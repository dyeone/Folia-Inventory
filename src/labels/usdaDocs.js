// USDA / CA nursery-stock compliance documents, printed per box for
// shipments that route through agricultural inspection (rural counties):
//
//   • Sticker — 6×4 "LIVE NURSERY STOCK" label (CA F&A Code §6501) with
//     county-where-grown, from/to, and a statement of contents. Prints on
//     the 4×6 label stock (landscape).
//   • Slip — letter-size packing slip with shipper/consignee panels, an
//     item table, and the §6501(c) nursery stock declaration summary.
//     Goes inside the box on plain paper.
//
// Both are drawn with jsPDF primitives in the BAE house style (red band,
// black blocks, mono accents). Business/grower facts live in USDA_CONFIG
// below — edit there when the license, grow site, or addresses change.

import { shortBoxCode } from './boxCode.js';

const RED = [240, 57, 46];
const BLACK = [17, 17, 17];
const CREAM = [244, 239, 220];

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

// ── Sticker: 6×4 landscape (prints on the 4×6 label stock) ────────────────
export async function openUsdaStickerPdf(box) {
  openPdf(await buildUsdaStickerPdf(box));
}

export async function buildUsdaStickerPdf(box) {
  const cfg = usdaConfig();
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'in', format: [4, 6], orientation: 'landscape' });
  const W = 6, M = 0.28;

  // Outer frame
  pdf.setDrawColor(...BLACK); pdf.setLineWidth(0.03);
  pdf.rect(0.06, 0.06, W - 0.12, 4 - 0.12);

  // Red header band
  pdf.setFillColor(...RED);
  pdf.rect(0.06, 0.06, W - 0.12, 0.62, 'F');
  pdf.setTextColor(...BLACK);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(23);
  pdf.text('LIVE NURSERY STOCK', M, 0.51);
  pdf.setFont('courier', 'bold'); pdf.setFontSize(10);
  pdf.text(cfg.code, W - M, 0.42, { align: 'right' });

  // County where grown
  let y = 1.02;
  pdf.setTextColor(...RED);
  pdf.setFont('courier', 'bold'); pdf.setFontSize(8.5);
  pdf.text('C O U N T Y   W H E R E   G R O W N', M, y);
  y += 0.3;
  pdf.setTextColor(...BLACK);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(21);
  pdf.text(`${cfg.grownAt.county}, ${cfg.grownAt.state}`.toUpperCase(), M, y);
  y += 0.24;
  pdf.setFont('courier', 'normal'); pdf.setFontSize(9.5);
  pdf.text(`${cfg.grownAt.line} · Lic. ${cfg.license}`, M, y);

  // From / To
  y += 0.18;
  pdf.setLineWidth(0.014); pdf.line(M, y, W - M, y);
  y += 0.26;
  const col2 = W / 2 + 0.1;
  pdf.setTextColor(...RED); pdf.setFont('courier', 'bold'); pdf.setFontSize(8.5);
  pdf.text('F R O M', M, y);
  pdf.text('T O', col2, y);
  pdf.setTextColor(...BLACK);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12);
  pdf.text(cfg.shipFrom.name, M, y + 0.22);
  pdf.text(String(box.recipientName || 'Recipient'), col2, y + 0.22);
  pdf.setFont('courier', 'normal'); pdf.setFontSize(9.5);
  const from = addrLines(cfg.shipFrom);
  const to = addrLines(box.address || {});
  from.forEach((l, i) => pdf.text(l, M, y + 0.42 + i * 0.17));
  to.forEach((l, i) => pdf.text(l, col2, y + 0.42 + i * 0.17));
  y += 0.42 + Math.max(from.length, to.length, 2) * 0.17;

  // Contents
  pdf.setLineWidth(0.014); pdf.line(M, y, W - M, y);
  y += 0.26;
  pdf.setTextColor(...RED); pdf.setFont('courier', 'bold'); pdf.setFontSize(8.5);
  pdf.text('C O N T E N T S', M, y);
  y += 0.22;
  pdf.setTextColor(...BLACK); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11.5);
  pdf.text(pdf.splitTextToSize(contentsStatement(box), W - 2 * M), M, y);

  // Footer band
  pdf.setFillColor(...BLACK);
  pdf.rect(0.06, 4 - 0.06 - 0.4, W - 0.12, 0.4, 'F');
  pdf.setTextColor(...CREAM);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13);
  pdf.text(cfg.short, M, 4 - 0.2);
  pdf.setFont('courier', 'bold'); pdf.setFontSize(8.5);
  pdf.text(cfg.wordmark.split('').join(' '), W - M, 4 - 0.21, { align: 'right' });

  return pdf;
}

