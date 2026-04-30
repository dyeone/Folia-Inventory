// Build a Palmstreet CSV — for a single sale event, or for the entire
// "available" inventory ready to be listed. Both modes share the same
// header set so Palmstreet ingests them identically.

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

// Mirror of the Ideal $ cascade in InventoryView so the export uses the
// same recommended price the user sees on screen.
function fallbackIdealPrice(item, varieties, species, globalRate) {
  const explicit = parseFloat(item.idealPrice);
  if (Number.isFinite(explicit)) return explicit;
  const cost = parseFloat(item.netCost) || parseFloat(item.grossCost ?? item.cost);
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const itemRate = parseFloat(item.profitRate);
  if (Number.isFinite(itemRate)) return cost * (1 + itemRate / 100);
  let sp = item.speciesId ? species.find(s => s.id === item.speciesId) : null;
  if (!sp) {
    const v = varieties.find(v => v.name === item.variety);
    if (v) sp = species.find(s => s.varietyId === v.id && s.epithet === item.name);
  }
  const spRate = parseFloat(sp?.profitRate);
  if (Number.isFinite(spRate)) return cost * (1 + spRate / 100);
  const g = parseFloat(globalRate);
  return Number.isFinite(g) ? cost * (1 + g / 100) : null;
}

// Export every status='available' item not already attached to a sale.
// Listing price falls through to the ideal-price cascade so freshly
// imported items still get a sensible number on Palmstreet.
export function exportAvailableToPalmstreet(items, varieties = [], species = [], idealRate = null) {
  const eligible = items
    .filter(i => i.status === 'available' && !i.saleId && i.lotKind !== 'giveaway')
    .sort((a, b) => String(a.sku || '').localeCompare(String(b.sku || ''), undefined, { numeric: true }));

  if (eligible.length === 0) {
    return { ok: false, reason: 'No available, unassigned inventory to export.' };
  }

  let pricedFromIdeal = 0;
  let priceless = 0;
  const rows = eligible.map(item => {
    let price = parseFloat(item.listingPrice);
    if (!Number.isFinite(price) || price <= 0) {
      const ideal = fallbackIdealPrice(item, varieties, species, idealRate);
      if (Number.isFinite(ideal) && ideal > 0) {
        price = Number(ideal.toFixed(2));
        pricedFromIdeal += 1;
      } else {
        price = 0;
        priceless += 1;
      }
    }
    return [
      buildTitle(item),
      buildDescription(item),
      item.imageUrl || '',
      price,
      parseInt(item.quantity) || 1,
      '', '',
      '', '',
      '', '',
      item.sku || '',
      '',
      '',
    ];
  });

  const csv = [
    HEADERS.map(escapeCsv).join(','),
    ...rows.map(r => r.map(escapeCsv).join(',')),
  ].join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `palmstreet-inventory-${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return { ok: true, count: eligible.length, pricedFromIdeal, priceless };
}
