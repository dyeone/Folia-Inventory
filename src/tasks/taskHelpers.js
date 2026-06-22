// Helpers for the personal GTD task / calendar feature.
//
// Due dates are stored and compared as local 'YYYY-MM-DD' strings rather than
// timestamps — a task due "today" should mean the calendar day in the
// operator's own timezone, not an instant that drifts across midnight or UTC.

// Format a Date (or date-ish value) as a local 'YYYY-MM-DD' string.
export function ymd(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayYmd() {
  return ymd(new Date());
}

// Parse a 'YYYY-MM-DD' string into a local Date at midnight (no TZ shift that
// `new Date('YYYY-MM-DD')` would introduce by parsing as UTC).
export function parseYmd(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isOverdue(task) {
  return task.status !== 'done' && !!task.due && task.due < todayYmd();
}

export function isDueToday(task) {
  return task.due === todayYmd();
}

// A short human label for a due date relative to today.
export function dueLabel(due) {
  if (!due) return 'Someday';
  const today = todayYmd();
  if (due === today) return 'Today';
  const d = parseYmd(due);
  const t = parseYmd(today);
  if (!d || !t) return due;
  const diffDays = Math.round((d - t) / 86400000);
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Priority metadata — dot color for compact chips, chip styling for the editor.
export const PRIORITIES = [
  { id: 'high', label: 'High', dot: 'bg-red-500', chip: 'bg-red-50 text-red-700 border-red-300' },
  { id: 'normal', label: 'Normal', dot: 'bg-blue-500', chip: 'bg-blue-50 text-blue-700 border-blue-300' },
  { id: 'low', label: 'Low', dot: 'bg-gray-400', chip: 'bg-gray-50 text-gray-600 border-gray-300' },
];
export function priorityMeta(p) {
  return PRIORITIES.find(x => x.id === p) || PRIORITIES[1];
}

const PRIO_RANK = { high: 0, normal: 1, low: 2 };

// Stable id for a new task. crypto.randomUUID where available, else a
// timestamp+random fallback (good enough — ids only need to be unique per user).
export function newTaskId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Build a fresh task object with sensible defaults.
export function makeTask(partial = {}) {
  return {
    id: newTaskId(),
    title: '',
    notes: '',
    due: null,
    priority: 'normal',
    tag: null,
    status: 'todo',
    completedAt: null,
    ...partial,
  };
}

// GTD-light buckets for the list view, each internally sorted.
export function groupTasks(tasks) {
  const today = todayYmd();
  const groups = { overdue: [], today: [], upcoming: [], someday: [], done: [] };
  for (const t of tasks) {
    if (t.status === 'done') { groups.done.push(t); continue; }
    if (!t.due) { groups.someday.push(t); continue; }
    if (t.due < today) { groups.overdue.push(t); continue; }
    if (t.due === today) { groups.today.push(t); continue; }
    groups.upcoming.push(t);
  }
  const byPriority = (a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
  const byDueThenPriority = (a, b) =>
    (a.due || '').localeCompare(b.due || '') || byPriority(a, b);
  groups.overdue.sort(byDueThenPriority);
  groups.today.sort(byPriority);
  groups.upcoming.sort(byDueThenPriority);
  groups.someday.sort(byPriority);
  groups.done.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  return groups;
}

// Index tasks by due date for the month grid: { 'YYYY-MM-DD': [task, ...] }.
export function tasksByDate(tasks) {
  const map = {};
  for (const t of tasks) {
    if (!t.due) continue;
    (map[t.due] || (map[t.due] = [])).push(t);
  }
  for (const list of Object.values(map)) {
    list.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
      return PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
    });
  }
  return map;
}
