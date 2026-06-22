import { Check, Tag, UserPlus } from 'lucide-react';
import { dueLabel, isOverdue, priorityMeta } from './taskHelpers.js';

// One task line: a check-off control, the title, and metadata chips. Used in
// both the full list view and the dashboard widget. `showDue` hides the due
// label in contexts where the date is already implied (e.g. a single day).
// `currentUserId` lets us flag tasks someone else assigned to you.
export function TaskRow({ task, onToggle, onEdit, showDue = true, currentUserId }) {
  const done = task.status === 'done';
  const overdue = isOverdue(task);
  const prio = priorityMeta(task.priority);
  const incoming = task.assignedBy && task.assignedBy !== currentUserId;

  return (
    <div className="flex items-start gap-2.5 py-2 group">
      <button
        type="button"
        onClick={() => onToggle(task)}
        aria-label={done ? 'Mark not done' : 'Mark done'}
        className={`mt-0.5 w-5 h-5 shrink-0 rounded-full border flex items-center justify-center transition ${
          done
            ? 'bg-emerald-600 border-emerald-600 text-white'
            : 'border-gray-300 hover:border-emerald-500 text-transparent'
        }`}
      >
        <Check className="w-3 h-3" strokeWidth={3} />
      </button>

      <button
        type="button"
        onClick={() => onEdit?.(task)}
        className="flex-1 min-w-0 text-left"
      >
        <div className="flex items-center gap-1.5">
          {!done && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${prio.dot}`} />}
          <span className={`text-sm truncate ${done ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
            {task.title}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {showDue && task.due && (
            <span className={`text-xs ${overdue ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
              {dueLabel(task.due)}
            </span>
          )}
          {task.tag && (
            <span className="inline-flex items-center gap-1 text-xs text-gray-500">
              <Tag className="w-3 h-3" /> {task.tag}
            </span>
          )}
          {incoming && (
            <span className="inline-flex items-center gap-1 text-xs text-violet-600">
              <UserPlus className="w-3 h-3" /> {task.assignedByName || 'Assigned'}
            </span>
          )}
        </div>
      </button>
    </div>
  );
}
