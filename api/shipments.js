import { supabase, requireBrand, brandIdFromReq } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Routes:
//   GET  /api/shipments?saleId=X
//     → all shipments for a sale (PackingView reads on mount)
//   GET  /api/shipments?action=label-url&id=BOX&kind=label|slip
//     → 5-min signed URL for the label PDF (kind=label, default) or the
//       packing slip PDF (kind=slip).
//   GET  /api/shipments?action=pending&carrier=usps&saleId=X
//     → boxes that don't have a non-voided shipments row yet, joined with
//       buyer + items + sale name. Used by the Chrome extension to build
//       its work queue.
//   GET  /api/shipments?action=with-tracking&saleId=X
//     → the inverse: boxes that DO have a recorded (non-voided) tracking
//       number, joined with recipient + items. Used by the Chrome extension
//       to push tracking numbers back into Palmstreet (search by name).
//   POST /api/shipments  body: { action: 'record-tracking', ...,
//                                 labelPdfBase64?, slipPdfBase64? }
//     → upserts a manual USPS row. If PDFs are included, uploads each
//       to the shipping-labels Storage bucket.
//   POST /api/shipments  body: { action: 'clear-tracking', shipmentBoxId }
//     → deletes a manual Palmstreet row (refuses to touch ShipStation rows).

const SIGNED_URL_TTL_SECONDS = 300;
const PALMSTREET_CARRIER_CODE = 'palmstreet';
const PALMSTREET_SERVICE_CODE = 'palmstreet_usps';
const STORAGE_BUCKET = 'shipping-labels';

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const { brandId } = await requireBrand(userId, brandIdFromReq(req));

  switch (req.method) {
    case 'GET': {
      const action = req.query?.action;
      if (action === 'label-url') return labelUrl(req, res, brandId);
      if (action === 'pending') return pending(req, res, brandId);
      if (action === 'with-tracking') return withTracking(req, res, brandId);
      if (action === 'box-notes') return boxNotes(req, res, brandId);
      if (action === 'phone-handoff') return phoneHandoff(req, res, userId);
      return list(req, res, brandId);
    }
    case 'POST': {
      const action = req.body?.action;
      if (action === 'record-tracking') return recordTracking(req, res, userId, brandId);
      if (action === 'clear-tracking') return clearTracking(req, res, brandId);
      if (action === 'set-box-note') return setBoxNote(req, res, userId, brandId);
      if (action === 'set-box-packaging') return setBoxPackaging(req, res, userId, brandId);
      if (action === 'set-box-hold') return setBoxHold(req, res, userId, brandId);
      if (action === 'send-to-phone') return sendToPhone(req, res, userId);
      const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
    }
    default:
      return methodNotAllowed(res, ['GET', 'POST']);
  }
});

async function list(req, res, brandId) {
  const saleId = req.query?.saleId;
  let query = supabase
    .from('shipments')
    .select('id, "saleId", carrier, "carrierCode", "serviceCode", "trackingNumber", "labelCost", "labelStoragePath", "shippingSlipStoragePath", "isTestLabel", "purchasedAt", "voidedAt"')
    .eq('brandId', brandId);
  if (saleId) query = query.eq('saleId', saleId);
  const { data, error } = await query;
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ shipments: data || [] });
}

async function labelUrl(req, res, brandId) {
  const id = req.query?.id;
  const kind = req.query?.kind === 'slip' ? 'slip' : 'label';
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }

  const { data: row, error } = await supabase
    .from('shipments')
    .select('id, "labelStoragePath", "shippingSlipStoragePath", "labelData"')
    .eq('id', id)
    .eq('brandId', brandId)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!row) { const e = new Error('Shipment not found'); e.status = 404; throw e; }

  const path = kind === 'slip' ? row.shippingSlipStoragePath : row.labelStoragePath;

  if (path) {
    const { data: signed, error: sErr } = await supabase
      .storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (sErr) { const e = new Error(sErr.message); e.status = 500; throw e; }
    return res.status(200).json({ url: signed.signedUrl, kind });
  }
  // Legacy fallback for label-only inline base64 rows.
  if (kind === 'label' && row.labelData) {
    return res.status(200).json({ url: `data:application/pdf;base64,${row.labelData}`, kind });
  }
  const e = new Error(`No ${kind} PDF available for this shipment`); e.status = 404; throw e;
}

