import { supabase, requireBrand, brandIdFromReq, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';
import { brandSkuPrefix } from './_lib/sku.js';

// Fields the client must never be able to set directly. The server owns these.
// brandId is server-owned too: the active brand is forced from the request, so
// a client can neither create rows in another brand nor move a row between
// brands via the item payload.
const SERVER_OWNED = ['createdAt', 'createdBy', 'modifiedAt', 'modifiedBy', 'brandId'];

// Supabase caps un-ranged selects at 1000 rows by default. Paginate so we
// actually return everything for tables that can grow past that. Pass a
// builder thunk because Supabase queries are single-use awaitables.
async function fetchAll(buildQuery) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function stripServerOwned(item) {
  const clean = { ...item };
  for (const k of SERVER_OWNED) delete clean[k];
  return clean;
}

// Largest numeric SKU suffix across all inventory items, computed in SQL.
//
// Why an RPC instead of `order('sku', desc).limit(N)`? Supabase's order is
// lexicographic — with mixed-width suffixes and prefixes, `MON-99` sorts
// above `ANT-2000`. The top-N window can miss the true max entirely, which
// caused new SKUs to collide with existing numbers under a different
// variety prefix. The RPC (defined in migration 0007) extracts the suffix
// in regex and takes max(int), which is correct regardless of width.
async function findMaxSkuSuffix(brandId) {
  const { data, error } = await supabase.rpc('inventory_max_sku_suffix', { p_brand: brandId });
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return data ?? 0;
}


// Assign SKUs to items that don't have one. Numbering is GLOBAL across all
// items; the variety code is only a prefix for identification. Example
// sequence: ANT-1, ALO-2, ANT-3, MON-4, JOR-5…
//
// Variety codes come from the `varieties` table (so admin-added varieties
// work without a code release).
//
// Seller-consignment items (those carrying a sellerId) get an extra leading
// segment — the seller's code — so their SKU reads <SELLERCODE>-<VARIETYCODE>-<n>
// (e.g. JADE-ANT-142) while still drawing from the same global number sequence.
// The trailing "-<n>" is what inventory_max_sku_suffix keys on, so the seller
// prefix doesn't disturb numbering or (brandId, sku) uniqueness.
async function assignMissingSkus(items, brandId) {
  const needSku = items.filter(i => !i.sku);
  if (needSku.length === 0) return;

  const { data: varieties, error: vErr } = await supabase
    .from('varieties').select('name, code').eq('brandId', brandId);
  if (vErr) { const e = new Error(vErr.message); e.status = 500; throw e; }
  const codeByName = Object.fromEntries((varieties || []).map(v => [v.name, v.code]));

  // Seller codes for any items being intaken on consignment.
  const needSeller = needSku.some(i => i.sellerId);
  let codeBySellerId = {};
  if (needSeller) {
    const { data: sellers, error: sErr } = await supabase
      .from('sellers').select('id, code').eq('brandId', brandId);
    if (sErr) { const e = new Error(sErr.message); e.status = 500; throw e; }
    codeBySellerId = Object.fromEntries((sellers || []).map(s => [s.id, s.code]));
  }

  for (const item of needSku) {
    if (!codeByName[item.variety]) {
      const e = new Error(`Unknown variety: ${item.variety}`); e.status = 400; throw e;
    }
    if (item.sellerId && !codeBySellerId[item.sellerId]) {
      const e = new Error(`Unknown seller: ${item.sellerId}`); e.status = 400; throw e;
    }
  }

  let next = (await findMaxSkuSuffix(brandId)) + 1;
  const brandCode = brandSkuPrefix(brandId);
  for (const item of needSku) {
    const varietyCode = codeByName[item.variety];
    const prefix = item.sellerId ? `${codeBySellerId[item.sellerId]}-${varietyCode}` : varietyCode;
    item.sku = `${brandCode}-${prefix}-${next++}`;
  }
}

// Pick the next global SKU number for a given variety. Used by /convert.
// Variety codes live in the `varieties` table (the old VARIETY_CODES
// constants.js export is gone) so we look them up here.
async function nextSkuForVariety(variety, brandId) {
  const { data: row, error: vErr } = await supabase
    .from('varieties')
    .select('code')
    .eq('brandId', brandId)
    .eq('name', variety)
    .maybeSingle();
  if (vErr) { const e = new Error(vErr.message); e.status = 500; throw e; }
  const code = row?.code;
  if (!code) {
    const e = new Error(`Unknown variety: ${variety}`); e.status = 400; throw e;
  }
  const next = (await findMaxSkuSuffix(brandId)) + 1;
  return `${brandSkuPrefix(brandId)}-${code}-${next}`;
}

// POST { action: 'combine-boxes', targetBoxId, sourceBoxIds: [...] }
// Move every still-sold item from the source boxes into the target box,
// re-stamping the target's denormalized identity (buyer/username/address/
// stamped carrier, derived server-side from the target's own items — never
// client-supplied). ONE set-based UPDATE, so the merge is atomic: it can
// never leave an order half-combined the way a per-item loop could.
// Guards: none of the involved boxes may have an active (non-voided) label —
// postage is priced for a box's contents, and the client's shipments cache
// can be stale, so the check must live here.
async function combineBoxes(req, res, user, brandId) {
  const targetBoxId = typeof req.body?.targetBoxId === 'string' ? req.body.targetBoxId : '';
  const sourceBoxIds = Array.isArray(req.body?.sourceBoxIds)
    ? [...new Set(req.body.sourceBoxIds.filter(id => typeof id === 'string' && id && id !== targetBoxId))]
    : [];
  if (!targetBoxId || sourceBoxIds.length === 0) {
    const e = new Error('targetBoxId and sourceBoxIds required'); e.status = 400; throw e;
  }

  const allIds = [targetBoxId, ...sourceBoxIds];
  const { data: ships, error: shipErr } = await supabase
    .from('shipments')
    .select('id, "voidedAt"')
    .eq('brandId', brandId)
    .in('id', allIds);
  if (shipErr) { const e = new Error(shipErr.message); e.status = 500; throw e; }
  const labeled = (ships || []).filter(s => !s.voidedAt).map(s => s.id);
  if (labeled.length > 0) {
    const e = new Error(`Box${labeled.length === 1 ? ' has' : 'es have'} an active label — void it first to combine`);
    e.status = 409; throw e;
  }

  const { data: tItems, error: tErr } = await supabase
    .from('inventory_items')
    .select('buyer, "buyerUsername", "buyerAddress", "shipmentCarrier"')
    .eq('brandId', brandId)
    .eq('shipmentBoxId', targetBoxId)
    .limit(1);
  if (tErr) { const e = new Error(tErr.message); e.status = 500; throw e; }
  if (!tItems || tItems.length === 0) {
    const e = new Error('Target box not found (it may have just shipped or been emptied)'); e.status = 404; throw e;
  }
  const t = tItems[0];

  const now = new Date().toISOString();
  const { data: moved, error: mvErr } = await supabase
    .from('inventory_items')
    .update({
      shipmentBoxId: targetBoxId,
      buyer: t.buyer,
      buyerUsername: t.buyerUsername,
      buyerAddress: t.buyerAddress,
      shipmentCarrier: t.shipmentCarrier,
      modifiedAt: now,
      modifiedBy: user.displayName,
    })
    .eq('brandId', brandId)
    .in('shipmentBoxId', sourceBoxIds)
    .eq('status', 'sold')          // shipped/delivered history never moves
    .is('deletedAt', null)
    .select('id');
  if (mvErr) { const e = new Error(mvErr.message); e.status = 500; throw e; }

  return res.status(200).json({ ok: true, moved: moved?.length || 0 });
}

// ─── Cross-brand stock (migration 0046) ──────────────────────────────────────
// Either brand can see and sell the other's plants, WITHOUT any query ever
// spanning brands: a plant belongs to one brand at a time, and selling the
// other brand's plant means MOVING it first (transfer), after which every
// existing flow — lineup, scan, listing, packing, shipping, reports — sees
// an ordinary plant of the active brand. The only cross-brand reads are the
// two narrow ones below (shared-stock, lookup), scoped to the brands the
// user's own access list holds — never a brand named by the client alone.

const TRANSFERABLE_STATUSES = ['available', 'listed', 'acclimated'];
const TRANSFER_REASONS = new Set(['sale', 'manual', 'return']);
const TRANSFER_ROLES = new Set(['admin']);   // packers work the bench, streamers sell, the consultant prices
const SHARED_FIELDS = 'id, sku, name, variety, "speciesId", type, status, quantity, "listingPrice", "idealPrice", "grossCost", "netCost", "saleId", "shipmentBoxId", "lotNumber", "imageUrl", "sellerId", "createdAt", "modifiedAt", "brandId"';

// The OTHER brands this user may read: their access list minus the active one.
function otherBrandsOf(user, brandId) {
  const access = Array.isArray(user.brandIds) && user.brandIds.length ? user.brandIds : [];
  return access.filter((b) => b && b !== brandId);
}

// PostgREST reports a table the schema cache doesn't know as PGRST205
// ("Could not find the table …"), and Postgres itself as 42P01 — before
// migration 0046 is applied, both mean the same thing here.
function isMissingTransfersTable(error) {
  if (!error) return false;
  const text = `${error.code || ''} ${error.message || ''}`;
  return /item_transfers/.test(text) && /PGRST205|42P01|does not exist|schema cache/i.test(text);
}

function stripCostsForRole(user, rows) {
  if (user.role === 'admin') return rows;
  return rows.map(({ grossCost, netCost, cost, ...rest }) => rest);
}

async function brandNames(ids) {
  if (!ids.length) return {};
  const { data, error } = await supabase.from('brands').select('id, name').in('id', ids);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return Object.fromEntries((data || []).map((b) => [b.id, b.name]));
}

// GET ?action=shared-stock → the other brands' in-stock plants (read only).
async function sharedStock(req, res, user, brandId) {
  const others = otherBrandsOf(user, brandId);
  if (!others.length) return res.status(200).json({ items: [], brands: {} });
  const data = await fetchAll(() => supabase
    .from('inventory_items')
    .select(SHARED_FIELDS)
    .in('brandId', others)
    .is('deletedAt', null)
    .in('status', TRANSFERABLE_STATUSES)
    .order('brandId').order('createdAt', { ascending: false }));
  return res.status(200).json({ items: stripCostsForRole(user, data || []), brands: await brandNames(others) });
}

// GET ?action=shared-skus → just the SKUs the other brands have IN STOCK,
// so the scan screen can tell "ours" from "ours AND theirs" without a round
// trip per scan (older plants were numbered per brand and can collide).
async function sharedSkus(req, res, user, brandId) {
  const others = otherBrandsOf(user, brandId);
  if (!others.length) return res.status(200).json({ skus: {} });
  const data = await fetchAll(() => supabase
    .from('inventory_items')
    .select('sku, "brandId"')
    .in('brandId', others)
    .is('deletedAt', null)
    .in('status', TRANSFERABLE_STATUSES)
    .order('sku'));
  const skus = {};
  for (const r of data || []) { if (!r.sku) continue; (skus[r.brandId] ||= []).push(String(r.sku).toUpperCase()); }
  return res.status(200).json({ skus });
}

// POST { action: 'renumber-duplicates' } → this brand's in-stock plants whose
// SKU is ALSO in stock in another brand the user can access get a fresh SKU:
// the brand prefix plus a fresh number (seller / variety segments kept).
// Those labels must be reprinted — the response lists old → new for
// exactly that. Staff or admin. One-time cleanup of the era before brand
// prefixes; prefixed SKUs can't collide.
async function renumberDuplicates(req, res, user, brandId) {
  if (!TRANSFER_ROLES.has(user.role)) { const e = new Error('Only admins can renumber plants'); e.status = 403; throw e; }
  const others = otherBrandsOf(user, brandId);
  if (!others.length) return res.status(200).json({ renumbered: [] });
  const theirs = await fetchAll(() => supabase
    .from('inventory_items').select('sku').in('brandId', others).is('deletedAt', null).in('status', TRANSFERABLE_STATUSES));
  const taken = new Set((theirs || []).map((r) => String(r.sku || '').toUpperCase()).filter(Boolean));
  if (!taken.size) return res.status(200).json({ renumbered: [] });
  const mine = await fetchAll(() => supabase
    .from('inventory_items').select('id, sku, name, variety, "speciesId", type, status')
    .eq('brandId', brandId).is('deletedAt', null).in('status', TRANSFERABLE_STATUSES));
  const dup = (mine || []).filter((r) => r.sku && taken.has(String(r.sku).toUpperCase()) && /-\d+$/.test(r.sku));
  if (!dup.length) return res.status(200).json({ renumbered: [] });
  let next = (await findMaxSkuSuffix(brandId)) + 1;
  const brandCode = brandSkuPrefix(brandId);
  const now = new Date().toISOString();
  const renumbered = [];
  for (const r of dup) {
    const stem = r.sku.replace(/-\d+$/, '').replace(new RegExp(`^${brandCode}-`), '');
    const sku = `${brandCode}-${stem}-${next++}`;
    const { data: upd, error } = await supabase
      .from('inventory_items')
      .update({ sku, modifiedAt: now, modifiedBy: user.displayName })
      .eq('id', r.id).eq('brandId', brandId).eq('sku', r.sku).is('deletedAt', null)
      .select('id, sku, name, variety, "speciesId", type, status, "lotNumber"');
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    if (upd && upd.length) renumbered.push({ ...upd[0], oldSku: r.sku });
  }
  return res.status(200).json({ renumbered });
}

// ─── Acclimation ─────────────────────────────────────────────────────────────
// TCs potted to recover: scanned into "acclimated" from the packing bench or
// the admin's scan modal, listed on the Acclimation tab, marked available
// again once grown. POST { action: 'acclimate', skus: [...], revert? } flips
// every SKU of the active brand in one call (any brand member — the bench is
// a team member) and reports per SKU, so a scanner session shows what
// happened to each label. The profit-rate bump the admin's modal applies
// comes from app_settings `acclimation:<brand>` ({ profitRate }, default 200)
// so bench scans price the same way; the bump only ever raises.
const ACCLIMATE_FROM = new Set(['available', 'listed']);
const ACCLIMATE_MAX = 500;
const ACCLIMATE_DEFAULT_RATE = 200;

async function acclimationRate(brandId) {
  const { data, error } = await supabase.from('app_settings').select('data').eq('id', `acclimation:${brandId}`).maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  const n = parseFloat(data?.data?.profitRate);
  return Number.isFinite(n) ? n : ACCLIMATE_DEFAULT_RATE;
}

async function acclimateItems(req, res, user, brandId) {
  const raw = Array.isArray(req.body?.skus) ? req.body.skus : [];
  const skus = Array.from(new Set(raw.map((s) => String(s || '').trim().toUpperCase().replace(/_/g, '-')).filter(Boolean)));
  if (!skus.length) { const e = new Error('skus (array) required'); e.status = 400; throw e; }
  if (skus.length > ACCLIMATE_MAX) { const e = new Error(`At most ${ACCLIMATE_MAX} SKUs per call`); e.status = 400; throw e; }
  const revert = !!req.body?.revert;
  const { data: rows, error } = await supabase
    .from('inventory_items')
    .select('id, sku, name, variety, type, status, "profitRate", "modifiedAt"')
    .eq('brandId', brandId).is('deletedAt', null).in('sku', skus);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  const bySku = new Map((rows || []).map((r) => [String(r.sku).toUpperCase(), r]));
  const rate = revert ? null : await acclimationRate(brandId);
  const now = new Date().toISOString();
  const results = [];
  for (const sku of skus) {
    const item = bySku.get(sku);
    if (!item) { results.push({ sku, ok: false, error: 'SKU not found' }); continue; }
    if (revert) {
      if (item.status !== 'acclimated') { results.push({ sku, ok: false, error: `not in acclimation (${item.status})`, item }); continue; }
      const { data: upd, error: uErr } = await supabase
        .from('inventory_items').update({ status: 'available', modifiedAt: now, modifiedBy: user.displayName })
        .eq('id', item.id).eq('brandId', brandId).eq('status', 'acclimated').select('id, sku, name, variety, type, status, "modifiedAt"');
      if (uErr) { const e = new Error(uErr.message); e.status = 500; throw e; }
      results.push(upd?.length ? { sku, ok: true, item: upd[0] } : { sku, ok: false, error: 'changed under you', item });
      continue;
    }
    if (item.status === 'acclimated') { results.push({ sku, ok: false, already: true, error: 'already in acclimation', item }); continue; }
    if (item.type !== 'tc') { results.push({ sku, ok: false, error: 'not a TC', item }); continue; }
    if (!ACCLIMATE_FROM.has(item.status)) { results.push({ sku, ok: false, error: `is ${item.status}`, item }); continue; }
    const current = parseFloat(item.profitRate);
    const patch = { status: 'acclimated', modifiedAt: now, modifiedBy: user.displayName };
    if (!Number.isFinite(current) || current < rate) patch.profitRate = rate;
    const { data: upd, error: uErr } = await supabase
      .from('inventory_items').update(patch)
      .eq('id', item.id).eq('brandId', brandId).in('status', [...ACCLIMATE_FROM]).select('id, sku, name, variety, type, status, "modifiedAt"');
    if (uErr) { const e = new Error(uErr.message); e.status = 500; throw e; }
    results.push(upd?.length ? { sku, ok: true, item: upd[0] } : { sku, ok: false, error: 'changed under you', item });
  }
  return res.status(200).json({ results, done: results.filter((r) => r.ok).length });
}

// GET ?action=lookup&sku= → one in-stock plant of another brand by SKU (the
// scan screen asks this when a scanned label isn't the active brand's).
async function lookupSku(req, res, user, brandId) {
  const sku = String(req.query?.sku || '').trim().toUpperCase().replace(/_/g, '-');
  if (!sku) { const e = new Error('sku required'); e.status = 400; throw e; }
  const others = otherBrandsOf(user, brandId);
  if (!others.length) return res.status(200).json({ item: null });
  const { data, error } = await supabase
    .from('inventory_items')
    .select(SHARED_FIELDS)
    .in('brandId', others)
    .is('deletedAt', null)
    .ilike('sku', sku)
    .limit(5);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  const hit = (data || []).find((i) => TRANSFERABLE_STATUSES.includes(i.status)) || (data || [])[0] || null;
  if (!hit) return res.status(200).json({ item: null });
  const names = await brandNames([hit.brandId]);
  return res.status(200).json({
    item: stripCostsForRole(user, [hit])[0],
    brandName: names[hit.brandId] || hit.brandId,
    transferable: TRANSFERABLE_STATUSES.includes(hit.status) && !hit.saleId && !hit.shipmentBoxId,
  });
}

// GET ?action=transfers → this brand's recent moves, in and out.
async function listTransfers(req, res, user, brandId) {
  const { data, error } = await supabase
    .from('item_transfers')
    .select('*')
    .or(`fromBrandId.eq.${brandId},toBrandId.eq.${brandId}`)
    .order('createdAt', { ascending: false })
    .limit(200);
  if (error) {
    if (isMissingTransfersTable(error)) return res.status(200).json({ transfers: [], unsupported: true });
    const e = new Error(error.message); e.status = 500; throw e;
  }
  const rows = user.role === 'admin' ? (data || []) : (data || []).map(({ grossCost, netCost, ...r }) => r);
  const ids = Array.from(new Set(rows.flatMap((t) => [t.fromBrandId, t.toBrandId])));
  return res.status(200).json({ transfers: rows, brands: await brandNames(ids) });
}

// The receiving brand's species for a plant: same variety name, same
// epithet. Created when missing (a plant must not lose its catalog link),
// copying the selling fields the streamer relies on.
// The receiving brand's variety of the same name, created (same code) when
// missing. `source` is the sending brand's variety row or null.
async function varietyInBrand(name, code, toBrandId, user) {
  if (!name) return null;
  const { data: found, error } = await supabase
    .from('varieties').select('id, name, code').eq('brandId', toBrandId).ilike('name', name).limit(1);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (found && found.length) return found[0];
  const row = { id: newId(), brandId: toBrandId, name, code: code || name.slice(0, 3).toUpperCase(), createdBy: user.displayName || user.id };
  const { error: iErr } = await supabase.from('varieties').insert(row);
  if (iErr) { const e = new Error(iErr.message); e.status = 500; throw e; }
  return row;
}

async function speciesInBrand(fromSpeciesId, toBrandId, user) {
  if (!fromSpeciesId) return null;
  const { data: src, error } = await supabase.from('species').select('*').eq('id', fromSpeciesId).maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!src) return null;
  const { data: srcVar, error: svErr } = await supabase.from('varieties').select('name, code').eq('id', src.varietyId).maybeSingle();
  if (svErr) { const e = new Error(svErr.message); e.status = 500; throw e; }
  if (!srcVar?.name) return null;
  const variety = await varietyInBrand(srcVar.name, srcVar.code, toBrandId, user);
  const { data: existing, error: sErr } = await supabase
    .from('species').select('id').eq('brandId', toBrandId).eq('varietyId', variety.id).ilike('epithet', src.epithet).maybeSingle();
  if (sErr) { const e = new Error(sErr.message); e.status = 500; throw e; }
  if (existing) return { speciesId: existing.id, varietyName: variety.name, created: false };
  const row = {
    id: newId(),
    brandId: toBrandId,
    varietyId: variety.id,
    epithet: src.epithet,
    commonName: src.commonName ?? null,
    notes: src.notes ?? null,
    profitRate: src.profitRate ?? null,
    wholesalePrice: src.wholesalePrice ?? null,
    idealSellingPrice: src.idealSellingPrice ?? null,
    sellNote: src.sellNote ?? null,
    createdBy: user.displayName || user.id,
  };
  const { error: iErr } = await supabase.from('species').insert(row);
  if (iErr) {
    // An older DB without a column we copied: retry with the bare row.
    const { error: again } = await supabase.from('species').insert({ id: row.id, brandId: toBrandId, varietyId: variety.id, epithet: src.epithet, createdBy: row.createdBy });
    if (again) { const e = new Error(again.message); e.status = 500; throw e; }
  }
  return { speciesId: row.id, varietyName: variety.name, created: true };
}

