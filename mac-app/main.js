// Electron main process. Owns:
//   - the single browser window (the bridge dashboard)
//   - the Node child process running bridge/index.js
//   - the ADB reconnect helper (bridge/reconnect.sh)
//
// Communication with the renderer goes through ipcMain — see preload.js
// for the surfaced channels. Logs from the bridge subprocess are
// streamed line-by-line to the renderer; renderer doesn't get raw
// access to the child process.

const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { BridgeRunner } = require('./bridge-runner.js');
const { checkForUpdate } = require('./updater.js');
const { downloadAndInstall } = require('./installer.js');

const execFileP = promisify(execFile);

// CUPS lives at fixed system paths. A GUI-launched Electron app inherits a
// stripped PATH (no /usr/bin guaranteed on PATH lookups for some setups), so
// call the absolute binaries — same reasoning as BridgeRunner._childEnv.
const LPSTAT = '/usr/bin/lpstat';
const LP = '/usr/bin/lp';

// Enumerate local CUPS destinations for the Printers panel. `lpstat -e` lists
// one destination name per line; `lpstat -d` reports the system default.
// Best-effort: any failure returns an empty list with the error so the UI can
// say "couldn't detect printers" instead of hanging.
async function listPrinters() {
  try {
    const [eRes, dRes] = await Promise.all([
      execFileP(LPSTAT, ['-e'], { encoding: 'utf8', timeout: 5000 }),
      execFileP(LPSTAT, ['-d'], { encoding: 'utf8', timeout: 5000 }).catch(() => ({ stdout: '' })),
    ]);
    const printers = eRes.stdout.split('\n').map(s => s.trim()).filter(Boolean);
    const m = (dRes.stdout || '').match(/system default destination:\s*(\S+)/i);
    return { printers, default: m ? m[1] : null };
  } catch (e) {
    return { printers: [], default: null, error: e.message };
  }
}

// Send a one-line test page straight to `lp` so the operator can confirm a
// printer works during setup, without round-tripping through the web app.
// printer === '' targets the system default.
async function testPrinter(printer) {
  const file = path.join(os.tmpdir(), `folia-printer-test-${Date.now()}.txt`);
  const body = [
    'Folia Bridge — printer test',
    new Date().toLocaleString(),
    printer ? `Printer: ${printer}` : 'Printer: (system default)',
    'If you can read this, direct printing works.',
    '',
  ].join('\n');
  try {
    // Inside the try so a tmpdir/write failure returns {ok:false} like every
    // other failure path, rather than rejecting the IPC handler.
    fs.writeFileSync(file, body, 'utf8');
    const args = [];
    if (printer) args.push('-d', printer);
    args.push('-t', 'folia-test', file);
    const { stdout } = await execFileP(LP, args, { encoding: 'utf8', timeout: 15000 });
    return { ok: true, detail: (stdout || '').trim() };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || 'lp failed').trim() };
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

// ─── Status widget: live printer + packing state ────────────────────────────
// Per-role printer state for the dashboard widget. `lpstat -p` reports each
// queue's state (idle / now printing / disabled), `lpstat -o` the queued jobs.
// A disabled queue is what "the printer is wedged" looks like from CUPS —
// that's the red the operator needs to see from across the room.
const PRINTER_ROLES = [
  { role: 'label',    key: 'LABEL_PRINTER',    title: 'Labels' },
  { role: 'shipping', key: 'SHIPPING_PRINTER', title: 'Shipping' },
  { role: 'slip',     key: 'SLIP_PRINTER',     title: 'Slips' },
  { role: 'document', key: 'DOCUMENT_PRINTER', title: 'Docs' },
];

function parseLpstatP(text) {
  // Lines look like:
  //   printer Shipping_label is idle.  enabled since Mon Aug  3 ...
  //   printer Box_labels now printing Box_labels-42.  enabled since ...
  //   printer Star_TSP143 disabled since Mon Aug  3 ... -
  //           Unable to send data to printer.
  // Indented lines are the reason for the queue announced just above.
  const queues = new Map();
  let last = null;
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^printer\s+(\S+)\s+(.*)$/);
    if (m) {
      const state = /now printing/.test(m[2]) ? 'printing'
        : /disabled/.test(m[2]) ? 'paused'
          : 'idle';
      last = { state, reason: null };
      queues.set(m[1], last);
    } else if (/^\s+\S/.test(line) && last && last.state === 'paused' && !last.reason) {
      last.reason = line.trim().replace(/\.$/, '');
    }
  }
  return queues;
}

