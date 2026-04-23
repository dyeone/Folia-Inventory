// Build a Palmstreet CSV from a sale's items and trigger a download.
// Giveaway items are skipped (Palmstreet only ingests purchasable lots).

const HEADERS = [
  'Title (product name, 80 character max)*',
  'Item description*',
  'Image URL',
  'Price*',
  'Quantity* ',
  'Variation 1 name',
  'Variation 1 value ',
  'Variation 2 name',
  'Variation 2 value',
  'Variation 3 name',
  'Variation 3 value',
  'SKU',
  'Mark "Yes" for Private listing',
  'Shipping (Leave empty will follow store setting...)',
];

function escapeCsv(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildTitle(item) {
  let t = item.name || '';
  if (item.variety) t = `${t} ${item.variety}`.trim();
  if (t.length > 80) t = t.slice(0, 80);
  return t;
}

function buildDescription(item) {
  const parts = [];
  if (item.name) parts.push(item.name);
  if (item.variety) parts.push(`Variety: ${item.variety}`);
  if (item.notes) parts.push(item.notes);
  return parts.join('. ');
}

export function exportPalmstreetCsv(sale, items) {
  const saleItems = items
    .filter(i => i.saleId === sale.id && i.lotKind !== 'giveaway')
    .sort((a, b) => {
      const la = parseInt(a.lotNumber) || 999999;
      const lb = parseInt(b.lotNumber) || 999999;
      return la - lb;
    });

  if (saleItems.length === 0) {
    return { ok: false, reason: 'No sale lots in this event yet.' };
  }

  const rows = saleItems.map(item => [
    buildTitle(item),
    buildDescription(item),
    item.imageUrl || '',
    parseFloat(item.listingPrice) || 0,
    parseInt(item.quantity) || 1,
    '', '',
    '', '',
    '', '',
    item.sku || '',
    '',
    '',
  ]);

  const csv = [
    HEADERS.map(escapeCsv).join(','),
    ...rows.map(r => r.map(escapeCsv).join(',')),
  ].join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (sale.name || 'sale').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  a.href = url;
  a.download = `palmstreet-${safeName}-${sale.date || 'event'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return { ok: true, count: saleItems.length };
}
