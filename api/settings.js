import { supabase, requireAdmin, requireBrand, brandIdFromReq, newId } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Single-row JSON blob per settings id. Currently used only for
// id='shipping' (ship-from address + ShipStation defaults), but the
// shape lets us add other namespaces (id='financial', etc.) without
// new endpoints.

export default wrap(async (req, res) => {
  // ── Public, unauthenticated read of published landing content ──
  // The BAE landing site lives on a separate origin and fetches this from the
  // browser to render whatever the admin published. Marketing copy is public by
  // nature, so there's no auth gate; CORS is opened so the cross-origin fetch
  // succeeds. Handled before requireBrand so no session is needed.
  if (req.method === 'GET' && req.query?.action === 'landing-public') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const pubBrand = String(req.query?.brandId || '').trim();
    if (!pubBrand) { const e = new Error('brandId required'); e.status = 400; throw e; }
    return res.status(200).json({ content: await loadLanding(pubBrand) });
  }

  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  // Resolve the active brand alongside the user. Tasks (per-user) and generic
  // settings (id='shipping', currently shared) ignore brandId; care calendars
  // are brand-scoped and use it.
  const { user, brandId } = await requireBrand(userId, brandIdFromReq(req));

  // Personal GTD tasks (private per user) are served from this same
  // function. Vercel Hobby caps a deployment at 12 serverless functions and
  // we are exactly at the cap, so a dedicated /api/tasks route isn't an
  // option. Tasks live as a per-user JSON blob in app_settings keyed
  // `tasks:<userId>` — no migration needed, and each user only ever reads or
  // writes their own row (admins may additionally assign into another user's
  // row, see handleTasks). Dispatched before the settings `id` check below.
  const action = req.method === 'GET' ? req.query?.action : req.body?.action;
  if (typeof action === 'string' && action.startsWith('task-')) {
    return handleTasks(action, req, res, user);
  }
  // Plant Care calendars — shared operational schedules (one row per calendar,
  // id `care-cal:<id>`). Same rationale as tasks: no new serverless function,
  // no migration. Anyone may view + check off a task; only admins create,
  // edit, or delete a calendar.
  if (typeof action === 'string' && action.startsWith('care-')) {
    return handleCare(action, req, res, user, brandId);
  }
  // BAE landing-page CMS — one brand-scoped JSON blob (id `landing:<brandId>`)
  // that the public BAE landing site reads (via the `landing-public` branch
  // above). Same no-new-function / no-migration rationale as tasks + care.
  // Authed read for the in-app editor; admin-only save.
  if (typeof action === 'string' && action.startsWith('landing-')) {
    return handleLanding(action, req, res, user, brandId);
  }
  // BAE loyalty program admin (config + reward fulfillment). Unlike the other
  // groups, the data lives in real tables (migration 0034) — the customer app
  // reads them directly via Supabase RLS — but staff access still rides this
  // function for the same no-new-function reason.
  if (typeof action === 'string' && action.startsWith('loyalty-')) {
    return handleLoyalty(action, req, res, user, brandId);
  }
  // Lineup running index — one brand-scoped counter so sales within a week
  // number continuously inside the week's lot block (src/sales/lotBlock.js).
  // Any active user in the brand may read + advance it; same no-new-function
  // rationale as the groups above.
  if (typeof action === 'string' && action.startsWith('lineup-')) {
    return handleLineup(action, req, res, user, brandId);
  }
  // Palmstreet follower monitor — live follower count for the brand's store,
  // scraped server-side from the public profile page (the browser can't:
  // palmstreet.app sends no CORS headers). Config is one brand-scoped row.
  if (typeof action === 'string' && action.startsWith('palmstreet-')) {
    return handlePalmstreet(action, req, res, user, brandId);
  }
  // Live show monitor — the Chrome extension watches the Palmstreet seller
  // dashboard during a live and keeps the whole show state here (one
  // brand-scoped row); the Mac app reads it via /api/bridge?action=live-show.
  // Same no-new-function rationale as the groups above.
  if (typeof action === 'string' && action.startsWith('live-show-')) {
    return handleLiveShow(action, req, res, user, brandId);
  }

  const id = req.method === 'GET' ? req.query?.id : req.body?.id;
  if (!id) {
    const e = new Error('id required'); e.status = 400; throw e;
  }

  switch (req.method) {
    case 'GET': {
      const { data, error } = await supabase
        .from('app_settings')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ settings: data || { id, data: {} } });
    }
    case 'PUT': {
      // Settings edits are admin-gated — ship-from + ShipStation defaults
      // are operationally sensitive (wrong address = misdelivered labels).
      await requireAdmin(userId);
      const data = req.body?.data;
      if (!data || typeof data !== 'object') {
        const e = new Error('data (object) required'); e.status = 400; throw e;
      }
      const { data: row, error } = await supabase
        .from('app_settings')
        .upsert({ id, data, updatedAt: new Date().toISOString(), updatedBy: userId })
        .select()
        .single();
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ settings: row });
    }
    default:
      return methodNotAllowed(res, ['GET', 'PUT']);
  }
});

// ----------------------------------------------------------------------------
// Live show monitor — one brand-scoped row (id `live_show:<brandId>`) holding
// the current/most-recent show as one JSON blob:
//   { showId, title, startedAt, totals: { gross, net, orders, entries },
//     current: { lot, title, price, bids: [{t, price}] },
//     sold: [{ at, lot, title, price, buyer, startedAt, bids }], raw }
// The Chrome extension (live-monitor.js) is the ONLY writer and owns the
// whole state, so save is a full replace — no server-side merge to get wrong;
// on a mid-show page reload it re-seeds itself from live-show-get first.
// Caps bound every growable part: the scraper runs unattended for hours.
// ----------------------------------------------------------------------------

const LIVE_SHOW_NS = 'live_show:';
const LIVE_SHOW_MAX_SOLD = 800;
const LIVE_SHOW_MAX_BIDS = 80;
const LIVE_SHOW_MAX_RAW = 4000;

