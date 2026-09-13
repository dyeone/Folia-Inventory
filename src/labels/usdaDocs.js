// USDA / CA nursery-stock compliance documents, printed per box for
// shipments that route through agricultural inspection (rural counties):
//
//   • Sticker — 4×6 portrait "LIVE NURSERY STOCK" label (CA F&A Code §6501)
//     with county-where-grown, from/to, a statement of contents and a big
//     FRAGILE · LIVE PLANTS · PLEASE HANDLE WITH CARE block. Prints on the
//     4×6 shipping-label printer next to the carrier label (bridge role
//     'shipping', media Custom.4x6in) — a 1-bit thermal printer, so the
//     sticker is pure black on white: solid bands and text, no red, no
//     greys (they dither into mud on thermal stock).
//   • Slip — 4×6 packing slip (one or more labels) with shipper/consignee
//     columns, an item table, the §6501(c) nursery stock declaration
//     summary and the same FRAGILE line. Goes inside the box; prints on
//     the same 4×6 shipping-label printer as the sticker (role 'shipping',
//     media Custom.4x6in), browser dialog when the bridge is offline.
//
// Business/grower facts live in USDA_CONFIG below — edit there when the
// license, grow site, or addresses change.

import { shortBoxCode } from './boxCode.js';
import { printGeneratedPdf } from '../packing/labelPdf.js';

// Pure black / pure white only — both documents may land on a 1-bit
// thermal printer, where any grey or colour dithers into mud.
const INK = [0, 0, 0];
const PAPER = [255, 255, 255];

const BASE_CONFIG = {
  code: 'CA F&A CODE §6501',
  codeLong: 'CA FOOD & AGRICULTURAL CODE §6501(c)',
  license: 'D3052.001',
  grownAt: {
    county: 'San Francisco County',
    state: 'CA',
    line: '801 Rockdale Dr, San Francisco, CA 94127',
  },
  shipFrom: {
    name: 'Best Anthuriums Ever',
    username: '@theBAE',
    street1: '205 E Alma Ave',
    city: 'San Jose',
    state: 'CA',
    zip: '95112',
  },
};

// Per-brand identity on top of the shared operation facts.
const USDA_CONFIG = {
  bae: { ...BASE_CONFIG, short: 'BAE', wordmark: 'BEST ANTHURIUMS EVER', footer: 'THE BAE SHOW + LIVE ON PALMSTREET · DOA CLAIMS WITHIN 24H OF DELIVERY' },
  'bae-gin': { ...BASE_CONFIG, short: 'BAE-GIN', wordmark: 'BAE-GIN', footer: 'BAE-GIN · DOA CLAIMS WITHIN 24H OF DELIVERY' },
};

export function usdaConfig() {
  const brand = (document.documentElement.getAttribute('data-brand') || 'bae-gin').toLowerCase();
  return USDA_CONFIG[brand] || USDA_CONFIG['bae-gin'];
}

// "N × live rooted nursery stock plant(s) — Anthurium hybrid. Bare-root in
// sphagnum moss. No soil." Count = physical plants (placeholders included:
// they ARE plants in the box, just unlinked); genus from the box contents.
export function contentsStatement(box) {
  const items = (box?.items || []).filter(i => i.type !== 'merch');
  const n = items.reduce((s, i) => s + (parseInt(i.quantity, 10) || 1), 0) || 1;
  const allAnthurium = items.length > 0 && items.every(
    i => (i.variety || '').toLowerCase() === 'anthurium' || i.lotKind === 'unmatched',
  );
  const genus = allAnthurium ? 'Anthurium hybrid' : 'tropical foliage plants';
  return `${n} × live rooted nursery stock plant${n === 1 ? '' : 's'} — ${genus}. Bare-root in sphagnum moss. No soil.`;
}

