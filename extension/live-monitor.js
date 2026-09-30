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
// Show identity: a show gets its id ONCE, when it is first seen (local date
// + local start time + title slug), and keeps it for as long as the
// dashboard keeps reporting. The id is never recomputed from the clock or
// from page labels: the old `UTC date + title` id flipped at 00:00 UTC
// (5 PM Pacific) and whenever the scraped label changed, which blanked the
// show mid-live. A NEW show starts only when Palmstreet's own counters
// restart (orders / gross fall back) or the dashboard was unseen for hours.
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
let liveSeeded = false;         // server re-seed settled (adopted, or nothing to adopt)
let liveSeeding = false;        // a re-seed is in flight — ticks wait for it
let liveSeedTries = 0;          // failed re-seed attempts (no answer from the API)
let liveRestartTicks = 0;       // consecutive passes on which the counters looked restarted
const LIVE_SEED_MAX_TRIES = 6;                    // then start blank rather than never start
const LIVE_ADOPT_FRESH_MS = 30 * 60 * 1000;       // a server copy this fresh is this live
const LIVE_NEW_SHOW_SILENCE_MS = 3 * 3600 * 1000; // dashboard unseen this long → a new show
const LIVE_RESTART_TICKS = 3;                     // a restart must hold this many passes
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

// Button labels that sit where a title could be.
const LIVE_BUTTON_LABEL = /^(?:(?:share|end|pause|resume|start|stop|go)\b.*\b(?:live|stream(?:ing)?)|view setup guide|live chat)$/i;