// POST { action: 'transfer', itemId, fromBrandId, reason, saleId?, transferId }
// Moves one plant from `fromBrandId` into the ACTIVE brand. Admin or staff,
// with both brands on their access list. The plant keeps its SKU (so its
// printed label keeps scanning) unless the receiving brand already used that
// SKU, in which case it is re-numbered and `relabel` comes back true. Cost
// travels with the plant; the ledger row is written first so a move can
// never happen unrecorded, and the item update guards status / lineup / box
// in the statement so two operators can't both move it.
async function transferItem(req, res, user, brandId) {
  if (!TRANSFER_ROLES.has(user.role)) { const e = new Error('Only admins can move stock between brands'); e.status = 403; throw e; }
  const { itemId, fromBrandId, reason = 'manual', saleId = null } = req.body || {};
  const transferId = typeof req.body?.transferId === 'string' && /^[\w-]{6,64}$/.test(req.body.transferId) ? req.body.transferId : newId();
  if (!itemId || typeof itemId !== 'string') { const e = new Error('itemId required'); e.status = 400; throw e; }
  if (!fromBrandId || typeof fromBrandId !== 'string') { const e = new Error('fromBrandId required'); e.status = 400; throw e; }
  if (fromBrandId === brandId) { const e = new Error('That plant is already in this brand'); e.status = 400; throw e; }
  if (!TRANSFER_REASONS.has(reason)) { const e = new Error('reason must be sale, manual or return'); e.status = 400; throw e; }
  if (!otherBrandsOf(user, brandId).includes(fromBrandId)) { const e = new Error('Brand access required'); e.status = 403; throw e; }

  // Idempotent retry: the same transferId already moved it.
  const { data: prior, error: pErr } = await supabase.from('item_transfers').select('id, "toBrandId"').eq('id', transferId).maybeSingle();
  if (pErr) {
    if (isMissingTransfersTable(pErr)) {
      const e = new Error('Moving stock between brands needs migration 0046 (item_transfers) — run it in the Supabase SQL editor first'); e.status = 409; throw e;
    }
    const e = new Error(pErr.message); e.status = 500; throw e;
  }
  if (prior) {
    const { data: already } = await supabase.from('inventory_items').select('*').eq('id', itemId).eq('brandId', brandId).maybeSingle();
    if (already) return res.status(200).json({ ok: true, item: already, relabel: false, transferId, repeated: true });
  }

  const { data: item, error: iErr } = await supabase
    .from('inventory_items').select('*').eq('id', itemId).eq('brandId', fromBrandId).is('deletedAt', null).maybeSingle();
  if (iErr) { const e = new Error(iErr.message); e.status = 500; throw e; }
  if (!item) { const e = new Error('Plant not found in that brand (it may have just moved)'); e.status = 404; throw e; }
  if (!TRANSFERABLE_STATUSES.includes(item.status)) { const e = new Error(`A ${item.status} plant can't move between brands`); e.status = 409; throw e; }
  if (item.saleId) { const e = new Error('That plant is staged in a sale event — remove it from the lineup first'); e.status = 409; throw e; }
  if (item.shipmentBoxId) { const e = new Error('That plant is in a shipping box'); e.status = 409; throw e; }

  const sp = await speciesInBrand(item.speciesId, brandId, user);
  // Even without a catalog link the variety must exist here, for the SKU
  // prefix and the inventory's variety tabs.
  if (!sp && item.variety) {
    const { data: srcVar } = await supabase.from('varieties').select('name, code').eq('brandId', fromBrandId).ilike('name', item.variety).limit(1);
    await varietyInBrand(item.variety, srcVar?.[0]?.code, brandId, user);
  }
  // SKU: keep it unless the receiving brand already has that SKU (any row,
  // deleted ones included — the unique index covers them all).
  const { data: clash, error: cErr } = await supabase
    .from('inventory_items').select('id').eq('brandId', brandId).eq('sku', item.sku).limit(1);
  if (cErr) { const e = new Error(cErr.message); e.status = 500; throw e; }
  let toSku = item.sku;
  let relabel = false;
  if (clash && clash.length) {
    const variety = sp?.varietyName || item.variety;
    toSku = await nextSkuForVariety(variety, brandId);
    relabel = true;
  }

  const now = new Date().toISOString();
  const ledger = {
    id: transferId,
    itemId: item.id,
    fromBrandId,
    toBrandId: brandId,
    fromSku: item.sku,
    toSku,
    fromSpeciesId: item.speciesId || null,
    toSpeciesId: sp?.speciesId || null,
    grossCost: item.grossCost ?? null,
    netCost: item.netCost ?? null,
    reason,
    saleId: typeof saleId === 'string' && saleId ? saleId : null,
    createdAt: now,
    createdBy: user.displayName || user.id,
  };
  const { error: lErr } = await supabase.from('item_transfers').insert(ledger);
  if (lErr) { const e = new Error(lErr.message); e.status = 500; throw e; }

  const { data: moved, error: mErr } = await supabase
    .from('inventory_items')
    .update({
      brandId,
      sku: toSku,
      speciesId: sp?.speciesId || null,
      variety: sp?.varietyName || item.variety,
      saleId: null, lotNumber: null, lotKind: 'sale', stagedAt: null,
      sellerId: null, commissionPct: null,     // consignment is per brand; the plant is ours to sell here
      modifiedAt: now,
      modifiedBy: user.displayName,
    })
    .eq('id', item.id)
    .eq('brandId', fromBrandId)
    .in('status', TRANSFERABLE_STATUSES)
    .is('saleId', null)
    .is('shipmentBoxId', null)
    .is('deletedAt', null)
    .select('*');
  if (mErr || !moved || moved.length === 0) {
    await supabase.from('item_transfers').delete().eq('id', transferId);
    if (mErr) { const e = new Error(mErr.message); e.status = 500; throw e; }
    const e = new Error('That plant changed under you (sold, staged or moved) — reload and try again'); e.status = 409; throw e;
  }
  // Its photos follow it (best effort — a miss only hides them until the
  // next move; the transfer itself is complete).
  try { await supabase.from('item_photos').update({ brandId }).eq('itemId', item.id); } catch { /* see above */ }
  return res.status(200).json({ ok: true, item: moved[0], relabel, transferId, speciesCreated: !!sp?.created });
}