function parseLpstatO(text) {
  // Job lines start with "<queue>-<jobId>"; count per queue.
  const jobs = new Map();
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^(\S+)-\d+\s/);
    if (m) jobs.set(m[1], (jobs.get(m[1]) || 0) + 1);
  }
  return jobs;
}

async function printerStatus() {
  // Pin the locale: the parsers match CUPS's English phrasing ("is idle",
  // "now printing", "disabled since"), which localizes under a non-C LANG.
  const lpstatOpts = { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } };
  let pOut = '', oOut = '', dOut = '', error = null;
  try {
    const [p, o, d] = await Promise.all([
      execFileP(LPSTAT, ['-p'], lpstatOpts),
      execFileP(LPSTAT, ['-o'], lpstatOpts).catch(() => ({ stdout: '' })),
      execFileP(LPSTAT, ['-d'], lpstatOpts).catch(() => ({ stdout: '' })),
    ]);
    pOut = p.stdout; oOut = o.stdout; dOut = d.stdout;
  } catch (e) {
    // "lpstat: No destinations added." exits non-zero — that's a real state
    // (no printers), not a crash. Anything else surfaces as the error note.
    if (!/no destinations/i.test(e.stderr || e.message || '')) error = (e.stderr || e.message || 'lpstat failed').trim();
  }
  const queues = parseLpstatP(pOut);
  const jobs = parseLpstatO(oOut);
  const dm = (dOut || '').match(/system default destination:\s*(\S+)/i);
  const defaultQueue = dm ? dm[1] : null;

  const cfg = runner?.readEnv() || {};
  const roles = PRINTER_ROLES.map(({ role, key, title }) => {
    const configured = (cfg[key] || '').trim();
    const name = configured || defaultQueue || '';
    if (!name) return { role, title, printer: null, state: 'unset', jobs: 0, reason: null };
    const q = queues.get(name);
    return {
      role,
      title,
      printer: name + (configured ? '' : ' (default)'),
      state: q ? q.state : 'missing',
      jobs: jobs.get(name) || 0,
      reason: q?.reason || null,
    };
  });
  return { roles, default: defaultQueue, error, at: Date.now() };
}

