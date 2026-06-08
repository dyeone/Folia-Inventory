// Secure IPC bridge. The renderer can ONLY call these methods — no
// arbitrary Node access — so a hypothetical XSS in the dashboard
// can't escape into the host. Each window.bridge.* call funnels
// through ipcRenderer.invoke and lands at a matching ipcMain.handle
// in main.js.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  start:        () => ipcRenderer.invoke('bridge:start'),
  stop:         () => ipcRenderer.invoke('bridge:stop'),
  restart:      () => ipcRenderer.invoke('bridge:restart'),
  reconnectPhone: () => ipcRenderer.invoke('bridge:reconnect-phone'),
  getState:     () => ipcRenderer.invoke('bridge:get-state'),
  getConfig:    () => ipcRenderer.invoke('bridge:get-config'),
  saveConfig:   (cfg) => ipcRenderer.invoke('bridge:save-config', cfg),

  onLog:   (cb) => ipcRenderer.on('bridge:log',   (_e, line) => cb(line)),
  onState: (cb) => ipcRenderer.on('bridge:state', (_e, state) => cb(state)),
});

contextBridge.exposeInMainWorld('live', {
  setWatch: (on) => ipcRenderer.invoke('live:set-watch', on),
  getWatch: () => ipcRenderer.invoke('live:get-watch'),
  onUpdate: (cb) => ipcRenderer.on('live:update', (_e, snap) => cb(snap)),
});

contextBridge.exposeInMainWorld('app', {
  openBridgeFolder: () => ipcRenderer.invoke('app:open-bridge-folder'),
  openLogFile:      () => ipcRenderer.invoke('app:open-log-file'),

  getVersion:       () => ipcRenderer.invoke('app:get-version'),
  checkForUpdates:  () => ipcRenderer.invoke('app:check-for-updates'),
  downloadUpdate:   (url) => ipcRenderer.invoke('app:download-update', url),
  installUpdate:    (url) => ipcRenderer.invoke('app:install-update', url),
  onUpdateStatus:   (cb) => ipcRenderer.on('app:update-status', (_e, s) => cb(s)),
  onUpdateProgress: (cb) => ipcRenderer.on('app:update-progress', (_e, p) => cb(p)),
});