export default wrap(async (req, res) => {
  // All item operations require an authenticated user + an authorized brand.
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const { user, brandId } = await requireBrand(userId, brandIdFromReq(req));

  // Sub-action dispatch — "convert" used to live at /api/items/convert
  // but was inlined here to stay under Vercel's 12-function Hobby cap.
  // The action travels in the query string for GET, body for POST.
  const action = req.method === 'GET' ? req.query?.action : req.body?.action;
  if (action === 'convert') return convertItem(req, res, user, brandId);
  if (action === 'rename-names') return renameNames(req, res, user, brandId);
  if (action === 'combine-boxes') return combineBoxes(req, res, user, brandId);
  if (action === 'shared-stock' && req.method === 'GET') return sharedStock(req, res, user, brandId);
  if (action === 'lookup' && req.method === 'GET') return lookupSku(req, res, user, brandId);
  if (action === 'shared-skus' && req.method === 'GET') return sharedSkus(req, res, user, brandId);
  if (action === 'renumber-duplicates' && req.method === 'POST') return renumberDuplicates(req, res, user, brandId);
  if (action === 'transfers' && req.method === 'GET') return listTransfers(req, res, user, brandId);
  if (action === 'transfer' && req.method === 'POST') return transferItem(req, res, user, brandId);
  if (action === 'acclimate' && req.method === 'POST') return acclimateItems(req, res, user, brandId);
  // Consultant-safe stock list: what's on hand, with the list price and
  // never the cost. Any brand member. (The plain GET returns full rows with
  // costs to staff/admin — this is the narrow read for the pricing screen.)
  if (action === 'stock' && req.method === 'GET') {
    const data = await fetchAll(() => supabase
      .from('inventory_items')
      .select('id, sku, name, variety, "speciesId", type, status, "listingPrice", "lotNumber", "saleId", quantity')
      .eq('brandId', brandId)
      .is('deletedAt', null)
      .in('status', ['available', 'listed', 'acclimated']));
    return res.status(200).json({ items: data || [] });
  }

  switch (req.method) {
    case 'GET': {
      // Lazy purge: hard-delete anything in the trash longer than 30 days.
      // The not-null guard is defense in depth — `lt` already excludes NULL
      // by SQL semantics, but one ORM quirk would silently nuke production
      // data, so we make the intent explicit.
      // Best-effort — we don't fail the read if this errors.
      const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
      await supabase
        .from('inventory_items')
        .delete()
        .eq('brandId', brandId)
        .not('deletedAt', 'is', null)
        .lt('deletedAt', cutoff);

      const data = await fetchAll(() =>
        supabase.from('inventory_items').select('*').eq('brandId', brandId));
      // The packing bench never needs what plants COST — strip bought-price
      // fields for packer logins so the data doesn't reach that client at
      // all (mirrors the purchase-orders API; staff/admin keep full rows).
      if (user.role !== 'admin') {
        return res.status(200).json({
          items: (data || []).map(({ grossCost, netCost, cost, ...rest }) => rest),
        });
      }
      return res.status(200).json({ items: data });
    }

    case 'POST': {
      // Race-safe bulk sale assignment (TikTok lives load TC per PO): the
      // saleId-null guard is IN the update, so two admins assigning the
      // same items to two sales can't both win — the response reports what
      // was actually claimed, and the client reconciles from that.
      if (req.body?.action === 'assign-to-sale') {
        const { itemIds, saleId } = req.body;
        if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > 1000) {
          const e = new Error('itemIds must be a non-empty array (max 1000)'); e.status = 400; throw e;
        }
        if (!saleId || typeof saleId !== 'string') {
          const e = new Error('saleId required'); e.status = 400; throw e;
        }
        // lotKind/lotNumber reset matches every other staging path's
        // invariant: staging must start un-numbered.
        const { data: claimed, error } = await supabase
          .from('inventory_items')
          .update({
            saleId,
            lotKind: 'sale',
            lotNumber: null,
            modifiedAt: new Date().toISOString(),
            modifiedBy: user.displayName,
          })
          .eq('brandId', brandId)
          .in('id', itemIds)
          .is('saleId', null)
          .is('deletedAt', null)
          .select('id');
        if (error) { const e = new Error(error.message); e.status = 500; throw e; }
        return res.status(200).json({ assignedIds: (claimed || []).map(c => c.id) });
      }

      const { items } = req.body || {};
      if (!Array.isArray(items)) {
        const e = new Error('items must be an array'); e.status = 400; throw e;
      }
      if (items.length === 0) return res.status(200).json({ ok: true });

      // Split by presence of id: no id = insert, has id = update.
      const rawInserts = items.filter(i => !i.id).map(stripServerOwned);
      const rawUpdates = items.filter(i => i.id).map(stripServerOwned);

      // Server-generate SKUs for new items that don't have one.
      if (rawInserts.length > 0) await assignMissingSkus(rawInserts, brandId);

      // Self-heal Validate-Sales placeholder rows. Each unmatched order
      // line generates a deterministic UNMATCHED-<boxId>-<rowKey> SKU
      // (see SalesUploadModal.handleApply). If an earlier upload of the
      // same file left a row (alive or soft-deleted) with that SKU, the
      // unique constraint on `sku` would reject the new insert. Hard-
      // delete any existing row whose SKU collides with an incoming
      // placeholder insert before proceeding. Placeholders are throwaway
      // — nothing of value gets lost here.
      const placeholderSkus = rawInserts
        .map(i => i.sku)
        .filter(s => typeof s === 'string' && s.startsWith('UNMATCHED-'));
      if (placeholderSkus.length > 0) {
        const { error: delErr } = await supabase
          .from('inventory_items')
          .delete()
          .eq('brandId', brandId)
          .in('sku', placeholderSkus);
        if (delErr) { const e = new Error(delErr.message); e.status = 500; throw e; }
      }

      const now = new Date().toISOString();
      const inserts = rawInserts.map(item => ({
        ...item,
        id: newId(),
        createdAt: now,
        createdBy: user.displayName,
        brandId,
      }));
      const updates = rawUpdates.map(item => ({
        ...item,
        modifiedAt: now,
        modifiedBy: user.displayName,
      }));

      // Catch duplicate SKUs within the incoming payload before hitting the DB.
      const allSkus = [...inserts, ...updates].map(i => (i.sku ?? '').toString().trim()).filter(Boolean);
      const dupeInBatch = allSkus.find((s, i) => allSkus.indexOf(s) !== i);
      if (dupeInBatch) {
        const e = new Error(`Duplicate SKU "${dupeInBatch}" in this save`); e.status = 409; throw e;
      }

      if (inserts.length > 0) {
        // Batch in chunks of 500 so very large imports don't hit Postgres
        // parameter limits or Vercel body-size limits in a single request.
        // SKUs are pre-assigned above so order between batches is irrelevant.
        const CHUNK = 500;
        for (let i = 0; i < inserts.length; i += CHUNK) {
          const batch = inserts.slice(i, i + CHUNK);
          const { error } = await supabase.from('inventory_items').insert(batch);
          if (error) {
            if (error.code === '23505' && /sku/i.test(error.message || '')) {
              const e = new Error('SKU already exists — someone else may have just taken it. Please retry.'); e.status = 409; throw e;
            }
            const e = new Error(error.message); e.status = 500; throw e;
          }
        }
      }
      // For updates we use UPDATE (not UPSERT) so partial payloads — e.g.
      // restoring a soft-deleted row by sending only { id, deletedAt: null }
      // — don't trip the NOT NULL constraints on sku/type during the
      // INSERT phase of an upsert.
      if (updates.length > 0) {
        for (const item of updates) {
          const { id, ...patch } = item;
          const { error } = await supabase
            .from('inventory_items')
            .update(patch)
            .eq('brandId', brandId)
            .eq('id', id);
          if (error) {
            if (error.code === '23505' && /sku/i.test(error.message || '')) {
              const e = new Error('SKU already exists — SKUs must be unique.'); e.status = 409; throw e;
            }
            const e = new Error(error.message); e.status = 500; throw e;
          }
        }
      }
      // Return the server-assigned ids of the rows we inserted so the client
      // can identify exactly this batch (e.g. CSV-import undo / label print)
      // without a fragile id-diff that a concurrent insert/restore could taint.
      return res.status(200).json({
        ok: true,
        inserted: inserts.length,
        updated: updates.length,
        insertedIds: inserts.map(i => i.id),
      });
    }

    case 'DELETE': {
      const { ids, purge } = req.body || {};
      if (!Array.isArray(ids) || ids.length === 0) {
        const e = new Error('ids required'); e.status = 400; throw e;
      }
      // Batch the .in() calls — PostgREST inlines every id into the URL
      // (?id=in.(...)), so a few hundred ids can blow past proxy URL-length
      // limits and come back as a generic 400. 200 per batch is well under
      // every reasonable proxy cap.
      const CHUNK = 200;
      // Deleting inventory is admin-only — the UI gates were client-side
      // only, leaving the endpoint open to any active user. One exception:
      // any active user may purge UNMATCHED-* placeholder rows, because
      // Validate Sales / box-delete cleanup creates and removes those as
      // part of normal staff workflows.
      if (user.role !== 'admin') {
        if (!purge) {
          const e = new Error('Only admins can delete items'); e.status = 403; throw e;
        }
        const skus = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
          const { data, error } = await supabase
            .from('inventory_items')
            .select('sku')
            .eq('brandId', brandId)
            .in('id', ids.slice(i, i + CHUNK));
          if (error) { const e = new Error(error.message); e.status = 500; throw e; }
          skus.push(...(data || []));
        }
        if (skus.some(r => !(r.sku || '').startsWith('UNMATCHED-'))) {
          const e = new Error('Only admins can delete items'); e.status = 403; throw e;
        }
      }
      if (purge) {
        // Hard delete — bypass the 30-day grace. Used by the Recently
        // Deleted tab's "Delete forever" action.
        for (let i = 0; i < ids.length; i += CHUNK) {
          const batch = ids.slice(i, i + CHUNK);
          const { error } = await supabase
            .from('inventory_items').delete().eq('brandId', brandId).in('id', batch);
          if (error) { const e = new Error(error.message); e.status = 500; throw e; }
        }
        return res.status(200).json({ ok: true, purged: ids.length });
      }
      // Soft delete: items keep all their data and are recoverable for
      // 30 days from the Recently Deleted tab.
      const patch = {
        deletedAt: new Date().toISOString(),
        deletedBy: user.displayName,
      };
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        const { error } = await supabase
          .from('inventory_items').update(patch).eq('brandId', brandId).in('id', batch);
        if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      }
      return res.status(200).json({ ok: true, deleted: ids.length });
    }

    default:
      return methodNotAllowed(res, ['GET', 'POST', 'DELETE']);
  }
});

