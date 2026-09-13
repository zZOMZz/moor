// Run with the dependency's stock Electron after pnpm build. A packaged Moor
// executable selects its own package.main and does not run a script argument.
// Uses the packaged renderer, real IPC,
// private device storage and synthetic identity responses. No real accounts,
// projects, external service or Agent are used. Progress follows DOM signals.
const { app, BrowserWindow, session, protocol, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
// Optional operator-selected packaged Resources/app directory; this fixture
// still creates a fresh temporary profile and never opens that app's user data.
const desktopRoot = process.env.MOOR_TEST_DESKTOP_APP
  ? path.resolve(process.env.MOOR_TEST_DESKTOP_APP)
  : path.join(root, 'src/desktop');
const runtimeRoot = process.env.MOOR_TEST_DESKTOP_APP
  ? path.join(desktopRoot, 'runtime')
  : path.join(root, 'dist');
const { CLIENT_SCHEME, CLIENT_PRIVILEGES, CLIENT_URL, CLIENT_ORIGIN } = require(
  path.join(desktopRoot, 'client-assets.cjs'),
);
const { prepareClientSession, createClientWindow } = require(
  path.join(desktopRoot, 'client-window.cjs'),
);
const { DesktopSecureBridge } = require(path.join(desktopRoot, 'secure-client.cjs'));
const { DesktopSecureAccount } = require(path.join(desktopRoot, 'secure-account.cjs'));

const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moor-secure-desktop-')));
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([{ scheme: CLIENT_SCHEME, privileges: CLIENT_PRIVILEGES }]);
app.on('window-all-closed', () => {});
const origin = 'https://synthetic-desktop.example.test',
  owner = 'synthetic-owner';
const privateRoot = path.join(profile, 'security');
fs.mkdirSync(privateRoot, { mode: 0o700 });
const hostFile = path.join(privateRoot, 'host.json'),
  recoveryCodeFile = path.join(privateRoot, 'recovery.json');
const endpointPath = path.join(privateRoot, 'client.json');
function security(input) {
  const result = spawnSync(
    process.execPath,
    [path.join(runtimeRoot, 'security.mjs'), '--data-file', hostFile],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      input: JSON.stringify(input),
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, 'synthetic security command must succeed');
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  return value.data;
}

app
  .whenReady()
  .then(async () => {
    const registry = new Map(),
      requests = [],
      errors = [];
    let window,
      connects = 0;
    const clientSession = session.fromPartition('synthetic-trusted-client');
    const identity = async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert([origin + '/api/me', origin + '/api/logout'].includes(String(url)));
      requests.push([String(url), options.method]);
      const loggedIn = !!options.headers.Cookie;
      return Response.json(
        String(url).endsWith('/api/logout')
          ? { ok: true }
          : {
              owner: loggedIn ? owner : null,
              needsSetup: false,
              localOnly: false,
              actor: loggedIn
                ? { kind: 'relay', authorityId: 'synthetic-authority', accountId: owner }
                : null,
              attentionFeatures: [],
              google: { enabled: false },
            },
      );
    };
    const runtime = await import(pathToFileURL(path.join(runtimeRoot, 'desktop-client.mjs')).href);
    const bridge = new DesktopSecureBridge({
      registry,
      remoteWindow: () => window,
      origin: () => origin,
      endpointPath: () => endpointPath,
      loadRuntime: async () => ({
        DesktopSecureClient: class extends runtime.DesktopSecureClient {
          constructor(options) {
            super({
              ...options,
              socket: () => {
                connects++;
                throw Error('synthetic offline');
              },
            });
          }
        },
        authenticateDesktopAccount: (value) =>
          runtime.authenticateDesktopAccount(value, { request: identity }),
      }),
    });
    const account = new DesktopSecureAccount({
      registry,
      remoteWindow: () => window,
      origin: () => origin,
      fetch: identity,
      onInvalidate: (contents) => bridge.invalidate(contents),
    });
    ipcMain.handle('moor:secure-client', (event, value) => bridge.request(event, value));
    ipcMain.handle('moor:secure-account', (event, value) => account.request(event, value));
    const initialized = security({
      action: 'initialize',
      identity: {
        accountId: owner,
        serverOrigin: origin,
        deviceId: 'synthetic-host',
        roles: ['host'],
      },
      recoveryCodeFile,
    });
    await prepareClientSession(clientSession, path.join(runtimeRoot, 'public'));
    window = createClientWindow({
      BrowserWindow: class extends BrowserWindow {
        constructor(options) {
          super({ ...options, show: false });
        }
      },
      session: clientSession,
      origin,
      preloadPath: path.join(desktopRoot, 'secure-preload.cjs'),
      registry,
      invalidate: (contents) => {
        bridge.invalidate(contents);
        account.invalidate(contents);
      },
    });
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message);
    });
    window.webContents.on('render-process-gone', () => {
      throw Error('synthetic renderer exited');
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = (expression) =>
      js(`new Promise((resolve, reject) => {
    let observer;
    const deadline = setTimeout(() => { observer?.disconnect(); reject(Error('DOM condition not reached: ' + ${JSON.stringify(expression)} + '\\n' + document.body.textContent.slice(0, 1800))); }, 15000);
    const check = () => {
      if (document.querySelector('.startup-failure')) { clearTimeout(deadline); observer?.disconnect(); reject(Error('startup failed')); return true; }
      if (${expression}) { clearTimeout(deadline); observer?.disconnect(); resolve(true); return true; }
      return false;
    };
    if (!check()) { observer = new MutationObserver(check); observer.observe(document.body, {childList:true,subtree:true,attributes:true,characterData:true}); }
  })`);
    const text = (value) => waitFor(`document.body.textContent.includes(${JSON.stringify(value)})`);
    const click = (label) =>
      js(`(() => {
    const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) throw Error('button unavailable');
    button.click();
  })()`);
    const fill = (selector, value) =>
      js(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) throw Error('input unavailable');
    Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', {bubbles:true}));
    input.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
    async function capture(name, width) {
      window.setContentSize(width, 844);
      await js(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      const layout = await js(
        `({width:innerWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth})`,
      );
      assert(
        layout.scroll <= layout.width && layout.body <= layout.width,
        'trusted layout must fit viewport',
      );
      fs.writeFileSync(
        path.join(profile, name + '.png'),
        (await window.webContents.capturePage()).toPNG(),
      );
    }
    try {
      await window.loadURL(CLIENT_URL);
      await text('此中转尚未配置 Google 登录');
      assert.equal(connects, 0);
      assert.equal(
        fs.existsSync(endpointPath),
        false,
        'anonymous startup does not open device storage',
      );
      await capture('anonymous-desktop', 1200);
      await clientSession.cookies.set({
        url: origin,
        name: 'personal',
        value: Buffer.alloc(32, 17).toString('base64url'),
        httpOnly: true,
        sameSite: 'strict',
        secure: true,
        path: '/',
      });
      await window.loadURL(CLIENT_URL);
      await text('尚未配对');
      assert.equal(await js('location.origin'), CLIENT_ORIGIN);
      assert.deepEqual(await js('Object.keys(window.moorSecure).sort()'), [
        'account',
        'request',
        'version',
      ]);
      await fill('.secure-device input', initialized.pin.rootKeyId);
      await click('生成配对请求');
      await text('等待批准');
      const first = await js(`JSON.parse(document.querySelector('.secure-json').value)`);
      await click('续期请求');
      await waitFor(
        `document.querySelector('.secure-json') && JSON.parse(document.querySelector('.secure-json').value).pairingId !== ${JSON.stringify(first.pairingId)}`,
      );
      await click('取消配对');
      await text('配对已取消');
      await window.loadURL(CLIENT_URL);
      await text('配对已取消');
      await fill('.secure-device input', initialized.pin.rootKeyId);
      await click('生成配对请求');
      await text('等待批准');
      await capture('pairing-mobile', 390);
      const pending = await js(
        `({request:JSON.parse(document.querySelector('.secure-json').value), fingerprint:document.querySelector('.secure-code').textContent})`,
      );
      assert.notEqual(pending.request.device.deviceId, first.device.deviceId);
      const approved = security({
        action: 'approve-pairing',
        expectedRevision: initialized.revision,
        request: pending.request,
        expectedFingerprint: pending.fingerprint,
        expectedDeviceKeyId: null,
        recoveryCodeFile,
      });
      await fill('textarea[name=approval]', approved.approval);
      await fill('textarea[name=rootPublicKey]', JSON.stringify(approved.trust.rootPublicKey));
      await fill('textarea[name=signedManifest]', approved.trust.signedManifest);
      await click('核对并接受配对');
      await text('设备已授权');
      assert.equal(connects, 0, 'accepting pairing does not connect or execute');
      await capture('paired-desktop', 1200);
      const locks = await js(`(async () => {
        if (!isSecureContext || !navigator.locks) throw Error('trusted Web Locks unavailable');
        const events = [];
        let enter, release;
        const entered = new Promise(resolve => { enter = resolve; });
        const held = new Promise(resolve => { release = resolve; });
        const first = navigator.locks.request('moor-synthetic-original', async () => {
          events.push('first'); enter(); await held; events.push('released');
        });
        await entered;
        const second = navigator.locks.request('moor-synthetic-original', () => { events.push('second'); });
        const state = await navigator.locks.query();
        if (!state.held.some(value=>value.name==='moor-synthetic-original') ||
            !state.pending.some(value=>value.name==='moor-synthetic-original')) throw Error('lock did not serialize');
        release(); await Promise.all([first, second]); return events;
      })()`);
      assert.deepEqual(locks, ['first', 'released', 'second']);
      assert.equal(
        errors.length,
        0,
        'real packaged renderer must load without errors: ' + errors.join('\n'),
      );
      await click('连接');
      console.log('Explicit connect clicked');
      await text('加密连接');
      await waitFor(
        `[...document.querySelectorAll('button')].some(node=>node.textContent.trim()==='连接' && !node.disabled)`,
      );
      assert.equal(connects, 1, 'explicit connect makes exactly one attempt');
      console.log('Connection failure handled');
      await window.loadURL(CLIENT_URL);
      await text('设备已授权');
      assert.equal(connects, 1, 'reload never reconnects');
      console.log('Reload restored device without reconnecting');
      const databases = await js(
        'indexedDB.databases().then(values=>values.map(value=>value.name))',
      );
      assert(
        !databases.includes('moor-runtime-v1'),
        'trusted startup never opens legacy HTTP storage',
      );
      const denied = await js(`Promise.all([
      fetch('https://synthetic-desktop.example.test/api/me').then(()=>false,()=>true),
      window.moorSecure.request({action:'status', url:'https://arbitrary.invalid'}).then(value=>!value.ok)
    ])`);
      assert.deepEqual(denied, [true, true]);
      const loggedOutPage = new Promise((resolve) =>
        window.webContents.once('did-finish-load', resolve),
      );
      await click('退出账号');
      console.log('Logout clicked');
      await loggedOutPage;
      await text('此中转尚未配置 Google 登录');
      assert.equal((await clientSession.cookies.get({ url: origin, name: 'personal' })).length, 0);
      assert.equal(requests.filter(([, method]) => method === 'POST').length, 1);
      console.log(
        'Trusted Electron: packaged UI, account IPC, pairing/renew/cancel/restart/accept, explicit connect, logout and 390px layout passed.',
      );
      console.log('Synthetic screenshots: ' + profile);
    } finally {
      bridge.close();
      account.close();
      window.destroy();
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
