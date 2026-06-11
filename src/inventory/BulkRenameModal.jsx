import { useMemo, useState } from 'react';
import { X, Pencil, Search, Check, GitMerge, AlertCircle } from 'lucide-react';

// Bulk-rename item (cultivar) names — the group names shown in the Inventory
// list. Every distinct item.name becomes an editable row; saving renames every
// item under that name. Editing two names to the same value merges their
// groups (grouping is purely by name). Renames are matched by the exact item
// ids in each group (trim-aware, like the inventory grouping), not by a raw
// name string, so whitespace variants can't be missed.
export function BulkRenameModal({ items, onApply, onClose }) {
  // Group live items by trimmed name → { name, count, ids }, mirroring the
  // InventoryView grouping so a rename hits exactly what the operator sees.
  const groups = useMemo(() => {
    const map = new Map();
    for (const it of items) {
      const name = (it.name || '').trim() || '(unnamed)';
      if (!map.has(name)) map.set(name, { name, count: 0, ids: [] });
      const g = map.get(name);
      g.count += 1;
      g.ids.push(it.id);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  // editedName: original name → current input value. Missing key = unchanged.
  const [edited, setEdited] = useState({});
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const valueFor = (name) => (edited[name] ?? name);

  // Recomputed each render (cheap, and `edited` changes on every keystroke):
  // the resulting name for each group, the set of names that exist after the
  // edits (to flag merges), and the list of actually-changed groups.
  const targetNames = new Map(); // resulting-name → how many source groups land on it
  for (const g of groups) {
    const v = valueFor(g.name).trim() || g.name;
    targetNames.set(v, (targetNames.get(v) || 0) + 1);
  }
  const changes = groups.filter(g => {
    const v = valueFor(g.name).trim();
    return v && v !== g.name;
  });
  const changedItemCount = changes.reduce((s, g) => s + g.count, 0);
  // A merge = more than one (post-edit) group lands on the same resulting
  // name. targetNames already self-maps every unchanged group, so a rename
  // into an unchanged group counts 2 (flagged), while a swap/vacate counts 1
  // each (correctly not flagged).
  const mergeCount = changes.filter(g => targetNames.get(valueFor(g.name).trim()) > 1).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(g => g.name.toLowerCase().includes(q));
  }, [groups, query]);

  const setName = (orig, value) => setEdited(prev => ({ ...prev, [orig]: value }));
  const resetRow = (orig) => setEdited(prev => {
    const next = { ...prev };
    delete next[orig];
    return next;
  });

  const handleSave = async () => {
    if (changes.length === 0 || busy) return;
    // One entry per changed group; the server applies each as a single
    // atomic set-based update (a group is never left half-renamed).
    const renames = changes.map(g => ({ ids: g.ids, name: valueFor(g.name).trim() }));
    setBusy(true);
    await onApply(renames, { names: changes.length, items: changedItemCount });
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full max-w-3xl h-full sm:h-[92vh] sm:rounded-2xl flex flex-col">

        <div className="border-b border-gray-200 px-5 py-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
              <Pencil className="w-5 h-5 text-indigo-600" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-gray-900 text-lg">Edit item names</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Rename a cultivar to update every item under it. Two names edited to the same value merge into one group.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pt-4 flex-shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${groups.length} names…`}
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {visible.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400">No names match "{query}".</div>
          ) : (
            <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl bg-white">
              {visible.map(g => {
                const value = valueFor(g.name);
                const trimmed = value.trim();
                // An all-blank value is simply ignored (can't blank a name), so
                // it never counts as a change and never saves.
                const changed = trimmed && trimmed !== g.name;
                // Merges only when more than one post-edit group lands on this
                // resulting name (handles rename-into-existing and many→one;
                // a swap/vacate is correctly not flagged).
                const mergesInto = changed && targetNames.get(trimmed) > 1;
                return (
                  <div key={g.name} className={`flex items-center gap-2 px-3 py-2 ${changed ? 'bg-indigo-50/40' : ''}`}>
                    <span className="text-xs text-gray-500 tabular-nums w-12 text-right flex-shrink-0">
                      {g.count}×
                    </span>
                    <input
                      value={value}
                      onChange={(e) => setName(g.name, e.target.value)}
                      spellCheck={false}
                      className={`flex-1 min-w-0 px-2.5 py-1.5 text-sm border rounded-lg focus:outline-none focus:ring-2 ${
                        changed
                          ? 'border-indigo-300 bg-white focus:ring-indigo-500'
                          : 'border-gray-200 focus:ring-indigo-500'
                      }`}
                    />
                    {mergesInto && (
                      <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-amber-700 whitespace-nowrap flex-shrink-0" title="Another group has this name — they'll merge">
                        <GitMerge className="w-3.5 h-3.5" /> merges
                      </span>
                    )}
                    {changed && (
                      <button
                        onClick={() => resetRow(g.name)}
                        title="Revert"
                        className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded flex-shrink-0"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 px-5 py-3 flex items-center justify-between gap-3 flex-shrink-0">
          <div className="text-sm text-gray-600 min-w-0">
            {changes.length === 0 ? (
              'No changes'
            ) : (
              <span className="flex items-center gap-1.5 flex-wrap">
                <span className="font-medium text-gray-900">{changes.length}</span> name{changes.length === 1 ? '' : 's'} →
                <span className="font-medium text-gray-900">{changedItemCount}</span> item{changedItemCount === 1 ? '' : 's'}
                {mergeCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-amber-700">
                    <GitMerge className="w-3.5 h-3.5" /> {mergeCount} merge{mergeCount === 1 ? '' : 's'}
                  </span>
                )}
              </span>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={changes.length === 0 || busy}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed rounded-lg transition flex-shrink-0"
          >
            <Check className="w-4 h-4" />
            {busy ? 'Saving…' : `Save${changes.length > 0 ? ` ${changes.length}` : ''}`}
          </button>
        </div>

        <div className="px-5 pb-3 -mt-1 flex-shrink-0">
          <div className="text-[11px] text-gray-400 flex items-start gap-1.5">
            <AlertCircle className="w-3 h-3 flex-shrink-0 mt-0.5" />
            Renames the inventory items only; the Species catalog and SKUs are unchanged.
          </div>
        </div>
      </div>
    </div>
  );
}
