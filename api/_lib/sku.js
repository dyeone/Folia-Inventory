// Every SKU minted from 2026-10-02 on starts with its BRAND: BAE-ANT-8912,
// BAEGIN-JADE-ANT-9808. The brands share plants now (cross-brand transfer)
// and each keeps its own number sequence, so the brand segment is what
// makes a label mean one plant wherever it is scanned. Older SKUs stay as
// they are. Derived from the brand id, so no table change: 'bae' → BAE,
// 'bae-gin' → BAEGIN. The client previews use the same rule
// (src/constants.js skuPrefixForBrand) — keep the two identical.
export function brandSkuPrefix(brandId) {
  return String(brandId || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}
