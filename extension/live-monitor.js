// Live show monitor — watches the Palmstreet SELLER live dashboard (the
// Chrome page the operator streams from: OBS status + Gross Earning + LIVE
// Chat) and keeps one show-state blob on the Folia API (live-show-save).
// The Mac app's Show monitor reads that blob and displays the whole show:
// every sold lot with its time, final price, buyer, and the bid trail.
//
// Parsing is TEXT-pattern based on purpose, like the phone scraper: the
// dashboard has no stable CSS hooks, and a Palmstreet redesign should break
// regexes visibly (blank fields + the raw sample to recalibrate from), not
// silently misread. The blob always carries a fresh `raw` slice so patterns
// can be recalibrated from a real show without reproducing one.
//
// Single-writer contract: this script owns the entire blob (the server does
// a full replace on save). On a mid-show page reload it re-seeds from
// live-show-get first, so nothing already recorded is lost.
//
// Every pass also emits one `folia:live-tick` DOM event (snapshot + show
// state + the events first seen on this pass) for live-overlay.js, the
// on-page streamer widget. The overlay only reads; it never touches the blob.
//
// Wrapped in an IIFE with a liveness guard: after the extension self-reloads
// (background.js), Chrome re-injects this file into the open dashboard tab.
// A still-live earlier instance wins; an orphaned one (its extension context
// invalidated by the reload) is stopped and replaced.

(() => {
const prevMonitor = window.__foliaLiveMonitor;
if (prevMonitor) {
  if (prevMonitor.alive()) return;
  try { prevMonitor.stop(); } catch { /* already gone */ }
}
const liveAlive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

const LIVE_TICK_MS = 1500;      // parse cadence
const LIVE_SAVE_MS = 4000;      // min gap between saves (sold events save sooner)
const LIVE_RAW_MS = 30000;      // refresh the calibration sample this often

let liveState = null;           // the show blob (see api/settings.js handleLiveShow)
let liveSeenSold = new Set();   // `${lot}|${buyer}|${price}` dedupe keys
let liveSeenJoins = new Set();  // usernames seen joining this show
let liveSeenBids = new Set();   // `${user}|${price}|${minute}` dedupe keys
const LIVE_MAX_EVENTS = 400;    // client-side cap on joins/bidders (server re-caps)
let liveSeeded = false;         // server re-seed attempted
let liveLastSave = 0;
let liveLastRaw = 0;
let liveSaving = false;

const money = (s) => {
  const n = parseFloat(String(s || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Viewer count. Palmstreet's exact rendering is only knowable from a real
// broadcast (the blob's raw sample exists for that), so try the common
// phrasings and let the operator override with a pattern from the options
// page (`liveViewerRegex`, one capture group) without a code change.
const VIEWER_PATTERNS = [
  /(\d[\d,]*)\s*(?:viewers?|watching|people watching|in the room)\b/i,
  /\bViewers?\s*:?\s*\n?\s*(\d[\d,]*)\b/i,
  /(?:👁|👀)\s*(\d[\d,]*)/u,
];
let liveViewerRe = null;   // compiled operator override, refreshed from storage
function setViewerRegex(src) {
  liveViewerRe = null;
  if (!src) return;
  try { liveViewerRe = new RegExp(src, 'im'); } catch { /* bad pattern → built-ins only */ }
}
function parseViewers(txt) {
  for (const re of liveViewerRe ? [liveViewerRe, ...VIEWER_PATTERNS] : VIEWER_PATTERNS) {
    const r = re.exec(txt);
    if (!r || r[1] == null) continue;
    const n = parseInt(String(r[1]).replace(/,/g, ''), 10);
    if (Number.isFinite(n) && n >= 0 && n < 1_000_000) return n;
  }
  return null;
}
try {
  chrome.storage.sync.get({ liveViewerRegex: '' }).then(v => setViewerRegex(v.liveViewerRegex)).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.liveViewerRegex) setViewerRegex(changes.liveViewerRegex.newValue);
  });
} catch { /* not in an extension context */ }

// One pass over the page text → everything we can see right now. Every
// pattern is best-effort: a miss yields null, never a throw.
function parseLivePage() {
  const txt = document.body?.innerText || '';
  if (!/OBS status/i.test(txt) || !/Gross Earning/i.test(txt)) return null;

  const m = (re) => { const r = re.exec(txt); return r || null; };

  const gross = m(/Gross Earning[\s\S]{0,60}?\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  const net = m(/Net Earning[\s\S]{0,60}?\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  const orders = m(/Orders\s*\n?\s*(\d{1,5})\b/i);
  const entries = m(/(\d{1,4})\s*Entries/i);
  const streaming = m(/Streaming:\s*([^\n]+)/i);
  const winner = m(/([A-Za-z0-9_.-]{2,30})\s+won!/i);
  const sold = /\bSOLD\b/.test(txt);
  // The auction overlay: "720 ???" — lot number AND title on ONE line, at
  // line start (a bare viewer count or a "2:00 PM" fragment must not match) —
  // with "$20.00" within the next few SHORT lines; the SOLD/PLANT tile and
  // the countdown can interleave in innerText reading order.
  const lot = m(/^[ \t]*(\d{1,4})[ \t]+(\S[^\n$]{0,59}?)[ \t]*\n(?:[^\n$]{0,20}\n){0,3}[ \t]*\$[ \t]*([\d,]+(?:\.\d{1,2})?)/m);
  const step = m(/\$\s*[\d,]+(?:\.\d{1,2})?\s*\(\+\s*([\d,.]+)\)/);
  // Show title: the line right above the LIVE badge in the left panel.
  const title = m(/^\s*(.{4,90}?)\s*\n+\s*LIVE\b/m);

  // Chat-side events. Joins render as their own line ("subtle_gust_pod51
  // joined"); bid attributions are best-effort — Palmstreet's exact phrasing
  // gets calibrated from the raw sample if this pattern misses.
  const joins = [...txt.matchAll(/^([A-Za-z0-9_.-]{2,30}) joined$/gm)].map(r => r[1]);
  const bidders = [...txt.matchAll(/^([A-Za-z0-9_.-]{2,30})\s+(?:placed a bid|is bidding|bid)\b[^\n]*?\$?\s*([\d,]+(?:\.\d{1,2})?)?\s*$/gm)]
    .map(r => ({ user: r[1], price: r[2] ? money(r[2]) : null }));

  return {
    at: new Date().toISOString(),
    title: title?.[1]?.trim() || null,
    joins,
    bidders,
    viewers: parseViewers(txt),
    streaming: streaming?.[1]?.trim() || null,
    totals: {
      gross: gross ? money(gross[1]) : null,
      net: net ? money(net[1]) : null,
      orders: orders ? parseInt(orders[1], 10) : null,
      entries: entries ? parseInt(entries[1], 10) : null,
    },
    lot: lot ? { num: lot[1], title: lot[2].trim(), price: money(lot[3]) } : null,
    bidStep: step ? money(step[1]) : null,
    winner: winner?.[1] || null,
    soldVisible: sold,
    rawSample: txt.slice(0, 2500),
  };
}

// Stable-enough show identity: the dashboard date + title slug. A new show
// (new title or new day) resets the blob; a reload mid-show re-adopts it.
function showIdFor(snap) {
  const slug = (snap.title || 'live').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
  return `${new Date().toISOString().slice(0, 10)}:${slug}`;
}

function sendBg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError; // swallow "no receiver" — resp stays undefined
        resolve(resp);
      });
    } catch { resolve(undefined); }
  });
}

