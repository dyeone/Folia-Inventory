import JsBarcode from 'jsbarcode';
import { jsPDF } from 'jspdf';
import { shortBoxCode } from './boxCode.js';

// 2"×1" box-tag PDF builder, shared by the Shipping tab's BoxLabelSheet
// (batch printing) and the packer's per-box "Print box tag" button. Kept in
// a plain module so component files only export components (fast refresh).

// Top line of the label: brand, carrier (UPS / USPS), match-status marker,
// and a contents tag for plants that need special handling at pack-out.
// Names and @ids are intentionally omitted — the label exists to
// identify the box at the carrier-handoff station, not the buyer.
//
//   *    every item in the box is matched real inventory
//   #    at least one item is an unmatched placeholder (purple in Shipping)
//   ANT  at least one item is an Anthurium — flagged on the physical
//        tag so the packer sees it before opening the box
//
// '#' tells the packer to double-check the manifest before sealing —
// the placeholder row didn't tie to a known SKU, so something needs
// attention before this box ships.
export function displayHeader(box) {
  // Brand first — Folia and BAE share no inventory, species, or SKUs, so a box
  // at the handoff station has to say which brand it belongs to. Always shown
  // (FOLIA / BAE), unlike item labels which only flag the non-default brand.
  // The active brand lives on <html data-brand> (set in App.jsx).
  const brand = (document.documentElement.getAttribute('data-brand') || 'folia').toUpperCase();
  const carrier = String(box.carrier || 'usps').toUpperCase();
  const items = box.items || [];
  const hasUnmatched = items.some(i => i.lotKind === 'unmatched');
  const hasAnthurium = items.some(i => (i.variety || '').toLowerCase() === 'anthurium');
  const marker = hasUnmatched ? '#' : '*';
  const tag = hasAnthurium ? ' · ANT' : '';
  return `${brand} · ${carrier} · ${marker}${tag}`;
}

export const BOX_LABEL_W = 2;
export const BOX_LABEL_H = 1;

function barcodeDataUrl(canvas, value) {
  try {
    JsBarcode(canvas, value, {
      format: 'CODE128',
      height: 50,
      width: 2,
      margin: 0,
      displayValue: false,
    });
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

export function buildBoxLabelPdf(boxes) {
  const pdf = new jsPDF({
    unit: 'in',
    format: [BOX_LABEL_W, BOX_LABEL_H],
    orientation: 'landscape',
  });
  const canvas = document.createElement('canvas');

  boxes.forEach((box, idx) => {
    if (idx > 0) pdf.addPage([BOX_LABEL_W, BOX_LABEL_H], 'landscape');
    const code = shortBoxCode(box.id);
    const header = displayHeader(box);

    // Top: brand · carrier · marker — 9pt, centered, truncated to fit.
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(0);
    pdf.text(header, BOX_LABEL_W / 2, 0.2, { align: 'center', maxWidth: BOX_LABEL_W - 0.15 });

    // Middle: box code — 12pt bold mono.
    pdf.setFont('courier', 'bold');
    pdf.setFontSize(12);
    pdf.setTextColor(0);
    pdf.text(code, BOX_LABEL_W / 2, 0.5, { align: 'center' });

    // Bottom: CODE128 barcode of the box code.
    const dataUrl = barcodeDataUrl(canvas, code);
    if (dataUrl) {
      // 'FAST' = FlateDecode the embedded PNG so big batches stay small.
      pdf.addImage(dataUrl, 'PNG', 0.1, 0.58, BOX_LABEL_W - 0.2, 0.36, undefined, 'FAST');
    }
  });

  return pdf;
}
