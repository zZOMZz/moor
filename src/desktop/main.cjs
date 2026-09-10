const { app, BrowserWindow, ipcMain, dialog, Menu, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { ProcessRecovery } = require('./recovery.cjs');
const { loadPage, clearLocalShellCache } = require('./page-loader.cjs');
const { pathToFileURL } = require('node:url');
app.setName('Moor');
const customDataDir = process.env.MOOR_DESKTOP_DATA_DIR ?? process.env.PERSONAL_DESKTOP_DATA_DIR;
if (customDataDir) app.setPath('userData', path.resolve(customDataDir));
// Reuse the MVP's data directory when upgrading; browser cache ids and IPC cookie names also stay compatible.
if (!customDataDir && !fs.existsSync(app.getPath('userData'))) {
  const previous = ['lody-personal', 'Lody Personal']
    .map((n) => path.join(app.getPath('appData'), n))
    .find((p) => fs.existsSync(path.join(p, 'settings.json')));
  if (previous) app.setPath('userData', previous);
}
const data = app.getPath('userData');
fs.mkdirSync(data, { recursive: true, mode: 0o700 });
const settingsFile = path.join(data, 'settings.json'),
  bridgeFile = path.join(data, 'bridge-v3.json'),
  runtimeData = path.join(data, 'runtime-v1.sqlite');
let settings = { server: '', name: os.hostname(), projects: [], agents: ['codex'] };
try {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
} catch {}
let settingsWindow,
  localWindow,
  remoteWindow,
  bridge,
  quitting = false,
  localOrigin = '',
  bridgeStatus = '正在启动',
  hostStatus = { state: 'starting', message: '正在启动本机执行组件', attempt: 0 },
  bridgeHealth = { local: 'unavailable', relay: 'unpaired', workspaces: 0 },
  recovering = false,
  restart;
let requestedView = 'local';
const contentRoot = path.join(__dirname, 'runtime');
const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  MOOR_RUNTIME_DATA: runtimeData,
};
const write = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
function endpoint(value) {
  if (!value) return '';
  const u = new URL(value);
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  )
    throw new Error('远程服务需要 HTTPS 地址');
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/')
    throw new Error('请填写服务根地址，例如 https://moor.example.com');
  return u.origin;
}
function lockedWindow(origin, partition) {
  const window = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 720,
    minHeight: 550,
    title: 'Moor',
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  return window;
}
function openPage(window, origin) {
  loadPage(window, origin, () => {
    void dialog
      .showMessageBox(window, {
        type: 'warning',
        title: 'Moor 页面未能打开',
        message: '页面加载失败或超时',
        detail: '可以重试加载，或打开连接设置检查本机执行组件与中转连接。',
        buttons: ['连接设置', '重试加载'],
        defaultId: 0,
        cancelId: 0,
      })
      .then(({ response }) => {
        if (window.isDestroyed()) return;
        if (response === 1) openPage(window, origin);
        else showSettings();
      });
  });
}
function showLocal() {
  requestedView = 'local';
  if (!localOrigin) {
    showSettings();
    return;
  }
  if (localWindow && !localWindow.isDestroyed()) {
    localWindow.show();
    return;
  }
  localWindow = lockedWindow(localOrigin, 'persist:personal-local');
  localWindow.on('closed', () => {
    localWindow = null;
  });
  openPage(localWindow, localOrigin);
}
function showRemote() {
  requestedView = 'remote';
  if (!settings.server) {
    showSettings();
    return;
  }
  if (remoteWindow && !remoteWindow.isDestroyed()) {
    remoteWindow.show();
    return;
  }
  remoteWindow = lockedWindow(settings.server, 'persist:personal-remote');
  remoteWindow.on('closed', () => {
    remoteWindow = null;
  });
  openPage(remoteWindow, settings.server);
}
function showSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 680,
    height: 890,
    minHeight: 640,
    title: '连接设置 · Moor',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  void settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
}
function trusted(event) {
  if (
    !settingsWindow ||
    event.sender !== settingsWindow.webContents ||
    event.senderFrame !== settingsWindow.webContents.mainFrame ||
    event.senderFrame.url !== pathToFileURL(path.join(__dirname, 'settings.html')).href
  )
    throw new Error('无效的本机设置请求');
}
function health() {
  const localReady = !!localOrigin && bridgeHealth.local === 'ready' && !!bridge;
  const remoteLabels = {
    unpaired: '尚未配对。登录个人服务后，使用“添加电脑”的配对码连接。',
    connected: '中转链路已连接。手机和其他电脑可以访问在线工作区。',
    reconnecting: '中转服务不可达，正在重连。本机任务可以继续，远程草稿不会自动发送。',
    revoked: '设备授权失效或被其他连接替换，请获取新的配对码。',
  };
  return {
    host: hostStatus,
    local: {
      state: localReady ? 'ready' : 'unavailable',
      message: localReady
        ? `本机工作区已就绪（${bridgeHealth.workspaces} 个）`
        : bridgeStatus || '等待本机执行组件',
    },
    relay: {
      state: bridgeHealth.relay,
      message: remoteLabels[bridgeHealth.relay] ?? remoteLabels.unpaired,
    },
    recovering,
  };
}
function startBridge() {
  const args = [
    path.join(contentRoot, 'bridge.mjs'),
    '--desktop',
    '--config',
    bridgeFile,
    '--public-dir',
    path.join(contentRoot, 'public'),
    '--name',
    settings.name,
  ];
  args.push('--server', settings.server);
  for (const p of settings.projects) args.push('--project', p);
  for (const a of settings.agents) args.push('--builtin-agent', a);
  const child = spawn(process.execPath, args, {
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  bridge = child;
  bridgeStatus = '正在连接本机执行组件';
  bridgeHealth = {
    local: 'unavailable',
    relay: settings.server ? 'reconnecting' : 'unpaired',
    workspaces: 0,
  };
  child.stderr.on('data', () => {}); // Do not surface raw process logs or local secrets in settings.
  child.on('message', async (message) => {
    if (bridge !== child) return;
    if (message?.type === 'health') {
      if (
        ['ready', 'unavailable'].includes(message.local) &&
        ['unpaired', 'connected', 'reconnecting', 'revoked'].includes(message.relay)
      ) {
        bridgeHealth = {
          local: message.local,
          relay: message.relay,
          workspaces: Number(message.workspaces) || 0,
        };
        if (message.local === 'ready') hostRecovery.ready();
        hostStatus = {
          state: message.local === 'ready' ? 'ready' : 'starting',
          message: message.local === 'ready' ? '本机执行服务已就绪' : '等待本机执行服务',
          attempt: 0,
        };
        bridgeStatus = message.local === 'ready' ? '本机工作区已就绪' : '等待本机执行组件恢复连接';
      }
      return;
    }
    if (message?.type !== 'local-ready') return;
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(message.origin) || typeof message.secret !== 'string')
      return;
    localOrigin = message.origin;
    // The application ships its own local UI. Clear only replaceable shell
    // caches, never cookies/IndexedDB where login, drafts and pending requests live.
    try {
      await clearLocalShellCache(session.fromPartition('persist:personal-local'), localOrigin);
    } catch {
      bridgeStatus = '本机界面缓存更新失败，请重新打开 Moor。';
      showSettings();
      return;
    }
    await session.fromPartition('persist:personal-local').cookies.set({
      url: localOrigin,
      name: 'personal',
      value: message.secret,
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
    });
    if (bridge !== child) return;
    bridgeStatus = '本机界面已启动，等待执行组件';
    if (localWindow && !localWindow.isDestroyed()) openPage(localWindow, localOrigin);
    else if (requestedView === 'local') showLocal();
  });
  child.on('error', (e) => {
    bridgeStatus = '连接组件启动失败，请重新连接。';
  });
  child.on('exit', () => {
    if (bridge !== child) return;
    bridge = null;
    localOrigin = '';
    bridgeHealth.local = 'unavailable';
    bridgeHealth.relay = settings.server ? 'reconnecting' : 'unpaired';
    bridgeStatus = '连接组件已退出，正在重新启动';
    // ProcessRecovery owns bounded retries; never replay a pending turn.
  });
  return child;
}
function makeRecovery() {
  return new ProcessRecovery({
    launch: startBridge,
    onState: (state) => {
      hostStatus = state;
    },
  });
}
let hostRecovery = makeRecovery();
let restartChain = Promise.resolve();
function restartBridge() {
  const task = restartChain.then(restartBridgeOnce);
  restartChain = task.catch(() => {});
  return task;
}
async function restartBridgeOnce() {
  hostRecovery.stop();
  clearTimeout(restart);
  localOrigin = '';
  const old = bridge;
  bridge = null;
  if (old && old.exitCode === null && old.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => old.kill('SIGKILL'), 5000);
      old.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      old.kill('SIGTERM');
    });
  }
  hostRecovery = makeRecovery();
  hostRecovery.start();
}
ipcMain.handle('personal:settings', (event) => {
  trusted(event);
  return {
    ...settings,
    status: hostStatus.message,
    health: health(),
    paired: fs.existsSync(bridgeFile),
  };
});
ipcMain.handle('personal:health', (event) => {
  trusted(event);
  return health();
});
ipcMain.handle('personal:recover', async (event) => {
  trusted(event);
  if (recovering) return health();
  recovering = true;
  try {
    await restartBridge();
    return health();
  } finally {
    recovering = false;
  }
});
ipcMain.handle('personal:project', async (event) => {
  trusted(event);
  const result = await dialog.showOpenDialog(settingsWindow, {
    properties: ['openDirectory'],
    title: '选择本机项目',
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('personal:save', async (event, value) => {
  trusted(event);
  const server = endpoint(String(value.server ?? '').trim()),
    name = String(value.name ?? '').trim();
  if (!name || name.length > 100) throw new Error('请输入电脑名称');
  if (
    !Array.isArray(value.projects) ||
    value.projects.length > 100 ||
    value.projects.some(
      (p) => typeof p !== 'string' || !path.isAbsolute(p) || !fs.statSync(p).isDirectory(),
    )
  )
    throw new Error('项目目录无效');
  const agents = value.agents;
  if (
    !Array.isArray(agents) ||
    !agents.length ||
    agents.some((a) => !['codex', 'claude'].includes(a))
  )
    throw new Error('请选择 Agent');
  const code = String(value.code ?? '').trim();
  if (code) {
    if (!server) throw new Error('请先填写服务地址');
    const response = await fetch(new URL('/api/pair/redeem', server), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + code },
      body: JSON.stringify({ code, name }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '配对失败');
    write(bridgeFile, { server, ...result });
  }
  const changed = settings.server !== server;
  settings = { server, name, projects: [...new Set(value.projects)], agents: [...new Set(agents)] };
  write(settingsFile, settings);
  if (changed && remoteWindow) {
    remoteWindow.close();
    remoteWindow = null;
  }
  await restartBridge();
  return { ok: true, paired: Boolean(code) };
});
ipcMain.handle('personal:open', async (event, mode) => {
  trusted(event);
  mode === 'remote' ? showRemote() : showLocal();
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showLocal);
  app.whenReady().then(() => {
    for (const partition of ['persist:personal-local', 'persist:personal-remote']) {
      const s = session.fromPartition(partition);
      s.setPermissionRequestHandler((_, __, callback) => callback(false));
      s.setPermissionCheckHandler(() => false);
      s.on('will-download', (event) => event.preventDefault());
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Moor',
          submenu: [
            { label: '本机工作区', click: showLocal },
            { label: '我的所有电脑', click: showRemote },
            { label: '连接设置…', accelerator: 'CmdOrCtrl+,', click: showSettings },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        {
          label: '窗口',
          submenu: [
            {
              label: '刷新页面',
              accelerator: 'CmdOrCtrl+R',
              click: () => BrowserWindow.getFocusedWindow()?.webContents.reload(),
            },
            { role: 'minimize' },
            { role: 'close' },
          ],
        },
      ]),
    );
    hostRecovery.start();
    showLocal();
  });
  app.on('activate', showLocal);
  // Closing a window leaves the execution host alive; explicit Quit stops this app's processes.
  app.on('window-all-closed', () => {});
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    clearTimeout(restart);
    hostRecovery.stop();
  });
}