function cappedBids(list) {
  return (Array.isArray(list) ? list : []).slice(-LIVE_SHOW_MAX_BIDS);
}

async function handleLiveShow(action, req, res, user, brandId) {
  const id = LIVE_SHOW_NS + brandId;
  switch (action) {
    case 'live-show-get': {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
      const { data, error } = await supabase
        .from('app_settings').select('data, "updatedAt"').eq('id', id).maybeSingle();
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ show: data?.data || null, updatedAt: data?.updatedAt || null });
    }
    case 'live-show-save': {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const show = req.body?.show;
      if (!show || typeof show !== 'object' || !show.showId) {
        const e = new Error('show (object with showId) required'); e.status = 400; throw e;
      }
      const clean = {
        ...show,
        raw: typeof show.raw === 'string' ? show.raw.slice(0, LIVE_SHOW_MAX_RAW) : undefined,
        current: show.current && typeof show.current === 'object'
          ? { ...show.current, bids: cappedBids(show.current.bids) }
          : null,
        sold: (Array.isArray(show.sold) ? show.sold : [])
          .slice(-LIVE_SHOW_MAX_SOLD)
          .map(s => ({ ...s, bids: cappedBids(s?.bids) })),
      };
      const { error } = await supabase
        .from('app_settings')
        .upsert({ id, data: clean, updatedAt: new Date().toISOString(), updatedBy: user.id });
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
    }
    default: {
      const e = new Error(`Unknown action: ${action}`); e.status = 400; throw e;
    }
  }
}

// ----------------------------------------------------------------------------
// Lineup running index — one brand-scoped row (id `lineup-counter:<brand>`)
// holding per-week counters: { weeks: { "<lotWeek>": next, ... }, next }.
// Each week's counter is advance-only (Tue ends 258 → Fri starts at 259) and
// independent of the others, so renumbering an old week's sale or pre-numbering
// next week's can never walk another week's count back. A week's first read
// starts at its own 200-number block (src/sales/lotBlock.js) — or continues a
// counter another week left INSIDE this block (a >200-lot spill, or the
// pre-week-scoping legacy `next`), so spilled numbers are never re-minted.
// Weekless calls from stale clients keep legacy single-counter behavior.
// Any active user in the brand may read + advance it (numbering is a routine
// operator action, not admin-gated). No new function, no migration.
// ----------------------------------------------------------------------------

const LINEUP_NS = 'lineup-counter:';

// Every positive counter value in the row: per-week entries plus the legacy
// weekless `next` (still maintained for stale clients).
function lineupValues(d) {
  return [...Object.values(d?.weeks || {}), d?.next]
    .map(Number).filter(v => Number.isFinite(v) && v > 0);
}

// Server-side lot week — mirrors src/sales/lotBlock.js lotWeek but UTC-based
// (it only bounds client-sent weeks, where ±1 doesn't matter). Weeks are
// client data: without a plausibility window, one typo'd 2027 sale date would
// prune every real week's entry and then keep pruning each new bump forever.
const LOT_WEEK_EPOCH = Date.UTC(2024, 0, 1); // Monday
function currentLotWeek() {
  const now = new Date();
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),
    now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  return Math.round((monday - LOT_WEEK_EPOCH) / (7 * 24 * 60 * 60 * 1000));
}

async function handleLineup(action, req, res, user, brandId) {
  const id = LINEUP_NS + brandId;
  switch (action) {
    case 'lineup-get': {
      const { data, error } = await supabase
        .from('app_settings').select('data').eq('id', id).maybeSingle();
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      const d = data?.data || {};
      const week = Math.floor(Number(req.query?.week));
      const blockStart = Math.floor(Number(req.query?.blockStart));
      const blockEnd = Math.floor(Number(req.query?.blockEnd));
      if (Number.isFinite(week) && Number.isFinite(blockStart)) {
        // The week continues its own counter, never below its block start.
        // Any OTHER counter value sitting inside this block means those
        // numbers are already on printed labels (a spilled week, or the legacy
        // counter at deploy time) — continue above them, don't re-mint. The
        // bound is end+1 because a stored next of exactly end+1 means the
        // whole block is consumed — answering blockStart there would make
        // every number in the block a duplicate of a printed label.
        const end = Number.isFinite(blockEnd) ? blockEnd : blockStart + 199;
        const own = Number(d.weeks?.[week]);
        const inBlock = lineupValues(d).filter(v => v > blockStart && v <= end + 1);
        const next = Math.max(
          blockStart,
          Number.isFinite(own) && own > 0 ? own : 1,
          ...inBlock,
        );
        return res.status(200).json({ next });
      }
      // Weekless (stale client): the old single running counter — the max of
      // everything ever handed out, so it can only over-shoot, never collide.
      const all = lineupValues(d);
      return res.status(200).json({ next: all.length ? Math.max(...all) : 1 });
    }
    case 'lineup-bump': {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const incoming = Math.floor(Number(req.body?.next));
      if (!Number.isFinite(incoming) || incoming < 1) {
        const e = new Error('next (positive integer) required'); e.status = 400; throw e;
      }
      // Lot numbers above 4 digits break the Palmstreet title parser and the
      // label font ladder — a runaway value would also poison the advance-only
      // counter with no in-app walk-back.
      if (incoming > 9999) {
        const e = new Error('next out of range (max 9999)'); e.status = 400; throw e;
      }
      // Advance-only per week, and a bump never touches any OTHER week's
      // entry. This is a read-then-write (not atomic); under two simultaneous
      // bumps one update can be lost, but the workflow is effectively
      // single-writer and the Start # is editable, so any drift self-corrects
      // on the next sale. Note this guards the COUNTER only — it does not
      // stop an operator manually re-numbering an already-numbered older sale
      // into a colliding range.
      const week = Math.floor(Number(req.body?.week));
      // Plausibility window: the week is client data derived from an editable
      // sale date. Legit uses reach a few weeks back (renumbering a held
      // sale) and a little forward (pre-numbering next week) — anything
      // further is a typo'd date or a bad clock, and accepting it would both
      // store a garbage key and mint numbers nobody can trace.
      const cur = currentLotWeek();
      if (Number.isFinite(week) && (week < cur - 12 || week > cur + 4)) {
        const e = new Error(`week ${week} implausible (server week ${cur}) — check the sale's date`);
        e.status = 400; throw e;
      }
      const { data: existingRow, error: rErr } = await supabase
        .from('app_settings').select('data').eq('id', id).maybeSingle();
      if (rErr) { const e = new Error(rErr.message); e.status = 500; throw e; }
      const d = existingRow?.data || {};
      const payload = { ...d };
      let next;
      if (Number.isFinite(week)) {
        const weeks = { ...(d.weeks || {}) };
        const own = Number(weeks[week]);
        next = Math.max(Number.isFinite(own) && own > 0 ? own : 1, incoming);
        weeks[week] = next;
        // Prune against the SERVER's clock, never against the stored keys —
        // the rotation only needs the recent past (holds span ≤5 weeks), and
        // a client-supplied anchor would let one bad key eat the whole map.
        for (const k of Object.keys(weeks)) {
          if (Number(k) < cur - 8 || Number(k) > cur + 8) delete weeks[k];
        }
        payload.weeks = weeks;
        // The pre-week-scoping counter (`next`) only matters through the
        // cutover window — kept forever it would re-seed its block on every
        // 5th rotation (block 0 permanently starts ~161 and spills). Stamp
        // the week it was first seen and retire it once the bench horizon is
        // long past.
        if (payload.next != null) {
          if (payload.nextWeek == null) payload.nextWeek = week;
          else if (week - payload.nextWeek > 8) { delete payload.next; delete payload.nextWeek; }
        }
      } else {
        // Stale weekless client: legacy advance-only single counter. Its
        // activity refreshes the retirement stamp — the counter is clearly
        // still in use.
        const current = Number(d.next);
        next = Math.max(Number.isFinite(current) && current > 0 ? current : 1, incoming);
        payload.next = next;
        payload.nextWeek = cur;
      }
      const { error } = await supabase
        .from('app_settings')
        .upsert({ id, data: payload, updatedAt: new Date().toISOString(), updatedBy: user.id });
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ next });
    }
    default:
      return methodNotAllowed(res, ['GET', 'POST']);
  }
}

