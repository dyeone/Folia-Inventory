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
  runner = new BridgeRunner({ bridgeDir });

  // Stream every line of bridge stdout/stderr to the renderer. Renderer
  // owns the scrollback buffer + autoscroll.
  runner.on('log', (line) => {
    mainWindow?.webContents.send('bridge:log', line);
  });
  runner.on('state', (state) => {
    mainWindow?.webContents.send('bridge:state', state);
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
ipcMain.handle('app:download-update', async (_e, url) => {
  // The URL is our own API's payload, but openExternal hands whatever it's
  // given to the OS's default scheme handler — so gate it to http(s) before
  // opening, in case the app_settings row ever holds something malformed.
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Invalid download URL' };
  }
  await shell.openExternal(url);
  return { ok: true };
});
