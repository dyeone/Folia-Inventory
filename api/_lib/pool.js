// For Sale tab server actions (routed from api/items.js — the function cap
// means no new api file). Plants ready for sale join ONE pool (2026-11-19,
// operator: "only have one pool… select some and push to website"); the
// salePool value says whether the plant is also on the website:
//   'palmstreet'  in the pool only (the Palmstreet CSV, sale events)
//   'shopify'     pushed to the website — synced to the brand's Shopify
//                 store by api/_lib/shopify.js
// (the values predate the single pool; the 0052 check constraint keeps
// them). Joining the pool gives the plant its short code — A1, A2 …, a new
// letter once the pool has been emptied (api/_lib/saleCode.js, below). Sale events on the tab's calendar are ordinary
// `sales` rows; putting plants into one is the same staging write the Pre
// Sale tab makes (saleId, un-numbered).
import { supabase, seesCosts, runsForSale, hasRole } from './supabase.js';
import { fetchAllById } from './fetchAll.js';
import { CODE_LETTERS, SERIES_MAX, parseSeriesCode, seriesCode, nextSeries, seriesMax } from './saleCode.js';
import { shopifyConfig, shopifyPublicState, reconcileShopify, pullShopifyOrders, dismissShopifyProblems, eventHolds } from './shopify.js';
import { refreshPhotoUrls } from './itemPhotos.js';

export const POOLS = ['palmstreet', 'shopify'];
// A plant can join a pool while it's in stock and in no box.
export const FOR_SALE_STATUSES = ['available', 'listed', 'acclimated'];
// Sale events take what the Pre Sale tab takes.
const EVENT_STATUSES = ['available', 'listed'];
const MAX_IDS = 500;

const fail = (status, message) => { const e = new Error(message); e.status = status; return e; };

export function isUnmigrated(error) {
  return !!error && (error.code === '42703' || error.code === 'PGRST204'
    || /saleCode|salePool|poolAddedAt|videoUrl|"shopify"/.test(error.message || ''));
}
const unmigrated = () => fail(409, 'The For Sale tab needs migration 0052 (for_sale_pools) — run it in the Supabase SQL editor first');
const dbFail = (error) => (isUnmigrated(error) ? unmigrated() : fail(500, error.message));

function stripCosts(user) {
  return (row) => {
    if (seesCosts(user)) return row;
    const { grossCost, netCost, cost, ...rest } = row;
    return rest;
  };
}

// Admins and the CEO run the For Sale tab.
function requireForSaleUser(user) {
  if (!runsForSale(user)) throw fail(403, 'Only admins and the CEO can change For Sale');
}

function requireAdminUser(user) {
  if (!hasRole(user, 'admin')) throw fail(403, 'Only admins can do that');
}

// What's on the website is an admin's call: the CEO runs For Sale but
// can't push plants to the website or take them off it (2026-11-20,
// operator: "for ceo role, disable the push to website function").
const runsWebsite = (user) => hasRole(user, 'admin');

function idList(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IDS) {
    throw fail(400, `itemIds must be a non-empty array (max ${MAX_IDS})`);
  }
  const ids = [...new Set(raw.filter((x) => typeof x === 'string' && x))];
  if (!ids.length) throw fail(400, 'itemIds must be a non-empty array');
  return ids;
}

async function rowsById(brandId, ids) {
  const out = [];
  for (let k = 0; k < ids.length; k += 200) {
    const { data, error } = await supabase.from('inventory_items').select('*')
      .eq('brandId', brandId).in('id', ids.slice(k, k + 200));
    if (error) throw dbFail(error);
    out.push(...(data || []));
  }
  return out;
}

async function ensureMigrated(brandId) {
  const { error } = await supabase.from('inventory_items').select('id, "saleCode", "salePool", "videoUrl", "shopify"').eq('brandId', brandId).limit(1);
  if (error) throw dbFail(error);
}

