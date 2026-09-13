import { jsPDF } from 'jspdf';
import { shortBoxCode } from './boxCode.js';

// 80mm receipt-style order slip for one of Nigel's (BoyGardening) boxes,
// built from the box's placeholder items — each carries the order number,
// order date, buyer, ship-to address and the parsed line title/qty/options
// from the slip import. Printed on the desk's Star TSP100III slip printer
// (role 'slip') from the packer UI.
//
// Why not print the stored original page? It's a letter/A4 page and the
// slip printer is an 80mm roll: scaled to fit, its body text lands near
// 4 pt. The original stays in Storage for the desk (browser view/print)
// and the packer's "This iPad" / "document printer" destinations.
//
// Same paper maths as ShippingSlipSheet: 80mm roll, 72mm printable, and
// the page height is computed from the content so the cutter trims clean.

const SLIP_W_MM = 80;
const MARGIN = 4;
const PRINT_W = SLIP_W_MM - MARGIN * 2;

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// Group a box's items by order number, oldest order first. Items without an
// order number (hand-added lines) go in a trailing "other" group.
function ordersOf(box) {
  const groups = new Map();
  for (const it of box.items || []) {
    if (it.deletedAt) continue;
    const key = it.orderId || '';
    if (!groups.has(key)) groups.set(key, { orderId: key, orderDate: it.orderDate || null, items: [] });
    groups.get(key).items.push(it);
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.orderId) return 1;
    if (!b.orderId) return -1;
    return String(a.orderDate || '').localeCompare(String(b.orderDate || ''));
  });
}

// Draws the slip onto `pdf` and returns the final y (mm). Called once on a
// tall scratch page to measure, then on the real page sized to fit.
function draw(pdf, box) {
  const a = box.buyerAddress || {};
  const orders = ordersOf(box);
  const itemCount = orders.reduce((n, o) => n + o.items.length, 0);
  let y = MARGIN + 2;

  const rule = () => {
    pdf.setDrawColor(0);
    pdf.setLineWidth(0.3);
    pdf.line(MARGIN, y, SLIP_W_MM - MARGIN, y);
    y += 3;
  };

  // Header — the customer's shop, not ours.
  pdf.setTextColor(0);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(15);
  pdf.text('BoyGardening', SLIP_W_MM / 2, y + 4, { align: 'center' });
  y += 7;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.text('Order slip', SLIP_W_MM / 2, y + 2, { align: 'center' });
  y += 5;
  rule();

  // Order number(s) + placed date.
  for (const o of orders) {
    if (!o.orderId) continue;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.text(`Order #${o.orderId}`, MARGIN, y + 3);
    const d = fmtDate(o.orderDate);
    if (d) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.text(`Placed ${d}`, SLIP_W_MM - MARGIN, y + 3, { align: 'right' });
    }
    y += 5;
  }
  y += 1;

  // Ship to.
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7);
  pdf.text('SHIP TO', MARGIN, y + 2);
  y += 5;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text(String(box.buyer || '(no name)').slice(0, 40), MARGIN, y + 2);
  y += 5;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  const addrLines = [
    a.street1,
    a.street2,
    [[a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' '),
    a.phone,
  ].filter(Boolean);
  for (const line of addrLines) {
    const wrapped = pdf.splitTextToSize(String(line), PRINT_W);
    for (const w of wrapped) { pdf.text(w, MARGIN, y + 2); y += 4; }
  }
  y += 1;
  rule();

  // Items — one block per order when the box holds several orders.
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.text(`ITEMS · ${itemCount}`, MARGIN, y + 2);
  y += 5;
  for (const o of orders) {
    if (orders.length > 1) {
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.text(o.orderId ? `#${o.orderId}` : 'Other', MARGIN, y + 2);
      y += 4;
    }
    for (const it of o.items) {
      const qty = it.quantity > 1 ? `x${it.quantity}` : '';
      const title = String(it.name || '(unnamed)');
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      const wrapped = pdf.splitTextToSize(title, PRINT_W - (qty ? 8 : 0));
      wrapped.forEach((w, i) => {
        pdf.text(w, MARGIN, y + 3);
        if (i === 0 && qty) {
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(9);
          pdf.text(qty, SLIP_W_MM - MARGIN, y + 3, { align: 'right' });
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(10);
        }
        y += 4.5;
      });
      // Option lines ("# of Seedlings: 1-Pack") ride in the item's notes.
      if (it.notes) {
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(8);
        for (const w of pdf.splitTextToSize(String(it.notes), PRINT_W)) { pdf.text(w, MARGIN, y + 2.5); y += 3.5; }
      }
      y += 1.5;
    }
  }
  rule();

  // Delivery method + our box code, so the slip can be matched to the box.
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  if (a.shipmentMethod) {
    pdf.text(`Delivery: ${String(a.shipmentMethod).slice(0, 40)}`, MARGIN, y + 2.5);
    y += 4;
  }
  pdf.setFont('courier', 'bold');
  pdf.setFontSize(9);
  pdf.text(shortBoxCode(box.id), MARGIN, y + 2.5);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.text(fmtDate(new Date().toISOString()), SLIP_W_MM - MARGIN, y + 2.5, { align: 'right' });
  y += 5;
  rule();

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.text('Thank you  ·  BoyGardening', SLIP_W_MM / 2, y + 2, { align: 'center' });
  y += 4;

  return y + MARGIN;
}

export function buildNigelSlipPdf(box) {
  // Measure on a tall scratch page, then lay out on a page cut to size.
  const scratch = new jsPDF({ unit: 'mm', format: [SLIP_W_MM, 600], orientation: 'portrait' });
  const height = Math.max(60, Math.ceil(draw(scratch, box)));
  const pdf = new jsPDF({ unit: 'mm', format: [SLIP_W_MM, height], orientation: 'portrait' });
  draw(pdf, box);
  return pdf;
}