// ----------------------------------------------------------------------------
// Palmstreet follower monitor — the brand's store profile on the public web
// (palmstreet.app/user/<id>) server-renders `follower_count` in its HTML, so
// one GET + one regex gives the live number. Fetched here (not in the browser)
// because palmstreet.app sends no CORS headers. The store link is one
// brand-scoped app_settings row (id `palmstreet:<brandId>`). Same
// no-new-function rationale as the groups above.
// ----------------------------------------------------------------------------

const PALMSTREET_NS = 'palmstreet:';
// Store links look like https://palmstreet.app/user/<firebase-uid>. Extracting
// the uid and rebuilding the URL ourselves means an admin can paste any share
// link shape while the server only ever fetches palmstreet.app (no SSRF).
const PALMSTREET_USER_RE = /^https:\/\/(?:www\.)?palmstreet\.app\/user\/([A-Za-z0-9_-]{6,64})\/?(?:[?#].*)?$/;
// The app's Share button hands out handle links (/u/<name>?pr=…) rather than
// the canonical /user/<uid> shape — accept those too by resolving the handle.
const PALMSTREET_HANDLE_RE = /^https:\/\/(?:www\.)?palmstreet\.app\/u\/([A-Za-z0-9_.-]{2,40})\/?(?:[?#].*)?$/;
// Short per-instance cache: coalesces several stations polling at once
// (Fluid Compute reuses instances) while staying fresh enough for the
// audience board's 3s refresh.
const palmstreetCache = new Map(); // brandId -> { at, payload }
const PALMSTREET_CACHE_MS = 1_000;

async function loadPalmstreetConfig(brandId) {
  const { data, error } = await supabase
    .from('app_settings').select('data').eq('id', PALMSTREET_NS + brandId).maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return data?.data || null;
}

// Fetch a handle page (palmstreet.app/u/<name>) and pull the store owner's
// uid out of the SSR payload — the owner's profile blob is the first user_id
// on the page. Null when the handle doesn't resolve.
async function resolveHandleToUid(handle) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch(`https://palmstreet.app/u/${encodeURIComponent(handle)}`, {
      signal: ctrl.signal,
      headers: { accept: 'text/html' },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    return /user_id[\\"\s:]*([A-Za-z0-9_-]{20,40})/.exec(html)?.[1] || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handlePalmstreet(action, req, res, user, brandId) {
  switch (action) {
    case 'palmstreet-get': {
      // Any active user may read the configured store link.
      return res.status(200).json({ config: await loadPalmstreetConfig(brandId) });
    }
    case 'palmstreet-save': {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      requireAdminRole(user);
      const url = str(req.body?.url, 200);
      let uid = PALMSTREET_USER_RE.exec(url)?.[1] || null;
      if (!uid) {
        const handle = PALMSTREET_HANDLE_RE.exec(url)?.[1];
        if (handle) uid = await resolveHandleToUid(handle);
      }
      if (!uid) {
        const e = new Error('Paste your store link — it looks like https://palmstreet.app/u/<name> or /user/…');
        e.status = 400; throw e;
      }
      const config = { url: `https://palmstreet.app/user/${uid}`, userId: uid };
      const { error } = await supabase.from('app_settings').upsert({
        id: PALMSTREET_NS + brandId, brandId, data: config,
        updatedAt: new Date().toISOString(), updatedBy: user.id,
      });
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      palmstreetCache.delete(brandId);
      return res.status(200).json({ config });
    }
    case 'palmstreet-followers': {
      const cached = palmstreetCache.get(brandId);
      if (cached && Date.now() - cached.at < PALMSTREET_CACHE_MS) {
        return res.status(200).json(cached.payload);
      }
      const config = await loadPalmstreetConfig(brandId);
      if (!config?.userId) return res.status(200).json({ configured: false });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let html;
      try {
        const resp = await fetch(`https://palmstreet.app/user/${config.userId}`, {
          signal: ctrl.signal,
          headers: { accept: 'text/html' },
        });
        if (!resp.ok) { const e = new Error(`Palmstreet answered ${resp.status}`); e.status = 502; throw e; }
        html = await resp.text();
      } catch (err) {
        if (err.status) throw err;
        const e = new Error(err.name === 'AbortError' ? 'Palmstreet timed out' : 'Could not reach Palmstreet');
        e.status = 502; throw e;
      } finally {
        clearTimeout(timer);
      }
      // The SSR payload carries `\"follower_count\":263` (escaped inside a
      // script string). The loose separator class tolerates both escaped and
      // plain JSON so a Next.js re-render on their side doesn't break us.
      const match = /follower_count[\\":\s]*?(\d+)/.exec(html);
      if (!match) {
        const e = new Error('Palmstreet page format changed — follower count not found');
        e.status = 502; throw e;
      }
      const payload = { configured: true, followers: parseInt(match[1], 10), at: new Date().toISOString() };
      palmstreetCache.set(brandId, { at: Date.now(), payload });
      return res.status(200).json(payload);
    }
    default: {
      const e = new Error('Unknown palmstreet action'); e.status = 400; throw e;
    }
  }
}

// ----------------------------------------------------------------------------
// Personal GTD tasks — per-user JSON blob in app_settings (id = `tasks:<id>`).
// ----------------------------------------------------------------------------

const TASKS_NS = 'tasks:';
const PRIORITIES = ['low', 'normal', 'high'];

// Read the caller's task list (always an array, even if the row is absent).
async function loadUserTasks(userId) {
  const { data, error } = await supabase
    .from('app_settings')
    .select('data')
    .eq('id', TASKS_NS + userId)
    .maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  const tasks = data?.data?.tasks;
  return Array.isArray(tasks) ? tasks : [];
}

// Write the caller's task list back (whole-row upsert; the caller is the only
// writer of their own row, so there's no cross-user contention).
async function persistUserTasks(userId, tasks) {
  const { error } = await supabase
    .from('app_settings')
    .upsert({
      id: TASKS_NS + userId,
      data: { tasks },
      updatedAt: new Date().toISOString(),
      updatedBy: userId,
    });
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
}

// Never trust the client's task shape: coerce every field, clamp lengths, and
// derive completedAt from status transitions server-side.
function cleanTask(input, existing, now) {
  if (!input || typeof input !== 'object') {
    const e = new Error('task object required'); e.status = 400; throw e;
  }
  const id = String(input.id || '').trim();
  if (!id) { const e = new Error('task.id required'); e.status = 400; throw e; }
  const title = String(input.title ?? '').trim().slice(0, 200);
  if (!title) { const e = new Error('task title required'); e.status = 400; throw e; }

  const notes = String(input.notes ?? '').slice(0, 2000);
  const priority = PRIORITIES.includes(input.priority) ? input.priority : 'normal';
  const status = input.status === 'done' ? 'done' : 'todo';
  // A due date is a calendar day (YYYY-MM-DD), or null for "someday".
  const due = typeof input.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.due)
    ? input.due : null;
  const tag = input.tag == null ? null : (String(input.tag).trim().slice(0, 40) || null);
  const createdAt = existing?.createdAt
    || (typeof input.createdAt === 'string' ? input.createdAt : now);
  // Keep the original completion time if it was already done; stamp now on the
  // todo→done transition; clear it when re-opened.
  const completedAt = status === 'done'
    ? (existing?.status === 'done' && existing?.completedAt ? existing.completedAt : now)
    : null;

  // Assignment provenance is set only by the admin `task-assign` path and
  // preserved here so an assignee completing/editing the task keeps the
  // "assigned by" marker. A user's own upsert can never fabricate it — these
  // come purely from `existing`, never from the client's payload.
  const assignedBy = existing?.assignedBy || null;
  const assignedByName = existing?.assignedByName || null;
  const assignedAt = existing?.assignedAt || null;

  return {
    id, title, notes, due, priority, tag, status,
    createdAt, updatedAt: now, completedAt,
    assignedBy, assignedByName, assignedAt,
  };
}

function requireAdminRole(user) {
  if (user.role !== 'admin') {
    const e = new Error('Admin access required'); e.status = 403; throw e;
  }
}

async function handleTasks(action, req, res, user) {
  const userId = user.id;
  switch (action) {
    case 'task-list': {
      const tasks = await loadUserTasks(userId);
      return res.status(200).json({ tasks });
    }
    case 'task-upsert': {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const now = new Date().toISOString();
      const tasks = await loadUserTasks(userId);
      const idx = tasks.findIndex(t => t.id === req.body?.task?.id);
      const clean = cleanTask(req.body?.task, idx >= 0 ? tasks[idx] : null, now);
      if (idx >= 0) tasks[idx] = clean; else tasks.unshift(clean);
      await persistUserTasks(userId, tasks);
      return res.status(200).json({ task: clean });
    }
    case 'task-assign': {
      // Admin-only: create/update a task in ANOTHER user's list. The task
      // lands in `tasks:<targetUserId>` so it shows up in that user's calendar,
      // stamped with who assigned it.
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      requireAdminRole(user);
      const targetUserId = req.body?.targetUserId;
      if (!targetUserId) { const e = new Error('targetUserId required'); e.status = 400; throw e; }
      const { data: target, error: tErr } = await supabase
        .from('users').select('id,active,"displayName"').eq('id', targetUserId).maybeSingle();
      if (tErr) { const e = new Error(tErr.message); e.status = 500; throw e; }
      if (!target || !target.active) { const e = new Error('Target user not found'); e.status = 400; throw e; }

      const now = new Date().toISOString();
      const tasks = await loadUserTasks(targetUserId);
      const idx = tasks.findIndex(t => t.id === req.body?.task?.id);
      const existing = idx >= 0 ? tasks[idx] : null;
      const clean = cleanTask(req.body?.task, existing, now);
      clean.assignedBy = userId;
      clean.assignedByName = user.displayName || null;
      clean.assignedAt = existing?.assignedAt || now;
      if (idx >= 0) tasks[idx] = clean; else tasks.unshift(clean);
      await persistUserTasks(targetUserId, tasks);
      return res.status(200).json({ task: clean, assigneeId: target.id, assigneeName: target.displayName });
    }
    case 'task-assigned-by-me': {
      // Admin-only: every task this admin has assigned to someone else, with
      // live status. Scans the `tasks:*` rows (a handful for a small team).
      requireAdminRole(user);
      const { data: rows, error: rErr } = await supabase
        .from('app_settings').select('id,data').like('id', `${TASKS_NS}%`);
      if (rErr) { const e = new Error(rErr.message); e.status = 500; throw e; }
      const { data: users } = await supabase.from('users').select('id,"displayName"');
      const nameById = Object.fromEntries((users || []).map(u => [u.id, u.displayName]));
      const assigned = [];
      for (const row of rows || []) {
        const assigneeId = row.id.slice(TASKS_NS.length);
        const list = Array.isArray(row.data?.tasks) ? row.data.tasks : [];
        for (const t of list) {
          // Skip the admin's own self-assigned tasks — those are just personal.
          if (t.assignedBy === userId && t.assignedBy !== assigneeId) {
            assigned.push({ ...t, assigneeId, assigneeName: nameById[assigneeId] || assigneeId });
          }
        }
      }
      return res.status(200).json({ assigned });
    }
    case 'task-delete': {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const id = req.body?.id;
      if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
      // Admins may delete (unassign) from another user's list via targetUserId;
      // everyone else can only delete from their own.
      let ownerId = userId;
      if (req.body?.targetUserId && req.body.targetUserId !== userId) {
        requireAdminRole(user);
        ownerId = req.body.targetUserId;
      }
      const tasks = (await loadUserTasks(ownerId)).filter(t => t.id !== id);
      await persistUserTasks(ownerId, tasks);
      return res.status(200).json({ ok: true });
    }
    default: {
      const e = new Error('Unknown task action'); e.status = 400; throw e;
    }
  }
}

// ----------------------------------------------------------------------------
// Plant Care calendars — shared schedules, one app_settings row per calendar
// (id = `care-cal:<calendarId>`).
// ----------------------------------------------------------------------------

const CARE_NS = 'care-cal:';
const CARE_TYPES = ['probiotic', 'feed', 'scout', 'flush'];

// Care calendars are brand-scoped. Folia keeps the legacy unprefixed row id for
// backward-compat; other brands namespace their app_settings row ids so the two
// brands' calendars never collide on the (single-column) primary key.
function careRowId(calId, brandId) {
  return (brandId === 'folia' ? '' : `${brandId}::`) + CARE_NS + calId;
}
function careScanPrefix(brandId) {
  return (brandId === 'folia' ? '' : `${brandId}::`) + CARE_NS;
}

function str(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

// Coerce one care task, derive doneAt/doneBy from done state. existingById lets
// us preserve who/when a task was completed across an admin edit.
function cleanCareTask(input, existing, now, userId) {
  const id = str(input?.id, 64) || `c-${Math.random().toString(36).slice(2, 10)}`;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input?.date) ? input.date : null;
  const type = CARE_TYPES.includes(input?.type) ? input.type : 'probiotic';
  const title = str(input?.title, 120);
  const detail = str(input?.detail, 160);
  const done = !!input?.done;
  const doneAt = done ? (existing?.done && existing?.doneAt ? existing.doneAt : now) : null;
  const doneBy = done ? (existing?.done && existing?.doneBy ? existing.doneBy : userId) : null;
  return { id, date, type, title, detail, done, doneAt, doneBy };
}

// Sanitize a full calendar (metadata + tasks). Tasks without a valid date or
// title are dropped so a malformed editor row can't poison the grid.
function cleanCalendar(input, user, existing) {
  if (!input || typeof input !== 'object') {
    const e = new Error('calendar object required'); e.status = 400; throw e;
  }
  const id = str(input.id, 64);
  if (!id) { const e = new Error('calendar.id required'); e.status = 400; throw e; }
  const title = str(input.title, 120);
  if (!title) { const e = new Error('calendar title required'); e.status = 400; throw e; }
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(input.startDate) ? input.startDate : null;
  if (!startDate) { const e = new Error('calendar startDate (YYYY-MM-DD) required'); e.status = 400; throw e; }

  const now = new Date().toISOString();
  const existingById = {};
  for (const t of existing?.tasks || []) existingById[t.id] = t;

  const tasks = (Array.isArray(input.tasks) ? input.tasks : [])
    .map(t => cleanCareTask(t, existingById[str(t?.id, 64)], now, user.id))
    .filter(t => t.date && t.title)
    .slice(0, 400);

  const weekLabels = (Array.isArray(input.weekLabels) ? input.weekLabels : [])
    .map(l => str(l, 40)).slice(0, 52);

  return {
    id,
    title,
    subtitle: str(input.subtitle, 120),
    notes: str(input.notes, 400),
    dailyNote: str(input.dailyNote, 160),
    startDate,
    weekLabels,
    tasks,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || user.id,
    updatedAt: now,
    updatedBy: user.id,
  };
}

async function loadCalendar(id, brandId) {
  const { data, error } = await supabase
    .from('app_settings').select('data').eq('id', careRowId(id, brandId)).maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return data?.data || null;
}

async function handleCare(action, req, res, user, brandId) {
  switch (action) {
    case 'care-list': {
      const { data: rows, error } = await supabase
        .from('app_settings').select('data').like('id', `${careScanPrefix(brandId)}%`);
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      const calendars = (rows || []).map(r => r.data).filter(Boolean)
        .sort((a, b) => (a.startDate || '').localeCompare(b.startDate || '') || (a.title || '').localeCompare(b.title || ''));
      return res.status(200).json({ calendars });
    }
    case 'care-save': {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      requireAdminRole(user);
      const existing = await loadCalendar(str(req.body?.calendar?.id, 64), brandId);
      const clean = cleanCalendar(req.body?.calendar, user, existing);
      const { error } = await supabase.from('app_settings').upsert({
        id: careRowId(clean.id, brandId), brandId, data: clean,
        updatedAt: clean.updatedAt, updatedBy: user.id,
      });
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ calendar: clean });
    }
    case 'care-delete': {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      requireAdminRole(user);
      const id = str(req.body?.id, 64);
      if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
      const { error } = await supabase.from('app_settings').delete().eq('id', careRowId(id, brandId));
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ ok: true });
    }
    case 'care-toggle-task': {
      // Any active user may check off care work (they're the ones doing it).
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const calendarId = str(req.body?.calendarId, 64);
      const taskId = str(req.body?.taskId, 64);
      const cal = await loadCalendar(calendarId, brandId);
      if (!cal) { const e = new Error('Calendar not found'); e.status = 404; throw e; }
      const task = (cal.tasks || []).find(t => t.id === taskId);
      if (!task) { const e = new Error('Task not found'); e.status = 404; throw e; }
      const done = !!req.body?.done;
      const now = new Date().toISOString();
      task.done = done;
      task.doneAt = done ? now : null;
      task.doneBy = done ? user.id : null;
      cal.updatedAt = now;
      const { error } = await supabase.from('app_settings').upsert({
        id: careRowId(calendarId, brandId), brandId, data: cal, updatedAt: now, updatedBy: user.id,
      });
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ calendar: cal });
    }
    default: {
      const e = new Error('Unknown care action'); e.status = 400; throw e;
    }
  }
}

