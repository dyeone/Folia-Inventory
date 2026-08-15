import { supabase, requireAdmin, requireBrand, brandIdFromReq, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Purchase orders. Action-dispatched. See:
//   docs/superpowers/specs/2026-05-22-purchasing-catalog-and-receive-design.md

// Hard ceilings. RECEIVE_MAX mirrors the packer UI's per-print cap — without
// it any authenticated member could POST an arbitrary quantityReceived and
// mint junk inventory until the function times out. LINE_QTY_MAX guards a
// fat-fingered spreadsheet cell (a date serial in the qty column) from
// creating a million-unit line that distorts shipping allocation forever.
const RECEIVE_MAX = 500;
const LINE_QTY_MAX = 10000;

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
    // PO editing is admin-shaped — it sets wholesale prices, deletes orders,
    // and controls what reaches the packer's receiving screen. Same server-
    // side posture as DELETE /api/items. Receiving (receive-line /
    // cancel-receive-line) stays open to any brand member: that IS the
    // packer's job.
    const ADMIN_ACTIONS = new Set([
      'create', 'update-header', 'add-line', 'update-line', 'remove-line', 'delete', 'mark-ordered',
    ]);
    if (ADMIN_ACTIONS.has(action)) await requireAdmin(userId);
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
  const fee = parseFloat(shippingFee || 0) || 0;
  if (!Number.isFinite(fee) || fee < 0) {
    const e = new Error('shippingFee must be ≥ 0'); e.status = 400; throw e;
  }
  const row = {
    id: newId(),
    brandId,
    supplier: String(supplier || '').slice(0, 500),
    status: 'draft',
    shippingFee: fee,
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
  if (qty > LINE_QTY_MAX) {
    const e = new Error(`quantityOrdered must be ≤ ${LINE_QTY_MAX} — check the sheet's qty column`);
    e.status = 400; throw e;
  }

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

// ─── status transitions & receiving ────────────────────────────────────────

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
  // 'received' is allowed too: extras often surface AFTER the last line
  // completes and auto-flips the PO — the packer counts stragglers on a
  // finished order. The allDone check below simply re-confirms 'received'.
  requireStatus(po, ['ordered', 'received']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }
  const n = parseInt(quantityReceived, 10);
  if (!Number.isFinite(n) || n <= 0) {
    const e = new Error('quantityReceived must be > 0'); e.status = 400; throw e;
  }
  if (n > RECEIVE_MAX) {
    const e = new Error(`quantityReceived must be ≤ ${RECEIVE_MAX} per receive`);
    e.status = 400; throw e;
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

  // Batch mint: one suffix read + one items insert + one audit insert. The
  // old per-unit loop was ~3 sequential round trips per plant, so a big
  // receive from the packing table risked the serverless timeout mid-loop —
  // stranding minted items with the line counter never updated. Two
  // attempts: a concurrent minting flow (another receive, /api/items) can
  // win the same suffix range, in which case the unique sku index fails the
  // whole insert atomically (23505) and we re-read + retry once.
  let createdItems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: maxSuffix, error: mErr } = await supabase.rpc('inventory_max_sku_suffix', { p_brand: brandId });
    if (mErr) { const e = new Error(mErr.message); e.status = 500; throw e; }
    const base = (maxSuffix || 0) + 1;
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push({
        id: newId(),
        brandId,
        sku: `${variety?.code || 'PLT'}-${base + i}`,
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
      });
    }
    const { error: insErr } = await supabase.from('inventory_items').insert(rows);
    if (!insErr) { createdItems = rows; break; }
    if (attempt === 0 && insErr.code === '23505') continue;
    const e = new Error(`Item insert failed: ${insErr.message}`); e.status = 500; throw e;
  }
  if (!createdItems.length) {
    const e = new Error('SKU numbering collided twice — retry the receive'); e.status = 409; throw e;
  }

  const auditRows = createdItems.map(it => ({
    id: newId(),
    brandId,
    lineId,
    inventoryItemId: it.id,
    receivedAt: nowIso,
    receivedBy: user.displayName,
  }));
  const { error: aErr } = await supabase.from('purchase_order_received_items').insert(auditRows);
  if (aErr) {
    // Audit rows are how cancel-receive-line finds a line's items — items
    // without them would be invisible to cleanup. Compensate (hard-delete
    // the rows this call just made) so the failure leaves nothing behind.
    await supabase.from('inventory_items').delete().eq('brandId', brandId)
      .in('id', createdItems.map(it => it.id));
    const e = new Error(`Audit insert failed: ${aErr.message} — nothing was received`); e.status = 500; throw e;
  }

  // Re-read the counter right before writing. supabase-js can't express an
  // atomic increment, but the batch above takes milliseconds, so re-reading
  // shrinks the concurrent-receive lost-update window from tens of seconds
  // to almost nothing. The audit table stays the ground truth regardless.
  const { data: lineNow } = await supabase
    .from('purchase_order_lines')
    .select('"quantityReceived"')
    .eq('id', lineId)
    .eq('brandId', brandId)
    .maybeSingle();
  const newReceived = (lineNow?.quantityReceived ?? line.quantityReceived) + n;
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
  // Don't re-stamp receivedAt when extras land on an already-received PO.
  if (allDone && po.status !== 'received') {
    await supabase
      .from('purchase_orders')
      .update({ status: 'received', receivedAt: nowIso, modifiedAt: nowIso, modifiedBy: user.displayName })
      .eq('id', id)
      .eq('brandId', brandId);
  }

  return res.status(200).json({
    line: { ...line, quantityReceived: newReceived },
    createdInventoryItemIds: createdItems.map(it => it.id),
    // Full rows so the packer's receiving pane can print labels for exactly
    // the SKUs this call minted, without a follow-up items fetch.
    createdItems,
    poFlippedToReceived: allDone,
  });
}

