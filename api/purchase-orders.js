import { supabase, requireBrand, brandIdFromReq, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Purchase orders. Action-dispatched. See:
//   docs/superpowers/specs/2026-05-22-purchasing-catalog-and-receive-design.md

// Generates the next SKU for a variety code, using the same RPC the
// existing /api/items handler uses. Synchronous in the request path:
// a 10-unit receive does 10 RPC calls in sequence. Acceptable for
// shipment-size batches.
async function nextSku(varietyCode, brandId) {
  const { data, error } = await supabase.rpc('inventory_max_sku_suffix', { p_brand: brandId });
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  const next = (data || 0) + 1;
  return `${varietyCode}-${next}`;
}

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const { user, brandId } = await requireBrand(userId, brandIdFromReq(req));

  if (req.method === 'GET') {
    const action = req.query?.action;
    if (action === 'get') return getOne(req, res, brandId);
    return list(req, res, brandId); // default GET
  }

  if (req.method === 'POST') {
    const action = req.body?.action;
    switch (action) {
      case 'create':              return create(req, res, user, brandId);
      case 'update-header':       return updateHeader(req, res, user, brandId);
      case 'add-line':            return addLine(req, res, brandId);
      case 'update-line':         return updateLine(req, res, brandId);
      case 'remove-line':         return removeLine(req, res, brandId);
      case 'delete':              return softDelete(req, res, user, brandId);
      case 'mark-ordered':        return markOrdered(req, res, user, brandId);
      case 'receive-line':        return receiveLine(req, res, user, brandId);
      case 'cancel-receive-line': return cancelReceiveLine(req, res, user, brandId);
      default: { const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e; }
    }
  }

  return methodNotAllowed(res, ['GET', 'POST']);
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function loadPo(id, brandId) {
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*')
    .eq('id', id)
    .eq('brandId', brandId)
    .is('deletedAt', null)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!data) { const e = new Error('Purchase order not found'); e.status = 404; throw e; }
  return data;
}

function requireStatus(po, allowed) {
  if (!allowed.includes(po.status)) {
    const e = new Error(`Cannot do this while PO is "${po.status}" (allowed: ${allowed.join(', ')})`);
    e.status = 409; throw e;
  }
}

// ─── list / get ─────────────────────────────────────────────────────────────

async function list(req, res, brandId) {
  const statuses = (req.query?.status || 'draft,ordered')
    .split(',').map(s => s.trim()).filter(Boolean);
  const { data: pos, error } = await supabase
    .from('purchase_orders')
    .select('*')
    .eq('brandId', brandId)
    .in('status', statuses)
    .is('deletedAt', null)
    .order('createdAt', { ascending: false });
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }

  const ids = (pos || []).map(p => p.id);
  let lineRows = [];
  if (ids.length) {
    const { data: lines, error: lErr } = await supabase
      .from('purchase_order_lines')
      .select('"purchaseOrderId", "quantityOrdered"')
      .eq('brandId', brandId)
      .in('purchaseOrderId', ids);
    if (lErr) { const e = new Error(lErr.message); e.status = 500; throw e; }
    lineRows = lines || [];
  }
  const tally = new Map();
  for (const l of lineRows) {
    const t = tally.get(l.purchaseOrderId) || { lineCount: 0, unitCount: 0 };
    t.lineCount += 1;
    t.unitCount += l.quantityOrdered;
    tally.set(l.purchaseOrderId, t);
  }
  const out = (pos || []).map(p => ({
    ...p,
    lineCount: tally.get(p.id)?.lineCount || 0,
    unitCount: tally.get(p.id)?.unitCount || 0,
  }));
  return res.status(200).json({ purchaseOrders: out });
}

async function getOne(req, res, brandId) {
  const po = await loadPo(req.query?.id, brandId);
  const { data: lines, error: lErr } = await supabase
    .from('purchase_order_lines')
    .select('*')
    .eq('brandId', brandId)
    .eq('purchaseOrderId', po.id)
    .order('sortOrder');
  if (lErr) { const e = new Error(lErr.message); e.status = 500; throw e; }
  const lineIds = (lines || []).map(l => l.id);
  let received = [];
  if (lineIds.length) {
    const { data: r, error: rErr } = await supabase
      .from('purchase_order_received_items')
      .select('*')
      .eq('brandId', brandId)
      .in('lineId', lineIds);
    if (rErr) { const e = new Error(rErr.message); e.status = 500; throw e; }
    received = r || [];
  }
  return res.status(200).json({ purchaseOrder: po, lines: lines || [], receivedItems: received });
}

// ─── header writes ──────────────────────────────────────────────────────────

