import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

// Admin client — bypasses RLS. Never send this to the browser.
export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Roles (2026-10-04): 'admin' (the full app), 'packer' (the packing bench:
// shipping + TC acclimation, no prices), 'streamer' (the mobile screen:
// availability, the schedule, the available inventory with list prices and
// sell notes — never costs) and 'consultant' (the mobile pricing screen).
// 'teammember' (2026-10-02) and 'staff' are gone; rows still carrying them
// (until migration 0049 runs) are read as 'packer' here, so no login lands
// on the wrong screen in between.
export const ROLES = ['admin', 'packer', 'streamer', 'consultant'];
export function normalizeRole(role) {
  if (role === 'teammember' || role === 'staff') return 'packer';
  return role;
}

// A person can hold SEVERAL roles (2026-10-04: "people can be both streamer
// and packer"). `users.roles` (text[], migration 0050) is the set; `role`
// stays the primary one (admin if held, else the first) for the check
// constraint, the last-admin guard and older readers. Until 0050 runs the
// column is missing and the set is just [role].
export function rolesOf(u) {
  const list = Array.isArray(u?.roles) && u.roles.length ? u.roles : [u?.role];
  const set = new Set(list.map(normalizeRole));
  const out = ROLES.filter((r) => set.has(r));   // deduped, in ROLES order (same as the client)
  return out.length ? out : ['packer'];
}
export const primaryRole = (roles) => (roles.includes('admin') ? 'admin' : roles[0]);
export const hasRole = (u, role) => rolesOf(u).includes(role);

// Remove sensitive fields before sending a user object to the client, and
// read the role under its current name.
export const stripUser = (u) => {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  const roles = rolesOf(safe);
  return { ...safe, role: primaryRole(roles), roles };
};

// Verify a request came from a currently-active admin user.
// Returns the admin row on success, or throws an Error with .status.
//
// Missing-id behavior matches requireUser: 401 "Not authenticated"
// rather than 400 "adminUserId required". The admin gate is a layered
// check on top of authentication — if no id is present, the right
// response is "you're not signed in," not "you sent a malformed body."
// Keeping the parameter name out of the error message also avoids
// leaking that the client should have sent `adminUserId` (it doesn't —
// it sends `userId`, which the handler forwards).
export async function requireAdmin(adminUserId) {
  if (!adminUserId) {
    const e = new Error('Not authenticated');
    e.status = 401;
    throw e;
  }
  const { data } = await supabase
    .from('users')
    .select('id,role,active')
    .eq('id', adminUserId)
    .maybeSingle();
  if (!data || data.role !== 'admin' || !data.active) {
    const e = new Error('Admin access required');
    e.status = 403;
    throw e;
  }
  return data;
}

// Verify a request came from a currently-active user (any role).
// Returns the user row (with displayName) on success, or throws.
export async function requireUser(userId) {
  if (!userId) {
    const e = new Error('Not authenticated');
    e.status = 401;
    throw e;
  }
  // '*' rather than a column list: `roles` only exists once migration 0050
  // has run, and naming a missing column fails the whole read.
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (!data || !data.active) {
    const e = new Error('Authentication required');
    e.status = 401;
    throw e;
  }
  const roles = rolesOf(data);
  return { id: data.id, role: primaryRole(roles), roles, active: data.active, displayName: data.displayName, brandIds: data.brandIds };
}

// The default brand. Any request that doesn't carry a brand resolves to it.
// Was 'folia' until migration 0041 retired that brand (its data stays
// archived in the database under brandId 'folia').
export const DEFAULT_BRAND = 'bae-gin';

// Pull the active brand id from a request, the same way handlers pull userId:
// query param on GET, body field on POST/DELETE.
export function brandIdFromReq(req) {
  return req.method === 'GET' ? req.query?.brandId : req.body?.brandId;
}

// Authorize the active brand for a request. Resolves the brand (defaulting to
// DEFAULT_BRAND when absent), confirms it exists, and verifies the user has
// access to it. Returns { user, brand, brandId } where brandId is the resolved
// id to filter queries by and stamp on inserts.
//
// Scoping is enforced here in code because the service-role client bypasses RLS
// — same trust model as requireUser/requireAdmin.
export async function requireBrand(userId, brandId) {
  const user = await requireUser(userId);
  const id = brandId || DEFAULT_BRAND;

  const access = Array.isArray(user.brandIds) && user.brandIds.length
    ? user.brandIds
    : [DEFAULT_BRAND];
  if (!access.includes(id)) {
    const e = new Error('Brand access required');
    e.status = 403;
    throw e;
  }

  const { data: brand } = await supabase
    .from('brands')
    .select('id,slug,name')
    .eq('id', id)
    .maybeSingle();
  if (!brand) {
    const e = new Error('Unknown brand');
    e.status = 404;
    throw e;
  }

  return { user, brand, brandId: id };
}

export function newId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 9);
}
