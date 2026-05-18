// Match a Palmstreet order item to an inventory item by SKU only —
// exact, case-insensitive equality. No fuzzy / lot-number / suffix
// fallbacks. If the order's SKU doesn't exactly equal an inventory
// SKU (case-insensitively), it stays unmatched and shows up in the
// Validate Sales preview as "No inventory match" so the operator can
// investigate. Manual linking has been removed — operators must fix
// the SKU at source (in inventory or in the order file) rather than
// patching it in the UI.
//
// Returns { item, confidence: 'sku' } or null.

export function matchInventory(palmItem, inventoryItems) {
  if (!palmItem?.sku || !inventoryItems?.length) return null;

  const k = String(palmItem.sku).toLowerCase();
  const hit = inventoryItems.find(
    i =>
      (i.status === 'available' || i.status === 'listed') &&
      String(i.sku || '').toLowerCase() === k,
  );
  return hit ? { item: hit, confidence: 'sku' } : null;
}
