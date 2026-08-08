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

const LIVE_TICK_MS = 1500;      // parse cadence
const LIVE_SAVE_MS = 4000;      // min gap between saves (sold events save sooner)
const LIVE_RAW_MS = 30000;      // refresh the calibration sample this often

let liveState = null;           // the show blob (see api/settings.js handleLiveShow)
let liveSeenSold = new Set();   // `${lot}|${buyer}|${price}` dedupe keys
let liveSeeded = false;         // server re-seed attempted
let liveLastSave = 0;
let liveLastRaw = 0;
let liveSaving = false;

const money = (s) => {
  const n = parseFloat(String(s || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

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

  return {
    at: new Date().toISOString(),
    title: title?.[1]?.trim() || null,
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
    return prev;
  }
  return null;
}

async function liveTick() {
  const snap = parseLivePage();
  if (!snap) return; // not the live dashboard (or the show ended)

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
      raw: '',
    };
    if (!adopted) liveSeenSold = new Set();
  }

  let dirty = false;
  let soldNow = false;

  // Totals: keep the last non-null reading of each counter.
  for (const k of ['gross', 'net', 'orders', 'entries']) {
    const v = snap.totals[k];
    if (v != null && liveState.totals[k] !== v) { liveState.totals[k] = v; dirty = true; }
  }
  if (snap.streaming) liveState.streaming = snap.streaming;

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
      liveState.sold.push({
        at: snap.at,
        lot: lotNum,
        title: snap.lot?.title ?? cur?.title ?? '',
        price,
        buyer: snap.winner,
        startedAt: cur?.startedAt || null,
        bids: cur?.bids?.slice() || [],
      });
      dirty = true;
      soldNow = true;
    }
  }

  // Calibration sample, refreshed occasionally — not worth a save on its own.
  if (Date.now() - liveLastRaw > LIVE_RAW_MS) {
    liveState.raw = snap.rawSample;
    liveLastRaw = Date.now();
  }

  if (dirty) await saveLiveState(soldNow);
}

// Self-activating: ticks are near-free off the dashboard (two regex tests on
// page text), so just run everywhere the manifest matches.
setInterval(() => { liveTick().catch(() => { /* keep the loop alive */ }); }, LIVE_TICK_MS);
