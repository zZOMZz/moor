const bridge = (
  window as unknown as {
    moorDesktop?: { version: number; platform?: string };
  }
).moorDesktop;
if (bridge?.version !== 1) throw Error('桌面启动能力接口不可用。');
if (bridge.platform === 'darwin') document.documentElement.dataset.platform = 'darwin';
document.documentElement.dataset.theme = 'system';