function addrLines(a) {
  return [
    a.street1,
    a.street2,
    [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
  ].filter(Boolean);
}

function openPdf(pdf) {
  window.open(pdf.output('bloburl'), '_blank');
}

// Boxes reach these builders in two shapes: the Ready/Shipped rows carry
// `buyer` / `buyerAddress` (the grouped box), the per-sale drill-down
// `recipientName` / `address`. Accept both so the sticker never prints a
// blank consignee.
function recipientOf(box) {
  return String(box?.recipientName || box?.buyer || 'Recipient');
}
function addressOf(box) {
  return box?.address || box?.buyerAddress || {};
}

// ── Sticker: 4×6 portrait, black & white, for the shipping-label printer ──

// Print the sticker on the desk's 4×6 shipping-label printer (bridge role
// 'shipping', same media as the carrier label) — browser print when the
// bridge is offline.
export async function printUsdaSticker(box, showToast) {
  const pdf = await buildUsdaStickerPdf(box);
  return printGeneratedPdf(pdf, { role: 'shipping', media: 'Custom.4x6in', what: 'USDA sticker' }, showToast);
}

// Kept for callers that want the PDF in a tab (preview / manual print).
export async function openUsdaStickerPdf(box) {
  openPdf(await buildUsdaStickerPdf(box));
}

export async function buildUsdaStickerPdf(box) {
  const cfg = usdaConfig();
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'in', format: [4, 6], orientation: 'portrait' });
  const W = 4, H = 6, M = 0.24;
  const INNER = W - 2 * M;

  // Vertical budget (worst case: a 3-line consignee address + a 3-line
  // contents statement) ends ~0.25in above the FRAGILE block, which is
  // anchored to the bottom. Keep the step sizes below if you add a line.
  const spaced = (t) => t.split('').join(' ');
  const rule = (y, w = 0.014) => { pdf.setDrawColor(...INK); pdf.setLineWidth(w); pdf.line(M, y, W - M, y); };
  const caption = (t, y) => {
    pdf.setTextColor(...INK); pdf.setFont('courier', 'bold'); pdf.setFontSize(7.5);
    pdf.text(spaced(t), M, y);
  };

  // Outer frame
  pdf.setDrawColor(...INK); pdf.setLineWidth(0.03);
  pdf.rect(0.06, 0.06, W - 0.12, H - 0.12);

  // Header band — solid black, knocked-out title (thermal-safe).
  const bandH = 0.72;
  pdf.setFillColor(...INK);
  pdf.rect(0.06, 0.06, W - 0.12, bandH, 'F');
  pdf.setTextColor(...PAPER);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(21);
  pdf.text('LIVE NURSERY STOCK', W / 2, 0.44, { align: 'center' });
  pdf.setFont('courier', 'bold'); pdf.setFontSize(8);
  pdf.text(cfg.code, W / 2, 0.66, { align: 'center' });

  // County where grown
  let y = 0.06 + bandH + 0.26;
  caption('COUNTY WHERE GROWN', y);
  y += 0.25;
  pdf.setTextColor(...INK);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(16);
  pdf.text(`${cfg.grownAt.county}, ${cfg.grownAt.state}`.toUpperCase(), M, y);
  y += 0.18;
  pdf.setFont('courier', 'normal'); pdf.setFontSize(8);
  pdf.text(cfg.grownAt.line, M, y);
  y += 0.14;
  pdf.text(`Lic. ${cfg.license}`, M, y);

  // From / To — stacked (portrait is too narrow for two address columns).
  y += 0.13;
  rule(y);
  y += 0.22;
  const block = (label, name, lines, nameSize) => {
    caption(label, y);
    y += 0.18;
    pdf.setTextColor(...INK);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(nameSize);
    pdf.text(pdf.splitTextToSize(name, INNER)[0] || '', M, y);
    pdf.setFont('courier', 'normal'); pdf.setFontSize(8.5);
    for (const l of lines) {
      for (const w of pdf.splitTextToSize(l, INNER)) { y += 0.14; pdf.text(w, M, y); }
    }
  };
  block('FROM', cfg.shipFrom.name, addrLines(cfg.shipFrom), 10.5);
  y += 0.18;
  block('TO', recipientOf(box), addrLines(addressOf(box)).slice(0, 3), 12);

  // Contents
  y += 0.14;
  rule(y);
  y += 0.22;
  caption('CONTENTS', y);
  y += 0.17;
  pdf.setTextColor(...INK); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9.5);
  const contents = pdf.splitTextToSize(contentsStatement(box), INNER).slice(0, 3);
  pdf.text(contents, M, y);

  // FRAGILE block — anchored to the bottom so it never gets squeezed; the
  // handler's eye should land on it first. Solid band + knocked-out word,
  // then the plain-language line underneath.
  const footH = 0.28;
  const fragH = 1.15;
  const fragY = H - 0.06 - footH - 0.1 - fragH;
  pdf.setDrawColor(...INK); pdf.setLineWidth(0.03);
  pdf.rect(M, fragY, INNER, fragH);
  pdf.setFillColor(...INK);
  pdf.rect(M, fragY, INNER, 0.56, 'F');
  pdf.setTextColor(...PAPER);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(36);
  pdf.text('FRAGILE', W / 2, fragY + 0.45, { align: 'center' });
  pdf.setTextColor(...INK);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14);
  pdf.text('LIVE PLANTS', W / 2, fragY + 0.83, { align: 'center' });
  pdf.setFontSize(11);
  pdf.text('PLEASE HANDLE WITH CARE', W / 2, fragY + 1.04, { align: 'center' });

  // Footer — brand on the left, box code on the right so the sticker can
  // be matched to its box at the desk.
  const footY = H - 0.06 - footH;
  rule(footY, 0.02);
  pdf.setTextColor(...INK);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(10);
  pdf.text(cfg.short, M, footY + 0.19);
  pdf.setFont('courier', 'bold'); pdf.setFontSize(8);
  pdf.text(shortBoxCode(box?.id || ''), W - M, footY + 0.19, { align: 'right' });

  return pdf;
}

