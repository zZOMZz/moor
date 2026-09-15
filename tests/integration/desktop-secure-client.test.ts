import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import {
  DesktopSecureBridge,
  SECURE_CLIENT_ERROR,
  SECURE_CLIENT_IPC_LIMITS,
} from '../../apps/desktop/src/main/secure-client.cjs';
import { CLIENT_URL, CLIENT_ORIGIN } from '../../apps/desktop/src/main/client-assets.cjs';
import { snapshotSecureInput } from '../../apps/desktop/src/main/secure-input.cjs';

const origin = 'https://relay.synthetic.invalid';
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(t: TestContext) {
  const cookie: any = {
    name: 'personal',
    value: Buffer.alloc(32, 18).toString('base64url'),
    domain: 'relay.synthetic.invalid',
    hostOnly: true,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    session: true,
  };
  const state = {
    origin,
    now: 1800000000000,
    loads: 0,
    creates: 0,
    closes: 0,
    cookies: [cookie],
    load: undefined as ReturnType<typeof gate> | undefined,
    read: undefined as ReturnType<typeof gate> | undefined,
    reply: undefined as ReturnType<typeof gate> | undefined,
    authenticate: undefined as ReturnType<typeof gate> | undefined,
    started: gate(),
    reading: gate(),
    failure: false,
  };
  const authenticated: any[] = [],
    requests: any[] = [];
  const cookies = Object.assign(new EventEmitter(), {
    async get(filter: unknown) {
      assert.deepEqual(filter, { url: origin, name: 'personal' });
      state.reading.release();
      await state.read?.promise;
      return state.cookies;
    },
  });
  const contents = {
    mainFrame: { url: CLIENT_URL, origin: CLIENT_ORIGIN },
    session: { cookies },
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  const window = {
    webContents: contents,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  const registered: any = { window, origin, trustedClient: true };
  const registry = new Map([[contents, registered]]);
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
  const bridge = new DesktopSecureBridge({
    registry,
    remoteWindow: () => window,
    origin: () => state.origin,
    now: () => state.now,
    endpointPath: () => '/synthetic/private/desktop-client.json',
    async loadRuntime() {
      state.loads++;
      await state.load?.promise;
      return {
        async authenticateDesktopAccount(account: any) {
          authenticated.push(account);
          await state.authenticate?.promise;
          account.current();
          return { ...account, owner: 'synthetic-owner' };
        },
        DesktopSecureClient: class {
          constructor(readonly options: any) {
            state.creates++;
            assert.equal(options.endpointPath, '/synthetic/private/desktop-client.json');
          }
          close() {
            state.closes++;
          }
          async request(value: any) {
            requests.push(value);
            const account =
              value.action === 'connect' ? await this.options.authenticate() : undefined;
            state.started.release();
            await state.reply?.promise;
            account?.current();
            if (state.failure) throw new Error('SYNTHETIC_PRIVATE_FAILURE');
            return { ok: true, value: { marker: 'synthetic-result' } };
          }
        },
      };
    },
  });
  t.after(() => bridge.close());
  return {
    state,
    authenticated,
    requests,
    contents,
    window,
    registered,
    registry,
    event,
    bridge,
    cookie,
    cookies,
  };
}

test('only the registered trusted main document can invoke the secure bridge', async (t) => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.registered.trustedClient = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.contents.mainFrame.url = origin + '/remote/';
    },
    (f: ReturnType<typeof fixture>) => {
      f.contents.mainFrame.url = CLIENT_URL + '?secret=1';
    },
    (f: ReturnType<typeof fixture>) => {
      f.contents.mainFrame.origin = 'null';
    },
    (f: ReturnType<typeof fixture>) => {
      f.registered.origin = 'https://other.synthetic.invalid';
    },
    (f: ReturnType<typeof fixture>) => {
      f.window.destroyed = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.contents.destroyed = true;
    },
  ]) {
    const f = fixture(t);
    change(f);
    assert.deepEqual(await f.bridge.request(f.event(), { action: 'status' }), SECURE_CLIENT_ERROR);
    assert.equal(f.state.loads, 0);
  }
  const f = fixture(t);
  assert.deepEqual(
    await f.bridge.request(
      { sender: f.contents, senderFrame: { ...f.contents.mainFrame } },
      { action: 'status' },
    ),
    SECURE_CLIENT_ERROR,
  );
  assert.equal(f.state.loads, 0);
});

