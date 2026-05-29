// Build a Palmstreet CSV — for a single sale event, or for the entire
// "available" inventory ready to be listed. Both modes share the same
// header set so Palmstreet ingests them identically.
//
// Per-item listing overrides — title, description, up to three variation
// name/value pairs, the private-listing flag, and a shipping note — come from
// the item's `listingDetails` JSONB, filled in on the Pre Sale tab (migration
// 0020). Price, quantity, image URL and SKU read from their own columns. The
// column order below matches Palmstreet's upload template exactly.

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

function details(item) {
  const o = item && item.listingDetails;
  return o && typeof o === 'object' ? o : {};
}

// Title: operator override first, else "<name> <variety>" capped at 80 chars.
function buildTitle(item) {
  const override = (details(item).title != null ? String(details(item).title) : '').trim();
  let t = override;
  if (!t) {
    t = item.name || '';
    if (item.variety) t = `${t} ${item.variety}`.trim();
  }
  return t.length > 80 ? t.slice(0, 80) : t;
}

// Description: operator override first, else a sentence built from the item.
function buildDescription(item) {
  const override = (details(item).description != null ? String(details(item).description) : '').trim();
  if (override) return override;
  const parts = [];
  if (item.name) parts.push(item.name);
  if (item.variety) parts.push(`Variety: ${item.variety}`);
  if (item.notes) parts.push(item.notes);
  return parts.join('. ');
}

// Six cells in Palmstreet order: v1 name, v1 value, v2 name, v2 value, …
function variationCells(item) {
  const v = details(item).variations;
  const arr = Array.isArray(v) ? v : [];
  const cells = [];
  for (let i = 0; i < 3; i++) {
    const x = arr[i] || {};
    cells.push(x.name || '', x.value || '');
  }
  return cells;
}

// One 14-column row in the template's exact order.
function baseRow(item, price) {
  return [
    buildTitle(item),
    buildDescription(item),
    item.imageUrl || '',
    price,
    parseInt(item.quantity) || 1,
    ...variationCells(item),
    item.sku || '',
    details(item).private ? 'Yes' : '',
    details(item).shipping || '',
  ];
}

function toCsv(rows) {
  return [
    HEADERS.map(escapeCsv).join(','),
    ...rows.map(r => r.map(escapeCsv).join(',')),
  ].join('\n');
}

function download(csv, filename) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

  const rows = saleItems.map(item => baseRow(item, parseFloat(item.listingPrice) || 0));
  const safeName = (sale.name || 'sale').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  download(toCsv(rows), `palmstreet-${safeName}-${sale.date || 'event'}.csv`);
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
    return baseRow(item, price);
  });

  const stamp = new Date().toISOString().slice(0, 10);
  download(toCsv(rows), `palmstreet-inventory-${stamp}.csv`);
  return { ok: true, count: eligible.length, pricedFromIdeal, priceless };
}
