import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { registerDevPerformance } from '../../apps/desktop/src/main/dev-performance.cjs';

function fixture(development = true) {
  const policy = {
    development,
    origin: 'http://127.0.0.1:5173',
    url: 'http://127.0.0.1:5173/',
  };
  let time = 0,
    pid = 42,
    metricCalls = 0,
    pidReads = 0,
    unavailable = false;
  let values: any[] = [
    { pid: 1, type: 'Browser', creationTime: 1, cpu: { percentCPUUsage: 90 }, secret: 'private' },
    { pid: 42, type: 'Tab', creationTime: 2, cpu: { percentCPUUsage: 12.5 }, secret: 'private' },
    { pid: 43, type: 'Tab', creationTime: 3, cpu: { percentCPUUsage: 21.5 } },
  ];
  const frame = { url: policy.url, origin: policy.origin };
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
    getOSProcessId: () => {
      pidReads++;
      return pid;
    },
  };
  const window = { webContents: sender, isDestroyed: () => false };
  let current: typeof window | undefined = window;
  const registered = { window, trustedClient: true, origin: '', clientPolicy: policy };
  const registry = new Map([[sender, registered]]);
  const handlers = new Map<string, (...args: any[]) => any>();
  registerDevPerformance({
    app: {
      getAppMetrics: () => {
        metricCalls++;
        if (unavailable) throw Error('Synthetic OS failure');
        return values;
      },
    },
    ipcMain: { handle: (channel: string, callback: any) => handlers.set(channel, callback) },
    clientPolicy: policy,
    registry,
    currentWindow: () => current,
    now: () => time,
  });
  const event = { sender, senderFrame: frame };
  return {
    handlers,
    event,
    registered,
    registry,
    setCurrent: (value: typeof window | undefined) => (current = value),
    setPid: (value: number) => (pid = value),
    setTime: (value: number) => (time = value),
    setMetrics: (value: any[]) => (values = value),
    setUnavailable: (value: boolean) => (unavailable = value),
    metricCalls: () => metricCalls,
    pidReads: () => pidReads,
    sample: () => handlers.get('moor:dev-performance')!(event),
  };
}

test('production does not register performance IPC; development authorizes the current main frame before sampling', () => {
  assert.equal(fixture(false).handlers.size, 0);
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], ['moor:dev-performance']);
  const sample = f.handlers.get('moor:dev-performance')!;
  for (const args of [[42], [{ pid: 1 }], [undefined]])
    assert.throws(() => sample(f.event, ...args), /开发窗口/);
  assert.throws(() => sample({ sender: {}, senderFrame: f.event.senderFrame }), /开发窗口/);
  assert.throws(() => sample({ ...f.event, senderFrame: { ...f.event.senderFrame } }), /开发窗口/);
  const originalUrl = f.event.senderFrame.url;
  f.event.senderFrame.url += 'other';
  assert.throws(f.sample, /开发窗口/);
  f.event.senderFrame.url = originalUrl;
  f.registered.trustedClient = false;
  assert.throws(f.sample, /开发窗口/);
  f.registered.trustedClient = true;
  f.setCurrent(undefined);
  assert.throws(f.sample, /开发窗口/);
  assert.equal(f.metricCalls(), 0);
  assert.equal(f.pidReads(), 0, 'untrusted calls never choose or inspect a process');
});