// GET ?action=pool-status — are the migrations in, and how is Shopify doing.
// photosMigrated: 0053 (photoUrls) — without it a plant's extra photos are
// kept but the CSV and Shopify only get the cover. notesMigrated: 0055
// (videoUrls + staffNote) — without it a plant keeps one video and has no
// note.
export async function poolStatus(req, res, user, brandId) {
  const { error } = await supabase.from('inventory_items').select('id, "saleCode"').eq('brandId', brandId).limit(1);
  if (error && !isUnmigrated(error)) throw fail(500, error.message);
  const { error: pErr } = await supabase.from('inventory_items').select('id, "photoUrls"').eq('brandId', brandId).limit(1);
  const { error: nErr } = await supabase.from('inventory_items').select('id, "videoUrls", "staffNote"').eq('brandId', brandId).limit(1);
  return res.status(200).json({
    migrated: !error, photosMigrated: !pErr, notesMigrated: !nErr,
    codes: await codeState(brandId).catch(() => null),
    shopify: await shopifyPublicState(brandId),
  });
}

// ─── plant codes ────────────────────────────────────────────────────────────
// A1, A2 … A999, then B1 … (api/_lib/saleCode.js). The brand's current
// letter lives in app_settings `salecodes:<brand>` ({ series, startedAt });
// the next number is one past the highest the letter has used.

const CODES_NS = 'salecodes:';
// A series that just started isn't moved on again for a minute, so two
// phones filling an empty pool at the same moment don't skip a letter.
const FRESH_SERIES_MS = 60 * 1000;

async function codeState(brandId) {
  const { data, error } = await supabase.from('app_settings').select('data').eq('id', CODES_NS + brandId).maybeSingle();
  if (error) throw fail(500, error.message);
  const d = data?.data;
  return d && typeof d === 'object' && typeof d.series === 'string' && d.series.length === 1 && CODE_LETTERS.includes(d.series) ? d : null;
}

// A plant keeps its code while it's in the pool, or sold and waiting to
// ship (the code is on its tag and in the order).
const keepsCode = (r) => !r.deletedAt && (
  (r.salePool && !r.shipmentBoxId && FOR_SALE_STATUSES.includes(r.status)) || r.status === 'sold');

// Start `series` at 1. A letter comes round again after Z: its codes from
// that earlier round are released from plants done with them (shipped,
// trashed, out of the pool) — new numbers skip any still kept.
async function startSeries(brandId, series, user) {
  const rows = await fetchAllById(() => supabase.from('inventory_items')
    .select('id, "saleCode", status, "salePool", "deletedAt", "shipmentBoxId"')
    .eq('brandId', brandId).like('saleCode', `${series}%`));
  const free = rows.filter((r) => parseSeriesCode(r.saleCode)?.series === series && !keepsCode(r)).map((r) => r.id);
  for (let k = 0; k < free.length; k += 200) {
    const { error } = await supabase.from('inventory_items').update({ saleCode: null })
      .eq('brandId', brandId).in('id', free.slice(k, k + 200)).like('saleCode', `${series}%`);
    if (error) throw dbFail(error);
  }
  const now = new Date().toISOString();
  const { error } = await supabase.from('app_settings').upsert({
    id: CODES_NS + brandId, data: { series, startedAt: now }, updatedAt: now, updatedBy: user.displayName,
  });
  if (error) throw fail(500, error.message);
  return series;
}

// The letter codes come from now (the first ever is A).
async function currentSeries(brandId, user) {
  return (await codeState(brandId))?.series || startSeries(brandId, 'A', user);
}

// The plants the tab lists (in the pool, still for sale).
const poolQuery = (brandId, cols) => supabase.from('inventory_items').select(cols)
  .eq('brandId', brandId).not('salePool', 'is', null).is('deletedAt', null).is('shipmentBoxId', null)
  .in('status', FOR_SALE_STATUSES);

