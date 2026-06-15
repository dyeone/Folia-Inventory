import { jsPDF } from 'jspdf';
import { shortBoxCode } from '../labels/boxCode.js';

// A printable packing-list table for a set of shipping boxes (US Letter,
// portrait). One row per item, grouped by box — box code, recipient, and
// carrier print on each box's first item row; the column header repeats on
// every page. Built for a regular document printer, not a label printer.

const M = 40;            // page margin (pt)
const PAGE_W = 612;      // letter width (pt)
const PAGE_H = 792;      // letter height (pt)
const BOTTOM = PAGE_H - M;
const ROW_H = 13;

// Absolute x of each column; qty is right-aligned to the content edge.
const COLS = {
  box:     { label: 'BOX',       x: 40,  w: 60 },
  recip:   { label: 'RECIPIENT', x: 100, w: 118 },
  carrier: { label: 'CARRIER',   x: 218, w: 44 },
  sku:     { label: 'SKU',       x: 262, w: 64 },
  item:    { label: 'ITEM',      x: 326, w: 210 },
  qty:     { label: 'QTY',       x: 572, w: 0, right: true },
};

function fmtNow() {
  try { return new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return ''; }
}

// Truncate text with an ellipsis to fit maxW at the current font/size.
function fit(pdf, text, maxW) {
  let t = String(text ?? '');
  if (!maxW || pdf.getTextWidth(t) <= maxW) return t;
  while (t.length > 1 && pdf.getTextWidth(t + '…') > maxW) t = t.slice(0, -1);
  return t + '…';
}

export function buildPackingTablePdf(boxes, { kind = 'ready' } = {}) {
  const pdf = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const totalItems = boxes.reduce((s, b) => s + (b.items?.length || 0), 0);
  const title = kind === 'shipped' ? 'Shipped — packing list' : 'Packing list';
  let y = M;

  const colHeader = () => {
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(0);
    for (const c of Object.values(COLS)) {
      pdf.text(c.label, c.x, y, c.right ? { align: 'right' } : undefined);
    }
    y += 4;
    pdf.setDrawColor(170); pdf.line(M, y, PAGE_W - M, y);
    y += 10;
  };
  const pageBreakIfNeeded = (h) => { if (y + h > BOTTOM) { pdf.addPage(); y = M; colHeader(); } };

  // Title block.
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); pdf.setTextColor(0);
  pdf.text(title, M, y); y += 15;
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(90);
  pdf.text(
    `${boxes.length} ${boxes.length === 1 ? 'box' : 'boxes'} · ${totalItems} ${totalItems === 1 ? 'item' : 'items'} · ${fmtNow()}`,
    M, y,
  );
  y += 16;
  colHeader();

  boxes.forEach((box, bi) => {
    const code = shortBoxCode(box.id);
    const recip = `${box.recipientName || '(no name)'}${box.username ? ` @${box.username}` : ''}`;
    const carrier = (box.carrier || '').toUpperCase();
    const rows = (box.items && box.items.length) ? box.items : [null]; // empty box → one blank row

    if (bi > 0) { pageBreakIfNeeded(6); pdf.setDrawColor(228); pdf.line(M, y - 5, PAGE_W - M, y - 5); }

    rows.forEach((item, ii) => {
      pageBreakIfNeeded(ROW_H);
      pdf.setFontSize(9);
      if (ii === 0) {
        pdf.setTextColor(20);
        pdf.setFont('helvetica', 'bold'); pdf.text(code, COLS.box.x, y);
        pdf.setFont('helvetica', 'normal'); pdf.setTextColor(40);
        pdf.text(fit(pdf, recip, COLS.recip.w - 4), COLS.recip.x, y);
        if (carrier) pdf.text(fit(pdf, carrier, COLS.carrier.w - 4), COLS.carrier.x, y);
      }
      if (item) {
        pdf.setTextColor(0);
        pdf.setFont('courier', 'normal'); pdf.text(fit(pdf, item.sku || '', COLS.sku.w - 4), COLS.sku.x, y);
        pdf.setFont('helvetica', 'normal');
        const name = `${item.name || ''}${item.variety ? ` · ${item.variety}` : ''}`;
        pdf.text(fit(pdf, name, COLS.item.w - 4), COLS.item.x, y);
        pdf.text(String(item.quantity ?? 1), COLS.qty.x, y, { align: 'right' });
      }
      y += ROW_H;
    });
  });

  return pdf;
}
