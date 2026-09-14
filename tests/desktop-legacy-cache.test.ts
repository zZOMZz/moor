import { legacyReadSelection } from '../src/desktop/legacy-cache-keys.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DesktopLegacyCache, legacyOrigin } from '../src/desktop/legacy-cache.cjs';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const origin = 'http://127.0.0.1:12345',
    ipcMain = new EventEmitter();
  const target = {
    serverKey: 'local:machine',
    owner: 'local-desktop',
    deviceId: 'local-machine',
    userId: 'user',
    machineId: 'machine',
    workspaceId: 'runtime',
    localProjectId: 'project',
    catalogWorkspaceId: 'space',
    catalogProjectId: 'logical-project',
    replicaId: 'replica',
  };
  const loaded = signal(),
    delivered = signal();
  const state = {
    actor: undefined as { kind: string; authorityId: string; accountId: string } | undefined,
    valid: true,
    reads: 0,
    confirmations: 0,
    normalized: 0,
    frame: true,
    names: [
      'http_127.0.0.1_12345.indexeddb.leveldb',
      'https_foreign.invalid_0.indexeddb.leveldb',
      'not-a-database',
    ],
    symlink: '',
    contents: undefined as any,
    window: undefined as any,
    handler: undefined as any,
    gate: undefined as any,
    timeout: undefined as (() => void) | undefined,
    read: undefined as any,
    onRead: undefined as (() => void) | undefined,
    reply: undefined as any,
    normalize: undefined as (() => void) | undefined,
    paths: [] as string[],
  };
  const registered = {},
    slot = {
      ready: Promise.resolve({
        request: async () => {
          state.confirmations++;
          return {
            ok: true,
            value: {
              source: 'local',
              actor: state.actor,
              owner: target.owner,
              connectionId: 'connection',
              targets: [{ target }],
            },
          };
        },
      }),
    };
  const current = () => {
    if (!state.valid) throw Error('Stale synthetic authority');
  };
  const session = {
    getStoragePath: () => '/synthetic/Moor/Partitions/personal-local',
    protocol: {
      handle: (_protocol: string, fn: unknown) => {
        state.handler = fn;
      },
      unhandle: () => {
        state.handler = undefined;
      },
    },
    webRequest: {
      onBeforeRequest: (fn: unknown) => {
        state.gate = fn;
      },
    },
  };
  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      id: 7,
      mainFrame: { url: '', origin },
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: (fn: () => unknown) => assert.deepEqual(fn(), { action: 'deny' }),
      send: (_channel: string, value: unknown) => {
        state.read = value;
        delivered.resolve();
        state.onRead?.();
      },
    });
    constructor(readonly options: any) {
      super();
      state.contents = this.webContents;
      state.window = this;
      assert.equal(options.show, false);
      assert.equal(options.webPreferences.session, session);
      assert.equal(options.webPreferences.sandbox, true);
      assert.equal(options.webPreferences.nodeIntegration, false);
      assert.equal(options.webPreferences.javascript, false);
    }
    isDestroyed() {
      return this.destroyed;
    }
    async loadURL(url: string) {
      this.webContents.mainFrame.url = url;
      loaded.resolve();
      this.webContents.emit('dom-ready');
    }
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const reader = new DesktopLegacyCache({
    workspace: {
      context: () => {
        current();
        if (!state.frame) throw Error('Wrong frame');
        return { registered };
      },
      slot: () => slot,
      current,
    },
    BrowserWindow: Window,
    ipcMain,
    sessionFor: () => session,
    preloadPath: '/packaged/legacy-cache-preload.cjs',
    uuid: () => 'synthetic-nonce',
    schedule: (fn: () => void) => {
      state.timeout = fn;
      return 1;
    },
    cancelTimer: () => {
      state.timeout = undefined;
    },
    fs: {
      realpath: async (path: string) => path,
      lstat: async (path: string) => {
        state.paths.push(path);
        return { isDirectory: () => true, isSymbolicLink: () => path === state.symlink };
      },
      readdir: async () => state.names,
    },
    loadRuntime: async () => ({
      normalizeLegacyCache: (input: any) => {
        state.normalized++;
        state.normalize?.();
        return {
          records: input.records,
          scope: { source: input.source, origin: input.origin, target: input.target },
        };
      },
    }),
  });
  const request = (action = 'read') => ({
    action,
    source: 'local',
    connectionId: 'connection',
    target: structuredClone(target),
    ...(action === 'read' ? { origin } : {}),
  });
  const reply = (
    value: unknown = {
      nonce: 'synthetic-nonce',
      ok: true,
      records: [
        { key: 'local-desktop/local-machine/runtime/session/draft', value: 'Synthetic draft' },
      ],
    },
    frame = state.contents.mainFrame,
  ) =>
    ipcMain.emit('moor:legacy-cache-result', { sender: state.contents, senderFrame: frame }, value);
  return { reader, state, origin, target, session, ipcMain, loaded, delivered, request, reply };
}

