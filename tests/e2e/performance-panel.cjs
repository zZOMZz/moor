// Real Chromium, actual WorkspaceApp and dev HUD; all content and CPU readings are synthetic.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  renderingFixtureSource,
  renderingInstrumentation,
  runRenderingWorkload,
} = require('./rendering-workload.cjs');

const root = path.resolve(__dirname, '../..');
const directory =
  process.env.MOOR_E2E_DIRECTORY ??
  fs.mkdtempSync(path.join(os.tmpdir(), 'moor-performance-panel-'));
const output = path.join(directory, 'output');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(directory, 'profile'));
let server;
app
  .whenReady()
  .then(async () => {
    const { build } = await import('esbuild');
    const { browserWasm } = await import('../../scripts/build/browser-wasm.mjs');
    const { workspaceSources } = await import('../../scripts/build/workspace-sources.mjs');
    const { buildWebStyles } = await import('../../apps/web/scripts/build-styles.mjs');
    // Extend only this bundle's synthetic controller. The real React layout effect
    // consumes the mark after rendering the new session version; the test never
    // invokes sessionPerformanceCommitted or a measurement sink directly.
    const replay = {
      name: 'synthetic-performance-session-replay',
      setup(builder) {
        builder.onLoad({ filter: /[/\\]workspace-layout-fixture\.tsx$/ }, ({ path: file }) => ({
          loader: 'tsx',
          contents:
            fs.readFileSync(file, 'utf8') +
            `
          let performanceVersion = 0;
          Object.assign(window, {
            __moorPerformanceReplay(mark) {
              const version = 'synthetic-performance-' + ++performanceVersion;
              state.session = {
                ...state.session,
                version,
                history: [...state.session.history, {
                  id: version, role: 'assistant', finished: true,
                  items: [{type: 'text', text: 'Synthetic committed update ' + performanceVersion}]
                }]
              };
              mark?.(controller, state.sessionId, version);
              emit();
            },
            __moorPerformanceVersion(mark, version, expectedVersion) {
              state.session = { ...state.session, version };
              mark?.(controller, state.sessionId, expectedVersion);
              emit();
            }
          });
        ` +
            renderingFixtureSource,
        }));
      },
    };
    await build({
      entryPoints: [path.join(root, 'tests/fixtures/performance-panel-fixture.ts')],
      outfile: path.join(output, 'fixture.js'),
      bundle: true,
      minify: true,
      define: { 'process.env.NODE_ENV': '"production"' },
      platform: 'browser',
      format: 'esm',
      target: 'chrome120',
      alias: { 'loro-crdt': 'loro-crdt/bundler' },
      plugins: [replay, renderingInstrumentation, workspaceSources, browserWasm()],
      loader: { '.wasm': 'file' },
      publicPath: '/',
    });
    await buildWebStyles(path.join(output, 'style.css'));
    server = http.createServer((request, response) => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (pathname === '/') {
        response.setHeader('content-type', 'text/html');
        response.end(
          '<!doctype html><html><head><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/fixture.css"></head><body><div id="app"></div><script type="module" src="/fixture.js"></script></body></html>',
        );
        return;
      }
      const file =
        pathname === '/moor-logo.png'
          ? path.join(root, 'apps/web/public/moor-logo.png')
          : path.join(output, path.basename(pathname));
      if (!fs.existsSync(file)) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.setHeader(
        'content-type',
        pathname.endsWith('.css')
          ? 'text/css'
          : pathname.endsWith('.wasm')
            ? 'application/wasm'
            : pathname.endsWith('.png')
              ? 'image/png'
              : 'text/javascript',
      );
      response.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const errors = [];
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message);
    });
    const read = (expression) => win.webContents.executeJavaScript(expression);
    const bounded = async (operation, label) => {
      let guard;
      try {
        return await Promise.race([
          operation,
          new Promise((_, reject) => {
            guard = setTimeout(
              () => reject(Error('Performance panel did not reach: ' + label)),
              7000,
            );
          }),
        ]);
      } finally {
        clearTimeout(guard);
      }
    };
    const until = (expression) =>
      bounded(
        read(`new Promise(resolve => {
    const check = () => { if (${expression}) resolve(); else requestAnimationFrame(check); }; check();
  })`),
        expression,
      );
    const frames = () =>
      read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const click = (label) =>
      read(`document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)}).click()`);
    const metric = (name) => `document.querySelector('[data-perf-metric="${name}"]')`;
    const type = async (value) => {
      await read(`(() => {
      const field = document.querySelector('[aria-label="消息"]'); field.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event('input', {bubbles: true}));
    })()`);
      await frames();
    };
    try {
      await win.loadURL('http://127.0.0.1:' + server.address().port);
      await until(
        `window.__moorPerformanceFixture && document.querySelector('[aria-label="消息"]') && document.querySelector('[aria-label="打开性能面板"]')`,
      );
      assert.equal(
        await read('document.hidden'),
        false,
        'Chromium must expose a visible document to collect foreground samples',
      );
      assert.equal(await read('window.__moorPerformanceFixture.sampling()'), false);
      assert.equal(await read('window.__moorPerformanceFixture.cpuReads()'), 0);
      await type('Synthetic draft before sampling');
      assert.equal(await read('window.__moorPerformanceFixture.stream()'), false);
      await until(
        `document.querySelector('.workspace-history').textContent.includes('Synthetic committed update 1')`,
      );
      assert.equal(await read('window.__moorPerformanceFixture.cpuReads()'), 0);

      await read(`document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'p', code: 'KeyP', ctrlKey: true, altKey: true, bubbles: true
      }))`);
      await until(`document.querySelector('[aria-label="开发性能面板"][data-state="sampling"]')`);
      assert.equal(await read('window.__moorPerformanceFixture.sampling()'), true);
      await until(`Number.parseFloat(${metric('fps')}.textContent) > 0`);
      assert.equal(await read(`Number.parseInt(${metric('inputSamples')}.textContent)`), 0);
      assert.equal(await read(`Number.parseInt(${metric('streamSamples')}.textContent)`), 0);
      await type('Synthetic measured draft');
      assert.equal(await read('window.__moorPerformanceFixture.stream()'), true);
      await until(
        `document.querySelector('.workspace-history').textContent.includes('Synthetic committed update 2')`,
      );
      await until(
        `Number.parseInt(${metric('inputSamples')}.textContent) > 0 && Number.parseInt(${metric('streamSamples')}.textContent) === 1`,
      );
      await until(`Number.parseFloat(${metric('cpu')}.textContent) === 21`);
      const measured = await read(
        `Object.fromEntries([...document.querySelectorAll('[data-perf-metric]')].map(node => [node.dataset.perfMetric, node.textContent]))`,
      );
      for (const name of ['inputP95Ms', 'streamP95Ms', 'frameP95Ms'])
        assert(Number.isFinite(Number.parseFloat(measured[name])), name);
      assert.equal(
        await read(`document.querySelector('[aria-label="消息"]').value`),
        'Synthetic measured draft',
      );
      fs.writeFileSync(
        path.join(output, 'performance-panel.png'),
        (await win.webContents.capturePage()).toPNG(),
      );

      await click('重置性能统计');
      await until(
        `Number.parseInt(${metric('inputSamples')}.textContent) === 0 && Number.parseInt(${metric('streamSamples')}.textContent) === 0`,
      );
      assert.equal(await read(`Number.parseInt(${metric('stallCount')}.textContent)`), 0);

      // A hidden conversation still commits real versions. A later cache revisit
      // must not turn the discarded read into an apparent long stream latency.
      await click('账号与连接');
      await until(`document.querySelector('main.workspace-conversation').hidden`);
      await read(`window.__moorPerformanceFixture.version('hidden-read', true)`);
      await frames();
      await read(`window.__moorPerformanceFixture.version('other-hidden-version')`);
      await frames();
      await read(
        `[...document.querySelectorAll('button')].find(node => node.textContent === '返回工作区').click()`,
      );
      await until(`!document.querySelector('main.workspace-conversation').hidden`);
      await read(`window.__moorPerformanceFixture.version('hidden-read')`);
      await frames();
      const afterHiddenCommit = await read('window.__moorPerformanceFixture.cpuReads()');
      // CPU reads start after the HUD's paint in the same refresh callback. This
      // waits for a real refresh signal, so asserting zero cannot read stale DOM.
      await until(`window.__moorPerformanceFixture.cpuReads() > ${afterHiddenCommit}`);
      assert.equal(
        await read(`Number.parseInt(${metric('streamSamples')}.textContent)`),
        0,
        'a hidden read cannot be sampled when its cached version is revisited',
      );

      await read(
        `window.__moorPerformanceFixture.version('visible-other-version', true, 'late-cached-version')`,
      );
      await frames();
      await read(`window.__moorPerformanceFixture.version('late-cached-version')`);
      await frames();
      const afterMismatchedCommit = await read('window.__moorPerformanceFixture.cpuReads()');
      await until(`window.__moorPerformanceFixture.cpuReads() > ${afterMismatchedCommit}`);
      assert.equal(
        await read(`Number.parseInt(${metric('streamSamples')}.textContent)`),
        0,
        'a mismatched commit consumes the stale mark before a cache-only revisit',
      );
      await click('关闭性能面板');
      await until(
        `!document.querySelector('[aria-label="开发性能面板"]') || document.querySelector('[aria-label="开发性能面板"]').hidden`,
      );
      assert.equal(await read('window.__moorPerformanceFixture.sampling()'), false);
      const stoppedCpuReads = await read('window.__moorPerformanceFixture.cpuReads()');
      await type('Synthetic draft while closed');
      assert.equal(await read('window.__moorPerformanceFixture.stream()'), false);
      await until(
        `document.querySelector('.workspace-history').textContent.includes('Synthetic committed update 3')`,
      );
      assert.equal(await read('window.__moorPerformanceFixture.cpuReads()'), stoppedCpuReads);
      await click('打开性能面板');
      await until(`document.querySelector('[aria-label="开发性能面板"][data-state="sampling"]')`);
      assert.equal(await read(`Number.parseInt(${metric('inputSamples')}.textContent)`), 0);
      assert.equal(await read(`Number.parseInt(${metric('streamSamples')}.textContent)`), 0);
      await type('Synthetic draft after reopening');
      assert.equal(await read('window.__moorPerformanceFixture.stream()'), true);
      await until(
        `Number.parseInt(${metric('inputSamples')}.textContent) > 0 && Number.parseInt(${metric('streamSamples')}.textContent) === 1`,
      );
      assert.deepEqual(errors, []);
      await read('window.__moorPerformanceFixture.dispose()');
      await until(
        `!document.querySelector('[aria-label="打开性能面板"]') && !document.querySelector('[aria-label="开发性能面板"]')`,
      );
      assert.equal(await read('window.__moorPerformanceFixture.sampling()'), false);
      const rendering = await runRenderingWorkload(win, output);
      console.log(
        JSON.stringify({
          output,
          measured,
          actualInputAndSessionCommit: true,
          rendering: rendering.stages,
          errors,
        }),
      );
    } catch (error) {
      fs.writeFileSync(
        path.join(output, 'failure.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
      throw error;
    } finally {
      win.destroy();
      server.close();
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    server?.close();
    app.exit(1);
  });
