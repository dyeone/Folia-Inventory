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
//                                        row is already in a box (open or
//                                        shipped). Apply keeps it in place
//                                        (never duplicates or moves it) but
//                                        tops up missing data — order date,
//                                        shipping fee, etc. — from the file.
//   null                               — no inventory item with that SKU
//                                        (or SKU exists only in some
//                                        non-actionable state)

export function matchInventory(palmItem, inventoryItems) {
  if (!inventoryItems?.length) return null;

  // ── Pass 1: SKU-based match ──────────────────────────────────────
  // Fresh available/listed row → mark sold. Already-placed row in any
  // box → flag as alreadyInBox so apply backfills its missing data
  // without duplicating or moving it.
  if (palmItem?.sku) {
    const k = normalizeSku(palmItem.sku);
    if (k) {
      const hits = inventoryItems.filter(
        i => !i.deletedAt && normalizeSku(i.sku) === k,
      );
      if (hits.length > 0) {
        const fresh = hits.find(
          i => i.status === 'available' || i.status === 'listed',
        );
        if (fresh) return { item: fresh, confidence: 'sku' };

        const placed = hits.find(
          i => ['sold', 'shipped', 'delivered'].includes(i.status) && i.shipmentBoxId,
        );
        if (placed) return { item: placed, alreadyInBox: placed.shipmentBoxId };
      }
    }
  }

  // ── Pass 2: unmatched-placeholder dedupe ─────────────────────────
  // The Palmstreet line couldn't be linked to a real inventory row by
  // SKU. Before we emit a fresh UNMATCHED-... placeholder, check whether
  // a PREVIOUS upload already created a placeholder for this same order
  // line. We don't have a real SKU to key off, but placeholders preserve
  // the source orderId + title; matching on both is specific enough that
  // a second upload of the same Palmstreet file won't generate a
  // duplicate placeholder in a parallel box.
  const orderId = String(palmItem?.orderNumber || '').trim();
  const title = String(palmItem?.title || '').trim().toLowerCase();
  if (orderId && title) {
    const placeholder = inventoryItems.find(
      i =>
        !i.deletedAt &&
        i.lotKind === 'unmatched' &&
        i.shipmentBoxId &&
        ['sold', 'shipped', 'delivered'].includes(i.status) &&
        String(i.orderId || '').trim() === orderId &&
        String(i.name || '').trim().toLowerCase() === title,
    );
    if (placeholder) return { item: placeholder, alreadyInBox: placeholder.shipmentBoxId };
  }

  return null;
}
