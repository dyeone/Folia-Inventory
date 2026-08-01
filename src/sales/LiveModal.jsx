import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Radio, Search, ScanLine, Gift, RotateCcw,
  Smartphone, Layers, Play,
} from 'lucide-react';
import { useLiveBridge } from './liveBridge.js';
import { STORAGE_KEY, loadState, formatElapsed } from './liveState.js';
import {
  Section, ItemList, EmptyHint,
  CurrentItemCard, QueuedRow, DoneRow, GiveawayRow,
  BridgeBadge, BridgeDot, PaneTab, StreamPane, BridgeSettingsDialog,
} from './LiveModalParts.jsx';
import { FollowerTicker } from './FollowerTicker.jsx';

export function LiveModal({ sale, items, onClose, setConfirmDialog, isAdmin, activeBrand, showToast }) {
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

  // Android emulator bridge (redroid + scrcpy worker, lives outside this
  // webapp). The hook handles config, WebSocket lifecycle, and reconnect.
  const bridge = useLiveBridge();
  const [pane, setPane] = useState('lineup'); // 'lineup' | 'stream'
  const [showBridgeSettings, setShowBridgeSettings] = useState(false);

  // Per-item: which items have been pushed to Palmstreet via the bridge.
  // Local-only state — the bridge can also confirm via inbound events.
  const [pushedIds, setPushedIds] = useState(() => new Set());

  const pushItemToPalmstreet = (item) => {
    const ok = bridge.send({
      type: 'push_listing',
      item: {
        sku: item.sku,
        name: item.name,
        variety: item.variety,
        listingPrice: parseFloat(item.listingPrice) || 0,
        imageUrl: item.imageUrl,
        notes: item.notes,
        lotNumber: item.lotNumber,
      },
    });
    if (ok) {
      setPushedIds(prev => new Set(prev).add(item.id));
      setScanMessage({ type: 'ok', text: `Pushed ${item.sku} to Palmstreet` });
    } else {
      setScanMessage({ type: 'error', text: 'Bridge not connected — configure it first' });
    }
  };

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
    setConfirmDialog?.({
      title: 'Reset live progress?',
      message: 'Clears the current/done state for this sale. The lineup itself is unchanged.',
      confirmLabel: 'Reset',
      danger: true,
      onConfirm: () => setLiveState({ itemStatus: {}, startedAt: null }),
    });
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
          <div className="text-xs text-gray-400 flex items-center gap-3 flex-wrap">
            <span>{doneCount}/{total} sold</span>
            {startedAt && <span className="tabular-nums">{elapsedLabel}</span>}
            {giveaways.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <Gift className="w-3 h-3" /> {giveaways.length}
              </span>
            )}
            <FollowerTicker brandId={activeBrand} isAdmin={isAdmin} dark showToast={showToast} />
            <BridgeBadge status={bridge.status} onSettings={() => setShowBridgeSettings(true)} />
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

      {/* ───────── Tabs ───────── */}
      <div className="flex-shrink-0 bg-gray-900 border-b border-gray-800 px-4 sm:px-6 flex gap-1">
        <PaneTab id="lineup"  active={pane === 'lineup'}  onClick={() => setPane('lineup')}  icon={Layers}>
          Lineup
        </PaneTab>
        <PaneTab id="stream"  active={pane === 'stream'}  onClick={() => setPane('stream')}  icon={Smartphone}>
          Palmstreet Bridge
          <BridgeDot status={bridge.status} />
        </PaneTab>
      </div>

      {/* ───────── Body ───────── */}
      {pane === 'stream' && (
        <StreamPane
          bridge={bridge}
          onOpenSettings={() => setShowBridgeSettings(true)}
        />
      )}
      {pane === 'lineup' && (
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
                bridgeReady={bridge.status === 'connected'}
                pushed={pushedIds.has(currentItem.id)}
                onPush={() => pushItemToPalmstreet(currentItem)}
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
                    bridgeReady={bridge.status === 'connected'}
                    pushed={pushedIds.has(item.id)}
                    onPush={() => pushItemToPalmstreet(item)}
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
      )}

      {showBridgeSettings && (
        <BridgeSettingsDialog
          config={bridge.config}
          status={bridge.status}
          onSave={(patch) => { bridge.updateConfig(patch); setShowBridgeSettings(false); }}
          onClose={() => setShowBridgeSettings(false)}
        />
      )}
    </div>
  );
}

