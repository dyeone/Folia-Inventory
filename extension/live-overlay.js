// Live overlay — the streamer-facing widget ON the Palmstreet seller
// dashboard tab (the one OBS streams from). live-monitor.js does the
// scraping and emits one `folia:live-tick` DOM event per pass; this script
// only renders and alerts. It never writes the show blob.
//
// Shows: a big wall clock with time on air, viewers (now / peak), gross,
// orders, sales pace, time since the last sale, the lot on the block with
// its high bidder, two bar charts over elapsed show time (sales $ and lots
// sold per 10 minutes), the VIPs seen in the room this show, and a short
// activity feed — every username badged
// against lifetime shipping history (live-show-buyers: 👑 VIP / ⭐ repeat,
// lifetime $, boxes, and any box still waiting to ship).
//
// It also polls the last scan from the web app's Live Scan Mode
// (live-show-scan-get, every 2 s while on the dashboard) and shows it at
// the top: the plant, the species LIST price as the recommendation, and the
// sell note as a "Say this" callout — the streamer's eyes are on this tab,
// not on the scanning window.
//
// Alerts (toast + chime + optional desktop notification) fire once per show
// per buyer for a VIP (or repeat, if enabled) join and first bid, and on
// every VIP win. The first pass of a show seeds the feed from the show
// state and never alerts: on a mid-show install the chat backlog would
// otherwise fire everything at once. History loads once per show and
// refreshes every 10 minutes.
//
// Lives in a shadow root so Palmstreet's CSS can't restyle it and ours
// can't leak out. Drag the header to move it, drag the bottom-right corner
// to resize it — text scales with the width so a bigger panel reads from
// across the room — and A−/A+ in the header bump the text on top of that.
// Position / size / text scale / collapsed / muted persist in storage.local.