async function liveSettings() {
  try { return await chrome.storage.sync.get(null); } catch { return {}; }
}

async function saveLiveState(force = false) {
  const now = Date.now();
  if (!liveState || liveSaving) return;
  if (!force && now - liveLastSave < LIVE_SAVE_MS) return;
  liveSaving = true;
  try {
    const settings = await liveSettings();
    if (!settings?.apiBase || !settings?.userId) return; // extension not configured
    await sendBg({ type: 'api:liveShowSave', settings, show: liveState });
    liveLastSave = now;
  } finally {
    liveSaving = false;
  }
}

// Re-adopt the server copy after a page reload so the sold log survives.
async function seedFromServer(showId) {
  liveSeeded = true;
  const settings = await liveSettings();
  if (!settings?.apiBase || !settings?.userId) return null;
  const resp = await sendBg({ type: 'api:liveShowGet', settings });
  const prev = resp?.show;
  if (prev && prev.showId === showId) {
    liveSeenSold = new Set((prev.sold || []).map(s => `${s.lot}|${s.buyer}|${s.price}`));
    liveSeenJoins = new Set((prev.joins || []).map(j => j.user));
    liveSeenBids = new Set((prev.bidders || []).map(b =>
      `${b.user}|${b.price}|${String(b.t || '').slice(0, 16)}`));
    return prev;
  }
  return null;
}

function emitTick(snap, fresh) {
  try {
    document.dispatchEvent(new CustomEvent('folia:live-tick', {
      detail: { snap, show: liveState, fresh },
    }));
  } catch { /* overlay absent — nothing to do */ }
}

