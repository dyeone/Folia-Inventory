// "Biggest boxes first" — the default working order for the Shipping tab
// and the packer's landing grid: the monster boxes get tackled while bench
// space and energy are fresh, and the one-plant boxes close out the day.
//
//   1. more plants in the box first (item rows — each row is one plant)
//   2. then the more valuable box (sum of salePrice, else listingPrice)
//   3. then buyer name, so equal boxes keep a stable, scannable order

export function boxValue(items) {
  return (items || []).reduce(
    (s, i) => s + (parseFloat(i?.salePrice) || parseFloat(i?.listingPrice) || 0),
    0,
  );
}

export function compareBoxesBySize(a, b) {
  const ac = a?.items?.length || 0;
  const bc = b?.items?.length || 0;
  if (ac !== bc) return bc - ac;
  const av = boxValue(a?.items);
  const bv = boxValue(b?.items);
  if (av !== bv) return bv - av;
  const an = a?.buyer || a?.recipientName || '';
  const bn = b?.buyer || b?.recipientName || '';
  return an.localeCompare(bn);
}