async function cancelReceiveLine(req, res, user, brandId) {
  const { id, lineId } = req.body || {};
  const po = await loadPo(id, brandId);
  // Cancel allowed on partially-received (ordered) AND fully-received POs.
  requireStatus(po, ['ordered', 'received']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }

  // The line MUST belong to the PO whose status was just checked — without
  // this, a lineId from a different (long-closed) PO could be mass-cancelled
  // by pairing it with any currently-ordered PO id, and the un-flip below
  // would mutate the wrong order.
  const { data: lineRow, error: lrErr } = await supabase
    .from('purchase_order_lines')
    .select('*')
    .eq('id', lineId)
    .eq('purchaseOrderId', id)
    .eq('brandId', brandId)
    .maybeSingle();
  if (lrErr) { const e = new Error(lrErr.message); e.status = 500; throw e; }
  if (!lineRow) { const e = new Error('Line not found on this purchase order'); e.status = 404; throw e; }

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

  // Soft-delete with the status conditions IN the update itself — an item
  // that got scanned into a box or sold between a select and this write
  // must not vanish. The returned rows are the ground truth for how many
  // were actually cancelled.
  const nowIso = new Date().toISOString();
  const { data: deleted, error: dErr } = await supabase
    .from('inventory_items')
    .update({ deletedAt: nowIso, deletedBy: user.displayName })
    .eq('brandId', brandId)
    .in('id', itemIds)
    .eq('status', 'available')
    .is('deletedAt', null)
    .select('id');
  if (dErr) { const e = new Error(dErr.message); e.status = 500; throw e; }
  const cancelIds = (deleted || []).map(d => d.id);
  if (cancelIds.length === 0) {
    const e = new Error('Nothing to cancel — every SKU from this line has already moved past available');
    e.status = 409; throw e;
  }

  // Drop the audit rows for the cancelled items so a Recently-Deleted
  // restore brings them back as plain inventory, disconnected from the PO —
  // otherwise a restore + re-receive double-counts the same physical stock
  // and a later cancel decrements the line by more than reality.
  const { error: adErr } = await supabase
    .from('purchase_order_received_items')
    .delete()
    .eq('brandId', brandId)
    .eq('lineId', lineId)
    .in('inventoryItemId', cancelIds);
  if (adErr) { const e = new Error(adErr.message); e.status = 500; throw e; }

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
