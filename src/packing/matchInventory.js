// Match a Palmstreet order item to an inventory item, by SKU only.
// Strategy (in order):
//   1.  Exact SKU match (case-insensitive).
//   1b. Bare-number SKU: resolve by suffix (-{number}) against the
//       globally-unique inventory numbering.
//   2.  Leading lot/SKU token in the title — catches sale events that
//       use lot numbers ("10 Alocasia …" → lotNumber 10).
// Fuzzy name matching used to live here but produced too many wrong
// links; it's been removed by request. Unmatched rows surface "No
// inventory match" and the operator links them manually.
//
// Returns { item, confidence } or null. Confidence: 'sku' | 'lot'.

function leadingToken(title) {
  const m = String(title || '').trim().match(/^([A-Za-z]?\d+)\b/);
  return m ? m[1].toLowerCase() : '';
}

export function matchInventory(palmItem, inventoryItems) {
  if (!palmItem || !inventoryItems?.length) return null;

  const candidates = inventoryItems.filter(
    i => i.status === 'available' || i.status === 'listed'
  );
  if (candidates.length === 0) return null;

  // 1. Exact SKU (case-insensitive).
  if (palmItem.sku) {
    const k = palmItem.sku.toLowerCase();
    const skuHit = candidates.find(i => String(i.sku || '').toLowerCase() === k);
    if (skuHit) return { item: skuHit, confidence: 'sku' };
  }

  // 1b. Bare-number SKU: bundled titles sometimes drop the prefix and
  // write just "(1589)" in the parens. Numbering is global across all
  // varieties so the suffix uniquely identifies the inventory item —
  // resolve to the candidate whose SKU ends with "-{number}". Refuse
  // if multiple candidates match (extremely unusual but possible if
  // one variety code shares numbers with another).
  if (palmItem.sku && /^\d+$/.test(palmItem.sku)) {
    const tail = `-${palmItem.sku}`;
    const tailHits = candidates.filter(i => String(i.sku || '').endsWith(tail));
    if (tailHits.length === 1) return { item: tailHits[0], confidence: 'sku' };
  }

  // 2. Leading token vs SKU/lotNumber. Catches sale events with lot
  // numbers (e.g. title "10 Alocasia bla bla" → inventory.lotNumber=10).
  const lead = leadingToken(palmItem.title);
  if (lead) {
    const skuLeadHit = candidates.find(i => String(i.sku || '').toLowerCase() === lead);
    if (skuLeadHit) return { item: skuLeadHit, confidence: 'sku' };
    const lotHit = candidates.find(i => String(i.lotNumber || '').toLowerCase() === lead);
    if (lotHit) return { item: lotHit, confidence: 'lot' };
  }

  // No SKU resolved — no fuzzy fallback. Operator picks manually.
  return null;
}
