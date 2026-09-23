// Wholesale order → "received items" CSV: one row per plant the order has
// minted so far, with the SKU and the LIST price (what it should sell for).
// Pure functions so the shape is testable without React; the card only
// wires the button. BOM + CRLF so Excel opens it cleanly with accents.

export const RECEIVED_CSV_COLUMNS = [
  ['SKU',        (r) => r.sku],
  ['Plant',      (r) => r.name],
  ['Variety',    (r) => r.variety],
  ['List price', (r) => (r.listPrice != null ? Number(r.listPrice).toFixed(2) : '')],
  ['Type',       (r) => (r.type === 'tc' ? 'TC' : r.type === 'plant' ? 'Plant' : r.type)],
  ['Status',     (r) => r.status],
  ['Lot',        (r) => r.lotNumber],
  ['Received',   (r) => (r.receivedAt ? String(r.receivedAt).slice(0, 10) : '')],
  ['By',         (r) => r.receivedBy],
];

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function buildReceivedCsv(rows) {
  const lines = [RECEIVED_CSV_COLUMNS.map(([h]) => esc(h)).join(',')];
  for (const r of rows || []) lines.push(RECEIVED_CSV_COLUMNS.map(([, get]) => esc(get(r))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function receivedCsvFilename(po) {
  const slug = String(po?.supplier || 'wholesale').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'wholesale';
  const date = po?.createdAt ? String(po.createdAt).slice(0, 10) : '';
  return `${slug}${date ? `-${date}` : ''}-received.csv`;
}

export function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
