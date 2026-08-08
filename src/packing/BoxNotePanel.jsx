import { useState } from 'react';
import { StickyNote, Pencil, Snowflake } from 'lucide-react';

// Sky strip shown on a box the desk marked "extra insulation" (migration
// 0037; distinct from the computed heat-check flags). Renders in the
// Ready/Shipped BoxRow and the drill-down ShipBoxCard; the packer app shows
// its own banner from the same box-notes field. Clear stays available until
// the box ships.
export function InsulationStrip({ on, onToggle, allShipped, compact = false }) {
  const [busy, setBusy] = useState(false);
  if (!on) return null;
  return (
    <div
      className={`bg-sky-50 border-t border-sky-100 flex items-center gap-2 ${compact ? 'px-3 py-2' : 'px-4 py-2.5'}`}
      onClick={(e) => e.stopPropagation()}
    >
      <Snowflake className="w-4 h-4 text-sky-600 flex-shrink-0" />
      <span className="text-sm font-semibold text-sky-800">EXTRA INSULATION</span>
      <span className="text-xs text-sky-700 hidden sm:inline">— pack this box with extra insulation</span>
      {!allShipped && onToggle && (
        <button
          type="button"
          disabled={busy}
          onClick={async (e) => {
            e.stopPropagation();
            setBusy(true);
            try { await onToggle(false); } finally { setBusy(false); }
          }}
          className="ml-auto text-xs font-medium text-sky-700 hover:bg-sky-100 rounded px-2 py-1 disabled:opacity-50"
        >
          Clear
        </button>
      )}
    </div>
  );
}

// The action-row chip that toggles the mark on (the strip above carries the
// clear affordance once set). Same chip grammar as Hold / Local pickup.
export function InsulationChip({ on, onToggle, stop }) {
  const [busy, setBusy] = useState(false);
  if (on) return null;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async (e) => {
        stop?.(e);
        setBusy(true);
        try { await onToggle(true); } finally { setBusy(false); }
      }}
      title="Mark this box: pack with extra insulation (the packer sees a banner)"
      className="text-xs font-medium px-2 py-1 rounded-md border border-gray-300 text-gray-600 bg-white hover:bg-sky-50 hover:text-sky-700 hover:border-sky-300 active:bg-sky-100 flex items-center gap-1 disabled:opacity-50"
    >
      <Snowflake className="w-3 h-3" /> Insulation
    </button>
  );
}

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
