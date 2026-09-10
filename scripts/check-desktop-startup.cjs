// Run with Electron after pnpm build. Uses isolated storage and synthetic HTTP
// responses only; never starts an execution host or reads real agent accounts.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'moor-startup-check-')));
app.on('window-all-closed', () => {});
app
  .whenReady()
  .then(async () => {
    let broken = false;
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/api/me') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ owner: null, needsSetup: true }));
        return;
      }
      if (broken && pathname === '/app.js') {
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
        file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
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
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      for (const failure of [false, true]) {
        broken = failure;
        const window = new BrowserWindow({
          show: false,
          webPreferences: {
            partition: 'synthetic-' + failure,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        window.webContents.session.setPermissionRequestHandler((_, __, cb) => cb(false));
        window.webContents.session.setPermissionCheckHandler(() => false);
        const started = performance.now();
        await window.loadURL('http://127.0.0.1:' + server.address().port);
        const result = await window.webContents.executeJavaScript(`new Promise(resolve => {
        const check = () => {
          if (document.querySelector('#login')) { resolve('login'); return true; }
          if (document.querySelector('#app h1')?.textContent === 'Moor 暂时无法打开') { resolve('failure'); return true; }
          return false;
        };
        if (!check()) { const observer = new MutationObserver(() => { if (check()) observer.disconnect(); }); observer.observe(document.body, {childList: true, subtree: true}); }
      })`);
        assert.equal(result, failure ? 'failure' : 'login');
        console.log(
          `${failure ? 'Asset failure offers retry' : 'Local login renders'}: ${Math.round(performance.now() - started)} ms`,
        );
        window.destroy();
      }
    } finally {
      server.close();
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
