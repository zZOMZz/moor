// Stock Electron only. The entire Chromium profile is disposable synthetic data.
const { app, BrowserWindow, session, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DesktopLegacyCache } = require('../src/desktop/legacy-cache.cjs');

const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moor-legacy-cache-check-')));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => {
  process.stderr.write('Synthetic legacy cache check timed out\n');
  app.exit(1);
}, 20000);

app
  .whenReady()
  .then(async () => {
    const origin = 'http://127.0.0.1:54321';
    const old = session.fromPartition('persist:personal-local');
    const seedWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        session: old,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const records = [
      {
        key: 'local-desktop/local-machine/runtime/session/draft',
        value: 'Synthetic preserved draft',
      },
      {
        key: 'local-desktop/local-machine/runtime/session/pending',
        value: { operationId: 'synthetic-original', unchanged: true },
      },
      { key: 'other-account/local-machine/runtime/session/draft', value: 'Excluded account' },
      ...Array.from({ length: 205 }, (_, i) => ({
        key: 'local-desktop/local-machine/runtime/page-' + String(i).padStart(3, '0') + '/session',
        value: 'Synthetic candidate',
      })),
    ];
    // A worker supplies an old page with an attempted database deletion. The
    // isolated reader disables page JavaScript while its preload can read IDB.
    old.protocol.handle(
      'http',
      (request) =>
        new Response(
          request.url.endsWith('/sw.js')
            ? `self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => e.respondWith(new Response('<!doctype html><script>indexedDB.deleteDatabase("moor-runtime-v1")</script>', { headers: { 'Content-Type': 'text/html' } })));`
            : '<!doctype html><title>Synthetic old Moor page</title>',
          {
            headers: {
              'Content-Type': request.url.endsWith('/sw.js')
                ? 'application/javascript'
                : 'text/html',
            },
          },
        ),
    );
    await seedWindow.loadURL(origin + '/');
    await seedWindow.webContents.executeJavaScript(`(async () => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open('moor-runtime-v1', 1); request.onupgradeneeded = () => request.result.createObjectStore('cache'); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
    await new Promise((resolve, reject) => { const tx = database.transaction('cache', 'readwrite'); for (const record of ${JSON.stringify(records)}) tx.objectStore('cache').put(record.value, record.key); tx.oncomplete = resolve; tx.onerror = reject; });
    database.close();
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true}));
  })()`);
    seedWindow.close();
    old.protocol.unhandle('http');
    const target = {
      serverKey: 'local:machine',
      owner: 'local-desktop',
      deviceId: 'local-machine',
      workspaceId: 'runtime',
      localProjectId: 'project',
      machineId: 'machine',
      userId: 'user',
      catalogWorkspaceId: 'catalog-workspace',
      catalogProjectId: 'catalog-project',
      replicaId: 'replica',
    };
    const registered = {};
    const reader = new DesktopLegacyCache({
      workspace: {
        context: () => ({ registered }),
        current: () => {},
        slot: () => ({
          ready: Promise.resolve({
            request: async () => ({
              ok: true,
              value: {
                source: 'local',
                owner: target.owner,
                connectionId: 'synthetic-connection',
                targets: [{ target }],
              },
            }),
          }),
        }),
      },
      BrowserWindow,
      ipcMain,
      sessionFor: () => old,
      preloadPath: path.resolve(__dirname, '../src/desktop/legacy-cache-preload.cjs'),
      loadRuntime: async () => ({ normalizeLegacyCache: (input) => input.records }),
    });
    const request = { source: 'local', connectionId: 'synthetic-connection', target };
    const listed = await reader.request({}, { ...request, action: 'list' });
    assert.deepEqual(listed, { ok: true, value: { origins: [origin] } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await reader.request(
        {},
        {
          ...request,
          action: 'read',
          origin,
          selection: { kind: 'session', sessionId: 'session' },
        },
      );
      assert.equal(read.ok, true, JSON.stringify(read));
      assert.deepEqual(
        read.value,
        records.slice(0, 2),
        'readonly recovery preserves original values even with an old service worker',
      );
    }
    let cursor;
    const ids = [];
    do {
      const page = await reader.request(
        {},
        { ...request, action: 'index', origin, ...(cursor ? { cursor } : {}) },
      );
      assert.equal(page.ok, true, JSON.stringify(page));
      ids.push(...page.value.sessionIds);
      cursor = page.value.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 206);
    assert.equal(new Set(ids).size, 206);
    reader.close();
    clearTimeout(deadline);
    process.stdout.write(
      'Synthetic Electron recovery passed: real old origin, readonly IDB, scoped repeated read, three index pages, account prefix, old worker script disabled.\n',
    );
    app.exit(0);
  })
  .catch((error) => {
    clearTimeout(deadline);
    process.stderr.write(String(error.stack || error) + '\n');
    app.exit(1);
  });
process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));
