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
// Mirrored client-side as MAX_ROWS in ImportOrderModal.jsx.
const IMPORT_LINES_MAX = 500;
// Money ceiling for member-supplied prices/fees on import-order — the action
// is open to non-admins, and an absurd unit price would flow straight into
// minted inventory grossCost and every financial report.
const PRICE_MAX = 100000;

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
    // import-order is deliberately NOT admin-gated: uploading the supplier's
    // list when the cargo lands is part of receiving, and the packer at the
    // dock shouldn't wait on an admin. It only CREATES a fresh order in one
    // deliberate action — editing, re-pricing, and deleting existing POs
    // stay admin-only.
    const ADMIN_ACTIONS = new Set([
      'create', 'update-header', 'add-line', 'update-line', 'remove-line', 'delete', 'mark-ordered',
    ]);
    if (ADMIN_ACTIONS.has(action)) await requireAdmin(userId);
    switch (action) {
      case 'import-order':        return importOrder(req, res, user, brandId);
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

// One-request wholesale import: species + PO + every line land in a handful
// of batch statements instead of one request per row (a 50-row sheet used to
// be ~50 sequential add-line calls, each with its own loadPo overhead).
// Open to brand members — see the dispatcher note. Write order is chosen so
// a mid-flight failure leaves nothing half-armed: species first (orphans are
// harmless catalog entries), then a DRAFT PO, then lines, and only then the
// flip to 'ordered' — an empty or line-less order can never reach the
// packer's receiving screen.
async function importOrder(req, res, user, brandId) {
  const { supplier, shippingFee, notes, lines, markOrdered, importId } = req.body || {};
  if (!Array.isArray(lines) || lines.length === 0) {
    const e = new Error('lines required'); e.status = 400; throw e;
  }
  if (lines.length > IMPORT_LINES_MAX) {
    const e = new Error(`Too many lines — max ${IMPORT_LINES_MAX} per import`); e.status = 400; throw e;
  }
  const fee = parseFloat(shippingFee || 0) || 0;
  if (!Number.isFinite(fee) || fee < 0 || fee > PRICE_MAX) {
    const e = new Error(`shippingFee must be 0–${PRICE_MAX}`); e.status = 400; throw e;
  }

  // Validate + normalize every line BEFORE any write.
  const wants = lines.map((l, i) => {
    const qty = parseInt(l?.quantityOrdered, 10) || 0;
    if (qty < 1 || qty > LINE_QTY_MAX) {
      const e = new Error(`Line ${i + 1}: quantityOrdered must be 1–${LINE_QTY_MAX}`); e.status = 400; throw e;
    }
    const rawPrice = l?.unitWholesalePrice;
    const price = (rawPrice === undefined || rawPrice === null || rawPrice === '') ? null : parseFloat(rawPrice);
    if (price !== null && (!Number.isFinite(price) || price < 0 || price > PRICE_MAX)) {
      const e = new Error(`Line ${i + 1}: unitWholesalePrice must be 0–${PRICE_MAX}`); e.status = 400; throw e;
    }
    const create = l?.createSpecies || null;
    if (!l?.speciesId && !(create?.varietyId && String(create?.epithet || '').trim())) {
      const e = new Error(`Line ${i + 1}: speciesId or createSpecies{varietyId, epithet} required`); e.status = 400; throw e;
    }
    return { speciesId: l?.speciesId || null, create, qty, price };
  });

  const nowIso = new Date().toISOString();

  // Resolve species-to-create. An existing (variety, epithet) row is reused
  // — a sheet re-sent after a failed attempt must not 409.
  const needCreate = wants.filter(w => !w.speciesId);
  let createdSpeciesCount = 0;
  if (needCreate.length) {
    const varietyIds = [...new Set(needCreate.map(w => w.create.varietyId))];
    const { data: vrows, error: vErr } = await supabase
      .from('varieties').select('id').eq('brandId', brandId).in('id', varietyIds);
    if (vErr) { const e = new Error(vErr.message); e.status = 500; throw e; }
    const knownVarieties = new Set((vrows || []).map(v => v.id));
    const badVariety = varietyIds.find(v => !knownVarieties.has(v));
    if (badVariety) { const e = new Error('Unknown variety on a new-species line'); e.status = 400; throw e; }

    // Paginated: supabase-js silently caps selects at 1000 rows (recurring
    // project gotcha) — a truncated dedup map would mint duplicate epithets
    // and hit the unique index on every retry, hard-sticking the import.
    const fetchSpeciesByKey = async () => {
      const map = new Map();
      for (let from = 0; ; from += 1000) {
        const { data: page, error: exErr } = await supabase
          .from('species').select('id, "varietyId", epithet')
          .eq('brandId', brandId).in('varietyId', varietyIds)
          .range(from, from + 999);
        if (exErr) { const e = new Error(exErr.message); e.status = 500; throw e; }
        for (const s of page || []) {
          map.set(`${s.varietyId}:${String(s.epithet).trim().toLowerCase()}`, s.id);
        }
        if (!page || page.length < 1000) break;
      }
      return map;
    };

    // Two attempts: a concurrent import of the same sheet can create the
    // same epithets between our select and insert — the unique index fails
    // the batch (23505), and a fresh select resolves the winners' ids.
    for (let attempt = 0; attempt < 2; attempt++) {
      const speciesByKey = await fetchSpeciesByKey();
      const newSpeciesRows = [];
      for (const w of needCreate) {
        const epithet = String(w.create.epithet).trim().slice(0, 200);
        const key = `${w.create.varietyId}:${epithet.toLowerCase()}`;
        let sid = speciesByKey.get(key);
        if (!sid) {
          sid = newId();
          speciesByKey.set(key, sid);
          const wp = parseFloat(w.create.wholesalePrice);
          newSpeciesRows.push({
            id: sid,
            brandId,
            varietyId: w.create.varietyId,
            epithet,
            commonName: null,
            notes: null,
            imageUrl: null,
            wholesalePrice: Number.isFinite(wp) && wp >= 0 && wp <= PRICE_MAX ? wp : (w.price ?? null),
            idealSellingPrice: null,
            createdAt: nowIso,
            createdBy: user.displayName,
          });
        }
        w.speciesId = sid;
      }
      if (!newSpeciesRows.length) break;
      const { error: sErr } = await supabase.from('species').insert(newSpeciesRows);
      if (!sErr) { createdSpeciesCount = newSpeciesRows.length; break; }
      if (sErr.code === '23505' && attempt === 0) continue;
      const e = new Error(sErr.code === '23505'
        ? 'Another import is creating the same species right now — try again in a moment'
        : `Species create failed: ${sErr.message}`);
      e.status = sErr.code === '23505' ? 409 : 500;
      throw e;
    }
  }

  // Verify referenced species + pull wholesale prices for the null-price
  // fallback. Chunked: 500 ~20-char ids in one PostgREST `in` would push the
  // GET query string toward gateway URL limits.
  const allSpeciesIds = [...new Set(wants.map(w => w.speciesId))];
  const priceById = new Map();
  for (let i = 0; i < allSpeciesIds.length; i += 200) {
    const { data: spRows, error: spErr } = await supabase
      .from('species').select('id, "wholesalePrice"')
      .eq('brandId', brandId).in('id', allSpeciesIds.slice(i, i + 200));
    if (spErr) { const e = new Error(spErr.message); e.status = 500; throw e; }
    for (const s of spRows || []) priceById.set(s.id, s.wholesalePrice ?? 0);
  }
  const unknown = allSpeciesIds.find(sid => !priceById.has(sid));
  if (unknown) { const e = new Error('Unknown species on a line'); e.status = 400; throw e; }

  // Aggregate by species — purchase_order_lines is UNIQUE(purchaseOrderId,
  // speciesId), so duplicates sum quantity and keep the first explicit price.
  // The per-line qty cap must hold on the SUM too, or 500 duplicate rows at
  // the cap would fold into one multi-million-unit line.
  const bySpecies = new Map();
  for (const w of wants) {
    const agg = bySpecies.get(w.speciesId);
    if (agg) {
      agg.qty += w.qty;
      if (agg.price == null && w.price != null) agg.price = w.price;
    } else {
      bySpecies.set(w.speciesId, { qty: w.qty, price: w.price });
    }
  }
  for (const agg of bySpecies.values()) {
    if (agg.qty > LINE_QTY_MAX) {
      const e = new Error(`A species totals ${agg.qty} units across duplicate rows — max ${LINE_QTY_MAX} per species`);
      e.status = 400; throw e;
    }
  }

  // Idempotency: the client sends one importId per parsed sheet, used as the
  // PO id. A retry after a lost success response (dock Wi-Fi) re-sends the
  // same id — the primary key rejects the duplicate and we return the
  // already-imported order instead of minting a second one.
  const cleanImportId = typeof importId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(importId)
    ? importId : null;
  const po = {
    id: cleanImportId || newId(),
    brandId,
    supplier: String(supplier || '').slice(0, 500),
    status: 'draft',
    shippingFee: fee,
    notes: notes ? String(notes).slice(0, 500) : null,
    createdAt: nowIso,
    createdBy: user.displayName,
  };
  const { error: poErr } = await supabase.from('purchase_orders').insert(po);
  if (poErr) {
    if (poErr.code === '23505' && cleanImportId) {
      const { data: prior } = await supabase
        .from('purchase_orders').select('*').eq('id', cleanImportId).eq('brandId', brandId).maybeSingle();
      if (prior) {
        const { data: priorLines } = await supabase
          .from('purchase_order_lines').select('"quantityOrdered"')
          .eq('brandId', brandId).eq('purchaseOrderId', prior.id);
        return res.status(200).json({
          purchaseOrder: prior,
          lineCount: (priorLines || []).length,
          unitCount: (priorLines || []).reduce((s, l) => s + l.quantityOrdered, 0),
          createdSpeciesCount: 0,
          alreadyImported: true,
        });
      }
    }
    const e = new Error(poErr.message); e.status = 500; throw e;
  }

  const lineRows = [...bySpecies.entries()].map(([speciesId, agg], idx) => ({
    id: newId(),
    brandId,
    purchaseOrderId: po.id,
    speciesId,
    quantityOrdered: agg.qty,
    quantityReceived: 0,
    unitWholesalePrice: agg.price ?? priceById.get(speciesId) ?? 0,
    sortOrder: idx,
  }));
  const { error: lErr } = await supabase.from('purchase_order_lines').insert(lineRows);
  if (lErr) {
    // Leave nothing half-armed: a PO shell with no lines is deleted rather
    // than left for someone to trip over in Drafts.
    await supabase.from('purchase_orders').delete().eq('id', po.id).eq('brandId', brandId);
    const e = new Error(`Line insert failed: ${lErr.message}`); e.status = 500; throw e;
  }

  // The flip failing is NOT an import failure — a complete draft exists.
  // Throwing here made the client say "try again", and a retry would mint a
  // duplicate order (the draft is invisible to packer-role users). Report
  // success with a flag instead so the client can explain the draft.
  let markOrderedFailed = false;
  if (markOrdered) {
    const { error: oErr } = await supabase
      .from('purchase_orders')
      .update({ status: 'ordered', orderedAt: nowIso, modifiedAt: nowIso, modifiedBy: user.displayName })
      .eq('id', po.id)
      .eq('brandId', brandId);
    if (oErr) {
      markOrderedFailed = true;
    } else {
      po.status = 'ordered';
      po.orderedAt = nowIso;
    }
  }

  return res.status(200).json({
    purchaseOrder: po,
    lineCount: lineRows.length,
    unitCount: lineRows.reduce((s, l) => s + l.quantityOrdered, 0),
    createdSpeciesCount,
    ...(markOrderedFailed ? { markOrderedFailed: true } : {}),
  });
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