async function create(req, res, user, brandId) {
  const { supplier, shippingFee, notes } = req.body || {};
  const row = {
    id: newId(),
    brandId,
    supplier: String(supplier || '').slice(0, 500),
    status: 'draft',
    shippingFee: parseFloat(shippingFee || 0) || 0,
    notes: notes ? String(notes).slice(0, 500) : null,
    createdAt: new Date().toISOString(),
    createdBy: user.displayName,
  };
  const { error } = await supabase.from('purchase_orders').insert(row);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ purchaseOrder: row });
}

async function updateHeader(req, res, user, brandId) {
  const { id, supplier, shippingFee, notes } = req.body || {};
  const po = await loadPo(id, brandId);
  requireStatus(po, ['draft', 'ordered']);
  const patch = { modifiedAt: new Date().toISOString(), modifiedBy: user.displayName };
  if (supplier    !== undefined) patch.supplier    = String(supplier || '').slice(0, 500);
  if (shippingFee !== undefined) {
    const n = parseFloat(shippingFee);
    if (!Number.isFinite(n) || n < 0) { const e = new Error('shippingFee must be ≥ 0'); e.status = 400; throw e; }
    patch.shippingFee = n;
  }
  if (notes       !== undefined) patch.notes = notes ? String(notes).slice(0, 500) : null;
  const { error } = await supabase.from('purchase_orders').update(patch).eq('id', id).eq('brandId', brandId);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ purchaseOrder: { ...po, ...patch } });
}

async function softDelete(req, res, user, brandId) {
  const { id } = req.body || {};
  const po = await loadPo(id, brandId);
  requireStatus(po, ['draft']);
  const { error } = await supabase
    .from('purchase_orders')
    .update({ deletedAt: new Date().toISOString(), modifiedBy: user.displayName })
    .eq('id', id)
    .eq('brandId', brandId);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ ok: true });
}

// ─── lines ──────────────────────────────────────────────────────────────────

async function addLine(req, res, brandId) {
  const { id, speciesId, quantityOrdered, unitWholesalePrice } = req.body || {};
  const po = await loadPo(id, brandId);
  requireStatus(po, ['draft']);
  if (!speciesId) { const e = new Error('speciesId required'); e.status = 400; throw e; }
  const qty = parseInt(quantityOrdered, 10) || 1;
  if (qty < 1) { const e = new Error('quantityOrdered must be ≥ 1'); e.status = 400; throw e; }

  let price = (unitWholesalePrice === undefined || unitWholesalePrice === null || unitWholesalePrice === '')
    ? null
    : parseFloat(unitWholesalePrice);
  if (price === null) {
    const { data: sp, error: spErr } = await supabase
      .from('species').select('"wholesalePrice"').eq('id', speciesId).eq('brandId', brandId).maybeSingle();
    if (spErr) { const e = new Error(spErr.message); e.status = 500; throw e; }
    if (!sp)   { const e = new Error('Unknown species'); e.status = 404; throw e; }
    price = sp.wholesalePrice ?? 0;
  }
  if (!Number.isFinite(price) || price < 0) {
    const e = new Error('unitWholesalePrice must be ≥ 0'); e.status = 400; throw e;
  }

  // Upsert behavior: if a line for this (PO, species) already exists,
  // bump its quantityOrdered.
  const { data: existing, error: exErr } = await supabase
    .from('purchase_order_lines')
    .select('*')
    .eq('brandId', brandId)
    .eq('purchaseOrderId', id)
    .eq('speciesId', speciesId)
    .maybeSingle();
  if (exErr) { const e = new Error(exErr.message); e.status = 500; throw e; }

  if (existing) {
    const next = { quantityOrdered: existing.quantityOrdered + qty };
    const { error } = await supabase
      .from('purchase_order_lines').update(next).eq('id', existing.id).eq('brandId', brandId);
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    return res.status(200).json({ line: { ...existing, ...next } });
  }

  const { data: last } = await supabase
    .from('purchase_order_lines')
    .select('"sortOrder"')
    .eq('brandId', brandId)
    .eq('purchaseOrderId', id)
    .order('sortOrder', { ascending: false })
    .limit(1);
  const nextSort = last && last[0] ? last[0].sortOrder + 1 : 0;

  const row = {
    id: newId(),
    brandId,
    purchaseOrderId: id,
    speciesId,
    quantityOrdered: qty,
    quantityReceived: 0,
    unitWholesalePrice: price,
    sortOrder: nextSort,
  };
  const { error } = await supabase.from('purchase_order_lines').insert(row);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ line: row });
}