// Boxes that need labels: every distinct shipmentBoxId on inventory_items
// that has no shipments row, or only voided rows. Optionally filtered by
// saleId and carrier. Returns enough context for the Chrome extension to
// drive Palmstreet's flow without a second round-trip.
async function pending(req, res, brandId) {
  const saleId = req.query?.saleId || null;
  const carrier = req.query?.carrier || null; // 'usps' | 'ups' | null

  // Pull all candidate items (sold + has shipmentBoxId), grouped client-side.
  let q = supabase
    .from('inventory_items')
    .select('id, sku, name, variety, quantity, "saleId", "shipmentBoxId", "shipmentCarrier", buyer, "buyerUsername", "buyerAddress", "orderId"')
    .eq('brandId', brandId)
    .not('shipmentBoxId', 'is', null);
  if (saleId) q = q.eq('saleId', saleId);
  if (carrier) q = q.eq('shipmentCarrier', carrier);
  const { data: items, error: iErr } = await q;
  if (iErr) { const e = new Error(iErr.message); e.status = 500; throw e; }

  // Existing non-voided shipments to subtract.
  const { data: shipments, error: sErr } = await supabase
    .from('shipments')
    .select('id, "voidedAt"')
    .eq('brandId', brandId);
  if (sErr) { const e = new Error(sErr.message); e.status = 500; throw e; }
  const hasActive = new Set((shipments || []).filter(s => !s.voidedAt).map(s => s.id));

  // Sale name lookup for nicer queue labels.
  const saleIds = [...new Set((items || []).map(i => i.saleId).filter(Boolean))];
  let salesById = {};
  if (saleIds.length) {
    const { data: sales } = await supabase
      .from('sales')
      .select('id, name')
      .eq('brandId', brandId)
      .in('id', saleIds);
    salesById = Object.fromEntries((sales || []).map(s => [s.id, s.name]));
  }

  // Group items by shipmentBoxId, skip ones with active shipments.
  const grouped = new Map();
  for (const it of items || []) {
    if (hasActive.has(it.shipmentBoxId)) continue;
    if (!grouped.has(it.shipmentBoxId)) {
      grouped.set(it.shipmentBoxId, {
        shipmentBoxId: it.shipmentBoxId,
        carrier: it.shipmentCarrier || 'usps',
        saleId: it.saleId,
        saleName: salesById[it.saleId] || null,
        recipientName: it.buyer || '(unknown)',
        buyerUsername: it.buyerUsername || '',
        buyerAddress: it.buyerAddress || {},
        orderIds: new Set(),
        items: [],
      });
    }
    const g = grouped.get(it.shipmentBoxId);
    if (it.orderId) g.orderIds.add(it.orderId);
    g.items.push({ id: it.id, sku: it.sku, name: it.name, variety: it.variety, quantity: it.quantity || 1 });
  }

  const boxes = [...grouped.values()].map(b => ({
    ...b,
    orderIds: [...b.orderIds],
  })).sort((a, b) => a.recipientName.localeCompare(b.recipientName));

  return res.status(200).json({ boxes });
}

