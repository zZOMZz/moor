import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { firstStartupSource } from '../src/web/bootstrap';
import type { Identity } from '../src/web/api';
import { deadline } from '../src/web/deadline';
import { loadPage, clearLocalShellCache } from '../src/desktop/page-loader.cjs';

test('local startup does not wait for identity, and confirmed identity does not wait for blocked storage', async () => {
  let confirm!: (identity: Identity | null) => void;
  const identity = new Promise<Identity | null>((resolve) => {
    confirm = resolve;
  });
  assert.deepEqual(await firstStartupSource(identity, Promise.resolve('cached-owner')), {
    kind: 'cache',
    owner: 'cached-owner',
  });
  const me = { owner: 'verified-owner', needsSetup: false };
  confirm(me);
  assert.deepEqual(await firstStartupSource(identity, new Promise(() => {})), {
    kind: 'identity',
    identity: me,
  });
  const logout = { owner: null, needsSetup: false };
  assert.deepEqual(
    await firstStartupSource(Promise.resolve(logout), Promise.resolve('old-owner')),
    {
      kind: 'identity',
      identity: logout,
    },
  );
  assert.deepEqual(await firstStartupSource(Promise.resolve(null), Promise.resolve(undefined)), {
    kind: 'identity',
    identity: null,
  });
});

test('slow startup retains its skeleton, offers manual retry and accepts late readiness', async () => {
  const html = await readFile('src/web/public/index.html', 'utf8');
  const source = await readFile('src/web/public/startup.js', 'utf8');
  const dom = new JSDOM(html, { url: 'https://synthetic.invalid' });
  const { window } = dom;
  window.localStorage.setItem('moor-appearance', 'dark');
  let expire!: () => void;
  let complete!: (entry: { start: () => void }) => void;
  const entry = new Promise<{ start: () => void }>((resolve) => {
    complete = resolve;
  });
  runInNewContext(source.replace("import('__ENTRY__')", 'loadEntry()'), {
    window,
    document: window.document,
    localStorage: window.localStorage,
    location: window.location,
    setTimeout: (callback: () => void) => {
      expire = callback;
      return 1;
    },
    clearTimeout() {},
    loadEntry: () => entry,
  });
  assert.equal(window.document.documentElement.dataset.theme, 'dark');
  expire();
  assert(window.document.querySelector('.startup-shell'));
  assert.match(window.document.querySelector('#startup-status')!.textContent!, /仍在加载/);
  assert.equal(window.document.querySelector('.startup-message button')!.textContent, '重新加载');
  assert.equal(window.document.querySelector('.startup-failure'), null);
  complete({
    start: () => {
      window.document.querySelector('#app')!.textContent = 'synthetic workspace';
      window.dispatchEvent(new window.Event('moor:ready'));
    },
  });
  await entry;
  expire();
  assert.equal(window.document.querySelector('#app')!.textContent, 'synthetic workspace');
  dom.window.close();
});

test('local shell cleanup excludes login, drafts and session databases', async () => {
  let options: any;
  await clearLocalShellCache(
    {
      clearStorageData: async (value: any) => {
        options = value;
      },
    },
    'http://127.0.0.1:1234',
    (() => 1) as any,
    () => {},
  );
  assert.deepEqual(options, {
    origin: 'http://127.0.0.1:1234',
    storages: ['serviceworkers', 'cachestorage'],
  });
});

test('blocked cache rejects on injected deadline without replaying work', async () => {
  let expire!: () => void;
  let complete!: (v: string) => void;
  const work = new Promise<string>((resolve) => {
    complete = resolve;
  });
  const result = deadline(
    work,
    5000,
    'cache timeout',
    ((fn: () => void) => {
      expire = fn;
      return 1;
    }) as any,
    (() => {}) as any,
  );
  const rejected = assert.rejects(result, /cache timeout/);
  expire();
  await rejected;
  complete('late');
});

test('hung navigation offers recovery once and does not automatically reload', async () => {
  let expire!: () => void;
  let loads = 0,
    failures = 0,
    stops = 0;
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { stop: () => stops++ },
    loadURL: () => {
      loads++;
      return new Promise(() => {});
    },
  });
  loadPage(
    window,
    'https://synthetic.invalid',
    () => failures++,
    ((fn: () => void) => {
      expire = fn;
      return 1;
    }) as any,
    () => {},
  );
  await Promise.resolve();
  expire();
  expire();
  assert.equal(loads, 1);
  assert.equal(failures, 1);
  assert.equal(stops, 1);
});

test('failed navigation is handled without an unhandled loadURL rejection', async () => {
  let failed!: () => void;
  const recovery = new Promise<void>((resolve) => {
    failed = resolve;
  });
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { stop() {} },
    loadURL: () => Promise.reject(new Error('synthetic offline')),
  });
  loadPage(window, 'https://synthetic.invalid', failed, (() => 1) as any, () => {});
  await recovery;
});
