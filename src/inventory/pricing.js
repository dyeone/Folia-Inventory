// Variety/species lookup + ideal-price math, factored out of InventoryView
// so they can be unit-tested or reused by other views.

// Pre-build O(1) Maps from the (varieties, species) arrays so per-item
// price calculations don't re-scan on every render.
export function buildLookups(varieties, species) {
  const speciesById = new Map(species.map(s => [s.id, s]));
  const varietyByName = new Map(varieties.map(v => [v.name, v]));
  const speciesByVarEpithet = new Map(
    species.map(s => [`${s.varietyId}|${s.epithet}`, s])
  );
  return { speciesById, varietyByName, speciesByVarEpithet };
}

// Find the species/cultivar row that a given item belongs to. Prefer the
// explicit FK; fall back to (variety name, cultivar name) lookup so older
// items without speciesId still resolve.
export function speciesForItem(item, lookups) {
  if (item.speciesId) {
    const s = lookups.speciesById.get(item.speciesId);
    if (s) return s;
  }
  const v = lookups.varietyByName.get(item.variety);
  if (!v) return null;
  return lookups.speciesByVarEpithet.get(`${v.id}|${item.name}`) || null;
}

// Compute the recommended (ideal) selling price for an item, in priority
// order: explicit idealPrice → per-item rate → cultivar (species) rate →
// global rate. Cost prefers netCost (post-shipping) but falls back to
// grossCost so freshly-imported items still get a meaningful number.
export function computeIdealPrice(item, globalRate, lookups) {
  const explicit = parseFloat(item.idealPrice);
  if (Number.isFinite(explicit)) return explicit;
  const cost = parseFloat(item.netCost) || parseFloat(item.grossCost ?? item.cost);
  if (!Number.isFinite(cost) || cost <= 0) return NaN;
  const itemRate = parseFloat(item.profitRate);
  if (Number.isFinite(itemRate)) return cost * (1 + itemRate / 100);
  const sp = speciesForItem(item, lookups);
  const spRate = parseFloat(sp?.profitRate);
  if (Number.isFinite(spRate)) return cost * (1 + spRate / 100);
  const gRate = parseFloat(globalRate);
  if (!Number.isFinite(gRate)) return NaN;
  return cost * (1 + gRate / 100);
}

// Which tier supplied the rate, for the small caption under the Ideal $
// number ("cultivar rate", "global", or none when the item is explicit).
export function rateSourceLabel(item, lookups) {
  if (Number.isFinite(parseFloat(item.idealPrice))) return null;
  if (Number.isFinite(parseFloat(item.profitRate))) return null;
  const sp = speciesForItem(item, lookups);
  if (Number.isFinite(parseFloat(sp?.profitRate))) return 'cultivar rate';
  return 'global';
}
