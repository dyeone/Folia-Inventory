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
    .select('id,role,active,"displayName"')
    .eq('id', userId)
    .maybeSingle();
  if (!data || !data.active) {
    const e = new Error('Authentication required');
    e.status = 401;
    throw e;
  }
  return data;
}

export function newId() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 9);
}
