import QRCode from 'qrcode';
import { jsPDF } from 'jspdf';

// The 2"×1" plant-label PDF builder plus its display helpers, in their own
// module (like boxLabelPdf.js) so non-component code — LabelSheet's preview,
// and the packer's burrito-wrap reprint (packerPrint.printItemLabel) — can
// share them without LabelSheet.jsx exporting non-components.

// BAE and bae-gin share nothing — not SKUs, varieties, or species — so a label
// has to say which brand it belongs to or it's ambiguous on the bench. We tag
// any non-bae-gin brand with its name (BAE → "BAE"); bae-gin (the default)
// stays clean. The active brand lives on <html data-brand> (set in App.jsx).
export function brandTag() {
  const b = (document.documentElement.getAttribute('data-brand') || 'bae-gin').toLowerCase();
  return b && b !== 'bae-gin' ? b.toUpperCase() : '';
}

// The plant's lineup number (lotNumber) as a display string, or '' when it isn't
// a positive integer. When present it prints big on the left of the label so the
// plant is easy to spot during a live; labels for items not in a numbered
// lineup keep the plain full-width SKU layout.
export function lotStr(item) {
  const n = parseInt(item?.lotNumber, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

// ISO-8601 week number (Monday-based, 1–53) of a date. Date-only strings
// ("2026-07-17") are parsed as LOCAL calendar dates — new Date() would read
// them as UTC midnight, which in US timezones lands on the previous local
// day and can cross a week boundary on Mondays.
function isoWeek(raw) {
  let d;
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, day] = raw.split('-').map(Number);
    d = new Date(y, m - 1, day);
  } else {
    d = new Date(raw);
  }
  if (isNaN(d.getTime())) return null;
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

// Bold "WK N" chip printed under the big lineup number. The running index
// keeps numbers unique WITHIN a week (Tue continues into Fri) but restarts
// for a new week, so two weeks' plants on the bench can share a number —
// the week chip is what tells this week's #12 from last week's, so it must
// be readable at arm's length (a tiny gray tag wasn't, and packers pulled
// the wrong week's plants). Week comes from the plant's sale date, else its
// sold date, else the print date (labels are printed in the lineup's own week).
export function weekTag(item, saleById) {
  const sale = item?.saleId && saleById ? saleById.get(item.saleId) : null;
  const week = isoWeek(sale?.date || item?.soldAt || new Date());
  return week ? `WK ${week}` : '';
}

// Big-number font size (pt) picked by digit count so it fills the (wide) left
// column of a 2"×1" label and stays readable across the room during a live.
function lotFontPt(lot) {
  return lot.length <= 1 ? 60 : lot.length === 2 ? 50 : lot.length === 3 ? 34 : 26;
}

// The name to print: the operator's listing Title override (entered on the Pre
// Sale tab, and what Palmstreet lists it as) if set, else the item's own name.
// So a relabelled plant prints the new name, not the stale species name. If the
// name already starts with the lineup number (e.g. an unmatched line named
// "31 no id"), drop that prefix — the number is already printed big.
export function displayName(item) {
  const d = item && item.listingDetails;
  const t = d && typeof d === 'object' && d.title != null ? String(d.title).trim() : '';
  let name = t || (item.name || '');
  const lot = lotStr(item);
  if (lot && name.startsWith(`${lot} `)) name = name.slice(lot.length + 1).trim();
  return name;
}

// The SKU to print / QR-encode. UNMATCHED-… and DBL-… are synthetic placeholder
// SKUs (a line that didn't match real inventory) — they're long and don't scan
// to anything, so we suppress them: those labels show just the big lineup number
// + name for identification.
export function realSku(item) {
  const s = String(item?.sku || '');
  return /^(UNMATCHED|DBL)-/i.test(s) ? '' : s;
}

// One label per page, page size = 2" × 1" (standard thermal label stock).
const LABEL_W = 2;
const LABEL_H = 1;

// Printed QR square sizes (inches). Shared with LabelSheet's preview so the
// on-screen label can't drift from the printed one. Both keep the code
// ≥0.08" off the label's bottom edge — thermal feed drift clips edges, and
// while a clipped QR still error-corrects, a clipped CODE128 is dead (which
// is why these labels are QR now).
export const QR_SIZE_LOT = 0.42;   // lineup layout, right column
export const QR_SIZE_FULL = 0.44;  // full-width layout

// jsPDF's built-in fonts are WinAnsi-only — a Chinese species name (now a
// first-class import path) would print as garbage glyphs. When a label's
// title contains CJK, render that one line with the BROWSER's fonts onto a
// canvas (they handle Chinese natively) and embed it as an image; Latin
// titles keep the vector-text path untouched.
const CJK_RE = /[\u1100-\u11FF\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]|[\uD800-\uDBFF][\uDC00-\uDFFF]/;

// One truncated-with-ellipsis text line → { dataUrl, wIn, hIn } (or null).
// 300px-per-inch keeps it crisp on the 203dpi thermal head.
function textLineImage(canvas, text, { fontPt, maxWidthIn, color = '#000000' }) {
  try {
    const PPI = 300;
    const fontPx = Math.round((fontPt / 72) * PPI);
    const maxPx = Math.round(maxWidthIn * PPI);
    const font = `${fontPx}px -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif`;
    let ctx = canvas.getContext('2d');
    ctx.font = font;
    let t = String(text);
    if (ctx.measureText(t).width > maxPx) {
      while (t.length > 1 && ctx.measureText(`${t}…`).width > maxPx) t = [...t].slice(0, -1).join('');
      t += '…';
    }
    const wPx = Math.max(1, Math.min(maxPx, Math.ceil(ctx.measureText(t).width)));
    const hPx = Math.ceil(fontPx * 1.25);
    canvas.width = wPx;   // resizing clears the canvas (transparent)
    canvas.height = hPx;
    ctx = canvas.getContext('2d');
    ctx.font = font;      // canvas resize resets context state
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(t, 0, hPx / 2);
    return { dataUrl: canvas.toDataURL('image/png'), wIn: wPx / PPI, hIn: hPx / PPI };
  } catch (e) {
    // A label with no name line is easy to miss in a big batch — same
    // failure-visibility convention as qrDataUrl below.
    console.error('[labels] title render failed for', text, e);
    return null;
  }
}

// Title line for either layout: vector text for Latin, canvas image for CJK.
// centerX/baselineY mirror the vector call's geometry; the image is placed
// so its optical middle sits where the vector baseline's x-height was.
function drawTitle(pdf, canvas, title, { centerX, baselineY, fontPt, maxWidthIn }) {
  if (CJK_RE.test(title)) {
    const img = textLineImage(canvas, title, { fontPt, maxWidthIn, color: '#464646' });
    if (img) {
      pdf.addImage(img.dataUrl, 'PNG', centerX - img.wIn / 2, baselineY - img.hIn * 0.7, img.wIn, img.hIn, undefined, 'FAST');
    }
    return;
  }
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(fontPt);
  pdf.setTextColor(70);
  // One line only (matches the preview's truncate) — maxWidth WRAPS, and a
  // wrapped second line lands on the SKU glyphs below.
  pdf.text(pdf.splitTextToSize(title, maxWidthIn)[0] || '', centerX, baselineY, { align: 'center' });
}

// Renders a QR code into a canvas and returns it as a PNG data URL. QR
// replaced CODE128 here: a 12-char SKU as CODE128 needs ~170 bar modules,
// which squeezed into the label's ~1" slot is ~1.3 printer dots per bar at
// 203 dpi — bars merge and the code won't scan. A version-1 QR is 21 modules
// across (~3+ dots per module at 0.42") and adds 15% error correction on
// top. Item labels are scanned by the packer station's 2D wedge scanner and
// by the phone CameraScanner (ZXing + BarcodeDetector, QR whitelisted) —
// both decode QR.
//
// Drawn by hand from QRCode.create() — the library's own renderers are
// async-only (and toCanvas stomps the target's CSS size), while this
// builder must stay synchronous for its callers (printChunked's buildPdf,
// the packer's burrito-wrap reprint, LabelSheet's preview).
export function qrDataUrl(canvas, value) {
  try {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const data = qr.modules.data; // row-major Uint8Array, 1 = dark
    const margin = 2;  // quiet-zone modules baked into the image
    const scale = 8;   // px per module — chunky so 1-bit thermal binarizes cleanly
    const dim = (size + margin * 2) * scale;
    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[y * size + x]) {
          ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
        }
      }
    }
    return canvas.toDataURL('image/png');
  } catch (e) {
    // A label with SKU text but no code is easy to miss in a big batch —
    // make the failure visible instead of silently printing blanks.
    console.error('[labels] QR render failed for', value, e);
    return null;
  }
}

