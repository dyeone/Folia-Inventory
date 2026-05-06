// Thin fetch wrapper around the /api/* routes.
// Each call returns parsed JSON on success and throws Error(message) on failure.

// The server uses this to identify the caller. Set after login and on
// session restore; cleared on logout.
let authUserId = null;
export function setAuthUserId(id) { authUserId = id; }

// Routes that should NOT have userId appended (auth endpoints).
// Everything else (items/sales/users) gets userId so the server can verify
// the caller is an active user. The auth path collapsed into a single
// /auth dispatcher (Vercel Hobby's 12-function cap), so we just match
// the prefix.
const UNAUTHED_PREFIXES = ['/auth'];
function isUnauthed(path) {
  return UNAUTHED_PREFIXES.some(p => path === p || path.startsWith(`${p}?`) || path.startsWith(`${p}/`));
}

async function request(path, { method = 'GET', body } = {}) {
  const isAuthed = !isUnauthed(path);

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
  // Auth — single dispatcher under /auth, action passed via query (GET) or body (POST).
  hasAnyUsers: () => request('/auth?action=has-users').then(r => r.hasAnyUsers),
  register: ({ username, password, displayName }) =>
    request('/auth', { method: 'POST', body: { action: 'register', username, password, displayName } }).then(r => r.user),
  login: ({ username, password }) =>
    request('/auth', { method: 'POST', body: { action: 'login', username, password } }).then(r => r.user),
  session: (userId) =>
    request('/auth', { method: 'POST', body: { action: 'session', userId } }).then(r => r.user),
  changePassword: (userId, currentPassword, newPassword) =>
    request('/auth', { method: 'POST', body: { action: 'change-password', userId, currentPassword, newPassword } }),

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
    request('/items', { method: 'POST', body: { action: 'convert', tcId, plantData } }).then(r => r),

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

  // App settings — single-row JSON blob keyed by id.
  // GET returns { id, data, updatedAt, updatedBy } (data may be {} if unset).
  // PUT requires admin and replaces the data blob wholesale.
  getSettings: (id) => request(`/settings?id=${encodeURIComponent(id)}`).then(r => r.settings),
  putSettings: (id, data) =>
    request('/settings', { method: 'PUT', body: { id, data } }).then(r => r.settings),

  // Shipments (ShipStation labels). One row per shipmentBoxId.
  getShipments: (saleId) =>
    request(`/shipments${saleId ? `?saleId=${encodeURIComponent(saleId)}` : ''}`).then(r => r.shipments),
  // Returns a fresh ~5-minute signed URL for the label PDF. The URL is
  // either a Supabase Storage signed URL (preferred) or a legacy data:
  // URL built from the inline labelData blob (older rows).
  getLabelUrl: (shipmentBoxId) =>
    request(`/shipments?action=label-url&id=${encodeURIComponent(shipmentBoxId)}`).then(r => r.url),
  buyLabel: ({ shipmentBoxId, weightOz, dims, serviceCode, packageCode, confirmation }) =>
    request('/shipstation', { method: 'POST', body: { action: 'buy-label', shipmentBoxId, weightOz, dims, serviceCode, packageCode, confirmation } }).then(r => r.shipment),
  voidLabel: (shipmentBoxId) =>
    request('/shipstation', { method: 'POST', body: { action: 'void-label', shipmentBoxId } }).then(r => r.shipment),

  // Users (admin only, enforced server-side)
  getUsers: () => request('/users').then(r => r.users),
  createUser: ({ username, password, displayName, role, adminUserId }) =>
    request('/users', { method: 'POST', body: { username, password, displayName, role, adminUserId } }).then(r => r.user),
  updateUser: ({ id, patch, newPassword, adminUserId }) =>
    request('/users', { method: 'PATCH', body: { id, patch, newPassword, adminUserId } }),
  deleteUsers: (ids, adminUserId) =>
    request('/users', { method: 'DELETE', body: { ids, adminUserId } }),
};
