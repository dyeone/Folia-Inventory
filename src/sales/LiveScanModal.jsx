import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Radio, ScanLine, AlertTriangle, Check, Loader2, WifiOff, Wifi, RotateCw,
} from 'lucide-react';
import { api } from '../api.js';
import { FollowerTicker } from './FollowerTicker.jsx';
import { buildLookups, computeIdealPrice } from '../inventory/pricing.js';
import { normalizeSku } from '../labels/boxCode.js';

const SOLD_STATUSES = new Set(['sold', 'shipped', 'delivered']);
const POLL_MS = 1500;

// The three Palmstreet listing modes. `key` is what the bridge dispatches
// on (matches MODE_CONFIG in bridge/index.js); `hint` tells the operator
// which dollar figure fills the amount field on the phone.
const MODES = [
  { key: 'auction',   label: 'Auction',  hint: 'Starts at 2.5× cost (never above the list price)' },
  { key: 'buy_now',   label: 'Buy Now',  hint: 'Price = list price, else 2.5× cost' },
  { key: 'give_away', label: 'Giveaway', hint: 'Value = list price, else 2.5× cost' },
];

// Live-scan pricing. The species LIST price (species.idealSellingPrice, set
// on the wholesale order line or in the catalog) is the recommended selling
// price: buy-now and giveaway list AT it, and it's shown big on every scan
// as the target. Auctions still start at cost × this multiplier — the
// floor the room bids up from — capped at the list price so a cheap plant
// never opens above its own target. No list price → the old cost-based
// chain, so scan = list it at margin with no per-item pricing pass.
const PRICE_COST_MULTIPLIER = 2.5;

// Flat fallback for items with no cost, listing price, or cultivar/global
// rate — they list at this instead of erroring out of the scan flow.
const DEFAULT_PRICE = 5;
const MODE_LABEL = Object.fromEntries(MODES.map(m => [m.key, m.label]));

// Text size for the whole scan screen (A−/A+ in the header). The streamer
// reads this from a few feet away and used to browser-zoom every live;
// CSS `zoom` on the panel's content scales everything in one step and the
// choice sticks per browser.
const TEXT_SCALES = [1, 1.25, 1.5, 1.75, 2];
const TEXT_SCALE_KEY = 'liveScan.textScale';
function loadTextScale() {
  try {
    const v = parseFloat(localStorage.getItem(TEXT_SCALE_KEY));
    return TEXT_SCALES.includes(v) ? v : 1.25;
  } catch { return 1.25; }
}

// Mirror the bridge's per-mode amount so each row shows the figure that
// actually gets typed. All three modes now carry the resolved 2.5×-cost
// price — the auction floor included (see the payload note in pushItem).
function displayAmount(mode, item, price) {
  return Number.isFinite(price) && price > 0 ? price : null;
}

// The bridge types the title on the phone with adb `input text`, which only
// handles printable ASCII — "monstera Creme Brûlée" and curly quotes made it
// throw and the quick-listing title stayed EMPTY. Transliterate accents
// (é → e via NFKD + strip combining marks) and typographic punctuation, drop
// whatever's left, and fall back to the SKU so the field is never blank.
// Sanitizing here (not in the bridge) means no Mac-app republish.
function asciiTitle(name, sku) {
  const out = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/×/g, 'x')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out || String(sku || 'Plant');
}