// The letter for plants joining now. The pool empty means it was cleared
// ("after clear this pool, then start from B1"): the next letter starts.
async function seriesForJoin(brandId, user) {
  const st = await codeState(brandId);
  if (!st) return startSeries(brandId, 'A', user);
  const fresh = Date.now() - Date.parse(st.startedAt || 0) < FRESH_SERIES_MS;
  if (fresh) return st.series;
  const { data, error } = await poolQuery(brandId, 'id').limit(1);
  if (error) throw dbFail(error);
  return (data || []).length ? st.series : startSeries(brandId, nextSeries(st.series), user);
}

// Code the plants in `need` (in that order) from `series`: one past its
// highest number, skipping any taken; past 999 the next letter starts. Each
// write is guarded on the plant's code as read, and a clash on the unique
// index (another phone took that code a moment ago) moves on to the next
// number. Sets r.saleCode on each row.
async function assignCodes(brandId, need, user, series) {
  if (!need.length) return;
  const loadTaken = async () => new Set((await fetchAllById(() => supabase.from('inventory_items')
    .select('id, "saleCode"').eq('brandId', brandId).not('saleCode', 'is', null))).map((r) => r.saleCode));
  let taken = await loadTaken();
  let n = seriesMax(taken, series);
  const nextFree = async () => {
    for (;;) {
      n += 1;
      if (n > SERIES_MAX) {
        series = await startSeries(brandId, nextSeries(series), user);
        taken = await loadTaken();
        n = seriesMax(taken, series);
        continue;
      }
      const code = seriesCode(series, n);
      if (!taken.has(code)) return code;
    }
  };
  const now = new Date().toISOString();
  for (const r of need) {
    for (let attempt = 0; ; attempt++) {
      const code = await nextFree();
      let q = supabase.from('inventory_items')
        .update({ saleCode: code, modifiedAt: now, modifiedBy: user.displayName })
        .eq('id', r.id).eq('brandId', brandId);
      q = r.saleCode ? q.eq('saleCode', r.saleCode) : q.is('saleCode', null);
      const { data, error } = await q.select('id, "saleCode"');
      if (error && error.code === '23505' && attempt < 25) { taken.add(code); continue; }
      if (error) throw dbFail(error);
      taken.add(code);
      if (data && data[0]) r.saleCode = data[0].saleCode;
      else {
        // Someone else re-coded it first — use theirs.
        const { data: cur } = await supabase.from('inventory_items').select('"saleCode"').eq('id', r.id).maybeSingle();
        if (cur?.saleCode) r.saleCode = cur.saleCode;
      }
      break;
    }
  }
}

// POST { action: 'pool-renumber' } — plants in the pool still carrying the
// old random codes ("KM42") get codes in the current letter, the longest in
// the pool first. Their tags need printing again.
export async function poolRenumber(req, res, user, brandId) {
  requireForSaleUser(user);
  await ensureMigrated(brandId);
  const rows = await fetchAllById(() => poolQuery(brandId, '*'));
  const old = rows.filter((r) => !parseSeriesCode(r.saleCode))
    .sort((a, b) => String(a.poolAddedAt || '').localeCompare(String(b.poolAddedAt || ''))
      || String(a.sku).localeCompare(String(b.sku), undefined, { numeric: true }));
  if (!old.length) return res.status(200).json({ items: [] });
  await assignCodes(brandId, old, user, await currentSeries(brandId, user));
  const items = await rowsById(brandId, old.map((r) => r.id));
  // Listings carry the code in their titles: website plants follow now.
  const web = items.filter((r) => r.salePool === 'shopify').map((r) => r.id);
  if (web.length) await followShopify(brandId, web, user);
  return res.status(200).json({ items: items.map(stripCosts(user)) });
}

