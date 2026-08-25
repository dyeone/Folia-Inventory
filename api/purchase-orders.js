import { supabase, requireAdmin, requireBrand, brandIdFromReq, newId, DEFAULT_BRAND } from './_lib/supabase.js';
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
// Money ceiling for prices/fees on import-order — an absurd unit price
// (typo'd cell, wrong column) would flow straight into minted inventory
// grossCost and every financial report.
const PRICE_MAX = 100000;

// Per-PO item settings (migration 0038): how receive-line mints this
// order's items. Defaults preserve the original behavior (plant/available).
const ITEM_TYPES = new Set(['plant', 'tc']);
const ITEM_STATUSES = new Set(['available', 'acclimated']);
function itemSettingsPatch({ itemType, itemStatus, itemNotes }) {
  const patch = {};
  if (itemType !== undefined) {
    if (!ITEM_TYPES.has(itemType)) { const e = new Error("itemType must be 'plant' or 'tc'"); e.status = 400; throw e; }
    patch.itemType = itemType;
  }
  if (itemStatus !== undefined) {
    if (!ITEM_STATUSES.has(itemStatus)) { const e = new Error("itemStatus must be 'available' or 'acclimated'"); e.status = 400; throw e; }
    patch.itemStatus = itemStatus;
  }
  if (itemNotes !== undefined) patch.itemNotes = itemNotes ? String(itemNotes).slice(0, 500) : null;
  return patch;
}
// Clients only send item settings that differ from the defaults, so an
// un-migrated database keeps working until someone actually picks a
// non-default — then the error must say what to do, not just 500.
function withMigrationHint(err) {
  if (err && (err.code === 'PGRST204' || err.code === '42703')) {
    const e = new Error('Item settings need database migration 0038_po_item_settings — run it in the Supabase SQL editor first');
    e.status = 500;
    return e;
  }
  return null;
}

// The packing bench doesn't need to see what plants cost — cost fields are
// stripped from every response to non-admin callers (the packer UI hides
// them too, but the data shouldn't even reach the bench client).
const stripPoCosts = (po) => {
  if (!po) return po;
  const { shippingFee, ...rest } = po;
  return rest;
};
const stripLineCosts = (line) => {
  if (!line) return line;
  const { unitWholesalePrice, ...rest } = line;
  return rest;
};
const stripItemCosts = (item) => {
  const { grossCost, netCost, idealPrice, ...rest } = item;
  return rest;
};

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const { user, brandId } = await requireBrand(userId, brandIdFromReq(req));
  const isAdminUser = user.role === 'admin';

  if (req.method === 'GET') {
    const action = req.query?.action;
    if (action === 'get') return getOne(req, res, brandId, isAdminUser);
    return list(req, res, brandId, isAdminUser); // default GET
  }

  if (req.method === 'POST') {
    const action = req.body?.action;
    // The wholesale list is the ADMIN's to manage — every action that
    // creates or edits an order (including the spreadsheet import) requires
    // admin, the same server-side posture as DELETE /api/items. The packer's
    // side of receiving is count + label only, so receive-line and
    // cancel-receive-line stay open to any brand member: that IS their job.
    const ADMIN_ACTIONS = new Set([
      'create', 'update-header', 'add-line', 'update-line', 'remove-line', 'delete', 'mark-ordered',
      'import-order', 'update-order-lines', 'migrate-brand',
    ]);
    if (ADMIN_ACTIONS.has(action)) await requireAdmin(userId);
    switch (action) {
      case 'import-order':        return importOrder(req, res, user, brandId);
      case 'update-order-lines':  return updateOrderLines(req, res, user, brandId);
      case 'create':              return create(req, res, user, brandId);
      case 'update-header':       return updateHeader(req, res, user, brandId);
      case 'add-line':            return addLine(req, res, user, brandId);
      case 'update-line':         return updateLine(req, res, user, brandId);
      case 'remove-line':         return removeLine(req, res, user, brandId);
      case 'delete':              return softDelete(req, res, user, brandId);
      case 'mark-ordered':        return markOrdered(req, res, user, brandId);
      case 'receive-line':        return receiveLine(req, res, user, brandId, isAdminUser);
      case 'cancel-receive-line': return cancelReceiveLine(req, res, user, brandId, isAdminUser);
      case 'migrate-brand':       return migrateBrand(req, res, user, brandId);
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

async function list(req, res, brandId, isAdminUser) {
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
    ...(isAdminUser ? p : stripPoCosts(p)),
    lineCount: tally.get(p.id)?.lineCount || 0,
    unitCount: tally.get(p.id)?.unitCount || 0,
  }));
  return res.status(200).json({ purchaseOrders: out });
}

async function getOne(req, res, brandId, isAdminUser) {
  const po = await loadPo(req.query?.id, brandId);
  const lines = await fetchAllPoLines(po.id, brandId, '*');
  const lineIds = lines.map(l => l.id);
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
  if (isAdminUser) {
    return res.status(200).json({ purchaseOrder: po, lines: lines || [], receivedItems: received });
  }
  return res.status(200).json({
    purchaseOrder: stripPoCosts(po),
    lines: (lines || []).map(stripLineCosts),
    receivedItems: received,
  });
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
    ...itemSettingsPatch(req.body || {}),
    createdAt: new Date().toISOString(),
    createdBy: user.displayName,
  };
  const { error } = await supabase.from('purchase_orders').insert(row);
  if (error) { const e = withMigrationHint(error) || new Error(error.message); e.status = e.status || 500; throw e; }
  return res.status(200).json({ purchaseOrder: row });
}

// ─── shared import/update plumbing ──────────────────────────────────────────
// import-order and update-order-lines take the same lines wire shape; both
// funnel through these helpers so species creation, price fallbacks, and
// duplicate aggregation can't drift between the two.

