import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Trash2, Check, AlertCircle } from 'lucide-react';
import { api } from '../api.js';
import { dueLabel, isOverdue } from './taskHelpers.js';

// Admin-only "Assigned by me" tracker: every task this admin handed to someone
// else, grouped by assignee, with live done/overdue status. Self-contained —
// it owns its own fetch (the data isn't part of the app's shared task state).
export function AssignedView() {
  const [assigned, setAssigned] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Async-first so neither the mount effect nor the refresh button sets state
  // synchronously inside the effect body.
  const fetchAssigned = useCallback(async () => {
    try {
      setAssigned(await api.getAssignedByMe());
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load assigned tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    fetchAssigned();
  }, [fetchAssigned]);

  // fetchAssigned only setState()s after an await, so this isn't the cascading
  // synchronous update the rule guards against.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchAssigned(); }, [fetchAssigned]);

  const unassign = async (assigneeId, id) => {
    // Optimistic removal; reload on failure to resync.
    setAssigned(prev => prev.filter(t => !(t.assigneeId === assigneeId && t.id === id)));
    try {
      await api.deleteTaskFor(assigneeId, id);
    } catch {
      fetchAssigned();
    }
  };

  // Group by assignee, with a done/total tally per person.
  const groups = useMemo(() => {
    const byPerson = {};
    for (const t of assigned) {
      const g = byPerson[t.assigneeId] || (byPerson[t.assigneeId] = { name: t.assigneeName, tasks: [] });
      g.tasks.push(t);
    }
    return Object.entries(byPerson)
      .map(([id, g]) => ({
        id,
        name: g.name,
        tasks: g.tasks.slice().sort((a, b) => {
          if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
          return (a.due || '~').localeCompare(b.due || '~');
        }),
        done: g.tasks.filter(t => t.status === 'done').length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [assigned]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {assigned.length} task{assigned.length === 1 ? '' : 's'} you assigned to others
        </p>
        <button
          onClick={refresh}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {!loading && groups.length === 0 && !error && (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
          <p className="text-sm text-gray-500">
            You haven't assigned any tasks yet. Use <span className="font-medium">New task → Assign to</span> to hand one to a teammate.
          </p>
        </div>
      )}

      {groups.map(group => (
        <div key={group.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">{group.name}</h3>
            <span className="text-xs text-gray-400 tabular-nums">{group.done}/{group.tasks.length} done</span>
          </div>
          <div className="px-4 divide-y divide-gray-100">
            {group.tasks.map(task => {
              const done = task.status === 'done';
              const overdue = isOverdue(task);
              return (
                <div key={task.id} className="flex items-center gap-3 py-2.5">
                  <span className={`w-5 h-5 shrink-0 rounded-full border flex items-center justify-center ${
                    done ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-gray-300 text-transparent'
                  }`}>
                    <Check className="w-3 h-3" strokeWidth={3} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm truncate ${done ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                      {task.title}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs ${overdue ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                        {done ? 'Completed' : dueLabel(task.due)}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => unassign(task.assigneeId, task.id)}
                    aria-label="Unassign"
                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
