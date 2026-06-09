import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Trash2, ScanLine, AlertTriangle, Info,
} from 'lucide-react';

// Statuses worth flagging before deletion — the item is (or was) part of a
// sale, so deleting it may be a mis-scan rather than intent.
const SOLD_STATUSES = new Set(['sold', 'shipped', 'delivered']);

// Scan-to-Delete — scan SKUs to build up a staging list, then delete them
// all at once. Mirrors AcclimationModal's scan loop, but because delete is
// destructive nothing happens per-scan: items are only staged, and the
// actual delete goes through the parent's onBulkDelete (which shows the
// shared ConfirmDialog and soft-deletes into Recently Deleted).
export function DeleteScanModal({ items, onBulkDelete, onClose }) {
  const itemsBySku = useMemo(() => {
    const m = new Map();
    for (const i of items) if (i.sku) m.set(i.sku.toUpperCase(), i);
    return m;
  }, [items]);

  const [scanInput, setScanInput] = useState('');
  const [entries, setEntries] = useState([]);
  const inputRef = useRef(null);

  // Refocus the input on every render so HID-style scanners (which
  // type characters into whatever's focused) never miss a scan.
  useEffect(() => { inputRef.current?.focus(); });

  const stagedIds = useMemo(
    () => entries.filter(e => e.state === 'staged').map(e => e.itemId),
    [entries]
  );

  const scanOne = (rawSku) => {
    const sku = rawSku.trim().toUpperCase();
    if (!sku) return;
    const item = itemsBySku.get(sku);

    const baseRow = { tempId: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, sku };

    if (!item) {
      setEntries(prev => [{ ...baseRow, state: 'error', message: 'SKU not found' }, ...prev]);
      return;
    }
    if (stagedIds.includes(item.id)) {
      setEntries(prev => [{ ...baseRow, name: item.name, variety: item.variety, state: 'skipped', message: 'Already scanned' }, ...prev]);
      return;
    }

    setEntries(prev => [{
      ...baseRow,
      itemId: item.id,
      name: item.name,
      variety: item.variety,
      status: item.status,
      state: 'staged',
    }, ...prev]);
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (!scanInput) return;
    scanOne(scanInput);
    setScanInput('');
  };

  const removeEntry = (tempId) => {
    setEntries(prev => prev.filter(e => e.tempId !== tempId));
  };

  const handleDelete = () => {
    if (stagedIds.length === 0) return;
    // Parent shows the shared ConfirmDialog (it stacks above this modal);
    // the callback only fires after the delete actually went through.
    onBulkDelete(stagedIds, () => {
      setEntries([]);
      onClose();
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full max-w-3xl h-full sm:h-[92vh] sm:rounded-2xl flex flex-col">

        <div className="border-b border-gray-200 px-5 py-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
              <Trash2 className="w-5 h-5 text-red-600" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-gray-900 text-lg">Scan to Delete</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Scan SKUs to stage them, then delete everything in one step. Nothing is deleted until you confirm.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Exit scan-to-delete mode">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pt-4 flex-shrink-0">
          <form onSubmit={onSubmit}>
            <div className="relative">
              <ScanLine className="w-5 h-5 text-gray-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input
                ref={inputRef}
                type="text"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder="Scan a SKU…"
                autoComplete="off"
                spellCheck={false}
                className="w-full pl-12 pr-4 py-4 text-lg font-mono tabular-nums border-2 border-red-300 bg-red-50/40 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
              />
            </div>
          </form>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Staged for deletion
          </h4>
          {entries.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400">
              Waiting for the first scan…
            </div>
          ) : (
            <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl bg-white">
              {entries.map(e => (
                <EntryRow key={e.tempId} entry={e} onRemove={() => removeEntry(e.tempId)} />
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 px-5 py-3 flex items-center justify-between gap-3 flex-shrink-0">
          <div className="text-sm text-gray-600">
            {stagedIds.length === 0
              ? 'No items staged'
              : `${stagedIds.length} ${stagedIds.length === 1 ? 'item' : 'items'} staged`}
          </div>
          <button
            onClick={handleDelete}
            disabled={stagedIds.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed rounded-lg transition"
          >
            <Trash2 className="w-4 h-4" />
            Delete {stagedIds.length > 0 ? stagedIds.length : ''} {stagedIds.length === 1 ? 'item' : 'items'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EntryRow({ entry, onRemove }) {
  const { sku, name, variety, status, state, message } = entry;
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-gray-900 truncate">
          {name || <span className="italic text-gray-400">unknown</span>}
        </div>
        <div className="text-xs text-gray-500 flex items-center gap-1.5">
          <span className="font-mono">{sku}</span>
          {variety && <span>· {variety}</span>}
        </div>
      </div>
      {state === 'staged' && SOLD_STATUSES.has(status) && (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full whitespace-nowrap" title={`This item is marked "${status}" — deleting it may be a mis-scan`}>
          <AlertTriangle className="w-3 h-3" /> {status}
        </span>
      )}
      <StateBadge state={state} message={message} />
      {state === 'staged' && (
        <button
          onClick={onRemove}
          title="Remove from staging"
          aria-label={`Remove ${sku} from staging`}
          className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function StateBadge({ state, message }) {
  if (state === 'staged') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700"><Trash2 className="w-3.5 h-3.5" /> Will delete</span>;
  }
  if (state === 'skipped') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-600" title={message}><Info className="w-3.5 h-3.5" /> Skipped</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700" title={message}>
      <AlertTriangle className="w-3.5 h-3.5" /> {message || 'Failed'}
    </span>
  );
}