// POST /api/items?action=convert
// Body: { userId, action: 'convert', tcId, plantData }
// Atomically converts a TC item into a new Plant item.
async function convertItem(req, res, user, brandId) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const { tcId, plantData } = req.body || {};
  if (!tcId) { const e = new Error('tcId required'); e.status = 400; throw e; }
  if (!plantData || typeof plantData !== 'object') {
    const e = new Error('plantData required'); e.status = 400; throw e;
  }

  const { data: tc, error: tcErr } = await supabase
    .from('inventory_items')
    .select('*')
    .eq('brandId', brandId)
    .eq('id', tcId)
    .maybeSingle();
  if (tcErr) { const e = new Error(tcErr.message); e.status = 500; throw e; }
  if (!tc) { const e = new Error('TC item not found'); e.status = 404; throw e; }
  if (tc.type !== 'tc') { const e = new Error('Item is not a TC — cannot convert'); e.status = 400; throw e; }
  if (tc.status === 'converted') { const e = new Error('Item is already converted'); e.status = 409; throw e; }

  const variety = plantData.variety || tc.variety;
  const newSku = await nextSkuForVariety(variety, brandId);
  const now = new Date().toISOString();

  const plant = {
    ...tc,
    ...plantData,
    id: newId(),
    sku: newSku,
    type: 'plant',
    status: 'available',
    saleId: null,
    lotNumber: null,
    variety,
    convertedFromTcId: tc.id,
    convertedFromSku: tc.sku,
    convertedAt: now,
    convertedBy: user.displayName,
    createdAt: now,
    createdBy: user.displayName,
    modifiedAt: null,
    modifiedBy: null,
    brandId,
  };

  const { error: insErr } = await supabase.from('inventory_items').insert(plant);
  if (insErr) {
    if (insErr.code === '23505' && /sku/i.test(insErr.message || '')) {
      const e = new Error('SKU collision during conversion. Please retry.'); e.status = 409; throw e;
    }
    const e = new Error(insErr.message); e.status = 500; throw e;
  }

  const { error: updErr } = await supabase
    .from('inventory_items')
    .update({
      status: 'converted',
      convertedToPlantId: plant.id,
      modifiedAt: now,
      modifiedBy: user.displayName,
    })
    .eq('brandId', brandId)
    .eq('id', tc.id);
  if (updErr) {
    // Best-effort rollback: delete the plant we just inserted.
    await supabase.from('inventory_items').delete().eq('brandId', brandId).eq('id', plant.id);
    const e = new Error(`Failed to mark TC as converted: ${updErr.message}`); e.status = 500; throw e;
  }

  res.status(201).json({
    plant,
    tc: { ...tc, status: 'converted', convertedToPlantId: plant.id, modifiedAt: now, modifiedBy: user.displayName },
  });
}

