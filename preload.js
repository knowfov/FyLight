const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('windowControls', {
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  toggleFullscreen: () => ipcRenderer.send('window:toggleFullscreen'),
  isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),
  onFullscreenChange: (callback) => {
    ipcRenderer.on('window:fullscreen-state', (_event, value) => callback(value));
  },
});

contextBridge.exposeInMainWorld('systemAPI', {
  getSystemInfo: () => ipcRenderer.invoke('system:getInfo'),
  getOsInfo: () => ipcRenderer.invoke('system:getOsInfo'),
});

contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (partial) => ipcRenderer.invoke('settings:set', partial),
  getAutoLaunch: () => ipcRenderer.invoke('settings:getAutoLaunch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('settings:setAutoLaunch', enabled),
});

contextBridge.exposeInMainWorld('backgroundAPI', {
  choosePng: () => ipcRenderer.invoke('background:choosePng'),
  clearPng: () => ipcRenderer.invoke('background:clearPng'),
});

contextBridge.exposeInMainWorld('linksAPI', {
  open: (url) => ipcRenderer.send('links:open', url),
});

contextBridge.exposeInMainWorld('tweaksAPI', {
  list: (lang) => ipcRenderer.invoke('tweaks:list', lang),
  getStatus: () => ipcRenderer.invoke('tweaks:getStatus'),
  apply: (items) => ipcRenderer.invoke('tweaks:apply', items),
});

contextBridge.exposeInMainWorld('startupAPI', {
  disableAll: () => ipcRenderer.invoke('startup:disableAll'),
});

contextBridge.exposeInMainWorld('powerAPI', {
  scheduleRestart: (delaySeconds) => ipcRenderer.invoke('system:scheduleRestart', delaySeconds),
  cancelRestart: () => ipcRenderer.invoke('system:cancelRestart'),
});

contextBridge.exposeInMainWorld('appsAPI', {
  list: () => ipcRenderer.invoke('apps:list'),
  install: (id) => ipcRenderer.invoke('apps:install', id),
  onProgress: (callback) => {
    ipcRenderer.on('apps:progress', (_event, value) => callback(value));
  },
});

contextBridge.exposeInMainWorld('buildsAPI', {
  list: () => ipcRenderer.invoke('builds:list'),
  create: (payload) => ipcRenderer.invoke('builds:create', payload),
  delete: (id) => ipcRenderer.invoke('builds:delete', id),
  setPublic: (id, isPublic) => ipcRenderer.invoke('builds:setPublic', id, isPublic),
  incrementViews: (id, isCommunity) => ipcRenderer.invoke('builds:incrementViews', id, isCommunity),
  incrementInstalls: (id, isCommunity) => ipcRenderer.invoke('builds:incrementInstalls', id, isCommunity),
  icons: () => ipcRenderer.invoke('builds:icons'),
  exportCode: (id) => ipcRenderer.invoke('builds:exportCode', id),
  importCode: (code) => ipcRenderer.invoke('builds:importCode', code),
  onImportRequest: (callback) => {
    ipcRenderer.on('builds:importRequest', (_event, code) => callback(code));
  },
});

contextBridge.exposeInMainWorld('gamesAPI', {
  list: () => ipcRenderer.invoke('games:list'),
  optimize: (ids, options) => ipcRenderer.invoke('games:optimize', ids, options),
});

contextBridge.exposeInMainWorld('quickActionsAPI', {
  emptyStandbyList: () => ipcRenderer.invoke('quickActions:emptyStandbyList'),
  restartExplorer: () => ipcRenderer.invoke('quickActions:restartExplorer'),
  diskBenchmark: () => ipcRenderer.invoke('quickActions:diskBenchmark'),
});

contextBridge.exposeInMainWorld('cleanupAPI', {
  run: () => ipcRenderer.invoke('cleanup:run'),
});

contextBridge.exposeInMainWorld('debloatAPI', {
  list: () => ipcRenderer.invoke('debloat:list'),
  remove: (ids) => ipcRenderer.invoke('debloat:remove', ids),
});

contextBridge.exposeInMainWorld('logsAPI', {
  openFolder: () => ipcRenderer.invoke('logs:openFolder'),
});

contextBridge.exposeInMainWorld('installerAPI', {
  onStatus: (callback) => {
    ipcRenderer.on('installer:status', (_event, value) => callback(value));
  },
});

contextBridge.exposeInMainWorld('updaterAPI', {
  check: () => ipcRenderer.invoke('updater:check'),
  downloadAndInstall: () => ipcRenderer.invoke('updater:downloadAndInstall'),
  // Текущий/последний известный статус проверки обновлений - используется
  // рендерером сразу при загрузке, чтобы не пропустить событие 'available',
  // если оно пришло до того, как onStatus успел подписаться.
  getStatus: () => ipcRenderer.invoke('updater:getStatus'),
  onStatus: (callback) => {
    ipcRenderer.on('updater:status', (_event, value) => callback(value));
  },
});
