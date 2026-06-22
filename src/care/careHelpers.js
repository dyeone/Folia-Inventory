// Plant Care calendar helpers: task-type metadata, week-grid construction, and
// a ready-to-seed template. Dates are local 'YYYY-MM-DD' calendar days (see
// ymd / parseYmd), reused from the tasks helpers to avoid timezone drift.
import { ymd, parseYmd, todayYmd, newTaskId } from '../tasks/taskHelpers.js';

export { ymd, parseYmd, todayYmd };

// The four care actions, matching the screenshot legend + colors. `observe`
// isn't a stored type — days with no task render "Observe only".
export const CARE_TYPES = [
  {
    id: 'probiotic', label: 'Probiotic drench', chip: 'PROBIOTIC',
    accent: 'bg-emerald-500', dot: 'bg-emerald-500', text: 'text-emerald-700',
    cellBg: 'bg-emerald-50/70', ring: 'ring-emerald-500',
  },
  {
    id: 'feed', label: 'Dilute feed', chip: 'FEED',
    accent: 'bg-amber-500', dot: 'bg-amber-500', text: 'text-amber-700',
    cellBg: 'bg-amber-50/70', ring: 'ring-amber-500',
  },
  {
    id: 'scout', label: 'Scout / Spinosad', chip: 'SCOUT',
    accent: 'bg-violet-500', dot: 'bg-violet-500', text: 'text-violet-700',
    cellBg: 'bg-violet-50/70', ring: 'ring-violet-500',
  },
  {
    id: 'flush', label: 'Plain-water flush', chip: 'FLUSH',
    accent: 'bg-sky-500', dot: 'bg-sky-500', text: 'text-sky-700',
    cellBg: 'bg-sky-50/70', ring: 'ring-sky-500',
  },
];

export function careType(id) {
  return CARE_TYPES.find(t => t.id === id) || null;
}

export function newCareTaskId() {
  return newTaskId();
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtShort(date) {
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

// Build the week×day grid from a start date and the calendar's tasks. Columns
// are labeled by the weekday the calendar starts on (so a Thu start reads
// Thu…Wed, matching the screenshot). The number of weeks is the larger of the
// declared week labels and the span needed to cover the last task.
export function buildWeeks(calendar) {
  const start = parseYmd(calendar.startDate);
  if (!start) return { weeks: [], weekdays: WEEKDAYS };

  const byDate = {};
  for (const t of calendar.tasks || []) byDate[t.date] = t;

  const lastDate = (calendar.tasks || []).reduce(
    (m, t) => (t.date > m ? t.date : m), calendar.startDate,
  );
  const spanDays = Math.round((parseYmd(lastDate) - start) / 86400000) + 1;
  const numWeeks = Math.max(
    calendar.weekLabels?.length || 0,
    Math.ceil(spanDays / 7),
    1,
  );

  const weekdays = Array.from({ length: 7 }, (_, d) =>
    WEEKDAYS[new Date(start.getFullYear(), start.getMonth(), start.getDate() + d).getDay()]);

  const weeks = [];
  for (let w = 0; w < numWeeks; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      const key = ymd(date);
      days.push({ date, key, task: byDate[key] || null });
    }
    weeks.push({
      index: w,
      label: calendar.weekLabels?.[w] || `Week ${w + 1}`,
      range: `${fmtShort(days[0].date)} – ${fmtShort(days[6].date)}`,
      days,
    });
  }
  return { weeks, weekdays };
}

// Progress tally across all dated tasks.
export function careProgress(calendar) {
  const tasks = calendar.tasks || [];
  return { done: tasks.filter(t => t.done).length, total: tasks.length };
}

// A fresh, empty calendar for the "New calendar" editor.
export function makeCalendar() {
  return {
    id: newTaskId(),
    title: '',
    subtitle: '',
    notes: '',
    dailyNote: '',
    startDate: todayYmd(),
    weekLabels: [],
    tasks: [],
  };
}

// The Anthurium Seedlings First-Month Care Calendar from the screenshot,
// ready to seed. Stable task ids so re-seeding is idempotent.
export function anthuriumTemplate() {
  return {
    id: 'anthurium-seedlings-2026-06',
    title: 'Anthurium Seedlings',
    subtitle: 'First-Month Care Calendar',
    notes: 'Imported plugs · sphagnum moss · grow tent RH ~72%, 70-80F · potted Jun 18, 2026',
    dailyNote: 'Observe leaves & moss daily · apply at dusk',
    startDate: '2026-06-18',
    weekLabels: ['Settle', 'Establish', 'First feed', 'Feed + flush'],
    tasks: [
      { id: 'a1', date: '2026-06-18', type: 'probiotic', title: 'Potted + Tricho.', detail: 'root drench done', done: true },
      { id: 'a2', date: '2026-06-21', type: 'probiotic', title: 'Bacillus drench', detail: 'B. subtilis / Revitalize', done: false },
      { id: 'a3', date: '2026-06-26', type: 'probiotic', title: 'Probiotic drench', detail: 'Trichoderma + Bac.', done: false },
      { id: 'a4', date: '2026-06-30', type: 'scout', title: 'Scout for pests', detail: 'Spinosad only if found', done: false },
      { id: 'a5', date: '2026-07-03', type: 'feed', title: 'First dilute feed', detail: 'Foliage Focus 1/4x', done: false },
      { id: 'a6', date: '2026-07-05', type: 'probiotic', title: 'Probiotic drench', detail: 'rotate Bacillus', done: false },
      { id: 'a7', date: '2026-07-10', type: 'feed', title: 'Dilute feed', detail: 'Foliage Focus 1/4-1/2', done: false },
      { id: 'a8', date: '2026-07-12', type: 'flush', title: 'Plain-water flush', detail: 'rinse salts from moss', done: false },
      { id: 'a9', date: '2026-07-14', type: 'probiotic', title: 'Probiotic drench', detail: 'Trichoderma + Bac.', done: false },
    ],
  };
}
