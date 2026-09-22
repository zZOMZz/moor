// Isolated real Chromium layout check. Synthetic in-memory UI only, no login or Agent.
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'moor-layout-profile-'));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'moor-layout-output-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
let server;
app
  .whenReady()
  .then(async () => {
    const { build } = await import('esbuild');
    const { browserWasm } = await import('../build/browser-wasm.mjs');
    const { workspaceSources } = await import('../build/workspace-sources.mjs');
    const { buildWebStyles } = await import('../../apps/web/scripts/build-styles.mjs');
    const plugins = [workspaceSources, browserWasm()];
    await build({
      entryPoints: [path.join(root, 'tests/fixtures/workspace-layout-fixture.tsx')],
      outfile: path.join(output, 'fixture.js'),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'chrome120',
      alias: { 'loro-crdt': 'loro-crdt/bundler' },
      plugins,
      loader: { '.wasm': 'file' },
      publicPath: '/',
    });
    await buildWebStyles(path.join(output, 'style.css'));
    const css = fs.readFileSync(path.join(output, 'style.css'), 'utf8');
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (pathname === '/') {
        res.setHeader('content-type', 'text/html');
        res.end(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/' +
            'fixture.js' +
            '"></script></body></html>',
        );
        return;
      }
      if (pathname === '/style.css') {
        res.setHeader('content-type', 'text/css');
        res.end(css);
        return;
      }
      const file =
        pathname === '/moor-logo.png'
          ? path.join(root, 'apps/web/public/moor-logo.png')
          : path.join(output, path.basename(pathname));
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader(
        'content-type',
        pathname.endsWith('.wasm')
          ? 'application/wasm'
          : pathname.endsWith('.png')
            ? 'image/png'
            : 'text/javascript',
      );
      res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const errors = [];
    win.webContents.on('console-message', (_event, ...args) => {
      const details = args[0];
      if (details?.level === 'error') errors.push(details.message);
    });
    const url = 'http://127.0.0.1:' + server.address().port;
    const wait = (selector) =>
      win.webContents.executeJavaScript(
        `new Promise(resolve=>{const ready=()=>{if(document.querySelector(${JSON.stringify(selector)})){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(resolve));}};const observer=new MutationObserver(ready);observer.observe(document,{subtree:true,childList:true,attributes:true});ready();})`,
      );
    const shot = async (name) => {
      await win.webContents.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
      fs.writeFileSync(
        path.join(output, name + '.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
    };
    await win.loadURL(url);
    await wait('.workspace-pinned li');
    await wait('.workspace-recent li');
    const pageReads = await win.webContents.executeJavaScript('window.__moorFixture.pageReads');
    assert.equal(pageReads.length, 8, 'four projects load bounded pinned and recent summaries');
    assert(
      pageReads.every(
        (read) => read.limit === 30 && !read.cursor && ['pinned', 'unpinned'].includes(read.pinned),
      ),
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.querySelector('.workspace-projects').textContent.includes('含旧主机兼容目录')",
      ),
      false,
    );
    const metrics = await win.webContents.executeJavaScript(`(()=>{
      const nav=document.querySelector('.workspace-projects'), rect=nav.getBoundingClientRect();
      return { viewport: innerHeight, listHeight: rect.height, visibleSessions: [...nav.querySelectorAll('li')].filter(node=>{const r=node.getBoundingClientRect();return r.height>0&&r.top>=rect.top&&r.bottom<=rect.bottom;}).length, overflow: document.documentElement.scrollWidth>innerWidth };
    })()`);
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="设置"]').click()`,
    );
    await wait('.appearance-settings');
    await win.webContents.executeJavaScript(
      `document.querySelector('input[name="appearance"][value="light"]').click()`,
    );
    await wait('html[data-theme="light"]');
    await shot('settings-light');
    assert.equal(
      await win.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor'),
      'rgb(255, 255, 255)',
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="关闭设置"]').click()`,
    );
    await shot('desktop-light');
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="设置"]').click()`,
    );
    await wait('.appearance-settings');
    await win.webContents.executeJavaScript(
      `document.querySelector('input[name="appearance"][value="dark"]').click()`,
    );
    await wait('html[data-theme="dark"]');
    await shot('settings-dark');
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="关闭设置"]').click()`,
    );
    await shot('desktop-dark');
    await win.reload();
    await wait('html[data-theme="dark"] .workspace-history');
    assert.equal(
      await win.webContents.executeJavaScript("localStorage.getItem('moor-appearance')"),
      'dark',
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="设置"]').click()`,
    );
    await wait('.appearance-settings');
    await win.webContents.executeJavaScript(
      `document.querySelector('input[value="system"]').click()`,
    );
    await wait('html[data-theme="system"]');
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="关闭设置"]').click()`,
    );
    for (const [theme, expected] of [
      ['light', 'rgb(255, 255, 255)'],
      ['dark', 'rgb(25, 25, 25)'],
    ]) {
      nativeTheme.themeSource = theme;
      await win.webContents.executeJavaScript(
        `new Promise(resolve => {const media=matchMedia('(prefers-color-scheme: dark)'); const check=()=>{if(media.matches===${theme === 'dark'}){media.removeEventListener('change',check);requestAnimationFrame(()=>resolve());}};media.addEventListener('change',check);check();})`,
      );
      assert.equal(
        await win.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor'),
        expected,
      );
    }

    {
      assert.equal(metrics.overflow, false);
      assert(metrics.visibleSessions >= 4, JSON.stringify(metrics));
      await win.webContents.executeJavaScript(
        "document.querySelector('.workspace-header-tools .workspace-menu-session > summary').click();document.querySelector('.session-information > summary').click()",
      );
      await wait('.session-information[open]');
      await shot('information');
      await win.webContents.executeJavaScript(
        "document.querySelector('.session-information').open=false;document.querySelector('.workspace-header-tools .workspace-menu-environment > summary').click()",
      );
      await wait('.workspace-tool-menu[open]');
      await shot('tools');
      await win.webContents.executeJavaScript(
        `document.querySelectorAll('.workspace-tool-menu').forEach(menu=>menu.open=false);const sizer=document.querySelector('[aria-label="调整侧栏宽度"]');sizer.focus();sizer.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`,
      );
      await wait('[aria-label="调整侧栏宽度"][aria-valuenow="276"]');
      await win.reload();
      await wait('[aria-label="调整侧栏宽度"][aria-valuenow="276"]');
      await win.webContents.executeJavaScript(
        `const sizer=document.querySelector('[aria-label="调整侧栏宽度"]');sizer.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));`,
      );
      await wait('[aria-label="调整侧栏宽度"][aria-valuenow="260"]');
    }
    await win.webContents.executeJavaScript('window.__moorFixture.newConversation()');
    await wait('.workspace-welcome');
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.querySelector('.workspace-menu-environment').hidden",
      ),
      true,
    );
    await shot('new-conversation');
    const composerLayout = await win.webContents.executeJavaScript(`(()=>{
      const toolbar=document.querySelector('.workspace-compose-actions');
      const items=[...toolbar.children].filter(node=>{const style=getComputedStyle(node),rect=node.getBoundingClientRect();return style.display!=='none'&&rect.width>0&&rect.height>0;}).map(node=>{const rect=node.getBoundingClientRect();return {name:node.className||node.tagName,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};});
      const overlaps=[];
      for(let i=0;i<items.length;i++) for(let j=i+1;j<items.length;j++) if(Math.min(items[i].right,items[j].right)-Math.max(items[i].left,items[j].left)>.5&&Math.min(items[i].bottom,items[j].bottom)-Math.max(items[i].top,items[j].top)>.5) overlaps.push([items[i].name,items[j].name]);
      return {items,overlaps};
    })()`);
    assert.deepEqual(composerLayout.overlaps, [], JSON.stringify(composerLayout));
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="模型与推理强度"]').click()`,
    );
    await wait('.model-menu-save');
    await shot('model-menu-default');
    await win.webContents.executeJavaScript(`document.querySelector('.model-menu-save').click()`);
    await win.webContents.executeJavaScript(
      `new Promise(resolve=>{const ready=()=>{if(document.querySelector('.model-menu-save')?.textContent.includes('已设为新会话默认')){observer.disconnect();resolve();}};const observer=new MutationObserver(ready);observer.observe(document,{subtree:true,childList:true});ready();})`,
    );
    assert(
      await win.webContents.executeJavaScript(
        `window.__moorFixture.calls.includes('defaults:fixture-model:high')`,
      ),
      'saving the current model and effort reaches the scoped default action',
    );
    win.setContentSize(390, 760);
    await win.loadURL(url);
    await wait('.workspace-history');
    await shot('narrow');
    const narrowOverflow = await win.webContents.executeJavaScript(
      'document.documentElement.scrollWidth>innerWidth',
    );
    assert.equal(narrowOverflow, false);
    {
      await win.webContents.executeJavaScript(
        "document.querySelector('.workspace-navigation-bar button').click()",
      );
      await wait('.workspace-app[data-navigation="open"]');
      await shot('narrow-navigation');
      assert.equal(
        await win.webContents.executeJavaScript("document.querySelector('.workspace-body').inert"),
        true,
      );

      await win.webContents.executeJavaScript('window.__moorFixture.empty()');
      await wait('.workspace-empty .workspace-add-project');
      await win.webContents.executeJavaScript(
        "document.querySelector('.workspace-empty .workspace-add-project').click()",
      );
      await wait('.workspace-status');
      assert.deepEqual(await win.webContents.executeJavaScript('window.__moorFixture.calls'), [
        'add',
        'create',
      ]);
    }
    fs.writeFileSync(
      path.join(output, 'metrics.json'),
      JSON.stringify({ ...metrics, narrowOverflow, composerLayout, errors }, null, 2),
    );
    console.log(JSON.stringify({ output, metrics, errors }));
    win.destroy();
  })
  .then(
    () => {
      server?.close();
      fs.rmSync(profile, { recursive: true, force: true });
      app.exit(0);
    },
    (error) => {
      console.error(error);
      server?.close();
      fs.rmSync(profile, { recursive: true, force: true });
      app.exit(1);
    },
  );
