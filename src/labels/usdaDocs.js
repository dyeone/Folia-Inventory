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
//   • Slip — letter-size packing slip with shipper/consignee panels, an
//     item table, the §6501(c) nursery stock declaration summary and the
//     same FRAGILE line. Goes inside the box on plain paper: prints to the
//     desk's document printer (bridge role 'document', like Print list),
//     browser dialog when the bridge is offline. Same black-on-white
//     treatment as the sticker so a mono laser or thermal prints it clean.
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

// ── Slip: letter-size nursery-stock packing slip (goes inside the box) ────

// Print the slip on the desk's document printer (bridge role 'document';
// no media override — the Docs queue's own default is letter), browser
// print when the bridge is offline.
export async function printUsdaSlip(box, shipment, showToast) {
  const pdf = await buildUsdaSlipPdf(box, shipment);
  return printGeneratedPdf(pdf, { role: 'document', media: null, what: 'USDA slip' }, showToast);
}

// Kept for callers that want the PDF in a tab (preview / manual print).
export async function openUsdaSlipPdf(box, shipment) {
  openPdf(await buildUsdaSlipPdf(box, shipment));
}

export async function buildUsdaSlipPdf(box, shipment) {
  const cfg = usdaConfig();
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'in', format: 'letter' });
  const W = 8.5, M = 0.6;
  const a = addressOf(box);
  const recipient = recipientOf(box);

  // Header
  pdf.setTextColor(...INK);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(30);
  pdf.text(cfg.short, M, 1.0);
  pdf.setTextColor(...INK); pdf.setFont('courier', 'bold'); pdf.setFontSize(9);
  pdf.text(`+ ${cfg.wordmark.split('').join(' ')}`, M + pdf.getTextWidth(cfg.short) / 4 + 1.15, 0.97);
  pdf.setTextColor(...INK);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(16);
  pdf.text('PACKING SLIP', M, 1.42);

  pdf.setFont('courier', 'normal'); pdf.setFontSize(9.5);
  const metaRight = [
    ['SLIP', `#${shortBoxCode(box.id).replace(/^B-/, '')}`],
    ['DATE', new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).toUpperCase()],
    ...(shipment?.trackingNumber ? [[String(box.carrier || '').toUpperCase() || 'TRK', shipment.trackingNumber]] : []),
    ['LIC', cfg.license],
  ];
  metaRight.forEach(([k, v], i) => {
    const yy = 0.78 + i * 0.2;
    pdf.setTextColor(...INK);
    pdf.text(k, W - M - pdf.getTextWidth(v) - 0.12, yy, { align: 'right' });
    pdf.setTextColor(...INK);
    pdf.setFont('courier', k === 'LIC' ? 'bold' : 'normal');
    pdf.text(v, W - M, yy, { align: 'right' });
    pdf.setFont('courier', 'normal');
  });

  pdf.setDrawColor(...INK); pdf.setLineWidth(0.03);
  pdf.line(M, 1.62, W - M, 1.62);

  // Ship-from / deliver-to panels
  const panelY = 1.85, panelH = 2.15, panelW = (W - 2 * M - 0.3) / 2;
  const drawPanel = (x, caption, name, lines, subCaption, subLines) => {
    pdf.setLineWidth(0.016);
    pdf.rect(x, panelY, panelW, panelH);
    pdf.setTextColor(...INK); pdf.setFont('courier', 'bold'); pdf.setFontSize(8);
    pdf.text(caption, x + 0.18, panelY + 0.28);
    pdf.setTextColor(...INK); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13);
    pdf.text(name, x + 0.18, panelY + 0.55);
    pdf.setFont('courier', 'normal'); pdf.setFontSize(9.5);
    lines.forEach((l, i) => pdf.text(l, x + 0.18, panelY + 0.78 + i * 0.19));
    const subY = panelY + 0.78 + lines.length * 0.19 + 0.08;
    pdf.setLineDashPattern([0.02, 0.02], 0);
    pdf.setLineWidth(0.008);
    pdf.line(x + 0.18, subY, x + panelW - 0.18, subY);
    pdf.setLineDashPattern([], 0);
    pdf.setTextColor(...INK); pdf.setFontSize(8.5);
    pdf.text(subCaption, x + 0.18, subY + 0.2);
    pdf.setTextColor(...INK); pdf.setFontSize(9);
    subLines.forEach((l, i) => pdf.text(l, x + 0.18, subY + 0.38 + i * 0.17));
  };
  const orderCount = new Set((box.items || []).map(i => i.orderId).filter(Boolean)).size || 1;
  drawPanel(
    M, 'SHIP FROM · SHIPPER / OWNER',
    cfg.shipFrom.name.toUpperCase(),
    [cfg.shipFrom.username, ...addrLines(cfg.shipFrom)],
    'GROWN AT',
    [cfg.grownAt.line, `LICENSE ${cfg.license}`],
  );
  drawPanel(
    M + panelW + 0.3, 'DELIVER TO · CONSIGNEE',
    recipient.toUpperCase(),
    [(box.username || box.buyerUsername) ? `@${String(box.username || box.buyerUsername).replace(/^@/, '')}` : '', ...addrLines(a)].filter(Boolean),
    'ORDER GROUP',
    [`${orderCount} ORDER${orderCount === 1 ? '' : 'S'}`, [a.city, a.state].filter(Boolean).join(', ').toUpperCase()],
  );

  // Item table
  let y = panelY + panelH + 0.3;
  const cols = { item: M + 0.15, sku: 4.7, qty: 5.9, ship: 6.7, price: W - M - 0.15 };
  pdf.setFillColor(...INK);
  pdf.rect(M, y, W - 2 * M, 0.32, 'F');
  pdf.setTextColor(...PAPER); pdf.setFont('courier', 'bold'); pdf.setFontSize(9);
  pdf.text('ITEM', cols.item, y + 0.21);
  pdf.text('SKU', cols.sku, y + 0.21);
  pdf.text('QTY', cols.qty, y + 0.21, { align: 'right' });
  pdf.text('SHIPPING', cols.ship + 0.5, y + 0.21, { align: 'right' });
  pdf.text('PRICE', cols.price, y + 0.21, { align: 'right' });
  y += 0.32;

  const money = (v) => `$${(parseFloat(v) || 0).toFixed(2)}`;
  let subtotal = 0;
  const rows = (box.items || []);
  pdf.setTextColor(...INK);
  for (const it of rows) {
    const price = parseFloat(it.salePrice) || 0;
    subtotal += price;
    const name = [it.lotNumber, it.name, it.variety && it.variety !== it.name ? `– ${it.variety}` : '']
      .filter(Boolean).join(' ').slice(0, 58);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9.5);
    pdf.text(name, cols.item, y + 0.22);
    pdf.setFont('courier', 'normal'); pdf.setFontSize(9);
    pdf.text(String(it.sku || '').slice(0, 14), cols.sku, y + 0.22);
    pdf.text(String(parseInt(it.quantity, 10) || 1), cols.qty, y + 0.22, { align: 'right' });
    pdf.text(it.orderShippingFee != null ? money(it.orderShippingFee) : '—', cols.ship + 0.5, y + 0.22, { align: 'right' });
    pdf.text(money(price), cols.price, y + 0.22, { align: 'right' });
    y += 0.3;
    pdf.setDrawColor(...INK); pdf.setLineWidth(0.006);
    pdf.line(M, y, W - M, y);
    if (y > 8.3) break; // keep one page; overflow boxes list the first ~15
  }

  // Totals
  const shipTotal = parseFloat(box.shippingFeeCollected) || 0;
  const totX = 5.4;
  pdf.setDrawColor(...INK); pdf.setLineWidth(0.016);
  const totRow = (label, value, dark) => {
    if (dark) {
      pdf.setFillColor(...INK);
      pdf.rect(totX, y, W - M - totX, 0.36, 'F');
      pdf.setTextColor(...PAPER);
    } else {
      pdf.rect(totX, y, W - M - totX, 0.32);
      pdf.setTextColor(...INK);
    }
    pdf.setFont('courier', dark ? 'bold' : 'normal'); pdf.setFontSize(dark ? 11 : 9.5);
    pdf.text(label, totX + 0.15, y + (dark ? 0.245 : 0.215));
    if (!dark) pdf.setTextColor(...INK);
    pdf.text(value, W - M - 0.15, y + (dark ? 0.245 : 0.215), { align: 'right' });
    y += dark ? 0.36 : 0.32;
  };
  totRow('SUBTOTAL', money(subtotal), false);
  totRow('SHIPPING', money(shipTotal), false);
  totRow('TOTAL', money(subtotal + shipTotal), true);
  pdf.setTextColor(...INK);

  // Declaration block
  y += 0.3;
  pdf.setFillColor(...INK);
  pdf.rect(M, y, W - 2 * M, 0.36, 'F');
  pdf.setTextColor(...PAPER);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
  pdf.text('NURSERY STOCK DECLARATION — SUMMARY', M + 0.15, y + 0.25);
  pdf.setFont('courier', 'normal'); pdf.setFontSize(8);
  pdf.text(cfg.codeLong, W - M - 0.15, y + 0.24, { align: 'right' });
  y += 0.36;
  const cellW = (W - 2 * M) / 2, cellH = 0.95;
  const cell = (cx, cy, num, caption, text, bold) => {
    pdf.setDrawColor(...INK); pdf.setLineWidth(0.012);
    pdf.rect(M + cx * cellW, y + cy * cellH, cellW, cellH);
    pdf.setTextColor(...INK); pdf.setFont('courier', 'normal'); pdf.setFontSize(8);
    pdf.text(`(${num}) ${caption}`, M + cx * cellW + 0.15, y + cy * cellH + 0.22);
    pdf.setTextColor(...INK);
    pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(9.5);
    pdf.text(
      pdf.splitTextToSize(text, cellW - 0.3),
      M + cx * cellW + 0.15,
      y + cy * cellH + 0.42,
    );
  };
  cell(0, 0, 1, 'SHIPPER / OWNER',
    `${cfg.shipFrom.name} — ${addrLines(cfg.shipFrom).join(', ')}`, false);
  cell(1, 0, 2, 'SHIPPED TO',
    `${recipient} — ${addrLines(a).join(', ')}`, false);
  cell(0, 1, 3, 'COUNTY WHERE GROWN',
    `${cfg.grownAt.county}, ${cfg.grownAt.state === 'CA' ? 'California' : cfg.grownAt.state}\n${cfg.grownAt.line} · Lic. ${cfg.license}`, true);
  cell(1, 1, 4, 'STATEMENT OF CONTENTS', contentsStatement(box), false);
  y += 2 * cellH;

  // FRAGILE strip — same wording as the sticker, so the two documents read
  // as a pair. Sits just above the footer, clear of the declaration grid.
  const stripY = 9.62, stripH = 0.5;
  pdf.setFillColor(...INK);
  pdf.rect(M, stripY, W - 2 * M, stripH, 'F');
  pdf.setTextColor(...PAPER);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(15);
  pdf.text('FRAGILE  ·  LIVE PLANTS  ·  PLEASE HANDLE WITH CARE', W / 2, stripY + 0.33, { align: 'center' });

  // Footer
  pdf.setDrawColor(...INK); pdf.setLineWidth(0.02);
  pdf.line(M, 10.3, W - M, 10.3);
  pdf.setTextColor(...INK); pdf.setFont('courier', 'normal'); pdf.setFontSize(8);
  pdf.text(cfg.footer, M, 10.52);
  pdf.text('SHEET 1 OF 1 · ENCLOSE IN BOX', W - M, 10.52, { align: 'right' });

  return pdf;
}