// The burrito-wrap reprint calls this without seller/sale context: the maps
// default empty, so the consignment seller line is omitted and the WK chip
// falls back to soldAt — same week as the sale for anything sold in a live.
export function buildItemLabelPdf(items, sellerNameById = new Map(), saleById = new Map()) {
  const pdf = new jsPDF({
    unit: 'in',
    format: [LABEL_W, LABEL_H],
    orientation: 'landscape',
  });
  const canvas = document.createElement('canvas');
  const tag = brandTag();

  items.forEach((item, idx) => {
    if (idx > 0) pdf.addPage([LABEL_W, LABEL_H], 'landscape');

    // Top line: brand tag (e.g. BAE) plus, for consignment plants, the seller's
    // name — so the bench can tell whose plant it is. BAE and bae-gin share no
    // SKUs/varieties, so non-bae-gin labels are marked to avoid bench mix-ups;
    // bae-gin (the default, no sellers) prints without a top line.
    const sellerName = item.sellerId && sellerNameById ? sellerNameById.get(item.sellerId) : null;
    const topTag = [tag, sellerName].filter(Boolean).join(' · ').slice(0, 28);
    const title = `${displayName(item)}${item.variety ? ` · ${item.variety}` : ''}`;
    const sku = realSku(item);
    const lot = lotStr(item);

    if (lot) {
      // Combined layout: the big lineup number fills the wide left column (easy
      // to read across the room during a live), with name / SKU / QR stacked
      // in the right column. A thin divider separates the two. A bold "WK N"
      // chip under the number says which week's lineup this is — numbers can
      // repeat across weeks on the bench, and the chip has to read at arm's
      // length (its tiny gray predecessor didn't).
      const week = weekTag(item, saleById);
      const DIV = 0.82;                 // left column width / divider x
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(0);
      pdf.setFontSize(lotFontPt(lot));
      pdf.text(lot, DIV / 2, week ? 0.68 : 0.74, { align: 'center' });
      if (week) {
        pdf.setFontSize(8);
        const chipW = pdf.getTextWidth(week) + 0.1;
        pdf.setDrawColor(0);
        pdf.setLineWidth(0.012);
        pdf.roundedRect(DIV / 2 - chipW / 2, 0.73, chipW, 0.16, 0.03, 0.03);
        pdf.text(week, DIV / 2, 0.85, { align: 'center' });
      }
      pdf.setDrawColor(170);
      pdf.setLineWidth(0.008);
      pdf.line(DIV, 0.1, DIV, 0.9);

      const cx = DIV + (LABEL_W - DIV) / 2; // center of the right column
      const cw = LABEL_W - DIV - 0.04;      // right column text width
      if (topTag) {
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(6.5);
        pdf.setTextColor(0);
        pdf.text(topTag, cx, 0.15, { align: 'center', maxWidth: cw });
      }
      drawTitle(pdf, canvas, title, { centerX: cx, baselineY: topTag ? 0.29 : 0.22, fontPt: 7, maxWidthIn: cw });
      pdf.setFont('courier', 'bold');
      pdf.setFontSize(10.5);
      pdf.setTextColor(0);
      pdf.text(sku, cx, 0.46, { align: 'center' });
      if (sku) {
        const dataUrl = qrDataUrl(canvas, sku);
        if (dataUrl) {
          pdf.addImage(dataUrl, 'PNG', cx - QR_SIZE_LOT / 2, 0.50, QR_SIZE_LOT, QR_SIZE_LOT, undefined, 'FAST');
        }
      }
      return;
    }

    // Full-width layout (no lineup number): brand tag, name, big SKU, QR.
    if (topTag) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7);
      pdf.setTextColor(0);
      pdf.text(topTag, LABEL_W / 2, 0.11, { align: 'center' });
    }
    drawTitle(pdf, canvas, title, { centerX: LABEL_W / 2, baselineY: topTag ? 0.24 : 0.18, fontPt: 8, maxWidthIn: LABEL_W - 0.15 });
    pdf.setFont('courier', 'bold');
    pdf.setFontSize(14);
    pdf.setTextColor(0);
    pdf.text(sku, LABEL_W / 2, 0.44, { align: 'center' });
    if (sku) {
      const dataUrl = qrDataUrl(canvas, sku);
      if (dataUrl) {
        // 'FAST' = FlateDecode the embedded PNG; a 1-bit QR compresses
        // hard, which keeps big batches well under the per-job size cap.
        pdf.addImage(dataUrl, 'PNG', (LABEL_W - QR_SIZE_FULL) / 2, 0.48, QR_SIZE_FULL, QR_SIZE_FULL, undefined, 'FAST');
      }
    }
  });

  return pdf;
}
