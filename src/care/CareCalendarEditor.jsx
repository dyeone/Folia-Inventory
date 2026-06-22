import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from '../ui/Modal.jsx';
import { Field } from '../ui/Field.jsx';
import { CARE_TYPES, makeCalendar, newCareTaskId } from './careHelpers.js';

// Admin editor for a plant care calendar: metadata + week phase labels + a
// flat editable list of care tasks. The pretty week grid is the read view;
// this is the simple form for entering data.
export function CareCalendarEditor({ calendar, onSave, onClose }) {
  const isEdit = !!calendar;
  const [draft, setDraft] = useState(() => calendar ? { ...calendar } : makeCalendar());
  const [weekLabelsText, setWeekLabelsText] = useState((calendar?.weekLabels || []).join(', '));

  const set = (patch) => setDraft(d => ({ ...d, ...patch }));
  const setTask = (id, patch) =>
    setDraft(d => ({ ...d, tasks: d.tasks.map(t => (t.id === id ? { ...t, ...patch } : t)) }));
  const addTask = () =>
    setDraft(d => ({
      ...d,
      tasks: [...d.tasks, { id: newCareTaskId(), date: d.startDate, type: 'probiotic', title: '', detail: '', done: false }],
    }));
  const removeTask = (id) => setDraft(d => ({ ...d, tasks: d.tasks.filter(t => t.id !== id) }));

  const canSave = draft.title.trim() && draft.startDate;

  const submit = (e) => {
    e?.preventDefault();
    if (!canSave) return;
    const weekLabels = weekLabelsText.split(',').map(s => s.trim()).filter(Boolean);
    // Drop incomplete task rows (no date or no title) so they don't poison the grid.
    const tasks = draft.tasks.filter(t => t.date && t.title.trim());
    onSave({ ...draft, title: draft.title.trim(), weekLabels, tasks });
    onClose();
  };

  return (
    <Modal title={isEdit ? 'Edit care calendar' : 'New care calendar'} onClose={onClose} size="xl">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Title">
            <input autoFocus value={draft.title} onChange={(e) => set({ title: e.target.value })}
              placeholder="Anthurium Seedlings" className="input w-full" />
          </Field>
          <Field label="Subtitle">
            <input value={draft.subtitle} onChange={(e) => set({ subtitle: e.target.value })}
              placeholder="First-Month Care Calendar" className="input w-full" />
          </Field>
        </div>

        <Field label="Notes (substrate, conditions, potted date…)">
          <input value={draft.notes} onChange={(e) => set({ notes: e.target.value })}
            placeholder="Imported plugs · sphagnum moss · grow tent RH ~72%…" className="input w-full" />
        </Field>

        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Start date">
            <input type="date" value={draft.startDate} onChange={(e) => set({ startDate: e.target.value })} className="input w-full" />
          </Field>
          <Field label="Daily reminder (shown by the legend)">
            <input value={draft.dailyNote} onChange={(e) => set({ dailyNote: e.target.value })}
              placeholder="Observe leaves & moss daily · apply at dusk" className="input w-full" />
          </Field>
        </div>

        <Field label="Week phase labels (comma-separated, one per week)">
          <input value={weekLabelsText} onChange={(e) => setWeekLabelsText(e.target.value)}
            placeholder="Settle, Establish, First feed, Feed + flush" className="input w-full" />
        </Field>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Care tasks ({draft.tasks.length})</span>
            <button type="button" onClick={addTask}
              className="flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800">
              <Plus className="w-4 h-4" /> Add task
            </button>
          </div>

          {draft.tasks.length === 0 ? (
            <p className="text-sm text-gray-500 py-2">No tasks yet. Days with no task show "Observe only".</p>
          ) : (
            <div className="space-y-2">
              {draft.tasks
                .slice()
                .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
                .map(t => (
                  <div key={t.id} className="flex flex-wrap items-center gap-2 bg-gray-50 rounded-lg p-2">
                    <input type="date" value={t.date || ''} onChange={(e) => setTask(t.id, { date: e.target.value })}
                      className="input w-[140px]" />
                    <select value={t.type} onChange={(e) => setTask(t.id, { type: e.target.value })} className="input w-[150px]">
                      {CARE_TYPES.map(ct => <option key={ct.id} value={ct.id}>{ct.label}</option>)}
                    </select>
                    <input value={t.title} onChange={(e) => setTask(t.id, { title: e.target.value })}
                      placeholder="Task" className="input flex-1 min-w-[120px]" />
                    <input value={t.detail} onChange={(e) => setTask(t.id, { detail: e.target.value })}
                      placeholder="Detail (optional)" className="input flex-1 min-w-[120px]" />
                    <button type="button" onClick={() => removeTask(t.id)} aria-label="Remove task"
                      className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button type="submit" disabled={!canSave}
            className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-50">
            {isEdit ? 'Save calendar' : 'Create calendar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
