import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { deadline } from '../src/web/deadline';
import { loadPage, clearLocalShellCache } from '../src/desktop/page-loader.cjs';

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