test('legacy origins accept only canonical Chromium names and discovery never follows links or unrelated origins', async () => {
  assert.equal(legacyOrigin('http_127.0.0.1_12345.indexeddb.leveldb'), 'http://127.0.0.1:12345');
  assert.equal(legacyOrigin('https_relay.invalid_0.indexeddb.leveldb'), 'https://relay.invalid');
  for (const name of [
    'https_relay.invalid_443.indexeddb.leveldb',
    'http_127.0.0.1_99999.indexeddb.leveldb',
    'file_secret_0.indexeddb.leveldb',
    'http_user@127.0.0.1_1.indexeddb.leveldb',
    '../http_127.0.0.1_1.indexeddb.leveldb',
    'http_127.0.0.1_01.indexeddb.leveldb',
  ])
    assert.equal(legacyOrigin(name), undefined, name);
  const f = fixture();
  assert.deepEqual(await f.reader.request({}, f.request('list')), {
    ok: true,
    value: { origins: [f.origin] },
  });
  assert.equal(f.state.confirmations, 2);
  assert(!f.state.paths.some((path) => path.includes('foreign')));
  assert.equal(f.state.contents, undefined, 'listing does not open a reader');
  f.state.symlink =
    '/synthetic/Moor/Partitions/personal-local/IndexedDB/http_127.0.0.1_12345.indexeddb.leveldb';
  assert.equal((await f.reader.request({}, f.request('list'))).ok, false);
  f.state.frame = false;
  assert.equal((await f.reader.request({}, f.request('list'))).ok, false);
});

test('legacy native reader allows one fixed document, verifies its main frame and nonce, and rechecks account authority', async () => {
  const f = fixture(),
    result = f.reader.request({}, f.request());
  await f.delivered.promise;
  assert.equal(
    (await f.reader.request({}, f.request())).ok,
    false,
    'only one reader can own the old partition',
  );
  const url = f.origin + '/__moor_read_legacy_cache__';
  for (const details of [
    { url: f.origin + '/api/execute', resourceType: 'xhr', webContentsId: 7 },
    { url, resourceType: 'mainFrame', webContentsId: 8 },
    { url, resourceType: 'subFrame', webContentsId: 7 },
  ])
    f.state.gate(details, (value: unknown) => assert.deepEqual(value, { cancel: true }));
  f.state.gate({ url, resourceType: 'mainFrame', webContentsId: 7 }, (value: unknown) =>
    assert.deepEqual(value, { cancel: false }),
  );
  const document = f.state.handler({ url, method: 'GET' });
  assert(document.headers.get('Content-Security-Policy').includes("default-src 'none'"));
  assert.throws(() => f.state.handler({ url, method: 'POST' }));
  assert.deepEqual(f.state.read.prefixes.slice(0, 2), [
    'local-desktop/local-machine/runtime/',
    'attachment-draft-v1/["local-desktop","local-machine","runtime","project",',
  ]);
  assert(
    f.state.read.prefixes.includes(
      'git-workspace-v1/["local-desktop","local-machine","user","machine","runtime","project",',
    ),
  );
  f.reply();
  const done = await result;
  assert.equal(done.ok, true);
  assert.equal(f.state.confirmations, 2);
  assert.equal(f.state.normalized, 1);
  assert.equal(f.ipcMain.listenerCount('moor:legacy-cache-result'), 0);
  assert.equal(f.state.timeout, undefined);
  assert.equal(f.state.handler, undefined);
  assert(f.state.window.destroyed);
  f.state.gate({ url, resourceType: 'mainFrame', webContentsId: 7 }, (value: unknown) =>
    assert.deepEqual(value, { cancel: true }),
  );
});