test('lazy CPU samples return only the current renderer, prime with null and share a 500ms interval across PIDs', () => {
  const f = fixture();
  assert.deepEqual(f.sample(), { rendererCpuPercent: null });
  f.setTime(499);
  assert.deepEqual(f.sample(), { rendererCpuPercent: null });
  assert.equal(f.metricCalls(), 1);
  f.setTime(500);
  assert.deepEqual(f.sample(), { rendererCpuPercent: 12.5 });
  f.setPid(43);
  assert.deepEqual(f.sample(), { rendererCpuPercent: null }, 'new renderer needs a first sample');
  f.setTime(999);
  assert.deepEqual(f.sample(), { rendererCpuPercent: null });
  assert.equal(f.metricCalls(), 2, 'another PID cannot reset the shared OS interval');
  f.setTime(1000);
  assert.deepEqual(f.sample(), { rendererCpuPercent: 21.5 });
  f.setPid(42);
  assert.deepEqual(f.sample(), { rendererCpuPercent: 12.5 });
  f.setPid(1);
  assert.deepEqual(f.sample(), { rendererCpuPercent: null }, 'non-renderer data is never returned');
  f.setTime(100000);
  assert.equal(f.metricCalls(), 3, 'advancing time without a request does not sample');
});

test('missing, invalid or restarted process metrics stay unavailable until a fresh valid interval', () => {
  const f = fixture();
  f.sample();
  f.setTime(500);
  f.setMetrics([{ pid: 42, type: 'Tab', creationTime: 22, cpu: { percentCPUUsage: 50 } }]);
  assert.deepEqual(f.sample(), { rendererCpuPercent: null }, 'PID reuse starts a new baseline');
  f.setTime(1000);
  assert.deepEqual(f.sample(), { rendererCpuPercent: 50 });
  for (const cpu of [NaN, Infinity, -1, undefined]) {
    f.setTime(
      1500 + [NaN, Infinity, -1, undefined].findIndex((value) => Object.is(value, cpu)) * 500,
    );
    f.setMetrics([{ pid: 42, type: 'Tab', creationTime: 22, cpu: { percentCPUUsage: cpu } }]);
    assert.deepEqual(f.sample(), { rendererCpuPercent: null });
  }
  f.setTime(3500);
  f.setUnavailable(true);
  assert.deepEqual(f.sample(), { rendererCpuPercent: null });
  f.setTime(4000);
  f.setUnavailable(false);
  f.setMetrics([{ pid: 42, type: 'Tab', creationTime: 22, cpu: { percentCPUUsage: 0 } }]);
  assert.deepEqual(f.sample(), { rendererCpuPercent: null }, 'OS failure invalidates the baseline');
  f.setTime(4500);
  assert.deepEqual(f.sample(), { rendererCpuPercent: 0 }, 'a real zero remains a valid sample');
  f.setTime(5000);
  f.setMetrics([]);
  assert.deepEqual(f.sample(), { rendererCpuPercent: null });
  f.setPid(0);
  assert.deepEqual(f.sample(), { rendererCpuPercent: null });
});

test('compiled performance preload exists only in development and exposes one parameterless method', async () => {
  const source = await readFile('apps/desktop/src/preload/workspace-preload.cjs', 'utf8');
  for (const development of [false, true]) {
    const { code } = await transform(source, {
      loader: 'js',
      format: 'cjs',
      minifySyntax: true,
      define: { __MOOR_DESKTOP_DEVELOPMENT__: JSON.stringify(development) },
    });
    const exposed = new Map<string, any>(),
      calls: unknown[][] = [];
    runInNewContext(code, {
      process: { platform: 'darwin' },
      require: () => ({
        contextBridge: {
          exposeInMainWorld: (name: string, value: unknown) => exposed.set(name, value),
        },
        ipcRenderer: {
          invoke: (...args: unknown[]) => {
            calls.push(args);
            return Promise.resolve({ rendererCpuPercent: null });
          },
        },
      }),
    });
    assert.equal(exposed.has('moorDevPerformance'), development);
    if (!development) {
      assert.doesNotMatch(code, /moorDevPerformance|moor:dev-performance/);
      continue;
    }
    const bridge = exposed.get('moorDevPerformance');
    assert.deepEqual(Object.keys(bridge).sort(), ['sample', 'version']);
    assert.equal(bridge.version, 1);
    assert.deepEqual(await bridge.sample({ pid: 1, channel: 'arbitrary' }), {
      rendererCpuPercent: null,
    });
    assert.deepEqual(calls, [['moor:dev-performance']]);
  }
});
