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

contextBridge.exposeInMainWorld('app', {
  openBridgeFolder: () => ipcRenderer.invoke('app:open-bridge-folder'),
  openLogFile:      () => ipcRenderer.invoke('app:open-log-file'),
});