// Validate + normalize every line BEFORE any write.
function validateLineWants(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    const e = new Error('lines required'); e.status = 400; throw e;
  }
  if (lines.length > IMPORT_LINES_MAX) {
    const e = new Error(`Too many lines — max ${IMPORT_LINES_MAX} per import`); e.status = 400; throw e;
  }
  return lines.map((l, i) => {
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
}

// Resolve species-to-create, mutating each want's speciesId in place. An
// existing (variety, epithet) row is reused — a sheet re-sent after a failed
// attempt must not 409. Returns how many species were actually created.
async function resolveSpeciesCreates(wants, brandId, user, nowIso) {
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
  return createdSpeciesCount;
}

// Verify referenced species + pull wholesale prices for the null-price
// fallback. Chunked: 500 ~20-char ids in one PostgREST `in` would push the
// GET query string toward gateway URL limits.
async function fetchSpeciesPrices(allSpeciesIds, brandId) {
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
  return priceById;
}

// Aggregate by species — purchase_order_lines is UNIQUE(purchaseOrderId,
// speciesId), so duplicates sum quantity and keep the first explicit price.
// The per-line qty cap must hold on the SUM too, or 500 duplicate rows at
// the cap would fold into one multi-million-unit line.
function aggregateWants(wants) {
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
  return bySpecies;
}

// All of a PO's lines, paginated past supabase-js's silent 1000-row select
// cap — a truncated read here would diff against (or flip on) a partial
// order. Realistic POs are far smaller, but repeated update sheets with
// disjoint species can grow one past any assumption.
async function fetchAllPoLines(poId, brandId, columns) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await supabase
      .from('purchase_order_lines')
      .select(columns)
      .eq('brandId', brandId)
      .eq('purchaseOrderId', poId)
      // id tiebreak: concurrent adds can mint duplicate sortOrders, and
      // offset pages over ties can drop/duplicate rows at boundaries.
      .order('sortOrder')
      .order('id')
      .range(from, from + 999);
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    out.push(...(page || []));
    if (!page || page.length < 1000) break;
  }
  return out;
}

// A line's price changed AFTER some of its plants were already received —
// restamp grossCost on exactly those items (found via the per-line
// receiving audit trail), so a price list that arrives after the cargo
// still lands on the inventory. ONLY the cost moves: sku, name, variety,
// type, status, lot — everything a printed label carries — stays untouched,
// so labels already on plants remain valid. netCost is a manually-set
// override elsewhere and is never written here. Shipping share uses the
// same live per-unit formula receiveLine uses.
// pricedByLineId: Map lineId → new unit price. Returns items restamped.
async function restampLineItemCosts(po, brandId, user, nowIso, pricedByLineId) {
  if (!pricedByLineId || !pricedByLineId.size) return 0;
  const allLines = await fetchAllPoLines(po.id, brandId, '"quantityOrdered"');
  const totalOrdered = allLines.reduce((s, l) => s + l.quantityOrdered, 0) || 1;
  const perUnitShipping = Math.round(((po.shippingFee || 0) / totalOrdered) * 10000) / 10000;

  // Audit rows for every candidate line, batched (a 500-line sheet must not
  // become 500 sequential reads) and paginated per batch (one line can have
  // hundreds of audit rows; a 200-line batch can pass the 1000-row cap).
  const lineIds = [...pricedByLineId.keys()];
  const itemsByLine = new Map();
  for (let i = 0; i < lineIds.length; i += 200) {
    const batchIds = lineIds.slice(i, i + 200);
    for (let from = 0; ; from += 1000) {
      const { data: page, error } = await supabase
        .from('purchase_order_received_items')
        .select('"lineId", "inventoryItemId"')
        .eq('brandId', brandId)
        .in('lineId', batchIds)
        .order('id')
        .range(from, from + 999);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      for (const a of page || []) {
        if (!itemsByLine.has(a.lineId)) itemsByLine.set(a.lineId, []);
        itemsByLine.get(a.lineId).push(a.inventoryItemId);
      }
      if (!page || page.length < 1000) break;
    }
  }

  // One update statement per ≤200 items of a line, run in parallel chunks —
  // same shape as bulk-price. The cost filter makes the restamp idempotent:
  // items already at the right cost aren't rewritten (no modifiedAt churn
  // on a re-uploaded sheet), and the returned rows count only real
  // corrections. NULL is matched explicitly — an admin can blank an item's
  // cost in the item form, and SQL NULL <> x would silently skip exactly
  // the items most in need of a cost. Soft-deleted items are deliberately
  // included: a restore from Recently Deleted should come back with the
  // corrected cost. Accepted tradeoffs (see PR): when the PO's totals
  // changed, a price-matching re-upload also re-normalizes every item's
  // shipping share (live-allocation rule); a receive minting mid-restamp
  // can keep the stale price until the next sheet re-upload converges it.
  const statements = [];
  for (const [lineId, price] of pricedByLineId) {
    const itemIds = itemsByLine.get(lineId) || [];
    const newCost = Number(price) + perUnitShipping;
    for (let i = 0; i < itemIds.length; i += 200) {
      statements.push({ ids: itemIds.slice(i, i + 200), newCost });
    }
  }
  let restamped = 0;
  for (let i = 0; i < statements.length; i += 20) {
    const results = await Promise.all(statements.slice(i, i + 20).map(s =>
      supabase
        .from('inventory_items')
        .update({ grossCost: s.newCost, modifiedAt: nowIso, modifiedBy: user.displayName })
        .eq('brandId', brandId)
        .in('id', s.ids)
        .or(`grossCost.is.null,grossCost.neq.${s.newCost}`)
        .select('id'),
    ));
    for (const r of results) {
      if (r.error) { const e = new Error(r.error.message); e.status = 500; throw e; }
      restamped += (r.data || []).length;
    }
  }
  return restamped;
}

// One line's received count, verified to belong to the PO — shared by the
// update-line and remove-line ordered-state guards.
async function loadLineReceived(lineId, poId, brandId) {
  const { data: line, error } = await supabase
    .from('purchase_order_lines')
    .select('"quantityReceived"')
    .eq('id', lineId).eq('purchaseOrderId', poId).eq('brandId', brandId)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!line) { const e = new Error('Line not found'); e.status = 404; throw e; }
  return line;
}

// Keep an ordered/received PO's status truthful to its lines, BOTH ways.
// Line edits can complete an order the same way a receive can (qty lowered
// to what arrived, the last short line removed) — but they can also UN-
// complete one (a line added or raised just as the last receive flips the
// PO). Without the reverse flip, those outstanding units vanish forever
// from the packer's ordered-only receiving list. Reads the CURRENT status
// (never the caller's possibly-stale snapshot) and writes with the status
// re-checked in the statement, so concurrent flips can't double-apply.
// Returns 'received', 'ordered' (un-flipped), or null (no change).
async function syncPoReceivedStatus(poId, brandId, user, nowIso) {
  const { data: po, error } = await supabase
    .from('purchase_orders')
    .select('id, status')
    .eq('id', poId).eq('brandId', brandId).is('deletedAt', null)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!po || (po.status !== 'ordered' && po.status !== 'received')) return null;
  const ls = await fetchAllPoLines(poId, brandId, '"quantityOrdered","quantityReceived"');
  const complete = ls.length > 0 && ls.every(l => l.quantityReceived >= l.quantityOrdered);
  if (po.status === 'ordered' && complete) {
    const { error: fErr } = await supabase
      .from('purchase_orders')
      .update({ status: 'received', receivedAt: nowIso, modifiedAt: nowIso, modifiedBy: user.displayName })
      .eq('id', poId).eq('brandId', brandId).eq('status', 'ordered');
    if (fErr) { const e = new Error(fErr.message); e.status = 500; throw e; }
    return 'received';
  }
  if (po.status === 'received' && ls.length && !complete) {
    const { error: uErr } = await supabase
      .from('purchase_orders')
      .update({ status: 'ordered', receivedAt: null, modifiedAt: nowIso, modifiedBy: user.displayName })
      .eq('id', poId).eq('brandId', brandId).eq('status', 'received');
    if (uErr) { const e = new Error(uErr.message); e.status = 500; throw e; }
    return 'ordered';
  }
  return null;
}

