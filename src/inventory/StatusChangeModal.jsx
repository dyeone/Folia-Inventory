import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, ArrowLeftRight, ScanLine, AlertTriangle, Check, Info,
} from 'lucide-react';

// Statuses an operator can batch-apply by scanning. TC-only statuses
// (acclimated) and the conversion op (converted) are intentionally left out —
// this mode is for moving plants through the sale lifecycle, not TC handling.
// Badge classes mirror the per-row status pill in InventoryView.
const STATUSES = [
  { value: 'available', label: 'Available', badge: 'bg-gray-100 text-gray-700' },
  { value: 'listed', label: 'Listed', badge: 'bg-amber-100 text-amber-800' },
  { value: 'consigned', label: 'On Consignment', badge: 'bg-orange-100 text-orange-800' },
  { value: 'sold', label: 'Sold', badge: 'bg-blue-100 text-blue-800' },
  { value: 'shipped', label: 'Shipped', badge: 'bg-violet-100 text-violet-800' },
  { value: 'delivered', label: 'Delivered', badge: 'bg-emerald-100 text-emerald-800' },
];

const labelFor = (v) => STATUSES.find(s => s.value === v)?.label
  || (v ? v.charAt(0).toUpperCase() + v.slice(1) : '—');
const badgeFor = (v) => STATUSES.find(s => s.value === v)?.badge || 'bg-gray-200 text-gray-600';

// Status Change Mode (BAE) — pick a target status, then scan SKUs to flip each
// scanned item to that status in bulk. Mirrors AcclimationModal's scan loop,
// but the target is operator-chosen instead of hard-coded to "acclimated", and
// there's no TC/profit-rate coupling. Work happens server-side via the shared
// onStatusChange handler in App.jsx. No bridge / queue.
export function StatusChangeModal({ items, onStatusChange, onClose }) {
  const itemsBySku = useMemo(() => {
    const m = new Map();
    for (const i of items) if (i.sku) m.set(i.sku.toUpperCase(), i);
    return m;
  }, [items]);

  const [target, setTarget] = useState('listed');
  const [scanInput, setScanInput] = useState('');
  const [entries, setEntries] = useState([]);
  const inputRef = useRef(null);

  // Refocus the input on every render so HID-style scanners (which type into
  // whatever's focused) never miss a scan.
  useEffect(() => { inputRef.current?.focus(); });

  const applyOne = (rawSku) => {
    const sku = rawSku.trim().toUpperCase();
    if (!sku) return;
    const item = itemsBySku.get(sku);
    const baseRow = { tempId: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, sku };

    if (!item) {
      setEntries(prev => [{ ...baseRow, state: 'error', message: 'SKU not found' }, ...prev].slice(0, 50));
      return;
    }
    if (item.status === target) {
      setEntries(prev => [{
        ...baseRow, name: item.name, variety: item.variety, from: item.status, to: target,
        state: 'skipped', message: `Already ${labelFor(target)}`,
      }, ...prev].slice(0, 50));
      return;
    }

    setEntries(prev => [{
      ...baseRow, name: item.name, variety: item.variety,
      from: item.status, to: target, state: 'changed',
    }, ...prev].slice(0, 50));

    onStatusChange(item.id, target);
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (!scanInput) return;
    applyOne(scanInput);
    setScanInput('');
  };

  const changedCount = entries.filter(e => e.state === 'changed').length;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full max-w-3xl h-full sm:h-[92vh] sm:rounded-2xl flex flex-col">

        <div className="border-b border-gray-200 px-5 py-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
              <ArrowLeftRight className="w-5 h-5 text-indigo-600" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-gray-900 text-lg flex items-center gap-2">
                Status Change
                <span className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full ${badgeFor(target)}`}>
                  → {labelFor(target)}
                </span>
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Pick a status, then scan SKUs to move each item to <strong>{labelFor(target)}</strong>.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Exit status change mode">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pt-4 flex-shrink-0 space-y-3">
          {/* Target status picker */}
          <div className="flex flex-wrap gap-1.5">
            {STATUSES.map(s => {
              const active = s.value === target;
              return (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setTarget(s.value)}
                  className={`px-3 py-1.5 text-sm rounded-lg border transition ${
                    active
                      ? 'border-indigo-500 ring-2 ring-indigo-500 bg-indigo-50 text-indigo-800 font-medium'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          <form onSubmit={onSubmit}>
            <div className="relative">
              <ScanLine className="w-5 h-5 text-gray-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input
                ref={inputRef}
                type="text"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                placeholder={`Scan a SKU to mark ${labelFor(target)}…`}
                autoComplete="off"
                spellCheck={false}
                className="w-full pl-12 pr-4 py-4 text-lg font-mono tabular-nums border-2 border-indigo-300 bg-indigo-50/40 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
          </form>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center justify-between">
            <span>Recent scans</span>
            {changedCount > 0 && (
              <span className="text-indigo-600 normal-case tracking-normal font-medium">
                {changedCount} changed
              </span>
            )}
          </h4>
          {entries.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400">
              Waiting for the first scan…
            </div>
          ) : (
            <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl bg-white">
              {entries.map(e => (
                <EntryRow key={e.tempId} entry={e} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EntryRow({ entry }) {
  const { sku, name, variety, from, to, state, message } = entry;
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
      {from != null && to != null && (
        <div className="hidden sm:flex items-center gap-1.5 text-[11px] whitespace-nowrap">
          <span className={`px-1.5 py-0.5 rounded ${badgeFor(from)}`}>{labelFor(from)}</span>
          <ArrowLeftRight className="w-3 h-3 text-gray-400" />
          <span className={`px-1.5 py-0.5 rounded ${badgeFor(to)}`}>{labelFor(to)}</span>
        </div>
      )}
      <StateBadge state={state} message={message} />
    </div>
  );
}

function StateBadge({ state, message }) {
  if (state === 'changed') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-indigo-700"><Check className="w-3.5 h-3.5" /> Changed</span>;
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