// Inverse of `pending`: boxes that DO have a recorded (non-voided) tracking
// number, joined with the recipient context needed to find the order on
// Palmstreet. Used by the Chrome extension's "push tracking to Palmstreet"
// flow — search the order by recipient name, then type the tracking number in.
async function withTracking(req, res, brandId) {
  const saleId = req.query?.saleId || null;

  let q = supabase
    .from('inventory_items')
    .select('id, sku, name, variety, quantity, status, "saleId", "shipmentBoxId", "shipmentCarrier", buyer, "buyerUsername", "buyerAddress", "orderId"')
    .eq('brandId', brandId)
    .not('shipmentBoxId', 'is', null);
  if (saleId) q = q.eq('saleId', saleId);
  const { data: items, error: iErr } = await q;
  if (iErr) { const e = new Error(iErr.message); e.status = 500; throw e; }

  // Active shipments that carry a tracking number, keyed by box id.
  const { data: shipments, error: sErr } = await supabase
    .from('shipments')
    .select('id, "trackingNumber", carrier, "carrierCode", "voidedAt"')
    .eq('brandId', brandId);
  if (sErr) { const e = new Error(sErr.message); e.status = 500; throw e; }
  const trackingById = new Map();
  for (const s of shipments || []) {
    if (!s.voidedAt && s.trackingNumber) trackingById.set(s.id, s);
  }

  // Sale name lookup for nicer queue labels.
  const saleIds = [...new Set((items || []).map(i => i.saleId).filter(Boolean))];
  let salesById = {};
  if (saleIds.length) {
    const { data: sales } = await supabase.from('sales').select('id, name').eq('brandId', brandId).in('id', saleIds);
    salesById = Object.fromEntries((sales || []).map(s => [s.id, s.name]));
  }

  // Group items by box, keeping only boxes that have a tracking number.
  const grouped = new Map();
  for (const it of items || []) {
    const ship = trackingById.get(it.shipmentBoxId);
    if (!ship) continue;
    if (!grouped.has(it.shipmentBoxId)) {
      grouped.set(it.shipmentBoxId, {
        shipmentBoxId: it.shipmentBoxId,
        trackingNumber: ship.trackingNumber,
        carrier: ship.carrier || it.shipmentCarrier || 'usps',
        saleId: it.saleId,
        saleName: salesById[it.saleId] || null,
        recipientName: it.buyer || '(unknown)',
        buyerUsername: it.buyerUsername || '',
        buyerAddress: it.buyerAddress || {},
        orderIds: new Set(),
        items: [],
        allShipped: true, // flips false if any item isn't shipped/delivered
      });
    }
    const g = grouped.get(it.shipmentBoxId);
    if (it.orderId) g.orderIds.add(it.orderId);
    g.items.push({ id: it.id, sku: it.sku, name: it.name, variety: it.variety, quantity: it.quantity || 1 });
    if (!['shipped', 'delivered'].includes(it.status)) g.allShipped = false;
  }

  const boxes = [...grouped.values()]
    .map(b => ({ ...b, orderIds: [...b.orderIds] }))
    .sort((a, b) => a.recipientName.localeCompare(b.recipientName));

  return res.status(200).json({ boxes });
}

