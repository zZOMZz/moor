// Isolated real Chromium layout check. Synthetic in-memory UI only, no login or Agent.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'moor-layout-profile-'));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'moor-layout-output-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
let server;
app
  .whenReady()
  .then(async () => {
    const { build } = await import('esbuild');
    const { browserWasm } = await import('./browser-wasm.mjs');
    const baseline = process.env.MOOR_LAYOUT_BASELINE;
    const plugins = [browserWasm()];
    if (baseline)
      plugins.push({
        name: 'baseline-workspace',
        setup(build) {
          build.onLoad({ filter: /src\/web\/workspace-app\.tsx$/ }, () => ({
            contents: execFileSync('git', ['show', baseline + ':src/web/workspace-app.tsx'], {
              cwd: root,
              encoding: 'utf8',
            }),
            loader: 'tsx',
            resolveDir: path.join(root, 'src/web'),
          }));
        },
      });
    await build({
      entryPoints: [path.join(root, 'tests/support/workspace-layout-fixture.tsx')],
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
    const css = baseline
      ? execFileSync('git', ['show', baseline + ':src/web/public/style.css'], { cwd: root })
      : fs.readFileSync(path.join(root, 'src/web/public/style.css'));
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (pathname === '/') {
        res.setHeader('content-type', 'text/html');
        res.end(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>',
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
          ? path.join(root, 'src/web/public/moor-logo.png')
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
    const shot = async (name) =>
      fs.writeFileSync(
        path.join(output, name + '.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
    await win.loadURL(url);
    await wait('.workspace-session-list li');
    const metrics = await win.webContents.executeJavaScript(`(()=>{
    const list=document.querySelector('.workspace-session-list ul');
    let top=0,bottom=innerHeight;
    for(let node=list;node;node=node.parentElement){const style=getComputedStyle(node);if(/auto|scroll|hidden/.test(style.overflowY)){const r=node.getBoundingClientRect();top=Math.max(top,r.top);bottom=Math.min(bottom,r.bottom);}}
    const rect=list.getBoundingClientRect();top=Math.max(top,rect.top);bottom=Math.min(bottom,rect.bottom);
    return{viewport:innerHeight,listHeight:Math.max(0,bottom-top),visibleSessions:[...list.querySelectorAll('li')].filter(node=>{const r=node.getBoundingClientRect();return r.top>=top&&r.bottom<=bottom;}).length,overflow:document.documentElement.scrollWidth>innerWidth};
  })()`);
    await shot('desktop-light');
    await win.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'");
    await shot('desktop-dark');
    if (!baseline) {
      assert.equal(metrics.overflow, false);
      assert(metrics.visibleSessions >= 12);
      await win.webContents.executeJavaScript(
        "document.querySelector('.session-information > summary').click()",
      );
      await wait('.session-information[open]');
      await shot('information');
      await win.webContents.executeJavaScript(
        "document.querySelector('.session-information').open=false;document.querySelector('.workspace-tool-menu > summary').click()",
      );
      await wait('.workspace-tool-menu[open]');
      await shot('tools');
      await win.webContents.executeJavaScript(
        `document.querySelector('.workspace-tool-menu').open=false;const sizer=document.querySelector('[aria-label="调整侧栏宽度"]');sizer.focus();sizer.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`,
      );
      await wait('[aria-label="调整侧栏宽度"][aria-valuenow="276"]');
      await win.reload();
      await wait('[aria-label="调整侧栏宽度"][aria-valuenow="276"]');
      await win.webContents.executeJavaScript(
        `const sizer=document.querySelector('[aria-label="调整侧栏宽度"]');sizer.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));`,
      );
      await wait('[aria-label="调整侧栏宽度"][aria-valuenow="260"]');
    }
    win.setContentSize(390, 760);
    await win.loadURL(url);
    await wait('.workspace-history');
    await shot('narrow');
    const narrowOverflow = await win.webContents.executeJavaScript(
      'document.documentElement.scrollWidth>innerWidth',
    );
    if (!baseline) assert.equal(narrowOverflow, false);
    if (!baseline) {
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
      JSON.stringify({ baseline: baseline ?? null, ...metrics, narrowOverflow, errors }, null, 2),
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