(() => {
  // Re-injection guard (see live-monitor.js): a live earlier instance wins,
  // an orphaned one is torn down and replaced.
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const prevOverlay = window.__foliaLiveOverlay;
  if (prevOverlay) {
    if (prevOverlay.alive()) return;
    try { prevOverlay.teardown(); } catch { /* already gone */ }
  }
  const overlaySelf = { alive, teardown };
  window.__foliaLiveOverlay = overlaySelf;

  const PREFS_KEY = 'liveOverlayPrefs';
  const BUYERS_REFRESH_MS = 10 * 60 * 1000;
  const BUYERS_RETRY_MS = 60 * 1000;
  const TOAST_MS = 12_000;
  const FEED_MAX = 14;
  const VIP_LIST_MAX = 8;
  const HIDE_AFTER_MS = 8_000;       // no dashboard tick for this long → hide
  const PANEL_W = 340;               // default width; the operator can resize
  const PANEL_MIN_W = 240, PANEL_MIN_H = 160;
  const FONT_MIN = 11, FONT_MAX = 26;   // base font follows width (~1px per 26px) × the A−/A+ scale
  const SCALE_STEPS = [0.85, 1, 1.15, 1.3, 1.45, 1.6];
  const SCAN_POLL_MS = 2000;
  const SCAN_STALE_MS = 45 * 60 * 1000;   // an old scan is history, not "just scanned"

  let host = null, root = null;
  const el = {};
  let prefs = { x: null, y: null, w: null, h: null, scale: 1, collapsed: false, muted: false };
  let settings = null;               // chrome.storage.sync snapshot
  let buyers = null;                 // lowercase username → { tier, spent, items, boxes, openBoxes, lastAt }
  let buyersAt = 0, buyersErr = null, buyersLoading = false;
  let showId = null;
  let alerted = new Set();           // `${user}|${kind}` this show
  let feed = [];                     // newest first: { t, kind, user, price, lot, title }
  let lastTickAt = 0;
  let last = null;                   // last tick detail
  let rafId = 0;
  let audioCtx = null;
  let clockTimer = null;
  let scan = null;                   // last scan from the scan screen
  let scanTimer = null;
  let scanPolling = false;
  let wallClock = null;              // 1 s clock tick

  const lc = (s) => String(s || '').trim().toLowerCase();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const fmtMoney = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : '$' + Math.round(Number(v)).toLocaleString());
  const fmtInt = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString());
  const fmtAgo = (t) => {
    if (!t) return '—';
    const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  };
  const fmtClock = (t) => {
    try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
  };

  function sendBg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => { void chrome.runtime.lastError; resolve(resp); });
      } catch { resolve(undefined); }
    });
  }

  // ── history (buyer tiers) ────────────────────────────────────────────
  const statsFor = (user) => (buyers && user ? buyers[lc(user)] || null : null);
  const alertable = (tier) => tier === 'vip' || (tier === 'repeat' && settings?.liveAlertRepeat !== false);

  async function ensureBuyers(force) {
    if (buyersLoading) return;
    const age = Date.now() - buyersAt;
    if (!force && buyers && age < BUYERS_REFRESH_MS) return;
    if (!force && !buyers && buyersErr && age < BUYERS_RETRY_MS) return;
    if (!settings?.apiBase || !settings?.userId) {
      buyersErr = 'extension not configured (options page)'; buyersAt = Date.now(); renderFoot(); return;
    }
    buyersLoading = true;
    try {
      const resp = await sendBg({ type: 'api:liveShowBuyers', settings });
      if (resp?.ok) { buyers = resp.buyers || {}; buyersErr = null; }
      else buyersErr = resp?.error || 'history unavailable';
    } catch (e) {
      buyersErr = e?.message || 'history unavailable';
    } finally {
      buyersAt = Date.now();
      buyersLoading = false;
      renderFoot();
      if (last) scheduleRender();
    }
  }

  // ── DOM ──────────────────────────────────────────────────────────────
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { position: fixed; z-index: 2147483647; }
    .panel {
      --fs: 12px;
      position: relative; width: ${PANEL_W}px; min-width: ${PANEL_MIN_W}px; min-height: ${PANEL_MIN_H}px;
      max-width: 92vw; max-height: 92vh;
      display: flex; flex-direction: column;
      resize: both; overflow: hidden;
      font: var(--fs)/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #f3f4f6; background: rgba(9, 12, 20, 0.97); border: 1px solid #1f2937;
      border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.45); user-select: none;
      backdrop-filter: blur(8px);
    }
    .panel.collapsed { resize: none; min-height: 0; height: auto !important; }
    .panel::after {
      /* visible grip over the native resize corner */
      content: ""; position: absolute; right: 3px; bottom: 3px; width: 10px; height: 10px; pointer-events: none;
      background: linear-gradient(135deg, transparent 50%, #4b5563 50%, #4b5563 60%, transparent 60%, transparent 75%, #4b5563 75%, #4b5563 85%, transparent 85%);
      border-bottom-right-radius: 8px; opacity: .8;
    }
    .panel.collapsed::after { display: none; }
    .head { display: flex; align-items: center; gap: .65em; padding: .65em .85em; cursor: grab; border-bottom: 1px solid #1f2937; flex-shrink: 0; }
    .head:active { cursor: grabbing; }
    .dot { width: .65em; height: .65em; border-radius: 50%; background: #ef4444; box-shadow: 0 0 0 0 rgba(239,68,68,.6); animation: pulse 1.6s infinite; flex-shrink: 0; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(239,68,68,.6); } 70% { box-shadow: 0 0 0 .55em rgba(239,68,68,0); } 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); } }
    .title { font-weight: 700; letter-spacing: .02em; color: #d1d5db; font-size: .9em; text-transform: uppercase; white-space: nowrap; }
    .viewers { margin-left: auto; display: flex; align-items: baseline; gap: .3em; }
    .viewers b { font-size: 1.5em; font-variant-numeric: tabular-nums; }
    .viewers small { color: #9ca3af; font-size: .8em; white-space: nowrap; }
    .head button { all: unset; cursor: pointer; color: #d1d5db; padding: .15em .4em; border-radius: 6px; font-size: 1.05em; line-height: 1; }
    .head button:hover { background: #1f2937; color: #fff; }
    .head button.tsz { font-size: .8em; font-weight: 700; letter-spacing: -.02em; }
    .body { padding: .65em .85em .5em; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
    .body::-webkit-scrollbar { width: 6px; } .body::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
    .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: .5em; flex-shrink: 0; }
    .tile { background: #111827; border-radius: 8px; padding: .5em .6em; min-width: 0; }
    .tile small { display: block; color: #a3a9b5; font-size: .8em; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tile b { display: block; font-size: 1.2em; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tile i { display: block; font-style: normal; color: #9ca3af; font-size: .78em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lot { margin-top: .65em; background: #111827; border-radius: 8px; padding: .55em .75em; display: flex; flex-wrap: wrap; align-items: baseline; gap: .65em; min-height: 2.8em; flex-shrink: 0; }
    .lot .num { font-size: 1.35em; font-weight: 800; font-variant-numeric: tabular-nums; }
    .lot .name { color: #e5e7eb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .lot .price { margin-left: auto; font-size: 1.35em; font-weight: 800; color: #60a5fa; font-variant-numeric: tabular-nums; }
    .lot .sub { flex-basis: 100%; color: #c3c8d2; font-size: .92em; margin-top: -.15em; display: flex; gap: .5em; align-items: center; flex-wrap: wrap; }
    .section { margin-top: .65em; display: flex; flex-direction: column; min-height: 0; flex-shrink: 0; }
    .section.grow { flex: 1; }
    .section > small { display: flex; justify-content: space-between; color: #a3a9b5; font-weight: 600; font-size: .8em; text-transform: uppercase; letter-spacing: .05em; margin-bottom: .25em; flex-shrink: 0; }
    .list { display: flex; flex-direction: column; gap: .15em; overflow-y: auto; min-height: 0; }
    .section.vips .list { max-height: 9.5em; }
    .ret { display: flex; align-items: center; gap: .5em; font-size: .85em; color: #c3c8d2; margin: .1em 0 .4em; white-space: nowrap; }
    .ret b { color: #f3f4f6; font-variant-numeric: tabular-nums; }
    .ret .bar { flex: 1; height: .5em; background: #1f2937; border-radius: 999px; overflow: hidden; min-width: 3em; }
    .ret .bar i { display: block; height: 100%; background: #fbbf24; border-radius: 999px; }
    .section.grow .list { flex: 1; min-height: 4.5em; }
    .list::-webkit-scrollbar { width: 6px; } .list::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
    .row { display: flex; align-items: center; gap: .5em; padding: .25em .4em; border-radius: 6px; cursor: pointer; min-width: 0; flex-shrink: 0; }
    .row:hover { background: #1f2937; }
    .row .t { color: #8b93a3; font-size: .85em; font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .row .k { flex-shrink: 0; width: 1.2em; text-align: center; }
    .row .u { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; max-width: 46%; }
    .row .x { color: #c3c8d2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 0; min-width: 2em; }
    .b { display: inline-flex; align-items: center; gap: .25em; border-radius: 999px; padding: .1em .5em; font-size: .85em; font-weight: 700; white-space: nowrap; flex-shrink: 0; margin-left: auto; }
    .b.vip { background: rgba(245,158,11,.16); color: #fbbf24; }
    .b.repeat { background: rgba(14,165,233,.16); color: #7dd3fc; }
    .b.open { background: rgba(244,63,94,.16); color: #fda4af; margin-left: 0; }
    .empty { color: #8b93a3; font-size: .92em; padding: .25em .4em; }
    .foot { margin-top: .5em; color: #8b93a3; font-size: .85em; display: flex; justify-content: space-between; gap: .65em; flex-shrink: 0; }
    .foot .err { color: #f87171; }
    .toasts { position: absolute; left: 0; right: 0; bottom: 100%; display: flex; flex-direction: column; gap: .5em; padding-bottom: .65em; font-size: var(--fs); }
    .toast { background: #111827; border: 1px solid #374151; border-left: 4px solid #fbbf24; border-radius: 10px; padding: .65em .85em; box-shadow: 0 8px 24px rgba(0,0,0,.4); cursor: pointer; animation: rise .18s ease-out; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .toast.repeat { border-left-color: #7dd3fc; }
    .toast.info { border-left-color: #6b7280; }
    .toast b { display: block; font-size: 1.08em; }
    .toast span { color: #e5e7eb; font-size: .92em; }
    @keyframes rise { from { transform: translateY(6px); opacity: 0; } to { transform: none; opacity: 1; } }
    .clock { display: flex; align-items: baseline; justify-content: space-between; gap: .6em; margin-bottom: .6em; padding: .35em .7em; background: #111827; border-radius: 10px; }
    .clock b { font-size: 2.1em; font-weight: 800; letter-spacing: .02em; font-variant-numeric: tabular-nums; line-height: 1.05; }
    .clock b small { font-size: .45em; font-weight: 700; color: #9ca3af; margin-left: .25em; letter-spacing: 0; }
    .clock .air { text-align: right; color: #c3c8d2; font-size: .85em; line-height: 1.2; }
    .clock .air b { display: block; font-size: 1.25em; font-weight: 800; color: #f3f4f6; }
    .charts { display: grid; grid-template-columns: 1fr; gap: .5em; margin-top: .65em; }
    .chart { background: #111827; border-radius: 8px; padding: .45em .55em .3em; min-width: 0; }
    .chart .h { display: flex; justify-content: space-between; align-items: baseline; gap: .4em; margin-bottom: .15em; }
    .chart .h small { color: #a3a9b5; font-size: .8em; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; white-space: nowrap; }
    .chart .h b { font-size: 1.05em; font-variant-numeric: tabular-nums; }
    .chart svg { display: block; width: 100%; height: auto; }
    .scan { margin-bottom: .65em; background: #14532d; border: 1px solid #166534; border-radius: 10px; padding: .6em .8em; flex-shrink: 0; }
    .scan .k { display: flex; justify-content: space-between; align-items: baseline; gap: .5em; color: #86efac; font-size: .8em; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
    .scan .k .age { font-weight: 500; text-transform: none; letter-spacing: 0; color: #4ade80; }
    .scan .top { display: flex; align-items: flex-start; gap: .6em; margin-top: .15em; }
    .scan .name { font-size: 1.35em; font-weight: 800; line-height: 1.15; flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .scan .meta { color: #bbf7d0; font-size: .9em; margin-top: .1em; }
    .scan .rec { text-align: right; flex-shrink: 0; }
    .scan .rec small { display: block; color: #86efac; font-size: .75em; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
    .scan .rec b { display: block; font-size: 1.9em; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
    .scan .rec i { display: block; font-style: normal; color: #bbf7d0; font-size: .8em; margin-top: .15em; }
    .scan .say { margin-top: .5em; background: #fcd34d; color: #111827; border-left: .4em solid #f59e0b; border-radius: 8px; padding: .5em .7em; }
    .scan .say small { display: block; color: #92400e; font-size: .72em; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
    .scan .say div { font-size: 1.15em; font-weight: 600; line-height: 1.3; white-space: pre-wrap; }
    .scan .none { margin-top: .4em; color: #86efac; font-size: .85em; }
    .panel.collapsed .body { display: none; }
    .muted .dot { animation: none; background: #6b7280; box-shadow: none; }
    /* Narrow = fewer than ~20 characters across at the current text size:
       drop the title word, tighten the header, and stack the tiles 2×2 so
       big text on a small panel still reads instead of truncating. */
    .panel.narrow .title { display: none; }
    .panel.narrow .head { gap: .4em; padding-left: .6em; padding-right: .6em; }
    .panel.narrow .tiles, .panel.tight .tiles { grid-template-columns: repeat(2, 1fr); }
    .panel.narrow .viewers small, .panel.tight .viewers small { display: none; }
  `;

  function build() {
    host = document.createElement('div');
    host.id = 'folia-live-overlay';
    host.hidden = true;
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap" id="wrap">
      <div class="toasts" id="toasts"></div>
      <div class="panel" id="panel">
        <div class="head" id="head">
          <span class="dot"></span>
          <span class="title">BAE live</span>
          <span class="viewers" title="Viewers now / peak this show"><b id="viewers">—</b><small id="peak"></small></span>
          <button id="smaller" title="Smaller text" class="tsz">A−</button>
          <button id="bigger" title="Bigger text" class="tsz">A+</button>
          <button id="mute" title="Mute alerts">🔔</button>
          <button id="collapse" title="Collapse">–</button>
        </div>
        <div class="body">
          <div class="clock" id="clock">
            <b><span id="clockTime">--:--</span><small id="clockAmPm"></small></b>
            <div class="air"><span id="airLabel">on air</span><b id="airTime">—</b></div>
          </div>
          <div class="scan" id="scan" hidden></div>
          <div class="tiles">
            <div class="tile"><small>Gross</small><b id="gross">—</b></div>
            <div class="tile"><small>Orders</small><b id="orders">—</b></div>
            <div class="tile" title="Gross per hour · lots per hour"><small>Pace /hr</small><b id="pace">—</b><i id="paceLots"></i></div>
            <div class="tile" title="Since the last sale"><small>Last</small><b id="lastSale">—</b><i id="lastSaleWhat"></i></div>
          </div>
          <div class="lot" id="lot"><span class="empty">No lot on the block</span></div>
          <div class="charts">
            <div class="chart"><div class="h"><small>Sales $ · per 10 min</small><b id="chartGrossNow">—</b></div><div id="chartGross"></div></div>
          </div>
          <div class="section vips">
            <small><span>VIPs in the room</span><span id="vipCount">0</span></small>
            <div class="ret" id="ret" title="Of everyone seen this show (joined, bid, or bought), how many have bought before"></div>
            <div class="list" id="vips"><div class="empty">Nobody badged yet</div></div>
          </div>
          <div class="section grow">
            <small><span>Activity</span><span id="entries"></span></small>
            <div class="list" id="feed"><div class="empty">Waiting for the room…</div></div>
          </div>
          <div class="foot"><span id="foot">loading history…</span><span id="brand"></span></div>
        </div>
      </div>
      </div>`;
    for (const id of ['wrap', 'panel', 'toasts', 'head', 'scan', 'clockTime', 'clockAmPm', 'airLabel', 'airTime', 'chartGross', 'chartGrossNow', 'ret', 'paceLots', 'lastSaleWhat', 'viewers', 'peak', 'smaller', 'bigger', 'mute', 'collapse', 'gross', 'orders', 'pace',
      'lastSale', 'lot', 'vipCount', 'vips', 'entries', 'feed', 'foot', 'brand']) {
      el[id] = root.getElementById(id);
    }
    (document.documentElement || document.body).appendChild(host);

    el.collapse.addEventListener('click', (e) => { e.stopPropagation(); prefs.collapsed = !prefs.collapsed; applyPrefs(); savePrefs(); });
    el.mute.addEventListener('click', (e) => { e.stopPropagation(); prefs.muted = !prefs.muted; applyPrefs(); savePrefs(); });
    const stepScale = (dir) => {
      const i = SCALE_STEPS.indexOf(prefs.scale);
      const cur = i >= 0 ? i : SCALE_STEPS.indexOf(1);
      prefs.scale = SCALE_STEPS[Math.max(0, Math.min(SCALE_STEPS.length - 1, cur + dir))];
      applyPrefs(); savePrefs();
    };
    el.smaller.addEventListener('click', (e) => { e.stopPropagation(); stepScale(-1); });
    el.bigger.addEventListener('click', (e) => { e.stopPropagation(); stepScale(1); });
    el.panel.addEventListener('click', () => { resumeAudio(); });
    el.vips.addEventListener('click', onRowClick);
    el.feed.addEventListener('click', onRowClick);
    wireDrag();
    wireResize();
    window.addEventListener('resize', () => { applyPrefs(); });
  }

  // Base font follows the panel width (about 1px per 26px, clamped) times
  // the A−/A+ scale, so dragging the corner scales everything, not just the
  // empty space, and the buttons bump it further without a wider panel.
  function applyScale() {
    const w = el.panel.offsetWidth || PANEL_W;
    const scale = SCALE_STEPS.includes(prefs.scale) ? prefs.scale : 1;
    const fs = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round((w / 26) * scale)));
    el.panel.style.setProperty('--fs', `${fs}px`);
    // Characters across at this text size decide the layout: < 20 drops the
    // title and stacks everything, < 26 stacks the stat tiles 2×2, ≥ 34 puts
    // the two charts side by side.
    const chars = w / fs;
    el.panel.classList.toggle('narrow', chars < 20);
    el.panel.classList.toggle('tight', chars < 24);
    el.panel.classList.toggle('wide', chars >= 34);
    el.smaller.disabled = scale === SCALE_STEPS[0];
    el.bigger.disabled = scale === SCALE_STEPS[SCALE_STEPS.length - 1];
    el.bigger.title = `Bigger text (${Math.round(scale * 100)}%)`;
    el.smaller.title = `Smaller text (${Math.round(scale * 100)}%)`;
  }

  // The native CSS resize handle sets inline width/height on the panel;
  // watch it, rescale, keep it on-screen, and remember the size. Only a
  // real corner drag counts as a resize: content growing (the scan card
  // appearing, a longer feed) must NOT pin the height, or it clips.
  function wireResize() {
    let saveTimer = null;
    let last = { w: 0, h: 0 };
    let dragging = false;
    el.panel.addEventListener('pointerdown', (e) => {
      // Anywhere in the panel's bottom-right corner region = the grip.
      const r = el.panel.getBoundingClientRect();
      dragging = e.clientX > r.right - 24 && e.clientY > r.bottom - 24;
    });
    document.addEventListener('pointerup', () => { dragging = false; }, true);
    document.addEventListener('pointercancel', () => { dragging = false; }, true);
    const ro = new ResizeObserver(() => {
      if (!host || host.hidden || prefs.collapsed) return;
      const w = el.panel.offsetWidth, h = el.panel.offsetHeight;
      if (w === last.w && h === last.h) return;
      last = { w, h };
      applyScale();
      if (!dragging) return;          // content reflow, not the operator
      prefs.w = w; prefs.h = h;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { applyPrefs(); savePrefs(); }, 250);
    });
    ro.observe(el.panel);
  }

  function onRowClick(e) {
    const row = e.target.closest?.('.row');
    const user = row?.dataset?.user;
    if (!user) return;
    try { navigator.clipboard?.writeText(user); toast('info', 'Copied', `@${user} is on the clipboard`, 2500); } catch { /* clipboard blocked */ }
  }

  function applyPrefs() {
    if (!host) return;
    el.panel.classList.toggle('collapsed', !!prefs.collapsed);
    el.panel.classList.toggle('muted', !!prefs.muted);
    el.collapse.textContent = prefs.collapsed ? '+' : '–';
    el.collapse.title = prefs.collapsed ? 'Expand' : 'Collapse';
    el.mute.textContent = prefs.muted ? '🔕' : '🔔';
    el.mute.title = prefs.muted ? 'Alerts muted — click to unmute' : 'Mute alerts';
    if (prefs.w) el.panel.style.width = `${Math.max(PANEL_MIN_W, prefs.w)}px`;
    if (!prefs.collapsed) {
      if (prefs.h) el.panel.style.height = `${Math.max(PANEL_MIN_H, prefs.h)}px`;
    } else {
      el.panel.style.height = '';   // collapsed: shrink to the header
    }
    applyScale();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = el.panel.offsetWidth || prefs.w || PANEL_W;
    let x = prefs.x, y = prefs.y;
    if (x == null || y == null) { x = vw - w - 16; y = 72; }
    x = Math.min(Math.max(0, x), Math.max(0, vw - w));
    y = Math.min(Math.max(0, y), Math.max(0, vh - 48));
    el.wrap.style.left = `${x}px`;
    el.wrap.style.top = `${y}px`;
  }

  async function loadPrefs() {
    try {
      const v = await chrome.storage.local.get({ [PREFS_KEY]: null });
      if (v?.[PREFS_KEY] && typeof v[PREFS_KEY] === 'object') prefs = { ...prefs, ...v[PREFS_KEY] };
    } catch { /* defaults */ }
  }
  function savePrefs() {
    try { chrome.storage.local.set({ [PREFS_KEY]: prefs }); } catch { /* ignore */ }
  }

  function wireDrag() {
    let drag = null;
    el.head.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const r = el.wrap.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    const move = (e) => {
      if (!drag) return;
      prefs.x = e.clientX - drag.dx;
      prefs.y = e.clientY - drag.dy;
      applyPrefs();
    };
    const up = () => { if (drag) { drag = null; savePrefs(); } };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  }

  // ── alerts ───────────────────────────────────────────────────────────
  function toast(kind, title, line, ms = TOAST_MS) {
    if (!host) return;
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.innerHTML = `<b>${esc(title)}</b><span>${esc(line)}</span>`;
    const kill = () => { t.remove(); };
    t.addEventListener('click', kill);
    el.toasts.appendChild(t);
    while (el.toasts.children.length > 4) el.toasts.firstChild.remove();
    setTimeout(kill, ms);
  }

  function resumeAudio() {
    try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch { /* ignore */ }
  }
  function chime(tier) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      resumeAudio();
      const notes = tier === 'vip' ? [880, 1175, 1568] : [660, 880];
      const t0 = audioCtx.currentTime;
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + i * 0.13);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + i * 0.13 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.13 + 0.22);
        o.connect(g).connect(audioCtx.destination);
        o.start(t0 + i * 0.13); o.stop(t0 + i * 0.13 + 0.25);
      });
    } catch { /* no audio — the toast still shows */ }
  }

  function describe(st) {
    const bits = [`${fmtMoney(st.spent)} lifetime`, `${st.boxes} box${st.boxes === 1 ? '' : 'es'}`];
    if (st.openBoxes) bits.push(`${st.openBoxes} waiting to ship`);
    return bits.join(' · ');
  }

  function maybeAlert(kind, user, extra) {
    const st = statsFor(user);
    if (!st || !alertable(st.tier)) return;
    const key = `${lc(user)}|${kind}`;
    if (kind !== 'sale' && alerted.has(key)) return;
    alerted.add(key);
    const who = st.tier === 'vip' ? '👑 VIP' : '⭐ Repeat buyer';
    const verb = kind === 'join' ? 'joined' : kind === 'bid' ? 'is bidding' : 'won';
    const title = `${who} ${verb}: @${user}`;
    const line = describe(st) + (extra ? ` · ${extra}` : '');
    toast(st.tier, title, line);
    if (prefs.muted) return;
    const sound = settings?.liveAlertSound !== false;
    if (sound) chime(st.tier);
    if (settings?.liveDesktopNotify) sendBg({ type: 'notify', title, message: line, silent: sound });
  }

  // ── last scan (from the web app's scan screen) ───────────────────────
  async function pollScan() {
    if (scanPolling || !host || host.hidden) return;
    if (!settings?.apiBase || !settings?.userId) return;
    scanPolling = true;
    try {
      const resp = await sendBg({ type: 'api:liveScanGet', settings });
      if (resp?.ok) {
        const next = resp.scan && resp.scan.sku ? resp.scan : null;
        const changed = (next?.at || null) !== (scan?.at || null) || (next?.sku || null) !== (scan?.sku || null);
        scan = next;
        if (changed) renderScan();
      }
    } catch { /* keep the last one */ }
    finally { scanPolling = false; }
  }

  function renderScan() {
    if (!host) return;
    const age = scan?.at ? Date.now() - new Date(scan.at).getTime() : Infinity;
    if (!scan || !(age < SCAN_STALE_MS)) { el.scan.hidden = true; el.scan.innerHTML = ''; return; }
    const list = Number.isFinite(Number(scan.listPrice)) && Number(scan.listPrice) > 0 ? Number(scan.listPrice) : null;
    const typed = Number.isFinite(Number(scan.price)) && Number(scan.price) > 0 ? Number(scan.price) : null;
    const rec = list ?? typed;
    const sub = list == null ? (typed != null ? 'no list price · typed' : 'no price') : typed != null && typed !== list ? `typed ${fmtMoney(typed)}` : 'listed at this';
    const modeLabel = { auction: 'Auction', buy_now: 'Buy Now', give_away: 'Giveaway' }[scan.mode] || scan.mode || '';
    el.scan.innerHTML = `
      <div class="k"><span>Just scanned${scan.forced ? ' · forced' : ''}</span><span class="age">${esc(fmtAgo(scan.at))} ago</span></div>
      <div class="top">
        <div style="flex:1;min-width:0">
          <div class="name">${esc(scan.name || scan.sku)}</div>
          <div class="meta">${esc([scan.variety, scan.sku, modeLabel].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="rec"><small>Recommended</small><b>${rec != null ? esc(fmtMoney(rec)) : '—'}</b><i>${esc(sub)}</i></div>
      </div>
      ${scan.sellNote ? `<div class="say"><small>Say this</small><div>${esc(scan.sellNote)}</div></div>` : '<div class="none">No sell note for this species</div>'}`;
    el.scan.hidden = false;
  }

  // ── tick handling ────────────────────────────────────────────────────
  function newShow(show) {
    showId = show.showId;
    alerted = new Set();
    feed = [];
    // Seed the feed from what the show already recorded (mid-show reload).
    const ev = [];
    for (const s of (show.sold || []).slice(-6)) ev.push({ t: s.at, kind: 'sale', user: s.buyer, price: s.price, lot: s.lot, title: s.title });
    for (const b of (show.bidders || []).slice(-10)) ev.push({ t: b.t, kind: 'bid', user: b.user, price: b.price });
    for (const j of (show.joins || []).slice(-10)) ev.push({ t: j.t, kind: 'join', user: j.user });
    feed = ev.filter(e => e.t).sort((a, b) => new Date(b.t) - new Date(a.t)).slice(0, FEED_MAX);
    ensureBuyers(true);
  }

  function ingest(fresh) {
    if (!fresh) return;
    const add = (e) => { feed.unshift(e); if (feed.length > FEED_MAX) feed.length = FEED_MAX; };
    for (const j of fresh.joins || []) { add({ t: j.t, kind: 'join', user: j.user }); maybeAlert('join', j.user); }
    for (const b of fresh.bidders || []) { add({ t: b.t, kind: 'bid', user: b.user, price: b.price }); maybeAlert('bid', b.user, b.price != null ? fmtMoney(b.price) : ''); }
    for (const s of fresh.sold || []) {
      add({ t: s.at, kind: 'sale', user: s.buyer, price: s.price, lot: s.lot, title: s.title });
      maybeAlert('sale', s.buyer, `#${s.lot} ${s.title || ''} ${fmtMoney(s.price)}`.trim());
    }
  }

  // The scraper announces its own death (extension context invalidated by a
  // self-reload); the re-injected pair takes over.
  function onDead() { teardown(); }

  function teardown() {
    document.removeEventListener('folia:live-tick', onTick);
    document.removeEventListener('folia:live-dead', onDead);
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (wallClock) { clearInterval(wallClock); wallClock = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    host?.remove(); host = null;
    if (window.__foliaLiveOverlay === overlaySelf) delete window.__foliaLiveOverlay;
  }

  function onTick(e) {
    if (!alive()) { teardown(); return; }
    const d = e.detail || {};
    if (!d.snap || !d.show) {
      if (host && !host.hidden && Date.now() - lastTickAt > HIDE_AFTER_MS) host.hidden = true;
      return;
    }
    lastTickAt = Date.now();
    if (host.hidden) { host.hidden = false; applyPrefs(); pollScan(); }
    // A new show seeds the feed from the show state (which already holds
    // this pass's events) and skips alerts; later passes ingest only what
    // the scraper first saw on that pass.
    if (d.show.showId !== showId) newShow(d.show);
    else { ensureBuyers(false); ingest(d.fresh); }
    last = d;
    scheduleRender();
  }

  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; render(); });
  }

  // ── clock ────────────────────────────────────────────────────────────
  // Big wall clock for the streamer + time on air (since the show's first
  // tick). Ticks every second; only these two elements change.
  function renderClock() {
    if (!host) return;
    const d = new Date();
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    el.clockTime.textContent = `${h}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    el.clockAmPm.textContent = ampm;
    const started = last?.show?.startedAt ? new Date(last.show.startedAt).getTime() : null;
    if (started && host && !host.hidden) {
      const s = Math.max(0, Math.round((Date.now() - started) / 1000));
      const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
      el.airLabel.textContent = 'on air';
      el.airTime.textContent = hh ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm} min`;
    } else {
      el.airLabel.textContent = '';
      el.airTime.textContent = '—';
    }
  }

  // ── charts ───────────────────────────────────────────────────────────
  // One bar chart over ELAPSED show time, one bar per 10 minutes: sales $
  // in that slice (lots in the tooltip and the header), from the sold log. Thin bars with rounded
  // tops and 2px gaps, three recessive gridlines, elapsed ticks, only the
  // tallest bar direct-labelled, a native tooltip (<title>) on every bar,
  // the current slice drawn a touch brighter. Colors are the reference
  // palette's dark steps (aqua slot 3 for $, blue slot 1 for lots),
  // validated on this surface. Rebuilt on each tick — cheap.
  const BUCKET_MS = 10 * 60000;
  const CH_W = 300, CH_H = 92, CH_PL = 34, CH_PR = 8, CH_PT = 10, CH_PB = 16;
  function barsSvg(buckets, color, fmt) {
    // buckets: [{ t: ms since start (slice start), v, lots }], one per 10 min slice.
    const n = buckets.length;
    const vMax = Math.max(1, ...buckets.map(b => b.v));
    const step = (() => { const raw = vMax / 2; const p = 10 ** Math.floor(Math.log10(raw)); const c = raw / p; return (c <= 1 ? 1 : c <= 2 ? 2 : c <= 5 ? 5 : 10) * p; })();
    const yMax = Math.max(step, Math.ceil(vMax / step) * step);
    const span = n * BUCKET_MS;
    const x = (t) => CH_PL + (t / span) * (CH_W - CH_PL - CH_PR);
    const y = (v) => CH_H - CH_PB - (v / yMax) * (CH_H - CH_PT - CH_PB);
    const slot = (CH_W - CH_PL - CH_PR) / n;
    const bw = Math.max(1.5, slot - 2);
    const grid = [0, yMax / 2, yMax].map(v => `<line x1="${CH_PL}" x2="${CH_W - CH_PR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#374151" stroke-width="1"/>` +
      `<text x="${CH_PL - 4}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="#9ca3af">${esc(fmt(v))}</text>`).join('');
    const spanMin = span / 60000;
    const tickEvery = spanMin <= 60 ? 10 : spanMin <= 180 ? 30 : 60;
    const ticks = [];
    for (let m = 0; m <= spanMin + 0.01; m += tickEvery) ticks.push(m);
    const xt = ticks.map((m, i) => `<text x="${x(m * 60000).toFixed(1)}" y="${CH_H - 4}" font-size="9" fill="#9ca3af" text-anchor="${i === 0 ? 'start' : m >= spanMin - tickEvery / 2 ? 'end' : 'middle'}">${m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`}</text>`).join('');
    const top = buckets.reduce((b, c) => (c.v > (b?.v ?? 0) ? c : b), null);
    const bars = buckets.map((b, i) => {
      if (!b.v) return '';
      const bx = x(b.t) + 1, h = Math.max(1, y(0) - y(b.v));
      const m0 = b.t / 60000, m1 = m0 + BUCKET_MS / 60000;
      const label = `${m0}–${m1} min: ${fmt(b.v)}${b.lots != null ? ` · ${b.lots} lot${b.lots === 1 ? '' : 's'}` : ''}`;
      const current = i === n - 1;
      return `<g><title>${esc(label)}</title><rect x="${bx.toFixed(1)}" y="${y(b.v).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${color}" opacity="${current ? 1 : 0.8}"/>` +
        (top && top.t === b.t ? `<text x="${(bx + bw / 2).toFixed(1)}" y="${(y(b.v) - 3).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="#f3f4f6">${esc(fmt(b.v))}</text>` : '') + '</g>';
    }).join('');
    return `<svg viewBox="0 0 ${CH_W} ${CH_H}" role="img" aria-label="per 10 minutes over show time">${grid}${xt}${bars}</svg>`;
  }

  function renderCharts(show) {
    const started = show?.startedAt ? new Date(show.startedAt).getTime() : null;
    const sold = (show?.sold || []).filter(s => s && s.at).map(s => ({ t: new Date(s.at).getTime(), price: Number(s.price) || 0 })).filter(s => Number.isFinite(s.t));
    if (!started || !Number.isFinite(started)) {
      el.chartGross.innerHTML = '<div class="empty">Waiting for the show…</div>';
      el.chartGrossNow.textContent = '—';
      return;
    }
    const elapsed = Math.max(Date.now() - started, BUCKET_MS);
    const n = Math.max(3, Math.ceil(elapsed / BUCKET_MS));
    const gross = Array.from({ length: n }, (_, i) => ({ t: i * BUCKET_MS, v: 0, lots: 0 }));
    let g = 0;
    for (const s of sold) {
      const i = Math.min(n - 1, Math.max(0, Math.floor((s.t - started) / BUCKET_MS)));
      gross[i].v += s.price; gross[i].lots += 1; g += s.price;
    }
    el.chartGross.innerHTML = barsSvg(gross, '#199e70', (v) => `$${Math.round(v).toLocaleString()}`);
    el.chartGrossNow.textContent = `${fmtMoney(g)} · ${sold.length} lot${sold.length === 1 ? '' : 's'}`;
  }

  // ── render ───────────────────────────────────────────────────────────
  // compact: the feed drops the 📦 open-box badge (the VIP list keeps it) so
  // usernames stay readable in 300px.
  function badgeHtml(user, compact = false) {
    const st = statsFor(user);
    if (!st) return '';
    const open = st.openBoxes && !compact ? `<span class="b open" title="Boxes still waiting to ship">📦 ${st.openBoxes}</span>` : '';
    return `<span class="b ${st.tier}" title="${esc(describe(st))}">${st.tier === 'vip' ? '👑' : '⭐'} ${esc(fmtMoney(st.spent))} · ${st.boxes} bx</span>${open}`;
  }

  function highBidder(show) {
    const cur = show.current;
    if (!cur) return null;
    const since = cur.startedAt ? new Date(cur.startedAt).getTime() : 0;
    const bids = (show.bidders || []).filter(b => b.t && new Date(b.t).getTime() >= since);
    if (!bids.length) return null;
    const atPrice = cur.price != null ? bids.filter(b => b.price === cur.price) : [];
    return (atPrice.length ? atPrice : bids)[ (atPrice.length ? atPrice : bids).length - 1 ] || null;
  }

  function render() {
    if (!host || host.hidden || !last) return;
    const { snap, show } = last;

    const vNow = show.viewers?.now ?? snap.viewers ?? null;
    const vPeak = show.viewers?.peak ?? null;
    el.viewers.textContent = fmtInt(vNow);
    el.peak.textContent = vPeak != null && vNow != null && vPeak > vNow ? `/ ${fmtInt(vPeak)} peak` : (vPeak != null && vNow == null ? `peak ${fmtInt(vPeak)}` : '');
    el.viewers.title = vNow == null ? 'Viewer count not found on the page — set a pattern in the extension options' : 'Viewers now / peak this show';

    const gross = show.totals?.gross ?? null;
    el.gross.textContent = fmtMoney(gross);
    el.orders.textContent = fmtInt(show.totals?.orders);
    const sold = Array.isArray(show.sold) ? show.sold : [];
    const hours = show.startedAt ? (Date.now() - new Date(show.startedAt).getTime()) / 3.6e6 : 0;
    if (hours >= 0.08 && (gross != null || sold.length)) {
      el.pace.textContent = gross != null ? fmtMoney(gross / hours) : '—';
      el.paceLots.textContent = `${(sold.length / hours).toFixed(1)} lots/hr`;
    } else { el.pace.textContent = '—'; el.paceLots.textContent = ''; }
    const lastSold = sold.length ? sold[sold.length - 1] : null;
    el.lastSale.textContent = lastSold ? `${fmtAgo(lastSold.at).replace(/ \d+s$/, '')} ago` : '—';
    el.lastSaleWhat.textContent = lastSold ? `#${lastSold.lot} · ${fmtMoney(lastSold.price)}` : '';
    el.lastSale.title = lastSold ? `#${lastSold.lot} ${lastSold.title || ''} · ${fmtMoney(lastSold.price)} · @${lastSold.buyer || '—'}` : '';

    const cur = show.current;
    if (cur) {
      const hb = highBidder(show);
      const bids = Array.isArray(cur.bids) ? cur.bids.length : 0;
      el.lot.innerHTML = `
        <span class="num">#${esc(cur.lot)}</span>
        <span class="name" title="${esc(cur.title || '')}">${esc(cur.title || '')}</span>
        <span class="price">${esc(fmtMoney(cur.price))}</span>
        <span class="sub">${bids ? `${bids} bid${bids === 1 ? '' : 's'}` : 'no bids yet'}${hb ? ` · high: <span class="u">@${esc(hb.user)}</span>${badgeHtml(hb.user)}` : ''}${snap.winner ? ` · <span style="color:#34d399">SOLD to @${esc(snap.winner)}</span>` : ''}</span>`;
    } else {
      el.lot.innerHTML = '<span class="empty">No lot on the block</span>';
    }
    renderCharts(show);

    // VIPs seen this show: joins ∪ bidders ∪ buyers, badged, VIP first.
    const seen = new Map();
    const note = (u, t) => { const k = lc(u); if (!k) return; const prev = seen.get(k); if (!prev || (t && t > prev.t)) seen.set(k, { user: u, t: t || prev?.t || null }); };
    for (const j of show.joins || []) note(j.user, j.t);
    for (const b of show.bidders || []) note(b.user, b.t);
    for (const s of sold) note(s.buyer, s.at);
    const vips = [];
    for (const { user, t } of seen.values()) {
      const st = statsFor(user);
      if (st && (st.tier === 'vip' || st.tier === 'repeat')) vips.push({ user, t, st });
    }
    vips.sort((a, b) => (a.st.tier === b.st.tier ? b.st.spent - a.st.spent : a.st.tier === 'vip' ? -1 : 1));
    el.vipCount.textContent = String(vips.filter(v => v.st.tier === 'vip').length) + (vips.length ? ` · ${vips.length} badged` : '');
    // Returning buyers: of everyone seen this show, how many have bought
    // from us before (any badge). The share is what the streamer wants.
    const seenN = seen.size;
    if (!buyers) el.ret.innerHTML = '<span class="empty">history not loaded</span>';
    else if (!seenN) el.ret.innerHTML = '<span class="empty">nobody seen yet</span>';
    else {
      const pctRet = Math.round((vips.length / seenN) * 100);
      el.ret.innerHTML = `<b>${pctRet}%</b> returning <span class="bar"><i style="width:${pctRet}%"></i></span> <b>${vips.length}</b> of ${seenN} · ${seenN - vips.length} new`;
    }
    el.vips.innerHTML = vips.length
      ? vips.slice(0, VIP_LIST_MAX).map(v => `
          <div class="row" data-user="${esc(v.user)}" title="Click to copy @${esc(v.user)}">
            <span class="t">${esc(fmtClock(v.t))}</span>
            <span class="u">@${esc(v.user)}</span>${badgeHtml(v.user)}
          </div>`).join('') + (vips.length > VIP_LIST_MAX ? `<div class="empty">+${vips.length - VIP_LIST_MAX} more</div>` : '')
      : (buyers ? '<div class="empty">Nobody badged yet</div>' : '<div class="empty">History not loaded</div>');

    el.entries.textContent = show.totals?.entries != null ? `${fmtInt(show.totals.entries)} entries` : '';
    el.feed.innerHTML = feed.length
      ? feed.map(e => {
          const k = e.kind === 'sale' ? '💵' : e.kind === 'bid' ? '🔨' : '👋';
          const x = e.kind === 'sale' ? `won #${esc(e.lot)} · ${esc(fmtMoney(e.price))}`
            : e.kind === 'bid' ? `bid${e.price != null ? ' ' + esc(fmtMoney(e.price)) : ''}` : 'joined';
          return `<div class="row" data-user="${esc(e.user)}" title="Click to copy @${esc(e.user)}">
            <span class="t">${esc(fmtClock(e.t))}</span><span class="k">${k}</span>
            <span class="u">@${esc(e.user)}</span><span class="x">${x}</span>${badgeHtml(e.user, true)}
          </div>`;
        }).join('')
      : '<div class="empty">Waiting for the room…</div>';

    renderFoot();
  }

  function renderFoot() {
    if (!host) return;
    if (buyersLoading && !buyers) el.foot.innerHTML = 'loading history…';
    else if (buyers) el.foot.innerHTML = `history: ${Object.keys(buyers).length} badged buyers · ${fmtAgo(buyersAt)} ago${buyersErr ? ` · <span class="err">refresh failed</span>` : ''}`;
    else el.foot.innerHTML = `<span class="err">history unavailable: ${esc(buyersErr || '…')}</span>`;
    el.brand.textContent = settings?.brandId ? String(settings.brandId) : '';
  }

  // ── boot ─────────────────────────────────────────────────────────────
  async function loadSettings() {
    try { settings = await chrome.storage.sync.get(null); } catch { settings = {}; }
  }

  async function boot() {
    await loadSettings();
    if (settings?.liveOverlay === false) return;   // turned off in options
    await loadPrefs();
    build();
    applyPrefs();
    document.addEventListener('folia:live-tick', onTick);
    document.addEventListener('folia:live-dead', onDead);
    // Relative clocks ("last sale 4m ago", history age) drift without a tick.
    clockTimer = setInterval(() => { if (last && host && !host.hidden) { scheduleRender(); renderScan(); } }, 5000);
    renderClock();
    wallClock = setInterval(renderClock, 1000);
    scanTimer = setInterval(pollScan, SCAN_POLL_MS);
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        loadSettings().then(() => {
          if (settings?.liveOverlay === false && host) teardown();
          if (changes.apiBase || changes.userId || changes.brandId) { buyers = null; buyersErr = null; buyersAt = 0; ensureBuyers(true); }
        });
      });
    } catch { /* not in an extension context */ }
  }

  boot().catch(() => { /* never take the dashboard down */ });
})();
