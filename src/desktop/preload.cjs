const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('personal', {
  health: () => ipcRenderer.invoke('personal:health'),
  recover: () => ipcRenderer.invoke('personal:recover'),
  settings: () => ipcRenderer.invoke('personal:settings'),
  project: () => ipcRenderer.invoke('personal:project'),
  save: (value) => ipcRenderer.invoke('personal:save', value),
  notificationSettings: (value) => ipcRenderer.invoke('personal:notification-settings', value),
  notificationTest: () => ipcRenderer.invoke('personal:notification-test'),
  open: (mode) => ipcRenderer.invoke('personal:open', mode),
});
