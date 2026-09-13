import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_URL, CLIENT_ORIGIN } from '../src/desktop/client-assets.cjs';
import { createClientWindow, prepareClientSession } from '../src/desktop/client-window.cjs';
import { isCurrentContentDocument } from '../src/desktop/content-authority.cjs';

test('trusted window keeps service authority separate from its immutable document and invalidates reload/close', () => {
  const registry = new Map(),
    invalidated: unknown[] = [],
    session = {};
  class Window extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: CLIENT_URL, origin: CLIENT_ORIGIN },
      session,
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: (handler: any) => {
        assert.deepEqual(handler(), { action: 'deny' });
      },
    });
    constructor(readonly options: any) {
      super();
    }
    isDestroyed() {
      return this.destroyed;
    }
  }
  const window = createClientWindow({
    BrowserWindow: Window,
    session,
    origin: 'https://relay.example',
    preloadPath: '/synthetic/secure-preload.cjs',
    registry,
    invalidate: (contents: unknown) => invalidated.push(contents),
  });
  const contents = window.webContents;
  assert.deepEqual(window.options.webPreferences, {
    session,
    preload: '/synthetic/secure-preload.cjs',
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  });
  assert.equal(registry.get(contents).origin, 'https://relay.example');
  assert(isCurrentContentDocument(registry.get(contents), contents, contents.mainFrame));
  for (const event of ['will-navigate', 'will-redirect']) {
    for (const url of [
      CLIENT_URL,
      'https://relay.example',
      'file:///etc/passwd',
      CLIENT_URL + '?next=x',
      CLIENT_URL + '#x',
      'moor-client://evil/remote/',
      CLIENT_ORIGIN + '/assets/entry-ABCDEFG1.js',
    ]) {
      let prevented = false;
      contents.emit(
        event,
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        url,
      );
      assert.equal(prevented, url !== CLIENT_URL, event + ' ' + url);
    }
  }
  contents.emit('did-start-navigation', {}, CLIENT_URL, false, false);
  assert.equal(invalidated.length, 0);
  contents.emit('did-start-navigation', {}, CLIENT_URL, false, true);
  assert.deepEqual(invalidated, [contents]);
  window.destroyed = true;
  window.emit('closed');
  assert.deepEqual(invalidated, [contents, contents]);
  assert.equal(registry.has(contents), false);
});

test('trusted session serves a packaged snapshot, blocks network and permissions, and has no service worker fallback', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-client-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'assets'));
  const files = [
    'index.html',
    'startup.js',
    'notification-worker.js',
    'style.css',
    'manifest.webmanifest',
    'THIRD_PARTY_NOTICES.txt',
    'moor-logo.png',
    'icon-192.png',
    'icon-512.png',
    'apple-touch-icon.png',
    'favicon.ico',
    'assets/entry-ABCDEFG1.js',
  ];
  for (const name of files) await writeFile(join(directory, name), 'synthetic packaged asset');
  let handler: any, before: any, permission: any, checkPermission: any;
  const session = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: (fn: any) => {
      permission = fn;
    },
    setPermissionCheckHandler: (fn: any) => {
      checkPermission = fn;
    },
    webRequest: {
      onBeforeRequest: (fn: any) => {
        before = fn;
      },
    },
    protocol: {
      handle: (scheme: string, fn: any) => {
        assert.equal(scheme, 'moor-client');
        handler = fn;
      },
    },
  });
  await prepareClientSession(session, directory);
  permission({}, 'clipboard-read', (value: boolean) => assert.equal(value, false));
  assert.equal(checkPermission(), false);
  for (const url of [
    CLIENT_URL,
    CLIENT_ORIGIN + '/startup.js',
    'https://relay.example/api/me',
    'wss://relay.example/bridge/v4/client',
    'file:///etc/passwd',
    'moor-client://app.evil/remote/',
  ])
    before({ url }, ({ cancel }: { cancel: boolean }) =>
      assert.equal(cancel, !url.startsWith(CLIENT_ORIGIN + '/')),
    );
  const req = (url: string) => ({ url, method: 'GET', headers: new Headers(), body: null });
  assert.equal(await handler(req(CLIENT_URL)).text(), 'synthetic packaged asset');
  await writeFile(join(directory, 'index.html'), 'changed after preparation');
  assert.equal(await handler(req(CLIENT_URL)).text(), 'synthetic packaged asset');
  assert.equal(handler(req(CLIENT_ORIGIN + '/sw.js')).status, 404);
  let blocked = false;
  session.emit('will-download', {
    preventDefault: () => {
      blocked = true;
    },
  });
  assert(blocked);
});