async function liveTick() {
  const snap = parseLivePage();
  if (!snap) { emitTick(null, null); return; } // not the live dashboard (or the show ended)
  const fresh = { joins: [], bidders: [], sold: [] };

  const showId = showIdFor(snap);
  if (!liveState || liveState.showId !== showId) {
    const adopted = !liveSeeded ? await seedFromServer(showId) : null;
    liveState = adopted || {
      showId,
      title: snap.title,
      startedAt: snap.at,
      totals: {},
      current: null,
      sold: [],
      joins: [],
      bidders: [],
      viewers: { now: null, peak: null },
      raw: '',
    };
    if (!adopted) {
      liveSeenSold = new Set();
      liveSeenJoins = new Set();
      liveSeenBids = new Set();
    }
  }
  if (!Array.isArray(liveState.joins)) liveState.joins = [];
  if (!Array.isArray(liveState.bidders)) liveState.bidders = [];

  let dirty = false;
  let soldNow = false;

  // Totals: keep the last non-null reading of each counter.
  for (const k of ['gross', 'net', 'orders', 'entries']) {
    const v = snap.totals[k];
    if (v != null && liveState.totals[k] !== v) { liveState.totals[k] = v; dirty = true; }
  }
  if (snap.streaming) liveState.streaming = snap.streaming;

  // Viewers: current reading + the show's peak (a miss keeps the last value).
  if (snap.viewers != null) {
    const v = liveState.viewers && typeof liveState.viewers === 'object' ? liveState.viewers : { now: null, peak: null };
    if (v.now !== snap.viewers) { v.now = snap.viewers; dirty = true; }
    if (v.peak == null || snap.viewers > v.peak) { v.peak = snap.viewers; dirty = true; }
    liveState.viewers = v;
  }

  // Current lot + bid trail: a new lot number opens a fresh record; a price
  // change on the same lot is a bid step.
  if (snap.lot) {
    const cur = liveState.current;
    if (!cur || cur.lot !== snap.lot.num) {
      liveState.current = {
        lot: snap.lot.num,
        title: snap.lot.title,
        price: snap.lot.price,
        startedAt: snap.at,
        bids: snap.lot.price != null ? [{ t: snap.at, price: snap.lot.price }] : [],
      };
      dirty = true;
    } else if (snap.lot.price != null && cur.price !== snap.lot.price) {
      cur.bids.push({ t: snap.at, price: snap.lot.price });
      cur.price = snap.lot.price;
      dirty = true;
    }
  }

  // Sold: the winner toast names the buyer; pair it with the lot on screen.
  // Dedupe on lot+buyer+price — the toast persists across several ticks.
  if (snap.winner && (snap.soldVisible || snap.lot)) {
    const cur = liveState.current;
    const lotNum = snap.lot?.num ?? cur?.lot ?? null;
    const price = snap.lot?.price ?? cur?.price ?? null;
    const key = `${lotNum}|${snap.winner}|${price}`;
    if (lotNum != null && !liveSeenSold.has(key)) {
      liveSeenSold.add(key);
      const rec = {
        at: snap.at,
        lot: lotNum,
        title: snap.lot?.title ?? cur?.title ?? '',
        price,
        buyer: snap.winner,
        startedAt: cur?.startedAt || null,
        bids: cur?.bids?.slice() || [],
      };
      liveState.sold.push(rec);
      fresh.sold.push(rec);
      dirty = true;
      soldNow = true;
    }
  }

  // Room activity: joins (once per username per show) and bid attributions
  // (deduped per user+price+minute — chat lines linger across ticks).
  for (const user of snap.joins || []) {
    if (liveSeenJoins.has(user)) continue;
    liveSeenJoins.add(user);
    liveState.joins.push({ t: snap.at, user });
    fresh.joins.push({ t: snap.at, user });
    if (liveState.joins.length > LIVE_MAX_EVENTS) liveState.joins.splice(0, liveState.joins.length - LIVE_MAX_EVENTS);
    dirty = true;
  }
  for (const b of snap.bidders || []) {
    const key = `${b.user}|${b.price}|${snap.at.slice(0, 16)}`;
    if (liveSeenBids.has(key)) continue;
    liveSeenBids.add(key);
    liveState.bidders.push({ t: snap.at, user: b.user, price: b.price });
    fresh.bidders.push({ t: snap.at, user: b.user, price: b.price });
    if (liveState.bidders.length > LIVE_MAX_EVENTS) liveState.bidders.splice(0, liveState.bidders.length - LIVE_MAX_EVENTS);
    dirty = true;
  }

  // Calibration sample, refreshed occasionally — not worth a save on its own.
  if (Date.now() - liveLastRaw > LIVE_RAW_MS) {
    liveState.raw = snap.rawSample;
    liveLastRaw = Date.now();
  }

  emitTick(snap, fresh);
  if (dirty) await saveLiveState(soldNow);
}

// Self-activating: ticks are near-free off the dashboard (two regex tests on
// page text), so just run everywhere the manifest matches. When this
// instance's extension context dies (self-reload), stop ticking and tell the
// overlay so the re-injected pair can take over cleanly.
let liveTimer = null;
function liveStop() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (window.__foliaLiveMonitor === liveSelf) delete window.__foliaLiveMonitor;
  try { document.dispatchEvent(new CustomEvent('folia:live-dead')); } catch { /* ignore */ }
}
const liveSelf = { alive: liveAlive, stop: liveStop };
window.__foliaLiveMonitor = liveSelf;
liveTimer = setInterval(() => {
  if (!liveAlive()) { liveStop(); return; }
  liveTick().catch(() => { /* keep the loop alive */ });
}, LIVE_TICK_MS);
})();
