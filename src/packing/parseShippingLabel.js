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
import { canonicalTracking, extractTrackingFromText, looksLikeTracking } from '../labels/tracking.js';
import { getPdfjs } from './pdfjsLoader.js';
import { isBiggerThanLabel, inkBox, boxToRegion, placement, regionToLabelPdf, cutKeepsInk, pageAlonePdf, UnseenImageError, LABEL_W_PT, LABEL_H_PT } from './labelFit.js';

// ── lazy singletons ──────────────────────────────────────────────────────

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

// The same canvas without its left and right edges. A label's outer frame
// line can run through the barcode rows, and ZXing (the only decoder in
// Safari, which has no BarcodeDetector) then fails on every row of a framed
// CODE-128; reading just inside the frame lets it decode.
function insetX(canvas, fraction = 0.04) {
  const dx = Math.round(canvas.width * fraction);
  const out = document.createElement('canvas');
  out.width = canvas.width - 2 * dx;
  out.height = canvas.height;
  out.getContext('2d').drawImage(canvas, dx, 0, out.width, canvas.height, 0, 0, out.width, canvas.height);
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
//
// Only a decode that looks like a tracking number counts — a stray code on
// the label (a QR, a short reference barcode) must never become the box's
// tracking #.
async function decodeBarcode(canvas) {
  const bottom45 = cropBottom(canvas, 0.45);
  const bottom28 = cropBottom(canvas, 0.28);
  const targets = [insetX(canvas), insetX(bottom45), insetX(bottom28), canvas, bottom45, bottom28];

  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = ['code_128', 'code_39', 'pdf417'].filter((f) => supported.includes(f));
      if (formats.length) {
        const detector = new window.BarcodeDetector({ formats });
        for (const target of targets) {
          try {
            const codes = await detector.detect(target);
            const hit = codes?.find((c) => c.rawValue && looksLikeTracking(c.rawValue));
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
      if (text && looksLikeTracking(text)) return text;
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

// A label cut out of an over-size page, rasterized — only used when the
// lossless cut (pdf-lib) fails on a file. `box` is the ink box in canvas
// pixels; `pxPerPt` the render scale, used to keep the same white pad.
function canvasRegionToPagePdf(canvas, box, pxPerPt) {
  const pad = Math.round(3 * pxPerPt);
  const x0 = Math.max(0, box.x0 - pad);
  const y0 = Math.max(0, box.y0 - pad);
  const w = Math.min(canvas.width, box.x1 + 1 + pad) - x0;
  const h = Math.min(canvas.height, box.y1 + 1 + pad) - y0;
  const cut = document.createElement('canvas');
  cut.width = w;
  cut.height = h;
  cut.getContext('2d').drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
  const p = placement({ left: 0, bottom: 0, right: w / pxPerPt, top: h / pxPerPt });
  const pdf = new jsPDF({ unit: 'pt', format: [LABEL_W_PT, LABEL_H_PT], orientation: 'portrait' });
  const dw = (w / pxPerPt) * p.xScale;
  const dh = (h / pxPerPt) * p.yScale;
  // jsPDF measures y from the top; placement() from the bottom.
  pdf.addImage(cut.toDataURL('image/jpeg', 0.92), 'JPEG', p.x, LABEL_H_PT - p.y - dh, dw, dh);
  cut.width = 0; cut.height = 0;
  return new Uint8Array(pdf.output('arraybuffer'));
}

// The PDF stored for one page of an upload.
//   • A page no bigger than 4×6 — as before: a one-page file keeps its
//     original bytes, a page of a multi-page file is rendered into its own
//     4×6 PDF.
//   • A bigger sheet — Palmstreet's label download, since 2026-11-08,
//     centers each true-size 4×6 label on an A4 page. Storing the sheet (or
//     squeezing it onto 4×6, as the splitter used to) printed the label at
//     half size. The label is cut out of the sheet instead, at full size, by
//     embedding the original page clipped to the label (see labelFit.js).
// Returns { base64, labelBytes }: labelBytes is the cut-out label when the
// page was a bigger sheet (null otherwise), so the caller can read the
// barcode and text off the label at label resolution.
async function labelPdfForPage({ srcBytes, origBase64, pageCount, pageIndex, page, canvas }) {
  const asBefore = () => ({ base64: pageCount === 1 ? origBase64 : canvasToPagePdfBase64(canvas), labelBytes: null });
  const base = page.getViewport({ scale: 1 });
  if (!isBiggerThanLabel(base.width, base.height) || page.rotate % 360) return asBefore();
  const box = inkBox(canvas);
  if (!box) return asBefore();
  const scale = renderScale(page);
  const viewport = page.getViewport({ scale });
  const region = boxToRegion(viewport, box, page.view);
  if (region.right - region.left > region.top - region.bottom) return asBefore(); // landscape artwork
  try {
    const cut = await regionToLabelPdf(srcBytes, pageIndex, region);
    // Same self-check as printing: a cut that lost part of the label is not
    // stored; the rendered page (which shows exactly what was read) is.
    if (await cutKeepsInk(cut, { canvas, viewport, region })) return { base64: arrayBufferToBase64(cut), labelBytes: cut };
  } catch (e) {
    // A page with an image pdf.js can't draw here: the rendered page would
    // miss it too, so store the page as it came — complete, if small.
    if (e instanceof UnseenImageError) {
      return { base64: pageCount === 1 ? origBase64 : arrayBufferToBase64(await pageAlonePdf(srcBytes, pageIndex)), labelBytes: null };
    }
    console.warn('[parseShippingLabel] lossless label cut failed — using the rendered page:', e?.message || e);
  }
  // The raster cut is made from the sheet canvas itself, so reading stays
  // there — re-rendering the same pixels larger can only lose detail.
  const raster = canvasRegionToPagePdf(canvas, box, scale);
  return { base64: arrayBufferToBase64(raster), labelBytes: null };
}

// Render a one-page label PDF (a cut-out label) the way a 4×6 upload page is
// rendered, for reading its barcode and text.
async function renderLabelBytes(bytes) {
  const pdfjs = await getPdfjs();
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    return await renderPage(await (await task.promise).getPage(1));
  } finally {
    try { await task.destroy(); } catch { /* best effort */ }
  }
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
    // pdf.js takes over the buffer it's given; keep a copy for cutting labels
    // out of over-size pages (labelPdfForPage).
    const srcBytes = new Uint8Array(buf.slice(0));

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
        // What gets stored — and, for a label cut out of a bigger sheet, what
        // gets READ: the cut-out label rendered like a 4×6 page (~288 dpi).
        // The whole A4 sheet renders at ~150 dpi under the 1800 px cap, too
        // coarse for the barcode, and the OCR fallback then misread digits:
        // on 2026-11-08, 17 of 21 Palmstreet A4 labels were stored with a 9
        // read as 0, so the packer's label scan matched no box.
        const stored = await labelPdfForPage({ srcBytes, origBase64, pageCount, pageIndex: p - 1, page, canvas });
        let readCanvas = canvas;
        if (stored.labelBytes) {
          try { readCanvas = await renderLabelBytes(stored.labelBytes); } catch { readCanvas = canvas; }
        }
        const barcodeRaw = await decodeBarcode(readCanvas)
          || (readCanvas !== canvas ? await decodeBarcode(canvas) : '');
        const ocrText = await ocrCanvas(readCanvas);
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
          thumbnailDataUrl: makeThumb(readCanvas),
          pagePdfBase64: stored.base64,
        });
        if (readCanvas !== canvas) { readCanvas.width = 0; readCanvas.height = 0; }
        canvas.width = 0; canvas.height = 0; // release the backing store
      } catch {
        out.push({ id: uid(), fileName: file.name, page: p, pageCount, error: 'Could not render this page' });
      }
    }
    // End this file's pdf.js worker (v6 tears down through the loading task).
    try { await doc.loadingTask.destroy(); } catch { /* best effort */ }
  }

  return out;
}
