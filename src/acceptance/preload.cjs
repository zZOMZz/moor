const { contextBridge, ipcRenderer } = require('electron');

const commandTypes = new Set(['prepare', 'reset', 'stop', 'accept', 'feedback']);

contextBridge.exposeInMainWorld(
  'moorAcceptance',
  Object.freeze({
    snapshot: () => ipcRenderer.invoke('acceptance:snapshot'),
    command: (command) => {
      if (!command || !commandTypes.has(command.type)) {
        return Promise.reject(new Error('不支持的验收操作'));
      }
      const input = { type: command.type };
      if (command.type === 'prepare') input.sceneId = command.sceneId;
      else input.runId = command.runId;
      if (command.type === 'feedback') input.text = command.text;
      return ipcRenderer.invoke('acceptance:command', input);
    },
    bounds: (bounds) => {
      if (!bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))) {
        return;
      }
      ipcRenderer.send('acceptance:bounds', {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    },
    subscribe: (callback) => {
      if (typeof callback !== 'function') throw new TypeError('状态订阅需要回调函数');
      const listener = (_event, snapshot) => callback(snapshot);
      ipcRenderer.on('acceptance:changed', listener);
      return () => ipcRenderer.removeListener('acceptance:changed', listener);
    },
  }),
);
