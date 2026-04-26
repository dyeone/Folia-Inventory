import { useMemo, useState } from 'react';
import {
  Trash2, RotateCcw, Search, AlertCircle, ShieldAlert,
} from 'lucide-react';

const RETENTION_DAYS = 30;

function daysRemaining(deletedAt) {
  if (!deletedAt) return null;
  const elapsed = (Date.now() - new Date(deletedAt).getTime()) / 86400000;
  return Math.max(0, Math.ceil(RETENTION_DAYS - elapsed));
}

export function RecentlyDeletedView({ deletedItems, isAdmin, onRestore, onPurge }) {
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const rows = useMemo(() => {
    const sorted = [...deletedItems].sort((a, b) => {
      const da = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
      const db = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
      return db - da;
    });
    if (!search) return sorted;
    const q = search.toLowerCase();
    return sorted.filter(i => (
      i.sku?.toLowerCase().includes(q) ||
      i.name?.toLowerCase().includes(q) ||
      i.variety?.toLowerCase().includes(q) ||
      i.deletedBy?.toLowerCase().includes(q)
    ));
  }, [deletedItems, search]);

  const allSelected = rows.length > 0 && rows.every(r => selectedIds.has(r.id));
  const visibleSelected = useMemo(
    () => rows.filter(r => selectedIds.has(r.id)).map(r => r.id),
    [rows, selectedIds]
  );

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(rows.map(r => r.id)));
  };
  const clearSelection = () => setSelectedIds(new Set());

  const handleRestore = async (ids) => {
    await onRestore(ids);
    clearSelection();
  };
  const handlePurge = async (ids) => {
    await onPurge(ids);
    clearSelection();
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Trash2 className="w-5 h-5 text-amber-600" /> Recently Deleted
        </h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Deleted items stay here for {RETENTION_DAYS} days before being permanently removed.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search SKU, name, variety, deleted by…"
            className="w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
        </div>
      </div>

      {visibleSelected.length > 0 && (
        <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          <span className="text-sm font-medium text-emerald-900">
            {visibleSelected.length} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={() => handleRestore(visibleSelected)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white rounded-lg"
          >
            <RotateCcw className="w-4 h-4" /> Restore
          </button>
          {isAdmin && (
            <button
              onClick={() => handlePurge(visibleSelected)}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 active:bg-red-800 text-white rounded-lg"
              title="Delete forever (admin)"
            >
              <ShieldAlert className="w-4 h-4" /> Delete forever
            </button>
          )}
          <button onClick={clearSelection} className="text-xs text-gray-600 hover:text-gray-900 px-2">
            Clear
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <Trash2 className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">
            {deletedItems.length === 0
              ? 'Trash is empty. Deleted items will appear here.'
              : 'No items match your search.'}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-3 py-2 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500"
                    />
                  </th>
                  <th className="px-3 py-2 text-left font-medium">SKU</th>
                  <th className="px-3 py-2 text-left font-medium">Item</th>
                  <th className="px-3 py-2 text-left font-medium hidden md:table-cell">Variety</th>
                  <th className="px-3 py-2 text-left font-medium hidden lg:table-cell">Status (was)</th>
                  <th className="px-3 py-2 text-left font-medium hidden sm:table-cell">Deleted by</th>
                  <th className="px-3 py-2 text-right font-medium">Time left</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(item => {
                  const left = daysRemaining(item.deletedAt);
                  const expiringSoon = left !== null && left <= 3;
                  return (
                    <tr key={item.id} className="hover:bg-gray-50/50">
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(item.id)}
                          onChange={() => toggleSelect(item.id)}
                          className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500"
                        />
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-gray-700">{item.sku || '—'}</td>
                      <td className="px-3 py-2.5">
                        <div className="text-gray-900 truncate max-w-[200px]">{item.name}</div>
                        <div className="text-xs text-gray-500 md:hidden">{item.variety}</div>
                      </td>
                      <td className="px-3 py-2.5 text-gray-600 hidden md:table-cell">{item.variety || '—'}</td>
                      <td className="px-3 py-2.5 hidden lg:table-cell">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">
                          {item.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-gray-600 hidden sm:table-cell">
                        {item.deletedBy || '—'}
                      </td>
                      <td className={`px-3 py-2.5 text-right text-xs tabular-nums ${
                        expiringSoon ? 'text-red-600 font-medium' : 'text-gray-600'
                      }`}>
                        {left !== null ? (
                          <span className="inline-flex items-center gap-1">
                            {expiringSoon && <AlertCircle className="w-3 h-3" />}
                            {left} {left === 1 ? 'day' : 'days'}
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => handleRestore([item.id])}
                            className="p-1.5 text-emerald-700 hover:bg-emerald-50 active:bg-emerald-100 rounded-lg"
                            title="Restore"
                            aria-label="Restore"
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                          {isAdmin && (
                            <button
                              onClick={() => handlePurge([item.id])}
                              className="p-1.5 text-red-600 hover:bg-red-50 active:bg-red-100 rounded-lg"
                              title="Delete forever (admin)"
                              aria-label="Delete forever"
                            >
                              <ShieldAlert className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
