// Renderer — talks to the main process via window.bridge / window.app
// (set up in preload.js). Pure DOM, no framework, ~100 lines.

const $ = (id) => document.getElementById(id);

const els = {
  statePill:     $('state-pill'),
  bridge:        $('status-bridge'),
  phone:         $('status-phone'),
  queue:         $('status-queue'),
  error:         $('status-error'),
  btnStart:      $('btn-start'),
  btnStop:       $('btn-stop'),
  btnRestart:    $('btn-restart'),
  btnReconnect:  $('btn-reconnect'),
  cfgView:       $('cfg-view'),
  cfgEdit:       $('cfg-edit'),
  btnEditCfg:    $('btn-edit-cfg'),
  cfgUrl:        $('cfg-url'),
  cfgToken:      $('cfg-token'),
  cfgDevice:     $('cfg-device'),
  inUrl:         $('in-url'),
  inToken:       $('in-token'),
  btnSaveCfg:    $('btn-save-cfg'),
  btnCancelCfg:  $('btn-cancel-cfg'),
  log:           $('log'),
  btnOpenLog:    $('btn-open-log'),
  btnClearLog:   $('btn-clear-log'),
  chkAutoscroll: $('chk-autoscroll'),
  versionLabel:  $('version-label'),
  btnCheckUpdate: $('btn-check-update'),
  updateBanner:  $('update-banner'),
  updateTitle:   $('update-title'),
  updateNotes:   $('update-notes'),
  updateProgress:    $('update-progress'),
  updateProgressBar: $('update-progress-bar'),
  updateStatusLine:  $('update-status-line'),
  btnInstallUpdate:  $('btn-install-update'),
  btnDownloadUpdate: $('btn-download-update'),
  btnDismissUpdate:  $('btn-dismiss-update'),
  liveStatus:    $('live-status'),
  btnWatchToggle: $('btn-watch-toggle'),
  liveEmpty:     $('live-empty'),
  liveBody:      $('live-body'),
  liveCurrent:   $('live-current'),
  liveCount:     $('live-count'),
  liveTop:       $('live-top'),
  liveUpdated:   $('live-updated'),
  liveListings:  $('live-listings'),
  liveFeed:      $('live-feed'),
  liveRaw:       $('live-raw'),
  selRole:       $('sel-role'),
  btnSaveRole:   $('btn-save-role'),
  roleResult:    $('role-result'),
  printersStatus: $('printers-status'),
  printersResult: $('printers-result'),
  btnRefreshPrinters: $('btn-refresh-printers'),
  selLabel:      $('sel-label'),
  selSlip:       $('sel-slip'),
  selDocument:   $('sel-document'),
  btnTestLabel:  $('btn-test-label'),
  btnTestSlip:   $('btn-test-slip'),
  btnTestDocument: $('btn-test-document'),
  btnSavePrinters: $('btn-save-printers'),
};

