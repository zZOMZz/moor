const { contextBridge, ipcRenderer } = require('electron');
// A deliberately separate bridge from the privileged local settings page.
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
