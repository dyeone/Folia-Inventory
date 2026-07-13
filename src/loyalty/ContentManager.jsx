import { useEffect, useState } from 'react';
import { Check, Loader2, Newspaper, Pencil, Plus, Sprout, Trash2 } from 'lucide-react';
import { api } from '../api.js';

// ░░ BAE customer hub — news & growing tips editor (Loyalty ▸ Content) ░░
//
// Rows live in customer_content (migration 0035). Staff author here through
// /api/settings (service role); customers read ACTIVE rows directly via RLS
// in the BAE Badges app, ordered by publishedAt. The `active` checkbox is the
// publish switch — flipping it on a row saves immediately.

const KINDS = [
  { id: 'news', label: 'News', icon: Newspaper, badge: 'bg-red-50 text-red-700 border border-red-100' },
  { id: 'tip', label: 'Growing tip', icon: Sprout, badge: 'bg-emerald-50 text-emerald-700 border border-emerald-100' },
];

const FILTERS = [
  { id: 'news', label: 'News' },
  { id: 'tip', label: 'Growing tips' },
  { id: 'all', label: 'All' },
];

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// ISO (or nothing) → the local "YYYY-MM-DDTHH:mm" shape datetime-local wants.
function toLocalInput(iso) {
  const parsed = iso ? new Date(iso) : new Date();
  const d = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function draftFrom(entry) {
  if (!entry) {
    return { id: null, kind: 'news', title: '', body: '', imageUrl: '', publishedAt: toLocalInput(null), active: true };
  }
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title || '',
    body: entry.body || '',
    imageUrl: entry.imageUrl || '',
    publishedAt: toLocalInput(entry.publishedAt),
    active: entry.active !== false,
  };
}

// Full payload for loyalty-content-save from an existing row (the server
// expects the whole entry even when only one field changed).
function payloadFrom(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    imageUrl: entry.imageUrl || undefined,
    publishedAt: entry.publishedAt,
    active: entry.active !== false,
  };
}

const byPublishedDesc = list =>
  [...list].sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));