// ── State rendering ──────────────────────────────────────────────────
function maskToken(t) {
  if (!t) return '—';
  if (t.length < 12) return '••••';
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function applyState(s) {
  els.bridge.textContent = s.running ? 'running' : 'stopped';
  els.phone.textContent  = s.phoneConnected ? (s.phoneTarget || 'connected') : 'disconnected';
  els.queue.textContent  = String(s.queued ?? 0);
  els.error.textContent  = s.lastError || 'none';
  els.btnStart.disabled  = !!s.running;
  els.btnStop.disabled   = !s.running;
  els.btnRestart.disabled = false;

  els.statePill.className = 'pill ' + (
    s.lastError ? 'pill-red' :
    (s.running && s.phoneConnected) ? 'pill-emerald' :
    'pill-gray'
  );
  els.statePill.textContent =
    s.lastError ? 'error' :
    (s.running && s.phoneConnected) ? 'live' :
    s.running ? 'starting' : 'idle';
}

function applyConfig(cfg) {
  // Tolerate both keys for one rev — the very first mac-app build wrote
  // BRIDGE_URL into bridge/.env, but the bridge subprocess looks for
  // FOLIA_API_URL. Prefer the canonical name; fall back if a stale
  // .env from that build is still on disk.
  els.cfgUrl.textContent    = cfg.FOLIA_API_URL || cfg.BRIDGE_URL || '—';
  els.cfgToken.textContent  = maskToken(cfg.BRIDGE_TOKEN);
  els.cfgDevice.textContent = cfg.BRIDGE_DEVICE || '(auto)';
}

// ── Log buffer ───────────────────────────────────────────────────────
const MAX_LINES = 1000;
function appendLog(line) {
  els.log.textContent += line + '\n';
  // Trim from the top if we exceed the cap — keeps DOM cheap.
  if (els.log.textContent.length > 200_000) {
    const lines = els.log.textContent.split('\n');
    els.log.textContent = lines.slice(-MAX_LINES).join('\n');
  }
  if (els.chkAutoscroll.checked) {
    els.log.scrollTop = els.log.scrollHeight;
  }
}

// ── Wire it up ───────────────────────────────────────────────────────
window.bridge.onState(applyState);
window.bridge.onLog(appendLog);

els.btnStart.addEventListener('click',     () => window.bridge.start());
els.btnStop.addEventListener('click',      () => window.bridge.stop());
els.btnRestart.addEventListener('click',   () => window.bridge.restart());
els.btnReconnect.addEventListener('click', async () => {
  els.btnReconnect.disabled = true;
  try { await window.bridge.reconnectPhone(); }
  finally { els.btnReconnect.disabled = false; }
});

els.btnEditCfg.addEventListener('click', async () => {
  const cfg = await window.bridge.getConfig();
  els.inUrl.value   = cfg.FOLIA_API_URL || cfg.BRIDGE_URL || '';
  els.inToken.value = cfg.BRIDGE_TOKEN  || '';
  els.cfgView.classList.add('hidden');
  els.cfgEdit.classList.remove('hidden');
});
els.btnCancelCfg.addEventListener('click', () => {
  els.cfgView.classList.remove('hidden');
  els.cfgEdit.classList.add('hidden');
});
els.btnSaveCfg.addEventListener('click', async () => {
  // Merge with the existing .env so other keys (BRIDGE_DEVICE,
  // U2_URL, POLL_MS) survive a save. Also explicitly null out the
  // legacy BRIDGE_URL key so old-build .env files don't sit alongside
  // the new FOLIA_API_URL forever.
  const existing = await window.bridge.getConfig();
  const cfg = await window.bridge.saveConfig({
    ...existing,
    FOLIA_API_URL: els.inUrl.value.trim(),
    BRIDGE_TOKEN:  els.inToken.value.trim(),
    BRIDGE_URL:    '',
  });
  applyConfig(cfg);
  els.cfgView.classList.remove('hidden');
  els.cfgEdit.classList.add('hidden');
});

els.btnClearLog.addEventListener('click', () => { els.log.textContent = ''; });
els.btnOpenLog.addEventListener('click',  () => window.app.openLogFile());

// ── Printers ─────────────────────────────────────────────────────────
// Map each label role to a local CUPS printer. The bridge subprocess reads
// LABEL_PRINTER / SLIP_PRINTER / DOCUMENT_PRINTER from its env at startup, so a
// change here applies on the bridge's next (re)start. Build options with the
// DOM (not string HTML) so a printer name can never inject markup, and keep a
// saved-but-currently-undetected printer visible so a brief unplug doesn't
// silently wipe the choice.
function fillSelect(sel, printers, saved) {
  sel.innerHTML = '';
  const seen = new Set();
  const add = (val, label) => {
    if (seen.has(val)) return;
    seen.add(val);
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    sel.appendChild(o);
  };
  add('', '(system default)');
  for (const p of printers) add(p, p);
  if (saved && !seen.has(saved)) add(saved, `${saved} (not detected)`);
  sel.value = saved || '';
}

async function refreshPrinters() {
  els.printersStatus.textContent = 'Detecting printers…';
  const [list, cfg] = await Promise.all([window.printers.list(), window.bridge.getConfig()]);
  const printers = list.printers || [];
  els.selRole.value = (cfg.BRIDGE_ROLE || '').toLowerCase();
  fillSelect(els.selLabel,    printers, cfg.LABEL_PRINTER || '');
  fillSelect(els.selSlip,     printers, cfg.SLIP_PRINTER || '');
  fillSelect(els.selDocument, printers, cfg.DOCUMENT_PRINTER || '');
  els.printersStatus.textContent = list.error
    ? `Couldn’t detect printers: ${list.error}`
    : `${printers.length} printer${printers.length === 1 ? '' : 's'} detected` +
      (list.default ? ` · system default: ${list.default}` : '');
}

async function testPrinter(sel, btn) {
  els.printersResult.textContent = 'Sending test page…';
  btn.disabled = true;
  try {
    const res = await window.printers.test(sel.value);
    els.printersResult.textContent = res.ok
      ? `Test page sent to ${sel.value || '(system default)'}${res.detail ? ` — ${res.detail}` : ''}.`
      : `Test failed: ${res.error}`;
  } finally {
    btn.disabled = false;
  }
}

els.btnSaveRole.addEventListener('click', async () => {
  els.btnSaveRole.disabled = true;
  try {
    // Merge so URL/token/printers survive. Empty role ('Everything') clears the
    // key (writeEnv drops empties) → the bridge claims all jobs.
    const existing = await window.bridge.getConfig();
    await window.bridge.saveConfig({ ...existing, BRIDGE_ROLE: els.selRole.value });
    els.roleResult.textContent = 'Saved. Restart the bridge to apply.';
  } finally {
    els.btnSaveRole.disabled = false;
  }
});

els.btnRefreshPrinters.addEventListener('click', refreshPrinters);
els.btnTestLabel.addEventListener('click',    () => testPrinter(els.selLabel, els.btnTestLabel));
els.btnTestSlip.addEventListener('click',     () => testPrinter(els.selSlip, els.btnTestSlip));
els.btnTestDocument.addEventListener('click', () => testPrinter(els.selDocument, els.btnTestDocument));
els.btnSavePrinters.addEventListener('click', async () => {
  els.btnSavePrinters.disabled = true;
  try {
    // Merge with the existing .env so URL/token/device survive the save.
    // An empty value ('(system default)') clears that role — writeEnv drops
    // empty keys, so the bridge falls back to the system default.
    const existing = await window.bridge.getConfig();
    await window.bridge.saveConfig({
      ...existing,
      LABEL_PRINTER:    els.selLabel.value,
      SLIP_PRINTER:     els.selSlip.value,
      DOCUMENT_PRINTER: els.selDocument.value,
    });
    els.printersResult.textContent = 'Saved. Restart the bridge to apply the change.';
  } finally {
    els.btnSavePrinters.disabled = false;
  }
});

// ── Watch live (prototype) ───────────────────────────────────────────
// The bridge scrapes the Palmstreet live screen while watching is on and
// streams snapshots here. We render the current snapshot and derive a rough
// "recently closed" feed by noticing items that left the screen. Exact
// numbers reconcile from the Palmstreet sales export, not this.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

let watching = false;
let prevLabels = new Set();
const closedFeed = [];                 // {label, price, buyer?, confirmed?, at}
const lastPriceByLabel = new Map();
// Sold toasts persist on screen across several 1.5s snapshots — dedupe by
// the verbatim node text so each toast lands in the feed once.
const seenSold = new Set();

function applyWatch(on) {
  watching = !!on;
  els.liveStatus.className = 'pill ' + (on ? 'pill-emerald' : 'pill-gray');
  els.liveStatus.textContent = on ? 'watching' : 'off';
  els.btnWatchToggle.textContent = on ? 'Stop watching' : 'Start watching';
  if (!on) {
    els.liveBody.classList.add('hidden');
    els.liveEmpty.classList.remove('hidden');
    els.liveEmpty.textContent =
      'Turn on watching during a Palmstreet live to see items and prices as they go.';
  }
}

function renderLive(snap) {
  if (!snap || !watching) return;
  if (!snap.live) {
    els.liveBody.classList.add('hidden');
    els.liveEmpty.classList.remove('hidden');
    els.liveEmpty.textContent = snap.error
      ? `Watching… phone unreachable (${snap.error})`
      : 'Watching… waiting for a live (open Palmstreet and go live).';
    return;
  }
  els.liveEmpty.classList.add('hidden');
  els.liveBody.classList.remove('hidden');

  const listings = snap.listings || [];
  els.liveCurrent.textContent = snap.current || '—';
  els.liveCount.textContent = String(listings.length);
  const top = listings.reduce((m, l) => Math.max(m, Number(l.price) || 0), 0);
  els.liveTop.textContent = top > 0 ? `$${top}` : '—';
  els.liveUpdated.textContent = new Date(snap.at || Date.now()).toLocaleTimeString();

  const tb = els.liveListings.querySelector('tbody');
  tb.innerHTML = listings.map(l =>
    `<tr><td>${esc(l.label || '—')}</td><td class="num">${l.price != null ? '$' + esc(l.price) : '—'}</td><td class="num">${l.bids != null ? '+' + esc(l.bids) : ''}</td><td class="num">${esc(l.timer || '')}</td></tr>`
  ).join('');
  for (const l of listings) if (l.label) lastPriceByLabel.set(l.label, l.price);

  // Confirmed sales first: the bridge parsed an actual sold/winner toast,
  // possibly with the buyer's handle.
  for (const s of (snap.sold || [])) {
    if (!s.raw || seenSold.has(s.raw)) continue;
    seenSold.add(s.raw);
    closedFeed.unshift({
      label: s.label || s.raw, buyer: s.buyer, price: s.price,
      confirmed: true, at: Date.now(),
    });
    // The toast names the item — don't double-report it when its listing
    // card leaves the screen a beat later.
    if (s.label) prevLabels.delete(s.label);
  }
  if (seenSold.size > 400) {
    for (const k of seenSold) { seenSold.delete(k); if (seenSold.size <= 200) break; }
  }

  // Rough sold feed: a label present a moment ago and gone now = likely closed.
  const cur = new Set(listings.map(l => l.label).filter(Boolean));
  for (const lbl of prevLabels) {
    if (!cur.has(lbl)) closedFeed.unshift({ label: lbl, price: lastPriceByLabel.get(lbl), at: Date.now() });
  }
  prevLabels = cur;
  if (closedFeed.length > 30) closedFeed.length = 30;
  els.liveFeed.innerHTML = closedFeed.length
    ? closedFeed.map(c =>
        `<div>${new Date(c.at).toLocaleTimeString()} · ${c.confirmed ? '✓ ' : ''}${esc(c.label)}${c.buyer ? ' → @' + esc(c.buyer) : ''} · ${c.price != null ? '$' + esc(c.price) : '—'}</div>`
      ).join('')
    : 'nothing yet';

  els.liveRaw.textContent = (snap.raw || []).join('\n');
}

els.btnWatchToggle.addEventListener('click', async () => {
  els.btnWatchToggle.disabled = true;
  try {
    const res = await window.live.setWatch(!watching);
    applyWatch(res?.watching);
  } finally {
    els.btnWatchToggle.disabled = false;
  }
});
window.live.onUpdate(renderLive);

// ── Updates ──────────────────────────────────────────────────────────
// The app is unsigned, so Squirrel can't silent-update it — but "Update &
// restart" does the manual drag for the operator: download the DMG with a
// progress bar, swap it over the running bundle, relaunch. "Download
// manually" is the always-there fallback (opens the DMG). baseVersionLabel
// keeps the plain "vX.Y.Z" the header shows at rest.
let baseVersionLabel = '';
let pendingUpdateUrl = null;
let installing = false;

function setProgress({ percent = null, indeterminate = false } = {}) {
  els.updateProgress.classList.remove('hidden');
  els.updateProgress.classList.toggle('indeterminate', indeterminate);
  if (!indeterminate) els.updateProgressBar.style.width = `${percent ?? 0}%`;
}
function setStatusLine(text, { error = false } = {}) {
  els.updateStatusLine.textContent = text || '';
  els.updateStatusLine.classList.toggle('hidden', !text);
  els.updateStatusLine.classList.toggle('is-error', error);
}

function applyUpdate(result, { manual = false } = {}) {
  if (installing) return;   // don't let a background re-check disturb an install in flight
  if (result?.status === 'update-available') {
    pendingUpdateUrl = result.url || null;
    els.updateTitle.textContent = `Update available — v${result.latest}`;
    els.updateNotes.textContent = result.notes || '';
    els.updateNotes.classList.toggle('hidden', !result.notes);
    // No URL means the published row is missing its download link — show
    // the banner so the operator knows, but the buttons can't do anything.
    els.btnInstallUpdate.disabled  = !pendingUpdateUrl;
    els.btnDownloadUpdate.disabled = !pendingUpdateUrl;
    els.updateBanner.classList.remove('hidden');
  } else {
    els.updateBanner.classList.add('hidden');
  }

  // A manual check deserves explicit feedback in the header; the silent
  // auto-check stays quiet unless there's actually an update.
  if (manual) {
    els.versionLabel.textContent =
      result?.status === 'up-to-date'        ? `${baseVersionLabel} · up to date` :
      result?.status === 'update-available'  ? baseVersionLabel :
      result?.status === 'error'             ? `${baseVersionLabel} · check failed` :
      result?.status === 'unknown'           ? `${baseVersionLabel} · no build published` :
      baseVersionLabel;
  }
}

async function checkForUpdates({ manual = false } = {}) {
  if (manual) {
    els.btnCheckUpdate.disabled = true;
    els.btnCheckUpdate.textContent = 'Checking…';
  }
  try {
    applyUpdate(await window.app.checkForUpdates(), { manual });
  } finally {
    if (manual) {
      els.btnCheckUpdate.disabled = false;
      els.btnCheckUpdate.textContent = 'Check for updates';
    }
  }
}

// Live progress from the main process during a one-click install.
window.app.onUpdateProgress((p) => {
  if (p.phase === 'downloading') {
    setProgress(p.percent == null ? { indeterminate: true } : { percent: p.percent });
    setStatusLine(p.percent == null ? 'Downloading…' : `Downloading… ${p.percent}%`);
  } else if (p.phase === 'installing') {
    setProgress({ indeterminate: true });
    setStatusLine('Installing…');
  } else if (p.phase === 'relaunching') {
    setProgress({ indeterminate: true });
    setStatusLine('Restarting Folia Bridge…');
  } else if (p.phase === 'error') {
    setStatusLine(p.error || 'Update failed', { error: true });
  }
});

els.btnCheckUpdate.addEventListener('click', () => checkForUpdates({ manual: true }));

els.btnInstallUpdate.addEventListener('click', async () => {
  if (!pendingUpdateUrl || installing) return;
  installing = true;
  els.btnInstallUpdate.disabled = true;
  els.btnDownloadUpdate.disabled = true;
  els.btnInstallUpdate.textContent = 'Updating…';
  setStatusLine('Starting…');
  setProgress({ percent: 0 });
  const res = await window.app.installUpdate(pendingUpdateUrl);
  // On success the app relaunches and this window goes away; we only reach
  // here on failure (or the dev fallback that opened the browser).
  installing = false;
  els.btnInstallUpdate.textContent = 'Update & restart';
  els.btnInstallUpdate.disabled = false;
  els.btnDownloadUpdate.disabled = false;
  els.updateProgress.classList.add('hidden');
  if (res && res.ok === false) {
    setStatusLine(
      res.fellBackToManual
        ? 'Couldn’t auto-install — opened the installer. Drag Folia Bridge into Applications, then reopen.'
        : (res.error || 'Update failed'),
      { error: true },
    );
  }
});

els.btnDownloadUpdate.addEventListener('click', () => {
  if (pendingUpdateUrl) window.app.downloadUpdate(pendingUpdateUrl);
});
els.btnDismissUpdate.addEventListener('click', () => {
  if (installing) return;
  els.updateBanner.classList.add('hidden');
});
// Periodic re-checks from the main process (long-idle window).
window.app.onUpdateStatus((result) => applyUpdate(result));

// Initial paint — pull current state + config from main.
(async () => {
  applyState(await window.bridge.getState());
  applyConfig(await window.bridge.getConfig());
  applyWatch((await window.live.getWatch())?.watching);
  refreshPrinters();  // populate the Printers panel; non-blocking
  baseVersionLabel = `v${await window.app.getVersion()}`;
  els.versionLabel.textContent = baseVersionLabel;
  checkForUpdates();  // silent on launch — only the banner speaks up
})();