// ----------------------------------------------------------------------------
// BAE landing-page CMS — one brand-scoped JSON blob (id = `landing:<brandId>`).
// The public BAE landing site reads it through the `landing-public` branch at
// the top of the handler; the in-app editor reads (`landing-get`) and the admin
// publishes (`landing-save`).
// ----------------------------------------------------------------------------

const LANDING_NS = 'landing:';
// Worst-case full landing blob is a few KB; 256KB is a generous abuse ceiling
// that still rejects someone pasting a novel into a text field.
const LANDING_MAX_BYTES = 256 * 1024;

function landingRowId(brandId) {
  return LANDING_NS + brandId;
}

// Read the published landing content for a brand (null if never published).
async function loadLanding(brandId) {
  const { data, error } = await supabase
    .from('app_settings').select('data').eq('id', landingRowId(brandId)).maybeSingle();
  if (error) { const e = new Error(error.message); e.status = 500; throw e; }
  return data?.data || null;
}

async function handleLanding(action, req, res, user, brandId) {
  switch (action) {
    case 'landing-get': {
      // Any active user may read; the editor itself is admin-gated in the UI.
      return res.status(200).json({ content: await loadLanding(brandId) });
    }
    case 'landing-save': {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      requireAdminRole(user);
      const content = req.body?.content;
      if (!content || typeof content !== 'object' || Array.isArray(content)) {
        const e = new Error('content (object) required'); e.status = 400; throw e;
      }
      // The landing renderer outputs React text nodes (no innerHTML), so admin
      // copy is XSS-safe; we just guard the blob size and that it's serializable.
      let serialized;
      try { serialized = JSON.stringify(content); }
      catch { const e = new Error('content is not JSON-serializable'); e.status = 400; throw e; }
      if (serialized.length > LANDING_MAX_BYTES) {
        const e = new Error('content too large'); e.status = 413; throw e;
      }
      const now = new Date().toISOString();
      const { error } = await supabase.from('app_settings').upsert({
        id: landingRowId(brandId), brandId, data: content, updatedAt: now, updatedBy: user.id,
      });
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ content });
    }
    default: {
      const e = new Error('Unknown landing action'); e.status = 400; throw e;
    }
  }
}

