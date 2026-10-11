import { shortBoxCode } from '../labels/boxCode.js';

// Plants that ship with a tag: OUR OWN plants the buyer paid $100 or more
// for. Consignment plants (sold for a seller — sellerId set, SKU carries the
// seller's code) never get one, whatever they sold for. One rule, used
// everywhere it shows — the "N tags" chip on a box (Shipping cards, the
// packer's box header), the TAG mark on the plant's own line, the packer's
// banner, and the weekly XLS the tag-maker works from.
//
// A Validate Sales placeholder (UNMATCHED-…) is still a plant the buyer
// paid for — it just isn't linked to inventory — so it counts, with an
// empty SKU. A DBL- line is a double-sale flag on a plant already counted,
// not a plant, so it never does. Hold lines, upgrades, coupons and
// giveaways fall out on price.
export const TAG_PRICE_MIN = 100;

export function needsTag(item) {
  if (!item || item.deletedAt) return false;
  if (item.sellerId) return false;                 // consignment: the seller's plant, no tag
  if (/^DBL-/i.test(item.sku || '')) return false;
  const price = parseFloat(item.salePrice);
  return Number.isFinite(price) && price >= TAG_PRICE_MIN;
}

export function tagItemsOf(box) {
  return (box?.items || []).filter(needsTag);
}

const isPlaceholder = (sku) => /^UNMATCHED-/i.test(sku || '');

// One row per plant that needs a tag, in lineup order: the live number
// the packer finds it by, the SKU, the species (genus line) and the name
// (cultivar), then the price it sold for, how many, who bought it and the
// box it ships in.
export function buildTagRows(boxes) {
  const rows = [];
  for (const box of boxes || []) {
    const buyer = box.recipientName || box.buyer || box.items?.[0]?.buyer || '';
    for (const item of tagItemsOf(box)) {
      rows.push({
        lot: item.lotNumber ? String(item.lotNumber) : '',
        sku: isPlaceholder(item.sku) ? '' : (item.sku || ''),
        species: item.variety || '',
        name: item.name || '',
        price: Math.round(parseFloat(item.salePrice) * 100) / 100,
        qty: parseInt(item.quantity, 10) || 1,
        buyer,
        box: shortBoxCode(box.id),
      });
    }
  }
  rows.sort((a, b) => {
    const la = parseInt(a.lot, 10), lb = parseInt(b.lot, 10);
    if (Number.isFinite(la) && Number.isFinite(lb) && la !== lb) return la - lb;
    if (Number.isFinite(la) !== Number.isFinite(lb)) return Number.isFinite(la) ? -1 : 1;
    return a.box.localeCompare(b.box) || a.sku.localeCompare(b.sku);
  });
  return rows;
}

export const TAG_COLUMNS = [
  ['lot', 'Live #', 8], ['sku', 'SKU', 16], ['species', 'Species', 18], ['name', 'Name', 32],
  ['price', 'Price', 9], ['qty', 'Qty', 5], ['buyer', 'Buyer', 22], ['box', 'Box', 8],
];

export async function downloadTagsXlsx(rows, stem = 'tags') {
  const XLSX = await import('xlsx');
  const sheetRows = rows.map((r) => Object.fromEntries(TAG_COLUMNS.map(([key, label]) => [label, r[key]])));
  const ws = XLSX.utils.json_to_sheet(sheetRows, { header: TAG_COLUMNS.map(([, label]) => label) });
  ws['!cols'] = TAG_COLUMNS.map(([, , wch]) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tags');
  XLSX.writeFile(wb, `${stem}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