// ── Slip: letter-size nursery-stock packing slip (goes inside the box) ────
export async function openUsdaSlipPdf(box, shipment) {
  openPdf(await buildUsdaSlipPdf(box, shipment));
}

export async function buildUsdaSlipPdf(box, shipment) {
  const cfg = usdaConfig();
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'in', format: 'letter' });
  const W = 8.5, M = 0.6;
  const a = box.address || {};

  // Header
  pdf.setTextColor(...BLACK);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(30);
  pdf.text(cfg.short, M, 1.0);
  pdf.setTextColor(...RED); pdf.setFont('courier', 'bold'); pdf.setFontSize(9);
  pdf.text(`+ ${cfg.wordmark.split('').join(' ')}`, M + pdf.getTextWidth(cfg.short) / 4 + 1.15, 0.97);
  pdf.setTextColor(...BLACK);
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
    pdf.setTextColor(120, 120, 120);
    pdf.text(k, W - M - pdf.getTextWidth(v) - 0.12, yy, { align: 'right' });
    pdf.setTextColor(...BLACK);
    pdf.setFont('courier', k === 'LIC' ? 'bold' : 'normal');
    pdf.text(v, W - M, yy, { align: 'right' });
    pdf.setFont('courier', 'normal');
  });

  pdf.setDrawColor(...BLACK); pdf.setLineWidth(0.03);
  pdf.line(M, 1.62, W - M, 1.62);

  // Ship-from / deliver-to panels
  const panelY = 1.85, panelH = 2.15, panelW = (W - 2 * M - 0.3) / 2;
  const drawPanel = (x, caption, name, lines, subCaption, subLines) => {
    pdf.setLineWidth(0.016);
    pdf.rect(x, panelY, panelW, panelH);
    pdf.setTextColor(...RED); pdf.setFont('courier', 'bold'); pdf.setFontSize(8);
    pdf.text(caption, x + 0.18, panelY + 0.28);
    pdf.setTextColor(...BLACK); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(13);
    pdf.text(name, x + 0.18, panelY + 0.55);
    pdf.setFont('courier', 'normal'); pdf.setFontSize(9.5);
    lines.forEach((l, i) => pdf.text(l, x + 0.18, panelY + 0.78 + i * 0.19));
    const subY = panelY + 0.78 + lines.length * 0.19 + 0.08;
    pdf.setLineDashPattern([0.02, 0.02], 0);
    pdf.setLineWidth(0.008);
    pdf.line(x + 0.18, subY, x + panelW - 0.18, subY);
    pdf.setLineDashPattern([], 0);
    pdf.setTextColor(120, 120, 120); pdf.setFontSize(8.5);
    pdf.text(subCaption, x + 0.18, subY + 0.2);
    pdf.setTextColor(...BLACK); pdf.setFontSize(9);
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
    String(box.recipientName || 'Recipient').toUpperCase(),
    [box.username ? `@${String(box.username).replace(/^@/, '')}` : '', ...addrLines(a)].filter(Boolean),
    'ORDER GROUP',
    [`${orderCount} ORDER${orderCount === 1 ? '' : 'S'}`, [a.city, a.state].filter(Boolean).join(', ').toUpperCase()],
  );

  // Item table
  let y = panelY + panelH + 0.3;
  const cols = { item: M + 0.15, sku: 4.7, qty: 5.9, ship: 6.7, price: W - M - 0.15 };
  pdf.setFillColor(...BLACK);
  pdf.rect(M, y, W - 2 * M, 0.32, 'F');
  pdf.setTextColor(...CREAM); pdf.setFont('courier', 'bold'); pdf.setFontSize(9);
  pdf.text('ITEM', cols.item, y + 0.21);
  pdf.text('SKU', cols.sku, y + 0.21);
  pdf.text('QTY', cols.qty, y + 0.21, { align: 'right' });
  pdf.text('SHIPPING', cols.ship + 0.5, y + 0.21, { align: 'right' });
  pdf.text('PRICE', cols.price, y + 0.21, { align: 'right' });
  y += 0.32;

  const money = (v) => `$${(parseFloat(v) || 0).toFixed(2)}`;
  let subtotal = 0;
  const rows = (box.items || []);
  pdf.setTextColor(...BLACK);
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
    pdf.setDrawColor(220, 220, 220); pdf.setLineWidth(0.008);
    pdf.line(M, y, W - M, y);
    if (y > 8.3) break; // keep one page; overflow boxes list the first ~15
  }

  // Totals
  const shipTotal = parseFloat(box.shippingFeeCollected) || 0;
  const totX = 5.4;
  pdf.setDrawColor(...BLACK); pdf.setLineWidth(0.016);
  const totRow = (label, value, dark) => {
    if (dark) {
      pdf.setFillColor(...BLACK);
      pdf.rect(totX, y, W - M - totX, 0.36, 'F');
      pdf.setTextColor(...CREAM);
    } else {
      pdf.rect(totX, y, W - M - totX, 0.32);
      pdf.setTextColor(120, 120, 120);
    }
    pdf.setFont('courier', dark ? 'bold' : 'normal'); pdf.setFontSize(dark ? 11 : 9.5);
    pdf.text(label, totX + 0.15, y + (dark ? 0.245 : 0.215));
    if (!dark) pdf.setTextColor(...BLACK);
    pdf.text(value, W - M - 0.15, y + (dark ? 0.245 : 0.215), { align: 'right' });
    y += dark ? 0.36 : 0.32;
  };
  totRow('SUBTOTAL', money(subtotal), false);
  totRow('SHIPPING', money(shipTotal), false);
  totRow('TOTAL', money(subtotal + shipTotal), true);
  pdf.setTextColor(...BLACK);

  // Declaration block
  y += 0.3;
  pdf.setFillColor(...BLACK);
  pdf.rect(M, y, W - 2 * M, 0.36, 'F');
  pdf.setTextColor(...CREAM);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(11);
  pdf.text('NURSERY STOCK DECLARATION — SUMMARY', M + 0.15, y + 0.25);
  pdf.setFont('courier', 'normal'); pdf.setFontSize(8);
  pdf.text(cfg.codeLong, W - M - 0.15, y + 0.24, { align: 'right' });
  y += 0.36;
  const cellW = (W - 2 * M) / 2, cellH = 0.95;
  const cell = (cx, cy, num, caption, text, bold) => {
    pdf.setDrawColor(...BLACK); pdf.setLineWidth(0.012);
    pdf.rect(M + cx * cellW, y + cy * cellH, cellW, cellH);
    pdf.setTextColor(120, 120, 120); pdf.setFont('courier', 'normal'); pdf.setFontSize(8);
    pdf.text(`(${num}) ${caption}`, M + cx * cellW + 0.15, y + cy * cellH + 0.22);
    pdf.setTextColor(...BLACK);
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
    `${box.recipientName || 'Recipient'} — ${addrLines(a).join(', ')}`, false);
  cell(0, 1, 3, 'COUNTY WHERE GROWN',
    `${cfg.grownAt.county}, ${cfg.grownAt.state === 'CA' ? 'California' : cfg.grownAt.state}\n${cfg.grownAt.line} · Lic. ${cfg.license}`, true);
  cell(1, 1, 4, 'STATEMENT OF CONTENTS', contentsStatement(box), false);
  y += 2 * cellH;

  // Footer
  pdf.setDrawColor(...BLACK); pdf.setLineWidth(0.02);
  pdf.line(M, 10.3, W - M, 10.3);
  pdf.setTextColor(120, 120, 120); pdf.setFont('courier', 'normal'); pdf.setFontSize(8);
  pdf.text(cfg.footer, M, 10.52);
  pdf.text('SHEET 1 OF 1 · ENCLOSE IN BOX', W - M, 10.52, { align: 'right' });

  return pdf;
}