async function recordTracking(req, res, userId, brandId) {
  let { shipmentBoxId, trackingNumber, matchByOrderId,
        labelPdfBase64, slipPdfBase64, weightOz } = req.body || {};

  const trim = (trackingNumber || '').trim();
  if (!trim) { const e = new Error('trackingNumber required'); e.status = 400; throw e; }

  if (!shipmentBoxId && matchByOrderId) {
    const { data: matches } = await supabase
      .from('inventory_items')
      .select('"shipmentBoxId"')
      .eq('brandId', brandId)
      .eq('orderId', String(matchByOrderId).trim())
      .not('shipmentBoxId', 'is', null)
      .limit(1);
    shipmentBoxId = matches?.[0]?.shipmentBoxId || null;
    if (!shipmentBoxId) {
      const e = new Error(`No shipment box found for Palmstreet order ${matchByOrderId}`);
      e.status = 404; throw e;
    }
  }
  if (!shipmentBoxId) {
    const e = new Error('shipmentBoxId or matchByOrderId required'); e.status = 400; throw e;
  }

  const { data: existing } = await supabase
    .from('shipments')
    .select('id, "carrierCode", "voidedAt", "purchasedAt"')
    .eq('id', shipmentBoxId)
    .eq('brandId', brandId)
    .maybeSingle();
  if (existing && existing.carrierCode !== PALMSTREET_CARRIER_CODE) {
    const e = new Error('A ShipStation label already exists for this box — void it first');
    e.status = 409; throw e;
  }

  const { data: items } = await supabase
    .from('inventory_items')
    .select('"saleId"')
    .eq('brandId', brandId)
    .eq('shipmentBoxId', shipmentBoxId)
    .limit(1);
  const saleId = items?.[0]?.saleId || null;

  // Upload PDFs if present. Soft-fail-through to save the row even if
  // Storage isn't reachable — the tracking number is still useful.
  // shipmentBoxId is a composite key (| + spaces); Supabase Storage rejects
  // those, so sanitize into a valid object key. The sanitized path is what
  // gets stored, so retrieval uses it verbatim.
  const key = String(shipmentBoxId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const labelStoragePath = await uploadPdf(`${key}.pdf`, labelPdfBase64).catch(logUploadErr('label'));
  const slipStoragePath  = await uploadPdf(`${key}-slip.pdf`, slipPdfBase64).catch(logUploadErr('slip'));

  const row = {
    id: shipmentBoxId,
    brandId,
    saleId,
    carrier: 'usps',
    carrierCode: PALMSTREET_CARRIER_CODE,
    serviceCode: PALMSTREET_SERVICE_CODE,
    packageCode: 'package',
    weightOz: Number.isFinite(parseFloat(weightOz)) ? parseFloat(weightOz) : null,
    trackingNumber: trim,
    labelStoragePath: labelStoragePath || null,
    shippingSlipStoragePath: slipStoragePath || null,
    isTestLabel: false,
    purchasedAt: existing?.purchasedAt || new Date().toISOString(),
    purchasedBy: userId,
    voidedAt: null,
    voidedBy: null,
  };

  const { data: saved, error: saveErr } = await supabase
    .from('shipments')
    .upsert(row)
    .select()
    .single();
  if (saveErr) { const e = new Error(saveErr.message); e.status = 500; throw e; }

  return res.status(200).json({ shipment: saved });
}

async function clearTracking(req, res, brandId) {
  const { shipmentBoxId } = req.body || {};
  if (!shipmentBoxId) { const e = new Error('shipmentBoxId required'); e.status = 400; throw e; }

  const { data: existing } = await supabase
    .from('shipments')
    .select('id, "carrierCode"')
    .eq('id', shipmentBoxId)
    .eq('brandId', brandId)
    .maybeSingle();
  if (!existing) { const e = new Error('No tracking entry for this box'); e.status = 404; throw e; }
  if (existing.carrierCode !== PALMSTREET_CARRIER_CODE) {
    const e = new Error('This is a ShipStation label — void via Buy Label flow instead');
    e.status = 409; throw e;
  }

  const { error } = await supabase.from('shipments').delete().eq('id', shipmentBoxId).eq('brandId', brandId);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ ok: true });
}

// POST /api/shipments  body: { action: 'set-box-note', shipmentBoxId, note }
// Upserts the per-box note. Empty/whitespace note is persisted as null so
// the row stays as an audit trail of when the note was cleared (and by
// whom). The row is created on first save — `shipment_boxes` is lazy.
async function setBoxNote(req, res, userId, brandId) {
  const { shipmentBoxId, note } = req.body || {};
  if (!shipmentBoxId || typeof shipmentBoxId !== 'string') {
    const e = new Error('shipmentBoxId required'); e.status = 400; throw e;
  }
  const trimmed = typeof note === 'string' ? note.trim() : '';
  const payload = {
    id: shipmentBoxId,
    brandId,
    note: trimmed === '' ? null : trimmed,
    updatedAt: new Date().toISOString(),
    updatedBy: userId,
  };
  const { data, error } = await supabase
    .from('shipment_boxes')
    .upsert(payload, { onConflict: 'id' })
    .select('id, note, "updatedAt", "updatedBy"')
    .single();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ box: data });
}

