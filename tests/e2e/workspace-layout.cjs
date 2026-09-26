// Isolated real Chromium layout check. Synthetic in-memory UI only, no login or Agent.
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const profile = process.env.MOOR_E2E_DIRECTORY
  ? path.join(process.env.MOOR_E2E_DIRECTORY, 'profile')
  : fs.mkdtempSync(path.join(os.tmpdir(), 'moor-layout-profile-'));
const output = process.env.MOOR_E2E_DIRECTORY
  ? path.join(process.env.MOOR_E2E_DIRECTORY, 'output')
  : fs.mkdtempSync(path.join(os.tmpdir(), 'moor-layout-output-'));
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
let server;
app
  .whenReady()
  .then(async () => {
    const { build } = await import('esbuild');
    const { browserWasm } = await import('../../scripts/build/browser-wasm.mjs');
    const { workspaceSources } = await import('../../scripts/build/workspace-sources.mjs');
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
      // Layout, transitions and frame waits need a mapped native window on Linux.
      show: true,
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
    win.webContents.on('console-message', (_event, ...args) => {
      const details = args[0];
      if (details?.level === 'error') errors.push(details.message);
    });
    const url = 'http://127.0.0.1:' + server.address().port;
    const bounded = async (operation, label) => {
      let timeout;
      try {
        return await Promise.race([
          operation,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('UI did not reach: ' + label)), 7000);
          }),
        ]);
      } catch (error) {
        fs.writeFileSync(
          path.join(output, 'failure.png'),
          (await win.webContents.capturePage()).toPNG(),
        );
        console.error(
          await win.webContents.executeJavaScript(
            `JSON.stringify({ active: document.activeElement?.outerHTML, notices: [...document.querySelectorAll('[role="alert"], .workspace-status')].map(node => node.textContent), fixtureCalls: window.__moorFixture?.calls, fixtureSelection: window.__moorFixture?.selection() })`,
          ),
        );
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    };
    const wait = (selector) =>
      bounded(
        win.webContents.executeJavaScript(
          `new Promise(resolve=>{const ready=()=>{if(document.querySelector(${JSON.stringify(selector)})){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(resolve));}};const observer=new MutationObserver(ready);observer.observe(document,{subtree:true,childList:true,attributes:true});ready();})`,
        ),
        selector,
      );
    const read = (expression) => win.webContents.executeJavaScript(expression);
    const frames = () =>
      read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const until = (expression) =>
      bounded(
        read(
          `new Promise(resolve => { const check = () => { if (${expression}) resolve(); else requestAnimationFrame(check); }; check(); })`,
        ),
        expression,
      );
    const input = async (selector, value) => {
      await read(
        `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      await frames();
    };
    const shortcut = async (key, modifier = 'metaKey', shiftKey = false) => {
      await read(
        `(document.activeElement?.closest('.workspace-app') ? document.activeElement : document.querySelector('.workspace-app')).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ${modifier}: true, shiftKey: ${shiftKey}, bubbles: true }))`,
      );
      await frames();
    };
    const escape = async () => {
      await read(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      );
      await frames();
    };
    const toolbarRow = async (count = 4) => {
      const controls = await read(`(() => {
        const box = document.querySelector('.workspace-input-box').getBoundingClientRect();
        return [...document.querySelectorAll('.workspace-compose-actions > .workspace-menu-composer > summary, .workspace-compose-actions .run-approval .picker-trigger, .workspace-compose-actions .model-menu-trigger, .workspace-compose-submit, .workspace-compose-steer')].map(node => {
          const rect = node.getBoundingClientRect();
          return { label: node.getAttribute('aria-label') || node.textContent, left: rect.left, right: rect.right, top: rect.top, center: rect.top + rect.height / 2, height: rect.height, inside: rect.left >= box.left - 1 && rect.right <= box.right + 1 };
        });
      })()`);
      assert.equal(controls.length, count, JSON.stringify(controls));
      assert(
        controls.every((control) => control.inside && control.height <= 44),
        JSON.stringify(controls),
      );
      assert(
        Math.max(...controls.map((control) => control.center)) -
          Math.min(...controls.map((control) => control.center)) <=
          3,
        'composer controls share one row: ' + JSON.stringify(controls),
      );
      const permission = await read(`(() => {
        const value = document.querySelector('.run-approval .picker-value');
        const rect = value.getBoundingClientRect(), trigger = value.closest('button').getBoundingClientRect();
        const style = getComputedStyle(value);
        return { text: value.textContent.trim(), width: Math.min(rect.right, trigger.right) - Math.max(rect.left, trigger.left), contentWidth: value.scrollWidth, visible: rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' };
      })()`);
      assert(
        permission.text &&
          permission.visible &&
          permission.width >= Math.min(permission.contentWidth, 40),
        'permission mode remains readable beside a long model name: ' + JSON.stringify(permission),
      );
      return controls;
    };
    const selectLines = async (side, start, end = start) => {
      await read(
        `document.querySelector(${JSON.stringify(`[aria-label="选择${side}第 ${start} 行"]`)}).click()`,
      );
      if (end !== start)
        await read(
          `document.querySelector(${JSON.stringify(`[aria-label="选择${side}第 ${end} 行"]`)}).dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: true}))`,
        );
      await frames();
      assert.equal(
        await read(`document.querySelectorAll('.project-select-line[aria-pressed="true"]').length`),
        end - start + 1,
      );
    };
    const diffFile = async (path) => {
      await until(`!document.querySelector('.project-loading')`);
      await frames();
      await read(
        `[...document.querySelectorAll('.project-change-list button')].find(button => button.textContent.includes(${JSON.stringify(path)})).click()`,
      );
      await until(
        `document.querySelector('.project-preview-heading h3')?.textContent === ${JSON.stringify(path)}`,
      );
    };
    const shot = async (name) => {
      await win.webContents.executeJavaScript(
        `(async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          await Promise.all(document.getAnimations()
            .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
            .map(animation => animation.finished.catch(() => {})));
        })()`,
      );
      fs.writeFileSync(
        path.join(output, name + '.png'),
        (await win.webContents.capturePage()).toPNG(),
      );
    };
    await win.loadURL(url);
    win.show();
    win.focus();
    win.webContents.focus();
    assert.equal(win.isVisible(), true, 'layout checks require a visible native window');
    assert.equal(await read('document.hidden'), false, 'layout checks require foreground frames');
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
      const commands = ['/review', '$synthetic-review', '/already-prefixed'];
      assert.deepEqual(
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.session-command button')].map(button=>button.textContent)`,
        ),
        commands,
        'command buttons preserve the native dollar and slash prefixes',
      );
      let draft = await win.webContents.executeJavaScript(
        'document.querySelector("textarea").value',
      );
      for (const command of commands) {
        const actual = await win.webContents.executeJavaScript(`(async()=>{
          [...document.querySelectorAll('.session-command button')].find(button=>button.textContent===${JSON.stringify(command)}).click();
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          return document.querySelector('textarea').value;
        })()`);
        draft = draft ? draft + '\n' + command : command;
        assert.equal(actual, draft, 'selecting a command appends its exact text to the draft');
      }
      assert.equal(
        await win.webContents.executeJavaScript("window.__moorFixture.calls.includes('send')"),
        false,
        'selecting a command never submits it',
      );
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

    // Everyday desktop navigation uses the same scoped actions as the visible controls.
    await read(
      `document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'k', metaKey: true, bubbles: true}))`,
    );
    await until(`document.activeElement?.getAttribute('aria-label') === '筛选当前工作区会话'`);
    await escape();
    for (const modifier of ['metaKey', 'ctrlKey']) {
      await shortcut('k', modifier);
      assert.equal(
        await read(`document.activeElement.getAttribute('aria-label')`),
        '筛选当前工作区会话',
      );
      await input('[aria-label="筛选当前工作区会话"]', '检查');
      await escape();
      assert.equal(
        await read(`document.querySelector('[aria-label="筛选当前工作区会话"]').value`),
        '',
      );
      assert.equal(
        await read(
          `document.querySelector('[aria-label="搜索会话"]').getAttribute('aria-expanded')`,
        ),
        'true',
      );
      await escape();
      assert.equal(
        await read(
          `document.querySelector('[aria-label="搜索会话"]').getAttribute('aria-expanded')`,
        ),
        'false',
      );
      await shortcut('b', modifier);
      await wait('.workspace-app[data-navigation="closed"]');
      await shortcut('b', modifier);
      await wait('.workspace-app[data-navigation="open"]');
    }
    await shortcut('k');
    await input('[aria-label="筛选当前工作区会话"]', '中文查询');
    for (const properties of [{ isComposing: true }, { keyCode: 229 }, { consumed: true }]) {
      await read(`(() => {
        const input = document.querySelector('[aria-label="筛选当前工作区会话"]');
        const properties = ${JSON.stringify(properties)};
        if (properties.consumed) input.addEventListener('keydown', event => event.preventDefault(), {once: true});
        input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true, ...properties}));
      })()`);
      await frames();
      assert.equal(
        await read(`document.querySelector('[aria-label="筛选当前工作区会话"]').value`),
        '中文查询',
        'IME or consumed Escape never clears the search',
      );
    }
    await escape();
    await escape();
    await read(
      `const menu = document.querySelector('.workspace-header-tools .workspace-menu-session'); menu.open = true; menu.querySelector('summary').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', isComposing: true, bubbles: true}));`,
    );
    await frames();
    assert.equal(
      await read(`document.querySelector('.workspace-header-tools .workspace-menu-session').open`),
      true,
      'IME cancellation does not close an open tool menu',
    );
    await escape();
    assert.equal(
      await read(`document.querySelector('.workspace-header-tools .workspace-menu-session').open`),
      false,
    );
    assert.equal(await read(`document.activeElement.getAttribute('aria-label')`), '会话工具');
    await read('window.__moorFixture.holdContentReads()');
    await read(
      `document.querySelector('.workspace-session-header [aria-label="项目文件"]').focus(); document.activeElement.click()`,
    );
    await wait('.workspace-new-conversation button:disabled');
    await shortcut('O', 'metaKey', true);
    assert.equal(
      await read(`window.__moorFixture.calls.filter(call => call === 'create').length`),
      0,
      'new conversation shortcut respects a pending workspace action',
    );
    await read('window.__moorFixture.releaseContentReads()');
    await wait('.project-content-docked');
    assert.equal(
      await read(`document.activeElement.getAttribute('aria-label')`),
      '关闭文件与变更',
      'opening a dock gives its controls keyboard focus',
    );
    await escape();
    await until(`!document.querySelector('.project-content-docked')`);
    assert.equal(await read(`document.activeElement.getAttribute('aria-label')`), '项目文件');
    await wait('.workspace-new-conversation button:not(:disabled)');
    await shortcut('O', 'ctrlKey', true);
    await until(`window.__moorFixture.calls.filter(call => call === 'create').length === 1`);
    await win.loadURL(url);
    await wait('.workspace-session-heading');
    await toolbarRow();
    assert.equal(
      await read(
        `document.querySelectorAll('.workspace-composer-context > button, .workspace-composer-context > label').length`,
      ),
      1,
      'execution context has one compact entry point',
    );
    await read(`document.querySelector('[aria-label="执行环境"]').click()`);
    await wait('.workspace-environment-popup');
    assert(
      await read(
        `!!document.querySelector('.workspace-environment-popup [aria-label="选择项目"]') && !!document.querySelector('.workspace-environment-popup [aria-label="执行电脑"]') && !!document.querySelector('.workspace-environment-popup [aria-label="选择 Git 分支与工作目录"]')`,
      ),
    );
    await read(
      `document.querySelector('.workspace-environment-popup [aria-label="选择项目"]').focus()`,
    );
    await escape();
    await until(`!document.querySelector('.workspace-environment-popup')`);
    await read(`document.querySelector('.workspace-menu-composer > summary').click()`);
    await wait('.workspace-menu-composer[open] .workspace-composer-extras .usage-trigger');
    await read(`document.querySelector('.workspace-menu-composer > summary').click()`);
    assert.match(
      await read(`document.querySelector('.workspace-session-heading').textContent`),
      /Moor.*Synthetic/s,
    );
    assert.equal(
      await read(`!!document.querySelector('[aria-label="查看文件变更"]')`),
      false,
      'sessions without changes have no change action',
    );
    await read('window.__moorFixture.fileChanges(0)');
    await frames();
    assert.equal(
      await read(`!!document.querySelector('[aria-label="查看文件变更"]')`),
      false,
      'zero-change baselines do not advertise changes',
    );
    await read('window.__moorFixture.fileChanges(1)');
    await wait('[aria-label="查看文件变更"]');
    await input('[aria-label="消息"]', '查看文件时保留的草稿');
    await read(
      `document.querySelector('.workspace-session-header [aria-label="项目文件"]').focus(); document.activeElement.click()`,
    );
    await wait('.workspace-content-dock .project-content-docked');
    await wait('[aria-label="查看文件：README.md"]');
    await read(
      `const close = document.querySelector('[aria-label="关闭文件与变更"]'); close.focus(); close.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', isComposing: true, keyCode: 229, bubbles: true}));`,
    );
    await frames();
    assert.equal(
      await read(`!!document.querySelector('.project-content-docked')`),
      true,
      'IME cancellation does not close file review',
    );
    await read(`document.querySelector('[aria-label="查看文件：README.md"]').click()`);
    await wait('.project-markdown');
    assert.equal(
      await read(
        `document.querySelector('.project-markdown').textContent.includes('Synthetic project')`,
      ),
      true,
    );
    await input('[aria-label="消息"]', '查看文件时仍可继续编辑的草稿');
    assert.equal(
      await read(`document.activeElement.getAttribute('aria-label')`),
      '消息',
      'docked files do not trap focus away from the composer',
    );
    const dockLayout = await read(
      `(() => { const dock = document.querySelector('.project-content-docked').getBoundingClientRect(); const composer = document.querySelector('.workspace-composer').getBoundingClientRect(); return {dockLeft: dock.left, composerRight: composer.right, overflow: document.documentElement.scrollWidth > innerWidth}; })()`,
    );
    assert(dockLayout.composerRight <= dockLayout.dockLeft + 1, JSON.stringify(dockLayout));
    assert.equal(dockLayout.overflow, false);
    await read(
      `document.querySelector('.workspace-session-header [aria-label="项目文件"]').focus(); document.activeElement.click()`,
    );
    await wait('.workspace-content-dock [aria-label="查看文件：README.md"]');
    assert.equal(
      await read(`document.querySelector('[aria-label="消息"]').value`),
      '查看文件时仍可继续编辑的草稿',
      'reopening file review preserves the draft',
    );
    await read(`document.querySelector('[aria-label="查看文件：README.md"]').click()`);
    await wait('.project-markdown');
    await shot('desktop-files');
    await read(`document.querySelector('[aria-label="打开目录：src"]').click()`);
    await wait('[aria-label="查看文件：src/engine.ts"]');
    await read(`document.querySelector('[aria-label="查看文件：src/engine.ts"]').click()`);
    await wait('[aria-label="选择本次读取第 12 行"]');
    await read(`document.querySelector('[aria-label="重新读取文件或变更"]').click()`);
    await wait('[aria-label="选择本次读取第 12 行"]');
    assert.equal(
      await read(`document.querySelector('.project-preview-heading h3').textContent`),
      'src/engine.ts',
      'refresh keeps the selected current file',
    );
    assert.match(
      await read(`document.querySelector('.project-compact-files > summary').textContent`),
      /src/,
    );
    await selectLines('本次读取', 10, 12);
    await read(`document.querySelector('.project-quote-button').click()`);
    await frames();
    const currentQuote = await read(`document.querySelector('[aria-label="消息"]').value`);
    assert(currentQuote.startsWith('查看文件时仍可继续编辑的草稿'));
    assert.match(currentQuote, /src\/engine\.ts/);
    assert.match(currentQuote, /current working file line 10/);
    assert.match(currentQuote, /current working file line 12/);
    assert.doesNotMatch(currentQuote, /current working file line (9|13)'/);
    assert.match(currentQuote, /sha256:[a-f0-9]{64}/);
    assert.equal(
      await read(`window.__moorFixture.calls.includes('send')`),
      false,
      'file references only append draft text',
    );
    assert.equal(await read(`document.activeElement.getAttribute('aria-label')`), '消息');
    await shot('file-reference');
    await input('[aria-label="消息"]', '查看文件时仍可继续编辑的草稿');

    const reviewWidth = await read(
      `document.querySelector('.project-content-docked').getBoundingClientRect().width`,
    );
    await read(`document.querySelector('[aria-label="放大文件与变更"]').click()`);
    await wait('[data-review-expanded="true"] .project-content-docked');
    await until(
      `document.querySelector('.project-content-docked').getBoundingClientRect().width > ${reviewWidth + 1}`,
    );
    assert(
      await read(
        `document.querySelector('.workspace-composer').getBoundingClientRect().width >= 320`,
      ),
    );
    await shot('review-expanded');
    await read(`document.querySelector('[aria-label="缩小文件与变更"]').click()`);
    await wait('[data-review-expanded="false"] .project-content-docked');
    await until(
      `Math.abs(document.querySelector('.project-content-docked').getBoundingClientRect().width - ${reviewWidth}) < 2`,
    );
    await read(`(() => {
      window.__moorWidthWrites = 0;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'moor-content-dock-width-v1') window.__moorWidthWrites++;
        return original.call(this, key, value);
      };
      window.__moorRestoreWidthStorage = () => { Storage.prototype.setItem = original; };
    })()`);
    const resizeStart = await read(
      `(() => {const node = document.querySelector('[aria-label="调整审查面板宽度"]'), r = node.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), width: Number(node.getAttribute('aria-valuenow'))};})()`,
    );
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: resizeStart.x,
      y: resizeStart.y,
      button: 'left',
      clickCount: 1,
    });
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: resizeStart.x - 40,
      y: resizeStart.y,
      modifiers: ['leftButtonDown'],
    });
    await until(
      `Number(document.querySelector('[aria-label="调整审查面板宽度"]').getAttribute('aria-valuenow')) > ${resizeStart.width}`,
    );
    assert.equal(await read('window.__moorWidthWrites'), 0, 'drag frames never persist width');
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: resizeStart.x - 40,
      y: resizeStart.y,
      button: 'left',
      clickCount: 1,
    });
    await until(
      `Number(document.querySelector('[aria-label="调整审查面板宽度"]').getAttribute('aria-valuenow')) > ${resizeStart.width}`,
    );
    const savedReviewWidth = await read(
      `Number(localStorage.getItem('moor-content-dock-width-v1'))`,
    );
    assert(savedReviewWidth > resizeStart.width, 'dragging saves the review width');
    assert.equal(
      await read('window.__moorWidthWrites'),
      1,
      'pointerup persists only the final width',
    );
    await read('window.__moorRestoreWidthStorage()');
    await read(`document.querySelector('[aria-label="关闭文件与变更"]').click()`);
    await until(`!document.querySelector('.project-content-docked')`);
    assert.equal(
      await read(`document.activeElement.getAttribute('aria-label')`),
      '项目文件',
      'closing the dock restores focus to its opener',
    );
    assert.equal(
      await read(`document.querySelector('[aria-label="消息"]').value`),
      '查看文件时仍可继续编辑的草稿',
    );
    await read(
      `document.querySelector('[aria-label="查看文件变更"]').focus(); document.activeElement.click()`,
    );
    await wait('.project-content-docked [aria-label="选择历史回合"]');
    await wait('.project-change-list button');
    await read(`document.querySelector('.project-change-list button').click()`);
    await wait('.project-lines');
    assert.match(
      await read(`document.querySelector('.project-lines').textContent`),
      /Synthetic project/,
    );
    await shot('desktop-changes');
    await read(`document.querySelector('[aria-label="设置"]').click()`);
    await wait('.appearance-settings');
    await read(`document.querySelector('input[name="appearance"][value="light"]').click()`);
    await wait('html[data-theme="light"]');
    await read(`document.querySelector('[aria-label="关闭设置"]').click()`);
    await shot('desktop-review-light');
    await read(`document.querySelector('[aria-label="设置"]').click()`);
    await wait('.appearance-settings');
    await read(`document.querySelector('input[name="appearance"][value="dark"]').click()`);
    await wait('html[data-theme="dark"]');
    await read(`document.querySelector('[aria-label="关闭设置"]').click()`);
    assert.equal(await read(`document.querySelectorAll('.project-change-list button').length`), 12);
    const listSpace = await read(
      `(() => {const panel = document.querySelector('.project-content-docked').getBoundingClientRect(), list = document.querySelector('.project-compact-files').getBoundingClientRect(); return {panel: panel.height, list: list.height};})()`,
    );
    assert(
      listSpace.list < listSpace.panel * 0.36,
      'file list leaves most of the panel for content: ' + JSON.stringify(listSpace),
    );
    await diffFile('src/engine.ts');
    await wait('[aria-label="选择修改后第 22 行"]');
    await read(`document.querySelector('[aria-label="重新读取文件或变更"]').click()`);
    await wait('[aria-label="选择修改后第 22 行"]');
    assert.equal(
      await read(`document.querySelector('.project-preview-heading h3').textContent`),
      'src/engine.ts',
      'refresh keeps the selected historical file instead of the first change',
    );
    await selectLines('修改后', 20, 22);
    await read(`document.querySelector('.project-quote-button').click()`);
    await frames();
    const historicalQuote = await read(`document.querySelector('[aria-label="消息"]').value`);
    assert.match(historicalQuote, /after snapshot line 20/);
    assert.match(historicalQuote, /after snapshot line 22/);
    assert.match(historicalQuote, /assistant-turn/);
    assert.match(historicalQuote, /synthetic-diff/);
    assert.doesNotMatch(historicalQuote, /current working file/);
    await read(
      `const select = document.querySelector('[aria-label="选择历史回合"]'); select.value = 'previous-turn'; select.dispatchEvent(new Event('change', {bubbles: true}));`,
    );
    await until(
      `!document.querySelector('.project-loading') && !document.querySelector('[aria-label="选择历史回合"]').disabled`,
    );
    await diffFile('src/engine.ts');
    await wait('[aria-label="选择修改后第 22 行"]');
    assert.equal(
      await read(`document.querySelectorAll('.project-select-line[aria-pressed="true"]').length`),
      0,
      'changing historical snapshots clears line selection',
    );
    await selectLines('修改后', 20, 22);
    await read(`document.querySelector('.project-quote-button').click()`);
    await frames();
    const previousQuote = await read(`document.querySelector('[aria-label="消息"]').value`);
    assert(previousQuote.startsWith(historicalQuote));
    assert.match(previousQuote, /previous snapshot line 20/);
    assert.match(previousQuote, /previous-turn/);
    assert.equal(await read(`window.__moorFixture.calls.includes('send')`), false);
    await shot('snapshot-reference');
    win.setContentSize(980, 768);
    await wait('[role="dialog"] .project-panel-heading');
    assert.equal(
      await read(`!!document.querySelector('.project-content-docked')`),
      false,
      'compact windows use a dialog for file review',
    );
    assert.equal(await read('document.documentElement.scrollWidth > innerWidth'), false);
    await shot('compact-changes');
    await read(`document.querySelector('[aria-label="关闭文件与变更"]').click()`);
    await until(`!document.querySelector('[role="dialog"] .project-panel-heading')`);
    assert.equal(await read(`document.activeElement.getAttribute('aria-label')`), '查看文件变更');
    await read(
      `document.querySelector('.workspace-session-header [aria-label="项目文件"]').click()`,
    );
    await wait('[role="dialog"] [aria-label="打开目录：src"]');
    await read(`document.querySelector('[aria-label="打开目录：src"]').click()`);
    await read(`document.querySelector('[aria-label="查看文件：src/engine.ts"]').click()`);
    await wait('[aria-label="选择本次读取第 7 行"]');
    await selectLines('本次读取', 7);
    await read(`document.querySelector('.project-quote-button').click()`);
    await until(`!document.querySelector('[role="dialog"] .project-panel-heading')`);
    await frames();
    assert.equal(
      await read(`document.activeElement.getAttribute('aria-label')`),
      '消息',
      'quoting from compact review returns to the draft: ' +
        (await read(`document.activeElement.outerHTML`)),
    );
    assert.match(
      await read(`document.querySelector('[aria-label="消息"]').value`),
      /current working file line 7/,
    );
    const readsBeforeOffline = await read(`window.__moorFixture.contentReads.length`);
    await read(`window.__moorFixture.offlineContent()`);
    await frames();
    await read(
      `document.querySelector('.workspace-session-header [aria-label="项目文件"]').click()`,
    );
    await wait('[role="dialog"] [aria-label="打开目录：src"]');
    await read(`document.querySelector('[aria-label="打开目录：src"]').click()`);
    await read(`document.querySelector('[aria-label="查看文件：src/engine.ts"]').click()`);
    await wait('[aria-label="选择本次读取第 1 行"]');
    assert.equal(
      await read(`document.querySelector('.project-source-badge').textContent`),
      '离线缓存',
    );
    await selectLines('本次读取', 1);
    await read(`document.querySelector('.project-quote-button').click()`);
    await until(`!document.querySelector('[role="dialog"] .project-panel-heading')`);
    assert.match(await read(`document.querySelector('[aria-label="消息"]').value`), /离线缓存/);
    assert.equal(
      await read(`window.__moorFixture.contentReads.length`),
      readsBeforeOffline,
      'offline reference reads only previously verified cache',
    );
    assert.equal(await read(`window.__moorFixture.calls.includes('send')`), false);
    win.setContentSize(1200, 768);
    await win.loadURL(url);
    await wait('.workspace-history');
    await read(
      `document.querySelector('.workspace-session-header [aria-label="项目文件"]').click()`,
    );
    await wait('.project-content-docked');
    await until(
      `Math.abs(document.querySelector('.project-content-docked').getBoundingClientRect().width - ${savedReviewWidth}) < 2`,
    );
    await read(`document.querySelector('[aria-label="关闭文件与变更"]').click()`);
    await read(
      `window.__moorFixture.longModel(); document.querySelector('.workspace-session-header [aria-label="项目文件"]').focus(); document.activeElement.click()`,
    );
    await wait('.workspace-content-dock .project-content-docked');
    win.setContentSize(1100, 768);
    await read(
      `document.querySelector('[aria-label="调整侧栏宽度"]').dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true}))`,
    );
    await wait('[aria-label="调整侧栏宽度"][aria-valuenow="400"]');
    await frames();
    const compactDock = await read(
      `(() => { const box = document.querySelector('.workspace-input-box').getBoundingClientRect(); const controls = [...document.querySelectorAll('.workspace-input-box button, .workspace-input-box summary, .workspace-input-box select')].filter(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1; }).map(node => { const rect = node.getBoundingClientRect(); return {label: node.getAttribute('aria-label') || node.textContent, left: rect.left, right: rect.right}; }); return {box: {left: box.left, right: box.right}, controls, overflow: document.documentElement.scrollWidth > innerWidth}; })()`,
    );
    assert.equal(compactDock.overflow, false, JSON.stringify(compactDock));
    await toolbarRow();
    assert(
      await read(
        `document.querySelector('[aria-label="模型与推理强度"]').getBoundingClientRect().height <= 44`,
      ),
      'long model names stay on a compact toolbar row instead of consuming conversation space',
    );
    assert(
      compactDock.controls.every(
        (control) =>
          control.left >= compactDock.box.left - 1 && control.right <= compactDock.box.right + 1,
      ),
      JSON.stringify(compactDock),
    );
    await shot('compact-dock');
    await read(
      `document.querySelector('[aria-label="关闭文件与变更"]').click(); localStorage.setItem('moor-workspace-layout-v1', JSON.stringify({width: 260, open: true}))`,
    );
    win.setContentSize(1200, 768);

    await win.loadURL(url + '/?grouped=1');
    await wait('.workspace-logical-project');
    const groupedSelection = await win.webContents.executeJavaScript(
      'window.__moorFixture.selection()',
    );
    await win.webContents.executeJavaScript(
      `const select=document.querySelector('[aria-label="筛选项目分组"]');select.value=select.options[1].value;select.dispatchEvent(new Event('change',{bubbles:true}));`,
    );
    await win.webContents.executeJavaScript(
      `new Promise(resolve=>{const check=()=>{if(document.querySelectorAll('.workspace-project-group').length===2){observer.disconnect();resolve();}};const observer=new MutationObserver(check);observer.observe(document,{subtree:true,childList:true});check();})`,
    );
    assert.deepEqual(
      await win.webContents.executeJavaScript('window.__moorFixture.selection()'),
      groupedSelection,
      'project filtering never navigates the current session',
    );
    assert.deepEqual(await win.webContents.executeJavaScript('window.__moorFixture.calls'), []);
    await shot('grouped-projects');
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.workspace-project-group .workspace-project')[1].click()`,
    );
    await wait('.workspace-project-group:nth-last-child(1) .workspace-session-open');
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.workspace-project-group')[1].querySelector('.workspace-session-open').click()`,
    );
    await win.webContents.executeJavaScript(
      `new Promise(resolve=>{const check=()=>{if(document.querySelector('.workspace-session-header h1')?.textContent==='另一台电脑的会话 2'){observer.disconnect();resolve();}};const observer=new MutationObserver(check);observer.observe(document,{subtree:true,childList:true});check();})`,
    );
    const selectedReplica = await win.webContents.executeJavaScript(
      'window.__moorFixture.selection()',
    );
    assert.equal(selectedReplica.scope.source, 'remote');
    assert.equal(selectedReplica.scope.target.deviceId, 'other-device');
    assert.equal(selectedReplica.scope.target.localProjectId, 'project-0');
    assert.equal(selectedReplica.sessionId, 'session-2');
    await win.webContents.executeJavaScript(
      `document.querySelector('[aria-label="搜索会话"]').click();const input=document.querySelector('[aria-label="筛选当前工作区会话"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Mac mini');input.dispatchEvent(new Event('input',{bubbles:true}));`,
    );
    await win.webContents.executeJavaScript(
      `new Promise(resolve=>{const check=()=>{const rows=[...document.querySelectorAll('.workspace-recent .workspace-session-context')];if(rows.length===2&&rows.every(row=>row.textContent==='Mac mini')){observer.disconnect();resolve();}};const observer=new MutationObserver(check);observer.observe(document,{subtree:true,childList:true,attributes:true});check();})`,
    );
    assert(
      await win.webContents.executeJavaScript(
        `window.__moorFixture.pageReads.some(read=>read.projectId==='project-0'&&read.query===''&&read.limit===30)`,
      ),
      'computer-name matches load only bounded summaries',
    );
    await shot('computer-search');
    await win.loadURL(url);
    await wait('.workspace-history');
    await win.webContents.executeJavaScript('window.__moorFixture.newConversation()');
    await wait('.workspace-welcome');
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.querySelector('.workspace-menu-environment').hidden",
      ),
      true,
    );
    await shot('new-conversation');
    assert.deepEqual(
      await read(
        `[...document.querySelectorAll('.workspace-welcome-suggestions button')].map(button => button.textContent.trim())`,
      ),
      ['了解项目', '规划任务', '检查改动'],
    );
    let previousSuggestion = '';
    for (const label of ['了解项目', '规划任务', '检查改动']) {
      await input('[aria-label="消息"]', '');
      await read(
        `[...document.querySelectorAll('.workspace-welcome-suggestions button')].find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`,
      );
      await frames();
      const suggestion = await read(`document.querySelector('[aria-label="消息"]').value`);
      assert(
        suggestion.trim() && suggestion !== previousSuggestion,
        'suggestions populate a distinct editable draft',
      );
      assert.equal(await read(`document.activeElement.getAttribute('aria-label')`), '消息');
      assert.equal(
        await read(
          `[...document.querySelectorAll('.workspace-welcome-suggestions button')].every(button => button.disabled)`,
        ),
        true,
        'suggestions cannot overwrite an existing draft',
      );
      assert.equal(
        await read(`window.__moorFixture.calls.includes('send')`),
        false,
        'suggestions never submit work',
      );
      previousSuggestion = suggestion;
    }
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
    await win.loadURL(url);
    await wait('.workspace-history');
    await input('[aria-label="消息"]', '中文输入确认测试');
    await wait('.workspace-composer button[type="submit"]:not(:disabled)');
    await read(
      `(() => { const input = document.querySelector('[aria-label="消息"]'); input.dispatchEvent(new CompositionEvent('compositionstart', {data: '中文', bubbles: true})); input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, bubbles: true})); input.dispatchEvent(new CompositionEvent('compositionend', {data: '中文', bubbles: true})); input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', ctrlKey: true, keyCode: 229, bubbles: true})); })()`,
    );
    await frames();
    assert.equal(
      await read(`window.__moorFixture.calls.includes('send')`),
      false,
      'IME confirmation, Enter for a newline, and keyCode 229 never submit',
    );
    await shortcut('Enter', 'ctrlKey');
    await until(`window.__moorFixture.calls.filter(call => call === 'send').length === 1`);
    await input('[aria-label="消息"]', '');
    const shortInputHeight = await read(
      `document.querySelector('[aria-label="消息"]').getBoundingClientRect().height`,
    );
    await input(
      '[aria-label="消息"]',
      Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行：合成多行草稿`).join('\n'),
    );
    const expandedInput = await read(
      `(() => { const input = document.querySelector('[aria-label="消息"]'); return {height: input.getBoundingClientRect().height, viewport: innerHeight, scroll: input.scrollHeight > input.clientHeight, overflow: getComputedStyle(input).overflowY}; })()`,
    );
    assert(
      expandedInput.height > shortInputHeight,
      JSON.stringify({ shortInputHeight, expandedInput }),
    );
    assert(
      expandedInput.height <= Math.min(240, expandedInput.viewport * 0.32) + 1,
      JSON.stringify(expandedInput),
    );
    assert.equal(expandedInput.scroll, true, 'long drafts scroll inside a bounded composer');
    assert.notEqual(expandedInput.overflow, 'hidden');
    await input('[aria-label="消息"]', '简短草稿');
    assert(
      (await read(`document.querySelector('[aria-label="消息"]').getBoundingClientRect().height`)) <
        expandedInput.height,
      'composer shrinks when text is removed',
    );
    await read('window.__moorFixture.longConversation()');
    await until(
      `document.querySelector('.workspace-history').scrollHeight > document.querySelector('.workspace-history').clientHeight`,
    );
    await frames();
    const composerMinHeight = await read(
      `document.querySelector('.workspace-input-box').style.minHeight`,
    );
    const tallDraft = Array.from({ length: 12 }, (_, index) => `连续输入第 ${index + 1} 行`).join(
      '\n',
    );
    await input('[aria-label="消息"]', tallDraft);
    for (let index = 0; index < 12; index++) {
      await input('[aria-label="消息"]', tallDraft + '\n追加文字 ' + index);
      assert.equal(
        await read(`!!document.querySelector('.session-jump-latest')`),
        false,
        'measuring a tall draft does not mistake browser scroll clamping for reading history',
      );
      assert.equal(
        await read(`document.querySelector('.workspace-input-box').style.minHeight`),
        composerMinHeight,
        'temporary composer sizing is restored after each measurement',
      );
    }
    for (const draft of ['短', '', '简短草稿']) {
      await input('[aria-label="消息"]', draft);
      await until(
        `(() => { const history = document.querySelector('.workspace-history'); return history.scrollHeight - history.scrollTop - history.clientHeight < 2; })()`,
      );
      assert.equal(await read(`!!document.querySelector('.session-jump-latest')`), false);
      assert.equal(
        await read(`document.querySelector('.workspace-input-box').style.minHeight`),
        composerMinHeight,
      );
    }
    await read(
      `const history = document.querySelector('.workspace-history'); history.scrollTop = 0; history.dispatchEvent(new Event('scroll'));`,
    );
    await wait('.session-jump-latest');
    const readingPosition = await read(`document.querySelector('.workspace-history').scrollTop`);
    await input('[aria-label="消息"]', tallDraft);
    await input('[aria-label="消息"]', '简短草稿');
    assert.equal(
      await read(`document.querySelector('.workspace-history').scrollTop`),
      readingPosition,
      'draft growth and shrinkage preserve an intentional history reading position',
    );
    await read('window.__moorFixture.appendMessage()');
    await frames();
    assert.equal(
      await read(`document.querySelector('.workspace-history').scrollTop`),
      readingPosition,
      'new messages preserve the user reading older history',
    );
    await shot('reading-history');
    await read(`document.querySelector('.session-jump-latest').click()`);
    await until(
      `(() => { const history = document.querySelector('.workspace-history'); return history.scrollHeight - history.scrollTop - history.clientHeight < 2; })()`,
    );
    assert.equal(await read(`!!document.querySelector('.session-jump-latest')`), false);
    assert(
      await read(
        `(() => { const history = document.querySelector('.workspace-history').getBoundingClientRect(); const text = [...document.querySelectorAll('.session-message-text')].at(-1); const range = document.createRange(); range.selectNodeContents(text); const row = [...range.getClientRects()].at(-1); return row.bottom > history.top && row.top < history.bottom; })()`,
      ),
      'the newest appended message is visible after restoring follow',
    );
    assert.equal(await read(`document.querySelector('[aria-label="消息"]').value`), '简短草稿');
    await read('window.__moorFixture.beginColdSession()');
    await wait('.workspace-session-loading[aria-busy="true"]');
    assert.equal(
      await read(
        `!!document.querySelector('.workspace-conversation textarea, .workspace-conversation [contenteditable="true"]')`,
      ),
      false,
      'a cold navigation removes the previous editable draft immediately',
    );
    assert.equal(
      await read(`!!document.querySelector('.workspace-session-loading img')`),
      false,
      'the initial loading boundary does not flash a spinner',
    );
    await read('window.__moorFixture.showColdSessionIndicator()');
    await wait('.workspace-session-loading img');
    await read('window.__moorFixture.finishColdSession()');
    await wait('[aria-label="消息"]');
    assert.equal(
      await read(`document.querySelector('[aria-label="消息"]').value`),
      '新会话独立草稿',
    );
    await read('window.__moorFixture.cachedRun()');
    await wait('.session-timeline-shell[data-live="false"] .session-item-running');
    assert.equal(
      await read(`document.querySelector('.session-turn-progress').textContent.trim()`),
      '缓存执行状态',
    );
    assert.equal(
      await read(
        `document.querySelector('.session-item-running .session-item-status').textContent.trim()`,
      ),
      '上次执行中',
    );
    assert.equal(
      await read(`document.querySelector('.workspace-compose-submit').disabled`),
      true,
      'cached running state cannot authorize a stop or send',
    );
    await shot('cached-run');
    win.setContentSize(390, 760);
    await win.loadURL(url);
    await wait('.workspace-history');
    await shot('narrow');
    await toolbarRow();
    const narrowOverflow = await win.webContents.executeJavaScript(
      'document.documentElement.scrollWidth>innerWidth',
    );
    assert.equal(narrowOverflow, false);
    {
      win.show();
      win.focus();
      win.webContents.focus();
      await bounded(
        new Promise((resolve) => {
          if (win.isFocused()) resolve();
          else win.once('focus', resolve);
        }),
        'test window focus',
      );
      win.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: 'K',
        modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
      });
      win.webContents.sendInputEvent({
        type: 'keyUp',
        keyCode: 'K',
        modifiers: [process.platform === 'darwin' ? 'meta' : 'control'],
      });
      await wait('.workspace-app[data-navigation="open"]');
      await until(`document.activeElement.getAttribute('aria-label') === '筛选当前工作区会话'`);
      win.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
      await until(`document.querySelector('[aria-label="筛选当前工作区会话"]').value === 'x'`);
      await shot('narrow-navigation');
      assert.equal(
        await win.webContents.executeJavaScript("document.querySelector('.workspace-body').inert"),
        true,
      );
      await read(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', isComposing: true, keyCode: 229, bubbles: true}))`,
      );
      await frames();
      assert.equal(
        await read(`document.querySelector('[aria-label="筛选当前工作区会话"]').value`),
        'x',
      );
      assert.equal(
        await read(`document.querySelector('.workspace-app').dataset.navigation`),
        'open',
      );
      await escape();
      assert.equal(
        await read(`document.querySelector('[aria-label="筛选当前工作区会话"]').value`),
        '',
      );
      await escape();
      assert.equal(await read(`document.activeElement.getAttribute('aria-label')`), '搜索会话');
      await escape();
      await wait('.workspace-app[data-navigation="closed"]');
      assert.equal(await read(`document.querySelector('.workspace-body').inert`), false);

      await read('window.__moorFixture.activeSteer()');
      await input('[aria-label="消息"]', '请保留目前改动，再补充边界验证。');
      await until(`!document.querySelector('.workspace-compose-steer').disabled`);
      assert.equal(
        await read(`document.querySelector('.workspace-compose-submit').disabled`),
        false,
      );
      assert.match(
        await read(`document.querySelector('.workspace-compose-submit').textContent`),
        /停止/,
      );
      await toolbarRow(5);
      assert.equal(await read('document.documentElement.scrollWidth > innerWidth'), false);
      await shot('narrow-active-steer');

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
      JSON.stringify(
        { ...metrics, narrowOverflow, composerLayout, dockLayout, expandedInput, errors },
        null,
        2,
      ),
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
