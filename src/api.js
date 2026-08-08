// Thin fetch wrapper around the /api/* routes.
// Each call returns parsed JSON on success and throws Error(message) on failure.

// The server uses this to identify the caller. Set after login and on
// session restore; cleared on logout.
let authUserId = null;
export function setAuthUserId(id) { authUserId = id; }

// The active brand (3babes multi-brand). Sent with every authed call so the
// server scopes reads/writes to it. When unset, the server defaults to the
// legacy 'folia' brand, so older flows keep working.
let authBrandId = null;
export function setAuthBrandId(id) { authBrandId = id; }

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
      // A caller-supplied brandId in the path wins over the session brand —
      // used by the follower board to show a non-active brand's store.
      if (authBrandId && !url.includes('brandId=')) url += `&brandId=${encodeURIComponent(authBrandId)}`;
    } else {
      finalBody = { ...(body || {}), userId: authUserId, brandId: authBrandId ?? undefined };
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
  // Pinned-brand variants for the hash-route boards (#show-board=<brand>):
  // an explicit brandId in the path wins over the session brand in request().
  getItemsForBrand: (brandId) =>
    request(`/items${brandId ? `?brandId=${encodeURIComponent(brandId)}` : ''}`).then(r => r.items),
  // Live show state written by the Chrome extension's dashboard scraper.
  getLiveShow: (brandId) =>
    request(`/settings?action=live-show-get${brandId ? `&brandId=${encodeURIComponent(brandId)}` : ''}`),
  upsertItems: (items) => request('/items', { method: 'POST', body: { items } }),
  // Atomic server-side box merge: moves every still-sold item from the source
  // boxes into the target box (identity re-stamped server-side). 409s when
  // any involved box has an active label.
  combineBoxes: ({ targetBoxId, sourceBoxIds }) =>
    request('/items', { method: 'POST', body: { action: 'combine-boxes', targetBoxId, sourceBoxIds } }),
  // Bulk-rename item names by group: renames = [{ ids: [...], name }].
  // Each group is one atomic set-based UPDATE server-side.
  renameItemNames: (renames) =>
    request('/items', { method: 'POST', body: { action: 'rename-names', renames } }),
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

  // Per-sale "Evaluate Sales" report snapshot (read-only; see migration 0027).
  getSaleEval: (saleId) =>
    request(`/sales?action=eval&saleId=${encodeURIComponent(saleId)}`).then(r => r.evaluation),
  getSaleEvalIds: () => request('/sales?action=evalIds').then(r => r.evalSaleIds || []),
  saveSaleEval: (saleId, result) =>
    request('/sales', { method: 'POST', body: { action: 'saveEval', saleId, result } }),

  // Sellers (consignment) — reusable per-brand records. getSellers is
  // best-effort empty for brands / installs without the 0033 table.
  getSellers: () => request('/sales?action=sellers-list').then(r => r.sellers || []),
  upsertSeller: (seller) =>
    request('/sales', { method: 'POST', body: { action: 'seller-upsert', seller } }),
  deleteSeller: (id) =>
    request('/sales', { method: 'DELETE', body: { action: 'seller-delete', id } }),

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
  // Combine one species into another (the survivor's variety wins, so this can
  // also move a species across varieties). Re-points items + photos to intoId,
  // then deletes fromId. Refused if fromId has purchase-order history.
  mergeSpecies: ({ fromId, intoId }) =>
    request('/species', { method: 'POST', body: { action: 'merge', fromId, intoId } }),
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

  // Item photos — per-individual-item gallery (Pre Sale tab). Shares the
  // /species-photos route (target:'item') so we don't add a serverless
  // function; rows live in item_photos. See migration 0019.
  listItemPhotos: (itemId) =>
    request(`/species-photos?action=list&target=item&itemId=${encodeURIComponent(itemId)}`).then(r => r.photos),
  uploadItemPhoto: ({ itemId, fileBase64, contentType, filename }) =>
    request('/species-photos', { method: 'POST', body: { action: 'upload', target: 'item', itemId, fileBase64, contentType, filename } }),
  deleteItemPhoto: (id) =>
    request('/species-photos', { method: 'POST', body: { action: 'delete', target: 'item', id } }),

  // App settings — single-row JSON blob keyed by id.
  // GET returns { id, data, updatedAt, updatedBy } (data may be {} if unset).
  // PUT requires admin and replaces the data blob wholesale.
  getSettings: (id) => request(`/settings?id=${encodeURIComponent(id)}`).then(r => r.settings),
  putSettings: (id, data) =>
    request('/settings', { method: 'PUT', body: { id, data } }).then(r => r.settings),

  // Lineup running index (brand-scoped) — the next lineup number to hand out,
  // so sales within a week number continuously. Pass the lot week + its block
  // range (src/sales/lotBlock.js): a week's first read starts at its block
  // start (or above another week's spill into it); omitted, legacy behavior
  // (the raw stored counter). Non-admin: numbering is routine. bump advances
  // that week's counter (advance-only, per week); returns the stored next.
  getLineupNext: (week, blockStart, blockEnd) =>
    request(`/settings?action=lineup-get${week != null && blockStart != null ? `&week=${week}&blockStart=${blockStart}${blockEnd != null ? `&blockEnd=${blockEnd}` : ''}` : ''}`).then(r => r.next ?? 1),
  bumpLineupNext: (next, week) =>
    request('/settings', { method: 'POST', body: { action: 'lineup-bump', next, ...(week != null ? { week } : {}) } }).then(r => r.next),

  // Palmstreet follower monitor — the brand's store link (admin sets it once)
  // and the live follower count, scraped server-side from the public store
  // profile page (the browser can't fetch palmstreet.app — no CORS).
  getPalmstreetConfig: () => request('/settings?action=palmstreet-get').then(r => r.config),
  savePalmstreetConfig: (url) =>
    request('/settings', { method: 'POST', body: { action: 'palmstreet-save', url } }).then(r => r.config),
  // → { configured, followers?, at? }. Optional brandId overrides the session
  // brand (server re-checks the caller's access to it).
  getPalmstreetFollowers: (brandId) =>
    request(`/settings?action=palmstreet-followers${brandId ? `&brandId=${encodeURIComponent(brandId)}` : ''}`),

  // Personal GTD tasks — private per user. Stored as a JSON blob in
  // app_settings keyed `tasks:<userId>` and served by /settings (Hobby's
  // 12-function cap rules out a dedicated /tasks route). The server sanitizes
  // every field and owns completedAt; upsert is keyed by task.id (generate one
  // client-side for new tasks).
  getTasks: () => request('/settings?action=task-list').then(r => r.tasks || []),
  upsertTask: (task) =>
    request('/settings', { method: 'POST', body: { action: 'task-upsert', task } }).then(r => r.task),
  deleteTask: (id) =>
    request('/settings', { method: 'POST', body: { action: 'task-delete', id } }),
  // Admin-only: assign/edit a task in another user's list. Returns
  // { task, assigneeId, assigneeName }.
  assignTask: (targetUserId, task) =>
    request('/settings', { method: 'POST', body: { action: 'task-assign', targetUserId, task } }),
  // Admin-only: all tasks this admin assigned to others (annotated with
  // assigneeId + assigneeName) with live completion status.
  getAssignedByMe: () =>
    request('/settings?action=task-assigned-by-me').then(r => r.assigned || []),
  // Admin-only: unassign (delete) a task from another user's list.
  deleteTaskFor: (targetUserId, id) =>
    request('/settings', { method: 'POST', body: { action: 'task-delete', targetUserId, id } }),

  // Plant Care calendars — shared schedules. Anyone may list + check off a
  // task; create/edit/delete are admin-only (enforced server-side).
  getCareCalendars: () => request('/settings?action=care-list').then(r => r.calendars || []),
  saveCareCalendar: (calendar) =>
    request('/settings', { method: 'POST', body: { action: 'care-save', calendar } }).then(r => r.calendar),
  deleteCareCalendar: (id) =>
    request('/settings', { method: 'POST', body: { action: 'care-delete', id } }),
  toggleCareTask: (calendarId, taskId, done) =>
    request('/settings', { method: 'POST', body: { action: 'care-toggle-task', calendarId, taskId, done } }).then(r => r.calendar),

  // BAE landing-page CMS — one brand-scoped JSON blob the public landing site
  // reads. getLanding returns the published content (or null → editor uses its
  // built-in defaults); saveLanding publishes (admin-only, enforced server-side).
  getLanding: () => request('/settings?action=landing-get').then(r => r.content),
  saveLanding: (content) =>
    request('/settings', { method: 'POST', body: { action: 'landing-save', content } }).then(r => r.content),

  // BAE loyalty program (migration 0034). Config + redemptions live in real
  // tables — the customer app reads them directly via Supabase RLS — but staff
  // admin rides the existing /settings function (12-function cap). getLoyalty
  // returns { config, stats, unavailable? }; unavailable means the 0034 tables
  // aren't migrated yet.
  getLoyalty: () => request('/settings?action=loyalty-get'),
  saveLoyaltyConfig: (config) =>
    request('/settings', { method: 'POST', body: { action: 'loyalty-save', config } }).then(r => r.config),
  listLoyaltyRedemptions: () =>
    request('/settings?action=loyalty-redemptions').then(r => r.redemptions || []),
  fulfillLoyaltyRedemption: (id, fulfilled = true) =>
    request('/settings', { method: 'POST', body: { action: 'loyalty-fulfill', id, fulfilled } }).then(r => r.redemption),
  // BAE customer hub (migration 0035) — news/tips authored here and read by
  // the BAE Badges app, plus the customer roster with per-customer aggregate
  // counts. The list helpers return the whole response object ({ content } /
  // { customers } plus unavailable?) so the UI can show a "run migration"
  // banner before the tables exist.
  listLoyaltyContent: () => request('/settings?action=loyalty-content-list'),
  saveLoyaltyContent: (entry) =>
    request('/settings', { method: 'POST', body: { action: 'loyalty-content-save', entry } }).then(r => r.entry),
  deleteLoyaltyContent: (id) =>
    request('/settings', { method: 'POST', body: { action: 'loyalty-content-delete', id } }),
  listLoyaltyCustomers: () => request('/settings?action=loyalty-customers'),

  // Shipments (ShipStation labels). One row per shipmentBoxId.
  getShipments: (saleId) =>
    request(`/shipments${saleId ? `?saleId=${encodeURIComponent(saleId)}` : ''}`).then(r => r.shipments),
  // Returns a fresh ~5-minute signed URL for one of the shipment PDFs.
  // kind = 'label' (default) or 'slip'.
  getLabelUrl: (shipmentBoxId, kind = 'label') =>
    request(`/shipments?action=label-url&id=${encodeURIComponent(shipmentBoxId)}&kind=${kind}`).then(r => r.url),
  // USPS-via-Palmstreet: record the tracking number for a box. Either typed
  // in by the operator, or extracted from an uploaded label by the Import
  // Labels flow — which also passes the label PDF (labelPdfBase64) and parcel
  // weight so the server stashes the PDF in Storage alongside the tracking
  // number. Inserts/updates the manual shipments row.
  recordPalmstreetTracking: (shipmentBoxId, trackingNumber, opts = {}) =>
    request('/shipments', {
      method: 'POST',
      body: {
        action: 'record-tracking',
        shipmentBoxId,
        trackingNumber,
        ...(opts.labelPdfBase64 ? { labelPdfBase64: opts.labelPdfBase64 } : {}),
        ...(opts.slipPdfBase64 ? { slipPdfBase64: opts.slipPdfBase64 } : {}),
        ...(opts.weightOz != null ? { weightOz: opts.weightOz } : {}),
      },
    }).then(r => r.shipment),
  clearPalmstreetTracking: (shipmentBoxId) =>
    request('/shipments', { method: 'POST', body: { action: 'clear-tracking', shipmentBoxId } }),
  // Per-box notes (lazy `shipment_boxes` rows). Internal operator
  // memos shown only in the ShipBoxCard drill-down.
  getBoxNotes: (saleId) =>
    request(`/shipments?action=box-notes${saleId ? `&saleId=${encodeURIComponent(saleId)}` : ''}`).then(r => r.boxNotes || {}),
  // Packer-poll variant: the box-notes map PLUS the desk's sweep-reset stamp
  // (rides the same response, so the 8s poll costs nothing extra).
  getBoxNotesWithMeta: () =>
    request('/shipments?action=box-notes').then(r => ({
      boxNotes: r.boxNotes || {},
      sweepResetAt: r.sweepResetAt ?? null,
      heat: r.heat ?? null, // { checkedAt, byBox: {boxId: maxTempF} }
    })),
  // Desk-side: stash the heat-check verdict so packer devices badge hot
  // boxes ("extra insulation"). Replaces the previous stash wholesale.
  setHeatFlags: (byBox) =>
    request('/shipments', { method: 'POST', body: { action: 'set-heat-flags', byBox } }).then(r => r),
  // Desk-side: stamp a sweep reset — every packer device drops found-marks
  // older than the stamp on its next poll and starts the checklist over.
  resetHoldSweep: () =>
    request('/shipments', { method: 'POST', body: { action: 'reset-hold-sweep' } }).then(r => r.resetAt),
  setBoxNote: ({ shipmentBoxId, note }) =>
    request('/shipments', { method: 'POST', body: { action: 'set-box-note', shipmentBoxId, note } }).then(r => r.box),
  // Per-box packaging selection (box size + weight + service). Only the
  // keys passed are touched server-side; returns the full updated box row.
  setBoxPackaging: ({ shipmentBoxId, boxSizeId, weightOz, serviceKey, carrierOverride }) =>
    request('/shipments', { method: 'POST', body: { action: 'set-box-packaging', shipmentBoxId, boxSizeId, weightOz, serviceKey, carrierOverride } }).then(r => r.box),
  // Put a box on a one-week hold (hold:true — pass the client-computed
  // week-scoped holdUntil; see holdInfo.weekHoldUntil) or clear it
  // (hold:false). release:true with hold:false stamps the HOLD_RELEASED
  // sentinel instead of null — the only thing that outranks an ITEM-based
  // hold (the "1-week hold" line the buyer bought; see holdInfo.js — a real
  // past stamp deliberately does NOT release), while null would let the item
  // resurface. Server bounds real holdUntil stamps to now..+31d, else falls
  // back to now + days (default 7) for stale callers.
  setBoxHold: ({ shipmentBoxId, hold, days, holdUntil, release }) =>
    request('/shipments', { method: 'POST', body: { action: 'set-box-hold', shipmentBoxId, hold, days, holdUntil, release } }).then(r => r.box),
  // Manual "pack with extra insulation" mark (migration 0037) — desk sets it,
  // the packer UI shows it.
  setBoxInsulation: ({ shipmentBoxId, extraInsulation }) =>
    request('/shipments', { method: 'POST', body: { action: 'set-box-insulation', shipmentBoxId, extraInsulation } }).then(r => r.box),
  // Get-or-create the BAE loyalty redemption code for a box (printed on the
  // shipping slip as QR + short code — see migration 0034). Returns
  // { code, qrPayload, badgeCount, status }. BAE boxes only.
  getBoxLoyaltyCode: (shipmentBoxId) =>
    request('/shipments', { method: 'POST', body: { action: 'loyalty-code', shipmentBoxId } }).then(r => r.loyalty),
  // Packer cross-device handoff: the iPad sends an open box's items to the
  // packer's phone (same login), which polls getPhoneHandoff and shows them
  // as a find-list. Returns { ok, sentAt } so the sender can mark its own
  // send as seen and avoid popping its own handoff back at itself.
  sendBoxToPhone: (box) =>
    request('/shipments', { method: 'POST', body: { action: 'send-to-phone', box } }),
  getPhoneHandoff: () =>
    request('/shipments?action=phone-handoff').then(r => r.handoff),
  // provider: 'shipstation' (default) | 'shippo'. serviceKey (one of the
  // three offered services) drives the carrier + per-provider codes; when
  // omitted the legacy item-carrier + saved defaults are used (ShipStation).
  buyLabel: ({ shipmentBoxId, weightOz, dims, serviceCode, packageCode, confirmation, provider, serviceKey, shipDate }) =>
    request('/shipstation', { method: 'POST', body: { action: 'buy-label', shipmentBoxId, weightOz, dims, serviceCode, packageCode, confirmation, provider, serviceKey, shipDate } }).then(r => r.shipment),
  voidLabel: (shipmentBoxId) =>
    request('/shipstation', { method: 'POST', body: { action: 'void-label', shipmentBoxId } }).then(r => r.shipment),
  // Live Shippo-vs-ShipStation rate comparison for one box. Returns
  // { rates:[{key,label,provider,shipstation,shippo,cheapest}],
  //   shippoConfigured, shippoError, shipstationError }.
  getRates: ({ shipmentBoxId, dims, weightOz, services }) =>
    request('/shipstation', { method: 'POST', body: { action: 'get-rates', shipmentBoxId, dims, weightOz, services } }),

  // Bridge — durable job queue between web app and the local Folia Bridge
  // that drives Palmstreet via ADB. See api/bridge.js + bridge/index.js.
  bridgeEnqueue: ({ jobAction, payload }) =>
    request('/bridge', { method: 'POST', body: { action: 'enqueue', jobAction, payload } }).then(r => r.job),
  bridgeStatus: (ids) =>
    request(`/bridge?action=status&ids=${encodeURIComponent(ids.join(','))}`).then(r => r.jobs),
  bridgeHealth: () => request('/bridge?action=health'),
  // Direct print: hand a label PDF to the local printer via the bridge. payload
  // = { pdfBase64, role: 'label'|'slip'|'document', copies?, media? }.
  bridgePrint: (payload) =>
    request('/bridge', { method: 'POST', body: { action: 'enqueue', jobAction: 'print', payload } }).then(r => r.job),
  bridgeGenerateToken: () =>
    request('/bridge', { method: 'POST', body: { action: 'generate-token' } }).then(r => r.token),

  // Users (admin only, enforced server-side)
  getUsers: () => request('/users').then(r => r.users),
  createUser: ({ username, password, displayName, role, brandIds, adminUserId }) =>
    request('/users', { method: 'POST', body: { username, password, displayName, role, brandIds, adminUserId } }).then(r => r.user),
  updateUser: ({ id, patch, newPassword, adminUserId }) =>
    request('/users', { method: 'PATCH', body: { id, patch, newPassword, adminUserId } }),
  deleteUsers: (ids, adminUserId) =>
    request('/users', { method: 'DELETE', body: { ids, adminUserId } }),
};
