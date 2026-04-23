// Variety + species are now persisted in the `varieties` and `species`
// tables and loaded at runtime via the catalog API. The constants below
// are kept only as a fallback for legacy callers (e.g. the inventory
// variety filter pills); admins can now add or rename varieties via the
// catalog UI.
export const VARIETIES = ['Anthurium', 'Alocasia', 'Monstera', 'Jewel Orchid'];

// Compute the next SKU suffix given a code prefix and the existing items.
// Numbering is GLOBAL across all items; the prefix is purely for display.
export function nextSkuForCode(code, existingItems) {
  if (!code) return '';
  const nums = (existingItems || [])
    .map(i => {
      const m = String(i.sku || '').match(/-(\d+)$/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter(n => n > 0);
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `${code}-${next}`;
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
