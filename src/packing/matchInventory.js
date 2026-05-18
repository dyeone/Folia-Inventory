import { normalizeSku } from '../labels/boxCode.js';

// Match a Palmstreet order item to an inventory item by SKU only —
// exact, case-insensitive equality (with hyphen-vs-underscore scanner
// tolerance via normalizeSku). No fuzzy / lot-number / suffix
// fallbacks. Manual linking has been removed — operators must fix
// the SKU at source rather than patching it in the UI.
//
// Returns one of:
//   { item, confidence: 'sku' }        — fresh available/listed match;
//                                        will be marked sold on apply
//   { item, alreadyInBox: boxId }      — SKU matches but the inventory
//                                        row is already in another
//                                        box (open or shipped). Apply
//                                        will SKIP this line so we
//                                        don't duplicate boxes or
//                                        disrupt actively-packed work.
//   null                               — no inventory item with that SKU
//                                        (or SKU exists only in some
//                                        non-actionable state)

export function matchInventory(palmItem, inventoryItems) {
  if (!palmItem?.sku || !inventoryItems?.length) return null;

  const k = normalizeSku(palmItem.sku);
  if (!k) return null;

  const hits = inventoryItems.filter(
    i => !i.deletedAt && normalizeSku(i.sku) === k,
  );
  if (hits.length === 0) return null;

  // Prefer a fresh row: an item that's still available/listed and can
  // be stamped sold for this new upload.
  const fresh = hits.find(
    i => i.status === 'available' || i.status === 'listed',
  );
  if (fresh) return { item: fresh, confidence: 'sku' };

  // No fresh row, but the SKU exists in a sold/shipped/delivered state
  // and is sitting in a box. Flag it so the apply step can skip — we
  // refuse to re-open a box that's already been worked on, and we
  // refuse to duplicate it.
  const placed = hits.find(
    i => ['sold', 'shipped', 'delivered'].includes(i.status) && i.shipmentBoxId,
  );
  if (placed) return { item: placed, alreadyInBox: placed.shipmentBoxId };

  return null;
}
