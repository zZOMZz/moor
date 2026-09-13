const { app, BrowserWindow, session, protocol, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '../..');
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
const { createAttachmentSaver } = require(path.join(desktop, 'attachment-save.cjs'));

module.exports = function runSecureNative(options, scenario) {
  const profile = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'moor-' + options.name + '-native-')),
  );
  console.log('Synthetic native profile: ' + profile);
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
      ).createSecureDesktopHost(profile, {
        richContent: options.richContent === true,
        extensions: options.extensions === true,
        integrations: options.integrations
          ? {
              electronPath: process.env.MOOR_TEST_DESKTOP_APP
                ? path.resolve(desktop, '../../MacOS/Electron')
                : process.execPath,
              workerPath: path.join(runtime, 'preview-renderer.cjs'),
            }
          : undefined,
      });
      const registry = new Map(),
        requests = [],
        errors = [],
        savedFiles = [];
      let window;
      const downloads = path.join(profile, 'synthetic-downloads');
      fs.mkdirSync(downloads, { mode: 0o700 });
      const saver = createAttachmentSaver({
        registry,
        downloads: () => downloads,
        showSaveDialog: async (_window, options) => {
          assert.equal(path.dirname(options.defaultPath), downloads);
          savedFiles.push(options.defaultPath);
          return { canceled: false, filePath: options.defaultPath };
        },
      });
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
      ipcMain.handle('moor:save-attachment', (event, value) => saver.save(event, value));
      ipcMain.handle('moor:cancel-attachment-save', (event) => saver.cancel(event));
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
          saver.invalidate(contents);
        },
      });
      window.webContents.on('console-message', (event) => {
        if (event.level === 'error') errors.push(event.message);
      });
      const js = async (source) => {
        try {
          return await window.webContents.executeJavaScript(source);
        } catch (error) {
          const body = await window.webContents
            .executeJavaScript('document.body.textContent')
            .catch(() => 'Unavailable document');
          throw Error(
            String(error) +
              '\nSynthetic renderer check: ' +
              source.slice(0, 1800) +
              '\n' +
              String(body).slice(0, 9000) +
              '\n' +
              errors.join('\n'),
          );
        }
      };
      const waitFor = (expression) =>
        js(`new Promise((resolve,reject)=>{
    let observer;
    const deadline=setTimeout(()=>{observer?.disconnect();reject(Error('DOM condition: '+${JSON.stringify(expression)}+'\\n'+document.body.textContent.slice(0,2400)));},15000);
    const check=()=>{if (${expression}) {clearTimeout(deadline);observer?.disconnect();resolve(true);return true;}return false;};
    if (!check()) {observer=new MutationObserver(check);observer.observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true});}
  })`);
      const text = (value) =>
        waitFor(`document.body.textContent.includes(${JSON.stringify(value)})`);
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
      const permissionRecord = (kind = 'permission', operationId) =>
        js(`new Promise((resolve,reject)=>{
    const request=indexedDB.open('moor-secure-workspace-v1',1);
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result,tx=db.transaction('state','readonly'),read=tx.objectStore('state').getAll();
      read.onsuccess=()=>resolve(read.result.flatMap(value=>value.operations??[]).find(value=>value.kind===${JSON.stringify(kind)}&&(${JSON.stringify(operationId)}===undefined||value.operationId===${JSON.stringify(operationId)})));
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
          await js(
            'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
          );
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
        await scenario({
          fixture,
          profile,
          registry,
          requests,
          errors,
          window,
          clientSession,
          js,
          waitFor,
          text,
          click,
          fill,
          select,
          permissionRecord,
          connectProject,
          openSession,
          capture,
          permissionRequests,
          savedFiles,
          CLIENT_URL,
        });
      } finally {
        bridge.close();
        account.close();
        window.destroy();
        await fixture.close();
        fs.rmSync(path.join(profile, 'private'), { recursive: true, force: true });
        fs.rmSync(path.join(profile, 'SYNTHETIC_PRIVATE_PROJECT'), {
          recursive: true,
          force: true,
        });
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
};
