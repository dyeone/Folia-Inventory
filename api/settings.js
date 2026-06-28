import { supabase, requireAdmin, requireBrand, brandIdFromReq } from './_lib/supabase.js';
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
