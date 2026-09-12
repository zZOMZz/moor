const { contextBridge, ipcRenderer } = require('electron');
// A deliberately separate bridge from the privileged local settings page.
contextBridge.exposeInMainWorld('moorDesktop', {
  version: 1,
  saveAttachment: (value) => ipcRenderer.invoke('moor:save-attachment', value),
  cancelAttachmentSave: () => ipcRenderer.invoke('moor:cancel-attachment-save'),
});