// POST { action: 'pool-set', itemIds, pool: 'palmstreet' | 'shopify' | null }
// Put plants into the pool (coding them on the way in), push them to the
// website ('shopify') or take them off it ('palmstreet'), or take them out
// of For Sale (null). Shopify listings follow right away when the store is
// connected (best effort — a failure is stored on the plant and retried by
// the next sync).
export async function poolSet(req, res, user, brandId) {
  requireForSaleUser(user);
  const ids = idList(req.body?.itemIds);
  const pool = req.body?.pool ?? null;
  if (pool !== null && !POOLS.includes(pool)) throw fail(400, 'pool must be palmstreet, shopify or null');
  const webOk = runsWebsite(user);
  if (pool === 'shopify' && !webOk) throw fail(403, 'Only an admin can push plants to the website');
  await ensureMigrated(brandId);

  const all = await rowsById(brandId, ids);
  const byId = new Map(all.map((r) => [r.id, r]));
  const skipped = [];
  for (const id of ids) if (!byId.has(id)) skipped.push({ id, reason: 'not found' });
  // Without the website say, a plant on the website stays as it is (taking
  // it off — or out of For Sale — would take it off the website).
  const rows = webOk ? all : all.filter((r) => {
    if (r.salePool !== 'shopify') return true;
    skipped.push({ id: r.id, sku: r.sku, reason: 'is on the website — only an admin can take it off' });
    return false;
  });
  const mine = new Set(rows.map((r) => r.id));
  const now = new Date().toISOString();
  let changed = [];

  if (pool) {
    const ok = [];
    for (const r of rows) {
      if (r.deletedAt) skipped.push({ id: r.id, sku: r.sku, reason: 'in the trash' });
      else if (r.shipmentBoxId) skipped.push({ id: r.id, sku: r.sku, reason: 'already in a shipping box' });
      else if (!FOR_SALE_STATUSES.includes(r.status)) skipped.push({ id: r.id, sku: r.sku, reason: `is ${r.status}` });
      else ok.push(r);
    }
    if (ok.length) {
      // Codes: a plant joining takes the next code of the current letter (a
      // new letter if the pool was empty), unless it already holds one of
      // that letter (out and back in again); one already in the pool keeps
      // its code.
      const joiningRows = ok.filter((r) => !r.salePool);
      const series = joiningRows.length ? await seriesForJoin(brandId, user)
        : ok.some((r) => !r.saleCode) ? await currentSeries(brandId, user) : null;
      if (series) {
        // Numbered in the order sent (the tab sends them in scan order).
        const at = new Map(ids.map((id, i) => [id, i]));
        const need = ok.filter((r) => !r.saleCode || (!r.salePool && parseSeriesCode(r.saleCode)?.series !== series))
          .sort((a, b) => at.get(a.id) - at.get(b.id));
        await assignCodes(brandId, need, user, series);
      }
      // A plant already in the pool keeps its poolAddedAt (the tab lists
      // newest first — pushing one to the website mustn't reorder it); one
      // joining now is stamped. Each write is guarded on the plant still
      // being in (or out of) the pool, as read above.
      const joining = ok.filter((r) => !r.salePool).map((r) => r.id);
      const moving = ok.filter((r) => r.salePool).map((r) => r.id);
      for (const [list, patch, inPool] of [
        [joining, { salePool: pool, poolAddedAt: now }, false],
        [moving, { salePool: pool }, true],
      ]) {
        for (let k = 0; k < list.length; k += 200) {
          let q = supabase.from('inventory_items')
            .update({ ...patch, modifiedAt: now, modifiedBy: user.displayName })
            .eq('brandId', brandId).in('id', list.slice(k, k + 200))
            .is('deletedAt', null).is('shipmentBoxId', null).in('status', FOR_SALE_STATUSES);
          q = inPool ? q.not('salePool', 'is', null) : q.is('salePool', null);
          if (inPool && !webOk) q = q.neq('salePool', 'shopify');
          const { data, error } = await q.select('id');
          if (error) throw dbFail(error);
          changed.push(...(data || []).map((d) => d.id));
        }
      }
      const got = new Set(changed);
      for (const r of ok) if (!got.has(r.id)) skipped.push({ id: r.id, sku: r.sku, reason: 'changed under you — reload' });
      // Photos it already has (the Pre Sale gallery) all go to its listing.
      await refreshPhotoUrls(brandId, changed);
    }
  } else {
    const out = ids.filter((id) => mine.has(id));
    for (let k = 0; k < out.length; k += 200) {
      let q = supabase.from('inventory_items')
        .update({ salePool: null, poolAddedAt: null, modifiedAt: now, modifiedBy: user.displayName })
        .eq('brandId', brandId).in('id', out.slice(k, k + 200)).not('salePool', 'is', null);
      if (!webOk) q = q.neq('salePool', 'shopify');
      const { data, error } = await q.select('id');
      if (error) throw dbFail(error);
      changed.push(...(data || []).map((d) => d.id));
    }
    const got = new Set(changed);
    if (!webOk) for (const id of out) if (!got.has(id) && byId.get(id)?.salePool) skipped.push({ id, sku: byId.get(id).sku, reason: 'changed under you — reload' });
  }

  // Shopify follows: anything that entered or left the Shopify pool.
  let shopify = null;
  const touched = changed.filter((id) => byId.get(id)?.salePool === 'shopify' || pool === 'shopify');
  if (touched.length && shopifyConfig(brandId)) {
    shopify = await reconcileShopify(brandId, { itemIds: touched, user, budgetMs: 25000 }).catch((e) => ({ error: e.message }));
  }
  const items = await rowsById(brandId, changed);
  return res.status(200).json({ items: items.map(stripCosts(user)), skipped, shopify });
}

