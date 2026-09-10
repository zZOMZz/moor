// Covers navigation failures before the page's own startup entry can run.
const activeLoads = new WeakMap();
function loadPage(window, url, onFailure, schedule = setTimeout, cancel = clearTimeout) {
  activeLoads.get(window)?.();
  let finished = false;
  const finish = (failed) => {
    if (finished) return;
    finished = true;
    cancel(timer);
    window.removeListener('closed', closed);
    activeLoads.delete(window);
    if (!window.isDestroyed() && failed) {
      window.webContents.stop();
      onFailure();
    }
  };
  const timer = schedule(() => finish(true), 20000);
  const closed = () => finish(false);
  activeLoads.set(window, closed);
  window.once('closed', closed);
  Promise.resolve()
    .then(() => window.loadURL(url))
    .then(
      () => finish(false),
      () => finish(true),
    );
}
function clearLocalShellCache(s, origin, schedule = setTimeout, cancel = clearTimeout) {
  return new Promise((resolve, reject) => {
    const timer = schedule(() => reject(new Error('界面缓存更新超时')), 5000);
    s.clearStorageData({ origin, storages: ['serviceworkers', 'cachestorage'] })
      .then(resolve, reject)
      .finally(() => cancel(timer));
  });
}
module.exports = { loadPage, clearLocalShellCache };