test('requests freeze before one shared document-owned runtime loads', async (t) => {
  const f = fixture(t);
  f.state.load = gate();
  const command = { action: 'execute', command: { params: { update: 'synthetic-original' } } };
  const first = f.bridge.request(f.event(), command);
  command.command.params.update = 'synthetic-replaced';
  const second = f.bridge.request(f.event(), { action: 'status' });
  assert.equal(f.state.loads, 1);
  f.state.load.release();
  assert((await first).ok);
  assert((await second).ok);
  assert.equal(f.state.creates, 1);
  assert.equal(f.requests[0].command.params.update, 'synthetic-original');
  assert.equal(f.cookies.listenerCount('changed'), 1);
  f.bridge.close();
  assert.equal(f.cookies.listenerCount('changed'), 0);
  assert.equal(f.state.closes, 1);
});

test('authentication receives only the configured service and private cookie, never IPC output', async (t) => {
  const f = fixture(t);
  const result = await f.bridge.request(f.event(), { action: 'connect' });
  assert.equal(result.ok, true);
  assert.equal(f.authenticated[0].origin, origin);
  assert.equal(f.authenticated[0].cookie, 'personal=' + f.cookie.value);
  assert(!JSON.stringify(result).includes(f.cookie.value));
  assert(!JSON.stringify(result).includes('/synthetic/private'));
});

test('invalid private cookies never reach account authentication', async (t) => {
  for (const patch of [
    { hostOnly: false },
    { domain: '.relay.synthetic.invalid' },
    { path: '/other' },
    { httpOnly: false },
    { sameSite: 'lax' },
    { secure: false },
    { value: 'synthetic-invalid' },
    { session: false, expirationDate: 1 },
  ]) {
    const f = fixture(t);
    Object.assign(f.cookie, patch);
    assert.deepEqual(await f.bridge.request(f.event(), { action: 'connect' }), SECURE_CLIENT_ERROR);
    assert.equal(f.authenticated.length, 0);
  }
  for (const length of [0, 2]) {
    const f = fixture(t);
    f.state.cookies = Array.from({ length }, () => f.cookie);
    assert.deepEqual(await f.bridge.request(f.event(), { action: 'connect' }), SECURE_CLIENT_ERROR);
  }
});

for (const failure of [false, true])
  test(
    'navigation suppresses late ' +
      (failure ? 'errors' : 'successes') +
      ' and releases the old owner',
    async (t) => {
      const f = fixture(t);
      f.state.reply = gate();
      f.state.failure = failure;
      const pending = f.bridge.request(f.event(), { action: 'status' });
      await f.state.started.promise;
      f.bridge.invalidate(f.contents);
      f.state.reply.release();
      assert.deepEqual(await pending, SECURE_CLIENT_ERROR);
      assert.equal(f.state.closes, 1);
      f.state.failure = false;
      assert.equal((await f.bridge.request(f.event(), { action: 'status' })).ok, true);
      assert.equal(f.state.creates, 2);
    },
  );

test('replacing registration, server or frame invalidates even without navigation callbacks', async (t) => {
  for (const replacement of ['registry', 'server', 'frame'] as const) {
    const f = fixture(t);
    f.state.reply = gate();
    const pending = f.bridge.request(f.event(), { action: 'status' });
    await f.state.started.promise;
    if (replacement === 'registry') f.registry.set(f.contents, { ...f.registered });
    else if (replacement === 'server') f.state.origin = 'https://other.synthetic.invalid';
    else f.contents.mainFrame = { ...f.contents.mainFrame };
    f.state.reply.release();
    assert.deepEqual(await pending, SECURE_CLIENT_ERROR);
    assert.equal(f.state.closes, 1);
  }
});

test('logout during private cookie loading prevents authentication', async (t) => {
  const f = fixture(t);
  f.state.read = gate();
  const pending = f.bridge.request(f.event(), { action: 'connect' });
  await f.state.reading.promise;
  f.cookies.emit('changed', {}, f.cookie, 'explicit', true);
  f.state.read.release();
  assert.deepEqual(await pending, SECURE_CLIENT_ERROR);
  assert.equal(f.authenticated.length, 0);
  assert.equal(f.state.closes, 1);
});

test('relevant cookie changes close the channel and preserve unrelated cookies', async (t) => {
  const f = fixture(t);
  f.state.reply = gate();
  const pending = f.bridge.request(f.event(), { action: 'connect' });
  await f.state.started.promise;
  f.cookies.emit('changed', {}, { name: 'other', domain: 'relay.synthetic.invalid' });
  f.cookies.emit('changed', {}, { name: 'personal', domain: 'elsewhere.synthetic.invalid' });
  assert.equal(f.state.closes, 0);
  f.cookies.emit('changed', {}, { ...f.cookie, domain: '.synthetic.invalid' });
  assert.equal(f.state.closes, 1);
  assert.throws(() => f.authenticated[0].current());
  f.state.reply.release();
  assert.deepEqual(await pending, SECURE_CLIENT_ERROR);
});

