// Only installed by a development-compiled main process. Rebuild completion is
// a deterministic signal; UI changes never restart the execution host.
function watchHostRuntime({ directory, fs, restart, onError }) {
  const path = require('node:path');
  const revisionFile = path.join(directory, 'host-revision.txt');
  let revision = fs.readFileSync(revisionFile, 'utf8');
  const watcher = fs.watch(directory, (_event, filename) => {
    if (String(filename) !== 'host-revision.txt') return;
    try {
      const next = fs.readFileSync(revisionFile, 'utf8');
      if (!/^[a-f0-9]{64}$/.test(next) || next === revision) return;
      revision = next;
      Promise.resolve(restart()).catch(onError);
    } catch (error) {
      onError(error);
    }
  });
  watcher.on?.('error', onError);
  return watcher;
}
module.exports = { watchHostRuntime };
