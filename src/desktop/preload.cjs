const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('personal', {
  appearance: (value) => ipcRenderer.invoke('personal:appearance', value),
  onAppearance: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Expected appearance listener');
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('moor:appearance-changed', receive);
    return () => ipcRenderer.removeListener('moor:appearance-changed', receive);
  },
  health: () => ipcRenderer.invoke('personal:health'),
  recover: () => ipcRenderer.invoke('personal:recover'),
  settings: () => ipcRenderer.invoke('personal:settings'),
  deviceMetadata: (value) => ipcRenderer.invoke('personal:device-metadata', value),
  project: () => ipcRenderer.invoke('personal:project'),
  save: (value) => ipcRenderer.invoke('personal:save', value),
  notificationSettings: (value) => ipcRenderer.invoke('personal:notification-settings', value),
  notificationTest: () => ipcRenderer.invoke('personal:notification-test'),
  githubConfig: (value) => ipcRenderer.invoke('personal:github-config', value),
  skillsConfig: (value) => ipcRenderer.invoke('personal:skills-config', value),
  skillsDirectory: () => ipcRenderer.invoke('personal:skills-directory'),
  agentConfig: (value) => ipcRenderer.invoke('personal:agent-config', value),
  agentExecutable: () => ipcRenderer.invoke('personal:agent-executable'),
  openCodexInstall: () => ipcRenderer.invoke('personal:open-codex-install'),
  mcpConfig: (value) => ipcRenderer.invoke('personal:mcp-config', value),
  mcpExecutable: () => ipcRenderer.invoke('personal:mcp-executable'),
  open: (mode) => ipcRenderer.invoke('personal:open', mode),
});
