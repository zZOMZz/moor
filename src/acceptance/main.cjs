const { app, BrowserWindow, WebContentsView, ipcMain, nativeTheme } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { prepareScene } = require('./browser.cjs');

// A separate developer entry point. It never opens Moor's normal settings,
// browser profile, host database, credentials, or a real coding Agent.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'moor-acceptance-'));
fs.chmodSync(profile, 0o700);
app.setName('Moor 验收');
app.setPath('userData', path.join(profile, 'browser'));
nativeTheme.themeSource = 'light';
const workbenchURL = pathToFileURL(path.join(__dirname, 'workbench.html')).href;
const live = new Map();
let window,
  controller,
  quitting = false;
let bounds = { x: 360, y: 124, width: 820, height: 740 };

function trusted(event) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== workbenchURL
  )
    throw new Error('无效的本机验收请求。');
}
function layout(snapshot = controller?.snapshot()) {
  if (!window || window.isDestroyed()) return;
  const [width, height] = window.getContentSize();
  for (const [id, item] of live) {
    const visible = snapshot?.run?.id === id && snapshot.run.status === 'ready';
    const x = Math.max(0, Math.min(Math.round(bounds.x), width - item.scene.width));
    const y = Math.max(0, Math.min(Math.round(bounds.y), height - item.scene.height));
    item.view.setBounds({ x, y, width: item.scene.width, height: item.scene.height });
    item.view.setVisible(visible);
  }
}
function changed(snapshot) {
  layout(snapshot);
  if (snapshot.run) {
    // Synthetic local task records deliberately live outside the source tree.
    fs.writeFileSync(
      path.join(profile, snapshot.run.id + '.json'),
      JSON.stringify({ schemaVersion: 1, ...snapshot.run }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
  if (window && !window.isDestroyed()) window.webContents.send('acceptance:changed', snapshot);
}

app
  .whenReady()
  .then(async () => {
    const { AcceptanceController, snapshotBuild, createAcceptanceFixture } = await import(
      pathToFileURL(path.resolve(__dirname, '../../dist/acceptance/runtime.mjs')).href
    );
    window = new BrowserWindow({
      width: 1280,
      height: 960,
      minWidth: 1240,
      minHeight: 940,
      useContentSize: true,
      title: 'Moor · 验收现场',
      backgroundColor: '#f6f8f5',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const [outerWidth, outerHeight] = window.getSize();
    const [contentWidth, contentHeight] = window.getContentSize();
    window.setMinimumSize(1240 + outerWidth - contentWidth, 940 + outerHeight - contentHeight);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_, __, done) => done(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.on('will-download', (event) => event.preventDefault());
    window.webContents.session.webRequest.onBeforeRequest((details, done) => {
      const allowed = [
        workbenchURL,
        pathToFileURL(path.join(__dirname, 'workbench.css')).href,
        pathToFileURL(path.join(__dirname, 'workbench.js')).href,
      ];
      done({ cancel: !allowed.includes(details.url) });
    });

    controller = new AcceptanceController({
      changed,
      async prepare(scene, id, signal, stage) {
        const directory = await fsp.mkdtemp(path.join(profile, 'scene-'));
        let fixture,
          view,
          disposed = false;
        const dispose = async () => {
          if (disposed) return;
          disposed = true;
          signal.removeEventListener('abort', abort);
          live.delete(id);
          if (view) {
            if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
            if (!view.webContents.isDestroyed()) view.webContents.close();
          }
          await fixture?.close();
          await fsp.rm(directory, { recursive: true, force: true });
        };
        const abort = () => {
          if (view && !view.webContents.isDestroyed()) view.webContents.close();
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          stage('正在固定本次验收的界面构建');
          const publicDir = path.join(directory, 'public');
          const buildId = await snapshotBuild(
            path.resolve(__dirname, '../../dist/public'),
            publicDir,
          );
          signal.throwIfAborted();
          stage('正在启动合成工作区');
          fixture = await createAcceptanceFixture({
            publicDir,
            dataDir: path.join(directory, 'fixture'),
          });
          signal.throwIfAborted();
          view = new WebContentsView({
            webPreferences: {
              partition: 'acceptance-' + id,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              backgroundThrottling: false,
            },
          });
          const contents = view.webContents,
            session = contents.session;
          session.setPermissionRequestHandler((_, __, done) => done(false));
          session.setPermissionCheckHandler(() => false);
          session.on('will-download', (event) => event.preventDefault());
          const permitted = (url) => {
            try {
              const candidate = new URL(url);
              return (
                candidate.origin === fixture.origin ||
                candidate.origin === fixture.origin.replace('http:', 'ws:')
              );
            } catch {
              return false;
            }
          };
          session.webRequest.onBeforeRequest((details, done) =>
            done({ cancel: !permitted(details.url) }),
          );
          contents.setWindowOpenHandler(() => ({ action: 'deny' }));
          for (const eventName of ['will-navigate', 'will-redirect'])
            contents.on(eventName, (event, url) => {
              if (!permitted(url)) event.preventDefault();
            });
          await session.cookies.set({
            url: fixture.origin,
            name: 'personal',
            value: fixture.secret,
            httpOnly: true,
            sameSite: 'strict',
          });
          signal.throwIfAborted();
          window.contentView.addChildView(view);
          live.set(id, { view, fixture, scene, dispose, directory });
          layout();
          stage('正在打开页面并准备操作位置');
          await contents.loadURL(fixture.origin);
          signal.throwIfAborted();
          await prepareScene(contents, scene);
          signal.throwIfAborted();
          const sessionId = {
            'narrow-dialog': 'acceptance-modal',
            'settings-save': 'acceptance-settings',
            'session-drawer': 'acceptance-session',
          }[scene.id];
          return { buildId, scope: { ...fixture.scope, sessionId }, dispose };
        } catch (error) {
          await dispose();
          throw error;
        }
      },
    });
    ipcMain.handle('acceptance:snapshot', (event) => {
      trusted(event);
      return controller.snapshot();
    });
    ipcMain.handle('acceptance:command', (event, command) => {
      trusted(event);
      return controller.command(command);
    });
    ipcMain.on('acceptance:bounds', (event, value) => {
      try {
        trusted(event);
        if (
          !value ||
          !['x', 'y', 'width', 'height'].every(
            (key) => Number.isFinite(value[key]) && value[key] >= 0 && value[key] < 10000,
          )
        )
          return;
        bounds = value;
        layout();
      } catch {
        /* Untrusted frames cannot place native views. */
      }
    });
    window.on('resize', () => layout());
    await window.loadURL(workbenchURL);
    console.log('Moor 验收现场已打开。本次合成验收记录：' + profile);
    if (process.argv.includes('--check')) {
      await require('./check.cjs').check({ window, controller, live, profile });
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
    app.quit();
  });
app.on('window-all-closed', () => app.quit());
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void controller
    ?.close()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => app.exit(process.exitCode ?? 0));
  if (!controller) app.exit(process.exitCode ?? 0);
});
