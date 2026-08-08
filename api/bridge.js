import { supabase, requireAdmin, requireBrand, brandIdFromReq, newId, DEFAULT_BRAND } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';
import { randomBytes } from 'node:crypto';

// Routes the local Folia Bridge talks to. The bridge polls outbound from
// the operator's Mac because it can't accept inbound from Vercel (mixed
// content + NAT). Three actions:
//
//   POST  ?action=enqueue          web → enqueue a job  (user auth)
//   POST  ?action=generate-token   web → mint bridge token (user auth)
//   GET   ?action=next             bridge → claim oldest pending (bridge auth)
//   POST  ?action=complete         bridge → report done/failed   (bridge auth)
//   GET   ?action=mac-version      mac app → latest published build (public)
//
// Bridge auth = Authorization: Bearer <users.bridgeToken>. User auth =
// userId in query (GET) or body (POST), matching the rest of the API.

// How long a 'running' job can sit before /next is allowed to re-claim
// it. Covers a bridge crash mid-job. Tune up if real ADB sequences
// routinely take longer than this.
const STALE_RUNNING_MS = 60_000;

async function requireBridgeUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    const e = new Error('Bridge token required'); e.status = 401; throw e;
  }
  const { data, error } = await supabase
    .from('users')
    .select('id, role, active, "displayName"')
    .eq('bridgeToken', token)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!data || !data.active) {
    const e = new Error('Invalid bridge token'); e.status = 401; throw e;
  }
  return data;
}

export default wrap(async (req, res) => {
  const action = req.method === 'GET' ? req.query?.action : req.body?.action;
  if (!action) { const e = new Error('action required'); e.status = 400; throw e; }

  switch (action) {
    case 'generate-token':  return generateToken(req, res);
    case 'enqueue':         return enqueue(req, res);
    case 'next':            return next(req, res);
    case 'complete':        return complete(req, res);
    case 'status':          return status(req, res);
    case 'health':          return health(req, res);
    case 'mac-version':     return macVersion(req, res);
    case 'packing-status':  return packingStatus(req, res);
    case 'live-show':       return liveShow(req, res);
    default: {
      const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
    }
  }
});

// Mint (or rotate) a bridge token for the calling user. Returns the
// plaintext token once — there's no way to recover it later, since we
// don't store anything alongside it that would let us re-derive it.
//
// Admin-only: a bridge token grants ADB-level control over the
// operator's phone, which can drive Palmstreet on behalf of the user.
// Staff and packer roles should never be able to mint one.
async function generateToken(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireAdmin(req.body?.userId);
  const token = randomBytes(32).toString('hex');
  const { error } = await supabase
    .from('users')
    .update({ bridgeToken: token })
    .eq('id', user.id);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ token });
}

async function enqueue(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const { user, brandId } = await requireBrand(req.body?.userId, brandIdFromReq(req));
  const { jobAction, payload } = req.body || {};
  if (!jobAction || typeof jobAction !== 'string') {
    const e = new Error('jobAction required'); e.status = 400; throw e;
  }
  const job = {
    id: newId(),
    status: 'queued',
    action: jobAction,
    payload: payload && typeof payload === 'object' ? payload : {},
    createdBy: user.displayName || user.id,
    brandId,
  };
  const { error } = await supabase.from('bridge_jobs').insert(job);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ job });
}

// Job routing by bridge role. The queue is one global per-account stream, so
// when an operator runs two bridges (one driving the phone for Palmstreet, one
// attached to the label printers) they'd otherwise race for every job — the
// phone machine grabs a print job it can't fulfil ("unknown action: print"),
// the printer machine grabs a Palmstreet tap. A bridge declares its role on
// /next and only claims matching jobs:
//   'printer'    → ONLY print jobs
//   'all'        → everything (explicit; a single Mac that has phone + printers)
//   'palmstreet' → only non-print (adb) jobs
//   anything else / ABSENT → only non-print jobs
//
// The key rule: a print job is only ever handed to a bridge that explicitly
// asked for it ('printer' or 'all'). Legacy bridges (old code that predates
// printing) send no role at all, so they fall into the default and are kept
// away from print jobs — which is exactly what stops an un-updated Palmstreet
// machine from stealing prints and rejecting them. No update needed on it.
function roleActionFilter(query, role) {
  if (role === 'printer') return query.eq('action', 'print');
  if (role === 'all') return query;
  return query.neq('action', 'print');
}

