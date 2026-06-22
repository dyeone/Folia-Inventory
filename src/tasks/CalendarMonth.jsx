import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ymd, todayYmd, tasksByDate, priorityMeta } from './taskHelpers.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_CHIPS = 3;

// Month grid. Each day shows its tasks (chips on desktop, dots on mobile).
// Clicking empty day space adds a task on that date; clicking a task edits it.
export function CalendarMonth({ tasks, onAddDay, onEditTask }) {
  // First-of-month anchor for the visible month; defaults to the current month.
  const [anchor, setAnchor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });

  const byDate = useMemo(() => tasksByDate(tasks), [tasks]);
  const today = todayYmd();

  // Build the 6x7 grid of dates starting from the Sunday on/before the 1st.
  const cells = useMemo(() => {
    const start = new Date(anchor);
    start.setDate(1 - anchor.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return { date: d, key: ymd(d), inMonth: d.getMonth() === anchor.getMonth() };
    });
  }, [anchor]);

  const monthLabel = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const step = (delta) => setAnchor(a => new Date(a.getFullYear(), a.getMonth() + delta, 1));
  const goToday = () => { const n = new Date(); setAnchor(new Date(n.getFullYear(), n.getMonth(), 1)); };

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h3 className="text-base font-semibold text-gray-900">{monthLabel}</h3>
        <div className="flex items-center gap-1">
          <button onClick={goToday} className="px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-lg">
            Today
          </button>
          <button onClick={() => step(-1)} aria-label="Previous month" className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button onClick={() => step(1)} aria-label="Next month" className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-gray-100">
        {WEEKDAYS.map(d => (
          <div key={d} className="px-1 py-1.5 text-center text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
            <span className="hidden sm:inline">{d}</span>
            <span className="sm:hidden">{d[0]}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {cells.map(cell => {
          const dayTasks = byDate[cell.key] || [];
          const isToday = cell.key === today;
          return (
            <button
              key={cell.key}
              type="button"
              onClick={() => onAddDay(cell.key)}
              title="Add a task on this day"
              className={`min-h-[64px] sm:min-h-[96px] border-b border-r border-gray-100 p-1 sm:p-1.5 text-left align-top hover:bg-emerald-50/40 transition ${
                cell.inMonth ? 'bg-white' : 'bg-gray-50/60'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`inline-flex items-center justify-center text-xs tabular-nums ${
                  isToday
                    ? 'bg-emerald-600 text-white font-semibold w-5 h-5 rounded-full'
                    : cell.inMonth ? 'text-gray-700' : 'text-gray-300'
                }`}>
                  {cell.date.getDate()}
                </span>
              </div>

              {/* Desktop: titled chips. */}
              <div className="hidden sm:block mt-1 space-y-0.5">
                {dayTasks.slice(0, MAX_CHIPS).map(t => {
                  const prio = priorityMeta(t.priority);
                  return (
                    <span
                      key={t.id}
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); onEditTask(t); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onEditTask(t); } }}
                      className={`flex items-center gap-1 px-1 py-0.5 rounded text-[11px] leading-tight truncate cursor-pointer ${
                        t.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${t.status === 'done' ? 'bg-gray-300' : prio.dot}`} />
                      <span className="truncate">{t.title}</span>
                    </span>
                  );
                })}
                {dayTasks.length > MAX_CHIPS && (
                  <span className="block px-1 text-[11px] text-gray-400">+{dayTasks.length - MAX_CHIPS} more</span>
                )}
              </div>

              {/* Mobile: priority dots only (chips don't fit at 375px). */}
              {dayTasks.length > 0 && (
                <div className="sm:hidden mt-1 flex flex-wrap gap-0.5">
                  {dayTasks.slice(0, 4).map(t => (
                    <span
                      key={t.id}
                      className={`w-1.5 h-1.5 rounded-full ${t.status === 'done' ? 'bg-gray-300' : priorityMeta(t.priority).dot}`}
                    />
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
