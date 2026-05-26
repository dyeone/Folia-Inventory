import { useState } from 'react';
import { StickyNote, Pencil } from 'lucide-react';

// Operator's internal seller-note for a single box. Inline editable.
// Used in both the top-level BoxRow (Ready/Shipped tab list) and the
// drill-down ShipBoxCard. Same persistence path either way.
//
// Props:
//   note         — current note string (or null/undefined for "no note")
//   onSave(text) — async (text: string) => void. Receives the raw textarea
//                  value; the server-side handler trims and persists null
//                  for empty/whitespace.
//   allShipped   — when true, hide edit controls (CTA + pencil) but still
//                  render an existing note read-only.
//   showToast    — optional (msg, ms) => void
//   compact      — when true, render a single-line tighter layout suitable
//                  for the BoxRow strip; default false uses the larger
//                  ShipBoxCard layout with a labelled header.

export function BoxNotePanel({ note, onSave, allShipped, showToast, compact = false }) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const hasNote = !!(note && note.trim());

  const beginEdit = (e) => {
    e?.stopPropagation?.();
    setInput(note || '');
    setErr('');
    setEditing(true);
  };

  if (editing) {
    return (
      <div
        className={`bg-amber-50 border-t border-amber-100 space-y-2 ${compact ? 'px-3 py-2' : 'px-4 py-3'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[11px] uppercase tracking-wide text-amber-800 font-medium">Note</div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          autoFocus
          placeholder="Operator note for this box (internal — not printed)"
          className="w-full px-3 py-2 text-sm border border-amber-300 rounded-lg resize-y bg-white"
        />
        {err && <div className="text-sm text-red-600">{err}</div>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setEditing(false); setErr(''); }}
            disabled={saving}
            className="px-3 py-1.5 text-sm rounded-lg hover:bg-amber-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={async (e) => {
              e.stopPropagation();
              setSaving(true);
              setErr('');
              try {
                await onSave(input);
                setEditing(false);
                showToast?.('Note saved', 1800);
              } catch (ex) {
                setErr(ex.message || 'Save failed');
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving}
            className="px-3 py-1.5 text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-lg disabled:opacity-60"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  if (hasNote) {
    return (
      <div
        className={`bg-amber-50 border-t border-amber-100 flex items-start gap-2 ${compact ? 'px-3 py-2' : 'px-4 py-2.5'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <StickyNote className="w-3.5 h-3.5 text-amber-700 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0 text-sm text-amber-900 whitespace-pre-wrap break-words">{note}</div>
        {!allShipped && (
          <button
            type="button"
            onClick={beginEdit}
            title="Edit note"
            className="p-1 text-amber-700 hover:bg-amber-100 rounded shrink-0"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  }

  if (allShipped) return null;

  return (
    <div
      className={`border-t border-gray-100 bg-gray-50 ${compact ? 'px-3 py-1.5' : 'px-4 py-2'}`}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={beginEdit}
        className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-amber-700"
      >
        <StickyNote className="w-3.5 h-3.5" /> Add note
      </button>
    </div>
  );
}
