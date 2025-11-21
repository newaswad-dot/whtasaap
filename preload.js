const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  getQR: () => ipcRenderer.invoke('get-qr'),

  fetchGroups: () => ipcRenderer.invoke('fetch-groups'),
  saveGroups: (ids) => ipcRenderer.invoke('save-groups', ids),
  getSavedGroups: () => ipcRenderer.invoke('get-groups-saved'),

  saveClients: (raw) => ipcRenderer.invoke('save-clients', raw),
  getClients: () => ipcRenderer.invoke('get-clients'),

  setSettings: (s) => ipcRenderer.invoke('set-settings', s),
  getSettings: () => ipcRenderer.invoke('get-settings'),

  saveNameLists: (lists) => ipcRenderer.invoke('save-name-lists', lists),
  getNameLists: () => ipcRenderer.invoke('get-name-lists'),
  getNameListsStats: () => ipcRenderer.invoke('get-name-lists-stats'),

  startBot: () => ipcRenderer.invoke('start-bot'),
  stopBot: () => ipcRenderer.invoke('stop-bot'),

  getLastChecked: () => ipcRenderer.invoke('get-last-checked'),
  checkBacklog:   (opts) => ipcRenderer.invoke('check-backlog', opts),

  onLog: (cb) => ipcRenderer.on('bot-log', (_e, line) => cb(line)),

  // ===== Bulk (إرسال جماعي) =====
  bulkStart:   (opts) => ipcRenderer.invoke('bulk-start', opts),
  bulkPause:   () => ipcRenderer.invoke('bulk-pause'),
  bulkResume:  () => ipcRenderer.invoke('bulk-resume'),
  bulkCancel:  () => ipcRenderer.invoke('bulk-cancel'),
  bulkStatus:  () => ipcRenderer.invoke('bulk-status'),
  bulkSaveDraft:   (d) => ipcRenderer.invoke('bulk-save-draft', d),
  bulkLoadDraft:   () => ipcRenderer.invoke('bulk-load-draft'),
  bulkSaveSettings:(s) => ipcRenderer.invoke('bulk-save-settings', s),
  bulkLoadSettings:() => ipcRenderer.invoke('bulk-load-settings'),
});