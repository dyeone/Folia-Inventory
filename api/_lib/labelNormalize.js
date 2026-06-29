// Normalize a shipping-label PDF to a single 4×6 page.
//
// Why: ShipStation's legacy v1 /shipments/createlabel API has NO labelLayout
// parameter (that's the v2/ShipEngine API), so it returns labels in the
// carrier account's default document layout. When that default is "letter"
// (8.5×11), the 4×6 label sits on the TOP-LEFT of the sheet; sent to a 4×6
// thermal printer only the blank bottom 4×6 lands on the label — the operator
// sees "only the half". Shippo is already forced to 4×6 (label_file_type
// PDF_4x6 in shippo.js); this is the in-our-control safety net for every
// provider: any label page bigger than 4×6 is cropped to its top-left 4×6
// region, so every stored/printed label is 4×6 regardless of account settings.
//
// Fail-safe: on any error the original bytes are returned unchanged — a label
// we've already paid for is never lost to a normalization bug.

import { PDFDocument } from 'pdf-lib';

const PT = 72;
export const LABEL_W = 4 * PT; // 288 pt = 4"
export const LABEL_H = 6 * PT; // 432 pt = 6"
// Only crop when the page is clearly larger than a 4×6 label. True 4×6 labels
// (288×432) and slightly-narrow USPS labels (e.g. 274×432) pass through.
const MAX_OK_W = 4.5 * PT; // 324 pt
const MAX_OK_H = 6.5 * PT; // 468 pt

export function isOversized(width, height) {
  return width > MAX_OK_W || height > MAX_OK_H;
}

// Returns { base64, changed, from?, to?, error? }. `base64` is the possibly
// cropped PDF (always safe to use). `changed` is true only when a crop happened.
//
// We don't crop by shrinking the MediaBox (a non-zero MediaBox origin is
// rendered inconsistently — some renderers offset the content, some don't).
// Instead we re-embed the top-left 4×6 region of the source page onto a fresh
// origin-(0,0) 4×6 page, so every renderer (and the 4×6 thermal printer) places
// it identically. ShipStation's "letter" layout puts the label in the top-left;
// if a real sample shows a different position, adjust the clip box below.
export async function normalizeLabelTo4x6(base64Pdf) {
  if (!base64Pdf) return { base64: base64Pdf, changed: false };
  try {
    const src = await PDFDocument.load(Buffer.from(base64Pdf, 'base64'));
    const pages = src.getPages();
    if (!pages.length) return { base64: base64Pdf, changed: false };
    const { width, height } = pages[0].getSize();
    if (!isOversized(width, height)) {
      return { base64: base64Pdf, changed: false, from: [Math.round(width), Math.round(height)] };
    }
    // Clip the source page to its top-left 4×6 region (PDF origin is
    // bottom-left, so the top of the sheet is at y = height).
    const out = await PDFDocument.create();
    const clip = { left: 0, bottom: height - LABEL_H, right: LABEL_W, top: height };
    const embedded = await out.embedPage(pages[0], clip);
    const page = out.addPage([LABEL_W, LABEL_H]);
    page.drawPage(embedded, { x: 0, y: 0 });
    const bytes = await out.save();
    return {
      base64: Buffer.from(bytes).toString('base64'),
      changed: true,
      from: [Math.round(width), Math.round(height)],
      to: [LABEL_W, LABEL_H],
    };
  } catch (e) {
    return { base64: base64Pdf, changed: false, error: e?.message || String(e) };
  }
}
