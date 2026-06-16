// Client-side shipping-label parser.
//
// The labels operators upload (Shippo / Palmstreet USPS) are image-only PDFs
// — a single 300-dpi raster per page with no text layer (pdftotext returns
// nothing). So we can't read them as text. Instead, per page we:
//   1. render the PDF page to a canvas (pdfjs-dist),
//   2. decode the tracking barcode (CODE-128 / IMpb) with ZXing — exact,
//   3. OCR the recipient block (tesseract.js) so we can auto-match a box.
//
// pdfjs + tesseract are big, so they're dynamically imported here and only
// pulled when the operator actually opens the Import Labels modal. Tesseract
// loads its worker + English model from the CDN on first use; if that or the
// barcode decode fails, the label still surfaces (operator fixes it by hand)
// — nothing here throws for a single bad page.

import { BrowserMultiFormatReader } from '@zxing/browser';
import { DecodeHintType, BarcodeFormat } from '@zxing/library';
import { jsPDF } from 'jspdf';
import { canonicalTracking, extractTrackingFromText } from '../labels/tracking.js';

// ── lazy singletons ──────────────────────────────────────────────────────

let pdfjsPromise = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

let ocrWorkerPromise = null;
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      return createWorker('eng');
    })();
  }
  return ocrWorkerPromise;
}

// Free the OCR worker (and its ~10 MB model) once the modal closes.
export async function terminateLabelParser() {
  if (ocrWorkerPromise) {
    const p = ocrWorkerPromise;
    ocrWorkerPromise = null;
    try { (await p).terminate(); } catch { /* already gone */ }
  }
}

// ── barcode ────────────────────────────────────────────────────────────────

const BARCODE_HINTS = new Map();
BARCODE_HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.PDF_417,
  BarcodeFormat.QR_CODE,
]);
BARCODE_HINTS.set(DecodeHintType.TRY_HARDER, true);

function cropBottom(canvas, fraction) {
  const h = Math.round(canvas.height * fraction);
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = h;
  out.getContext('2d').drawImage(canvas, 0, canvas.height - h, canvas.width, h, 0, 0, canvas.width, h);
  return out;
}

// Decode the tracking barcode from a rendered label. USPS prints it across
// the bottom, so after a full-frame attempt we retry on just the bottom
// slices — a smaller region decodes more reliably when the rest of the
// label crowds the binarizer.
//
// The browser's native BarcodeDetector (when available) is tried first: it's
// the OS's hardware-accelerated decoder and reads these labels more reliably
// than ZXing-in-JS does off a rendered raster. ZXing is the fallback. Either
// way this is best-effort — the human-readable tracking is OCR'd separately
// as the guaranteed source (see parseLabelFiles).
async function decodeBarcode(canvas) {
  const targets = [canvas, cropBottom(canvas, 0.45), cropBottom(canvas, 0.28)];

  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = ['code_128', 'code_39', 'pdf417'].filter((f) => supported.includes(f));
      if (formats.length) {
        const detector = new window.BarcodeDetector({ formats });
        for (const target of targets) {
          try {
            const codes = await detector.detect(target);
            const hit = codes?.find((c) => c.rawValue);
            if (hit) return hit.rawValue;
          } catch { /* try next region */ }
        }
      }
    } catch { /* fall through to ZXing */ }
  }

  const reader = new BrowserMultiFormatReader(BARCODE_HINTS);
  for (const target of targets) {
    try {
      const result = reader.decodeFromCanvas(target);
      const text = result?.getText?.();
      if (text) return text;
    } catch { /* NotFoundException — try the next region */ }
  }
  return '';
}

// ── OCR + field detection ────────────────────────────────────────────────

async function ocrCanvas(canvas) {
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(canvas);
    return data?.text || '';
  } catch {
    return '';
  }
}

function detectCarrier(text) {
  const t = (text || '').toUpperCase();
  if (/FED\s?EX/.test(t)) return 'fedex';
  if (/\bUPS\b/.test(t) && !/USPS/.test(t)) return 'ups';
  return 'usps';
}