// POST /api/shipments  body: { action:'set-box-packaging', shipmentBoxId,
//   boxSizeId?, weightOz?, serviceKey? }
// Upserts the per-box packaging selection (box size + weight + service)
// onto the lazy shipment_boxes row. Only the keys present in the body are
// touched, so saving a service doesn't wipe a previously-saved size. Empty
// string / null clears a field. Mirrors set-box-note's upsert pattern.
const VALID_SERVICE_KEYS = ['usps_priority', 'ups_2nd_day_air', 'ups_next_day_air_saver'];
const VALID_CARRIERS = ['usps', 'ups'];
async function setBoxPackaging(req, res, userId, brandId) {
  const { shipmentBoxId, boxSizeId, weightOz, serviceKey, carrierOverride } = req.body || {};
  if (!shipmentBoxId || typeof shipmentBoxId !== 'string') {
    const e = new Error('shipmentBoxId required'); e.status = 400; throw e;
  }
  const patch = { id: shipmentBoxId, brandId, updatedAt: new Date().toISOString(), updatedBy: userId };
  if ('boxSizeId' in req.body) patch.boxSizeId = boxSizeId ? String(boxSizeId) : null;
  if ('weightOz' in req.body) {
    const n = parseFloat(weightOz);
    patch.weightOz = Number.isFinite(n) && n > 0 ? n : null;
  }
  if ('serviceKey' in req.body) {
    if (serviceKey && !VALID_SERVICE_KEYS.includes(serviceKey)) {
      const e = new Error(`Invalid serviceKey: ${serviceKey}`); e.status = 400; throw e;
    }
    patch.serviceKey = serviceKey || null;
  }
  // Per-box carrier override (operator flip). null/'' clears it so the carrier
  // reverts to the content-derived default (anthurium → UPS, else stamped).
  if ('carrierOverride' in req.body) {
    const c = carrierOverride ? String(carrierOverride).toLowerCase() : null;
    if (c && !VALID_CARRIERS.includes(c)) {
      const e = new Error(`Invalid carrierOverride: ${carrierOverride}`); e.status = 400; throw e;
    }
    patch.carrierOverride = c;
  }

  const { data, error } = await supabase
    .from('shipment_boxes')
    .upsert(patch, { onConflict: 'id' })
    .select('*') // '*' so a pre-migration missing carrierOverride column doesn't 400
    .single();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ box: data });
}

// POST /api/shipments  body: { action:'set-box-hold', shipmentBoxId,
//   hold: boolean, days?: number }
// Puts a box on hold (holdUntil = now + days, default 7) or clears it
// (hold:false → null). The deadline is computed server-side so it doesn't
// depend on the operator's clock. Lazy-creates the shipment_boxes row.
async function setBoxHold(req, res, userId, brandId) {
  const { shipmentBoxId, hold, days } = req.body || {};
  if (!shipmentBoxId || typeof shipmentBoxId !== 'string') {
    const e = new Error('shipmentBoxId required'); e.status = 400; throw e;
  }
  let holdUntil = null;
  if (hold) {
    const n = parseFloat(days);
    const d = Number.isFinite(n) && n > 0 ? n : 7;
    holdUntil = new Date(Date.now() + d * 86400000).toISOString();
  }
  const { data, error } = await supabase
    .from('shipment_boxes')
    .upsert(
      { id: shipmentBoxId, brandId, holdUntil, updatedAt: new Date().toISOString(), updatedBy: userId },
      { onConflict: 'id' },
    )
    .select('*') // needs migration 0028 (the holdUntil column) applied
    .single();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ box: data });
}

// Packer cross-device handoff. A packer running the iPad packing UI taps
// "Send to phone" on an open box; their phone (same login) polls and shows
// the box's items as a find-list. We stash the snapshot in app_settings
// under a per-user key — it's transient per-user state, one row, overwritten
// on each send, so no dedicated table is needed.
const HANDOFF_PREFIX = 'packer-handoff:';

