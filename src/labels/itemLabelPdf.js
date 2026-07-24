import JsBarcode from 'jsbarcode';
import { jsPDF } from 'jspdf';

// The 2"×1" plant-label PDF builder plus its display helpers, in their own
// module (like boxLabelPdf.js) so non-component code — LabelSheet's preview,
// and the packer's burrito-wrap reprint (packerPrint.printItemLabel) — can
// share them without LabelSheet.jsx exporting non-components.

// BAE and Folia share nothing — not SKUs, varieties, or species — so a label
// has to say which brand it belongs to or it's ambiguous on the bench. We tag
// any non-Folia brand with its name (BAE → "BAE"); Folia (the default) stays
// clean. The active brand lives on <html data-brand> (set in App.jsx).
export function brandTag() {
  const b = (document.documentElement.getAttribute('data-brand') || 'folia').toLowerCase();
  return b && b !== 'folia' ? b.toUpperCase() : '';
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

// The SKU to print / barcode. UNMATCHED-… and DBL-… are synthetic placeholder
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

// Renders a CODE128 barcode into a hidden canvas and returns it as a PNG data
// URL, ready to embed in a jsPDF page.
function barcodeDataUrl(canvas, value) {
  try {
    JsBarcode(canvas, value, {
      format: 'CODE128',
      height: 50,      // drawing height in px
      width: 2,        // bar width multiplier
      margin: 0,
      displayValue: false,
    });
    return canvas.toDataURL('image/png');
  } catch {
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
    // name — so the bench can tell whose plant it is. BAE and Folia share no
    // SKUs/varieties, so non-Folia labels are marked to avoid bench mix-ups;
    // Folia (the default, no sellers) prints without a top line.
    const sellerName = item.sellerId && sellerNameById ? sellerNameById.get(item.sellerId) : null;
    const topTag = [tag, sellerName].filter(Boolean).join(' · ').slice(0, 28);
    const title = `${displayName(item)}${item.variety ? ` · ${item.variety}` : ''}`;
    const sku = realSku(item);
    const lot = lotStr(item);

    if (lot) {
      // Combined layout: the big lineup number fills the wide left column (easy
      // to read across the room during a live), with name / SKU / barcode stacked
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
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7);
      pdf.setTextColor(70);
      pdf.text(title, cx, topTag ? 0.29 : 0.22, { align: 'center', maxWidth: cw });
      pdf.setFont('courier', 'bold');
      pdf.setFontSize(10.5);
      pdf.setTextColor(0);
      pdf.text(sku, cx, 0.50, { align: 'center' });
      if (sku) {
        const dataUrl = barcodeDataUrl(canvas, sku);
        if (dataUrl) pdf.addImage(dataUrl, 'PNG', DIV + 0.05, 0.58, LABEL_W - DIV - 0.11, 0.34, undefined, 'FAST');
      }
      return;
    }

    // Full-width layout (no lineup number): brand tag, name, big SKU, barcode.
    if (topTag) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(7);
      pdf.setTextColor(0);
      pdf.text(topTag, LABEL_W / 2, 0.11, { align: 'center' });
    }
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(70);
    pdf.text(title, LABEL_W / 2, topTag ? 0.24 : 0.18, { align: 'center', maxWidth: LABEL_W - 0.15 });
    pdf.setFont('courier', 'bold');
    pdf.setFontSize(14);
    pdf.setTextColor(0);
    pdf.text(sku, LABEL_W / 2, 0.45, { align: 'center' });
    if (sku) {
      const dataUrl = barcodeDataUrl(canvas, sku);
      if (dataUrl) {
        // 'FAST' = FlateDecode the embedded PNG; a 1-bit barcode compresses
        // hard, which keeps big batches well under the per-job size cap.
        pdf.addImage(dataUrl, 'PNG', 0.1, 0.55, LABEL_W - 0.2, 0.4, undefined, 'FAST');
      }
    }
  });

  return pdf;
}
