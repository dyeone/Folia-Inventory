// Carrier labels must fill the 4×6 sticker. Two sources don't:
//
//  • Palmstreet's label download (since 2026-11-08) centers each true-size
//    4×6 label on an A4 page. Sent to the 4×6 printer, the whole A4 sheet is
//    shrunk to fit the sticker, so the label comes out at half size.
//  • Import labels stored those A4 pages squeezed onto a 4×6 page (the
//    splitter assumed every page was already a label), so the stored file
//    itself shows the label at ~48% in the middle of the sticker.
//
// The fix finds the label on its page — the box around the dark ink — and
// redraws only that region onto a 4×6 page with pdf-lib. Nothing is
// re-rendered: the original page is embedded and clipped, so barcodes keep
// the source's sharpness. Only two kinds of file are touched: a page bigger
// than the sticker (the printer would shrink the whole sheet) and artwork
// shrunk inside its page. Every other label — including pages a little
// narrower than 4×6, like ShipStation's August 274×432 labels, which print at
// true size — is left byte for byte as it is.
import { getPdfjs } from './pdfjsLoader.js';

export const LABEL_W_PT = 288; // 4 in
export const LABEL_H_PT = 432; // 6 in

const INK_LUMA = 160;            // darker than this counts as ink
const INK_MIN_PX = 2;            // a row/column needs this many ink pixels (ignores specks)
const PAD_PT = 3;                // white kept around the label's outer frame
const MEASURE_LONG_SIDE_PX = 900;
const SHRUNK_GAIN = 1.2;         // artwork that could grow ≥20% is "shrunk" inside its page
const PAGE_TOLERANCE = 0.03;     // a page up to 3% over 4×6 still counts as sticker-size
const FILL_TOLERANCE = 0.08;     // within 8% of the 2:3 shape → fill the sticker exactly

// Would the printer have to shrink this page (points) to get it onto the 4×6
// sticker? Compared in portrait, so a 6×4 landscape page counts as 4×6.
export function isBiggerThanLabel(w, h, tol = PAGE_TOLERANCE) {
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  return short > LABEL_W_PT * (1 + tol) || long > LABEL_H_PT * (1 + tol);
}

// Pixel box around the dark ink of a rendered page, or null for a blank one.
export function inkBox(canvas) {
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return null;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const rows = new Uint32Array(h);
  const cols = new Uint32Array(w);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      if (data[i + 3] < 128) continue; // unpainted = white
      if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < INK_LUMA) { rows[y]++; cols[x]++; }
    }
  }
  const first = (a) => a.findIndex((n) => n >= INK_MIN_PX);
  const last = (a) => { for (let k = a.length - 1; k >= 0; k--) if (a[k] >= INK_MIN_PX) return k; return -1; };
  const x0 = first(cols), y0 = first(rows);
  if (x0 < 0 || y0 < 0) return null;
  return { x0, y0, x1: last(cols), y1: last(rows) };
}

// The ink box in PDF user space (pdf.js viewport maps pixels back, offsets
// and y-flip included), padded and kept on the page. `view` is page.view.
export function boxToRegion(viewport, box, view) {
  const [ax, ay] = viewport.convertToPdfPoint(box.x0, box.y0);
  const [bx, by] = viewport.convertToPdfPoint(box.x1 + 1, box.y1 + 1);
  const [vx0, vy0, vx1, vy1] = view;
  return {
    left: Math.max(vx0, Math.min(ax, bx) - PAD_PT),
    right: Math.min(vx1, Math.max(ax, bx) + PAD_PT),
    bottom: Math.max(vy0, Math.min(ay, by) - PAD_PT),
    top: Math.min(vy1, Math.max(ay, by) + PAD_PT),
  };
}

// Where a portrait region lands on the 4×6 page. Close to the label's 2:3
// shape (a true 4×6 label, or one squeezed by the A4→4×6 mix-up, which is
// 6% off) it fills the sticker exactly; any other shape keeps its
// proportions, centered.
export function placement(region) {
  const w = region.right - region.left;
  const h = region.top - region.bottom;
  const sx = LABEL_W_PT / w;
  const sy = LABEL_H_PT / h;
  if (Math.abs(sx / sy - 1) <= FILL_TOLERANCE) return { x: 0, y: 0, xScale: sx, yScale: sy };
  const s = Math.min(sx, sy);
  return { x: (LABEL_W_PT - w * s) / 2, y: (LABEL_H_PT - h * s) / 2, xScale: s, yScale: s };
}

// A one-page 4×6 PDF holding just `region` of a source page — lossless.
export async function regionToLabelPdf(srcBytes, pageIndex, region) {
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true, updateMetadata: false });
  // An encrypted file loads, but its page content can't be read back — the
  // embedded label would be garbage. Let the caller keep the original.
  if (src.isEncrypted) throw new Error('encrypted label PDF');
  const out = await PDFDocument.create();
  const embedded = await out.embedPage(src.getPage(pageIndex), region);
  out.addPage([LABEL_W_PT, LABEL_H_PT]).drawPage(embedded, placement(region));
  return out.save();
}

// Label region of a pdf.js page, measured on a small render.
async function measureRegion(page) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: MEASURE_LONG_SIDE_PX / Math.max(base.width, base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
    await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport }).promise;
    const box = inkBox(canvas);
    return box ? boxToRegion(viewport, box, page.view) : null;
  } finally {
    canvas.width = 0; canvas.height = 0; // release the backing store
  }
}

// The bytes to send to the 4×6 printer for a stored carrier label: the file
// as stored (the same Uint8Array, so callers can tell nothing changed) unless
// the page is bigger than the sticker or the artwork sits shrunk inside it —
// then the label cut out and fitted onto a 4×6 page. Never throws — on any
// failure the label prints as stored, exactly as before this existed.
export async function fitLabelPdf(bytes) {
  let task = null;
  try {
    const pdfjs = await getPdfjs();
    // pdf.js hands its input buffer to the worker; give it a copy so `bytes`
    // stays usable for pdf-lib and for the as-stored fallback.
    task = pdfjs.getDocument({ data: bytes.slice() });
    const doc = await task.promise;
    if (doc.numPages !== 1) return bytes;
    const page = await doc.getPage(1);
    if (page.rotate % 360) return bytes;
    const base = page.getViewport({ scale: 1 });
    const region = await measureRegion(page);
    if (!region) return bytes;
    const w = region.right - region.left;
    const h = region.top - region.bottom;
    if (w > h) return bytes; // landscape artwork — leave it to the printer
    const gain = Math.min(LABEL_W_PT / w, LABEL_H_PT / h);
    if (!isBiggerThanLabel(base.width, base.height) && gain < SHRUNK_GAIN) return bytes;
    return await regionToLabelPdf(bytes, 0, region);
  } catch (e) {
    console.warn('[labelFit] printing the label as stored —', e?.message || e);
    return bytes;
  } finally {
    // pdf.js v6 tears down through the loading task (the document proxy has
    // no destroy()); this also ends the worker it started for this file.
    try { await task?.destroy(); } catch { /* best effort */ }
  }
}
