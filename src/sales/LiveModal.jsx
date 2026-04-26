import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Radio, Search, ScanLine, Gift, Check, RotateCcw,
  Play, Pause, ChevronRight, AlertCircle, ListOrdered,
} from 'lucide-react';

// Per-item live status, persisted in localStorage so a refresh during the
// stream doesn't lose where the streamer is.
//   queued  — not yet on Palmstreet
//   current — currently being sold
//   done    — finished
const STORAGE_KEY = (saleId) => `live-state-${saleId}`;

function loadState(saleId) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY(saleId));
    return raw ? JSON.parse(raw) : { itemStatus: {}, startedAt: null };
  } catch {
    return { itemStatus: {}, startedAt: null };
  }
}

export function LiveModal({ sale, items, onClose }) {
  const saleItems = useMemo(
    () => items.filter(i => i.saleId === sale.id),
    [items, sale.id]
  );
  const saleLots = useMemo(
    () => saleItems.filter(i => i.lotKind !== 'giveaway')
      .sort((a, b) => (parseInt(a.lotNumber) || 999999) - (parseInt(b.lotNumber) || 999999)),
    [saleItems]
  );
  const giveaways = useMemo(
    () => saleItems.filter(i => i.lotKind === 'giveaway'),
    [saleItems]
  );

  const [{ itemStatus, startedAt }, setLiveState] = useState(() => loadState(sale.id));
  const [now, setNow] = useState(() => Date.now());
  const [search, setSearch] = useState('');
  const [showGiveaways, setShowGiveaways] = useState(true);
  const [scanInput, setScanInput] = useState('');
  const [scanFlash, setScanFlash] = useState({ id: null, kind: null });
  const [scanMessage, setScanMessage] = useState(null);
  const scanRef = useRef(null);

  // Persist on every change.
  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY(sale.id),
      JSON.stringify({ itemStatus, startedAt }),
    );
  }, [sale.id, itemStatus, startedAt]);

  // Tick the elapsed clock when the live session is running.
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  useEffect(() => { scanRef.current?.focus(); }, []);

  // Brief visual feedback on scans / state changes.
  useEffect(() => {
    if (!scanFlash.id) return;
    const t = setTimeout(() => setScanFlash({ id: null, kind: null }), 1200);
    return () => clearTimeout(t);
  }, [scanFlash]);
  useEffect(() => {
    if (!scanMessage) return;
    const t = setTimeout(() => setScanMessage(null), 2000);
    return () => clearTimeout(t);
  }, [scanMessage]);

  const statusOf = (id) => itemStatus[id] || 'queued';

  // Update one item's status. If we're setting an item to 'current' we also
  // demote any existing current item back to 'queued' (only one item can be
  // live at a time). Setting to 'queued' from 'done' is a normal undo.
  const setStatus = (id, next) => {
    setLiveState(prev => {
      const current = prev.itemStatus[id] || 'queued';
      if (current === next) return prev;
      const updated = { ...prev.itemStatus };
      if (next === 'current') {
        for (const [k, v] of Object.entries(updated)) {
          if (v === 'current') updated[k] = 'queued';
        }
      }
      updated[id] = next;
      // Auto-start the live clock when the first item moves from queued.
      const startedAtNext = prev.startedAt
        ?? (next !== 'queued' ? Date.now() : null);
      return { ...prev, itemStatus: updated, startedAt: startedAtNext };
    });
  };

  // Scan handler: queued → current; current → done; done → flash "already sold".
  const handleScan = (raw) => {
    const code = (raw || '').trim();
    if (!code) return;
    const found = saleItems.find(i => i.sku?.toLowerCase() === code.toLowerCase());
    if (!found) {
      setScanMessage({ type: 'error', text: `SKU "${code}" not in this sale` });
      return;
    }
    const cur = statusOf(found.id);
    if (cur === 'queued') {
      setStatus(found.id, 'current');
      setScanFlash({ id: found.id, kind: 'current' });
      setScanMessage({ type: 'ok', text: `Now selling ${found.sku}` });
    } else if (cur === 'current') {
      setStatus(found.id, 'done');
      setScanFlash({ id: found.id, kind: 'done' });
      setScanMessage({ type: 'ok', text: `Sold ${found.sku}` });
    } else {
      setScanMessage({ type: 'warn', text: `${found.sku} already marked sold` });
      setScanFlash({ id: found.id, kind: 'done' });
    }
  };

  const onScanKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleScan(scanInput);
      setScanInput('');
    }
  };

  // Filter for the search box. Always shows current + giveaways (when toggled
  // on) regardless of search text so the streamer doesn't lose them.
  const matchesSearch = (item) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      item.sku?.toLowerCase().includes(q) ||
      item.name?.toLowerCase().includes(q) ||
      item.variety?.toLowerCase().includes(q) ||
      String(item.lotNumber || '').toLowerCase().includes(q)
    );
  };

  const currentItem = saleLots.find(i => statusOf(i.id) === 'current');
  const queuedItems = saleLots.filter(i => statusOf(i.id) === 'queued' && matchesSearch(i));
  const doneItems = saleLots.filter(i => statusOf(i.id) === 'done' && matchesSearch(i));

  const doneCount = saleLots.filter(i => statusOf(i.id) === 'done').length;
  const total = saleLots.length;
  const progress = total > 0 ? (doneCount / total) * 100 : 0;
  const elapsedMs = startedAt ? now - startedAt : 0;
  const elapsedLabel = formatElapsed(elapsedMs);

  const startSession = () => {
    if (!startedAt) setLiveState(prev => ({ ...prev, startedAt: Date.now() }));
  };
  const resetSession = () => {
    if (!confirm('Reset live progress for this sale? This clears the current/done state.')) return;
    setLiveState({ itemStatus: {}, startedAt: null });
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-900 flex flex-col" onClick={(e) => e.stopPropagation()}>
      {/* ───────── Header ───────── */}
      <div className="flex-shrink-0 bg-gray-900 text-white border-b border-gray-800 px-4 sm:px-6 py-3 flex items-center gap-3">
        <Radio className={`w-5 h-5 ${startedAt ? 'text-red-500 animate-pulse' : 'text-gray-500'}`} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-base sm:text-lg truncate">
            {sale.name}
            <span className="ml-2 text-xs uppercase tracking-wide text-gray-400">On Live</span>
          </div>
          <div className="text-xs text-gray-400 flex items-center gap-3">
            <span>{doneCount}/{total} sold</span>
            {startedAt && <span className="tabular-nums">{elapsedLabel}</span>}
            {giveaways.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <Gift className="w-3 h-3" /> {giveaways.length}
              </span>
            )}
          </div>
        </div>
        {!startedAt ? (
          <button
            onClick={startSession}
            className="hidden sm:flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 active:bg-red-800 text-white rounded-lg"
          >
            <Play className="w-4 h-4" /> Start
          </button>
        ) : (
          <button
            onClick={resetSession}
            className="hidden sm:flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-gray-800 hover:bg-gray-700 active:bg-gray-600 text-gray-200 rounded-lg"
            title="Reset progress"
          >
            <RotateCcw className="w-4 h-4" /> Reset
          </button>
        )}
        <button
          onClick={onClose}
          className="p-2 -mr-1 text-gray-400 hover:text-white hover:bg-gray-800 active:bg-gray-700 rounded-lg"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="h-1.5 bg-gray-800 flex-shrink-0">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* ───────── Scan + search bar ───────── */}
      <div className="flex-shrink-0 bg-gray-900 border-b border-gray-800 px-4 sm:px-6 py-3 grid sm:grid-cols-2 gap-2">
        <div className="relative">
          <ScanLine className="w-5 h-5 text-emerald-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            ref={scanRef}
            value={scanInput}
            onChange={(e) => setScanInput(e.target.value)}
            onKeyDown={onScanKeyDown}
            placeholder="Scan to advance: queued → live → sold"
            className="w-full pl-10 pr-3 py-3 text-base bg-gray-800 text-white placeholder-gray-500 border-2 border-emerald-700 rounded-lg focus:outline-none focus:border-emerald-500"
          />
          {scanMessage && (
            <div className={`absolute right-2 top-1/2 -translate-y-1/2 text-xs px-2 py-1 rounded ${
              scanMessage.type === 'error' ? 'bg-red-900 text-red-200'
                : scanMessage.type === 'warn' ? 'bg-amber-900 text-amber-200'
                : 'bg-emerald-900 text-emerald-200'
            }`}>
              {scanMessage.text}
            </div>
          )}
        </div>
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by SKU, name, lot #…"
            className="w-full pl-9 pr-3 py-3 text-sm bg-gray-800 text-white placeholder-gray-500 border border-gray-700 rounded-lg focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      {/* ───────── Body ───────── */}
      <div className="flex-1 overflow-y-auto bg-gray-50">
        <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-4">

          {/* Now Live card */}
          <Section
            label="Now Live"
            count={currentItem ? 1 : 0}
            tone="red"
          >
            {currentItem ? (
              <CurrentItemCard
                item={currentItem}
                onSold={() => setStatus(currentItem.id, 'done')}
                onRequeue={() => setStatus(currentItem.id, 'queued')}
              />
            ) : (
              <div className="bg-white border-2 border-dashed border-gray-300 rounded-xl p-8 text-center text-sm text-gray-500">
                Tap "Go Live" on a queued item below — or scan its barcode.
              </div>
            )}
          </Section>

          {/* Up Next */}
          <Section
            label="Up Next"
            count={queuedItems.length}
            tone="emerald"
            sub={search ? 'Filtered by search' : 'Sorted by lot #'}
          >
            {queuedItems.length === 0 ? (
              <EmptyHint message={search
                ? 'No queued items match.'
                : total === 0
                ? 'No items in this lineup yet.'
                : 'All caught up!'} />
            ) : (
              <ItemList>
                {queuedItems.map(item => (
                  <QueuedRow
                    key={item.id}
                    item={item}
                    flashed={scanFlash.id === item.id}
                    onGoLive={() => setStatus(item.id, 'current')}
                  />
                ))}
              </ItemList>
            )}
          </Section>

          {/* Sold */}
          {doneItems.length > 0 && (
            <Section label="Sold" count={doneItems.length} tone="gray">
              <ItemList>
                {doneItems.map(item => (
                  <DoneRow
                    key={item.id}
                    item={item}
                    onUndo={() => setStatus(item.id, 'queued')}
                  />
                ))}
              </ItemList>
            </Section>
          )}

          {/* Giveaways */}
          {giveaways.length > 0 && (
            <Section
              label="Giveaways"
              count={giveaways.length}
              tone="amber"
              actionLabel={showGiveaways ? 'Hide' : 'Show'}
              onAction={() => setShowGiveaways(!showGiveaways)}
            >
              {showGiveaways && (
                <ItemList>
                  {giveaways.filter(matchesSearch).map(item => (
                    <GiveawayRow key={item.id} item={item} />
                  ))}
                </ItemList>
              )}
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────── Sub-components ─────────────────────────────────────────

function Section({ label, count, tone, sub, actionLabel, onAction, children }) {
  const dotTone = {
    red:     'bg-red-500',
    emerald: 'bg-emerald-500',
    amber:   'bg-amber-500',
    gray:    'bg-gray-400',
  }[tone] || 'bg-gray-400';
  return (
    <section>
      <div className="flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${dotTone}`} />
          <h3 className="font-semibold text-gray-900">{label}</h3>
          <span className="text-xs text-gray-500 tabular-nums">{count}</span>
          {sub && <span className="text-xs text-gray-400">· {sub}</span>}
        </div>
        {actionLabel && (
          <button onClick={onAction} className="text-xs text-gray-600 hover:text-gray-900 font-medium">
            {actionLabel}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function ItemList({ children }) {
  return <div className="bg-white border border-gray-200 rounded-xl overflow-hidden divide-y divide-gray-100">{children}</div>;
}

function EmptyHint({ message }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
      <AlertCircle className="w-4 h-4" /> {message}
    </div>
  );
}

function CurrentItemCard({ item, onSold, onRequeue }) {
  return (
    <div className="bg-red-600 text-white rounded-xl p-5 sm:p-6 shadow-lg">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-red-100 mb-1">
            <Radio className="w-3.5 h-3.5 animate-pulse" /> Now Live
          </div>
          {item.lotNumber && (
            <div className="text-xs text-red-200 font-mono mb-1">
              <ListOrdered className="w-3 h-3 inline mr-1" /> Lot #{item.lotNumber}
            </div>
          )}
          <div className="text-2xl sm:text-3xl font-bold leading-tight">
            {item.name}
          </div>
          {item.variety && (
            <div className="text-base text-red-100 mt-0.5">{item.variety}</div>
          )}
          <div className="text-xs text-red-200 font-mono mt-1">{item.sku}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wide text-red-200">Listing</div>
          <div className="text-3xl sm:text-4xl font-bold tabular-nums">
            ${parseFloat(item.listingPrice || 0).toFixed(0)}
          </div>
        </div>
      </div>
      {item.notes && (
        <div className="mt-3 text-sm text-red-50 bg-red-700/60 rounded-lg px-3 py-2">
          {item.notes}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={onSold}
          className="flex-1 min-w-[160px] flex items-center justify-center gap-1.5 px-4 py-3 text-base font-medium bg-white text-red-700 hover:bg-red-50 active:bg-red-100 rounded-lg"
        >
          <Check className="w-5 h-5" /> Mark Sold
        </button>
        <button
          onClick={onRequeue}
          className="flex items-center justify-center gap-1.5 px-4 py-3 text-sm font-medium bg-red-700/80 text-white hover:bg-red-800 active:bg-red-900 rounded-lg"
        >
          <RotateCcw className="w-4 h-4" /> Re-queue
        </button>
      </div>
    </div>
  );
}

function QueuedRow({ item, flashed, onGoLive }) {
  return (
    <div className={`flex items-center gap-3 px-3 sm:px-4 py-3 transition ${
      flashed ? 'bg-emerald-100' : 'hover:bg-gray-50'
    }`}>
      <div className="w-12 text-center">
        {item.lotNumber ? (
          <span className="inline-block px-2 py-1 text-xs font-mono font-semibold bg-gray-100 text-gray-700 rounded">
            #{item.lotNumber}
          </span>
        ) : (
          <span className="text-xs text-gray-300">—</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-900 truncate">{item.name}</div>
        <div className="text-xs text-gray-500 truncate">
          {item.variety ? `${item.variety} · ` : ''}<span className="font-mono">{item.sku}</span>
        </div>
      </div>
      <div className="text-right">
        <div className="text-lg font-semibold text-gray-900 tabular-nums">
          ${parseFloat(item.listingPrice || 0).toFixed(0)}
        </div>
      </div>
      <button
        onClick={onGoLive}
        className="flex items-center gap-1 px-3 py-2 text-sm font-medium bg-red-600 hover:bg-red-700 active:bg-red-800 text-white rounded-lg flex-shrink-0"
      >
        <Play className="w-3.5 h-3.5" /> Go Live
      </button>
    </div>
  );
}

function DoneRow({ item, onUndo }) {
  return (
    <div className="flex items-center gap-3 px-3 sm:px-4 py-2.5 opacity-70 hover:opacity-100">
      <div className="w-12 text-center">
        {item.lotNumber && (
          <span className="inline-block px-2 py-0.5 text-xs font-mono text-gray-500">
            #{item.lotNumber}
          </span>
        )}
      </div>
      <Check className="w-4 h-4 text-emerald-600 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-700 truncate line-through">{item.name}</div>
        <div className="text-xs text-gray-400 font-mono truncate">{item.sku}</div>
      </div>
      <div className="text-sm text-gray-500 tabular-nums">
        ${parseFloat(item.listingPrice || 0).toFixed(0)}
      </div>
      <button
        onClick={onUndo}
        className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg"
        title="Re-queue"
        aria-label="Undo"
      >
        <ChevronRight className="w-4 h-4 rotate-180" />
      </button>
    </div>
  );
}

function GiveawayRow({ item }) {
  return (
    <div className="flex items-center gap-3 px-3 sm:px-4 py-2.5">
      <Gift className="w-4 h-4 text-amber-600 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">{item.name}</div>
        <div className="text-xs text-gray-500 truncate">
          {item.variety ? `${item.variety} · ` : ''}<span className="font-mono">{item.sku}</span>
        </div>
      </div>
    </div>
  );
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