function parseWeightOz(text) {
  const m = (text || '').match(/([\d.]+)\s*OZ\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── rendering ──────────────────────────────────────────────────────────────

// Render at roughly 300 dpi (4× the 72-dpi base viewport) — matches the
// embedded raster and gives tesseract crisp glyphs — capped so a stray
// oversized page can't blow up memory.
function renderScale(page) {
  const base = page.getViewport({ scale: 1 });
  return Math.min(4, Math.max(2, 1800 / base.height));
}

async function renderPage(page) {
  const viewport = page.getViewport({ scale: renderScale(page) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function makeThumb(canvas, targetW = 300) {
  const scale = Math.min(1, targetW / canvas.width);
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.7);
}

// Build a standalone 1-page PDF (4×6 label) from a rendered page. Used when
// splitting a multi-page upload so each box stores only its own label. A
// single-page upload keeps its original bytes instead (higher fidelity).
function canvasToPagePdfBase64(canvas) {
  const portrait = canvas.height >= canvas.width;
  const w = portrait ? 288 : 432;
  const h = portrait ? 432 : 288;
  const pdf = new jsPDF({ unit: 'pt', format: [w, h], orientation: portrait ? 'portrait' : 'landscape' });
  pdf.addImage(canvas.toDataURL('image/jpeg', 0.85), 'JPEG', 0, 0, w, h);
  return pdf.output('datauristring').split(',')[1] || '';
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

let uidCounter = 0;
function uid() { return `lbl_${Date.now().toString(36)}_${(uidCounter++).toString(36)}`; }

// ── public API ─────────────────────────────────────────────────────────────

// Parse a list of uploaded PDF files into per-label records. onProgress is
// called before each page with { fileIndex, fileCount, fileName, page,
// pageCount } so the UI can show "Reading 2/5…".
//
// Each returned record:
//   { id, fileName, page, pageCount, error?,
//     barcodeRaw, trackingNumber, carrier, weightOz,
//     ocrText, thumbnailDataUrl, pagePdfBase64 }
export async function parseLabelFiles(files, onProgress) {
  const pdfjs = await getPdfjs();
  const list = Array.from(files || []);
  const out = [];

  for (let f = 0; f < list.length; f++) {
    const file = list[f];
    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch {
      out.push({ id: uid(), fileName: file.name, page: 1, pageCount: 1, error: 'Could not read file' });
      continue;
    }
    const origBase64 = arrayBufferToBase64(buf);

    let doc;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    } catch {
      out.push({ id: uid(), fileName: file.name, page: 1, pageCount: 1, error: 'Not a readable PDF' });
      continue;
    }

    const pageCount = doc.numPages;
    for (let p = 1; p <= pageCount; p++) {
      onProgress?.({ fileIndex: f, fileCount: list.length, fileName: file.name, page: p, pageCount });
      try {
        const page = await doc.getPage(p);
        const canvas = await renderPage(page);
        const barcodeRaw = await decodeBarcode(canvas);
        const ocrText = await ocrCanvas(canvas);
        // Tracking source: the barcode is exact when it decodes; otherwise
        // fall back to the human-readable tracking OCR'd off the label.
        const barcodeTracking = barcodeRaw ? canonicalTracking(barcodeRaw) : '';
        const ocrTracking = extractTrackingFromText(ocrText);
        const trackingNumber = barcodeTracking || ocrTracking;
        out.push({
          id: uid(),
          fileName: file.name,
          page: p,
          pageCount,
          barcodeRaw,
          trackingNumber,
          trackingSource: barcodeTracking ? 'barcode' : (ocrTracking ? 'ocr' : ''),
          carrier: detectCarrier(ocrText),
          weightOz: parseWeightOz(ocrText),
          ocrText,
          thumbnailDataUrl: makeThumb(canvas),
          pagePdfBase64: pageCount === 1 ? origBase64 : canvasToPagePdfBase64(canvas),
        });
        canvas.width = 0; canvas.height = 0; // release the backing store
      } catch {
        out.push({ id: uid(), fileName: file.name, page: p, pageCount, error: 'Could not render this page' });
      }
    }
    try { await doc.cleanup?.(); } catch { /* best effort */ }
  }

  return out;
}
