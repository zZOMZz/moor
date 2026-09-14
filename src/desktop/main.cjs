const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  session,
  Notification,
  shell,
  protocol,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { ProcessRecovery } = require('./recovery.cjs');
const { loadPage, clearLocalShellCache } = require('./page-loader.cjs');
const { pathToFileURL } = require('node:url');
const {
  DesktopNotifications,
  notificationSettings,
  validateSettings,
  validateEvent,
} = require('./notifications.cjs');
const { createAttachmentSaver } = require('./attachment-save.cjs');
const { DesktopGitHubSettings } = require('./github-settings.cjs');
const { DesktopPreviewSettings } = require('./preview-settings.cjs');
const { DesktopSkillsSettings } = require('./skills-settings.cjs');
const { DesktopAgentSettings } = require('./agent-settings.cjs');
const { DesktopMcpSettings } = require('./mcp-settings.cjs');
const {
  DesktopDeviceMetadata,
  publicState: deviceMetadataState,
} = require('./device-metadata.cjs');
const { DesktopGoogleAuth } = require('./google-auth.cjs');
const { DesktopSecureBridge } = require('./secure-client.cjs');
const { DesktopProjectRegistration } = require('./project-registration.cjs');
const { DesktopWorkspaceBridge } = require('./workspace-bridge.cjs');
const { DesktopLegacyCache } = require('./legacy-cache.cjs');
const { DesktopSecureAccount } = require('./secure-account.cjs');
const {
  CLIENT_SCHEME,
  CLIENT_PRIVILEGES,
  CLIENT_URL,
  CLIENT_ORIGIN,
} = require('./client-assets.cjs');
const {
  CLIENT_PARTITION,
  prepareClientSession,
  createClientWindow,
} = require('./client-window.cjs');
protocol.registerSchemesAsPrivileged([{ scheme: CLIENT_SCHEME, privileges: CLIENT_PRIVILEGES }]);
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
  runtimeData = path.join(data, 'runtime-v1.sqlite'),
  notificationsFile = path.join(data, 'notifications-v1.json');
const CODEX_INSTALL_URL = 'https://learn.chatgpt.com/docs/codex/cli';
let settings = { server: '', name: os.hostname(), projects: [], agents: ['codex'] };
try {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
} catch {}
settings.agents = Array.isArray(settings.agents)
  ? settings.agents.includes('codex')
    ? ['codex']
    : []
  : ['codex'];
settings.notifications = notificationSettings(settings.notifications);
let settingsWindow,
  secureWindow,
  bridge,
  quitting = false,
  localOrigin = '',
  bridgeStatus = '正在启动',
  hostStatus = { state: 'starting', message: '正在启动本机执行组件', attempt: 0 },
  bridgeHealth = { local: 'unavailable', relay: 'unpaired', workspaces: 0 },
  cliUnavailable = false,
  recovering = false,
  restart;
let requestedView = 'local';
let requestedNotification = null;
let navigationRevision = 0;
let localReadyGeneration = 0,
  localReadyChain = Promise.resolve();