// POST { action: 'pool-sync', itemIds?, force? } — Shopify both ways: new
// paid orders mark their plants sold and open a box to ship; listings are
// brought in line with the plants (price, photo, video, sold, paused).
// Any brand member (the packer screen calls it too); throttled server-side.
export async function poolSync(req, res, user, brandId) {
  if (!shopifyConfig(brandId)) return res.status(200).json({ configured: false });
  const force = !!req.body?.force && runsForSale(user);
  // Dismissing a problem is just that — no sync rides along.
  if (Array.isArray(req.body?.dismissProblems) && req.body.dismissProblems.length) {
    if (!runsForSale(user)) throw fail(403, 'Only admins and the CEO can dismiss Shopify problems');
    await dismissShopifyProblems(brandId, req.body.dismissProblems.filter((x) => typeof x === 'string'), user);
    return res.status(200).json({ configured: true, dismissed: true, items: [] });
  }
  const ids = Array.isArray(req.body?.itemIds) ? req.body.itemIds.filter((x) => typeof x === 'string').slice(0, MAX_IDS) : null;
  // Orders first (a plant sold on Shopify must not be re-listed below); a
  // failed pull is reported, not fatal — the listings still sync.
  let orders;
  try { orders = await pullShopifyOrders(brandId, { user, force }); } catch (e) { orders = { error: e.message, changedIds: [] }; }
  let listing;
  try {
    listing = await reconcileShopify(brandId, { itemIds: ids && ids.length ? ids : null, user, budgetMs: 35000 });
  } catch (e) { listing = { error: e.message, changedIds: [] }; }
  const changedIds = [...new Set([...(orders.changedIds || []), ...(listing.changedIds || [])])];
  const items = changedIds.length ? await rowsById(brandId, changedIds) : [];
  return res.status(200).json({ configured: true, orders, listing, items: items.map(stripCosts(user)) });
}