// ── Slip: 4×6 nursery-stock packing slip (goes inside the box) ───────────
//
// Same 4×6 label stock and printer as the sticker and the carrier label —
// the desk has no letter printer. A box with more items than one label
// holds continues onto further labels; totals, the §6501(c) declaration
// and the FRAGILE strip always close the last one.

export async function printUsdaSlip(box, shipment, showToast) {
  const pdf = await buildUsdaSlipPdf(box, shipment);
  return printGeneratedPdf(pdf, { role: 'shipping', media: 'Custom.4x6in', what: 'USDA slip' }, showToast);
}

// Kept for callers that want the PDF in a tab (preview / manual print).
export async function openUsdaSlipPdf(box, shipment) {
  openPdf(await buildUsdaSlipPdf(box, shipment));
}

export async function buildUsdaSlipPdf(box, shipment) {
  const cfg = usdaConfig();
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'in', format: [4, 6], orientation: 'portrait' });
  const W = 4, H = 6, M = 0.2;
  const INNER = W - 2 * M;
  const a = addressOf(box);
  const recipient = recipientOf(box);
  const username = box.username || box.buyerUsername;
  const money = (v) => `$${(parseFloat(v) || 0).toFixed(2)}`;
  const spaced = (t) => t.split('').join(' ');
  const code = shortBoxCode(box?.id || '');
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).toUpperCase();

  // Bottom furniture of the LAST label: FRAGILE strip + footer. Content on
  // any page must stay above `limit`; the last page's limit leaves room
  // for them, continuation pages only for the footer.
  const footH = 0.3;
  const fragH = 0.38;
  const fragY = H - 0.06 - footH - 0.08 - fragH;
  const limitLast = fragY - 0.1;
  const limitCont = H - 0.06 - footH - 0.1;

  const rule = (y, w = 0.014) => { pdf.setDrawColor(...INK); pdf.setLineWidth(w); pdf.line(M, y, W - M, y); };
  const caption = (t, x, y) => {
    pdf.setTextColor(...INK); pdf.setFont('courier', 'bold'); pdf.setFontSize(7);
    pdf.text(spaced(t), x, y);
  };

  let pageNo = 0;
  // Frame + header band. Page 1 carries the full header (slip #, date,
  // tracking, license); later pages a slim "continued" band.
  const startPage = (first) => {
    if (!first) pdf.addPage([4, 6], 'portrait');
    pageNo++;
    pdf.setDrawColor(...INK); pdf.setLineWidth(0.03);
    pdf.rect(0.06, 0.06, W - 0.12, H - 0.12);
    const bandH = first ? 0.7 : 0.4;
    pdf.setFillColor(...INK);
    pdf.rect(0.06, 0.06, W - 0.12, bandH, 'F');
    pdf.setTextColor(...PAPER);
    if (first) {
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(17);
      pdf.text('PACKING SLIP', M, 0.36);
      pdf.setFont('courier', 'bold'); pdf.setFontSize(7.5);
      pdf.text(`${cfg.short} · ${cfg.code}`, M, 0.55);
      pdf.setFont('courier', 'bold'); pdf.setFontSize(7.5);
      const meta = [
        `SLIP ${code}`,
        `DATE ${dateStr}`,
        ...(shipment?.trackingNumber ? [`${String(box.carrier || '').toUpperCase() || 'TRK'} ${shipment.trackingNumber}`] : []),
        `LIC ${cfg.license}`,
      ];
      meta.forEach((t, i) => pdf.text(t, W - M, 0.22 + i * 0.13, { align: 'right' }));
    } else {
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12);
      pdf.text('PACKING SLIP · CONTINUED', M, 0.32);
      pdf.setFont('courier', 'bold'); pdf.setFontSize(7.5);
      pdf.text(`SLIP ${code}`, W - M, 0.31, { align: 'right' });
    }
    return 0.06 + bandH + 0.2;
  };

  const footer = (y0) => {
    rule(y0, 0.02);
    pdf.setTextColor(...INK); pdf.setFont('courier', 'normal'); pdf.setFontSize(6);
    const right = `SHEET ${pageNo} · ENCLOSE IN BOX`;
    const leftW = INNER - pdf.getTextWidth(right) - 0.12;
    pdf.splitTextToSize(cfg.footer, leftW).slice(0, 2).forEach((l, i) => pdf.text(l, M, y0 + 0.12 + i * 0.1));
    pdf.text(right, W - M, y0 + 0.12, { align: 'right' });
  };

  let y = startPage(true);

  // Ship-from / deliver-to — two compact columns.
  const colW = (INNER - 0.14) / 2;
  const col2 = M + colW + 0.14;
  const addrCol = (x, cap, name, lines) => {
    caption(cap, x, y);
    pdf.setTextColor(...INK); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9.5);
    pdf.text(pdf.splitTextToSize(name, colW)[0] || '', x, y + 0.18);
    pdf.setFont('courier', 'normal'); pdf.setFontSize(7.5);
    let yy = y + 0.18;
    for (const l of lines) {
      for (const w of pdf.splitTextToSize(l, colW).slice(0, 2)) { yy += 0.12; pdf.text(w, x, yy); }
    }
    return yy;
  };
  const yFrom = addrCol(M, 'SHIP FROM', cfg.shipFrom.name, [cfg.shipFrom.username, ...addrLines(cfg.shipFrom)]);
  const yTo = addrCol(col2, 'DELIVER TO', recipient,
    [username ? `@${String(username).replace(/^@/, '')}` : '', ...addrLines(a)].filter(Boolean).slice(0, 4));
  y = Math.max(yFrom, yTo) + 0.12;
  pdf.setFont('courier', 'normal'); pdf.setFontSize(7);
  pdf.setTextColor(...INK);
  pdf.text(pdf.splitTextToSize(`GROWN AT ${cfg.grownAt.line}`, INNER)[0], M, y);
  y += 0.14;

  // Item table — ITEM · SKU · QTY · PRICE (the shipping fee shows in totals).
  const cols = { item: M + 0.05, sku: 2.28, qty: 3.12, price: W - M - 0.05 };
  const rowH = 0.17;
  const tableHead = () => {
    pdf.setFillColor(...INK);
    pdf.rect(M, y, INNER, 0.2, 'F');
    pdf.setTextColor(...PAPER); pdf.setFont('courier', 'bold'); pdf.setFontSize(7);
    pdf.text('ITEM', cols.item, y + 0.14);
    pdf.text('SKU', cols.sku, y + 0.14);
    pdf.text('QTY', cols.qty, y + 0.14, { align: 'right' });
    pdf.text('PRICE', cols.price, y + 0.14, { align: 'right' });
    y += 0.2;
    pdf.setTextColor(...INK);
  };
  tableHead();

  const rows = (box.items || []).filter(i => !i.deletedAt);
  let subtotal = 0;
  rows.forEach((it, idx) => {
    // Keep the last row with the totals; otherwise continue on a new label.
    const isLast = idx === rows.length - 1;
    const need = rowH + (isLast ? 0.62 : 0);
    const limit = isLast ? limitLast : limitCont;
    if (y + need > limit) {
      footer(H - 0.06 - footH);
      y = startPage(false);
      tableHead();
    }
    const price = parseFloat(it.salePrice) || 0;
    subtotal += price;
    const name = [it.lotNumber, it.name, it.variety && it.variety !== it.name ? `– ${it.variety}` : '']
      .filter(Boolean).join(' ');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5);
    const nameFit = (pdf.splitTextToSize(name, cols.sku - cols.item - 0.08)[0] || '').replace(/\s[–-]$/, '');
    pdf.text(nameFit, cols.item, y + 0.12);
    pdf.setFont('courier', 'normal'); pdf.setFontSize(7);
    pdf.text(String(it.sku || '').slice(0, 12), cols.sku, y + 0.12);
    pdf.text(String(parseInt(it.quantity, 10) || 1), cols.qty, y + 0.12, { align: 'right' });
    pdf.text(money(price), cols.price, y + 0.12, { align: 'right' });
    y += rowH;
    pdf.setDrawColor(...INK); pdf.setLineWidth(0.005);
    pdf.line(M, y, W - M, y);
  });
  if (rows.length === 0) {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5);
    pdf.text('No items recorded for this box.', cols.item, y + 0.14);
    y += rowH;
  }

  // Totals — right-aligned stack. The Shipping tab's grouped box carries
  // shippingFeeCollected; the packer's box doesn't, so fall back to the
  // per-item order fees (same sum the Shipping tab makes).
  const shipTotal = box.shippingFeeCollected != null
    ? (parseFloat(box.shippingFeeCollected) || 0)
    : rows.reduce((sum, i) => sum + (parseFloat(i.orderShippingFee) || 0), 0);
  y += 0.04;
  const totX = 2.05;
  const totRow = (label, value, dark) => {
    const h = dark ? 0.22 : 0.18;
    if (dark) {
      pdf.setFillColor(...INK);
      pdf.rect(totX, y, W - M - totX, h, 'F');
      pdf.setTextColor(...PAPER);
    } else {
      pdf.setDrawColor(...INK); pdf.setLineWidth(0.01);
      pdf.rect(totX, y, W - M - totX, h);
      pdf.setTextColor(...INK);
    }
    pdf.setFont('courier', dark ? 'bold' : 'normal'); pdf.setFontSize(dark ? 8.5 : 7.5);
    pdf.text(label, totX + 0.08, y + h - 0.07);
    pdf.text(value, W - M - 0.08, y + h - 0.07, { align: 'right' });
    y += h;
  };
  totRow('SUBTOTAL', money(subtotal), false);
  totRow('SHIPPING', money(shipTotal), false);
  totRow('TOTAL', money(subtotal + shipTotal), true);
  pdf.setTextColor(...INK);

  // Declaration summary — 2×2 grid. Needs ~1.5in; new label if it won't fit.
  const cellW = INNER / 2, cellH = 0.52;
  const declH = 0.22 + 2 * cellH;
  y += 0.08;
  if (y + declH > limitLast) {
    footer(H - 0.06 - footH);
    y = startPage(false);
  }
  pdf.setFillColor(...INK);
  pdf.rect(M, y, INNER, 0.22, 'F');
  pdf.setTextColor(...PAPER);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5);
  pdf.text('NURSERY STOCK DECLARATION — SUMMARY', M + 0.06, y + 0.15);
  pdf.setFont('courier', 'bold'); pdf.setFontSize(6.5);
  pdf.text(cfg.code, W - M - 0.06, y + 0.15, { align: 'right' });
  y += 0.22;
  const cell = (cx, cy, num, cap, text, bold) => {
    const x0 = M + cx * cellW, y0 = y + cy * cellH;
    pdf.setDrawColor(...INK); pdf.setLineWidth(0.012);
    pdf.rect(x0, y0, cellW, cellH);
    pdf.setTextColor(...INK); pdf.setFont('courier', 'bold'); pdf.setFontSize(6);
    pdf.text(`(${num}) ${cap}`, x0 + 0.06, y0 + 0.12);
    pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(6.8);
    pdf.text(pdf.splitTextToSize(text, cellW - 0.12).slice(0, 3), x0 + 0.06, y0 + 0.24);
  };
  cell(0, 0, 1, 'SHIPPER / OWNER', `${cfg.shipFrom.name} — ${addrLines(cfg.shipFrom).join(', ')}`, false);
  cell(1, 0, 2, 'SHIPPED TO', `${recipient} — ${addrLines(a).join(', ')}`, false);
  cell(0, 1, 3, 'COUNTY WHERE GROWN',
    `${cfg.grownAt.county}, ${cfg.grownAt.state === 'CA' ? 'California' : cfg.grownAt.state}\n${cfg.grownAt.line} · Lic. ${cfg.license}`, true);
  cell(1, 1, 4, 'STATEMENT OF CONTENTS', contentsStatement(box), false);
  y += 2 * cellH;

  // FRAGILE strip + footer — anchored to the bottom of the last label.
  pdf.setFillColor(...INK);
  pdf.rect(M, fragY, INNER, fragH, 'F');
  pdf.setTextColor(...PAPER);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12);
  pdf.text('FRAGILE · LIVE PLANTS', W / 2, fragY + 0.17, { align: 'center' });
  pdf.setFontSize(8);
  pdf.text('PLEASE HANDLE WITH CARE', W / 2, fragY + 0.31, { align: 'center' });
  footer(H - 0.06 - footH);

  return pdf;
}
