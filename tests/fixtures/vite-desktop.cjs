const { app, BrowserWindow, ipcMain, protocol, session } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
const { CLIENT_SCHEME, CLIENT_PRIVILEGES } = require(
  path.join(root, 'apps/desktop/src/main/client-assets.cjs'),
);
const { PACKAGED_CLIENT, developmentClientPolicy, clientDocumentMatches } = require(
  path.join(root, 'apps/desktop/src/main/client-policy.cjs'),
);
const { createClientWindow, prepareClientSession } = require(
  path.join(root, 'apps/desktop/src/main/client-window.cjs'),
);
app.setPath('userData', process.env.MOOR_TEST_VITE_PROFILE);
protocol.registerSchemesAsPrivileged([{ scheme: CLIENT_SCHEME, privileges: CLIENT_PRIVILEGES }]);
app.on('window-all-closed', () => {});
const development = process.env.MOOR_TEST_VITE_MODE === 'development';
const policy =
  developmentClientPolicy({
    enabled: development,
    isPackaged: false,
    rendererUrl: process.env.MOOR_TEST_VITE_URL,
    token: process.env.MOOR_TEST_VITE_TOKEN,
  }) ?? PACKAGED_CLIENT;

app.whenReady().then(async () => {
  let window;
  try {
    const registry = new Map();
    const clientSession = session.fromPartition('synthetic-vite-client');
    await prepareClientSession(
      clientSession,
      path.join(root, 'dist/desktop/runtime/public'),
      policy,
    );
    class HiddenWindow extends BrowserWindow {
      constructor(options) {
        super({ ...options, show: false });
      }
    }
    window = createClientWindow({
      BrowserWindow: HiddenWindow,
      session: clientSession,
      origin: '',
      preloadPath: path.join(root, 'dist/desktop/preload/secure-preload.cjs'),
      registry,
      invalidate() {},
      clientPolicy: policy,
    });
    const contents = window.webContents;
    let loads = 0,
      contextReads = 0;
    const errors = [],
      operations = [];
    contents.on('did-finish-load', () => {
      loads++;
    });
    contents.on('preload-error', (_event, _path, error) => errors.push(String(error)));
    contents.on('console-message', (event) => {
      if (event.level === 'error') {
        errors.push(event.message);
        if (!event.message.includes('synthetic-untrusted.invalid'))
          console.error('[synthetic renderer]', event.message);
      }
    });
    clientSession.webRequest.onCompleted((details) => {
      if (details.statusCode >= 400)
        console.error('[synthetic resource]', details.statusCode, details.url);
    });
    function trusted(event) {
      assert.equal(event.sender, contents);
      assert.equal(event.senderFrame, contents.mainFrame);
      assert(clientDocumentMatches(registry.get(contents), event.senderFrame));
    }
    ipcMain.handle('moor:workspace-context', (event) => {
      trusted(event);
      contextReads++;
      return { localReady: false, view: 'local', notification: null, revision: 0 };
    });
    ipcMain.handle('moor:appearance', (event) => {
      trusted(event);
      return { appearance: 'system' };
    });
    ipcMain.handle('moor:secure-account', (event) => {
      trusted(event);
      return {
        ok: true,
        value: { origin: '', owner: null, needsSetup: false, google: { enabled: false } },
      };
    });
    for (const name of ['moor:workspace-client', 'moor:secure-client'])
      ipcMain.handle(name, (event, value) => {
        trusted(event);
        operations.push(value);
        return { ok: false, error: { message: 'Synthetic offline host' } };
      });
    const js = (code) => contents.executeJavaScript(code);
    const waitFor = (condition) =>
      js(`new Promise((resolve, reject) => {
      const check = () => { if (${condition}) { observer.disconnect(); clearTimeout(timeout); resolve(true); } };
      const observer = new MutationObserver(check);
      const timeout = setTimeout(() => { observer.disconnect(); reject(Error('DOM signal timed out: ' + document.body.innerText)); }, 30000);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); check();
    })`);
    await window.loadURL(policy.url);
    await waitFor(
      `document.body.innerText.includes('添加项目') && !document.querySelector('#startup-status')`,
    );
    assert.equal(await js('typeof window.moorWorkspace.request'), 'function');
    assert.equal(await js('typeof window.require'), 'undefined');
    if (development) {
      const probeUrl = '/@fs' + process.env.MOOR_TEST_VITE_MOUNT;
      await js(`(async () => {
        const { mount } = await import(${JSON.stringify(probeUrl)}); mount();
      })()`);
      await waitFor(`document.querySelector('#refresh-probe')?.textContent === 'before:0'`);
      await js("document.querySelector('#refresh-probe').click()");
      await waitFor(`document.querySelector('#refresh-probe')?.textContent === 'before:1'`);
      const reads = contextReads,
        count = loads;
      process.send('update-component');
      await waitFor(`document.querySelector('#refresh-probe')?.textContent === 'after:1'`);
      process.send('update-css');
      await waitFor(
        `getComputedStyle(document.querySelector('#refresh-probe')).color === 'rgb(4, 5, 6)'`,
      );
      assert.equal(loads, count, 'React and CSS updates must not reload the document');
      assert.equal(contextReads, reads, 'HMR must not restart the workspace controller');
      assert.equal(operations.length, 0, 'HMR must not send an operation');
      console.log('PASS: Vite React/CSS HMR preserves state, document, controller and finite IPC.');
    } else {
      const wasm = fs
        .readdirSync(path.join(root, 'dist/desktop/runtime/public/assets'))
        .filter((file) => file.endsWith('.wasm'));
      for (const file of wasm)
        await js(
          `WebAssembly.compileStreaming(fetch('/assets/' + ${JSON.stringify(file)})).then(() => true)`,
        );
      assert.equal(loads, 1);
      console.log('PASS: production custom protocol, compiled sandboxed preload and offline WASM.');
    }
    assert.deepEqual(errors, [], 'renderer must have no preload/CSP/runtime errors');
    const denied = await js(
      "fetch('https://synthetic-untrusted.invalid/').then(() => false, () => true)",
    );
    assert(denied, 'arbitrary renderer networking must remain blocked');
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    window?.destroy();
    app.exit(1);
  }
});