// POST { action: 'event-assign', saleId, itemIds, move? } — put plants into a
// sale event from the calendar or a plant's sheet. Same write as the Pre Sale
// tab (un-numbered, stagedAt = now; Palmstreet lineups are numbered there). A
// plant already in another OPEN event stays put (it's in someone's upcoming
// lineup) unless `move` — the person picked this event for it on purpose;
// one left over from a closed event moves. Compare-and-set on the plant's
// current saleId so two devices can't both claim it.
export async function eventAssign(req, res, user, brandId) {
  requireForSaleUser(user);
  const ids = idList(req.body?.itemIds);
  const move = req.body?.move === true;
  const saleId = req.body?.saleId;
  if (!saleId || typeof saleId !== 'string') throw fail(400, 'saleId required');
  const { data: sale, error: sErr } = await supabase.from('sales')
    .select('id, name, status, "itemTypes"').eq('id', saleId).eq('brandId', brandId).maybeSingle();
  if (sErr) throw fail(500, sErr.message);
  if (!sale) throw fail(404, 'Sale event not found');
  if (sale.status === 'closed') throw fail(409, 'That event is closed');

  const rows = await rowsById(brandId, ids);
  const otherIds = [...new Set(rows.map((r) => r.saleId).filter((s) => s && s !== saleId))];
  const openOther = new Map();
  for (let k = 0; k < otherIds.length; k += 200) {
    const { data, error } = await supabase.from('sales').select('id, name, status, date')
      .eq('brandId', brandId).in('id', otherIds.slice(k, k + 200));
    if (error) throw fail(500, error.message);
    // Same rule the Shopify pause uses (eventHolds): an ongoing event from
    // yesterday on keeps its plants; packing / closed / past ones let go.
    for (const s of data || []) if (eventHolds(s)) openOther.set(s.id, s.name);
  }

  const skipped = [];
  const groups = new Map(); // current saleId ('' = none) → ids
  for (const r of rows) {
    let reason = '';
    if (r.deletedAt) reason = 'in the trash';
    else if (r.shipmentBoxId) reason = 'in a shipping box';
    else if (!EVENT_STATUSES.includes(r.status)) reason = `is ${r.status}`;
    else if (r.saleId === saleId) reason = 'already in this event';
    else if (openOther.has(r.saleId) && !move) reason = `in ${openOther.get(r.saleId) || 'another event'}`;
    else if (sale.itemTypes === 'tc' && r.type !== 'tc') reason = 'not a TC (TC-only event)';
    else if (sale.itemTypes === 'plant' && r.type !== 'plant') reason = 'not a plant (plants-only event)';
    if (reason) { skipped.push({ id: r.id, sku: r.sku, reason }); continue; }
    const key = r.saleId || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.id);
  }

  const now = new Date().toISOString();
  const assignedIds = [];
  for (const [cur, gIds] of groups) {
    let q = supabase.from('inventory_items')
      .update({ saleId, lotKind: 'sale', lotNumber: null, stagedAt: now, modifiedAt: now, modifiedBy: user.displayName })
      .eq('brandId', brandId).in('id', gIds)
      .is('deletedAt', null).is('shipmentBoxId', null).in('status', EVENT_STATUSES);
    q = cur ? q.eq('saleId', cur) : q.is('saleId', null);
    const { data, error } = await q.select('id');
    if (error) throw fail(500, error.message);
    assignedIds.push(...(data || []).map((d) => d.id));
  }
  const got = new Set(assignedIds);
  for (const r of rows) {
    if (!got.has(r.id) && !skipped.some((s) => s.id === r.id)) skipped.push({ id: r.id, sku: r.sku, reason: 'changed under you — reload' });
  }

  // A Shopify listing pauses while its plant sits in an open event (not a
  // website sale) — and comes back when it moves into one.
  const shopIds = rows.filter((r) => got.has(r.id) && r.salePool === 'shopify').map((r) => r.id);
  const shopify = shopIds.length && shopifyConfig(brandId)
    ? await reconcileShopify(brandId, { itemIds: shopIds, user, budgetMs: 20000 }).catch((e) => ({ error: e.message }))
    : null;
  const items = await rowsById(brandId, assignedIds);
  return res.status(200).json({ assignedIds, skipped, items: items.map(stripCosts(user)), shopify });
}