// Try once to claim the oldest queued (or stale-running) job this bridge's role
// is allowed to handle. Atomic via CAS: select candidate, then guarded UPDATE
// on its prior status. If 0 rows return, another bridge raced us; treat as
// "nothing claimed".
async function tryClaim(user, role, brand) {
  const staleCutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
  let query = roleActionFilter(
    supabase
      .from('bridge_jobs')
      .select('*')
      .or(`status.eq.queued,and(status.eq.running,claimedAt.lt.${staleCutoff})`),
    role,
  );
  // Optional brand pin: a bridge launched with BRIDGE_BRAND only claims that
  // brand's jobs. Unset = claim every brand (the normal single-Mac setup).
  if (brand) query = query.eq('brandId', brand);
  const { data: candidate, error: selErr } = await query
    .order('createdAt', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (selErr) { const e = new Error(selErr.message); e.status = 500; throw e; }
  if (!candidate) return null;

  const { data: claimed, error: updErr } = await supabase
    .from('bridge_jobs')
    .update({
      status: 'running',
      claimedAt: new Date().toISOString(),
      claimedBy: user.displayName || user.id,
    })
    .eq('id', candidate.id)
    .eq('status', candidate.status)  // CAS guard against races
    .select()
    .maybeSingle();
  if (updErr) { const e = new Error(updErr.message); e.status = 500; throw e; }
  return claimed || null;
}

// Long-poll for the next job. The bridge used to short-poll every 500 ms
// — that meant ~250 ms of dead time on every scan between the operator
// tapping the SKU and the bridge issuing its first ADB call. Holding the
// request open server-side until a job lands collapses that gap to just
// the network RTT (~80–150 ms).
//
// Vercel Hobby caps function duration at 10 s, so we deadline ~9 s and
// fall back to a null response, which the bridge treats like a normal
// idle tick and immediately re-polls.
const NEXT_LONG_POLL_MS = 9_000;
const NEXT_POLL_INTERVAL_MS = 200;

async function next(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const user = await requireBridgeUser(req);
  const role = (req.query?.role || '').toString().toLowerCase();
  const brand = (req.query?.brand || '').toString().toLowerCase();

  // Heartbeat. /health reads this to decide if the bridge is online.
  // With long-poll, the bridge issues at most one request per ~9 s when
  // idle, so HEARTBEAT_FRESH_MS has to be wider than the long-poll
  // deadline — see the constant for the calculation.
  await supabase
    .from('users')
    .update({ bridgeLastSeen: new Date().toISOString() })
    .eq('id', user.id);

  const deadline = Date.now() + NEXT_LONG_POLL_MS;
  while (true) {
    const claimed = await tryClaim(user, role, brand);
    if (claimed) return res.status(200).json({ job: claimed });
    if (Date.now() >= deadline) return res.status(200).json({ job: null });
    await new Promise(r => setTimeout(r, NEXT_POLL_INTERVAL_MS));
  }
}

// Bulk status lookup for the UI's polling loop. ?ids=a,b,c — at most 32
// at a time so the URL stays short and the SELECT is bounded.
async function status(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const { brandId } = await requireBrand(req.query?.userId, brandIdFromReq(req));
  const raw = (req.query?.ids || '').toString();
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 32);
  if (ids.length === 0) return res.status(200).json({ jobs: [] });
  const { data, error } = await supabase
    .from('bridge_jobs')
    .select('id, status, action, payload, result, error, "createdAt", "claimedAt", "completedAt"')
    .in('id', ids)
    .eq('brandId', brandId);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return res.status(200).json({ jobs: data || [] });
}

