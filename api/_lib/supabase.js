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

// Remove sensitive fields before sending a user object to the client.
export const stripUser = (u) => {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
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
  const { data } = await supabase
    .from('users')
    .select('id,role,active,"displayName","brandIds"')
    .eq('id', userId)
    .maybeSingle();
  if (!data || !data.active) {
    const e = new Error('Authentication required');
    e.status = 401;
    throw e;
  }
  return data;
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
