// Thin fetch wrapper around the /api/* routes.
// Each call returns parsed JSON on success and throws Error(message) on failure.

// The server uses this to identify the caller. Set after login and on
// session restore; cleared on logout.
let authUserId = null;
export function setAuthUserId(id) { authUserId = id; }

// Routes that should NOT have userId appended (auth endpoints).
// Everything else (items/sales/users) gets userId so the server can verify
// the caller is an active user.
const UNAUTHED = new Set([
  '/auth/has-users',
  '/auth/register',
  '/auth/login',
  '/auth/session',
]);

async function request(path, { method = 'GET', body } = {}) {
  const isAuthed = !UNAUTHED.has(path);

  // Build the request URL; for GET add userId as a query param.
  let url = `/api${path}`;
  let finalBody = body;

  if (isAuthed) {
    if (method === 'GET') {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}userId=${encodeURIComponent(authUserId ?? '')}`;
    } else {
      finalBody = { ...(body || {}), userId: authUserId };
    }
  }

  const res = await fetch(url, {
    method,
    headers: finalBody ? { 'Content-Type': 'application/json' } : undefined,
    body: finalBody ? JSON.stringify(finalBody) : undefined,
  });

  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  // Auth
  hasAnyUsers: () => request('/auth/has-users').then(r => r.hasAnyUsers),
  register: ({ username, password, displayName }) =>
    request('/auth/register', { method: 'POST', body: { username, password, displayName } }).then(r => r.user),
  login: ({ username, password }) =>
    request('/auth/login', { method: 'POST', body: { username, password } }).then(r => r.user),
  session: (userId) =>
    request('/auth/session', { method: 'POST', body: { userId } }).then(r => r.user),
  changePassword: (userId, currentPassword, newPassword) =>
    request('/auth/change-password', { method: 'POST', body: { userId, currentPassword, newPassword } }),

  // Items
  getItems: () => request('/items').then(r => r.items),
  upsertItems: (items) => request('/items', { method: 'POST', body: { items } }),
  // Soft delete: items move to the Recently Deleted tab and stay
  // recoverable for 30 days before being purged on read.
  deleteItems: (ids) => request('/items', { method: 'DELETE', body: { ids } }),
  // Restore from soft delete by clearing deletedAt.
  restoreItems: (ids) =>
    request('/items', { method: 'POST', body: { items: ids.map(id => ({ id, deletedAt: null, deletedBy: null })) } }),
  // Hard delete — bypasses the 30-day grace.
  purgeItems: (ids) => request('/items', { method: 'DELETE', body: { ids, purge: true } }),
  convertItem: ({ tcId, plantData }) =>
    request('/items/convert', { method: 'POST', body: { tcId, plantData } }).then(r => r),

  // Sales
  getSales: () => request('/sales').then(r => r.sales),
  upsertSales: (sales) => request('/sales', { method: 'POST', body: { sales } }),
  deleteSales: (ids) => request('/sales', { method: 'DELETE', body: { ids } }),

  // Varieties (genus catalog)
  getVarieties: () => request('/varieties').then(r => r.varieties),
  createVariety: ({ name, code }) =>
    request('/varieties', { method: 'POST', body: { name, code } }).then(r => r.variety),
  updateVariety: ({ id, patch }) =>
    request('/varieties', { method: 'PATCH', body: { id, ...patch } }),
  deleteVariety: (id) =>
    request('/varieties', { method: 'DELETE', body: { id } }),

  // Species catalog
  getSpecies: () => request('/species').then(r => r.species),
  createSpecies: ({ varietyId, epithet, commonName, notes, imageUrl }) =>
    request('/species', { method: 'POST', body: { varietyId, epithet, commonName, notes, imageUrl } }).then(r => r.species),
  updateSpecies: ({ id, patch }) =>
    request('/species', { method: 'PATCH', body: { id, ...patch } }),
  deleteSpecies: (id) =>
    request('/species', { method: 'DELETE', body: { id } }),

  // Users (admin only, enforced server-side)
  getUsers: () => request('/users').then(r => r.users),
  createUser: ({ username, password, displayName, role, adminUserId }) =>
    request('/users', { method: 'POST', body: { username, password, displayName, role, adminUserId } }).then(r => r.user),
  updateUser: ({ id, patch, newPassword, adminUserId }) =>
    request('/users', { method: 'PATCH', body: { id, patch, newPassword, adminUserId } }),
  deleteUsers: (ids, adminUserId) =>
    request('/users', { method: 'DELETE', body: { ids, adminUserId } }),
};
