// Live overlay — the streamer-facing widget ON the Palmstreet seller
// dashboard tab (the one OBS streams from). live-monitor.js does the
// scraping and emits one `folia:live-tick` DOM event per pass; this script
// only renders and alerts. It never writes the show blob.
//
// Shows: viewers (now / peak), gross, orders, sales pace, time since the
// last sale, the lot on the block with its high bidder, the VIPs seen in
// the room this show, and a short activity feed — every username badged
// against lifetime shipping history (live-show-buyers: 👑 VIP / ⭐ repeat,
// lifetime $, boxes, and any box still waiting to ship).
//
// Alerts (toast + chime + optional desktop notification) fire once per show
// per buyer for a VIP (or repeat, if enabled) join and first bid, and on
// every VIP win. The first pass of a show seeds the feed from the show
// state and never alerts: on a mid-show install the chat backlog would
// otherwise fire everything at once. History loads once per show and
// refreshes every 10 minutes.
//
// Lives in a shadow root so Palmstreet's CSS can't restyle it and ours
// can't leak out. Position / collapsed / muted persist in storage.local.

(() => {
  if (window.__foliaLiveOverlay) return;
  window.__foliaLiveOverlay = true;

  const PREFS_KEY = 'liveOverlayPrefs';
  const BUYERS_REFRESH_MS = 10 * 60 * 1000;
  const BUYERS_RETRY_MS = 60 * 1000;
  const TOAST_MS = 12_000;
  const FEED_MAX = 14;
  const VIP_LIST_MAX = 8;
  const HIDE_AFTER_MS = 8_000;       // no dashboard tick for this long → hide
  const PANEL_W = 300;

  let host = null, root = null;
  const el = {};
  let prefs = { x: null, y: null, collapsed: false, muted: false };
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
    .panel {
      position: fixed; z-index: 2147483647; width: ${PANEL_W}px;
      font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #e5e7eb; background: rgba(9, 12, 20, 0.94); border: 1px solid #1f2937;
      border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.45); user-select: none;
      backdrop-filter: blur(8px);
    }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: grab; border-bottom: 1px solid #1f2937; }
    .head:active { cursor: grabbing; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 0 0 rgba(239,68,68,.6); animation: pulse 1.6s infinite; flex-shrink: 0; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(239,68,68,.6); } 70% { box-shadow: 0 0 0 7px rgba(239,68,68,0); } 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); } }
    .title { font-weight: 700; letter-spacing: .02em; color: #9ca3af; font-size: 11px; text-transform: uppercase; }
    .viewers { margin-left: auto; display: flex; align-items: baseline; gap: 4px; }
    .viewers b { font-size: 18px; font-variant-numeric: tabular-nums; }
    .viewers small { color: #6b7280; font-size: 10px; }
    .head button, .lot button { all: unset; cursor: pointer; color: #9ca3af; padding: 2px 5px; border-radius: 6px; font-size: 13px; line-height: 1; }
    .head button:hover { background: #1f2937; color: #fff; }
    .body { padding: 8px 10px 6px; }
    .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .tile { background: #111827; border-radius: 8px; padding: 6px 7px; min-width: 0; }
    .tile small { display: block; color: #6b7280; font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; }
    .tile b { display: block; font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .lot { margin-top: 8px; background: #111827; border-radius: 8px; padding: 7px 9px; display: flex; align-items: baseline; gap: 8px; min-height: 34px; }
    .lot .num { font-size: 16px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .lot .name { color: #d1d5db; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .lot .price { margin-left: auto; font-size: 16px; font-weight: 800; color: #60a5fa; font-variant-numeric: tabular-nums; }
    .lot .sub { flex-basis: 100%; color: #9ca3af; font-size: 11px; margin-top: -2px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .lot { flex-wrap: wrap; }
    .section { margin-top: 8px; }
    .section > small { display: flex; justify-content: space-between; color: #6b7280; font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 3px; }
    .list { display: flex; flex-direction: column; gap: 2px; max-height: 150px; overflow-y: auto; }
    .list::-webkit-scrollbar { width: 6px; } .list::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
    .row { display: flex; align-items: center; gap: 6px; padding: 3px 5px; border-radius: 6px; cursor: pointer; min-width: 0; }
    .row:hover { background: #1f2937; }
    .row .t { color: #4b5563; font-size: 10px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .row .k { flex-shrink: 0; width: 14px; text-align: center; }
    .row .u { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; max-width: 46%; }
    .row .x { color: #9ca3af; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 0; min-width: 24px; }
    .b { display: inline-flex; align-items: center; gap: 3px; border-radius: 999px; padding: 1px 6px; font-size: 10px; font-weight: 700; white-space: nowrap; flex-shrink: 0; margin-left: auto; }
    .b.vip { background: rgba(245,158,11,.16); color: #fbbf24; }
    .b.repeat { background: rgba(14,165,233,.16); color: #7dd3fc; }
    .b.open { background: rgba(244,63,94,.16); color: #fda4af; margin-left: 0; }
    .empty { color: #4b5563; font-size: 11px; padding: 3px 5px; }
    .foot { margin-top: 6px; color: #4b5563; font-size: 10px; display: flex; justify-content: space-between; gap: 8px; }
    .foot .err { color: #f87171; }
    .toasts { position: absolute; left: 0; right: 0; bottom: 100%; display: flex; flex-direction: column; gap: 6px; padding-bottom: 8px; }
    .toast { background: #111827; border: 1px solid #374151; border-left: 4px solid #fbbf24; border-radius: 10px; padding: 8px 10px; box-shadow: 0 8px 24px rgba(0,0,0,.4); cursor: pointer; animation: rise .18s ease-out; }
    .toast.repeat { border-left-color: #7dd3fc; }
    .toast.info { border-left-color: #6b7280; }
    .toast b { display: block; font-size: 13px; }
    .toast span { color: #d1d5db; font-size: 11px; }
    @keyframes rise { from { transform: translateY(6px); opacity: 0; } to { transform: none; opacity: 1; } }
    .panel.collapsed .body { display: none; }
    .muted .dot { animation: none; background: #6b7280; box-shadow: none; }
  `;

  function build() {
    host = document.createElement('div');
    host.id = 'folia-live-overlay';
    host.hidden = true;
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="panel" id="panel">
        <div class="toasts" id="toasts"></div>
        <div class="head" id="head">
          <span class="dot"></span>
          <span class="title">Folia live</span>
          <span class="viewers" title="Viewers now / peak this show"><b id="viewers">—</b><small id="peak"></small></span>
          <button id="mute" title="Mute alerts">🔔</button>
          <button id="collapse" title="Collapse">–</button>
        </div>
        <div class="body">
          <div class="tiles">
            <div class="tile"><small>Gross</small><b id="gross">—</b></div>
            <div class="tile"><small>Orders</small><b id="orders">—</b></div>
            <div class="tile" title="Gross per hour · lots per hour"><small>Pace /hr</small><b id="pace">—</b></div>
            <div class="tile" title="Since the last sale"><small>Last sale</small><b id="lastSale">—</b></div>
          </div>
          <div class="lot" id="lot"><span class="empty">No lot on the block</span></div>
          <div class="section">
            <small><span>VIPs in the room</span><span id="vipCount">0</span></small>
            <div class="list" id="vips"><div class="empty">Nobody badged yet</div></div>
          </div>
          <div class="section">
            <small><span>Activity</span><span id="entries"></span></small>
            <div class="list" id="feed"><div class="empty">Waiting for the room…</div></div>
          </div>
          <div class="foot"><span id="foot">loading history…</span><span id="brand"></span></div>
        </div>
      </div>`;
    for (const id of ['panel', 'toasts', 'head', 'viewers', 'peak', 'mute', 'collapse', 'gross', 'orders', 'pace',
      'lastSale', 'lot', 'vipCount', 'vips', 'entries', 'feed', 'foot', 'brand']) {
      el[id] = root.getElementById(id);
    }
    (document.documentElement || document.body).appendChild(host);

    el.collapse.addEventListener('click', (e) => { e.stopPropagation(); prefs.collapsed = !prefs.collapsed; applyPrefs(); savePrefs(); });
    el.mute.addEventListener('click', (e) => { e.stopPropagation(); prefs.muted = !prefs.muted; applyPrefs(); savePrefs(); });
    el.panel.addEventListener('click', () => { resumeAudio(); });
    el.vips.addEventListener('click', onRowClick);
    el.feed.addEventListener('click', onRowClick);
    wireDrag();
    window.addEventListener('resize', () => { applyPrefs(); });
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
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = prefs.x, y = prefs.y;
    if (x == null || y == null) { x = vw - PANEL_W - 16; y = 72; }
    x = Math.min(Math.max(0, x), Math.max(0, vw - PANEL_W));
    y = Math.min(Math.max(0, y), Math.max(0, vh - 48));
    el.panel.style.left = `${x}px`;
    el.panel.style.top = `${y}px`;
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
      const r = el.panel.getBoundingClientRect();
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

  function onTick(e) {
    const d = e.detail || {};
    if (!d.snap || !d.show) {
      if (host && !host.hidden && Date.now() - lastTickAt > HIDE_AFTER_MS) host.hidden = true;
      return;
    }
    lastTickAt = Date.now();
    if (host.hidden) { host.hidden = false; applyPrefs(); }
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
      const perHr = gross != null ? fmtMoney(gross / hours) : '—';
      el.pace.textContent = `${perHr} · ${(sold.length / hours).toFixed(1)} lots`;
    } else el.pace.textContent = '—';
    const lastSold = sold.length ? sold[sold.length - 1] : null;
    el.lastSale.textContent = lastSold ? `${fmtAgo(lastSold.at)} ago` : '—';
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
    // Relative clocks ("last sale 4m ago", history age) drift without a tick.
    clockTimer = setInterval(() => { if (last && host && !host.hidden) scheduleRender(); }, 5000);
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        loadSettings().then(() => {
          if (settings?.liveOverlay === false && host) {
            document.removeEventListener('folia:live-tick', onTick);
            clearInterval(clockTimer);
            host.remove(); host = null;
          }
          if (changes.apiBase || changes.userId || changes.brandId) { buyers = null; buyersErr = null; buyersAt = 0; ensureBuyers(true); }
        });
      });
    } catch { /* not in an extension context */ }
  }

  boot().catch(() => { /* never take the dashboard down */ });
})();
