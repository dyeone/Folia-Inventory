import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Sprout, ScanLine, AlertTriangle, Check, Info,
} from 'lucide-react';

// Statuses where transitioning a TC to acclimated still makes sense.
// Anything outside this set produces a row with an error badge instead.
const ALLOWED_FROM = new Set(['available', 'listed']);

// Acclimation Mode — scan TC SKUs and flip them to "acclimated" in
// bulk. Mirrors LiveScanModal but the work happens server-side via
// the existing onStatusChange handler in App.jsx (which also does the
// sticky profit-rate bump). No bridge / queue.
export function AcclimationModal({ items, acclimatedRate, onStatusChange, onClose }) {
  const itemsBySku = useMemo(() => {
    const m = new Map();
    for (const i of items) if (i.sku) m.set(i.sku.toUpperCase(), i);
    return m;
  }, [items]);

  const [scanInput, setScanInput] = useState('');
  const [error, setError] = useState('');
  const [entries, setEntries] = useState([]);
  const inputRef = useRef(null);

  // Refocus the input on every render so HID-style scanners (which
  // type characters into whatever's focused) never miss a scan.
  useEffect(() => { inputRef.current?.focus(); });

  const acclimateOne = (rawSku) => {
    setError('');
    const sku = rawSku.trim().toUpperCase();
    if (!sku) return;
    const item = itemsBySku.get(sku);

    const baseRow = { tempId: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, sku };

    if (!item) {
      setEntries(prev => [{ ...baseRow, state: 'error', message: 'SKU not found' }, ...prev].slice(0, 50));
      return;
    }
    if (item.type !== 'tc') {
      setEntries(prev => [{ ...baseRow, name: item.name, variety: item.variety, state: 'error', message: 'Not a TC' }, ...prev].slice(0, 50));
      return;
    }
    if (item.status === 'acclimated') {
      setEntries(prev => [{ ...baseRow, name: item.name, variety: item.variety, state: 'skipped', message: 'Already acclimated' }, ...prev].slice(0, 50));
      return;
    }
    if (!ALLOWED_FROM.has(item.status)) {
      setEntries(prev => [{ ...baseRow, name: item.name, variety: item.variety, state: 'error', message: `Can't acclimate from "${item.status}"` }, ...prev].slice(0, 50));
      return;
    }

    // Compute display values for the new rate. Mirrors the bump rule in
    // App.jsx#onStatusChange — profit rate only goes up, never down.
    const previousRate = parseFloat(item.profitRate);
    const newRate = (!Number.isFinite(previousRate) || previousRate < acclimatedRate)
      ? acclimatedRate
      : previousRate;

    setEntries(prev => [{
      ...baseRow,
      name: item.name,
      variety: item.variety,
      previousRate: Number.isFinite(previousRate) ? previousRate : null,
      newRate,
      state: 'acclimated',
    }, ...prev].slice(0, 50));

    onStatusChange(item.id, 'acclimated');
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (!scanInput) return;
    acclimateOne(scanInput);
    setScanInput('');
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full max-w-3xl h-full sm:h-[92vh] sm:rounded-2xl flex flex-col">

        <div className="border-b border-gray-200 px-5 py-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-full bg-fuchsia-100 flex items-center justify-center flex-shrink-0">
              <Sprout className="w-5 h-5 text-fuchsia-600" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-gray-900 text-lg flex items-center gap-2">
                Acclimation Mode
                <span className="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full bg-fuchsia-100 text-fuchsia-800">
                  bumps to {acclimatedRate}%
                </span>
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Scan TC SKUs to flip them to <strong>Acclimated</strong>. Profit rate is bumped automatically.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Exit acclimation mode">
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
                placeholder="Scan a TC SKU…"
                autoComplete="off"
                spellCheck={false}
                className="w-full pl-12 pr-4 py-4 text-lg font-mono tabular-nums border-2 border-fuchsia-300 bg-fuchsia-50/40 rounded-xl focus:outline-none focus:ring-2 focus:ring-fuchsia-500 focus:border-fuchsia-500"
              />
            </div>
          </form>
          {error && (
            <div className="flex items-start gap-2 mt-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {error}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Recent scans
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
  const { sku, name, variety, previousRate, newRate, state, message } = entry;
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
      {state === 'acclimated' && newRate != null && (
        <div className="text-xs text-fuchsia-700 font-medium tabular-nums whitespace-nowrap">
          {previousRate != null ? `${previousRate.toFixed(0)}% → ` : ''}
          {newRate.toFixed(0)}%
        </div>
      )}
      <StateBadge state={state} message={message} />
    </div>
  );
}

function StateBadge({ state, message }) {
  if (state === 'acclimated') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-fuchsia-700"><Check className="w-3.5 h-3.5" /> Acclimated</span>;
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
