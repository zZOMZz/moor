const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('moorWorkspace', {
  version: 1,
  request: (value) => ipcRenderer.invoke('moor:workspace-client', value),
  context: () => ipcRenderer.invoke('moor:workspace-context'),
  addProject: () => ipcRenderer.invoke('moor:add-project'),
  onChange: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Expected workspace listener');
    const receive = () => listener();
    ipcRenderer.on('moor:workspace-changed', receive);
    return () => ipcRenderer.removeListener('moor:workspace-changed', receive);
  },
});

// This preload belongs only to the packaged trusted client document. The main
// process still validates every sender/frame and the closed request schema.
contextBridge.exposeInMainWorld('moorSecure', {
  version: 1,
  request: (value) => ipcRenderer.invoke('moor:secure-client', value),
  account: (value) => ipcRenderer.invoke('moor:secure-account', value),
});
contextBridge.exposeInMainWorld('moorDesktop', {
  version: 1,
  openSettings: () => ipcRenderer.invoke('moor:open-settings'),
  googleAuth: {
    begin: (value) => ipcRenderer.invoke('moor:google-auth-begin', value),
    complete: () => ipcRenderer.invoke('moor:google-auth-complete'),
    cancel: () => ipcRenderer.invoke('moor:google-auth-cancel'),
  },
  saveAttachment: (value) => ipcRenderer.invoke('moor:save-attachment', value),
  cancelAttachmentSave: () => ipcRenderer.invoke('moor:cancel-attachment-save'),
});
