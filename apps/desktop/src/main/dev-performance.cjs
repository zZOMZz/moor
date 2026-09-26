const { isCurrentContentDocument } = require('./content-authority.cjs');

// getAppMetrics resets every process's interval, so all callers share one lazy
// snapshot. There is deliberately no polling or timer in the main process.
function registerDevPerformance({
  app,
  ipcMain,
  clientPolicy,
  registry,
  currentWindow,
  now = () => performance.now(),
}) {
  if (clientPolicy.development !== true) return;
  let sampledAt = -Infinity;
  let generation = 0;
  let metrics = new Map();
  const firstSamples = new Map();

  ipcMain.handle('moor:dev-performance', (event, ...args) => {
    const registered = registry.get(event.sender);
    if (
      args.length !== 0 ||
      registered?.trustedClient !== true ||
      registered.clientPolicy !== clientPolicy ||
      registered.window !== currentWindow() ||
      !isCurrentContentDocument(registered, event.sender, event.senderFrame)
    )
      throw Error('性能采样只能从当前 Moor 开发窗口请求。');

    const pid = event.sender.getOSProcessId();
    if (!Number.isSafeInteger(pid) || pid <= 0) return { rendererCpuPercent: null };
    const time = now();
    if (time - sampledAt >= 500) {
      sampledAt = time;
      generation++;
      metrics = new Map();
      try {
        for (const metric of app.getAppMetrics())
          if (metric.type === 'Tab' && Number.isFinite(metric.creationTime))
            metrics.set(metric.pid, {
              creationTime: metric.creationTime,
              cpu: metric.cpu?.percentCPUUsage,
            });
      } catch {
        // A stopped/restarting renderer or unavailable OS metric is not 0% CPU.
      }
      for (const [seenPid, first] of firstSamples)
        if (metrics.get(seenPid)?.creationTime !== first.creationTime) firstSamples.delete(seenPid);
    }
    const metric = metrics.get(pid);
    if (!metric) return { rendererCpuPercent: null };
    let first = firstSamples.get(pid);
    if (!first) {
      first = { creationTime: metric.creationTime, generation };
      firstSamples.set(pid, first);
    }
    return {
      rendererCpuPercent:
        first.generation !== generation && Number.isFinite(metric.cpu) && metric.cpu >= 0
          ? metric.cpu
          : null,
    };
  });
}

module.exports = { registerDevPerformance };