async function updateLine(req, res, brandId) {
  const { id, lineId, quantityOrdered, unitWholesalePrice } = req.body || {};
  const po = await loadPo(id, brandId);
  requireStatus(po, ['draft']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }

  const patch = {};
  if (quantityOrdered !== undefined) {
    const n = parseInt(quantityOrdered, 10);
    if (!Number.isFinite(n) || n <= 0) {
      const e = new Error('quantityOrdered must be > 0 (use remove-line to drop a line)'); e.status = 400; throw e;
    }
    patch.quantityOrdered = n;
  }
  if (unitWholesalePrice !== undefined) {
    const n = parseFloat(unitWholesalePrice);
    if (!Number.isFinite(n) || n < 0) {
      const e = new Error('unitWholesalePrice must be ≥ 0'); e.status = 400; throw e;
    }
    patch.unitWholesalePrice = n;
  }
  if (Object.keys(patch).length === 0) {
    const e = new Error('No fields to update'); e.status = 400; throw e;
  }

  const { error } = await supabase
    .from('purchase_order_lines').update(patch).eq('id', lineId).eq('purchaseOrderId', id).eq('brandId', brandId);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ ok: true });
}

async function removeLine(req, res, brandId) {
  const { id, lineId } = req.body || {};
  const po = await loadPo(id, brandId);
  requireStatus(po, ['draft']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }
  const { error } = await supabase
    .from('purchase_order_lines').delete().eq('id', lineId).eq('purchaseOrderId', id).eq('brandId', brandId);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ ok: true });
}

// ─── placeholders, filled in tasks 5-6 ─────────────────────────────────────

async function markOrdered(req, res, user, brandId) {
  const { id } = req.body || {};
  const po = await loadPo(id, brandId);
  requireStatus(po, ['draft']);

  // Must have at least one line.
  const { count, error: cErr } = await supabase
    .from('purchase_order_lines')
    .select('id', { count: 'exact', head: true })
    .eq('brandId', brandId)
    .eq('purchaseOrderId', id);
  if (cErr) { const e = new Error(cErr.message); e.status = 500; throw e; }
  if (!count) { const e = new Error('Cannot mark ordered — PO has no lines'); e.status = 409; throw e; }

  const now = new Date().toISOString();
  const { error } = await supabase
    .from('purchase_orders')
    .update({ status: 'ordered', orderedAt: now, modifiedAt: now, modifiedBy: user.displayName })
    .eq('id', id)
    .eq('brandId', brandId);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ purchaseOrder: { ...po, status: 'ordered', orderedAt: now } });
}
async function receiveLine(req, res, user, brandId) {
  const { id, lineId, quantityReceived } = req.body || {};
  const po = await loadPo(id, brandId);
  requireStatus(po, ['ordered']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }
  const n = parseInt(quantityReceived, 10);
  if (!Number.isFinite(n) || n <= 0) {
    const e = new Error('quantityReceived must be > 0'); e.status = 400; throw e;
  }

  const { data: line, error: lErr } = await supabase
    .from('purchase_order_lines')
    .select('*')
    .eq('id', lineId)
    .eq('purchaseOrderId', id)
    .eq('brandId', brandId)
    .maybeSingle();
  if (lErr) { const e = new Error(lErr.message); e.status = 500; throw e; }
  if (!line) { const e = new Error('Line not found'); e.status = 404; throw e; }

  const { data: species, error: spErr } = await supabase
    .from('species')
    .select('id, epithet, "varietyId", "idealSellingPrice"')
    .eq('id', line.speciesId)
    .eq('brandId', brandId)
    .maybeSingle();
  if (spErr) { const e = new Error(spErr.message); e.status = 500; throw e; }
  if (!species) { const e = new Error('Linked species missing'); e.status = 500; throw e; }

  const { data: variety, error: vErr } = await supabase
    .from('varieties').select('name, code').eq('id', species.varietyId).eq('brandId', brandId).maybeSingle();
  if (vErr) { const e = new Error(vErr.message); e.status = 500; throw e; }

  // Allocate shipping per unit across ALL lines on this PO.
  const { data: allLines, error: alErr } = await supabase
    .from('purchase_order_lines')
    .select('"quantityOrdered"')
    .eq('brandId', brandId)
    .eq('purchaseOrderId', id);
  if (alErr) { const e = new Error(alErr.message); e.status = 500; throw e; }
  const totalOrdered = (allLines || []).reduce((s, l) => s + l.quantityOrdered, 0) || 1;
  const perUnitShipping = Math.round(((po.shippingFee || 0) / totalOrdered) * 10000) / 10000;

  const nowIso = new Date().toISOString();
  const todayDate = nowIso.slice(0, 10);
  const supplierLabel = po.supplier && po.supplier.trim() ? po.supplier.trim() : `PO #${po.id.slice(-6)}`;

  const createdIds = [];
  for (let i = 0; i < n; i++) {
    const sku = await nextSku(variety?.code || 'PLT', brandId);
    const itemId = newId();
    const itemRow = {
      id: itemId,
      brandId,
      sku,
      type: 'plant',
      name: species.epithet,
      variety: variety?.name || null,
      speciesId: species.id,
      quantity: 1,
      grossCost: Number(line.unitWholesalePrice) + perUnitShipping,
      idealPrice: species.idealSellingPrice ?? null,
      status: 'available',
      lotKind: 'sale',
      source: supplierLabel,
      acquiredAt: todayDate,
      createdAt: nowIso,
      createdBy: user.displayName,
    };
    const { error: insErr } = await supabase.from('inventory_items').insert(itemRow);
    if (insErr) { const e = new Error(`Insert SKU ${sku} failed: ${insErr.message}`); e.status = 500; throw e; }

    const auditRow = {
      id: newId(),
      brandId,
      lineId,
      inventoryItemId: itemId,
      receivedAt: nowIso,
      receivedBy: user.displayName,
    };
    const { error: aErr } = await supabase.from('purchase_order_received_items').insert(auditRow);
    if (aErr) { const e = new Error(`Audit insert failed for ${sku}: ${aErr.message}`); e.status = 500; throw e; }
    createdIds.push(itemId);
  }

  const newReceived = line.quantityReceived + n;
  const { error: uErr } = await supabase
    .from('purchase_order_lines')
    .update({ quantityReceived: newReceived })
    .eq('id', lineId)
    .eq('brandId', brandId);
  if (uErr) { const e = new Error(uErr.message); e.status = 500; throw e; }

  // If every line is fully received, flip PO.
  const { data: refreshed, error: rErr } = await supabase
    .from('purchase_order_lines')
    .select('"quantityOrdered","quantityReceived"')
    .eq('brandId', brandId)
    .eq('purchaseOrderId', id);
  if (rErr) { const e = new Error(rErr.message); e.status = 500; throw e; }
  const allDone = (refreshed || []).every(l => l.quantityReceived >= l.quantityOrdered);
  if (allDone) {
    await supabase
      .from('purchase_orders')
      .update({ status: 'received', receivedAt: nowIso, modifiedAt: nowIso, modifiedBy: user.displayName })
      .eq('id', id)
      .eq('brandId', brandId);
  }

  return res.status(200).json({
    line: { ...line, quantityReceived: newReceived },
    createdInventoryItemIds: createdIds,
    poFlippedToReceived: allDone,
  });
}