// Palmstreet's own on-air timer ("LIVE · 1h 04m 43s") as milliseconds;
// null when the page shows none (not streaming yet, or a different layout).
function parseElapsed(txt) {
  const r = /^[ \t]*LIVE[ \t]*[^\w\s][ \t]*((?:\d{1,3}[ \t]*h)?[ \t]*(?:\d{1,2}[ \t]*m)?[ \t]*(?:\d{1,2}[ \t]*s)?)[ \t]*$/m.exec(txt);
  if (!r || !r[1].trim()) return null;
  const part = (u) => { const x = new RegExp(`(\\d+)[ \\t]*${u}`).exec(r[1]); return x ? Number(x[1]) : 0; };
  return ((part('h') * 60 + part('m')) * 60 + part('s')) * 1000;
}

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
  // Show title: the line right after "OBS status: …" (seen on a real
  // broadcast); the line above the LIVE badge is the fallback. Both spots
  // can hold a BUTTON ("Share LIVE", "End LIVE", "Start streaming", "View
  // setup guide") — never a title.
  const titleOf = (r) => { const v = r?.[1]?.trim(); return v && !LIVE_BUTTON_LABEL.test(v) ? v : null; };
  const title = titleOf(m(/OBS status[^\n]*\n+[ \t]*([^\n]{2,120})/i))
    || titleOf(m(/^\s*(.{4,90}?)\s*\n+\s*LIVE\b/m));

  // Chat-side events. Joins render as their own line ("subtle_gust_pod51
  // joined"); bid attributions are best-effort — Palmstreet's exact phrasing
  // gets calibrated from the raw sample if this pattern misses.
  const joins = [...txt.matchAll(/^([A-Za-z0-9_.-]{2,30}) joined$/gm)].map(r => r[1]);
  const bidders = [...txt.matchAll(/^([A-Za-z0-9_.-]{2,30})\s+(?:placed a bid|is bidding|bid)\b[^\n]*?\$?\s*([\d,]+(?:\.\d{1,2})?)?\s*$/gm)]
    .map(r => ({ user: r[1], price: r[2] ? money(r[2]) : null }));

  return {
    at: new Date().toISOString(),
    title,
    elapsedMs: parseElapsed(txt),
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

// Show id, minted once per show: LOCAL date + LOCAL start time + title slug
// (the server reads the first 10 characters as the show's day). Never
// derived again after that — see the header.
const pad2 = (n) => String(n).padStart(2, '0');
function mintShowId(snap, startMs) {
  const d = new Date(startMs);
  const slug = (snap.title || 'live').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'live';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}:${pad2(d.getHours())}${pad2(d.getMinutes())}-${slug}`;
}
const msOf = (iso) => { const t = iso ? new Date(iso).getTime() : NaN; return Number.isFinite(t) ? t : 0; };

// Did Palmstreet's per-show counters start over? Compares what the show
// last recorded with what the page says now. Every counter that CAN be
// compared must have fallen to half or less — a cancelled order moves gross
// by a few dollars, a new live moves everything back to zero. `freshStream`
// (the on-air timer restarted after we last saw this show on air) lowers
// the bar so a tiny first show still counts.
function countersRestarted(prev, cur, freshStream) {
  const checks = [];
  for (const [k, min] of [['orders', freshStream ? 1 : 4], ['gross', freshStream ? 1 : 100]]) {
    const p = Number(prev?.[k]);
    const c = cur?.[k];
    if (!Number.isFinite(p) || p < min || c == null) continue;
    checks.push(c <= p / 2);
  }
  return checks.length > 0 && checks.every(Boolean);
}
const streamStartOf = (snap, now) => (snap.elapsedMs != null ? now - snap.elapsedMs : null);

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

// Is the server's copy the live that is on screen now? Yes when the stream
// on screen was already running at the copy's last save (or the copy was
// saved shortly before it went on air: the setup minutes), or — with no
// timer on the page — when the copy is fresh. Never when the counters
// restarted since. The copy's id is NOT compared: ids from the old scheme
// changed mid-live, and the id is ours to keep, not to re-derive.
function sameLive(prev, savedAtMs, snap, now) {
  if (!prev?.showId || !savedAtMs) return false;
  const streamStart = streamStartOf(snap, now);
  if (countersRestarted(prev.totals, snap.totals, streamStart != null && streamStart > savedAtMs)) return false;
  if (streamStart != null) return streamStart <= savedAtMs || savedAtMs > streamStart - LIVE_ADOPT_FRESH_MS;
  return now - savedAtMs < LIVE_ADOPT_FRESH_MS;
}

// Re-adopt the server copy after a page or extension reload so the show
// survives. Returns { show } (null = nothing to adopt, start blank) or
// { retry: true } when the API didn't answer — starting blank then would
// overwrite the server copy with an empty show.
async function seedFromServer(snap, now) {
  const settings = await liveSettings();
  if (!settings?.apiBase || !settings?.userId) return { show: null };   // not configured: nothing is saved either
  const resp = await sendBg({ type: 'api:liveShowGet', settings });
  if (!resp?.ok) return { retry: true };
  const prev = resp.show;
  if (!sameLive(prev, msOf(resp.updatedAt), snap, now)) return { show: null };
  liveSeenSold = new Set((prev.sold || []).map(s => `${s.lot}|${s.buyer}|${s.price}`));
  liveSeenJoins = new Set((prev.joins || []).map(j => j.user));
  liveSeenBids = new Set((prev.bidders || []).map(b =>
    `${b.user}|${b.price}|${String(b.t || '').slice(0, 16)}`));
  return { show: prev };
}

function blankShow(snap, now) {
  const streamStart = streamStartOf(snap, now);
  const startMs = streamStart ?? now;
  return {
    showId: mintShowId(snap, startMs),
    title: snap.title,
    startedAt: new Date(startMs).toISOString(),
    liveStartedAt: streamStart != null ? new Date(streamStart).toISOString() : null,
    totals: {},
    current: null,
    sold: [],
    joins: [],
    bidders: [],
    viewers: { now: null, peak: null },
    raw: '',
  };
}

// Has the show on screen stopped being the one in memory? (See the header.)
function isNewShow(state, snap, now) {
  if (state.lastSeenAt && now - msOf(state.lastSeenAt) > LIVE_NEW_SHOW_SILENCE_MS) return true;
  const streamStart = streamStartOf(snap, now);
  const freshStream = streamStart != null && !!state.lastOnAirAt && streamStart > msOf(state.lastOnAirAt) + 60_000;
  if (countersRestarted(state.totals, snap.totals, freshStream)) liveRestartTicks += 1;
  else liveRestartTicks = 0;
  return liveRestartTicks >= LIVE_RESTART_TICKS;
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

  const now = Date.now();
  if (liveSeeding) return;   // a re-seed is in flight; this pass would start blank
  if (!liveState) {
    let adopted = null;
    if (!liveSeeded) {
      liveSeeding = true;
      let seed;
      try { seed = await seedFromServer(snap, now); }
      catch { seed = { retry: true }; }
      finally { liveSeeding = false; }
      if (seed.retry && ++liveSeedTries < LIVE_SEED_MAX_TRIES) return;   // ask again next pass
      liveSeeded = true;
      adopted = seed.show || null;
    }
    liveState = adopted || blankShow(snap, now);
    liveRestartTicks = 0;
    if (!adopted) {
      liveSeenSold = new Set();
      liveSeenJoins = new Set();
      liveSeenBids = new Set();
    }
  } else if (isNewShow(liveState, snap, now)) {
    liveState = blankShow(snap, now);
    liveRestartTicks = 0;
    liveSeenSold = new Set();
    liveSeenJoins = new Set();
    liveSeenBids = new Set();
  }
  if (!Array.isArray(liveState.sold)) liveState.sold = [];
  if (!Array.isArray(liveState.joins)) liveState.joins = [];
  if (!Array.isArray(liveState.bidders)) liveState.bidders = [];
  if (!liveState.totals || typeof liveState.totals !== 'object') liveState.totals = {};

  let dirty = false;
  let soldNow = false;

  // Housekeeping for the identity rules; rides along with the next save.
  liveState.lastSeenAt = snap.at;
  const streamStart = streamStartOf(snap, now);
  if (streamStart != null) {
    liveState.lastOnAirAt = snap.at;
    // The on-air start, once: Palmstreet's timer beats "when the dashboard
    // was opened" (setup can be half an hour earlier) for time on air and
    // pace. Kept as first read — a pause must not move it.
    if (!liveState.liveStartedAt) {
      liveState.liveStartedAt = new Date(streamStart).toISOString();
      const firstSold = liveState.sold.length ? msOf(liveState.sold[0].at) : 0;
      liveState.startedAt = new Date(firstSold && firstSold < streamStart ? firstSold : streamStart).toISOString();
      dirty = true;
    }
  }
  // A real title can show up after the show was first seen (setup screen).
  if (snap.title && liveState.title !== snap.title) { liveState.title = snap.title; dirty = true; }

  // Totals: keep the last non-null reading of each counter. While a restart
  // is suspected the recorded totals are held, so the next passes still
  // compare against the show's real numbers (see isNewShow).
  if (liveRestartTicks === 0) {
    for (const k of ['gross', 'net', 'orders', 'entries']) {
      const v = snap.totals[k];
      if (v != null && liveState.totals[k] !== v) { liveState.totals[k] = v; dirty = true; }
    }
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