test('cookie expiry invalidates a long-lived account without depending on a cookie changed event', async (t) => {
  const f = fixture(t);
  f.state.reply = gate();
  Object.assign(f.cookie, { session: false, expirationDate: f.state.now / 1000 + 1 });
  const pending = f.bridge.request(f.event(), { action: 'connect' });
  await f.state.started.promise;
  f.state.now += 1000;
  f.state.reply.release();
  assert.deepEqual(await pending, SECURE_CLIENT_ERROR);
  assert.equal(f.state.closes, 1);
});

test('closing during module loading cannot create a private endpoint owner later', async (t) => {
  const f = fixture(t);
  f.state.load = gate();
  const pending = f.bridge.request(f.event(), { action: 'status' });
  f.bridge.close();
  f.state.load.release();
  assert.deepEqual(await pending, SECURE_CLIENT_ERROR);
  assert.equal(f.state.creates, 0);
  assert.equal(f.cookies.listenerCount('changed'), 0);
});

test('IPC admission rejects excess callers without queueing and releases settled slots', async (t) => {
  const f = fixture(t);
  f.state.reply = gate();
  const pending = Array.from({ length: SECURE_CLIENT_IPC_LIMITS.requests }, () =>
    f.bridge.request(f.event(), { action: 'status' }),
  );
  await f.state.started.promise;
  assert.deepEqual(await f.bridge.request(f.event(), { action: 'status' }), SECURE_CLIENT_ERROR);
  assert.equal(f.requests.length, SECURE_CLIENT_IPC_LIMITS.requests);
  f.state.reply.release();
  assert((await Promise.all(pending)).every((response) => response.ok));
  assert.equal((await f.bridge.request(f.event(), { action: 'status' })).ok, true);
});

test('unknown IPC operations cannot become a raw URL, file or socket proxy', async (t) => {
  const f = fixture(t);
  for (const value of [
    null,
    [],
    { action: 'fetch', url: origin },
    { action: 'socket' },
    { action: 'open', path: '/synthetic/private' },
  ])
    assert.deepEqual(await f.bridge.request(f.event(), value), SECURE_CLIENT_ERROR);
  assert.equal(f.state.loads, 0);
});

test('non-JSON structured-clone values cannot hide retained bytes behind JSON accounting', async (t) => {
  const f = fixture(t);
  for (const extra of [
    new ArrayBuffer(4 * 1024 * 1024),
    new Uint8Array(4096),
    new Map([['payload', new ArrayBuffer(4096)]]),
    new Set(['synthetic']),
    new Date(0),
    1n,
    undefined,
  ]) {
    assert.deepEqual(
      await f.bridge.request(f.event(), { action: 'status', extra }),
      SECURE_CLIENT_ERROR,
    );
    assert.equal(f.bridge.bytes, 0);
  }
  assert.equal(f.state.loads, 0);
});

test('bounded JSON snapshots own parameters, count escaped UTF-8 and keep keys inert', () => {
  const original = JSON.parse(
    '{"__proto__":{"synthetic":true},"params":{"array":[null,false,12,"汉字\\n\\"😀"]}}',
  );
  const bytes = Buffer.byteLength(JSON.stringify(original));
  const result = snapshotSecureInput(original, bytes);
  assert.equal(result.bytes, bytes);
  assert.deepEqual(result.value, original);
  original.params.array[0] = 'changed';
  assert.equal(result.value.params.array[0], null);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal(({} as any).synthetic, undefined);
  assert.throws(() => snapshotSecureInput(result.value, bytes - 1));
  const shared = { text: 'synthetic' };
  assert.deepEqual(snapshotSecureInput([shared, shared], 100).value, [shared, shared]);
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
    assert.throws(() => snapshotSecureInput(value, 48 * 1024 * 1024));
  assert.equal(invoked, false);
});

test('the trusted preload exposes finite application entry points', async () => {
  const exposed = new Map<string, any>(),
    calls: unknown[] = [],
    listeners = new Map<string, (...args: unknown[]) => void>();
  runInNewContext(await readFile('apps/desktop/src/preload/secure-preload.cjs', 'utf8'), {
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
  assert.deepEqual(Object.keys(exposed.get('moorSecure')).sort(), [
    'account',
    'request',
    'version',
  ]);
  await exposed.get('moorSecure').request({ action: 'status' });
  await exposed.get('moorSecure').account({ action: 'status' });
  assert.deepEqual(Object.keys(exposed.get('moorWorkspace')).sort(), [
    'addProject',
    'context',
    'onChange',
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
  assert.deepEqual(calls, [
    ['moor:secure-client', { action: 'status' }],
    ['moor:secure-account', { action: 'status' }],
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