// POST /api/items?action=rename-names  (body action: 'rename-names')
// Body: { userId, action: 'rename-names', renames: [{ ids: [...], name }] }
// Bulk-rename item names (the Inventory "Edit Names" tool). Each group is one
// set-based UPDATE by id — atomic per group (a group can never be left
// half-renamed) and one round-trip per chunk instead of per item (no timeout
// on large renames). Renaming two groups to the same name merges them.
async function renameNames(req, res, user, brandId) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const { renames } = req.body || {};
  if (!Array.isArray(renames) || renames.length === 0) {
    const e = new Error('renames required'); e.status = 400; throw e;
  }
  const now = new Date().toISOString();
  // ids go in the URL (?id=in.(...)) so chunk to stay under proxy URL limits,
  // matching the DELETE path.
  const CHUNK = 200;
  let renamed = 0;
  for (const r of renames) {
    const name = typeof r?.name === 'string' ? r.name.trim() : '';
    const ids = Array.isArray(r?.ids) ? r.ids.filter(id => typeof id === 'string' && id) : [];
    if (!name || ids.length === 0) continue;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from('inventory_items')
        .update({ name, modifiedAt: now, modifiedBy: user.displayName })
        .eq('brandId', brandId)
        .in('id', batch)
        .select('id');
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      renamed += data?.length || 0;
    }
  }
  return res.status(200).json({ ok: true, renamed });
}
