// Run with Electron after pnpm build. Uses isolated storage and synthetic HTTP
// responses and explicit gates only; never starts a host or reads real accounts.
const { app, BrowserWindow, nativeTheme } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { startupFixture } = require('./startup-fixture.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'moor-startup-check-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
app
  .whenReady()
  .then(async () => {
    const fixture = await startupFixture();
    let scenario;
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      scenario.requests.push(pathname);
      if (req.method !== 'GET') scenario.mutations.push(pathname);
      if (pathname === '/seed') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>Synthetic cache setup</title>');
        return;
      }
      if (scenario.offline) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'synthetic offline' }));
        return;
      }
      if (pathname === '/api/me') {
        scenario.identityRequested.resolve();
        void scenario.identityReleased.promise.then(() => {
          res.setHeader('Content-Type', 'application/json');
          if (scenario.identityOffline) {
            res.writeHead(503);
            res.end(JSON.stringify({ error: 'synthetic identity unavailable' }));
          } else res.end(JSON.stringify({ owner: scenario.owner, needsSetup: true }));
        });
        return;
      }
      if (pathname === '/api/devices' || pathname === '/api/workspaces') {
        res.setHeader('Content-Type', 'application/json');
        const sameOwner = scenario.cached && scenario.owner === fixture.owner;
        res.end(
          JSON.stringify(
            sameOwner ? [pathname === '/api/devices' ? fixture.device : fixture.workspace] : [],
          ),
        );
        if (pathname === '/api/workspaces') scenario.catalogueRead.resolve();
        return;
      }
      if (pathname.startsWith('/api/') && pathname.endsWith('/sessions')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify([fixture.meta]));
        return;
      }
      if (pathname.startsWith('/api/') && pathname.endsWith('/sessions/' + fixture.meta.id)) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            meta: fixture.meta,
            metaBundle: fixture.metaBundle,
            update: fixture.snapshot,
            synced: true,
            online: true,
          }),
        );
        scenario.sessionRead.resolve();
        return;
      }
      if (pathname === '/events') {
        res.writeHead(404);
        res.end();
        return;
      }
      const runtime = /^\/assets\/app-/.test(pathname);
      if (runtime) scenario.runtimeRequested.resolve();
      const deliver = () => {
        if (
          (scenario.failure === 'entry' && /^\/assets\/entry-/.test(pathname)) ||
          (scenario.failure === 'runtime' && runtime)
        ) {
          res.writeHead(503);
          res.end('synthetic asset failure');
          return;
        }
        const root = path.resolve(__dirname, '../dist/public');
        const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(root + path.sep)) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader(
          'Content-Type',
          file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.wasm')
              ? 'application/wasm'
              : file.endsWith('.css')
                ? 'text/css'
                : 'text/html',
        );
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        );
        fs.readFile(file, (error, bytes) => {
          res.statusCode = error ? 404 : 200;
          res.end(error ? 'missing' : bytes);
        });
      };
      if (runtime) void scenario.runtimeReleased.promise.then(deliver);
      else deliver();
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      scenario.connections++;
      sockets.handleUpgrade(req, socket, head, () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      for (const config of [
        { name: 'slow-identity-dark', theme: 'dark', owner: null },
        { name: 'slow-identity-mobile', theme: 'light', owner: null, mobile: true },
        { name: 'slow-runtime', theme: 'dark', owner: 'synthetic-owner' },
        { name: 'failed-entry', theme: 'dark', owner: null, failure: 'entry' },
        { name: 'failed-runtime', theme: 'dark', owner: 'synthetic-owner', failure: 'runtime' },
        { name: 'cached-before-identity', theme: 'dark', owner: fixture.owner, cached: true },
        { name: 'cached-auth-rejected', theme: 'dark', owner: null, cached: true },
        { name: 'cached-account-changed', theme: 'dark', owner: 'different-owner', cached: true },
        {
          name: 'cached-offline',
          theme: 'dark',
          owner: fixture.owner,
          cached: true,
          identityOffline: true,
        },
      ]) {
        scenario = {
          ...config,
          requests: [],
          mutations: [],
          connections: 0,
          catalogueRead: deferred(),
          sessionRead: deferred(),
          identityRequested: deferred(),
          identityReleased: deferred(),
          runtimeRequested: deferred(),
          runtimeReleased: deferred(),
        };
        nativeTheme.themeSource = config.theme;
        const window = new BrowserWindow({
          show: false,
          width: config.mobile ? 390 : 1280,
          height: 844,
          webPreferences: {
            partition: 'synthetic-' + config.name,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        window.webContents.session.setPermissionRequestHandler((_, __, cb) => cb(false));
        window.webContents.session.setPermissionCheckHandler(() => false);
        try {
          if (config.cached) {
            await window.loadURL(origin + '/seed');
            await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
              const request = indexedDB.open('moor-runtime-v1', 1);
              request.onupgradeneeded = () => request.result.createObjectStore('cache');
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const db = request.result;
                const tx = db.transaction('cache', 'readwrite');
                for (const [key, value] of ${JSON.stringify(fixture.records)}) tx.objectStore('cache').put(value, key);
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => reject(tx.error);
              };
            })`);
            scenario.runtimeReleased.resolve();
          }
          await window.loadURL(origin);
          if (!config.failure && !config.cached) {
            await scenario.identityRequested.promise;
            const state = await window.webContents.executeJavaScript(`({
            skeleton: !!document.querySelector('.startup-shell'),
            text: document.querySelector('#startup-status')?.textContent,
            background: getComputedStyle(document.body).backgroundColor,
            gradient: getComputedStyle(document.body, '::before').backgroundImage,
            sidebar: getComputedStyle(document.querySelector('.startup-sidebar')).display
          })`);
            assert.equal(state.skeleton, true);
            assert.equal(state.text, '正在连接工作区…');
            assert.equal(state.gradient, 'none');
            assert.equal(
              state.background,
              config.theme === 'dark' ? 'rgb(25, 25, 25)' : 'rgb(255, 255, 255)',
            );
            assert.equal(state.sidebar === 'none', !!config.mobile);
            fs.writeFileSync(
              path.join(profile, config.name + '.png'),
              (await window.webContents.capturePage()).toPNG(),
            );
          }
          if (config.cached) {
            const cached = await window.webContents.executeJavaScript(`new Promise(resolve => {
              const check = () => {
                if (document.querySelector('.startup-failure')) { resolve(false); return true; }
                if (document.querySelector('#history')?.textContent.includes('Synthetic cached history visible before identity') &&
                    document.querySelector('#draft-state')?.textContent.includes('提交结果待确认')) {
                  resolve({ sendDisabled: document.querySelector('#send').disabled,
                    approvalDisabled: [...document.querySelectorAll('[data-permission]')].every(button => button.disabled),
                    approvalCount: document.querySelectorAll('[data-permission]').length,
                    draft: document.querySelector('#prompt').value });
                  return true;
                }
                return false;
              };
              if (!check()) {
                const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
                observer.observe(document.body, { childList: true, subtree: true, attributes: true });
              }
            })`);
            assert(cached, 'cached startup must initialize the standalone WASM modules');
            assert.equal(cached.sendDisabled, true);
            assert.equal(cached.approvalDisabled, true);
            assert.equal(cached.approvalCount, 2);
            assert.equal(cached.draft, 'Synthetic retained draft');
            assert.deepEqual(
              scenario.requests.filter((request) => request.startsWith('/api/')),
              ['/api/me'],
            );
            assert.equal(
              scenario.connections,
              0,
              'cached owner must not authorize an execution connection',
            );
          }
          scenario.identityReleased.resolve();
          if (config.owner && !config.cached) {
            await scenario.runtimeRequested.promise;
            assert.equal(
              await window.webContents.executeJavaScript(
                "document.querySelector('#startup-status')?.textContent",
              ),
              '正在恢复工作区…',
            );
          }
          scenario.runtimeReleased.resolve();
          const result = await window.webContents.executeJavaScript(`new Promise(resolve => {
          const check = () => {
            if (document.querySelector('#login')) { resolve('login'); return true; }
            if (document.querySelector('.workspace-shell') && ${!config.cached || config.owner !== null}) { resolve('workspace'); return true; }
            if (document.querySelector('#app h1')?.textContent === 'Moor 暂时无法打开') { resolve('failure'); return true; }
            return false;
          };
          if (!check()) {
            const observer = new MutationObserver(() => { if (check()) observer.disconnect(); });
            observer.observe(document.body, { childList: true, subtree: true });
          }
        })`);
          assert.equal(result, config.failure ? 'failure' : config.owner ? 'workspace' : 'login');
          if (!config.owner && !config.cached)
            assert(
              !scenario.requests.some((request) => /^\/assets\/app-/.test(request)),
              'login must not fetch the session runtime',
            );
          if (!config.failure)
            assert.equal(
              scenario.requests.filter((request) => request === '/api/me').length,
              1,
              'startup must reuse the identity request',
            );
          if (config.cached) {
            if (config.owner && !config.identityOffline) await scenario.catalogueRead.promise;
            if (config.owner === fixture.owner && !config.identityOffline)
              await scenario.sessionRead.promise;
            const state = await window.webContents.executeJavaScript(`({
              history: document.querySelector('#history')?.textContent ?? '',
              login: !!document.querySelector('#login'),
            })`);
            if (config.owner !== fixture.owner)
              assert(
                !state.history.includes('Synthetic cached history'),
                'confirmed identity change must remove old-account content',
              );
            assert.equal(state.login, config.owner === null);
            assert.deepEqual(
              scenario.mutations,
              [],
              'restoring or reconnecting must never replay the pending operation',
            );
          }
          console.log(config.name + ': passed');
          if (config.name === 'slow-identity-dark') {
            // Local production pages skip SW registration. Explicitly register
            // it in this isolated fixture to test the packaged offline shell.
            await window.webContents.executeJavaScript(`(async () => {
              await navigator.serviceWorker.register('/sw.js');
              await navigator.serviceWorker.ready;
              if (!navigator.serviceWorker.controller) await new Promise(resolve =>
                navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
            })()`);
            const beforeOffline = scenario.requests.length;
            scenario.offline = true;
            await window.loadURL(origin);
            await window.webContents.executeJavaScript(`new Promise(resolve => {
              if (document.querySelector('#login')) { resolve(); return; }
              const observer = new MutationObserver(() => {
                if (document.querySelector('#login')) { observer.disconnect(); resolve(); }
              });
              observer.observe(document.body, { childList: true, subtree: true });
            })`);
            assert(
              !scenario.requests
                .slice(beforeOffline)
                .some((request) => request.startsWith('/assets/')),
              'offline reload must restore every dynamic chunk from the shell cache',
            );
            assert(
              scenario.requests.slice(beforeOffline).includes('/api/me'),
              'identity must never be served from the shell cache',
            );
            console.log('offline split-bundle reload: passed');
          }
        } finally {
          scenario.identityReleased.resolve();
          scenario.runtimeReleased.resolve();
          window.destroy();
        }
      }
      console.log('Synthetic screenshots: ' + profile);
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.close();
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
