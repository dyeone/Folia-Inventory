// 3babes brand metadata (frontend display). The source of truth for which
// brands EXIST is the `brands` table; this just maps known ids to display name
// + accent so the shell can theme the switcher without an extra API round-trip.
// Add a new brand here when you add its row in the brands table.
//
// 'folia' (the original brand) was retired in migration 0041 — its rows are
// archived in the database (brands row + brandId data kept) but it's gone from
// this map and from every user's brandIds, so it no longer appears in the app.

export const COMPANY_NAME = '3babes';

export const BRANDS = {
  'bae-gin': { name: 'bae-gin', accent: '#DDFF00', logo: '/logo-baegin.png' }, // neon chartreuse (logo)
  bae: { name: 'BAE', accent: '#F0392E', logo: '/logo-bae.png', full: 'Best Anthuriums Ever' }, // red (logo)
};

export const DEFAULT_BRAND = 'bae-gin';

export function brandName(id) {
  return BRANDS[id]?.name || id;
}

export function brandAccent(id) {
  return BRANDS[id]?.accent || '#DDFF00';
}

// Header logo (served from public/), per brand. Falls back to the bae-gin logo.
export function brandLogo(id) {
  return BRANDS[id]?.logo || '/logo-baegin.png';
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
