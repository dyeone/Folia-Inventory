import { useState } from 'react';
import { Plus, Leaf } from 'lucide-react';
import { ConfirmDialog } from '../ui/ConfirmDialog.jsx';
import { CareCalendarGrid } from './CareCalendarGrid.jsx';
import { CareCalendarEditor } from './CareCalendarEditor.jsx';
import { careProgress, anthuriumTemplate } from './careHelpers.js';

// The Plant Care tab: a shared, operational care schedule per plant batch.
// Anyone can check off care work; admins create / edit / delete calendars.
export function CareCalendarView({ calendars, onSave, onDelete, onToggleTask, isAdmin }) {
  const [selectedId, setSelectedId] = useState(null);
  const [editor, setEditor] = useState(null); // {} = new, {calendar} = edit, null = closed
  const [confirmDel, setConfirmDel] = useState(null);

  const selected = calendars.find(c => c.id === selectedId) || calendars[0] || null;

  const handleSave = async (cal) => {
    const saved = await onSave(cal);
    setSelectedId(saved?.id || cal.id);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Leaf className="w-5 h-5 text-emerald-600" /> Plant Care
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Shared care schedules — everyone sees the same plan and can check work off.
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setEditor({})}
            className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg"
          >
            <Plus className="w-4 h-4" /> <span className="hidden sm:inline">New calendar</span>
          </button>
        )}
      </div>

      {/* Calendar selector (only when there's more than one) */}
      {calendars.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {calendars.map(c => {
            const { done, total } = careProgress(c);
            const active = selected?.id === c.id;
            return (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                  active ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'
                }`}
              >
                {c.title}
                <span className={`ml-1.5 text-xs ${active ? 'text-emerald-100' : 'text-gray-400'}`}>{done}/{total}</span>
              </button>
            );
          })}
        </div>
      )}

      {selected ? (
        <CareCalendarGrid
          calendar={selected}
          onToggleTask={onToggleTask}
          isAdmin={isAdmin}
          onEdit={() => setEditor({ calendar: selected })}
          onDelete={() => setConfirmDel(selected)}
        />
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <Leaf className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
          <p className="text-sm text-gray-600">No care calendars yet.</p>
          {isAdmin && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button onClick={() => setEditor({})}
                className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg">
                New calendar
              </button>
              <button onClick={() => handleSave(anthuriumTemplate())}
                className="px-4 py-2 text-sm font-medium text-emerald-700 border border-emerald-200 hover:bg-emerald-50 rounded-lg">
                Load Anthurium sample
              </button>
            </div>
          )}
        </div>
      )}

      {editor && (
        <CareCalendarEditor
          calendar={editor.calendar || null}
          onSave={handleSave}
          onClose={() => setEditor(null)}
        />
      )}

      {confirmDel && (
        <ConfirmDialog
          title="Delete care calendar?"
          message={`"${confirmDel.title}" and all its tasks will be removed for everyone. This can't be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => { onDelete(confirmDel.id); if (selectedId === confirmDel.id) setSelectedId(null); setConfirmDel(null); }}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}