// Packing progress comes from the Folia API's packing-status action, using
// the same base URL + bridge token the bridge subprocess runs on — so the
// widget works even while the bridge itself is stopped.
const PACKING_TIMEOUT_MS = 8000;
async function fetchPackingStatus() {
  const cfg = runner?.readEnv() || {};
  const base = (cfg.FOLIA_API_URL || cfg.BRIDGE_URL || '').replace(/\/+$/, '');
  const token = cfg.BRIDGE_TOKEN || '';
  if (!base || !token) return { error: 'not-configured' };
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);   // local midnight → "shipped today" is the operator's today
  const url = `${base}/api/bridge?action=packing-status&since=${encodeURIComponent(midnight.toISOString())}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PACKING_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    return await resp.json();
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timed out' : (e.message || 'network error') };
  } finally {
    clearTimeout(timer);
  }
}

// Both polls pause while the window is hidden (menu-bar background) — the
// widget can't be seen, so there's nothing to keep fresh. A show re-ticks
// immediately so the operator never stares at stale numbers.
const PRINTER_POLL_MS = 5000;
const PACKING_POLL_MS = 15000;
let printersInFlight = false;
let packingInFlight = false;

function widgetVisible() {
  return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
}
async function tickPrinters() {
  if (!widgetVisible() || printersInFlight) return;
  printersInFlight = true;
  try {
    const st = await printerStatus();
    // Re-check after the await — the window can be torn down mid-lpstat, and
    // a send to a destroyed webContents throws in the main process.
    if (widgetVisible()) mainWindow.webContents.send('printers:status', st);
  } catch { /* window closed mid-tick */ }
  finally { printersInFlight = false; }
}
async function tickPacking() {
  if (!widgetVisible() || packingInFlight) return;
  packingInFlight = true;
  try {
    const st = await fetchPackingStatus();
    if (widgetVisible()) mainWindow.webContents.send('packing:status', st);
  } catch { /* window closed mid-tick */ }
  finally { packingInFlight = false; }
}

// Re-check for a newer build every 6h so an operator who leaves the window
// open for days still learns about a release without restarting. The
// renderer also checks on load and on demand — this just covers the
// long-idle case, and only pushes when there's actually something new.
const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;
let updateTimer = null;

// The bridge ships inside this app: in dev it's the bundled `bridge/`
// subfolder; when packaged, electron-builder's extraResources copies that
// same folder into Contents/Resources/bridge. One source, no separate
// top-level checkout to drift out of sync.
function locateBridgeDir() {
  const packaged = path.join(process.resourcesPath || '', 'bridge');
  if (fs.existsSync(path.join(packaged, 'index.js'))) return packaged;
  return path.resolve(__dirname, 'bridge');
}

let mainWindow = null;
let runner = null;
let tray = null;
let lastState = {};
// Set true only when the operator really wants to quit (tray "Quit" or Cmd-Q),
// so closing the window hides it to the menu bar instead of killing the bridge.
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 700,
    title: 'Folia Bridge',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fafafa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  // Coming back from the menu bar → refresh the status widget right away
  // instead of waiting out a poll interval.
  mainWindow.on('show', () => { tickPrinters(); tickPacking(); });
  // Closing the window keeps the app (and the bridge) alive in the menu bar.
  // The menu bar icon makes the still-running bridge visible — which is why we
  // no longer quit on close (the old "invisible bridge" concern). The Dock icon
  // hides while backgrounded so it behaves like a proper menu bar app; it comes
  // back when the window is reopened.
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });
}

// Show (or recreate) the main window and restore the Dock icon.
function showWindow() {
  if (process.platform === 'darwin') app.dock?.show();
  if (!mainWindow) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

// ─── Menu bar (tray) ────────────────────────────────────────────────────────
function buildTrayMenu(s = {}) {
  const status = s.lastError
    ? `⚠ ${String(s.lastError).slice(0, 40)}`
    : (s.running && s.phoneConnected) ? 'Running · phone connected'
      : s.running ? 'Running'
        : 'Stopped';
  return Menu.buildFromTemplate([
    { label: 'Open Folia Bridge', click: showWindow },
    { type: 'separator' },
    { label: status, enabled: false },
    { label: `Queue: ${s.queued ?? 0}`, enabled: false },
    { type: 'separator' },
    s.running
      ? { label: 'Stop bridge', click: () => { runner?.stop(); } }
      : { label: 'Start bridge', click: () => { runner?.start(); } },
    { label: 'Restart bridge', click: async () => { await runner?.stop(); runner?.start(); } },
    {
      label: 'Check for updates…',
      click: async () => { const r = await runUpdateCheck(); showWindow(); mainWindow?.webContents.send('app:update-status', r); },
    },
    { type: 'separator' },
    { label: 'Quit Folia Bridge', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function updateTray(s = {}) {
  lastState = s;
  if (!tray) return;
  tray.setToolTip(`Folia Bridge — ${s.running ? 'running' : 'stopped'}`);
  tray.setContextMenu(buildTrayMenu(s));
}

function createTray() {
  // Template image → macOS renders it monochrome and auto-inverts for the
  // light/dark menu bar. nativeImage auto-picks iconTemplate@2x.png on retina.
  const icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'iconTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  updateTray(runner?.getState() || {});
}

app.whenReady().then(() => {
  const bridgeDir = locateBridgeDir();
  // Keep the bridge config (URL + token) in userData, NOT in the app bundle —
  // userData persists across app updates, so the operator enters it once and
  // never again. (The in-bundle bridge/.env was wiped by every update.)
  const configPath = path.join(app.getPath('userData'), 'bridge.env');
  runner = new BridgeRunner({ bridgeDir, configPath });

  // Stream every line of bridge stdout/stderr to the renderer. Renderer
  // owns the scrollback buffer + autoscroll.
  runner.on('log', (line) => {
    mainWindow?.webContents.send('bridge:log', line);
  });
  runner.on('state', (state) => {
    mainWindow?.webContents.send('bridge:state', state);
    updateTray(state);
  });
  // Live-monitor snapshots (Watch live panel). Best-effort screen scrape of the
  // Palmstreet live; the renderer derives a sold feed by diffing snapshots.
  runner.on('live', (snap) => {
    mainWindow?.webContents.send('live:update', snap);
  });

  createWindow();
  createTray();

  // Status widget polls — cheap, and self-gated to a visible window.
  setInterval(tickPrinters, PRINTER_POLL_MS);
  setInterval(tickPacking, PACKING_POLL_MS);

  updateTimer = setInterval(async () => {
    const result = await runUpdateCheck();
    if (result.status === 'update-available') {
      mainWindow?.webContents.send('app:update-status', result);
    }
  }, UPDATE_POLL_MS);

  // Dock click (or reopen) → bring the window back.
  app.on('activate', () => { showWindow(); });
});

app.on('window-all-closed', () => {
  // On macOS the app lives in the menu bar — closing the window backgrounds it
  // (bridge keeps running), it does NOT quit. Only a real quit (tray Quit /
  // Cmd-Q sets isQuitting) tears it down. Other platforms keep prior behavior.
  if (isQuitting || process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (updateTimer) clearInterval(updateTimer);
  runner?.stop();
});

// Where the bridge talks to Vercel — same value the update check hits at
// {base}/api/bridge?action=mac-version. Tolerate the legacy BRIDGE_URL key
// (see renderer applyConfig for why both are read).
function currentApiBase() {
  const cfg = runner?.readEnv() || {};
  return cfg.FOLIA_API_URL || cfg.BRIDGE_URL || '';
}

function runUpdateCheck() {
  return checkForUpdate({ apiBase: currentApiBase(), currentVersion: app.getVersion() });
}

// ─── IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('bridge:start', async () => {
  return runner.start();
});
ipcMain.handle('bridge:stop', async () => {
  return runner.stop();
});
ipcMain.handle('bridge:restart', async () => {
  await runner.stop();
  return runner.start();
});
ipcMain.handle('bridge:reconnect-phone', async () => {
  return runner.reconnectPhone();
});
ipcMain.handle('bridge:get-state', () => runner.getState());
ipcMain.handle('live:set-watch', (_e, on) => ({ watching: runner.setWatchLive(!!on) }));
ipcMain.handle('live:get-watch', () => ({ watching: runner.isWatchLive() }));
ipcMain.handle('bridge:get-config', () => runner.readEnv());
ipcMain.handle('bridge:save-config', async (_e, cfg) => {
  runner.writeEnv(cfg);
  return runner.readEnv();
});

// Printers panel: list local CUPS destinations and send a test page. The
// role→printer mapping itself (LABEL_PRINTER/SLIP_PRINTER/DOCUMENT_PRINTER) is
// persisted through the existing bridge:save-config, so the bridge subprocess
// picks it up via _childEnv on its next start.
ipcMain.handle('printers:list', () => listPrinters());
ipcMain.handle('printers:test', (_e, printer) => testPrinter(typeof printer === 'string' ? printer : ''));

// Status widget: one-shot pulls for the renderer's initial paint; the
// steady state arrives via the printers:status / packing:status pushes.
ipcMain.handle('printers:get-status', () => printerStatus());
ipcMain.handle('packing:get-status', () => fetchPackingStatus());

ipcMain.handle('app:open-bridge-folder', async () => {
  await shell.openPath(runner.bridgeDir);
});
ipcMain.handle('app:open-log-file', async () => {
  const file = runner.logFilePath();
  if (!fs.existsSync(file)) {
    dialog.showMessageBox({ message: 'No log file yet — start the bridge first.' });
    return;
  }
  await shell.openPath(file);
});

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:check-for-updates', () => runUpdateCheck());

// Manual fallback: just open the DMG URL in the browser (the old behavior).
// The URL is our own API's payload, but openExternal hands whatever it's
// given to the OS's default scheme handler — so gate it to http(s) first,
// in case the app_settings row ever holds something malformed.
ipcMain.handle('app:download-update', async (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Invalid download URL' };
  }
  await shell.openExternal(url);
  return { ok: true };
});

// The running app bundle (…/Folia Bridge.app), derived from the executable
// path. Only meaningful when packaged.
function currentAppBundle() {
  return path.resolve(app.getPath('exe'), '..', '..', '..');
}

// One-click update: download the DMG with progress, swap it over the
// running bundle, and relaunch. Falls back to opening the DMG for a manual
// drag on any failure, so the operator is never stranded.
ipcMain.handle('app:install-update', async (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Invalid download URL' };
  }
  const send = (p) => mainWindow?.webContents.send('app:update-progress', p);

  // In dev (not a real .app bundle) we can't self-replace — open the DMG.
  if (!app.isPackaged) {
    await shell.openExternal(url);
    return { ok: false, error: 'Running unpackaged — opened the download in your browser instead.' };
  }

  try {
    await downloadAndInstall({ url, targetApp: currentAppBundle(), onProgress: send });
    send({ phase: 'relaunching' });
    await runner?.stop();          // clean bridge shutdown before we restart
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) {
    // Auto-install failed — hand the operator the DMG (if we got it) or the
    // URL so they can drag it over /Applications themselves.
    send({ phase: 'error', error: e.message });
    if (e.dmgPath && fs.existsSync(e.dmgPath)) {
      await shell.openPath(e.dmgPath);   // mounts + shows the drag window
    } else {
      await shell.openExternal(url);
    }
    return { ok: false, error: e.message, fellBackToManual: true };
  }
});