// ----------------------------------------------------------------------------
// BAE loyalty program — punch-card reward economics + redemption fulfillment.
// Config lives in the reward_config TABLE (not app_settings) because the
// customer app (bae-loyalty-app repo) reads it directly through Supabase RLS;
// reward_redemptions rows are created by the claim_redemption_code() RPC when
// a customer's badge total crosses the threshold. See migration 0034.
// ----------------------------------------------------------------------------

// Same shim as sales.js: the 0034 tables are applied manually; until then the
// admin panel gets `unavailable: true` instead of a hard error.
function isMissingLoyaltyTable(error) {
  return !!error && (error.code === '42P01' || error.code === 'PGRST205'
    || /does not exist|schema cache|find the table/i.test(error.message || ''));
}

// Program-at-a-glance counters for the admin panel. Best-effort: any failure
// (including missing tables) renders the panel without the stats row.
async function loadLoyaltyStats(brandId) {
  const countRows = async (table, filters) => {
    let q = supabase.from(table).select('*', { count: 'exact', head: true }).eq('brandId', brandId);
    for (const [k, v] of Object.entries(filters || {})) q = q.eq(k, v);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  };
  try {
    const [codesIssued, codesClaimed, badgesGranted, rewardsPending, rewardsFulfilled] = await Promise.all([
      countRows('redemption_codes'),
      countRows('redemption_codes', { status: 'claimed' }),
      countRows('badge_events'),
      countRows('reward_redemptions', { status: 'pending' }),
      countRows('reward_redemptions', { status: 'fulfilled' }),
    ]);
    return { codesIssued, codesClaimed, badgesGranted, rewardsPending, rewardsFulfilled };
  } catch {
    return null;
  }
}