async function cancelReceiveLine(req, res, user, brandId) {
  const { id, lineId } = req.body || {};
  const po = await loadPo(id, brandId);
  // Cancel allowed on partially-received (ordered) AND fully-received POs.
  requireStatus(po, ['ordered', 'received']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }

  const { data: audits, error: aErr } = await supabase
    .from('purchase_order_received_items')
    .select('"inventoryItemId"')
    .eq('brandId', brandId)
    .eq('lineId', lineId);
  if (aErr) { const e = new Error(aErr.message); e.status = 500; throw e; }
  const itemIds = (audits || []).map(a => a.inventoryItemId);
  if (itemIds.length === 0) {
    return res.status(200).json({ deletedCount: 0, line: null });
  }

  const { data: items, error: iErr } = await supabase
    .from('inventory_items')
    .select('id, status, "deletedAt"')
    .eq('brandId', brandId)
    .in('id', itemIds);
  if (iErr) { const e = new Error(iErr.message); e.status = 500; throw e; }
  const cancelable = (items || []).filter(it => it.status === 'available' && !it.deletedAt);
  if (cancelable.length === 0) {
    const e = new Error('Nothing to cancel — every SKU from this line has already moved past available');
    e.status = 409; throw e;
  }

  const nowIso = new Date().toISOString();
  const cancelIds = cancelable.map(c => c.id);
  const { error: dErr } = await supabase
    .from('inventory_items')
    .update({ deletedAt: nowIso, deletedBy: user.displayName })
    .eq('brandId', brandId)
    .in('id', cancelIds);
  if (dErr) { const e = new Error(dErr.message); e.status = 500; throw e; }

  const { data: line } = await supabase
    .from('purchase_order_lines').select('*').eq('id', lineId).eq('brandId', brandId).maybeSingle();
  if (line) {
    const next = Math.max(0, line.quantityReceived - cancelIds.length);
    await supabase
      .from('purchase_order_lines').update({ quantityReceived: next }).eq('id', lineId).eq('brandId', brandId);
    line.quantityReceived = next;
  }

  if (po.status === 'received') {
    await supabase
      .from('purchase_orders')
      .update({ status: 'ordered', receivedAt: null, modifiedAt: nowIso, modifiedBy: user.displayName })
      .eq('id', id)
      .eq('brandId', brandId);
  }

  return res.status(200).json({ deletedCount: cancelIds.length, line });
}
