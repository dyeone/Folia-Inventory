import { lotTag } from './lotBlock.js';
import { photosOf } from '../forsale/pools.js';
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

// Title: "<###> <name>" — the lineup number, zero-padded to three digits (see
// lotTag: Palmstreet's title search is a substring match, and a bare "2"
// matched 12, 20, 21…), then the plant name — so buyers see a clean product
// name and the operator can call lots by number during the live. The SKU is
// deliberately NOT in the title; it still travels in the dedicated SKU column
// (which is what order reconciliation reads). The number is the item's
// lotNumber (its lineup position); items without one (e.g. the whole-inventory
// export) get just the name. The operator's title override, if set, replaces
// the name — and if it already starts with this lot's number in any padding,
// that prefix is re-padded rather than doubled. Capped at 80 chars.
export function buildTitle(item) {
  const override = (details(item).title != null ? String(details(item).title) : '').trim();
  let base = override || (item.name || '');
  const tag = lotTag(item.lotNumber);
  if (!tag) return base.length > 80 ? base.slice(0, 80) : base;
  const lead = /^(\d{1,4})\s+/.exec(base);
  if (lead && parseInt(lead[1], 10) === parseInt(item.lotNumber, 10)) base = base.slice(lead[0].length);
  const t = base ? `${tag} ${base}` : tag;
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

// Items without an assigned photo fall back to their brand's default tile so
// no listing ever uploads imageless. Keyed by brandId because the art is
// branded (BAE's "??? PLANT · MYSTERY" card); a brand without a tile keeps
// the empty cell. The file ships in this app's public/ folder — a stable
// public URL, no signed-URL expiry to rot inside an exported CSV.
const DEFAULT_IMAGE_BY_BRAND = {
  bae: 'https://folia-inventory.vercel.app/bae-mystery-tile.png',
};

// The Image URL cell: every photo of the plant, cover first (For Sale tab,
// migration 0053), then its video when it has one (0052), joined by the
// operator's chosen separator — Palmstreet's template doesn't document how
// several media share the cell, so the separator is a setting
// (src/forsale/ForSaleView.jsx, per device).
export const MEDIA_SEPARATORS = {
  comma: { label: 'Comma', sep: ',' },
  semicolon: { label: 'Semicolon', sep: ';' },
  newline: { label: 'New line', sep: '\n' },
  space: { label: 'Space', sep: ' ' },
};
export function mediaCell(item, separator = 'comma') {
  const photos = photosOf(item);
  if (!photos.length && DEFAULT_IMAGE_BY_BRAND[item.brandId]) photos.push(DEFAULT_IMAGE_BY_BRAND[item.brandId]);
  const sep = (MEDIA_SEPARATORS[separator] || MEDIA_SEPARATORS.comma).sep;
  return [...photos, item.videoUrl || ''].filter(Boolean).join(sep);
}

// One 14-column row in the template's exact order. `title` overrides the
// lineup-number title (the For Sale pool titles by plant code instead).
// All photos + the video go in only when a `separator` is given (the For
// Sale tab's exports); every other export keeps the single cover URL.
function baseRow(item, price, { separator = null, title } = {}) {
  return [
    title ?? buildTitle(item),
    buildDescription(item),
    separator ? mediaCell(item, separator) : (item.imageUrl || DEFAULT_IMAGE_BY_BRAND[item.brandId] || ''),
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

export function exportPalmstreetCsv(sale, items, { separator = null } = {}) {
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

  const rows = saleItems.map(item => baseRow(item, parseFloat(item.listingPrice) || 0, { separator }));
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

// "KM42 Anthurium crystallinum" — the For Sale pool's title: the plant's
// short code first (the packer finds the pot by it, like a lineup number in
// a live), then the operator's title override or the name. Capped at 80.
export function buildPoolTitle(item) {
  const override = (details(item).title != null ? String(details(item).title) : '').trim();
  const name = override || item.name || '';
  const code = String(item.saleCode || '').trim();
  const t = code && !name.toUpperCase().startsWith(code) ? `${code} ${name}`.trim() : name;
  return t.length > 80 ? t.slice(0, 80) : t;
}

// The Palmstreet pool (For Sale tab): every priced plant in it as one CSV,
// its photos + video in the Image URL cell. A plant without a price is left out
// (a $0 row would list it at $0) and counted in `unpriced`.
export function exportPoolToPalmstreet(items, { separator = 'comma' } = {}) {
  const priced = items.filter(i => parseFloat(i.listingPrice) > 0);
  const unpriced = items.length - priced.length;
  if (items.length === 0) return { ok: false, reason: 'The Palmstreet pool is empty.' };
  if (priced.length === 0) return { ok: false, reason: `None of the ${items.length} plants has a price yet.` };
  const rows = [...priced]
    .sort((a, b) => String(a.saleCode || '').localeCompare(String(b.saleCode || '')))
    .map(item => baseRow(item, parseFloat(item.listingPrice), { separator, title: buildPoolTitle(item) }));
  const stamp = new Date().toISOString().slice(0, 10);
  download(toCsv(rows), `palmstreet-pool-${stamp}.csv`);
  return { ok: true, count: rows.length, unpriced, withVideo: priced.filter(i => i.videoUrl).length };
}