// POST /api/shipments  body: { action:'send-to-phone', box }
// Stores the (sanitized) box snapshot the iPad sent, stamped with a fresh
// sentAt the receiving device uses to detect a new handoff.
async function sendToPhone(req, res, userId) {
  const { box } = req.body || {};
  if (!box || typeof box !== 'object' || !box.id) {
    const e = new Error('box required'); e.status = 400; throw e;
  }
  const str = (v) => (v == null ? null : String(v));
  const safeBox = {
    id: String(box.id),
    code: str(box.code) || '',
    buyer: str(box.buyer) || '',
    buyerUsername: str(box.buyerUsername) || '',
    carrier: str(box.carrier) || 'usps',
    items: (Array.isArray(box.items) ? box.items : []).slice(0, 500).map(it => ({
      id: str(it?.id),
      sku: str(it?.sku),
      name: str(it?.name),
      variety: str(it?.variety),
      quantity: Number.isFinite(+it?.quantity) ? +it.quantity : null,
      lotNumber: str(it?.lotNumber),
      notes: str(it?.notes),
      packedAt: str(it?.packedAt),
      status: str(it?.status),
    })),
  };
  const sentAt = new Date().toISOString();
  const { error } = await supabase
    .from('app_settings')
    .upsert({
      id: `${HANDOFF_PREFIX}${userId}`,
      data: { box: safeBox, sentAt, sentBy: userId },
      updatedAt: sentAt,
      updatedBy: userId,
    }, { onConflict: 'id' });
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ ok: true, sentAt });
}

// GET /api/shipments?action=phone-handoff
// Returns the caller's latest handoff ({ box, sentAt }) or null. The phone
// polls this; a changed sentAt means a fresh box to surface.
async function phoneHandoff(req, res, userId) {
  const { data, error } = await supabase
    .from('app_settings')
    .select('data')
    .eq('id', `${HANDOFF_PREFIX}${userId}`)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ handoff: data?.data || null });
}

// GET /api/shipments?action=box-notes[&saleId=<id>]
// Returns { boxNotes: { [shipmentBoxId]: { note, boxSizeId, weightOz,
//   serviceKey, updatedAt, updatedBy } } }.
// With saleId: scoped to boxes whose items belong to that sale.
// Without saleId: returns all box-note rows (top-level Ready/Shipped tab
// uses this to decorate every visible box). Missing rows are absent from
// the map (client treats absence as "no note").
async function boxNotes(req, res, brandId) {
  const saleId = req.query?.saleId;
  let query = supabase
    .from('shipment_boxes')
    // '*' so a pre-migration missing carrierOverride column doesn't 400 and
    // break all box note/packaging loading. Fields are read by name below.
    .select('*')
    .eq('brandId', brandId);
  if (saleId) {
    const { data: items, error: itemsErr } = await supabase
      .from('inventory_items')
      .select('"shipmentBoxId"')
      .eq('brandId', brandId)
      .eq('saleId', saleId)
      .not('shipmentBoxId', 'is', null);
    if (itemsErr) { const e = new Error(itemsErr.message); e.status = 500; throw e; }
    const ids = Array.from(new Set((items || []).map(i => i.shipmentBoxId).filter(Boolean)));
    if (ids.length === 0) return res.status(200).json({ boxNotes: {} });
    query = query.in('id', ids);
  }
  const { data: rows, error: rowsErr } = await query;
  if (rowsErr) { const e = new Error(rowsErr.message); e.status = 500; throw e; }
  const map = Object.fromEntries((rows || []).map(r => [r.id, {
    note: r.note,
    boxSizeId: r.boxSizeId ?? null,
    weightOz: r.weightOz ?? null,
    serviceKey: r.serviceKey ?? null,
    carrierOverride: r.carrierOverride ?? null,
    holdUntil: r.holdUntil ?? null,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  }]));
  return res.status(200).json({ boxNotes: map });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function uploadPdf(path, base64) {
  if (!base64) return null;
  const buf = Buffer.from(String(base64), 'base64');
  if (buf.length === 0) return null;
  const { error } = await supabase
    .storage
    .from(STORAGE_BUCKET)
    .upload(path, buf, { contentType: 'application/pdf', upsert: true });
  if (error) throw error;
  return path;
}

function logUploadErr(kind) {
  return (e) => {
    console.error(`[shipments] ${kind} PDF upload failed:`, e?.message || e);
    return null; // keep going — tracking number gets saved either way
  };
}

