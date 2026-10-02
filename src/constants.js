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
// Every SKU minted since 2026-10-02 starts with its BRAND (BAE-ANT-8912,
// BAEGIN-JADE-ANT-9808): plants move between brands, each brand keeps its
// own numbers, and the brand segment is what keeps a label unique wherever
// it is scanned. Same rule as api/_lib/sku.js — keep the two identical.
// The active brand is set by api.setAuthBrandId.
export function skuPrefixForBrand(brandId) {
  return String(brandId || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}
let skuBrandPrefix = '';
export function setSkuBrand(brandId) { skuBrandPrefix = skuPrefixForBrand(brandId); }

export function nextSkuForCode(code, existingItems) {
  if (!code) return '';
  const nums = (existingItems || [])
    .map(i => {
      const m = String(i.sku || '').match(/-(\d+)$/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter(n => n > 0);
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `${skuBrandPrefix ? `${skuBrandPrefix}-` : ''}${code}-${next}`;
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
