// Variety + species are now persisted in the `varieties` and `species`
// tables and loaded at runtime via the catalog API. The constants below
// are kept only as a fallback for legacy callers (e.g. the inventory
// variety filter pills); admins can now add or rename varieties via the
// catalog UI.
export const VARIETIES = ['Anthurium', 'Alocasia', 'Monstera', 'Jewel Orchid'];

// Defaults for newly added items. The variety default is matched by name
// (case-insensitive) against the brand's catalog — on a brand with no
// Anthurium variety (e.g. BAE) it simply doesn't apply. Renaming the
// Anthurium variety in the catalog silently disables the default; this
// constant is the one place to update if the shop's main genus changes.
export const DEFAULT_ITEM_TYPE = 'plant';
export const DEFAULT_ADD_VARIETY = 'anthurium';

// Compute the next SKU suffix given a code prefix and the existing items.
// Numbering is GLOBAL across all items; the prefix is purely for display.
// Every SKU minted since 2026-10-02 starts with its BRAND; since 2026-10-08
// that segment is ONE letter (B-ANT-8912, G-JADE-ANT-9808) so it fits the
// label. Plants move between brands, each brand keeps its own numbers, and
// the letter keeps a label unique wherever it is scanned. Same table as
// api/_lib/sku.js — keep the two identical. The active brand is set by
// api.setAuthBrandId.
const BRAND_SKU_LETTER = { bae: 'B', 'bae-gin': 'G' };
export function skuPrefixForBrand(brandId) {
  const id = String(brandId || '').toLowerCase();
  if (BRAND_SKU_LETTER[id]) return BRAND_SKU_LETTER[id];
  return id.split(/[^a-z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase()).join('') || 'X';
}
let skuBrandPrefix = '';
export function setSkuBrand(brandId) { skuBrandPrefix = skuPrefixForBrand(brandId); }

// The number part: 1 … 9999, then A001 … A999, B001 … Z999 — a
// four-character suffix always fits the label. The "serial" is the plain
// count behind both spellings (A001 = 10000). Same encoding as
// api/_lib/sku.js — keep the two identical.
export const SKU_SUFFIX_END_RE = /-(\d+|[A-Z]\d{3})$/;
const FIRST_LETTER_SERIAL = 10000, LETTER_BLOCK = 999;
export function formatSkuSerial(n) {
  const s = Math.max(1, Math.floor(Number(n) || 0));
  if (s < FIRST_LETTER_SERIAL) return String(s);
  const k = Math.min(s, FIRST_LETTER_SERIAL + 26 * LETTER_BLOCK - 1) - FIRST_LETTER_SERIAL;
  return `${String.fromCharCode(65 + Math.floor(k / LETTER_BLOCK))}${String((k % LETTER_BLOCK) + 1).padStart(3, '0')}`;
}
export function parseSkuSerial(suffix) {
  const t = String(suffix || '').trim().toUpperCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = /^([A-Z])(\d{3})$/.exec(t);
  if (!m || parseInt(m[2], 10) < 1) return null;
  return FIRST_LETTER_SERIAL + (m[1].charCodeAt(0) - 65) * LETTER_BLOCK + (parseInt(m[2], 10) - 1);
}
export function skuSerialOf(sku) {
  const m = SKU_SUFFIX_END_RE.exec(String(sku || '').toUpperCase());
  return m ? parseSkuSerial(m[1]) : null;
}

export function nextSkuForCode(code, existingItems) {
  if (!code) return '';
  let max = 0;
  for (const i of existingItems || []) { const s = skuSerialOf(i.sku); if (s != null && s > max) max = s; }
  return `${skuBrandPrefix ? `${skuBrandPrefix}-` : ''}${code}-${formatSkuSerial(max + 1)}`;
}

// SKU preview for a seller-consignment plant: <SELLERCODE>-<VARIETYCODE>-<n>
// (e.g. JADE-ANT-142). Cosmetic only — the server assigns the authoritative SKU
// on save (see api/items.js assignMissingSkus); this just shows the operator
// what to expect in the intake form.
// Seller-consignment preview: <BRAND>-<SELLERCODE>-<VARIETYCODE>-<n>.
export function nextSkuForSeller(sellerCode, varietyCode, existingItems) {
  const base = nextSkuForCode(varietyCode, existingItems); // "BAE-ANT-<n>"
  if (!base) return '';
  if (!sellerCode) return base;
  const cut = skuBrandPrefix ? skuBrandPrefix.length + 1 : 0;
  return `${base.slice(0, cut)}${sellerCode}-${base.slice(cut)}`;
}

export const PRICE_BUCKETS = [
  { label: '$0 – 25', min: 0, max: 25 },
  { label: '$25 – 50', min: 25, max: 50 },
  { label: '$50 – 100', min: 50, max: 100 },
  { label: '$100 – 250', min: 100, max: 250 },
  { label: '$250 – 500', min: 250, max: 500 },
  { label: '$500+', min: 500, max: Infinity },
  { label: 'No price set', min: null, max: null },
];
