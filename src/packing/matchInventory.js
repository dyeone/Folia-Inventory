// Match a Palmstreet order item to an inventory item.
// Strategy (in order):
//   1. Exact SKU match against inventory.sku
//   2. Leading token from item title matches inventory.sku or inventory.lotNumber
//      (Palmstreet titles often start with a lot # like "10 Alocasia ..." or
//      an internal code like "A0021 monstera ...")
//   3. Fuzzy token overlap on inventory.name + inventory.variety
//
// Returns { item, confidence } or null. Confidence: 'sku' | 'lot' | 'fuzzy'.

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'with', 'plant', 'plants', 'pink', 'green',
]);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t));
}

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

  // 1. Exact SKU
  if (palmItem.sku) {
    const k = palmItem.sku.toLowerCase();
    const skuHit = candidates.find(i => String(i.sku || '').toLowerCase() === k);
    if (skuHit) return { item: skuHit, confidence: 'sku' };
  }

  // 2. Leading token vs SKU/lotNumber
  const lead = leadingToken(palmItem.title);
  if (lead) {
    const skuLeadHit = candidates.find(i => String(i.sku || '').toLowerCase() === lead);
    if (skuLeadHit) return { item: skuLeadHit, confidence: 'sku' };
    const lotHit = candidates.find(i => String(i.lotNumber || '').toLowerCase() === lead);
    if (lotHit) return { item: lotHit, confidence: 'lot' };
  }

  // 3. Fuzzy token overlap. Strip the leading code from the title before
  // tokenizing so we score on the descriptive part only.
  const cleanedTitle = String(palmItem.title || '').replace(/^[A-Za-z]?\d+\s+/, '');
  const tokens = tokenize(cleanedTitle);
  if (tokens.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const inv of candidates) {
    const text = `${inv.name || ''} ${inv.variety || ''}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (text.includes(t)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = inv;
    }
  }
  // Require at least 2 token hits, or at least half the tokens for short titles.
  const threshold = Math.max(2, Math.ceil(tokens.length / 2));
  if (best && bestScore >= threshold) {
    return { item: best, confidence: 'fuzzy' };
  }
  return null;
}
