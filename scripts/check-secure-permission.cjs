// Run with the dependency's stock Electron after pnpm build. The optional
// MOOR_TEST_DESKTOP_APP points at a packaged Contents/Resources/app directory.
// All accounts, projects, device files and Agent decisions are synthetic.
const { app, BrowserWindow, session, protocol, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '..');
const desktop = process.env.MOOR_TEST_DESKTOP_APP
  ? path.resolve(process.env.MOOR_TEST_DESKTOP_APP)
  : path.join(root, 'src/desktop');
const runtime = process.env.MOOR_TEST_DESKTOP_APP
  ? path.join(desktop, 'runtime')
  : path.join(root, 'dist');
const { CLIENT_SCHEME, CLIENT_PRIVILEGES, CLIENT_URL } = require(
  path.join(desktop, 'client-assets.cjs'),
);
const { prepareClientSession, createClientWindow } = require(
  path.join(desktop, 'client-window.cjs'),
);
const { DesktopSecureBridge } = require(path.join(desktop, 'secure-client.cjs'));
const { DesktopSecureAccount } = require(path.join(desktop, 'secure-account.cjs'));
const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moor-permission-native-')));
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([{ scheme: CLIENT_SCHEME, privileges: CLIENT_PRIVILEGES }]);
app.on('window-all-closed', () => {});

