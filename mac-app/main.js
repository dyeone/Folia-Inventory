// Electron main process. Owns:
//   - the single browser window (the bridge dashboard)
//   - the Node child process running ../bridge/index.js
//   - the ADB reconnect helper (../bridge/reconnect.sh)
//
// Communication with the renderer goes through ipcMain — see preload.js
// for the surfaced channels. Logs from the bridge subprocess are
// streamed line-by-line to the renderer; renderer doesn't get raw
// access to the child process.

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { BridgeRunner } = require('./bridge-runner.js');

// In dev the bridge lives in the sibling folder; when packaged via
// electron-builder, extraResources copies it into Contents/Resources.
function locateBridgeDir() {
  const packaged = path.join(process.resourcesPath || '', 'bridge');
  if (fs.existsSync(path.join(packaged, 'index.js'))) return packaged;
  return path.resolve(__dirname, '..', 'bridge');
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
  runner?.stop();
});

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
ipcMain.handle('bridge:disconnect-all', async () => {
  runner.disconnectAllAdb();
  return { ok: true };
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
