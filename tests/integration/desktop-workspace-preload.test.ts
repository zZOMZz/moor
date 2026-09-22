import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { snapshotJsonInput } from '../../apps/desktop/src/main/json-input.cjs';
test('bounded JSON snapshots own parameters, count escaped UTF-8 and keep keys inert', () => {
  const original = JSON.parse(
    '{"__proto__":{"synthetic":true},"params":{"array":[null,false,12,"汉字\\n\\"😀"]}}',
  );
  const bytes = Buffer.byteLength(JSON.stringify(original));
  const result = snapshotJsonInput(original, bytes);
  assert.equal(result.bytes, bytes);
  assert.deepEqual(result.value, original);
  original.params.array[0] = 'changed';
  assert.equal(result.value.params.array[0], null);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal(({} as any).synthetic, undefined);
  assert.throws(() => snapshotJsonInput(result.value, bytes - 1));
  const shared = { text: 'synthetic' };
  assert.deepEqual(snapshotJsonInput([shared, shared], 100).value, [shared, shared]);
});

test('accessors, cycles, sparse arrays and excessive structure fail without executing hooks', () => {
  let invoked = false;
  const accessor = Object.defineProperty({}, 'data', {
    enumerable: true,
    get() {
      invoked = true;
      return 'private';
    },
  });
  const hook = {
    toJSON() {
      invoked = true;
      return {};
    },
  };
  const cycle: any = {};
  cycle.value = cycle;
  let deep: any = null;
  for (let i = 0; i < 66; i++) deep = { child: deep };
  for (const value of [
    accessor,
    hook,
    cycle,
    new Array(2),
    new Array(100001).fill(null),
    deep,
    NaN,
    Infinity,
  ])
    assert.throws(() => snapshotJsonInput(value, 48 * 1024 * 1024));
  assert.equal(invoked, false);
});

test('the trusted preload exposes finite application entry points', async () => {
  const exposed = new Map<string, any>(),
    calls: unknown[] = [],
    listeners = new Map<string, (...args: unknown[]) => void>();
  runInNewContext(await readFile('apps/desktop/src/preload/workspace-preload.cjs', 'utf8'), {
    process: { platform: 'darwin' },
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value),
        },
        ipcRenderer: {
          on: (channel: string, callback: (...args: unknown[]) => void) =>
            listeners.set(channel, callback),
          removeListener: (channel: string, callback: (...args: unknown[]) => void) => {
            if (listeners.get(channel) === callback) listeners.delete(channel);
          },
          invoke: (...args: unknown[]) => {
            calls.push(args);
            return Promise.resolve();
          },
        },
      };
    },
  });
  assert.equal(exposed.has('moorSecure'), false);
  await exposed.get('moorWorkspace').account({ action: 'status' });
  assert.deepEqual(Object.keys(exposed.get('moorWorkspace')).sort(), [
    'account',
    'addProject',
    'context',
    'exportRetiredData',
    'onChange',
    'onSync',
    'request',
    'version',
  ]);
  await exposed.get('moorWorkspace').request({ action: 'catalog', source: 'local' });
  await exposed.get('moorDesktop').openSettings();
  await exposed.get('moorWorkspace').context();
  await exposed
    .get('moorWorkspace')
    .addProject({ path: '/untrusted-renderer-path', source: 'remote' });
  let signals = 0;
  const unsubscribe = exposed.get('moorWorkspace').onChange((...args: unknown[]) => {
    assert.deepEqual(args, []);
    signals++;
  });
  listeners.get('moor:workspace-changed')!({ sender: 'private Electron event' });
  assert.equal(signals, 1);
  unsubscribe();
  assert.equal(listeners.size, 0);
  const notice = { source: 'local', kind: 'changed', sessionId: 'synthetic-session' };
  let received: unknown;
  const stopSync = exposed.get('moorWorkspace').onSync((value: unknown) => {
    received = value;
  });
  listeners.get('moor:workspace-sync')!({ sender: 'private Electron event' }, notice);
  assert.deepEqual(received, notice);
  stopSync();
  assert.equal(listeners.size, 0);
  assert.deepEqual(calls, [
    ['moor:account', { action: 'status' }],
    ['moor:workspace-client', { action: 'catalog', source: 'local' }],
    ['moor:open-settings'],
    ['moor:workspace-context'],
    ['moor:add-project'],
  ]);
  assert.deepEqual(Object.keys(exposed.get('moorDesktop')).sort(), [
    'appearance',
    'cancelAttachmentSave',
    'googleAuth',
    'onAppearance',
    'openSettings',
    'platform',
    'saveAttachment',
    'version',
  ]);
});
