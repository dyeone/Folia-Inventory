// 3babes brand metadata (frontend display). The source of truth for which
// brands EXIST is the `brands` table; this just maps known ids to display name
// + accent so the shell can theme the switcher without an extra API round-trip.
// Add a new brand here when you add its row in the brands table.

export const COMPANY_NAME = '3babes';

export const BRANDS = {
  folia: { name: 'Folia', accent: '#16a34a' },      // green
  bae: { name: 'BAE', accent: '#F0382E', full: 'Best Anthuriums Ever' }, // red
};

export const DEFAULT_BRAND = 'folia';

export function brandName(id) {
  return BRANDS[id]?.name || id;
}

export function brandAccent(id) {
  return BRANDS[id]?.accent || '#16a34a';
}

// Resolve the list of brands a user can access into [{ id, name, accent }],
// preserving the order in their brandIds. Falls back to the default brand.
export function userBrands(brandIds) {
  const ids = Array.isArray(brandIds) && brandIds.length ? brandIds : [DEFAULT_BRAND];
  return ids.map((id) => ({ id, name: brandName(id), accent: brandAccent(id) }));
}

// Pick the active brand: the stored one if the user still has access, else the
// first brand they can access.
export function resolveActiveBrand(brandIds, stored) {
  const ids = Array.isArray(brandIds) && brandIds.length ? brandIds : [DEFAULT_BRAND];
  return stored && ids.includes(stored) ? stored : ids[0];
}
