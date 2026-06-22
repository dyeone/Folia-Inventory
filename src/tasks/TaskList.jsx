import { useMemo } from 'react';
import { groupTasks } from './taskHelpers.js';
import { TaskRow } from './TaskRow.jsx';

const SECTIONS = [
  { key: 'overdue', label: 'Overdue', tone: 'text-red-600' },
  { key: 'today', label: 'Today', tone: 'text-emerald-700' },
  { key: 'upcoming', label: 'Upcoming', tone: 'text-gray-700' },
  { key: 'someday', label: 'Someday', tone: 'text-gray-700' },
  { key: 'done', label: 'Done', tone: 'text-gray-400' },
];

// GTD-light list: tasks bucketed into Overdue / Today / Upcoming / Someday /
// Done. Empty buckets are hidden.
export function TaskList({ tasks, onToggle, onEdit, currentUserId }) {
  const groups = useMemo(() => groupTasks(tasks), [tasks]);
  const hasAny = tasks.length > 0;

  if (!hasAny) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
        <p className="text-sm text-gray-500">No tasks yet. Capture one above to get started.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {SECTIONS.map(section => {
        const list = groups[section.key];
        if (!list.length) return null;
        return (
          <div key={section.key} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between">
              <h3 className={`text-xs font-semibold uppercase tracking-wide ${section.tone}`}>
                {section.label}
              </h3>
              <span className="text-xs text-gray-400 tabular-nums">{list.length}</span>
            </div>
            <div className="px-4 divide-y divide-gray-100">
              {list.map(task => (
                <TaskRow key={task.id} task={task} onToggle={onToggle} onEdit={onEdit} currentUserId={currentUserId} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
