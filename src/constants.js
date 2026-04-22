export const VARIETIES = ['Anthurium', 'Alocasia', 'Monstera', 'Jewel Orchid'];

// Short code prefixes used when generating SKUs. Each SKU is `${code}-${n}`
// where n is the next unused number within that variety's sequence.
export const VARIETY_CODES = {
  'Anthurium': 'ANT',
  'Alocasia': 'ALO',
  'Monstera': 'MON',
  'Jewel Orchid': 'JOR',
};

// Global SKU counter: the number after the variety prefix increments across
// ALL items, regardless of variety. So you might see ANT-1, ALO-2, ANT-3, MON-4…
// Prefix just identifies the variety; number is globally unique.
export function nextSkuForVariety(variety, existingItems) {
  const code = VARIETY_CODES[variety];
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
