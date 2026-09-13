const { contextBridge, ipcRenderer } = require('electron');

// This preload belongs only to the packaged trusted client document. The main
// process still validates every sender/frame and the closed request schema.
contextBridge.exposeInMainWorld('moorSecure', {
  version: 1,
  request: (value) => ipcRenderer.invoke('moor:secure-client', value),
});
contextBridge.exposeInMainWorld('moorDesktop', {
  version: 1,
  googleAuth: {
    begin: (value) => ipcRenderer.invoke('moor:google-auth-begin', value),
    complete: () => ipcRenderer.invoke('moor:google-auth-complete'),
    cancel: () => ipcRenderer.invoke('moor:google-auth-cancel'),
  },
  saveAttachment: (value) => ipcRenderer.invoke('moor:save-attachment', value),
  cancelAttachmentSave: () => ipcRenderer.invoke('moor:cancel-attachment-save'),
});
