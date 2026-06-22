import { useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { makeTask, todayYmd, groupTasks } from './taskHelpers.js';
import { TaskRow } from './TaskRow.jsx';

// "Today" agenda for the main dashboard: overdue + due-today tasks with quick
// capture and a link into the full Calendar tab. Kept lightweight (no heavy
// deps) so it can ride along in the eagerly-loaded Dashboard bundle.
export function DashboardTasks({ tasks, onSaveTask, onToggleTask, onOpenCalendar, currentUserId }) {
  const [quickTitle, setQuickTitle] = useState('');

  const { agenda, overdueCount, upcomingCount, doneToday } = useMemo(() => {
    const g = groupTasks(tasks);
    // Overdue first (most urgent), then today's open tasks.
    const agenda = [...g.overdue, ...g.today];
    const doneToday = tasks.filter(t => t.status === 'done' && (t.completedAt || '').slice(0, 10) === todayYmd()).length;
    return { agenda, overdueCount: g.overdue.length, upcomingCount: g.upcoming.length, doneToday };
  }, [tasks]);

  const quickAdd = (e) => {
    e?.preventDefault();
    const title = quickTitle.trim();
    if (!title) return;
    onSaveTask(makeTask({ title, due: todayYmd() }));
    setQuickTitle('');
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" /> My Day
          {overdueCount > 0 && (
            <span className="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
              {overdueCount} overdue
            </span>
          )}
        </h3>
        <button
          onClick={onOpenCalendar}
          className="flex items-center gap-0.5 text-xs font-medium text-emerald-700 hover:text-emerald-800"
        >
          Calendar <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>

      <form onSubmit={quickAdd} className="flex items-center gap-2 mb-3">
        <input
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
          placeholder="Add a task for today…"
          className="input flex-1"
        />
        <button
          type="submit"
          disabled={!quickTitle.trim()}
          className="px-3 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-40"
        >
          Add
        </button>
      </form>

      {agenda.length === 0 ? (
        <p className="text-sm text-gray-500 py-2">
          Nothing due today.{' '}
          {upcomingCount > 0
            ? `${upcomingCount} upcoming — `
            : ''}
          <button onClick={onOpenCalendar} className="text-emerald-700 hover:underline">open the calendar</button>.
        </p>
      ) : (
        <div className="divide-y divide-gray-100">
          {agenda.map(task => (
            <TaskRow key={task.id} task={task} onToggle={onToggleTask} onEdit={() => onOpenCalendar()} currentUserId={currentUserId} />
          ))}
        </div>
      )}

      {doneToday > 0 && (
        <p className="text-xs text-gray-400 mt-2">{doneToday} completed today</p>
      )}
    </div>
  );
}
