// Every SKU minted since 2026-10-02 starts with its BRAND. From 2026-10-08
// the brand segment is ONE letter — B-ANT-8912, G-NC-ANT-9808 — because the
// word ("BAEGIN-") ate a third of a 2-inch label. The brands share plants
// (cross-brand transfer) and each keeps its own number sequence, so the
// letter is what makes a label mean one plant wherever it is scanned.
// Older SKUs (BAE-…, BAEGIN-…, unprefixed) stay as they are; every reader
// accepts a first segment of 1–8 letters. The client previews use the same
// table (src/constants.js skuPrefixForBrand) — keep the two identical.
export const BRAND_SKU_LETTER = {
  bae: 'B',
  'bae-gin': 'G',
};

export function brandSkuPrefix(brandId) {
  const id = String(brandId || '').toLowerCase();
  if (BRAND_SKU_LETTER[id]) return BRAND_SKU_LETTER[id];
  // A brand without a letter: the initials of its id ("new-brand" → NB).
  return id.split(/[^a-z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase()).join('') || 'X';
}