// Liveness signal for the UI's "bridge online" indicator. Reads the
// explicit heartbeat that /next writes at the start of every long-poll
// cycle. With long-poll on, the bridge writes a heartbeat at most every
// NEXT_LONG_POLL_MS (9 s) when idle, so the freshness window has to be
// wider than the long-poll deadline plus one full poll round-trip.
// 15 s = 9 s deadline + ~1 s RTT + ~5 s grace.
const HEARTBEAT_FRESH_MS = 15_000;

async function health(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const { brandId } = await requireBrand(req.query?.userId, brandIdFromReq(req));
  const [{ data: heartbeatRow }, { count: queuedCount }] = await Promise.all([
    supabase.from('users')
      .select('bridgeLastSeen')
      .not('bridgeLastSeen', 'is', null)
      .order('bridgeLastSeen', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from('bridge_jobs')
      .select('id', { count: 'exact', head: true }).eq('status', 'queued').eq('brandId', brandId),
  ]);
  const lastSeen = heartbeatRow?.bridgeLastSeen || null;
  const online = !!lastSeen && (Date.now() - new Date(lastSeen).getTime()) < HEARTBEAT_FRESH_MS;
  return res.status(200).json({
    online,
    lastSeen,
    queued: queuedCount || 0,
  });
}

// Update check for the macOS Bridge app. Public — no auth: the app polls
// this on launch and on demand, possibly before a bridge token is set, and
// the payload is non-sensitive (a version string + a public DMG URL). The
// release pointer lives in app_settings(id='mac_release') so shipping a new
// build is a one-row bump, no API redeploy:
//
//   { version: "0.2.2",
//     url:     "https://…/Folia Bridge-0.2.2-universal.dmg",
//     notes:   "What changed in this build" }
//
// When no row exists yet, every field comes back null and the app treats
// that as "nothing published" (no false update prompt).
async function macVersion(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const { data, error } = await supabase
    .from('app_settings')
    .select('data')
    .eq('id', 'mac_release')
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  const rel = data?.data || {};
  return res.status(200).json({
    version: rel.version || null,
    url: rel.url || null,
    notes: rel.notes || null,
  });
}

// Glanceable packing progress for the Mac app's dashboard widget. Bridge
// auth — the app already holds the token, so no userId/brand round-trip.
// Boxes derive from items' shipmentBoxId, mirroring the packer UI: a box is
// "open" while it still has a 'sold' item, and "ready" once every sold item
// carries packedAt. `since` (ISO — the app passes its local midnight) scopes
// the shipped-today count and bounds how many shipped rows we ever read.
async function packingStatus(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  await requireBridgeUser(req);
  const sinceRaw = (req.query?.since || '').toString();
  let since = null;
  if (sinceRaw) {
    const parsed = Date.parse(sinceRaw);
    if (Number.isNaN(parsed)) { const e = new Error('invalid since'); e.status = 400; throw e; }
    // Clamp to 7 days back. The widget only ever asks for local midnight; the
    // clamp keeps a stale or hostile token holder from forcing full-history
    // scans (`since=1970-01-01`) on every poll.
    since = new Date(Math.max(parsed, Date.now() - 7 * 24 * 60 * 60 * 1000)).toISOString();
  }

  // Page through every matching item — a live week tops Supabase's 1000-row
  // cap, and a truncated read undercounts silently. Ordered by id: offset
  // pagination without ORDER BY lets Postgres reshuffle rows between pages,
  // which duplicates or drops items exactly when the count matters.
  const PAGE = 1000;
  const MAX_PAGES = 20;
  const items = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE;
    let q = supabase
      .from('inventory_items')
      .select('"brandId", status, "shipmentBoxId", "packedAt", "shippedAt", "deletedAt"')
      .not('shipmentBoxId', 'is', null);
    // `since` here is ONLY ever the clamped, re-serialized ISO string above —
    // never interpolate raw query input into this .or() filter (PostgREST
    // or-syntax injection: `,` `(` `)` are metacharacters).
    q = since
      ? q.or(`status.eq.sold,and(status.eq.shipped,shippedAt.gte.${since})`)
      : q.eq('status', 'sold');
    const { data, error } = await q.order('id').range(from, from + PAGE - 1);
    if (error) { const e = new Error(error.message); e.status = 500; throw e; }
    items.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  // brand → box → tallies. Soft-deleted rows are ghosts to the packer UI, so
  // they're ghosts here too.
  const brands = new Map();
  for (const it of items) {
    if (it.deletedAt) continue;
    const brandId = it.brandId || DEFAULT_BRAND;
    let boxes = brands.get(brandId);
    if (!boxes) { boxes = new Map(); brands.set(brandId, boxes); }
    let box = boxes.get(it.shipmentBoxId);
    if (!box) { box = { sold: 0, packed: 0, shippedSince: false }; boxes.set(it.shipmentBoxId, box); }
    if (it.status === 'sold') {
      box.sold += 1;
      if (it.packedAt) box.packed += 1;
    }
    if (since && it.shippedAt && Date.parse(it.shippedAt) >= Date.parse(since)) box.shippedSince = true;
  }

  const brandIds = [...brands.keys()];
  let namesById = {};
  if (brandIds.length) {
    // Degrade to raw brand ids if the lookup fails — but say so in the logs.
    const { data: rows, error: bErr } = await supabase.from('brands').select('id,name').in('id', brandIds);
    if (bErr) console.warn('packing-status: brands lookup failed:', bErr.message);
    namesById = Object.fromEntries((rows || []).map(r => [r.id, r.name]));
  }

  const out = brandIds.map(id => {
    let boxesOpen = 0, boxesReady = 0, plantsTotal = 0, plantsPacked = 0, boxesShipped = 0;
    for (const box of brands.get(id).values()) {
      if (box.sold > 0) {
        boxesOpen += 1;
        plantsTotal += box.sold;
        plantsPacked += box.packed;
        if (box.packed === box.sold) boxesReady += 1;
      } else if (box.shippedSince) {
        boxesShipped += 1;
      }
    }
    return { brandId: id, name: namesById[id] || id, boxesOpen, boxesReady, plantsTotal, plantsPacked, boxesShipped };
  }).filter(b => b.boxesOpen > 0 || b.boxesShipped > 0)
    .sort((a, b) => b.plantsTotal - a.plantsTotal);

  return res.status(200).json({ brands: out, at: new Date().toISOString() });
}

// Latest live-show state for the Mac app's Show monitor. The Chrome
// extension writes it during a live via /api/settings live-show-save; this
// is the bridge-token read. ?brand= pins a brand; absent, the most recently
// updated brand's show wins (one live runs at a time in practice).
async function liveShow(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  await requireBridgeUser(req);
  const brand = (req.query?.brand || '').toString().trim().toLowerCase();
  let q = supabase
    .from('app_settings')
    .select('id, data, "updatedAt"')
    .like('id', 'live_show:%');
  if (brand) q = q.eq('id', `live_show:${brand}`);
  const { data, error } = await q.order('updatedAt', { ascending: false }).limit(1);
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  const row = data?.[0] || null;
  return res.status(200).json({
    show: row?.data || null,
    updatedAt: row?.updatedAt || null,
    brandId: row ? row.id.slice('live_show:'.length) : null,
  });
}

async function complete(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  await requireBridgeUser(req);
  const { id, result, error: errMsg } = req.body || {};
  if (!id) { const e = new Error('job id required'); e.status = 400; throw e; }
  const status = errMsg ? 'failed' : 'done';
  const { data, error } = await supabase
    .from('bridge_jobs')
    .update({
      status,
      result: result ?? null,
      error: errMsg || null,
      completedAt: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  if (!data) { const e = new Error('Job not found'); e.status = 404; throw e; }
  return res.status(200).json({ job: data });
}
