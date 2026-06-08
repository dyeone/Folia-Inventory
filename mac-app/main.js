// Electron main process. Owns:
//   - the single browser window (the bridge dashboard)
//   - the Node child process running bridge/index.js
//   - the ADB reconnect helper (bridge/reconnect.sh)
//
// Communication with the renderer goes through ipcMain — see preload.js
// for the surfaced channels. Logs from the bridge subprocess are
// streamed line-by-line to the renderer; renderer doesn't get raw
// access to the child process.

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { BridgeRunner } = require('./bridge-runner.js');
const { checkForUpdate } = require('./updater.js');
const { downloadAndInstall } = require('./installer.js');

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 560,
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
  });
  // Live-monitor snapshots (Watch live panel). Best-effort screen scrape of the
  // Palmstreet live; the renderer derives a sold feed by diffing snapshots.
  runner.on('live', (snap) => {
    mainWindow?.webContents.send('live:update', snap);
  });

  createWindow();

  updateTimer = setInterval(async () => {
    const result = await runUpdateCheck();
    if (result.status === 'update-available') {
      mainWindow?.webContents.send('app:update-status', result);
    }
  }, UPDATE_POLL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Standard macOS behavior would keep the app alive, but a bridge
  // running with no UI is invisible and confusing — quit fully on
  // window close so the bridge process also dies. Operator can re-open
  // anytime.
  app.quit();
});

app.on('before-quit', () => {
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
