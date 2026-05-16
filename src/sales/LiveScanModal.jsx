import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Radio, ScanLine, AlertTriangle, Check, Loader2, WifiOff, Wifi, RotateCw,
} from 'lucide-react';
import { api } from '../api.js';
import { buildLookups, computeIdealPrice } from '../inventory/pricing.js';

const SOLD_STATUSES = new Set(['sold', 'shipped', 'delivered']);
const POLL_MS = 1500;

// Live Scan Mode — keep the input autofocused; every barcode scan
// resolves the SKU locally and enqueues a Palmstreet listing job.
// No per-scan confirmation: scan = list it.
export function LiveScanModal({ items, varieties, species, idealRate, onClose }) {
  const lookups = useMemo(() => buildLookups(varieties, species), [varieties, species]);
  const itemsBySku = useMemo(() => {
    const m = new Map();
    for (const i of items) if (i.sku) m.set(i.sku.toUpperCase(), i);
    return m;
  }, [items]);

  // `entries` is what the operator sees; latest first. Each entry tracks
  // its own bridge job id (if it got that far) and a status for the badge.
  const [entries, setEntries] = useState([]);
  const [scanInput, setScanInput] = useState('');
  const [error, setError] = useState('');
  const [forcePush, setForcePush] = useState(null); // { sku, item } when sold-block triggers
  const [bridgeStatus, setBridgeStatus] = useState({ online: false, queued: 0 });
  const inputRef = useRef(null);

  // Refocus the scanner input on every render unless the operator is
  // typing in the (rare) force-push confirm dialog. Scanners are HID
  // devices that just emit characters — losing focus = lost scans.
  useEffect(() => {
    if (!forcePush) inputRef.current?.focus();
  });

  // Poll bridge health so the operator can see whether the bridge is
  // actually running. Scans still go through when offline (jobs queue).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const h = await api.bridgeHealth();
        if (!cancelled) setBridgeStatus(h);
      } catch { /* keep last value */ }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Poll job status for any entry that's still pending. Drops out of the
  // poll set as jobs reach a terminal state.
  useEffect(() => {
    const pending = entries.filter(e => e.jobId && (e.state === 'queued' || e.state === 'pushing'));
    if (pending.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const ids = pending.map(p => p.jobId);
        const jobs = await api.bridgeStatus(ids);
        if (cancelled) return;
        const byId = new Map(jobs.map(j => [j.id, j]));
        setEntries(prev => prev.map(e => {
          const j = e.jobId && byId.get(e.jobId);
          if (!j) return e;
          if (j.status === 'done') return { ...e, state: 'live' };
          if (j.status === 'failed') return { ...e, state: 'failed', errorMsg: j.error || 'Bridge error' };
          if (j.status === 'running') return { ...e, state: 'pushing' };
          return e;
        }));
      } catch { /* keep polling */ }
    };
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [entries]);

  const resolvePrice = (item) => {
    const listing = parseFloat(item.listingPrice);
    if (Number.isFinite(listing) && listing > 0) return listing;
    const ideal = computeIdealPrice(item, idealRate, lookups);
    if (Number.isFinite(ideal) && ideal > 0) return Math.round(ideal * 100) / 100;
    return null;
  };

  const pushItem = async (item, { forced = false } = {}) => {
    const price = resolvePrice(item);
    const tempId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setEntries(prev => [
      { tempId, sku: item.sku, name: item.name, variety: item.variety, price, state: 'queued', jobId: null, scannedAt: new Date().toISOString(), forced },
      ...prev,
    ].slice(0, 50));
    try {
      const job = await api.bridgeEnqueue({
        jobAction: 'listing',
        payload: {
          sku: item.sku,
          name: item.name,
          price,
          grossCost: item.grossCost,  // bridge types this into the Starting Price field
          forced,
        },
      });
      setEntries(prev => prev.map(e => e.tempId === tempId ? { ...e, jobId: job.id } : e));
    } catch (e) {
      setEntries(prev => prev.map(en => en.tempId === tempId ? { ...en, state: 'failed', errorMsg: e.message } : en));
    }
  };

  const handleScan = (rawSku) => {
    setError('');
    const sku = rawSku.trim().toUpperCase();
    if (!sku) return;
    const item = itemsBySku.get(sku);
    if (!item) {
      setError(`No item with SKU "${sku}".`);
      return;
    }
    if (SOLD_STATUSES.has(item.status)) {
      setForcePush({ sku, item });
      return;
    }
    const price = resolvePrice(item);
    if (price == null) {
      setError(`${sku} has no listing price and no cultivar/global rate to fall back on.`);
      return;
    }
    pushItem(item);
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (!scanInput) return;
    handleScan(scanInput);
    setScanInput('');
  };

  // Scanner-dropped-Enter fallback. Most barcode scanners append a CR
  // after the code which triggers onSubmit naturally, but some scanners
  // skip it intermittently (low battery, flaky USB, profile config).
  // When the field matches the SKU pattern and stays stable for 200 ms,
  // submit anyway. A real human typing pauses longer between characters,
  // so this rarely fires mid-type — and if it does, the SKU is already
  // valid so submitting early is harmless.
  useEffect(() => {
    if (!scanInput || forcePush) return;
    if (!/^[A-Za-z]{2,4}-\d+$/.test(scanInput.trim())) return;
    const id = setTimeout(() => {
      handleScan(scanInput);
      setScanInput('');
    }, 200);
    return () => clearTimeout(id);
  }, [scanInput, forcePush]);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full max-w-3xl h-full sm:h-[92vh] sm:rounded-2xl flex flex-col">

        <div className="border-b border-gray-200 px-5 py-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
              <Radio className="w-5 h-5 text-red-600" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-gray-900 text-lg flex items-center gap-2">
                Live Scan Mode
                <BridgeBadge status={bridgeStatus} />
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Each barcode scan auto-pushes that SKU to Palmstreet as a listing.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Exit live mode">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pt-4 flex-shrink-0">
          <form onSubmit={onSubmit}>
            <label className="block">
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
                  className="w-full pl-12 pr-4 py-4 text-lg font-mono tabular-nums border-2 border-emerald-300 bg-emerald-50/40 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                />
              </div>
            </label>
          </form>
          {error && (
            <div className="flex items-start gap-2 mt-2 bg-red-50 text-red-700 text-sm px-3 py-2 rounded-lg">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {error}
            </div>
          )}
          {!bridgeStatus.online && (
            <div className="flex items-start gap-2 mt-2 bg-amber-50 text-amber-800 text-xs px-3 py-2 rounded-lg">
              <WifiOff className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              Bridge offline — scans will queue and run when it reconnects ({bridgeStatus.queued} pending).
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Recently pushed
          </h4>
          {entries.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400">
              Waiting for the first scan…
            </div>
          ) : (
            <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl bg-white">
              {entries.map(e => (
                <EntryRow
                  key={e.tempId}
                  entry={e}
                  onRetry={() => {
                    const item = itemsBySku.get(e.sku.toUpperCase());
                    if (item) pushItem(item, { forced: e.forced });
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {forcePush && (
          <ForcePushDialog
            sku={forcePush.sku}
            item={forcePush.item}
            onConfirm={() => {
              pushItem(forcePush.item, { forced: true });
              setForcePush(null);
            }}
            onCancel={() => setForcePush(null)}
          />
        )}
      </div>
    </div>
  );
}

function BridgeBadge({ status }) {
  if (status.online) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
        <Wifi className="w-3 h-3" /> Bridge live
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
      <WifiOff className="w-3 h-3" /> Offline
    </span>
  );
}

function EntryRow({ entry, onRetry }) {
  const { sku, name, variety, price, state, errorMsg, forced } = entry;
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-900 truncate">
            {name}
            {forced && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-amber-700">forced</span>}
          </div>
          <div className="text-xs text-gray-500 flex items-center gap-1.5">
            <span className="font-mono">{sku}</span>
            {variety && <span>· {variety}</span>}
          </div>
        </div>
        <div className="text-sm font-semibold text-gray-900 tabular-nums">
          {price != null ? `$${price.toFixed(2)}` : '—'}
        </div>
        <StateBadge state={state} errorMsg={errorMsg} />
        {state === 'failed' && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 rounded"
            title="Re-push this item"
          >
            <RotateCw className="w-3.5 h-3.5" /> Retry
          </button>
        )}
      </div>
      {state === 'failed' && errorMsg && (
        <div className="mt-1 text-xs text-red-700 break-words">
          {errorMsg}
        </div>
      )}
    </div>
  );
}

function StateBadge({ state, errorMsg }) {
  if (state === 'live') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><Check className="w-3.5 h-3.5" /> Live</span>;
  }
  if (state === 'pushing') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Pushing</span>;
  }
  if (state === 'queued') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-600"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Queued</span>;
  }
  if (state === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700" title={errorMsg}>
        <AlertTriangle className="w-3.5 h-3.5" /> Failed
      </span>
    );
  }
  return null;
}

function ForcePushDialog({ sku, item, onConfirm, onCancel }) {
  return (
    <div className="absolute inset-0 bg-black/40 flex items-center justify-center p-4 z-10">
      <div className="bg-white rounded-xl max-w-sm w-full p-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold text-gray-900">Already sold</h4>
            <p className="text-sm text-gray-600 mt-1">
              <span className="font-mono">{sku}</span> ({item.name}) is marked
              <span className="font-medium"> {item.status}</span>. Push anyway?
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">
            Cancel
          </button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-lg">
            Force push
          </button>
        </div>
      </div>
    </div>
  );
}