test('reader failure, deadlines, close and late identity changes preserve old data and clean up native listeners', async () => {
  for (const failure of ['nonce', 'frame', 'deadline', 'close', 'identity', 'late']) {
    const f = fixture(),
      result = f.reader.request({}, f.request());
    await f.delivered.promise;
    if (failure === 'nonce') f.reply({ nonce: 'wrong', ok: true, records: [] });
    if (failure === 'frame') f.reply(undefined, { ...f.state.contents.mainFrame });
    if (failure === 'deadline') f.state.timeout!();
    if (failure === 'close') f.reader.close();
    if (failure === 'identity') {
      f.state.valid = false;
      f.reply();
    }
    if (failure === 'late') {
      f.state.normalize = () => {
        f.state.valid = false;
      };
      f.reply();
    }
    const done = await result;
    assert.equal(done.ok, false, failure);
    assert.equal(f.ipcMain.listenerCount('moor:legacy-cache-result'), 0, failure);
    assert.equal(f.state.timeout, undefined, failure);
    assert(f.state.window.destroyed, failure);
  }
  const f = fixture();
  for (const input of [
    { ...f.request(), origin: 'http://127.0.0.1:9999' },
    { ...f.request(), url: 'https://foreign.invalid' },
    { ...f.request(), target: { ...f.target, owner: 'other' } },
    { ...f.request(), connectionId: 'old' },
  ])
    assert.equal((await f.reader.request({}, input)).ok, false);
  assert.equal(f.state.contents, undefined);
});

async function preload(
  options: {
    exists?: boolean;
    version?: number;
    records?: { key: string; value: unknown }[];
    url?: string;
    request?: Record<string, unknown>;
  } = {},
) {
  const sent: any[] = [],
    calls: any[] = [];
  const bodyReads: string[] = [];
  let listener!: (event: unknown, input: unknown) => Promise<void>;
  const records = options.records ?? [
    { key: 'owner/device/work/session/draft', value: 'Synthetic draft' },
    { key: 'another/device/work/session/draft', value: 'Other account' },
  ];
  const db = {
    version: options.version ?? 1,
    objectStoreNames: { contains: (name: string) => name === 'cache' },
    close: () => calls.push(['close']),
    transaction: (name: string, mode: string) => {
      calls.push(['transaction', name, mode]);
      assert.equal(mode, 'readonly');
      let index = 0;
      const tx: any = {
        abort: () => queueMicrotask(() => tx.onabort()),
        objectStore: () => ({
          get: (key: string) => {
            bodyReads.push(key);
            const request: any = {};
            queueMicrotask(() => {
              request.result = records.find((record) => record.key === key)?.value;
              request.onsuccess?.();
            });
            return request;
          },
          openKeyCursor: () => {
            const cursor: any = {};
            const next = () =>
              queueMicrotask(() => {
                const record = records[index++];
                cursor.result = record ? { key: record.key, continue: next } : null;
                cursor.onsuccess();
                if (!record) queueMicrotask(() => tx.oncomplete());
              });
            next();
            return cursor;
          },
        }),
      };
      return tx;
    },
  };
  runInNewContext(readFileSync('src/desktop/legacy-cache-preload.cjs', 'utf8'), {
    require: (name: string) => {
      assert.equal(name, 'electron');
      return {
        ipcRenderer: {
          once: (channel: string, fn: typeof listener) => {
            assert.equal(channel, 'moor:legacy-cache-read');
            listener = fn;
          },
          send: (channel: string, value: unknown) => {
            assert.equal(channel, 'moor:legacy-cache-result');
            sent.push(structuredClone(value));
          },
        },
      };
    },
    location: { href: options.url ?? 'http://127.0.0.1:12345/__moor_read_legacy_cache__' },
    TextEncoder,
    indexedDB: {
      databases: async () => (options.exists === false ? [] : [{ name: 'moor-runtime-v1' }]),
      open: (...args: unknown[]) => {
        calls.push(['open', ...args]);
        const request: any = { result: db };
        queueMicrotask(() => request.onsuccess());
        return request;
      },
    },
  });
  await listener(
    {},
    {
      nonce: 'synthetic',
      url: 'http://127.0.0.1:12345/__moor_read_legacy_cache__',
      prefixes: ['owner/device/work/'],
      ...options.request,
    },
  );
  return { sent, calls, bodyReads };
}

