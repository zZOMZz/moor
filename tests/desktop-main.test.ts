import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire as createPackageRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { notificationIdentity } from '../src/notification-protocol';

function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, release, entered, waiting };
}

// Execute the actual desktop main/preload/settings sources with synthetic Electron
// objects. No system notification, dialog, child process or user file is touched.
test('actual desktop main limits IPC, acknowledges native events, keeps notifications after window close and opens only scoped read links', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-desktop-main-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localRequire = createPackageRequire(resolve('src/desktop/main.cjs'));
  const handlers = new Map<string, (...args: any[]) => any>(),
    windows: any[] = [],
    children: any[] = [],
    notices: any[] = [],
    partitions = new Map<string, any>();
  const nativeTimers = new Map<number, () => void>();
  const cookieWrites: { url: string; value: string }[] = [];
  let clearGate: ReturnType<typeof gate> | undefined,
    cookieGate: ReturnType<typeof gate> | undefined;
  let timerId = 0;
  const paths = new Map([
    ['userData', directory],
    ['appData', directory],
    ['downloads', directory],
  ]);
  const application = Object.assign(new EventEmitter(), {
    setName() {},
    setPath: (key: string, value: string) => paths.set(key, value),
    getPath: (key: string) => paths.get(key),
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    quit() {},
  });
  class Window extends EventEmitter {
    destroyed = false;
    webContents: any;
    urls: string[] = [];
    constructor(readonly options: any) {
      super();
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: 'about:blank', origin: 'null' },
        isDestroyed: () => this.destroyed,
        setWindowOpenHandler: (fn: unknown) => {
          this.webContents.openHandler = fn;
        },
        stop() {},
      });
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    loadURL(url: string) {
      this.webContents.emit('did-start-navigation', {}, url, false, true);
      this.urls.push(url);
      this.webContents.mainFrame = { url, origin: new URL(url).origin };
      return Promise.resolve();
    }
    loadFile(path: string) {
      return this.loadURL(pathToFileURL(path).href);
    }
    show() {}
    focus() {}
    close() {
      this.destroyed = true;
      this.emit('closed');
    }
    static getFocusedWindow() {
      return windows.at(-1);
    }
  }
  let nativeStarted: (() => void) | undefined;
  class NativeNotification extends EventEmitter {
    static isSupported() {
      return true;
    }
    constructor(readonly options: any) {
      super();
      notices.push(this);
      nativeStarted?.();
    }
    show() {}
    close() {
      this.emit('close');
    }
  }
  let dialogResult: any = { canceled: true };
  const electron = {
    app: application,
    BrowserWindow: Window,
    Notification: NativeNotification,
    ipcMain: { handle: (name: string, fn: any) => handlers.set(name, fn) },
    dialog: {
      showSaveDialog: async () => dialogResult,
      showOpenDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (value: any) => value },
    session: {
      fromPartition: (name: string) => {
        if (!partitions.has(name))
          partitions.set(
            name,
            Object.assign(new EventEmitter(), {
              cookies: {
                set: async (value: { url: string; value: string }) => {
                  const waiting = cookieGate;
                  cookieGate = undefined;
                  if (waiting) {
                    waiting.enter();
                    await waiting.waiting;
                  }
                  cookieWrites.push({ url: value.url, value: value.value });
                },
              },
              setPermissionRequestHandler(this: any, fn: any) {
                this.requestPermission = fn;
              },
              setPermissionCheckHandler(this: any, fn: any) {
                this.checkPermission = fn;
              },
            }),
          );
        return partitions.get(name);
      },
    },
  };
  class Recovery {
    constructor(readonly options: any) {}
    start() {
      this.options.launch();
    }
    stop() {}
    ready() {}
  }
  const spawn = () => {
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      connected: true,
      exitCode: 0,
      signalCode: null,
      sent: [] as any[],
      send(value: any) {
        this.sent.push(value);
      },
      kill() {},
    });
    children.push(child);
    return child;
  };
  const fakeProcess = Object.assign(new EventEmitter(), {
    env: { MOOR_DESKTOP_DATA_DIR: directory },
    execPath: '/synthetic/electron',
    connected: true,
  });
  const context = {
    __dirname: resolve('src/desktop'),
    process: fakeProcess,
    Buffer,
    URL,
    structuredClone,
    setTimeout: (fn: () => void) => {
      nativeTimers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id: number) => nativeTimers.delete(id),
    require: (name: string) => {
      if (name === 'electron') return electron;
      if (name === 'node:child_process') return { spawn };
      if (name === './recovery.cjs') return { ProcessRecovery: Recovery };
      if (name === './page-loader.cjs')
        return {
          loadPage: (window: any, url: string) => window.loadURL(url),
          clearLocalShellCache: async () => {
            const waiting = clearGate;
            clearGate = undefined;
            if (waiting) {
              waiting.enter();
              await waiting.waiting;
            }
          },
        };
      if (name === './notifications.cjs') {
        const original = localRequire(name);
        return {
          ...original,
          DesktopNotifications: class extends original.DesktopNotifications {
            constructor(options: any) {
              super({ ...options, schedule: context.setTimeout, cancel: context.clearTimeout });
            }
          },
        };
      }
      return localRequire(name);
    },
  };
  runInNewContext(await readFile(resolve('src/desktop/main.cjs'), 'utf8'), context);
  await Promise.resolve();
  const settingsWindow = windows[0],
    settingsEvent = () => ({
      sender: settingsWindow.webContents,
      senderFrame: settingsWindow.webContents.mainFrame,
    });
  const invoke = (name: string, value?: unknown, event = settingsEvent()) =>
    handlers.get(name)!(event, value);
  assert.equal((await invoke('personal:settings')).notifications.enabled, false);
  assert.equal(notices.length, 0);
  const event = {
    notificationVersion: 1,
    userId: 'user',
    machineId: 'machine',
    workspaceId: 'workspace',
    localProjectId: 'project',
    sessionId: 'session',
    turnId: 'turn',
    kind: 'completed',
    createdAt: Date.now(),
    expiresAt: Date.now() + 100000,
    eventId: '',
  };
  event.eventId =
    'notification_' +
    createHash('sha256')
      .update(notificationIdentity(event as any))
      .digest('hex');
  const emitMessage = async (child: any, value: any) => {
    for (const listener of child.listeners('message')) await listener(value);
  };
  await emitMessage(children[0], {
    type: 'local-ready',
    origin: 'http://127.0.0.1:4521',
    secret: 'synthetic-secret',
  });
  const localWindow = windows.at(-1),
    localEvent = () => ({
      sender: localWindow.webContents,
      senderFrame: localWindow.webContents.mainFrame,
    });
  assert.match(localWindow.options.webPreferences.preload, /web-preload\.cjs$/);
  assert.equal(localWindow.options.webPreferences.sandbox, true);
  assert.equal(localWindow.options.webPreferences.nodeIntegration, false);
  assert.throws(
    () =>
      invoke(
        'personal:notification-settings',
        { enabled: true, completed: true, failed: true, approvals: true },
        localEvent(),
      ),
    /无效的本机设置请求/,
  );
  await emitMessage(children[0], { type: 'notification', event });
  assert.equal(children[0].sent.at(-1).status, 'ignored');
  assert.equal(notices.length, 0);
  // Run real settings.js and its actual preload bridge. Permission/native display
  // happens only after the user-facing enable button is clicked.
  const dom = new JSDOM(await readFile(resolve('src/desktop/settings.html'), 'utf8'), {
    runScripts: 'outside-only',
    url: pathToFileURL(resolve('src/desktop/settings.html')).href,
  });
  const exposed = new Map<string, any>();
  runInNewContext(await readFile(resolve('src/desktop/preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (key: string, value: any) => exposed.set(key, value) },
      ipcRenderer: {
        invoke: (name: string, value: unknown) => Promise.resolve(invoke(name, value)),
      },
    }),
  });
  Object.assign(dom.window, {
    personal: exposed.get('personal'),
    setInterval: () => 1,
    clearInterval() {},
  });
  dom.window.eval(await readFile(resolve('src/desktop/settings.js'), 'utf8'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(notices.length, 0);
  const enable = dom.window.document.querySelector<HTMLButtonElement>('#notifications-enable')!;
  const started = new Promise<void>((resolve) => {
    nativeStarted = resolve;
  });
  const enabling = (enable.onclick as any)(new dom.window.MouseEvent('click'));
  await Promise.race([
    started,
    enabling.then(() => {
      assert.fail(dom.window.document.querySelector('#notifications-status')!.textContent!);
    }),
  ]);
  assert.equal(notices.length, 1);
  notices[0].emit('failed', 'Synthetic OS denial');
  await enabling;
  assert.match(
    dom.window.document.querySelector('#notifications-status')!.textContent!,
    /系统未确认/,
  );
  assert.equal((await invoke('personal:settings')).notifications.enabled, true);
  const next = { ...event, turnId: 'next-turn', eventId: '' };
  next.eventId =
    'notification_' +
    createHash('sha256')
      .update(notificationIdentity(next as any))
      .digest('hex');
  localWindow.close();
  const sending = emitMessage(children[0], { type: 'notification', event: next });
  assert.equal(notices.length, 2);
  assert.equal(children[0].sent.length, 1);
  notices[1].emit('show');
  await sending;
  assert.equal(children[0].sent.at(-1).status, 'shown');
  notices[1].emit('click');
  const reopened = windows.at(-1),
    url = new URL(reopened.urls.at(-1));
  assert.equal(url.origin, 'http://127.0.0.1:4521');
  assert.deepEqual(JSON.parse(url.searchParams.get('notification')!), next);
  assert.equal(url.searchParams.has('approve'), false);
  for (const partition of partitions.values()) {
    let allowed = true;
    partition.requestPermission({}, 'notifications', (value: boolean) => (allowed = value));
    assert.equal(allowed, false);
    assert.equal(partition.checkPermission(), false);
    let prevented = false;
    partition.emit('will-download', { preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
  }
  const webBridge = new Map<string, any>();
  runInNewContext(await readFile(resolve('src/desktop/web-preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (key: string, value: any) => webBridge.set(key, value) },
      ipcRenderer: {
        invoke: (name: string, value: unknown) =>
          Promise.resolve(
            invoke(name, value, {
              sender: reopened.webContents,
              senderFrame: reopened.webContents.mainFrame,
            }),
          ),
      },
    }),
  });
  assert.deepEqual(Object.keys(webBridge.get('moorDesktop')).sort(), [
    'cancelAttachmentSave',
    'saveAttachment',
    'version',
  ]);
  assert.equal(webBridge.has('personal'), false);
  const bytes = Buffer.from('Synthetic native save');
  const value = {
    scope: {
      owner: 'owner',
      deviceId: 'device',
      workspaceId: 'workspace',
      localProjectId: 'project',
      sessionId: 'session',
    },
    reference: {
      contentVersion: 1,
      attachmentId: 'attachment',
      name: 'output.txt',
      content: {
        version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length,
        mediaType: 'text/plain',
      },
    },
    data: bytes.toString('base64'),
  };
  assert.deepEqual(await webBridge.get('moorDesktop').saveAttachment(value), {
    status: 'cancelled',
  });
  dialogResult = { canceled: false, filePath: join(directory, 'synthetic-output.txt') };
  assert.deepEqual(await webBridge.get('moorDesktop').saveAttachment(value), { status: 'saved' });
  assert.deepEqual(await readFile(dialogResult.filePath), bytes);
  await assert.rejects(
    invoke('moor:save-attachment', value, {
      sender: reopened.webContents,
      senderFrame: { ...reopened.webContents.mainFrame },
    }),
    /保存来源/,
  );
  // A replaced child cannot deliver events or receive acknowledgements.
  await invoke('personal:save', {
    server: '',
    name: 'Synthetic desktop',
    projects: [],
    agents: ['codex'],
    code: '',
  });
  const previousCount = notices.length,
    ackCount = children[0].sent.length;
  await emitMessage(children[0], { type: 'notification', event: { ...next, turnId: 'wrong' } });
  assert.equal(notices.length, previousCount);
  assert.equal(children[0].sent.length, ackCount);
  // A former child's delayed cache clear must not write its login at the new
  // child's origin. The actual main handler runs with controlled async signals.
  const clearing = gate();
  clearGate = clearing;
  const staleReady = emitMessage(children.at(-1), {
    type: 'local-ready',
    origin: 'http://127.0.0.1:4531',
    secret: 'synthetic-stale',
  });
  await clearing.entered;
  await invoke('personal:recover');
  const replacementReady = emitMessage(children.at(-1), {
    type: 'local-ready',
    origin: 'http://127.0.0.1:4532',
    secret: 'synthetic-replacement',
  });
  clearing.release();
  await Promise.all([staleReady, replacementReady]);
  assert.deepEqual(cookieWrites.at(-1), {
    url: 'http://127.0.0.1:4532',
    value: 'synthetic-replacement',
  });
  assert.equal(
    cookieWrites.some((value) => value.value === 'synthetic-stale'),
    false,
  );
  // Even a cookie write already in flight cannot finish after a replacement's
  // write at the same reused loopback origin and overwrite the current login.
  const writingCookie = gate();
  cookieGate = writingCookie;
  const staleWrite = emitMessage(children.at(-1), {
    type: 'local-ready',
    origin: 'http://127.0.0.1:4532',
    secret: 'synthetic-in-flight',
  });
  await writingCookie.entered;
  await invoke('personal:recover');
  const currentWrite = emitMessage(children.at(-1), {
    type: 'local-ready',
    origin: 'http://127.0.0.1:4532',
    secret: 'synthetic-current',
  });
  writingCookie.release();
  await Promise.all([staleWrite, currentWrite]);
  assert.deepEqual(cookieWrites.slice(-2), [
    { url: 'http://127.0.0.1:4532', value: 'synthetic-in-flight' },
    { url: 'http://127.0.0.1:4532', value: 'synthetic-current' },
  ]);
  assert.equal(new URL(reopened.urls.at(-1)).origin, 'http://127.0.0.1:4532');
  dom.window.close();
  application.emit('before-quit');
  assert.equal(nativeTimers.size, 0);
});