// One-request wholesale import: species + PO + every line land in a handful
// of batch statements instead of one request per row (a 50-row sheet used to
// be ~50 sequential add-line calls, each with its own loadPo overhead).
// Admin-only, like every other order-writing action. Write order is chosen
// so a mid-flight failure leaves nothing half-armed: species first (orphans
// are harmless catalog entries), then a DRAFT PO, then lines, and only then
// the flip to 'ordered' — an empty or line-less order can never reach the
// packer's receiving screen.
async function importOrder(req, res, user, brandId) {
  const { supplier, shippingFee, notes, lines, markOrdered, importId } = req.body || {};
  const wants = validateLineWants(lines);
  const fee = parseFloat(shippingFee || 0) || 0;
  if (!Number.isFinite(fee) || fee < 0 || fee > PRICE_MAX) {
    const e = new Error(`shippingFee must be 0–${PRICE_MAX}`); e.status = 400; throw e;
  }

  const nowIso = new Date().toISOString();
  const createdSpeciesCount = await resolveSpeciesCreates(wants, brandId, user, nowIso);
  const priceById = await fetchSpeciesPrices([...new Set(wants.map(w => w.speciesId))], brandId);
  const bySpecies = aggregateWants(wants);

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
    ...itemSettingsPatch(req.body || {}),
    createdAt: nowIso,
    createdBy: user.displayName,
  };
  const { error: poErr } = await supabase.from('purchase_orders').insert(po);
  if (poErr) {
    const hint = withMigrationHint(poErr);
    if (hint) throw hint;
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

// Re-sync an EXISTING order to a revised supplier list. Same lines wire
// shape as import-order; the diff against current lines happens here so
// received work is never destroyed:
//   - species already on the order   → quantity/price updated (quantity
//     never drops below what's been received — clamped and reported)
//   - species not on the order       → new line appended (species created
//     on the fly, same as import)
//   - lines missing from the list    → kept unless removeMissing is set,
//     and even then only lines with nothing received are deleted
// Write order: adds → updates → removes, so a mid-flight failure can lose
// at most the tail (re-applying the same sheet converges — every step is
// state-based, not delta-based).
async function updateOrderLines(req, res, user, brandId) {
  const { id, lines, removeMissing } = req.body || {};
  const po = await loadPo(id, brandId);
  requireStatus(po, ['draft', 'ordered']);
  const wants = validateLineWants(lines);

  const nowIso = new Date().toISOString();
  const createdSpeciesCount = await resolveSpeciesCreates(wants, brandId, user, nowIso);
  const priceById = await fetchSpeciesPrices([...new Set(wants.map(w => w.speciesId))], brandId);
  const bySpecies = aggregateWants(wants);

  const existing = await fetchAllPoLines(id, brandId, '*');
  const lineBySpecies = new Map(existing.map(l => [l.speciesId, l]));

  const toInsert = [];
  const toUpdate = []; // { lineId, patch }
  // Lines whose sheet price EQUALS the line price — no line write needed,
  // but their received items may still carry a stale cost (restamped below).
  const samePriceByLineId = new Map();
  let unchangedCount = 0;
  let clampedCount = 0;
  let nextSort = (existing || []).reduce((m, l) => Math.max(m, l.sortOrder + 1), 0);
  for (const [speciesId, agg] of bySpecies) {
    const line = lineBySpecies.get(speciesId);
    if (!line) {
      toInsert.push({
        id: newId(),
        brandId,
        purchaseOrderId: id,
        speciesId,
        quantityOrdered: agg.qty,
        quantityReceived: 0,
        unitWholesalePrice: agg.price ?? priceById.get(speciesId) ?? 0,
        sortOrder: nextSort++,
      });
      continue;
    }
    let qty = agg.qty;
    if (qty < line.quantityReceived) { qty = line.quantityReceived; clampedCount += 1; }
    const patch = {};
    if (qty !== line.quantityOrdered) patch.quantityOrdered = qty;
    // A sheet with no price column leaves existing prices alone — only an
    // explicit price cell overwrites what's on the line.
    if (agg.price != null && Number(agg.price) !== Number(line.unitWholesalePrice)) {
      patch.unitWholesalePrice = agg.price;
    } else if (agg.price != null) {
      // Price already matches the line, but its RECEIVED items may predate
      // it (list updated after the cargo) — still a restamp candidate; the
      // item write is idempotent, so this is free when nothing is wrong.
      samePriceByLineId.set(line.id, agg.price);
    }
    if (Object.keys(patch).length) toUpdate.push({ lineId: line.id, patch });
    else unchangedCount += 1;
  }

  const missing = (existing || []).filter(l => !bySpecies.has(l.speciesId));

  if (toInsert.length) {
    const { error } = await supabase.from('purchase_order_lines').insert(toInsert);
    if (error) {
      // 23505 = a concurrent add-line/apply created one of these (PO,
      // species) rows between our read and this insert. The row now EXISTS,
      // so re-applying the same sheet classifies it as an update — converge
      // with a clear 409 instead of a raw 500.
      const e = new Error(error.code === '23505'
        ? 'Another edit added one of these species just now — re-upload the same sheet to converge'
        : `Line insert failed: ${error.message}`);
      e.status = error.code === '23505' ? 409 : 500;
      throw e;
    }
  }
  // Each patch differs, so updates can't batch into one statement — chunked
  // parallel keeps a big revision inside the function timeout. Quantity
  // patches carry the received guard IN the statement (like the delete
  // below): a packer receive landing between our select and this write must
  // not leave quantityOrdered below quantityReceived. A row skipped by the
  // guard simply stays put — re-applying the same sheet converges.
  let updatedCount = 0;
  // Price changes that actually landed → their already-received items get
  // their grossCost restamped below (the price list often arrives after
  // the cargo). Only landed writes qualify — a guard-skipped row kept its
  // old price, so its items keep their old cost.
  const pricedByLineId = new Map();
  for (let i = 0; i < toUpdate.length; i += 20) {
    const batch = toUpdate.slice(i, i + 20);
    const results = await Promise.all(batch.map(u => {
      let q = supabase.from('purchase_order_lines')
        .update(u.patch).eq('id', u.lineId).eq('purchaseOrderId', id).eq('brandId', brandId);
      if (u.patch.quantityOrdered !== undefined) q = q.lte('quantityReceived', u.patch.quantityOrdered);
      return q.select('id');
    }));
    results.forEach((r, j) => {
      if (r.error) { const e = new Error(`Line update failed: ${r.error.message}`); e.status = 500; throw e; }
      if ((r.data || []).length) {
        updatedCount += 1;
        if (batch[j].patch.unitWholesalePrice !== undefined) {
          pricedByLineId.set(batch[j].lineId, batch[j].patch.unitWholesalePrice);
        }
      }
    });
  }
  let removedCount = 0;
  const removedIds = new Set();
  if (removeMissing && missing.length) {
    // Two guards on the delete. (1) quantityReceived = 0 lives IN the
    // statement — a packer can receive between our select and this write.
    // (2) No audit rows may exist: a receive in flight writes its audit
    // rows BEFORE bumping the line counter, and the audit FK cascades on
    // line delete — deleting in that window would orphan freshly minted
    // SKUs from their audit trail (invisible to cancel-receive forever).
    // A sub-ms residual race remains; the real fix is an RPC.
    const candidateIds = missing.map(l => l.id);
    const audited = new Set();
    for (let i = 0; i < candidateIds.length; i += 200) {
      const { data: aRows, error: aErr } = await supabase
        .from('purchase_order_received_items')
        .select('"lineId"')
        .eq('brandId', brandId)
        .in('lineId', candidateIds.slice(i, i + 200));
      if (aErr) { const e = new Error(aErr.message); e.status = 500; throw e; }
      for (const a of aRows || []) audited.add(a.lineId);
    }
    const deletable = candidateIds.filter(cid => !audited.has(cid));
    // Chunked: delete filters travel in the query string, and a big enough
    // id list would hit gateway URL limits (same reason the reads chunk).
    for (let i = 0; i < deletable.length; i += 200) {
      const { data: removed, error } = await supabase
        .from('purchase_order_lines')
        .delete()
        .eq('brandId', brandId)
        .eq('purchaseOrderId', id)
        .in('id', deletable.slice(i, i + 200))
        .eq('quantityReceived', 0)
        .select('id');
      if (error) { const e = new Error(`Line remove failed: ${error.message}`); e.status = 500; throw e; }
      removedCount += (removed || []).length;
      for (const r of removed || []) removedIds.add(r.id);
    }
  }
  // Kept = what actually survived the guarded delete, not the pre-delete
  // snapshot — a line received mid-flight is skipped by the guard and must
  // show up as kept, or the summary's counts stop adding up.
  const keptMissingSpeciesIds = removeMissing
    ? missing.filter(l => !removedIds.has(l.id)).map(l => l.speciesId)
    : missing.map(l => l.speciesId);

  const { error: stampErr } = await supabase.from('purchase_orders')
    .update({ modifiedAt: nowIso, modifiedBy: user.displayName })
    .eq('id', id).eq('brandId', brandId);
  if (stampErr) { const e = new Error(stampErr.message); e.status = 500; throw e; }

  // Re-cost the already-received plants of every line the sheet priced —
  // both changed prices and matching ones (items minted before the price
  // landed are the whole point). Drafts can't have received anything.
  for (const [lid, p] of samePriceByLineId) {
    if (!pricedByLineId.has(lid)) pricedByLineId.set(lid, p);
  }
  const restampedItemCount = po.status !== 'draft'
    ? await restampLineItemCosts(po, brandId, user, nowIso, pricedByLineId)
    : 0;

  // Lowering quantities to what arrived can complete the order; adding or
  // raising lines mid-flip can un-complete it — sync both directions.
  const poFlippedToReceived = (await syncPoReceivedStatus(id, brandId, user, nowIso)) === 'received';

  return res.status(200).json({
    purchaseOrder: { ...po, ...(poFlippedToReceived ? { status: 'received', receivedAt: nowIso } : {}) },
    addedCount: toInsert.length,
    updatedCount,
    unchangedCount,
    removedCount,
    keptMissingSpeciesIds,
    clampedCount,
    createdSpeciesCount,
    restampedItemCount,
    poFlippedToReceived,
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
  Object.assign(patch, itemSettingsPatch(req.body || {}));
  // Cross-field rule: 'acclimated' only exists for TC. Normalizing on the
  // EFFECTIVE type stops interleaved admin edits stranding acclimated on a
  // plant PO (and a later plant→tc flip silently resurrecting it).
  const effectiveType = patch.itemType ?? po.itemType ?? 'plant';
  if (effectiveType !== 'tc' && (patch.itemStatus === 'acclimated' || (patch.itemType && po.itemStatus === 'acclimated'))) {
    patch.itemStatus = 'available';
  }
  // Changing how items mint mid-receive splits one physical shipment into
  // mixed types/statuses — freeze the settings once anything is received.
  if ((patch.itemType !== undefined || patch.itemStatus !== undefined) && po.status === 'ordered') {
    const { data: recv } = await supabase
      .from('purchase_order_lines')
      .select('"quantityReceived"')
      .eq('brandId', brandId)
      .eq('purchaseOrderId', id)
      .gt('quantityReceived', 0)
      .limit(1);
    if (recv && recv.length) {
      const e = new Error('Item settings are locked — this order already has received items (use Start over on the lines first)');
      e.status = 409; throw e;
    }
  }
  const { error } = await supabase.from('purchase_orders').update(patch).eq('id', id).eq('brandId', brandId);
  if (error) { const e = withMigrationHint(error) || new Error(error.message); e.status = e.status || 500; throw e; }
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

async function addLine(req, res, user, brandId) {
  const { id, speciesId, quantityOrdered, unitWholesalePrice } = req.body || {};
  const po = await loadPo(id, brandId);
  // 'ordered' too: suppliers revise orders after they're placed — the new
  // line simply shows up on the packer's receiving screen with the rest.
  requireStatus(po, ['draft', 'ordered']);
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
  if (!Number.isFinite(price) || price < 0 || price > PRICE_MAX) {
    const e = new Error(`unitWholesalePrice must be 0–${PRICE_MAX}`); e.status = 400; throw e;
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
    // The per-call cap must hold on the accumulated line too — repeated adds
    // of the same species (double-taps, retries) otherwise grow one line
    // past the same ceiling aggregateWants enforces for sheet uploads.
    const total = existing.quantityOrdered + qty;
    if (total > LINE_QTY_MAX) {
      const e = new Error(`This line would total ${total} units — max ${LINE_QTY_MAX} per species`);
      e.status = 400; throw e;
    }
    const next = { quantityOrdered: total };
    const { error } = await supabase
      .from('purchase_order_lines').update(next).eq('id', existing.id).eq('brandId', brandId);
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    // Raising a line can un-complete a PO that flipped received mid-request
    // — without the reverse sync the new units never reach the packer list.
    // Drafts can't be received, so they skip the extra reads.
    if (po.status === 'ordered') await syncPoReceivedStatus(id, brandId, user, new Date().toISOString());
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
  // Same reverse-sync as the bump path: a fresh 0/N line on a PO that just
  // flipped received must pull it back to 'ordered'.
  if (po.status === 'ordered') await syncPoReceivedStatus(id, brandId, user, new Date().toISOString());
  return res.status(200).json({ line: row });
}

async function updateLine(req, res, user, brandId) {
  const { id, lineId, quantityOrdered, unitWholesalePrice, itemType } = req.body || {};
  const po = await loadPo(id, brandId);
  requireStatus(po, ['draft', 'ordered']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }

  const patch = {};
  if (itemType !== undefined) {
    // Per-line arrives-as override (0039). null = back to the PO default.
    // Only before anything is received: a mid-count flip would split one
    // physical shipment into mixed types (same freeze rule as the header).
    if (itemType !== null && !ITEM_TYPES.has(itemType)) {
      const e = new Error("itemType must be 'plant', 'tc', or null"); e.status = 400; throw e;
    }
    const line = await loadLineReceived(lineId, id, brandId);
    if (line.quantityReceived > 0) {
      const e = new Error('This line already has received items — its type is locked (use Cancel receive first)');
      e.status = 409; throw e;
    }
    patch.itemType = itemType;
  }
  if (quantityOrdered !== undefined) {
    const n = parseInt(quantityOrdered, 10);
    if (!Number.isFinite(n) || n <= 0) {
      const e = new Error('quantityOrdered must be > 0 (use remove-line to drop a line)'); e.status = 400; throw e;
    }
    if (n > LINE_QTY_MAX) {
      const e = new Error(`quantityOrdered must be ≤ ${LINE_QTY_MAX}`); e.status = 400; throw e;
    }
    patch.quantityOrdered = n;
  }
  if (unitWholesalePrice !== undefined) {
    const n = parseFloat(unitWholesalePrice);
    // PRICE_MAX matters more here than on the sheet path: an ordered PO's
    // line price flows straight into minted-item grossCost at receive time.
    if (!Number.isFinite(n) || n < 0 || n > PRICE_MAX) {
      const e = new Error(`unitWholesalePrice must be 0–${PRICE_MAX}`); e.status = 400; throw e;
    }
    patch.unitWholesalePrice = n;
  }
  if (Object.keys(patch).length === 0) {
    const e = new Error('No fields to update'); e.status = 400; throw e;
  }

  // On an ordered PO the received count is physical reality — the ordered
  // quantity can't be edited below it (cancel the receive first).
  const guardQty = po.status === 'ordered' && patch.quantityOrdered !== undefined;
  if (guardQty) {
    const line = await loadLineReceived(lineId, id, brandId);
    if (patch.quantityOrdered < line.quantityReceived) {
      const e = new Error(`${line.quantityReceived} already received on this line — quantity can't go below that (use Cancel receive first)`);
      e.status = 409; throw e;
    }
  }

  // The guard is re-checked IN the update (like remove-line's delete): a
  // receive can land between the check above and this write.
  let q = supabase
    .from('purchase_order_lines').update(patch).eq('id', lineId).eq('purchaseOrderId', id).eq('brandId', brandId);
  if (guardQty) q = q.lte('quantityReceived', patch.quantityOrdered);
  const { data: written, error } = await q.select('id');
  if (error) {
    // Missing itemType column = un-migrated database; say what to run.
    const e = (patch.itemType !== undefined && (error.code === 'PGRST204' || error.code === '42703'))
      ? Object.assign(new Error('Per-line item type needs database migration 0039_line_item_type — run it in the Supabase SQL editor first'), { status: 500 })
      : Object.assign(new Error(error.message), { status: 500 });
    throw e;
  }
  if (!written || !written.length) {
    // Zero rows = the guard rejected it (guardQty) OR the lineId isn't on
    // this PO at all. The distinction matters beyond the message: the
    // restamp below keys on lineId alone, so proceeding on an unlanded
    // write could re-cost a DIFFERENT PO's items with this PO's shipping
    // share (cancel-receive defends the same id-pairing attack).
    const e = new Error(guardQty
      ? 'Line was just received against — refresh and try again'
      : 'Line not found on this purchase order');
    e.status = guardQty ? 409 : 404; throw e;
  }
  const nowIso = new Date().toISOString();
  // A price edit re-costs the plants this line already minted — the price
  // list often arrives after the cargo. Drafts can't have received items.
  // Only reached when the line write LANDED (checked above).
  let restampedCount = 0;
  if (patch.unitWholesalePrice !== undefined && po.status !== 'draft') {
    restampedCount = await restampLineItemCosts(po, brandId, user, nowIso, new Map([[lineId, patch.unitWholesalePrice]]));
  }
  // Lowering the quantity to what's already received can complete the order
  // (and raising one mid-flip can un-complete it) — a price-only patch can't
  // do either, so skip the extra lines read.
  const poFlippedToReceived = patch.quantityOrdered !== undefined
    ? (await syncPoReceivedStatus(id, brandId, user, nowIso)) === 'received'
    : false;
  return res.status(200).json({ ok: true, poFlippedToReceived, restampedCount });
}

async function removeLine(req, res, user, brandId) {
  const { id, lineId } = req.body || {};
  const po = await loadPo(id, brandId);
  requireStatus(po, ['draft', 'ordered']);
  if (!lineId) { const e = new Error('lineId required'); e.status = 400; throw e; }
  if (po.status === 'ordered') {
    const line = await loadLineReceived(lineId, id, brandId);
    if (line.quantityReceived > 0) {
      const e = new Error('This line has received items — use Cancel receive first, then remove it');
      e.status = 409; throw e;
    }
    // Audit rows with a zero counter = a receive in flight (audits land
    // before the counter bumps) or a stranded receive — either way the
    // cascade on delete would orphan minted SKUs from their audit trail.
    const { count: auditCount, error: acErr } = await supabase
      .from('purchase_order_received_items')
      .select('id', { count: 'exact', head: true })
      .eq('brandId', brandId)
      .eq('lineId', lineId);
    if (acErr) { const e = new Error(acErr.message); e.status = 500; throw e; }
    if ((auditCount || 0) > 0) {
      const e = new Error('A receive against this line is in flight — try again in a moment');
      e.status = 409; throw e;
    }
    // An ordered PO must keep at least one line — a line-less order on the
    // packer's receiving screen is the invariant import-order dies to avoid.
    const { count, error: cErr } = await supabase
      .from('purchase_order_lines')
      .select('id', { count: 'exact', head: true })
      .eq('brandId', brandId)
      .eq('purchaseOrderId', id);
    if (cErr) { const e = new Error(cErr.message); e.status = 500; throw e; }
    if ((count || 0) <= 1) {
      const e = new Error("Can't remove the only line of an ordered PO — delete the order or add another line first");
      e.status = 409; throw e;
    }
  }
  // The received guard is re-checked IN the delete: a packer can receive
  // against this line between the check above and this statement, and a
  // received line must never silently vanish.
  const { data: removed, error } = await supabase
    .from('purchase_order_lines')
    .delete()
    .eq('id', lineId).eq('purchaseOrderId', id).eq('brandId', brandId)
    .eq('quantityReceived', 0)
    .select('id');
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (po.status === 'ordered' && (!removed || !removed.length)) {
    const e = new Error('Line was just received against — refresh and try again');
    e.status = 409; throw e;
  }
  // Removing the last incomplete line can complete the order.
  const poFlippedToReceived = (await syncPoReceivedStatus(id, brandId, user, new Date().toISOString())) === 'received';
  return res.status(200).json({ ok: true, poFlippedToReceived });
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
async function receiveLine(req, res, user, brandId, isAdminUser) {
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

  // Allocate shipping per unit across ALL lines on this PO. Known tradeoff
  // since ordered POs became editable: the split uses the CURRENT total, so
  // line edits mid-receiving shift the per-unit share between earlier and
  // later receives (a removed no-show line strands its share). Exact
  // allocation would need a snapshot at mark-ordered time.
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

  // Per-PO item settings (0038) with the per-LINE override (0039) on top;
  // 'acclimated' only means anything for TC; absent columns (un-migrated
  // DB) fall back to the original behavior.
  const mintType = (line.itemType ?? po.itemType) === 'tc' ? 'tc' : 'plant';
  const mintStatus = po.itemStatus === 'acclimated' && mintType === 'tc' ? 'acclimated' : 'available';
  const mintNotes = po.itemNotes ? String(po.itemNotes).slice(0, 500) : null;

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
        type: mintType,
        name: species.epithet,
        variety: variety?.name || null,
        speciesId: species.id,
        quantity: 1,
        grossCost: Number(line.unitWholesalePrice) + perUnitShipping,
        idealPrice: species.idealSellingPrice ?? null,
        status: mintStatus,
        lotKind: 'sale',
        source: supplierLabel,
        acquiredAt: todayDate,
        notes: mintNotes,
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

  const lineOut = { ...line, quantityReceived: newReceived };
  return res.status(200).json({
    line: isAdminUser ? lineOut : stripLineCosts(lineOut),
    createdInventoryItemIds: createdItems.map(it => it.id),
    // Full rows so the packer's receiving pane can print labels for exactly
    // the SKUs this call minted, without a follow-up items fetch. Labels
    // need sku/name/variety — never costs, which non-admins don't get.
    createdItems: isAdminUser ? createdItems : createdItems.map(stripItemCosts),
    poFlippedToReceived: allDone,
  });
}

async function cancelReceiveLine(req, res, user, brandId, isAdminUser) {
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
  // 'acclimated' is a mint-time status too (TC POs, 0038) — items sitting
  // on the bench in either state are equally un-moved and cancellable.
  // Items claimed by a sale lineup (saleId set — e.g. a TikTok live loaded
  // this PO's TC) HAVE moved: cancelling them out from under an exported
  // listing would silently oversell, so they're skipped like sold ones.
  const { data: deleted, error: dErr } = await supabase
    .from('inventory_items')
    .update({ deletedAt: nowIso, deletedBy: user.displayName })
    .eq('brandId', brandId)
    .in('id', itemIds)
    .in('status', ['available', 'acclimated'])
    .is('saleId', null)
    .is('deletedAt', null)
    .select('id');
  if (dErr) { const e = new Error(dErr.message); e.status = 500; throw e; }
  const cancelIds = (deleted || []).map(d => d.id);
  if (cancelIds.length === 0) {
    const e = new Error('Nothing to cancel — every SKU from this line has already moved past its received state');
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

  // Sync from CURRENT state, not the entry snapshot — an admin edit's flip
  // landing mid-cancel used to strand the PO at 'received' with an
  // incomplete line, hidden from the packer's ordered-only list.
  await syncPoReceivedStatus(id, brandId, user, nowIso);

  return res.status(200).json({
    deletedCount: cancelIds.length,
    line: isAdminUser ? line : stripLineCosts(line),
  });
}

// ─── migrate to another brand ───────────────────────────────────────────────
// Moves a draft/ordered PO — header, every line, AND everything already
// received off it — into another brand the admin can access. Species and
// varieties are per-brand, so each line's (and item's) species is re-pointed
// at the target brand's row with the same (variety name, epithet), created
// there when missing — the same copy-don't-move taxonomy posture as
// migration 0031.
//
// Received items move AS-IS: sku, name, variety text, costs, status all
// untouched, because the SKUs are already printed on labels stuck to plants.
// That only works if every moving SKU is free in the target brand —
// (brandId, sku) is unique — so a collision refuses the whole migration
// up front. Moving the items also raises the target's max SKU suffix, so
// future mints there number PAST the migrated labels instead of into them.
// Items that progressed beyond the bench (sold, boxed, claimed by a live)
// are tied to the source brand's sales/boxes and block the migration.
//
// PostgREST gives us no cross-table transaction, so writes are ordered to
// fail safe: catalog creates first (additive), then items + their photos +
// the receiving audit trail, then lines, then the PO header flip LAST — the
// PO only surfaces in the target brand once everything under it has moved.
// Reads and writes match by PO/line/item ids (globally unique), NOT brandId,
// so a run that died mid-move converges when the admin retries; a
// post-flip sweep converges receives that landed while the move was in
// flight.
async function migrateBrand(req, res, user, brandId) {
  const { id } = req.body || {};
  const target = typeof req.body?.targetBrandId === 'string' ? req.body.targetBrandId.trim() : '';
  if (!target) { const e = new Error('targetBrandId required'); e.status = 400; throw e; }
  if (target === brandId) { const e = new Error('This PO is already in that brand'); e.status = 400; throw e; }

  // Destination gets the same access posture requireBrand gives the source:
  // a real brands row the caller is allowed into.
  const access = Array.isArray(user.brandIds) && user.brandIds.length ? user.brandIds : [DEFAULT_BRAND];
  if (!access.includes(target)) { const e = new Error('No access to the target brand'); e.status = 403; throw e; }
  const { data: targetBrand, error: tbErr } = await supabase
    .from('brands').select('id').eq('id', target).maybeSingle();
  if (tbErr) { const e = new Error(tbErr.message); e.status = 500; throw e; }
  if (!targetBrand) { const e = new Error('Unknown target brand'); e.status = 404; throw e; }

  const po = await loadPo(id, brandId);
  requireStatus(po, ['draft', 'ordered']);

  // Every line by PO id only — a prior attempt may have moved some already.
  const lines = [];
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await supabase
      .from('purchase_order_lines')
      .select('*')
      .eq('purchaseOrderId', id)
      .order('id')
      .range(from, from + 999);
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    lines.push(...(page || []));
    if (!page || page.length < 1000) break;
  }

  const lineIds = lines.map(l => l.id);

  // Everything received so far, via the audit trail — these move with the
  // PO, SKUs untouched (labels are already on the plants).
  const auditRows = [];
  for (let i = 0; i < lineIds.length; i += 200) {
    const { data: rows, error } = await supabase
      .from('purchase_order_received_items')
      .select('id, "lineId", "inventoryItemId"')
      .in('lineId', lineIds.slice(i, i + 200));
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    auditRows.push(...(rows || []));
  }
  const itemIds = [...new Set(auditRows.map(a => a.inventoryItemId))];
  const items = [];
  for (let i = 0; i < itemIds.length; i += 200) {
    const { data: rows, error } = await supabase
      .from('inventory_items')
      .select('id, "brandId", sku, "speciesId", status, "saleId", "shipmentBoxId"')
      .in('id', itemIds.slice(i, i + 200));
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    items.push(...(rows || []));
  }
  const movingItems = items.filter(it => it.brandId !== target);

  // Items that moved past the bench are woven into THIS brand's sales,
  // boxes, and live lineups — stock that's already selling can't change
  // hands without corrupting those records.
  const entangled = movingItems.filter(it =>
    it.saleId != null || it.shipmentBoxId != null || !['available', 'acclimated'].includes(it.status));
  if (entangled.length) {
    const e = new Error(`${entangled.length} received item${entangled.length === 1 ? ' is' : 's are'} already sold, packed into a box, or claimed by a live — they're tied to this brand's records, so this PO can't migrate.`);
    e.status = 409; throw e;
  }

  // SKUs move verbatim, so every one must be free in the target brand.
  const movingSkus = movingItems.map(it => it.sku).filter(Boolean);
  const takenSkus = [];
  for (let i = 0; i < movingSkus.length; i += 200) {
    const { data: rows, error } = await supabase
      .from('inventory_items')
      .select('sku')
      .eq('brandId', target)
      .in('sku', movingSkus.slice(i, i + 200));
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    takenSkus.push(...(rows || []).map(r => r.sku));
  }
  if (takenSkus.length) {
    const e = new Error(`${takenSkus.length} SKU${takenSkus.length === 1 ? ' is' : 's are'} already in use in the target brand (${takenSkus.slice(0, 5).join(', ')}${takenSkus.length > 5 ? '…' : ''}) — the printed labels can't be kept, so this PO can't migrate there.`);
    e.status = 409; throw e;
  }

  const nowIso = new Date().toISOString();

  // Source species by id WITHOUT a brand filter: on a retry, already-moved
  // lines point at target-brand species and simply map to themselves. Items
  // are included in the union — an item can lag its line's species after an
  // update-from-list revision swapped the line.
  const speciesIds = [...new Set([
    ...lines.map(l => l.speciesId),
    ...movingItems.map(it => it.speciesId).filter(Boolean),
  ])];
  const srcSpeciesById = new Map();
  for (let i = 0; i < speciesIds.length; i += 200) {
    const { data: rows, error } = await supabase
      .from('species')
      .select('id, "brandId", "varietyId", epithet, "commonName", notes, "imageUrl", "wholesalePrice", "idealSellingPrice", "profitRate"')
      .in('id', speciesIds.slice(i, i + 200));
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    for (const s of rows || []) srcSpeciesById.set(s.id, s);
  }
  if (speciesIds.some(sid => !srcSpeciesById.has(sid))) {
    const e = new Error('A line references a missing species'); e.status = 500; throw e;
  }
  const toMap = speciesIds.map(sid => srcSpeciesById.get(sid)).filter(s => s.brandId !== target);

  // Map the varieties those species hang off: match by NAME in the target
  // brand (per-brand unique since 0031), create the missing ones with the
  // same name + SKU-prefix code. Two attempts — a concurrent create of the
  // same name fails the batch (23505) and a fresh select resolves winners.
  const srcVarietyIds = [...new Set(toMap.map(s => s.varietyId))];
  const srcVarietyById = new Map();
  const targetVarietyByName = new Map();
  let createdVarieties = 0;
  if (srcVarietyIds.length) {
    for (let i = 0; i < srcVarietyIds.length; i += 200) {
      const { data: rows, error } = await supabase
        .from('varieties').select('id, name, code, "profitRate"')
        .in('id', srcVarietyIds.slice(i, i + 200));
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      for (const v of rows || []) srcVarietyById.set(v.id, v);
    }
    if (srcVarietyIds.some(vid => !srcVarietyById.has(vid))) {
      const e = new Error('A species references a missing variety'); e.status = 500; throw e;
    }
    const names = [...new Set([...srcVarietyById.values()].map(v => v.name))];
    for (let attempt = 0; attempt < 2; attempt++) {
      targetVarietyByName.clear();
      for (let i = 0; i < names.length; i += 200) {
        const { data: rows, error } = await supabase
          .from('varieties').select('id, name')
          .eq('brandId', target).in('name', names.slice(i, i + 200));
        if (error) { const e = new Error(error.message); e.status = 500; throw e; }
        for (const v of rows || []) targetVarietyByName.set(v.name, v.id);
      }
      const newRows = [];
      for (const v of srcVarietyById.values()) {
        if (targetVarietyByName.has(v.name)) continue;
        const vid = newId();
        targetVarietyByName.set(v.name, vid);
        newRows.push({ id: vid, brandId: target, name: v.name, code: v.code, profitRate: v.profitRate ?? null, createdBy: user.displayName });
      }
      if (!newRows.length) break;
      const { error: insErr } = await supabase.from('varieties').insert(newRows);
      if (!insErr) { createdVarieties = newRows.length; break; }
      if (insErr.code === '23505' && attempt === 0) continue;
      const e = new Error(`Variety create failed: ${insErr.message}`); e.status = 500; throw e;
    }
  }

  // Map species into the target by (mapped variety, epithet) — same
  // case-insensitive dedup key and 23505 retry as the import's
  // resolveSpeciesCreates, and the same paginated read past the silent
  // 1000-row select cap.
  const speciesIdMap = new Map(
    speciesIds.filter(sid => srcSpeciesById.get(sid).brandId === target).map(sid => [sid, sid]),
  );
  let createdSpecies = 0;
  if (toMap.length) {
    const targetVarietyIds = [...new Set(toMap.map(s => targetVarietyByName.get(srcVarietyById.get(s.varietyId).name)))];
    for (let attempt = 0; attempt < 2; attempt++) {
      const byKey = new Map();
      for (let from = 0; ; from += 1000) {
        const { data: page, error } = await supabase
          .from('species').select('id, "varietyId", epithet')
          .eq('brandId', target).in('varietyId', targetVarietyIds)
          .range(from, from + 999);
        if (error) { const e = new Error(error.message); e.status = 500; throw e; }
        for (const s of page || []) byKey.set(`${s.varietyId}:${String(s.epithet).trim().toLowerCase()}`, s.id);
        if (!page || page.length < 1000) break;
      }
      const newRows = [];
      for (const s of toMap) {
        const tvId = targetVarietyByName.get(srcVarietyById.get(s.varietyId).name);
        const key = `${tvId}:${String(s.epithet).trim().toLowerCase()}`;
        let tid = byKey.get(key);
        if (!tid) {
          tid = newId();
          byKey.set(key, tid);
          newRows.push({
            id: tid,
            brandId: target,
            varietyId: tvId,
            epithet: s.epithet,
            commonName: s.commonName ?? null,
            notes: s.notes ?? null,
            imageUrl: s.imageUrl ?? null,
            wholesalePrice: s.wholesalePrice ?? null,
            idealSellingPrice: s.idealSellingPrice ?? null,
            profitRate: s.profitRate ?? null,
            createdAt: nowIso,
            createdBy: user.displayName,
          });
        }
        speciesIdMap.set(s.id, tid);
      }
      if (!newRows.length) break;
      const { error: insErr } = await supabase.from('species').insert(newRows);
      if (!insErr) { createdSpecies = newRows.length; break; }
      if (insErr.code === '23505' && attempt === 0) continue;
      const e = new Error(`Species create failed: ${insErr.message}`); e.status = 500; throw e;
    }
  }

  // Lines are UNIQUE(purchaseOrderId, speciesId) — two source species that
  // collapse onto one target row (case-variant epithets) would collide.
  const targetOwner = new Map();
  for (const [src, tgt] of speciesIdMap) {
    const prior = targetOwner.get(tgt);
    if (prior && prior !== src) {
      const e = new Error('Two lines would land on the same species in the target brand (same variety + epithet) — merge those lines first.');
      e.status = 409; throw e;
    }
    targetOwner.set(tgt, src);
  }

  // Move the minted items first — grouped by target species so a big
  // receive is a handful of statements, not one per plant. SKU, name,
  // variety text, costs, status: all untouched.
  const itemGroups = new Map();
  for (const it of movingItems) {
    const tgtSpecies = (it.speciesId && speciesIdMap.get(it.speciesId)) || '';
    if (!itemGroups.has(tgtSpecies)) itemGroups.set(tgtSpecies, []);
    itemGroups.get(tgtSpecies).push(it.id);
  }
  for (const [tgtSpecies, ids] of itemGroups) {
    const patch = tgtSpecies ? { brandId: target, speciesId: tgtSpecies } : { brandId: target };
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await supabase
        .from('inventory_items').update(patch).in('id', ids.slice(i, i + 200));
      if (error) { const e = new Error(`Item move failed: ${error.message}`); e.status = 500; throw e; }
    }
  }

  // Their photos and the receiving audit trail follow the items.
  for (let i = 0; i < itemIds.length; i += 200) {
    const { error } = await supabase
      .from('item_photos').update({ brandId: target }).in('itemId', itemIds.slice(i, i + 200));
    if (error) { const e = new Error(`Photo move failed: ${error.message}`); e.status = 500; throw e; }
  }
  for (let i = 0; i < lineIds.length; i += 200) {
    const { error } = await supabase
      .from('purchase_order_received_items')
      .update({ brandId: target }).in('lineId', lineIds.slice(i, i + 200));
    if (error) { const e = new Error(`Receipt move failed: ${error.message}`); e.status = 500; throw e; }
  }

  // Move the lines. Chunked parallel like update-order-lines. A line that
  // vanished mid-move (concurrent remove-line) just comes back empty —
  // nothing to move.
  for (let i = 0; i < lines.length; i += 20) {
    const batch = lines.slice(i, i + 20);
    const results = await Promise.all(batch.map(l =>
      supabase.from('purchase_order_lines')
        .update({ brandId: target, speciesId: speciesIdMap.get(l.speciesId) })
        .eq('id', l.id)
        .eq('purchaseOrderId', id)
        .select('id'),
    ));
    for (const r of results) {
      if (r.error) { const e = new Error(`Line move failed: ${r.error.message}`); e.status = 500; throw e; }
    }
  }

  // Header flip last — this is the moment the PO changes hands.
  const { data: moved, error: mvErr } = await supabase
    .from('purchase_orders')
    .update({ brandId: target, modifiedAt: nowIso, modifiedBy: user.displayName })
    .eq('id', id)
    .select('*')
    .maybeSingle();
  if (mvErr) { const e = new Error(mvErr.message); e.status = 500; throw e; }

  // Convergence sweep: a receive in flight during the move minted items in
  // the source brand after our snapshot. New receives now land in the
  // target (the header has flipped; source-side receives 404), so one pass
  // over still-source audit rows converges the stragglers.
  const stragglers = [];
  for (let i = 0; i < lineIds.length; i += 200) {
    const { data: rows, error } = await supabase
      .from('purchase_order_received_items')
      .select('id, "inventoryItemId"')
      .in('lineId', lineIds.slice(i, i + 200))
      .neq('brandId', target);
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    stragglers.push(...(rows || []));
  }
  if (stragglers.length) {
    const sIds = [...new Set(stragglers.map(s => s.inventoryItemId))];
    const { data: sItems, error: sfErr } = await supabase
      .from('inventory_items').select('id, "speciesId"').in('id', sIds);
    if (sfErr) { const e = new Error(sfErr.message); e.status = 500; throw e; }
    for (const it of sItems || []) {
      const tgtSpecies = (it.speciesId && speciesIdMap.get(it.speciesId)) || null;
      const patch = tgtSpecies ? { brandId: target, speciesId: tgtSpecies } : { brandId: target };
      const { error } = await supabase.from('inventory_items').update(patch).eq('id', it.id);
      if (error) { const e = new Error(`Straggler item move failed: ${error.message}`); e.status = 500; throw e; }
    }
    const { error: saErr } = await supabase
      .from('purchase_order_received_items')
      .update({ brandId: target })
      .in('id', stragglers.map(s => s.id));
    if (saErr) { const e = new Error(`Straggler receipt move failed: ${saErr.message}`); e.status = 500; throw e; }
  }

  return res.status(200).json({
    purchaseOrder: moved,
    targetBrandId: target,
    migrated: {
      lines: lines.length,
      items: movingItems.length + stragglers.length,
      createdVarieties,
      createdSpecies,
    },
  });
}