test('isolated preload reads only existing Moor IDB records with a readonly transaction and no exposed page API', async () => {
  const valid = await preload();
  assert.deepEqual(valid.sent, [
    {
      nonce: 'synthetic',
      ok: true,
      records: [{ key: 'owner/device/work/session/draft', value: 'Synthetic draft' }],
    },
  ]);
  assert.deepEqual(valid.calls, [
    ['open', 'moor-runtime-v1'],
    ['transaction', 'cache', 'readonly'],
    ['close'],
  ]);
  const absent = await preload({ exists: false });
  assert.deepEqual(absent.calls, []);
  assert.deepEqual(absent.sent, [{ nonce: 'synthetic', ok: true, records: [] }]);
  for (const options of [{ version: 2 }, { url: 'http://127.0.0.1:9999/' }]) {
    const invalid = await preload(options);
    assert.deepEqual(invalid.sent, [{ nonce: 'synthetic', ok: false }]);
    assert(!invalid.calls.some((call) => call[0] === 'transaction'));
  }
});

test('legacy native attention prefixes use verified Actor and reject an authority change during reading', async () => {
  const f = fixture();
  f.state.actor = { kind: 'local', authorityId: 'synthetic-authority', accountId: 'local-desktop' };
  const reading = f.reader.request({}, f.request());
  await f.delivered.promise;
  const scope = JSON.stringify([
    'attention-v1',
    f.origin,
    JSON.stringify(['local', 'synthetic-authority', 'local-desktop']),
    'machine',
    'runtime',
    'project',
  ]);
  assert(f.state.read.prefixes.includes(JSON.stringify([scope]).slice(0, -1) + ','));
  f.state.actor = { ...f.state.actor, authorityId: 'replaced-authority' };
  f.reply();
  assert.equal((await reading).ok, false);
});

test('legacy native attention read succeeds when the verified Actor is unchanged', async () => {
  const f = fixture();
  f.state.actor = { kind: 'local', authorityId: 'synthetic-authority', accountId: 'local-desktop' };
  const reading = f.reader.request({}, f.request());
  await f.delivered.promise;
  f.reply();
  assert.equal((await reading).ok, true);
  assert.equal(f.state.confirmations, 2);
});

async function indexRead(f: ReturnType<typeof fixture>, keys: string[], cursor?: unknown) {
  const ready = signal();
  f.state.onRead = ready.resolve;
  const request = f.reader.request(
    {},
    { ...f.request(), action: 'index', ...(cursor ? { cursor } : {}) },
  );
  await ready.promise;
  assert.equal(f.state.read.keysOnly, true);
  f.reply({ nonce: 'synthetic-nonce', ok: true, keys });
  return request;
}

test('native legacy index pages only scoped session ids, binds cursors and rejects changing inventories', async () => {
  const f = fixture();
  const keys = Array.from(
    { length: 205 },
    (_, i) =>
      'local-desktop/local-machine/runtime/session-' + String(i).padStart(3, '0') + '/session',
  );
  keys.push('local-desktop/local-machine/runtime/project/session-001/session-action');
  keys.push('local-desktop/local-machine/runtime/new/draft');
  const first = await indexRead(f, keys);
  assert.equal(first.ok, true);
  assert.equal(first.value.total, 205);
  assert.equal(first.value.sessionIds.length, 100);
  assert.equal(first.value.hasNew, true);
  const second = await indexRead(f, keys, first.value.nextCursor);
  assert.equal(second.ok, true);
  assert.equal(second.value.sessionIds[0], 'session-100');
  const third = await indexRead(f, keys, second.value.nextCursor);
  assert.equal(third.value.sessionIds.length, 5);
  assert.equal(third.value.nextCursor, undefined);
  assert.equal(
    new Set([...first.value.sessionIds, ...second.value.sessionIds, ...third.value.sessionIds])
      .size,
    205,
  );
  assert.equal(f.state.normalized, 0, 'index pages never normalize or return session bodies');
  const changed = await indexRead(
    f,
    [...keys, 'local-desktop/local-machine/runtime/added/session'],
    first.value.nextCursor,
  );
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, 'index-changed');
  const foreign = await indexRead(f, [
    ...keys,
    'another-account/local-machine/runtime/private/session',
  ]);
  assert.equal(foreign.ok, false);
});

