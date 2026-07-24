// Pack-time lot-number collision detection. Rolling weekly blocks make a
// duplicate lineup number on the bench structurally rare, but it still
// happens: legacy 1-160 hold labels during the cutover fortnight, ≥5-week
// stragglers whose block rotated back around, operator-confirmed block
// spills, and manual free-text dupes. Deliberately WEEK-AGNOSTIC — pure
// item-pair detection, no sales fetch, no week derivation — so it catches
// every one of those cases the same way.
// Shared by the Shipping desk (PackingView) and the packer UI (PackerView).

// Lot values (parseInt) that appear on TWO OR MORE distinct unpacked sold
// items across the given boxes — including two inside one box, which catches
// same-week manual dupes. `boxes` is any array of { items: [...] } (both
// PackerView's boxesByCode values and PackingView's buyer-group boxes fit).
// Items with an absent/unparseable lotNumber are ignored.
export function findDupeLots(boxes) {
  const seen = new Set();
  const dupes = new Set();
  for (const box of boxes || []) {
    for (const item of box.items || []) {
      if (item.status !== 'sold' || item.packedAt) continue;
      const lot = parseInt(item.lotNumber, 10);
      if (!Number.isFinite(lot)) continue;
      if (seen.has(lot)) dupes.add(lot);
      else seen.add(lot);
    }
  }
  return dupes;
}
