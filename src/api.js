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

  // cache: 'no-store' stops the browser from sending If-None-Match /
  // If-Modified-Since headers on repeat polls. Without it, Vercel's
  // CDN was occasionally responding 304 Not Modified to bridge status
  // polls and (more weirdly) enqueue POSTs, which res.ok flags as a
  // failure — surfacing as a red "Failed" pill on scans the bridge
  // actually completed.
  const res = await fetch(url, {
    method,
    headers: finalBody ? { 'Content-Type': 'application/json' } : undefined,
    body: finalBody ? JSON.stringify(finalBody) : undefined,
    cache: 'no-store',
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
  register: ({ username, password, displayName, registrationPassword }) =>
    request('/auth', { method: 'POST', body: { action: 'register', username, password, displayName, registrationPassword } }).then(r => r.user),
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
  createSpecies: ({ varietyId, epithet, commonName, notes, imageUrl, wholesalePrice, idealSellingPrice }) =>
    request('/species', { method: 'POST', body: { varietyId, epithet, commonName, notes, imageUrl, wholesalePrice, idealSellingPrice } }).then(r => r.species),
  updateSpecies: ({ id, patch }) =>
    request('/species', { method: 'PATCH', body: { id, ...patch } }),
  deleteSpecies: (id) =>
    request('/species', { method: 'DELETE', body: { id } }),

  // Purchase orders
  listPurchaseOrders: (statuses = 'draft,ordered') =>
    request(`/purchase-orders?status=${encodeURIComponent(statuses)}`).then(r => r.purchaseOrders),
  getPurchaseOrder: (id) =>
    request(`/purchase-orders?action=get&id=${encodeURIComponent(id)}`).then(r => ({
      purchaseOrder: r.purchaseOrder, lines: r.lines, receivedItems: r.receivedItems,
    })),
  createPurchaseOrder: ({ supplier, shippingFee, notes } = {}) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'create', supplier, shippingFee, notes } }).then(r => r.purchaseOrder),
  updatePurchaseOrderHeader: ({ id, supplier, shippingFee, notes }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'update-header', id, supplier, shippingFee, notes } }).then(r => r.purchaseOrder),
  addPurchaseOrderLine: ({ id, speciesId, quantityOrdered, unitWholesalePrice }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'add-line', id, speciesId, quantityOrdered, unitWholesalePrice } }).then(r => r.line),
  updatePurchaseOrderLine: ({ id, lineId, quantityOrdered, unitWholesalePrice }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'update-line', id, lineId, quantityOrdered, unitWholesalePrice } }),
  removePurchaseOrderLine: ({ id, lineId }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'remove-line', id, lineId } }),
  markPurchaseOrderOrdered: (id) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'mark-ordered', id } }).then(r => r.purchaseOrder),
  receivePurchaseOrderLine: ({ id, lineId, quantityReceived }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'receive-line', id, lineId, quantityReceived } }),
  cancelReceivePurchaseOrderLine: ({ id, lineId }) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'cancel-receive-line', id, lineId } }),
  deletePurchaseOrder: (id) =>
    request('/purchase-orders', { method: 'POST', body: { action: 'delete', id } }),

  // Species photos
  uploadSpeciesPhoto: ({ speciesId, fileBase64, contentType, filename, kind }) =>
    request('/species-photos', { method: 'POST', body: { action: 'upload', speciesId, fileBase64, contentType, filename, kind } }),
  deleteSpeciesPhoto: (id) =>
    request('/species-photos', { method: 'POST', body: { action: 'delete', id } }),
  reorderSpeciesPhotos: ({ speciesId, orderedPhotoIds }) =>
    request('/species-photos', { method: 'POST', body: { action: 'reorder', speciesId, orderedPhotoIds } }),
  speciesPhotoSignedUrl: (id) =>
    request(`/species-photos?action=signed-url&id=${encodeURIComponent(id)}`).then(r => r.url),

  // App settings — single-row JSON blob keyed by id.
  // GET returns { id, data, updatedAt, updatedBy } (data may be {} if unset).
  // PUT requires admin and replaces the data blob wholesale.
  getSettings: (id) => request(`/settings?id=${encodeURIComponent(id)}`).then(r => r.settings),
  putSettings: (id, data) =>
    request('/settings', { method: 'PUT', body: { id, data } }).then(r => r.settings),

  // Shipments (ShipStation labels). One row per shipmentBoxId.
  getShipments: (saleId) =>
    request(`/shipments${saleId ? `?saleId=${encodeURIComponent(saleId)}` : ''}`).then(r => r.shipments),
  // Returns a fresh ~5-minute signed URL for one of the shipment PDFs.
  // kind = 'label' (default) or 'slip'.
  getLabelUrl: (shipmentBoxId, kind = 'label') =>
    request(`/shipments?action=label-url&id=${encodeURIComponent(shipmentBoxId)}&kind=${kind}`).then(r => r.url),
  // USPS-via-Palmstreet: operator enters the tracking number after
  // generating the label in Palmstreet. Inserts a manual shipments row.
  recordPalmstreetTracking: (shipmentBoxId, trackingNumber) =>
    request('/shipments', { method: 'POST', body: { action: 'record-tracking', shipmentBoxId, trackingNumber } }).then(r => r.shipment),
  clearPalmstreetTracking: (shipmentBoxId) =>
    request('/shipments', { method: 'POST', body: { action: 'clear-tracking', shipmentBoxId } }),
  // Per-box notes (lazy `shipment_boxes` rows). Internal operator
  // memos shown only in the ShipBoxCard drill-down.
  getBoxNotes: (saleId) =>
    request(`/shipments?action=box-notes${saleId ? `&saleId=${encodeURIComponent(saleId)}` : ''}`).then(r => r.boxNotes || {}),
  setBoxNote: ({ shipmentBoxId, note }) =>
    request('/shipments', { method: 'POST', body: { action: 'set-box-note', shipmentBoxId, note } }).then(r => r.box),
  buyLabel: ({ shipmentBoxId, weightOz, dims, serviceCode, packageCode, confirmation }) =>
    request('/shipstation', { method: 'POST', body: { action: 'buy-label', shipmentBoxId, weightOz, dims, serviceCode, packageCode, confirmation } }).then(r => r.shipment),
  voidLabel: (shipmentBoxId) =>
    request('/shipstation', { method: 'POST', body: { action: 'void-label', shipmentBoxId } }).then(r => r.shipment),

  // Bridge — durable job queue between web app and the local Folia Bridge
  // that drives Palmstreet via ADB. See api/bridge.js + bridge/index.js.
  bridgeEnqueue: ({ jobAction, payload }) =>
    request('/bridge', { method: 'POST', body: { action: 'enqueue', jobAction, payload } }).then(r => r.job),
  bridgeStatus: (ids) =>
    request(`/bridge?action=status&ids=${encodeURIComponent(ids.join(','))}`).then(r => r.jobs),
  bridgeHealth: () => request('/bridge?action=health'),
  bridgeGenerateToken: () =>
    request('/bridge', { method: 'POST', body: { action: 'generate-token' } }).then(r => r.token),

  // Users (admin only, enforced server-side)
  getUsers: () => request('/users').then(r => r.users),
  createUser: ({ username, password, displayName, role, adminUserId }) =>
    request('/users', { method: 'POST', body: { username, password, displayName, role, adminUserId } }).then(r => r.user),
  updateUser: ({ id, patch, newPassword, adminUserId }) =>
    request('/users', { method: 'PATCH', body: { id, patch, newPassword, adminUserId } }),
  deleteUsers: (ids, adminUserId) =>
    request('/users', { method: 'DELETE', body: { ids, adminUserId } }),
};