test('legacy key enumeration exceeds the old record-count limit without ever reading bodies', async () => {
  const records = Array.from({ length: 10001 }, (_, i) => ({
    key: 'owner/device/work/session-' + i + '/session',
    get value(): unknown {
      throw Error('Inventory must not read bodies');
    },
  }));
  const result = await preload({ records, request: { keysOnly: true } });
  assert.equal(result.sent[0].ok, true);
  assert.equal(result.sent[0].keys.length, 10001);
  assert.deepEqual(result.bodyReads, []);
});

test('scoped legacy reads fetch only the selected record values and resolve new-draft attachment pointers in the same readonly transaction', async () => {
  const selected = 'owner/device/work/selected/draft';
  const result = await preload({
    records: [
      { key: selected, value: 'Selected text' },
      {
        key: 'owner/device/work/other/session',
        get value(): unknown {
          throw Error('Unrelated large body');
        },
      },
    ],
    request: { scoped: true, prefixes: ['owner/device/work/selected/'] },
  });
  assert.equal(result.sent[0].ok, true);
  assert.deepEqual(result.bodyReads, [selected]);
  const reservationKey = 'attachment-session-v1/["owner","device","work","project"]';
  const pendingKey = 'owner/device/work/new/pending';
  const prefix = 'attachment-draft-v1/["owner","device","work","project",';
  const attachmentKey = prefix + '"reserved"]';
  const records = [
    { key: 'owner/device/work/new/draft', value: 'New draft' },
    { key: reservationKey, value: 'reserved' },
    { key: attachmentKey, value: { synthetic: 'preserved attachment' } },
    {
      key: prefix + '"unrelated"]',
      get value(): unknown {
        throw Error('Unrelated attachment');
      },
    },
  ];
  const draft = await preload({
    records,
    request: {
      scoped: true,
      prefixes: ['owner/device/work/new/', reservationKey],
      newDraft: {
        reservationKey,
        pendingKey,
        sessionPrefixes: [prefix],
        actionPrefix: 'owner/device/work/project/',
      },
    },
  });
  assert.equal(draft.sent[0].ok, true);
  assert.deepEqual(draft.sent[0].records, records.slice(0, 3));
  assert(draft.bodyReads.includes(attachmentKey));
  assert.equal(draft.calls.filter((call) => call[0] === 'transaction').length, 1);
});

test('native scoped reading includes old file caches only for the selected project and session', async () => {
  const target = {
    owner: 'owner',
    deviceId: 'device',
    userId: 'user',
    machineId: 'machine',
    workspaceId: 'work',
    localProjectId: 'project',
    catalogWorkspaceId: 'catalog',
    replicaId: 'replica',
  };
  const first =
    'project-content-v1/["owner","device","work","project","selected","tree-last-read"]';
  const second =
    'file-content-v1/["owner","device","work","project","selected","readme.md","sha256:' +
    'a'.repeat(64) +
    '"]';
  const rows = [
    { key: first, value: 'directory version' },
    { key: second, value: 'synthetic file content' },
  ];
  const result = await preload({
    records: [
      ...rows,
      {
        key: first.replace('"project"', '"other-project"'),
        get value(): unknown {
          throw Error('Another project must stay unread');
        },
      },
      {
        key: second.replace('"selected"', '"another-session"'),
        get value(): unknown {
          throw Error('Another session must stay unread');
        },
      },
    ],
    request: {
      ...legacyReadSelection(target, 'http://127.0.0.1:12345', undefined, {
        kind: 'session',
        sessionId: 'selected',
      }),
      scoped: true,
    },
  });
  assert.equal(result.sent[0].ok, true);
  assert.deepEqual(result.sent[0].records, rows);
  assert.deepEqual(result.bodyReads, [first, second]);
});