app
  .whenReady()
  .then(async () => {
    const helperPath = path.join(profile, 'host-fixture.mjs');
    await build({
      entryPoints: [path.join(root, 'tests/support/secure-desktop-host.ts')],
      outfile: helperPath,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      banner: {
        js: "import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);",
      },
      bundle: true,
      plugins: [
        {
          name: 'pinned-native-dependencies',
          setup(builder) {
            builder.onResolve({ filter: /^(loro-crdt|ws)$/ }, (args) => ({
              path:
                args.path === 'ws'
                  ? path.join(path.dirname(require.resolve('ws/package.json')), 'wrapper.mjs')
                  : require.resolve(args.path),
              external: true,
            }));
          },
        },
      ],
    });
    const fixture = await (
      await import(pathToFileURL(helperPath).href)
    ).createSecureDesktopHost(profile);
    const registry = new Map(),
      requests = [],
      errors = [];
    let window;
    const bridge = new DesktopSecureBridge({
      registry,
      remoteWindow: () => window,
      origin: () => fixture.origin,
      endpointPath: () => fixture.clientFile,
      loadRuntime: () => import(pathToFileURL(path.join(runtime, 'desktop-client.mjs')).href),
    });
    const account = new DesktopSecureAccount({
      registry,
      remoteWindow: () => window,
      origin: () => fixture.origin,
      onInvalidate: (contents) => bridge.invalidate(contents),
    });
    ipcMain.handle('moor:secure-client', (event, value) => {
      requests.push(structuredClone(value));
      return bridge.request(event, value);
    });
    ipcMain.handle('moor:secure-account', (event, value) => account.request(event, value));
    const clientSession = session.fromPartition('persist:synthetic-secure-permission');
    await prepareClientSession(clientSession, path.join(runtime, 'public'));
    await clientSession.cookies.set({
      url: fixture.origin,
      name: 'personal',
      value: fixture.cookie,
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      path: '/',
    });
    window = createClientWindow({
      BrowserWindow: class extends BrowserWindow {
        constructor(options) {
          super({ ...options, show: false });
        }
      },
      session: clientSession,
      origin: fixture.origin,
      preloadPath: path.join(desktop, 'secure-preload.cjs'),
      registry,
      invalidate: (contents) => {
        bridge.invalidate(contents);
        account.invalidate(contents);
      },
    });
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message);
    });
    const js = (source) => window.webContents.executeJavaScript(source);
    const waitFor = (expression) =>
      js(`new Promise((resolve,reject)=>{
    let observer;
    const deadline=setTimeout(()=>{observer?.disconnect();reject(Error('DOM condition: '+${JSON.stringify(expression)}+'\\n'+document.body.textContent.slice(0,2400)));},15000);
    const check=()=>{if (${expression}) {clearTimeout(deadline);observer?.disconnect();resolve(true);return true;}return false;};
    if (!check()) {observer=new MutationObserver(check);observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});}
  })`);
    const text = (value) => waitFor(`document.body.textContent.includes(${JSON.stringify(value)})`);
    const click = (label) =>
      js(`(()=>{
    const button=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(label)});
    if (!button||button.disabled) throw Error('Unavailable button: '+${JSON.stringify(label)});
    button.click();
  })()`);
    const fill = (selector, value) =>
      js(`(()=>{
    const input=document.querySelector(${JSON.stringify(selector)});
    if (!input) throw Error('Missing input');
    Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
    const select = (label) =>
      js(`(()=>{
    const element=[...document.querySelectorAll('label')].find(node=>node.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector('select');
    const option=element&&[...element.options].find(option=>option.value&&!option.disabled);
    if (!element||element.disabled||!option) throw Error('Missing selection');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,option.value);
    element.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
    const permissionRecord = () =>
      js(`new Promise((resolve,reject)=>{
    const request=indexedDB.open('moor-secure-workspace-v1',1);
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result,tx=db.transaction('state','readonly'),read=tx.objectStore('state').getAll();
      read.onsuccess=()=>resolve(read.result.flatMap(value=>value.operations??[]).find(value=>value.kind==='permission'));
      tx.oncomplete=()=>db.close();tx.onerror=()=>reject(tx.error);};
  })`);
    async function connectProject() {
      await text('设备已授权');
      await click('连接');
      await text('选择并核对主机');
      await select('执行主机');
      await text('已核对执行主机目录');
      await select('项目副本');
      await waitFor(
        `[...document.querySelectorAll('button')].some(button=>button.textContent==='新建会话'&&!button.disabled)`,
      );
    }
    async function openSession() {
      await click('刷新');
      await waitFor(
        `document.querySelector('.secure-sessions button')&&!document.querySelector('.secure-sessions button').disabled`,
      );
      await js(`document.querySelector('.secure-sessions button').click()`);
      await waitFor(`document.querySelector('#secure-prompt')`);
    }
    async function capture(name, width) {
      window.setContentSize(width, 844);
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert(
        await js(
          'document.documentElement.scrollWidth<=innerWidth&&document.body.scrollWidth<=innerWidth',
        ),
      );
      for (const [part, selector] of [
        ['details', '.secure-permission'],
        ['decisions', '.secure-permission-options'],
      ]) {
        await js(
          `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`,
        );
        await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        fs.writeFileSync(
          path.join(profile, name + '-' + part + '.png'),
          (await window.webContents.capturePage()).toPNG(),
        );
      }
    }
    const permissionRequests = () =>
      requests.filter(
        (value) =>
          value.action === 'execute' &&
          value.command.method === 'mutate' &&
          value.command.params.kind === 'permission',
      );
    try {
      await window.loadURL(CLIENT_URL);
      await connectProject();
      await click('新建会话');
      await text('主机已确认原操作');
      await openSession();
      await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_PROMPT_1');
      await click('发送');
      await fixture.waitPermission(1);
      await waitFor(
        `[...document.querySelectorAll('button')].some(button=>button.textContent==='刷新会话'&&!button.disabled)`,
      );
      await click('刷新会话');
      await text('SYNTHETIC_PRIVATE_APPROVAL_1');
      await text('需要你的审批决定');
      assert.equal(permissionRequests().length, 0, 'rendering does not approve');
      await capture('permission-desktop', 1200);
      await capture('permission-mobile', 390);
      fixture.dropNextPermissionReply();
      await click('允许此次合成操作');
      await fixture.waitCompleted(1);
      await text('结果待确认');
      await waitFor(
        `[...document.querySelectorAll('button')].some(button=>button.textContent==='刷新本机记录'&&!button.disabled)`,
      );
      assert.equal(fixture.droppedReplies, 1);
      assert.deepEqual(fixture.outcomes, [{ outcome: { outcome: 'selected', optionId: 'allow' } }]);
      const original = await permissionRecord();
      assert.equal(original.state, 'pending');
      const sent = permissionRequests()[0];
      await window.loadURL(CLIENT_URL);
      await text('设备已授权');
      assert.equal(permissionRequests().length, 1, 'reload does not retry');
      assert.deepEqual(
        await permissionRecord(),
        original,
        'reload preserves original durable record',
      );
      await connectProject();
      await openSession();
      await click('重试原操作');
      await text('主机已确认原操作');
      await waitFor(
        `[...document.querySelectorAll('button')].some(button=>button.textContent==='刷新本机记录'&&!button.disabled)`,
      );
      assert.equal((await permissionRecord()).state, 'accepted');
      assert.equal(permissionRequests().length, 2);
      const retried = permissionRequests()[1];
      assert.deepEqual(retried.command, sent.command);
      assert.deepEqual(retried.target, sent.target);
      assert.equal(
        fixture.outcomes.length,
        1,
        'original retry cannot deliver another Agent decision',
      );
      await click('刷新会话');
      await text('SYNTHETIC_PRIVATE_COMPLETED_1');
      await fill('#secure-prompt', 'SYNTHETIC_PRIVATE_PROMPT_2');
      await click('发送');
      await fixture.waitPermission(2);
      await waitFor(
        `[...document.querySelectorAll('button')].some(button=>button.textContent==='刷新会话'&&!button.disabled)`,
      );
      await click('刷新会话');
      await text('SYNTHETIC_PRIVATE_APPROVAL_2');
      await click('取消审批请求');
      await fixture.waitCompleted(2);
      await text('主机已确认原操作');
      assert.deepEqual(fixture.outcomes[1], { outcome: { outcome: 'cancelled' } });
      assert.equal(fixture.prompts, 2);
      assert.equal(errors.length, 0, errors.join('\n'));
      fixture.assertOpaque();
      console.log(
        'Trusted native approval: actual Relay/Host encryption, durable IndexedDB, dropped reply, reload/manual original retry, explicit cancel and 390px layout passed.',
      );
      console.log('Synthetic screenshots: ' + profile);
    } finally {
      bridge.close();
      account.close();
      window.destroy();
      await fixture.close();
      fs.rmSync(path.join(profile, 'private'), { recursive: true, force: true });
      fs.rmSync(path.join(profile, 'SYNTHETIC_PRIVATE_PROJECT'), { recursive: true, force: true });
      for (const suffix of ['', '-wal', '-shm'])
        fs.rmSync(path.join(profile, 'relay.sqlite' + suffix), { force: true });
      fs.rmSync(helperPath, { force: true });
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