// ── Customer hub additions (migration 0035) ─────────────────────────────────
// customer_content: news + growing tips authored by staff here, read by
// customers in the BAE Badges app via RLS (active rows only — this editor
// sees everything). Plus a staff-side customer roster with per-customer
// aggregate counts (badges / orders / rewards).

const CONTENT_KINDS = ['news', 'tip'];

// Never trust the editor's entry shape: validate/coerce every field. Returns
// only the content columns — id/brandId/audit stamps are decided by the caller.
function cleanContentEntry(input) {
  if (!input || typeof input !== 'object') {
    const e = new Error('entry (object) required'); e.status = 400; throw e;
  }
  if (!CONTENT_KINDS.includes(input.kind)) {
    const e = new Error("kind must be 'news' or 'tip'"); e.status = 400; throw e;
  }
  const title = str(input.title, 120);
  if (!title) { const e = new Error('title required'); e.status = 400; throw e; }
  const body = str(input.body, 5000);
  if (!body) { const e = new Error('body required'); e.status = 400; throw e; }
  const imageUrl = str(input.imageUrl, 500) || null;
  if (imageUrl && !imageUrl.startsWith('https://')) {
    const e = new Error('imageUrl must start with https://'); e.status = 400; throw e;
  }
  // null = "not provided": create defaults it to now, edit keeps the row's
  // existing date (else clearing the field silently re-dates an old post to
  // the top of the customer feed).
  let publishedAt = null;
  if (input.publishedAt != null && input.publishedAt !== '') {
    const d = new Date(input.publishedAt);
    if (Number.isNaN(d.getTime())) {
      const e = new Error('publishedAt must be a valid ISO timestamp'); e.status = 400; throw e;
    }
    publishedAt = d.toISOString();
  }
  return { kind: input.kind, title, body, imageUrl, publishedAt, active: !!input.active };
}

