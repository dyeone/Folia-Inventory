import { supabase, requireUser, requireAdmin } from './_lib/supabase.js';
import { wrap, methodNotAllowed } from './_lib/respond.js';

// Single-row JSON blob per settings id. Currently used only for
// id='shipping' (ship-from address + ShipStation defaults), but the
// shape lets us add other namespaces (id='financial', etc.) without
// new endpoints.

export default wrap(async (req, res) => {
  const userId = req.method === 'GET' ? req.query?.userId : req.body?.userId;
  const user = await requireUser(userId);

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