// Live Scan Mode — keep the input autofocused; every barcode scan
// resolves the SKU locally and enqueues a Palmstreet listing job.
// No per-scan confirmation: scan = list it.
export function LiveScanModal({ items, varieties, species, idealRate, onClose, isAdmin, activeBrand, showToast }) {
  const lookups = useMemo(() => buildLookups(varieties, species), [varieties, species]);
  const itemsBySku = useMemo(() => {
    const m = new Map();
    for (const i of items) if (i.sku) m.set(normalizeSku(i.sku), i);
    return m;
  }, [items]);
  // Species list price + sell note, looked up live by speciesId so an edit on
  // the order line shows on the very next scan (nothing is stamped).
  const speciesById = useMemo(() => new Map((species || []).map(sp => [sp.id, sp])), [species]);
  const speciesFor = (item) => (item?.speciesId ? speciesById.get(item.speciesId) : null) || null;
  const listPriceFor = (item) => {
    const v = parseFloat(speciesFor(item)?.idealSellingPrice);
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  // `entries` is what the operator sees; latest first. Each entry tracks
  // its own bridge job id (if it got that far) and a status for the badge.
  const [entries, setEntries] = useState([]);
  const [scanInput, setScanInput] = useState('');
  const [mode, setMode] = useState('auction'); // session-wide listing mode
  const [error, setError] = useState('');
  const [forcePush, setForcePush] = useState(null); // { sku, item } when sold-block triggers
  const [bridgeStatus, setBridgeStatus] = useState({ online: false, queued: 0 });
  const [textScale, setTextScale] = useState(loadTextScale);
  const stepText = (dir) => {
    const i = TEXT_SCALES.indexOf(textScale);
    const next = TEXT_SCALES[Math.max(0, Math.min(TEXT_SCALES.length - 1, (i < 0 ? 1 : i) + dir))];
    setTextScale(next);
    try { localStorage.setItem(TEXT_SCALE_KEY, String(next)); } catch { /* private mode */ }
  };
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

  // See the pricing note above MODES. Returns the figure typed on the phone
  // for this mode. Items with no list price and no recorded cost fall back
  // to the old chain (explicit listing price, then the cultivar/global
  // rate), and anything still unpriced lists at a flat $5 — a scan must
  // never bounce for lack of a price.
  const resolvePrice = (item, m) => {
    const list = listPriceFor(item);
    const cost = Number(item.grossCost);
    const costPrice = Number.isFinite(cost) && cost > 0 ? Math.ceil(cost * PRICE_COST_MULTIPLIER) : null;
    if (list != null && m !== 'auction') return list;
    if (costPrice != null) return list != null ? Math.min(costPrice, list) : costPrice;
    if (list != null) return list;
    const listing = parseFloat(item.listingPrice);
    if (Number.isFinite(listing) && listing > 0) return listing;
    const ideal = computeIdealPrice(item, idealRate, lookups);
    if (Number.isFinite(ideal) && ideal > 0) return Math.round(ideal * 100) / 100;
    return DEFAULT_PRICE;
  };

  const pushItem = async (item, { forced = false, mode: chosenMode } = {}) => {
    // Capture the mode at scan time so a retry re-lists in the same mode
    // even if the operator has since flipped the toggle.
    const m = chosenMode || mode;
    const price = resolvePrice(item, m);
    const amount = displayAmount(m, item, price);
    const sp = speciesFor(item);
    const listPrice = listPriceFor(item);
    const sellNote = (sp?.sellNote || '').trim() || null;
    const tempId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setEntries(prev => [
      { tempId, sku: item.sku, name: item.name, variety: item.variety, price, amount, mode: m, state: 'queued', jobId: null, scannedAt: new Date().toISOString(), forced, listPrice, sellNote },
      ...prev,
    ].slice(0, 50));
    try {
      const job = await api.bridgeEnqueue({
        jobAction: 'listing',
        payload: {
          sku: item.sku,
          name: asciiTitle(item.name, item.sku),
          price,             // bridge uses this for buy_now / give_away
          // The bridge types ceil(grossCost) as the auction starting price.
          // Auctions now start at 2.5× cost like the other modes, so feed the
          // resolved price through this field — the deployed bridge keeps its
          // contract and types the new figure without a Mac-app republish.
          grossCost: price,
          mode: m,           // 'auction' | 'buy_now' | 'give_away'
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
    const sku = normalizeSku(rawSku);
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
  //
  // handleScan closes over items/idealRate which change between renders;
  // route through a ref so the timeout always calls the freshest version
  // without re-firing the effect on every keystroke render.
  const handleScanRef = useRef(handleScan);
  handleScanRef.current = handleScan;
  useEffect(() => {
    if (!scanInput || forcePush) return;
    if (!/^[A-Za-z]{2,4}-\d+$/.test(scanInput.trim())) return;
    const id = setTimeout(() => {
      handleScanRef.current(scanInput);
      setScanInput('');
    }, 200);
    return () => clearTimeout(id);
  }, [scanInput, forcePush]);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-stretch sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full max-w-3xl h-full sm:h-[92vh] sm:rounded-2xl flex flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col" style={{ zoom: textScale }}>

        <div className="border-b border-gray-200 px-5 py-4 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
              <Radio className="w-5 h-5 text-red-600" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-gray-900 text-lg flex items-center gap-2 flex-wrap">
                <span className="whitespace-nowrap">Live Scan Mode</span>
                <BridgeBadge status={bridgeStatus} />
                <FollowerTicker brandId={activeBrand} isAdmin={isAdmin} showToast={showToast} />
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Each barcode scan auto-pushes that SKU to Palmstreet as a listing.
                {' '}
                <button
                  onClick={() => window.open(`/#follower-board=${activeBrand || ''}`, '_blank', 'noopener')}
                  className="text-sky-600 hover:underline"
                  title="Open the audience follower board — a giant counter to put in the camera frame"
                >
                  Audience view ↗
                </button>
                {' · '}
                <button
                  onClick={() => window.open(`/#show-board=${activeBrand || ''}`, '_blank', 'noopener')}
                  className="text-sky-600 hover:underline"
                  title="Open the show board — price trend, room activity, and VIP buyers for your second monitor"
                >
                  Show board ↗
                </button>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <div className="flex items-center rounded-lg border border-gray-200 bg-gray-50 mr-1" role="group" aria-label="Text size">
              <button type="button" onClick={() => stepText(-1)} disabled={textScale === TEXT_SCALES[0]}
                className="px-2 py-1.5 text-sm font-bold text-gray-700 hover:bg-gray-200 disabled:opacity-30 rounded-l-lg" title="Smaller text">A−</button>
              <span className="px-1 text-[11px] tabular-nums text-gray-500 select-none" title="Text size">{Math.round(textScale * 100)}%</span>
              <button type="button" onClick={() => stepText(1)} disabled={textScale === TEXT_SCALES[TEXT_SCALES.length - 1]}
                className="px-2 py-1.5 text-sm font-bold text-gray-700 hover:bg-gray-200 disabled:opacity-30 rounded-r-lg" title="Bigger text">A+</button>
            </div>
            <button onClick={onClose} className="p-2 -mr-1 text-gray-500 hover:bg-gray-100 active:bg-gray-200 rounded-lg" aria-label="Exit live mode">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="px-5 pt-4 flex-shrink-0">
          <div className="mb-3">
            <div className="flex rounded-xl border border-gray-200 bg-gray-100 p-1" role="group" aria-label="Listing mode">
              {MODES.map(m => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMode(m.key)}
                  aria-pressed={mode === m.key}
                  className={`flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                    mode === m.key
                      ? 'bg-white text-emerald-700 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-1 px-1">
              {MODES.find(m => m.key === mode)?.hint} · every scan lists as <span className="font-medium text-gray-500">{MODE_LABEL[mode]}</span>
            </p>
          </div>
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
          {entries[0] && <NowScanningCard entry={entries[0]} />}
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
                    const item = itemsBySku.get(normalizeSku(e.sku));
                    if (item) pushItem(item, { forced: e.forced, mode: e.mode });
                  }}
                />
              ))}
            </div>
          )}
        </div>

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
      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 whitespace-nowrap">
        <Wifi className="w-3 h-3" /> Bridge live
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 whitespace-nowrap">
      <WifiOff className="w-3 h-3" /> Offline
    </span>
  );
}

// The last scan, big: what the streamer is holding up right now. List price
// as the recommended price and the species sell note as the talking points.
function NowScanningCard({ entry }) {
  const { name, variety, sku, amount, price, mode, listPrice, sellNote } = entry;
  const shown = amount != null ? amount : price;
  return (
    <div className="mb-4 rounded-xl bg-emerald-700 text-white p-4 sm:p-5 shadow">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-emerald-200 mb-1">Just scanned</div>
          <div className="text-2xl sm:text-3xl font-bold leading-tight break-words">{name}</div>
          <div className="text-sm text-emerald-100 mt-0.5">
            {variety ? `${variety} · ` : ''}<span className="font-mono">{sku}</span>
            {mode && <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-800/70 text-[10px] font-semibold uppercase tracking-wide">{MODE_LABEL[mode] || mode}</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wide text-emerald-200">Recommended</div>
          <div className="text-3xl sm:text-4xl font-bold tabular-nums">
            {listPrice != null ? `$${Number(listPrice).toFixed(0)}` : '—'}
          </div>
          <div className="text-xs text-emerald-200 mt-0.5">
            {listPrice == null ? 'no list price on this species' : shown != null && Number(shown) !== Number(listPrice) ? `typed: $${Number(shown).toFixed(2)}` : 'listed at this price'}
          </div>
        </div>
      </div>
      {sellNote ? (
        <div className="mt-3 rounded-lg bg-amber-300 text-gray-900 border-l-8 border-amber-500 px-4 py-3 shadow-inner">
          <div className="text-[11px] font-bold uppercase tracking-wider text-amber-900/80 mb-0.5">Say this</div>
          <div className="text-xl sm:text-2xl font-semibold leading-snug whitespace-pre-wrap">{sellNote}</div>
        </div>
      ) : (
        <div className="mt-3 text-xs text-emerald-200">No sell note — add one on the wholesale order line or in the catalog.</div>
      )}
    </div>
  );
}

function EntryRow({ entry, onRetry }) {
  const { sku, name, variety, price, amount, mode, state, errorMsg, forced, listPrice, sellNote } = entry;
  // Show the figure actually typed on the phone (auction = cost floor),
  // falling back to the resolved price for older entries without `amount`.
  const shown = amount != null ? amount : price;
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
            {mode && (
              <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-medium uppercase tracking-wide">
                {MODE_LABEL[mode] || mode}
              </span>
            )}
            {listPrice != null && (
              <span className="text-emerald-700 font-semibold" title="Species list price (recommended)">list ${Number(listPrice).toFixed(0)}</span>
            )}
          </div>
          {sellNote && (
            <div className="text-xs text-gray-600 truncate mt-0.5" title={sellNote}>{sellNote}</div>
          )}
        </div>
        <div className="text-sm font-semibold text-gray-900 tabular-nums">
          {shown != null ? `$${Number(shown).toFixed(2)}` : '—'}
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
