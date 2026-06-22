import { useState } from 'react';
import { Trash2, Flag, UserPlus } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';
import { PRIORITIES, makeTask } from './taskHelpers.js';

// Create / edit a single task. `task` is an existing task to edit, or null to
// create a new one. `defaultDue` pre-seeds the date for new tasks (e.g. when a
// calendar day was clicked). Admins additionally get an "Assign to" picker on
// NEW tasks: choosing someone else routes the save through `onAssign` so the
// task lands in that user's list instead of the admin's own.
export function TaskModal({
  task, defaultDue = null, onSave, onDelete, onClose,
  isAdmin = false, users = [], currentUser, onAssign,
}) {
  const isEdit = !!task;
  const [draft, setDraft] = useState(() =>
    task ? { ...task } : makeTask({ due: defaultDue }));
  const [assignee, setAssignee] = useState(currentUser?.id || '');

  // Only staff/admins have a calendar to receive tasks — packers use a
  // separate UI, so they can't be assignees.
  const assignable = users.filter(u => u.active && u.role !== 'packer');
  const showAssign = !isEdit && isAdmin && assignable.length > 0;

  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const canSave = draft.title.trim().length > 0;

  const submit = (e) => {
    e?.preventDefault();
    if (!canSave) return;
    const next = { ...draft, title: draft.title.trim() };
    if (showAssign && assignee && assignee !== currentUser?.id) {
      onAssign(assignee, next);
    } else {
      onSave(next);
    }
    onClose();
  };

  return (
    <Modal title={isEdit ? 'Edit task' : 'New task'} onClose={onClose} size="md">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Task">
          <input
            autoFocus
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="What needs doing?"
            className="input w-full"
          />
        </Field>

        {showAssign && (
          <Field label="Assign to">
            <select
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              className="input w-full"
            >
              <option value={currentUser?.id || ''}>Myself</option>
              {assignable
                .filter(u => u.id !== currentUser?.id)
                .map(u => (
                  <option key={u.id} value={u.id}>{u.displayName || u.username}</option>
                ))}
            </select>
            {assignee && assignee !== currentUser?.id && (
              <p className="mt-1 text-xs text-violet-600 flex items-center gap-1">
                <UserPlus className="w-3 h-3" /> Adds to their calendar, marked assigned by you.
              </p>
            )}
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Due date">
            <input
              type="date"
              value={draft.due || ''}
              onChange={(e) => set({ due: e.target.value || null })}
              className="input w-full"
            />
            {draft.due && (
              <button
                type="button"
                onClick={() => set({ due: null })}
                className="mt-1 text-xs text-gray-500 hover:text-gray-700"
              >
                Clear date (move to Someday)
              </button>
            )}
          </Field>

          <Field label="Tag / context">
            <input
              value={draft.tag || ''}
              onChange={(e) => set({ tag: e.target.value || null })}
              placeholder="@home, @calls…"
              className="input w-full"
            />
          </Field>
        </div>

        <div>
          <span className="text-sm font-medium text-gray-700 block mb-1.5">Priority</span>
          <div className="flex gap-2">
            {PRIORITIES.map(p => {
              const active = draft.priority === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => set({ priority: p.id })}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm font-medium transition ${
                    active ? p.chip : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <Flag className={`w-3.5 h-3.5 ${active ? '' : 'text-gray-400'}`} /> {p.label}
                </button>
              );
            })}
          </div>
        </div>

        <Field label="Notes">
          <textarea
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
            rows={3}
            placeholder="Optional details…"
            className="input w-full resize-y"
          />
        </Field>

        <div className="flex items-center justify-between gap-2 pt-1">
          {isEdit ? (
            <button
              type="button"
              onClick={() => { onDelete(draft.id); onClose(); }}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg"
            >
              <Trash2 className="w-4 h-4" /> Delete
            </button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-50"
            >
              {isEdit ? 'Save' : (showAssign && assignee && assignee !== currentUser?.id ? 'Assign' : 'Add task')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