const githubSettings = new DesktopGitHubSettings({ bridge: () => bridge });
const previewSettings = new DesktopPreviewSettings({ bridge: () => bridge });
const skillsSettings = new DesktopSkillsSettings({ bridge: () => bridge });
const agentSettings = new DesktopAgentSettings({ bridge: () => bridge });
const mcpSettings = new DesktopMcpSettings({ bridge: () => bridge });
const deviceMetadata = new DesktopDeviceMetadata({ bridge: () => bridge });
const projectRegistration = new DesktopProjectRegistration({ bridge: () => bridge });
let deviceNameState;
let localConnection;
const contentRoot = path.join(__dirname, 'runtime');
const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  MOOR_RUNTIME_DATA: runtimeData,
};
const write = (file, value) => {
  const temporary = file + '.tmp-' + require('node:crypto').randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
};
const contentWindows = new Map();
const workspaceClient = new DesktopWorkspaceBridge({
  registry: contentWindows,
  window: () => secureWindow,
  local: () => (!quitting && bridge?.connected ? localConnection : undefined),
  origin: () => settings.server,
  loadRuntime: () => import(pathToFileURL(path.join(contentRoot, 'workspace-client.mjs')).href),
});
const legacyCache = new DesktopLegacyCache({
  workspace: workspaceClient,
  BrowserWindow,
  ipcMain,
  sessionFor: (source) =>
    session.fromPartition(
      source === 'local' ? 'persist:personal-local' : 'persist:personal-remote',
    ),
  preloadPath: path.join(__dirname, 'legacy-cache-preload.cjs'),
  loadRuntime: () => import(pathToFileURL(path.join(contentRoot, 'workspace-client.mjs')).href),
});
const secureClient = new DesktopSecureBridge({
  registry: contentWindows,
  remoteWindow: () => secureWindow,
  origin: () => settings.server,
  endpointPath: () => {
    const directory = path.join(data, '.moor-security');
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    return path.join(directory, 'desktop-client.json');
  },
  loadRuntime: () => import(pathToFileURL(path.join(contentRoot, 'desktop-client.mjs')).href),
});
const secureGoogleAuth = new DesktopGoogleAuth({
  registry: contentWindows,
  remoteWindow: () => secureWindow,
  origin: () => settings.server,
  openExternal: (url) => shell.openExternal(url),
  confirm: (window, options) => dialog.showMessageBox(window, options),
});
const secureAccount = new DesktopSecureAccount({
  registry: contentWindows,
  remoteWindow: () => secureWindow,
  origin: () => settings.server,
  onInvalidate: (contents) => {
    workspaceClient.invalidate(contents, 'remote');
    secureClient.invalidate(contents);
    secureGoogleAuth.invalidate(contents);
    return secureGoogleAuth.cookieWrites;
  },
});
const attachmentSaver = createAttachmentSaver({
  registry: contentWindows,
  showSaveDialog: (window, options) => dialog.showSaveDialog(window, options),
  downloads: () => app.getPath('downloads'),
});
const nativeNotifications = new DesktopNotifications({
  Notification,
  load: () => {
    try {
      return JSON.parse(fs.readFileSync(notificationsFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  },
  save: (value) => write(notificationsFile, value),
  getSettings: () => settings.notifications,
  onClick: (event) => showLocal(event),
});
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
function openPage(window, origin) {
  const registered = contentWindows.get(window.webContents);
  if (registered?.trustedClient !== true || origin !== CLIENT_URL) return;
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
function showLocal(event) {
  requestedView = 'local';
  navigationRevision++;
  if (event) requestedNotification = validateEvent(event);
  return showSecure().then(notifyWorkspaceChanged);
}
function showRemote() {
  requestedView = 'remote';
  navigationRevision++;
  return showSecure().then(notifyWorkspaceChanged);
}
function notifyWorkspaceChanged() {
  if (secureWindow && !secureWindow.isDestroyed())
    secureWindow.webContents.send('moor:workspace-changed');
}
let clientPreparation;
async function showSecure() {
  const origin = settings.server;
  try {
    const clientSession = session.fromPartition(CLIENT_PARTITION);
    clientPreparation ??= prepareClientSession(clientSession, path.join(contentRoot, 'public'));
    await clientPreparation;
    if (quitting || settings.server !== origin) return;
    if (secureWindow && !secureWindow.isDestroyed()) {
      secureWindow.show();
      secureWindow.focus();
      return;
    }
    const window = createClientWindow({
      BrowserWindow,
      session: clientSession,
      origin,
      preloadPath: path.join(__dirname, 'secure-preload.cjs'),
      registry: contentWindows,
      invalidate: (contents) => {
        workspaceClient.invalidate(contents);
        secureClient.invalidate(contents);
        secureAccount.invalidate(contents);
        secureGoogleAuth.invalidate(contents);
        attachmentSaver.invalidate(contents);
      },
    });
    secureWindow = window;
    window.on('closed', () => {
      if (secureWindow === window) secureWindow = null;
    });
    openPage(window, CLIENT_URL);
  } catch {
    void dialog.showMessageBox({
      type: 'error',
      title: 'Moor 工作区未能打开',
      message: '安装包中的可信客户端资源不可用，请重新安装当前版本。',
    });
  }
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
    githubSettings.invalidate();
    previewSettings.invalidate();
    skillsSettings.invalidate();
    agentSettings.invalidate();
    deviceMetadata.invalidate();
    mcpSettings.invalidate();
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
    unavailable: '远程连接暂不可用。本机任务可以继续；请检查连接后手动核查原操作。',
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
    notifications: nativeNotifications.state(),
    ...(deviceNameState ? { deviceMetadata: deviceNameState } : {}),
    ...(cliUnavailable
      ? {
          cli: {
            state: 'unavailable',
            message:
              '本机 CLI 不可用：请将私有配置目录移到项目和程序发行目录外，并确保仅本用户可写。本机界面仍可使用。',
          },
        }
      : {}),
  };
}
function startBridge() {
  localConnection = undefined;
  workspaceClient.invalidate(undefined, 'local');
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
  cliUnavailable = false;
  bridgeStatus = '正在连接本机执行组件';
  bridgeHealth = {
    local: 'unavailable',
    relay: settings.server ? 'reconnecting' : 'unpaired',
    workspaces: 0,
  };
  child.stderr.on('data', () => {}); // Do not surface raw process logs or local secrets in settings.
  child.on('message', async (message) => {
    if (bridge !== child) return;
    if (message?.type === 'cli-unavailable') {
      cliUnavailable = true;
      return;
    }
    if (githubSettings.receive(child, message)) return;
    if (previewSettings.receive(child, message)) return;
    if (skillsSettings.receive(child, message)) return;
    if (agentSettings.receive(child, message)) return;
    if (mcpSettings.receive(child, message)) return;
    if (deviceMetadata.receive(child, message)) return;
    if (projectRegistration.receive(child, message)) return;
    if (message?.type === 'notification') {
      let status = 'failed';
      try {
        status = await nativeNotifications.receive(message.event);
      } catch {}
      if (
        bridge === child &&
        child.connected &&
        /^notification_[a-f0-9]{64}$/.test(message.event?.eventId ?? '')
      ) {
        try {
          child.send(
            { type: 'notification-ack', eventId: message.event.eventId, status },
            () => {},
          );
        } catch {}
      }
      return;
    }
    if (message?.type === 'health') {
      const previousNameRevision = deviceNameState?.metadata.revision;
      try {
        deviceNameState = deviceMetadataState(message.deviceMetadata);
      } catch {}
      if (
        ['ready', 'unavailable'].includes(message.local) &&
        ['unpaired', 'connected', 'reconnecting', 'unavailable', 'revoked'].includes(message.relay)
      ) {
        const catalogChanged =
          bridgeHealth.local !== message.local ||
          bridgeHealth.workspaces !== (Number(message.workspaces) || 0) ||
          previousNameRevision !== deviceNameState?.metadata.revision;
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
        if (catalogChanged) notifyWorkspaceChanged();
      }
      return;
    }
    if (message?.type !== 'local-ready') return;
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(message.origin) || typeof message.secret !== 'string')
      return;
    const origin = message.origin,
      generation = ++localReadyGeneration,
      current = () => !quitting && bridge === child && generation === localReadyGeneration;
    // An in-progress cookie write cannot be cancelled. Serialize initialization
    // across child generations so a replacement always writes its own login last.
    const preparing = localReadyChain.then(async () => {
      if (!current()) return;
      try {
        // Clear only replaceable shell caches, never cookies/IndexedDB where
        // login, drafts and pending requests live. Keep this origin immutable.
        await clearLocalShellCache(session.fromPartition('persist:personal-local'), origin);
        if (!current()) return;
        await session.fromPartition('persist:personal-local').cookies.set({
          url: origin,
          name: 'personal',
          value: message.secret,
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
        });
        if (!current()) return;
        localOrigin = origin;
        workspaceClient.invalidate(undefined, 'local');
        const identity = message.identity;
        localConnection =
          identity &&
          identity.owner === 'local-desktop' &&
          ['deviceId', 'workspaceId', 'machineId'].every(
            (key) =>
              typeof identity[key] === 'string' && /^[A-Za-z0-9_:-]{1,200}$/.test(identity[key]),
          ) &&
          typeof identity.userId === 'string' &&
          identity.userId.length > 0 &&
          identity.userId.length <= 1000 &&
          /^[A-Za-z0-9_-]{43}$/.test(message.secret)
            ? Object.freeze({
                origin,
                cookie: 'personal=' + message.secret,
                identity: {
                  owner: identity.owner,
                  deviceId: identity.deviceId,
                  workspaceId: identity.workspaceId,
                  machineId: identity.machineId,
                  userId: identity.userId,
                },
              })
            : undefined;
        bridgeStatus = '本机界面已启动，等待执行组件';
        notifyWorkspaceChanged();
      } catch {
        if (!current()) return;
        bridgeStatus = '本机界面初始化失败，请重新打开 Moor。';
        showSettings();
      }
    });
    localReadyChain = preparing.catch(() => {});
    await preparing;
  });
  child.on('error', (e) => {
    bridgeStatus = '连接组件启动失败，请重新连接。';
  });
  child.on('exit', () => {
    githubSettings.disconnect(child);
    previewSettings.disconnect(child);
    skillsSettings.disconnect(child);
    agentSettings.disconnect(child);
    deviceMetadata.disconnect(child);
    projectRegistration.disconnect(child);
    if (deviceNameState) deviceNameState = { ...deviceNameState, sync: 'pending' };
    mcpSettings.disconnect(child);
    if (bridge !== child) return;
    bridge = null;
    localConnection = undefined;
    workspaceClient.invalidate(undefined, 'local');
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
  localConnection = undefined;
  workspaceClient.invalidate(undefined, 'local');
  const old = bridge;
  if (old) githubSettings.disconnect(old);
  if (old) previewSettings.disconnect(old);
  if (old) skillsSettings.disconnect(old);
  if (old) agentSettings.disconnect(old);
  if (old) deviceMetadata.disconnect(old);
  if (old) projectRegistration.disconnect(old);
  if (deviceNameState) deviceNameState = { ...deviceNameState, sync: 'pending' };
  if (old) mcpSettings.disconnect(old);
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
    name: deviceNameState?.metadata.name ?? settings.name,
    projects: [...settings.projects],
    agents: [...settings.agents],
    status: hostStatus.message,
    health: health(),
    paired: fs.existsSync(bridgeFile),
  };
});
ipcMain.handle('personal:open-codex-install', async (event) => {
  trusted(event);
  await shell.openExternal(CODEX_INSTALL_URL);
});
ipcMain.handle('personal:health', (event) => {
  trusted(event);
  return health();
});
async function changeDeviceMetadata(event, action) {
  trusted(event);
  const sender = event.sender,
    frame = event.senderFrame;
  const state = await deviceMetadata.request(action, () => {
    try {
      trusted({ sender, senderFrame: frame });
      return true;
    } catch {
      return false;
    }
  });
  deviceNameState = state;
  return state;
}
ipcMain.handle('personal:device-metadata', (event, action) => changeDeviceMetadata(event, action));
ipcMain.handle('personal:github-config', (event, value) => {
  trusted(event);
  const sender = event.sender,
    frame = event.senderFrame;
  return githubSettings.request(value, () => {
    try {
      trusted({ sender, senderFrame: frame });
      return true;
    } catch {
      return false;
    }
  });
});
ipcMain.handle('personal:preview-config', (event, value) => {
  trusted(event);
  const sender = event.sender,
    frame = event.senderFrame;
  return previewSettings.request(value, () => {
    try {
      trusted({ sender, senderFrame: frame });
      return true;
    } catch {
      return false;
    }
  });
});
ipcMain.handle('personal:skills-config', (event, value) => {
  trusted(event);
  const sender = event.sender,
    frame = event.senderFrame;
  return skillsSettings.request(value, () => {
    try {
      trusted({ sender, senderFrame: frame });
      return true;
    } catch {
      return false;
    }
  });
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
ipcMain.handle('personal:agent-config', (event, value) => {
  trusted(event);
  const sender = event.sender,
    frame = event.senderFrame;
  return agentSettings.request(value, () => {
    try {
      trusted({ sender, senderFrame: frame });
      return true;
    } catch {
      return false;
    }
  });
});
ipcMain.handle('personal:mcp-config', (event, value) => {
  trusted(event);
  const sender = event.sender,
    frame = event.senderFrame;
  return mcpSettings.request(value, () => {
    try {
      trusted({ sender, senderFrame: frame });
      return true;
    } catch {
      return false;
    }
  });
});
ipcMain.handle('personal:mcp-executable', async (event) => {
  trusted(event);
  const sender = event.sender,
    frame = event.senderFrame;
  const result = await dialog.showOpenDialog(settingsWindow, {
    properties: ['openFile'],
    title: '选择本机 MCP 可执行程序',
  });
  trusted({ sender, senderFrame: frame });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('personal:agent-executable', async (event) => {
  trusted(event);
  const sender = event.sender,
    frame = event.senderFrame;
  const result = await dialog.showOpenDialog(settingsWindow, {
    properties: ['openFile'],
    title: '选择本机 ACP 可执行程序',
  });
  trusted({ sender, senderFrame: frame });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('personal:project', async (event) => {
  trusted(event);
  const sender = event.sender,
    frame = event.senderFrame;
  const result = await dialog.showOpenDialog(settingsWindow, {
    properties: ['openDirectory'],
    title: '选择本机项目',
  });
  trusted({ sender, senderFrame: frame });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('personal:skills-directory', async (event) => {
  trusted(event);
  const sender = event.sender,
    frame = event.senderFrame;
  const result = await dialog.showOpenDialog(settingsWindow, {
    properties: ['openDirectory'],
    title: '选择 Skills 根目录',
  });
  trusted({ sender, senderFrame: frame });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('personal:save', async (event, value) => {
  trusted(event);
  const server = endpoint(String(value.server ?? '').trim()),
    name = String(value.name ?? '').trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error('请输入有效的电脑名称');
  if (
    !Array.isArray(value.projects) ||
    value.projects.length > 100 ||
    value.projects.some(
      (p) => typeof p !== 'string' || !path.isAbsolute(p) || !fs.statSync(p).isDirectory(),
    )
  )
    throw new Error('项目目录无效');
  const agents = value.agents;
  if (!Array.isArray(agents) || agents.length > 1 || agents.some((agent) => agent !== 'codex'))
    throw new Error('内置 Agent 配置无效');
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
  const restartRequired =
    changed ||
    !!code ||
    JSON.stringify([...new Set(value.projects)].sort()) !==
      JSON.stringify([...settings.projects].sort()) ||
    JSON.stringify([...new Set(agents)].sort()) !== JSON.stringify([...settings.agents].sort());
  // Connection/project recovery must remain available while the host is down.
  // Only an actual rename needs a reviewed host revision and live private IPC.
  if (name !== (deviceNameState?.metadata.name ?? settings.name))
    await changeDeviceMetadata(event, {
      action: 'rename',
      name,
      expectedRevision: value.nameRevision,
    });
  if (changed) {
    workspaceClient.invalidate(undefined, 'remote');
    secureClient.invalidate();
    secureGoogleAuth.invalidate();
    secureAccount.invalidate();
  }
  settings = {
    server,
    name,
    projects: [...new Set(value.projects)],
    agents: [...new Set(agents)],
    notifications: settings.notifications,
  };
  write(settingsFile, settings);
  if (changed && secureWindow) {
    secureWindow.close();
    secureWindow = null;
  }
  if (restartRequired) await restartBridge();
  return { ok: true, paired: Boolean(code), deviceMetadata: deviceNameState };
});
ipcMain.handle('personal:notification-settings', (event, value) => {
  trusted(event);
  const preferences = validateSettings(value);
  write(settingsFile, { ...settings, notifications: preferences });
  settings = { ...settings, notifications: preferences };
  nativeNotifications.updateSettings();
  return nativeNotifications.state();
});
ipcMain.handle('personal:notification-test', async (event) => {
  trusted(event);
  await nativeNotifications.test();
  return nativeNotifications.state();
});
ipcMain.handle('moor:save-attachment', (event, value) => attachmentSaver.save(event, value));
function googleFor(event) {
  if (contentWindows.get(event.sender)?.trustedClient !== true)
    throw Error('Google 登录只能从当前 Moor 主窗口启动。');
  if (secureAccount.isLoggingOut(event.sender)) throw new Error('正在退出账号，请完成后重试。');
  return secureGoogleAuth;
}
ipcMain.handle('moor:google-auth-begin', (event, value) => googleFor(event).begin(event, value));
ipcMain.handle('moor:google-auth-complete', (event, value) =>
  googleFor(event).complete(event, value),
);
ipcMain.handle('moor:google-auth-cancel', (event, value) => googleFor(event).cancel(event, value));
ipcMain.handle('moor:secure-client', (event, value) => secureClient.request(event, value));
ipcMain.handle('moor:workspace-client', (event, value) => workspaceClient.request(event, value));
ipcMain.handle('moor:legacy-cache', (event, value) => legacyCache.request(event, value));
function trustedWorkspaceDocument(event, value) {
  const registered = contentWindows.get(event.sender);
  if (
    value !== undefined ||
    !secureWindow ||
    secureWindow.isDestroyed() ||
    registered?.window !== secureWindow ||
    registered.trustedClient !== true ||
    event.sender.isDestroyed() ||
    secureWindow.webContents !== event.sender ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame.url !== CLIENT_URL ||
    event.senderFrame.origin !== CLIENT_ORIGIN
  )
    throw Error('本机设置只能从当前 Moor 主窗口打开。');
}
ipcMain.handle('moor:workspace-context', (event, value) => {
  trustedWorkspaceDocument(event, value);
  return {
    localReady: !!localConnection,
    view: requestedView,
    notification: requestedNotification,
    revision: navigationRevision,
  };
});
let choosingProject = false;
ipcMain.handle('moor:add-project', async (event, value) => {
  trustedWorkspaceDocument(event, value);
  if (choosingProject) throw Error('正在选择项目文件夹。');
  const connection = localConnection,
    child = bridge;
  const current = () => {
    try {
      trustedWorkspaceDocument(event, value);
      return (
        !quitting &&
        !!connection &&
        localConnection === connection &&
        bridge === child &&
        child?.connected
      );
    } catch {
      return false;
    }
  };
  if (!current()) throw Error('本机执行组件尚未就绪，请稍后添加项目。');
  choosingProject = true;
  try {
    const selection = await dialog.showOpenDialog(secureWindow, {
      properties: ['openDirectory'],
      title: '添加本机项目',
      buttonLabel: '添加项目',
    });
    if (!current()) throw Error('本机连接或窗口已变化，请重新选择项目。');
    if (selection.canceled) return { canceled: true };
    if (selection.filePaths?.length !== 1) throw Error('请选择一个本机项目文件夹。');
    const result = await projectRegistration.request(
      selection.filePaths[0],
      connection.identity,
      current,
    );
    if (!current()) throw Error('本机连接已变化，请刷新项目列表确认登记结果。');
    const alreadyListed = settings.projects.some((path) => {
      try {
        return fs.realpathSync(path) === result.path;
      } catch {
        return path === result.path;
      }
    });
    const next = {
      ...settings,
      projects: alreadyListed ? settings.projects : [...settings.projects, result.path],
    };
    let settingsSaved = true;
    try {
      write(settingsFile, next);
      settings = next;
    } catch {
      settingsSaved = false;
    }
    notifyWorkspaceChanged();
    return {
      canceled: false,
      projectId: result.projectId,
      identity: connection.identity,
      settingsSaved,
    };
  } finally {
    choosingProject = false;
  }
});
ipcMain.handle('moor:open-settings', (event, value) => {
  trustedWorkspaceDocument(event, value);
  showSettings();
  return { opened: true };
});
ipcMain.handle('moor:secure-account', (event, value) => secureAccount.request(event, value));
ipcMain.handle('moor:cancel-attachment-save', (event) => attachmentSaver.cancel(event));
ipcMain.handle('personal:open', async (event, mode) => {
  trusted(event);
  if (mode === 'secure' || mode === 'remote') await showRemote();
  else await showLocal();
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showLocal());
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
            { label: '打开 Moor', click: () => showLocal() },
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
  app.on('activate', () => showLocal());
  // Closing a window leaves the execution host alive; explicit Quit stops this app's processes.
  app.on('window-all-closed', () => {});
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    nativeNotifications.close();
    githubSettings.close();
    previewSettings.close();
    skillsSettings.close();
    agentSettings.close();
    deviceMetadata.close();
    projectRegistration.close();
    mcpSettings.close();
    secureClient.close();
    workspaceClient.close();
    legacyCache.close();
    secureGoogleAuth.close();
    secureAccount.close();
    clearTimeout(restart);
    hostRecovery.stop();
  });
}