// Reads degrade to `unavailable: true` pre-migration; writes can't (the client
// would mistake the response for a success), so they fail loudly but clearly —
// same pattern as the loyalty-code action in shipments.js.
function throwIfMissing0035(error) {
  if (isMissingLoyaltyTable(error)) {
    const e = new Error('Customer hub tables missing — apply supabase/migrations/0035_bae_customer_hub.sql');
    e.status = 503;
    throw e;
  }
}

// Page through every brand-scoped row of a table (Supabase caps one read at
// 1000 rows). Fetch only the columns the aggregate needs; stops at the first
// short page, hard-capped at 20 pages (20k rows — far above the 500-customer
// roster this feeds). Throws the raw supabase error so the caller can
// distinguish a missing table.
async function fetchAllBrandRows(table, columns, brandId) {
  const PAGE = 1000, MAX_PAGES = 20;
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .eq('brandId', brandId)
      // Deterministic order matters: LIMIT/OFFSET without ORDER BY lets a
      // concurrent claim (customers write these tables) shift rows between
      // pages, skipping/double-counting badges in the roster aggregates.
      .order('id')
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function handleLoyalty(action, req, res, user, brandId) {
  switch (action) {
    case 'loyalty-get': {
      // Any active user may view; edits are admin-gated below.
      const { data: config, error } = await supabase
        .from('reward_config').select('*').eq('brandId', brandId).maybeSingle();
      if (error) {
        if (isMissingLoyaltyTable(error)) {
          return res.status(200).json({ config: null, stats: null, unavailable: true });
        }
        const e = new Error(error.message); e.status = 500; throw e;
      }
      return res.status(200).json({ config: config || null, stats: await loadLoyaltyStats(brandId) });
    }
    case 'loyalty-save': {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      requireAdminRole(user);
      const c = req.body?.config;
      if (!c || typeof c !== 'object') {
        const e = new Error('config (object) required'); e.status = 400; throw e;
      }
      const threshold = parseInt(c.threshold, 10);
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 1000) {
        const e = new Error('threshold must be an integer between 1 and 1000'); e.status = 400; throw e;
      }
      const rewardTitle = str(c.rewardTitle, 120);
      if (!rewardTitle) { const e = new Error('rewardTitle required'); e.status = 400; throw e; }
      const rewardDetail = str(c.rewardDetail, 2000) || null;
      const { data: row, error } = await supabase
        .from('reward_config')
        .upsert({
          brandId, threshold, rewardTitle, rewardDetail, active: !!c.active,
          updatedAt: new Date().toISOString(), updatedBy: user.id,
        }, { onConflict: 'brandId' })
        .select('*')
        .single();
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      return res.status(200).json({ config: row });
    }
    case 'loyalty-redemptions': {
      // Newest first, joined with customer contact so staff can verify the
      // person in front of them (customers are Supabase Auth users, not staff).
      // Admin-only like fulfill: the list carries customer email/phone and its
      // only UI consumer (the Loyalty tab) is admin-gated — keep the server
      // gate matching so a non-admin can't pull it via curl.
      requireAdminRole(user);
      const { data: rows, error } = await supabase
        .from('reward_redemptions')
        .select('*')
        .eq('brandId', brandId)
        .order('createdAt', { ascending: false })
        .limit(500);
      if (error) {
        if (isMissingLoyaltyTable(error)) {
          return res.status(200).json({ redemptions: [], unavailable: true });
        }
        const e = new Error(error.message); e.status = 500; throw e;
      }
      const customerIds = [...new Set((rows || []).map(r => r.customerId))];
      let customersById = {};
      if (customerIds.length) {
        const { data: customers } = await supabase
          .from('customers')
          .select('id, "displayName", email, phone')
          .in('id', customerIds);
        customersById = Object.fromEntries((customers || []).map(cu => [cu.id, cu]));
      }
      return res.status(200).json({
        redemptions: (rows || []).map(r => ({ ...r, customer: customersById[r.customerId] || null })),
      });
    }
    case 'loyalty-fulfill': {
      // Mark a reward handed out (or undo an accidental tap via fulfilled:false).
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      requireAdminRole(user);
      const id = str(req.body?.id, 64);
      if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
      const fulfilled = req.body?.fulfilled !== false;
      const patch = fulfilled
        ? { status: 'fulfilled', fulfilledAt: new Date().toISOString(), fulfilledBy: user.id }
        : { status: 'pending', fulfilledAt: null, fulfilledBy: null };
      const { data: row, error } = await supabase
        .from('reward_redemptions')
        .update(patch)
        .eq('id', id)
        .eq('brandId', brandId)
        .select('*')
        .maybeSingle();
      if (error) { const e = new Error(error.message); e.status = 500; throw e; }
      if (!row) { const e = new Error('Redemption not found'); e.status = 404; throw e; }
      return res.status(200).json({ redemption: row });
    }
    case 'loyalty-content-list': {
      // Any staff may read. This is the editor list, so inactive (unpublished)
      // rows are included — the customer app only ever sees active ones (RLS).
      const { data: rows, error } = await supabase
        .from('customer_content')
        .select('*')
        .eq('brandId', brandId)
        .order('publishedAt', { ascending: false })
        .limit(200);
      if (error) {
        if (isMissingLoyaltyTable(error)) {
          return res.status(200).json({ content: [], unavailable: true });
        }
        const e = new Error(error.message); e.status = 500; throw e;
      }
      return res.status(200).json({ content: rows || [] });
    }
    case 'loyalty-content-save': {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      requireAdminRole(user);
      const clean = cleanContentEntry(req.body?.entry);
      const id = str(req.body?.entry?.id, 64);
      const now = new Date().toISOString();
      const row = { ...clean, brandId };
      if (id) {
        // Editing: the row must already exist for THIS brand — a wrong or
        // cross-brand id 404s instead of upsert-inserting under it.
        const { data: existing, error: exErr } = await supabase
          .from('customer_content')
          .select('id, "publishedAt"')
          .eq('id', id)
          .eq('brandId', brandId)
          .maybeSingle();
        if (exErr) {
          throwIfMissing0035(exErr);
          const e = new Error(exErr.message); e.status = 500; throw e;
        }
        if (!existing) { const e = new Error('Post not found'); e.status = 404; throw e; }
        Object.assign(row, {
          id,
          publishedAt: clean.publishedAt ?? existing.publishedAt,
          updatedAt: now,
          updatedBy: user.id,
        });
      } else {
        Object.assign(row, {
          id: 'cc_' + newId(),
          publishedAt: clean.publishedAt ?? now,
          createdAt: now,
          createdBy: user.id,
        });
      }
      // Upsert only touches the columns present in `row`, so an edit keeps the
      // original createdAt/createdBy.
      const { data: saved, error } = await supabase
        .from('customer_content')
        .upsert(row)
        .select('*')
        .single();
      if (error) {
        throwIfMissing0035(error);
        const e = new Error(error.message); e.status = 500; throw e;
      }
      return res.status(200).json({ entry: saved });
    }
    case 'loyalty-content-delete': {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      requireAdminRole(user);
      const id = str(req.body?.id, 64);
      if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
      const { data: deleted, error } = await supabase
        .from('customer_content')
        .delete()
        .eq('id', id)
        .eq('brandId', brandId)
        .select('id');
      if (error) {
        throwIfMissing0035(error);
        const e = new Error(error.message); e.status = 500; throw e;
      }
      if (!deleted?.length) { const e = new Error('Post not found'); e.status = 404; throw e; }
      return res.status(200).json({ ok: true });
    }
    case 'loyalty-customers': {
      // Admin-only: the roster carries customer PII (email/phone) — same gate
      // and rationale as loyalty-redemptions.
      requireAdminRole(user);
      const { data: customers, error } = await supabase
        .from('customers')
        .select('id, "displayName", email, phone, "createdAt"')
        .eq('brandId', brandId)
        .order('createdAt', { ascending: false })
        .limit(500);
      if (error) {
        // `unavailable` only when even the 0034 customers table is missing.
        if (isMissingLoyaltyTable(error)) {
          return res.status(200).json({ customers: [], unavailable: true });
        }
        const e = new Error(error.message); e.status = 500; throw e;
      }

      // Per-customer aggregates, counted in JS from paginated id-only reads.
      const [badgeRows, redemptionRows] = await Promise.all([
        fetchAllBrandRows('badge_events', '"customerId"', brandId),
        fetchAllBrandRows('reward_redemptions', '"customerId", status', brandId),
      ]);
      // customer_orders ships in 0035; pre-migration every count is simply 0.
      let orderRows = [];
      try {
        orderRows = await fetchAllBrandRows('customer_orders', '"customerId"', brandId);
      } catch (ordErr) {
        if (!isMissingLoyaltyTable(ordErr)) {
          const e = new Error(ordErr.message); e.status = 500; throw e;
        }
      }

      const badges = new Map(), orders = new Map(), pending = new Map(), fulfilledCounts = new Map();
      const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
      for (const r of badgeRows) bump(badges, r.customerId);
      for (const r of orderRows) bump(orders, r.customerId);
      for (const r of redemptionRows) {
        if (r.status === 'pending') bump(pending, r.customerId);
        else if (r.status === 'fulfilled') bump(fulfilledCounts, r.customerId);
      }

      return res.status(200).json({
        customers: (customers || []).map(c => ({
          id: c.id,
          displayName: c.displayName,
          email: c.email,
          phone: c.phone,
          createdAt: c.createdAt,
          badges: badges.get(c.id) || 0,
          orders: orders.get(c.id) || 0,
          rewardsPending: pending.get(c.id) || 0,
          rewardsFulfilled: fulfilledCounts.get(c.id) || 0,
        })),
      });
    }
    default: {
      const e = new Error('Unknown loyalty action'); e.status = 400; throw e;
    }
  }
}
