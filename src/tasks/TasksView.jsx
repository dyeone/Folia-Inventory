import { useMemo, useState } from 'react';
import { Plus, CalendarDays, ListTodo, UserCheck } from 'lucide-react';
import { useIsMobile } from '../ui/useIsMobile.js';
import { makeTask, todayYmd, groupTasks } from './taskHelpers.js';
import { CalendarMonth } from './CalendarMonth.jsx';
import { TaskList } from './TaskList.jsx';
import { TaskModal } from './TaskModal.jsx';
import { AssignedView } from './AssignedView.jsx';

// The Calendar tab: a personal GTD task list with a month-calendar view and a
// GTD-light list view, plus quick capture. Tasks are private to the signed-in
// user (see api.getTasks / settings.js). Admins can additionally assign tasks
// to others and track them in the "Assigned" view.
export function TasksView({
  tasks, onSaveTask, onDeleteTask, onToggleTask,
  onAssignTask, currentUser, isAdmin = false, users = [],
}) {
  const isMobile = useIsMobile();
  // Month grid is cramped on phones — default them to the list view.
  const [view, setView] = useState(isMobile ? 'list' : 'month');
  const [modal, setModal] = useState(null); // { task } | { defaultDue } | null
  const [quickTitle, setQuickTitle] = useState('');

  const counts = useMemo(() => {
    const g = groupTasks(tasks);
    return { open: g.overdue.length + g.today.length + g.upcoming.length + g.someday.length, overdue: g.overdue.length };
  }, [tasks]);

  const quickAdd = (e) => {
    e?.preventDefault();
    const title = quickTitle.trim();
    if (!title) return;
    onSaveTask(makeTask({ title, due: todayYmd() }));
    setQuickTitle('');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Calendar &amp; Tasks</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {counts.open} open{counts.overdue > 0 ? ` · ${counts.overdue} overdue` : ''} · only you can see these
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-gray-100 rounded-lg p-0.5">
            <button
              onClick={() => setView('month')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                view === 'month' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              <CalendarDays className="w-4 h-4" /> Month
            </button>
            <button
              onClick={() => setView('list')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                view === 'list' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
              }`}
            >
              <ListTodo className="w-4 h-4" /> List
            </button>
            {isAdmin && (
              <button
                onClick={() => setView('assigned')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                  view === 'assigned' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                }`}
              >
                <UserCheck className="w-4 h-4" /> <span className="hidden sm:inline">Assigned</span>
              </button>
            )}
          </div>
          <button
            onClick={() => setModal({})}
            className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg"
          >
            <Plus className="w-4 h-4" /> <span className="hidden sm:inline">New task</span>
          </button>
        </div>
      </div>

      {/* Quick capture — adds a task due today; edit it for a different date.
          Hidden in the Assigned view, which is about other people's tasks. */}
      {view !== 'assigned' && (
        <form onSubmit={quickAdd} className="flex items-center gap-2">
          <input
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            placeholder="Quick add a task for today…"
            className="input flex-1"
          />
          <button
            type="submit"
            disabled={!quickTitle.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-gray-800 hover:bg-gray-900 rounded-lg disabled:opacity-40"
          >
            Add
          </button>
        </form>
      )}

      {view === 'month' && (
        <CalendarMonth
          tasks={tasks}
          onAddDay={(due) => setModal({ defaultDue: due })}
          onEditTask={(task) => setModal({ task })}
        />
      )}
      {view === 'list' && (
        <TaskList
          tasks={tasks}
          onToggle={onToggleTask}
          onEdit={(task) => setModal({ task })}
          currentUserId={currentUser?.id}
        />
      )}
      {view === 'assigned' && isAdmin && <AssignedView />}

      {modal && (
        <TaskModal
          task={modal.task || null}
          defaultDue={modal.defaultDue || null}
          onSave={onSaveTask}
          onDelete={onDeleteTask}
          onClose={() => setModal(null)}
          isAdmin={isAdmin}
          users={users}
          currentUser={currentUser}
          onAssign={onAssignTask}
        />
      )}
    </div>
  );
}
