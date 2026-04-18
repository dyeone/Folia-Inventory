// Thin fetch wrapper around the /api/* routes.
// Each call returns parsed JSON on success and throws Error(message) on failure.

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
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
  deleteItems: (ids) => request('/items', { method: 'DELETE', body: { ids } }),

  // Sales
  getSales: () => request('/sales').then(r => r.sales),
  upsertSales: (sales) => request('/sales', { method: 'POST', body: { sales } }),
  deleteSales: (ids) => request('/sales', { method: 'DELETE', body: { ids } }),

  // Users (admin only, enforced server-side)
  getUsers: () => request('/users').then(r => r.users),
  createUser: ({ username, password, displayName, role, adminUserId }) =>
    request('/users', { method: 'POST', body: { username, password, displayName, role, adminUserId } }).then(r => r.user),
  updateUser: ({ id, patch, newPassword, adminUserId }) =>
    request('/users', { method: 'PATCH', body: { id, patch, newPassword, adminUserId } }),
  deleteUsers: (ids, adminUserId) =>
    request('/users', { method: 'DELETE', body: { ids, adminUserId } }),
};