// POST { action: 'event-unassign', saleId, itemIds } — take unsold plants
// back out of an event (their staging is cleared, like Pre Sale's remove).
export async function eventUnassign(req, res, user, brandId) {
  requireForSaleUser(user);
  const ids = idList(req.body?.itemIds);
  const saleId = req.body?.saleId;
  if (!saleId || typeof saleId !== 'string') throw fail(400, 'saleId required');
  const now = new Date().toISOString();
  const { data, error } = await supabase.from('inventory_items')
    .update({ saleId: null, lotKind: 'sale', lotNumber: null, stagedAt: null, modifiedAt: now, modifiedBy: user.displayName })
    .eq('brandId', brandId).eq('saleId', saleId).in('id', ids)
    .in('status', EVENT_STATUSES).is('shipmentBoxId', null)
    .select('id, "salePool"');
  if (error) throw dbFail(error);
  const removedIds = (data || []).map((d) => d.id);
  const shopIds = (data || []).filter((d) => d.salePool === 'shopify').map((d) => d.id);
  const shopify = shopIds.length && shopifyConfig(brandId)
    ? await reconcileShopify(brandId, { itemIds: shopIds, user, budgetMs: 20000 }).catch((e) => ({ error: e.message }))
    : null;
  const items = await rowsById(brandId, removedIds);
  return res.status(200).json({ removedIds, items: items.map(stripCosts(user)), shopify });
}