function EntryRow({ entry, busy, onToggle, onEdit, onDelete }) {
  const kind = KINDS.find(k => k.id === entry.kind) || KINDS[0];
  const KindIcon = kind.icon;
  const firstLine = String(entry.body || '').split('\n')[0];
  return (
    <div className={`flex items-center gap-3 px-4 py-3 ${entry.active ? '' : 'opacity-60'}`}>
      <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${kind.badge}`}>
        <KindIcon className="w-3 h-3" /> {kind.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-gray-900 truncate">{entry.title}</div>
        <div className="text-xs text-gray-500 truncate">{firstLine}</div>
      </div>
      <div className="text-xs text-gray-500 whitespace-nowrap hidden sm:block">{formatDate(entry.publishedAt)}</div>
      <label className="flex items-center gap-1.5 text-xs text-gray-600" title="Visible in the app">
        <input
          type="checkbox"
          checked={entry.active !== false}
          disabled={busy}
          onChange={() => onToggle(entry)}
          className="rounded border-gray-300"
        />
        Active
      </label>
      <button onClick={() => onEdit(entry)} title="Edit" className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100">
        <Pencil className="w-4 h-4" />
      </button>
      <button
        onClick={() => onDelete(entry)}
        disabled={busy}
        title="Delete"
        className="p-1.5 rounded-lg text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
      </button>
    </div>
  );
}

export function ContentManager({ showToast }) {
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState('all');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  async function load() {
    try {
      const r = await api.listLoyaltyContent();
      setUnavailable(!!r.unavailable);
      setEntries(r.content || []);
    } catch (e) {
      showToast?.(e.message || 'Failed to load content', 'error');
    } finally {
      setReady(true);
    }
  }

  // load only setState()s after an await, so this isn't the cascading
  // synchronous update the rule guards against (same idiom as LoyaltyAdmin).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function patchDraft(p) {
    setDraft(d => ({ ...d, ...p }));
  }

  async function saveDraft() {
    if (saving) return;
    setSaving(true);
    try {
      const saved = await api.saveLoyaltyContent({
        ...(draft.id ? { id: draft.id } : {}),
        kind: draft.kind,
        title: draft.title,
        body: draft.body,
        imageUrl: draft.imageUrl.trim() || undefined,
        publishedAt: draft.publishedAt ? new Date(draft.publishedAt).toISOString() : undefined,
        active: draft.active,
      });
      setEntries(list => {
        const rest = list.filter(e => e.id !== saved.id);
        return byPublishedDesc([saved, ...rest]);
      });
      setDraft(null);
      showToast?.(draft.id ? 'Post updated' : 'Post saved');
    } catch (e) {
      showToast?.(e.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(entry) {
    setBusyId(entry.id);
    try {
      const saved = await api.saveLoyaltyContent({ ...payloadFrom(entry), active: entry.active === false });
      setEntries(list => list.map(e => (e.id === saved.id ? saved : e)));
      // If this row is open in the editor, mirror the toggle into the draft so
      // a later Save doesn't silently revert it.
      setDraft(d => (d?.id === saved.id ? { ...d, active: saved.active } : d));
      showToast?.(saved.active ? 'Post published' : 'Post hidden from the app');
    } catch (e) {
      showToast?.(e.message || 'Update failed', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(entry) {
    if (!window.confirm(`Delete "${entry.title}"? Customers will no longer see it.`)) return;
    setBusyId(entry.id);
    try {
      await api.deleteLoyaltyContent(entry.id);
      setEntries(list => list.filter(e => e.id !== entry.id));
      if (draft?.id === entry.id) setDraft(null);
      showToast?.('Post deleted');
    } catch (e) {
      showToast?.(e.message || 'Delete failed', 'error');
    } finally {
      setBusyId(null);
    }
  }

  if (!ready) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500 text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading content…
      </div>
    );
  }

  const visible = entries.filter(e => filter === 'all' || e.kind === filter);

  return (
    <div className="space-y-4">
      {unavailable && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl px-4 py-3">
          The customer hub tables aren&apos;t set up yet — apply{' '}
          <code className="font-mono">supabase/migrations/0035_bae_customer_hub.sql</code> in the
          Supabase SQL editor, then refresh.
        </div>
      )}

      <div className="flex items-center gap-2">
        {FILTERS.map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1 text-xs rounded-full border ${filter === f.id
              ? 'bg-gray-900 text-white border-gray-900'
              : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}
          >
            {f.label}
          </button>
        ))}
        <button
          onClick={() => setDraft(draftFrom(null))}
          disabled={unavailable || !!draft}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60"
        >
          <Plus className="w-4 h-4" /> New post
        </button>
      </div>

      {draft && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
          <h3 className="text-sm font-semibold text-gray-900">{draft.id ? 'Edit post' : 'New post'}</h3>
          <div className="grid sm:grid-cols-[10rem_1fr] gap-4">
            <label className="block">
              <span className="block text-xs font-medium text-gray-500 mb-1">Kind</span>
              <select
                value={draft.kind}
                onChange={e => patchDraft({ kind: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                <option value="news">News</option>
                <option value="tip">Growing tip</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-500 mb-1">Title</span>
              <input
                type="text"
                value={draft.title}
                maxLength={120}
                onChange={e => patchDraft({ title: e.target.value })}
                placeholder="e.g. New anthurium drop this Friday"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </label>
          </div>
          <label className="block">
            <span className="block text-xs font-medium text-gray-500 mb-1">Body</span>
            <textarea
              rows={6}
              value={draft.body}
              onChange={e => patchDraft({ body: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-y"
            />
          </label>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="block text-xs font-medium text-gray-500 mb-1">Image</span>
              <input
                type="text"
                value={draft.imageUrl}
                onChange={e => patchDraft({ imageUrl: e.target.value })}
                placeholder="https:// image link (optional)"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-gray-500 mb-1">Publish date</span>
              <input
                type="datetime-local"
                value={draft.publishedAt}
                onChange={e => patchDraft({ publishedAt: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </label>
          </div>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={draft.active}
                onChange={e => patchDraft({ active: e.target.checked })}
                className="rounded border-gray-300"
              />
              Active (visible in the app)
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setDraft(null)}
                className="px-3 py-2 text-sm rounded-lg text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={saveDraft}
                disabled={saving || !draft.title.trim() || !draft.body.trim()}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-60"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {visible.length === 0 ? (
          <div className="px-4 py-6 text-sm text-gray-500">
            No posts yet. Use “New post” to write BAE news or a growing tip.
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {visible.map(entry => (
              <EntryRow
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                onToggle={toggleActive}
                onEdit={e => {
                  // Don't silently blow away an open draft (New post is
                  // disabled while editing; Edit deserves the same care).
                  if (draft && draft.id !== e.id
                    && !window.confirm('Discard the post you are currently editing?')) return;
                  setDraft(draftFrom(e));
                }}
                onDelete={remove}
              />
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500">Published posts appear in the BAE Badges app feed.</p>
    </div>
  );
}