// POST { action: 'media-cleanup', dryRun, days } — free storage: delete the
// photos and videos of plants that are done (shipped/delivered more than
// `days` ago, or in the trash). Sold plants still waiting to ship keep
// theirs (the packer may need them). Admin only.
const PHOTO_BUCKET = 'plant-photos';
const VIDEO_BUCKET = 'plant-videos';
export async function mediaCleanup(req, res, user, brandId) {
  requireAdminUser(user);
  const dryRun = req.body?.dryRun !== false;
  const days = Math.max(0, Math.min(365, parseInt(req.body?.days, 10) || 14));
  const cutoff = Date.now() - days * 86400000;
  const done = (i) => !!i.deletedAt
    || (['shipped', 'delivered'].includes(i.status) && (!i.shippedAt || Date.parse(i.shippedAt) < cutoff));

  const photos = await fetchAllById(() => supabase.from('item_photos')
    .select('id, "itemId", "storagePath"').eq('brandId', brandId));
  const ids = [...new Set(photos.map((p) => p.itemId))];
  const items = new Map();
  for (let k = 0; k < ids.length; k += 200) {
    const { data, error } = await supabase.from('inventory_items')
      .select('id, status, "deletedAt", "shippedAt", "imageUrl"').in('id', ids.slice(k, k + 200));
    if (error) throw fail(500, error.message);
    for (const i of data || []) items.set(i.id, i);
  }
  // A file can be another plant's photo too (a copied row keeps the URL):
  // never delete one a plant still for sale points at.
  const inUse = new Set();
  {
    const base = supabase.storage.from(PHOTO_BUCKET).getPublicUrl('').data.publicUrl.replace(/\/$/, '');
    const pathOf = (u) => (typeof u === 'string' && u.startsWith(`${base}/`) ? u.slice(base.length + 1).split('?')[0] : null);
    const refs = await fetchAllById(() => supabase.from('inventory_items')
      .select('id, status, "deletedAt", "shippedAt", "imageUrl", "photoUrls"').eq('brandId', brandId).not('imageUrl', 'is', null))
      .catch(() => fetchAllById(() => supabase.from('inventory_items')      // before 0053
        .select('id, status, "deletedAt", "shippedAt", "imageUrl"').eq('brandId', brandId).not('imageUrl', 'is', null)));
    for (const r of refs) {
      if (done(r)) continue;
      for (const u of [r.imageUrl, ...(Array.isArray(r.photoUrls) ? r.photoUrls : [])]) { const p = pathOf(u); if (p) inUse.add(p); }
    }
  }
  const photoTargets = photos.filter((p) => { const i = items.get(p.itemId); return (!i || done(i)) && !inUse.has(p.storagePath); });

  let videoRows = [];
  {
    const rows = await fetchAllById(() => supabase.from('inventory_items')
      .select('id, status, "deletedAt", "shippedAt", "videoUrl"').eq('brandId', brandId).not('videoUrl', 'is', null))
      .catch((e) => { if (isUnmigrated(e)) return []; throw e; });
    videoRows = rows.filter(done);
  }

  if (dryRun) {
    return res.status(200).json({ dryRun: true, days, photos: photoTargets.length, videos: videoRows.length });
  }

  let photosDeleted = 0;
  for (let k = 0; k < photoTargets.length; k += 100) {
    const chunk = photoTargets.slice(k, k + 100);
    const { error } = await supabase.storage.from(PHOTO_BUCKET).remove(chunk.map((p) => p.storagePath));
    if (error) throw fail(500, error.message);
    const { error: dErr } = await supabase.from('item_photos').delete().in('id', chunk.map((p) => p.id));
    if (dErr) throw fail(500, dErr.message);
    photosDeleted += chunk.length;
  }
  const photoBase = supabase.storage.from(PHOTO_BUCKET).getPublicUrl('items/').data.publicUrl;
  const clearImage = [...new Set(photoTargets.map((p) => p.itemId))]
    .filter((id) => items.get(id)?.imageUrl?.startsWith(`${photoBase}${id}/`));
  for (let k = 0; k < clearImage.length; k += 200) {
    await supabase.from('inventory_items').update({ imageUrl: null }).in('id', clearImage.slice(k, k + 200));
  }
  // Their photo lists follow what's left (0053; a no-op before it).
  await refreshPhotoUrls(brandId, [...new Set(photoTargets.map((p) => p.itemId))]);

  let videosDeleted = 0;
  for (const v of videoRows) {
    const folder = `items/${v.id}`;
    const { data: objs } = await supabase.storage.from(VIDEO_BUCKET).list(folder, { limit: 100 });
    const paths = (objs || []).map((o) => `${folder}/${o.name}`);
    if (paths.length) {
      const { error } = await supabase.storage.from(VIDEO_BUCKET).remove(paths);
      if (error) throw fail(500, error.message);
    }
    const { error: vErr } = await supabase.from('inventory_items').update({ videoUrl: null, videoUrls: null }).eq('id', v.id).eq('brandId', brandId);
    if (vErr) await supabase.from('inventory_items').update({ videoUrl: null }).eq('id', v.id).eq('brandId', brandId);   // before 0055
    videosDeleted += 1;
  }
  return res.status(200).json({ dryRun: false, days, photos: photosDeleted, videos: videosDeleted });
}

// After any other write to plants (the generic save, trash, Validate Sales,
// Pre Sale staging): bring the Shopify listings of the ones in the Shopify
// pool — or still listed there — in line now, so a plant sold or staged
// elsewhere leaves the store at once instead of at the next poll. Best
// effort and short (the next poll is the safety net); never throws.
export async function followShopify(brandId, ids, user) {
  try {
    if (!ids?.length || !shopifyConfig(brandId)) return;
    const hit = [];
    for (let k = 0; k < ids.length && k < 1000; k += 200) {
      const { data, error } = await supabase.from('inventory_items').select('id, "salePool", shopify')
        .eq('brandId', brandId).in('id', ids.slice(k, k + 200));
      if (error) return;   // e.g. before migration 0052
      for (const r of data || []) if (r.salePool === 'shopify' || r.shopify?.productId) hit.push(r.id);
    }
    if (hit.length) await reconcileShopify(brandId, { itemIds: hit, user, budgetMs: 8000 });
  } catch { /* the next poll retries */ }
}
