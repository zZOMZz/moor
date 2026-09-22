import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('a waiting shell preserves old lazy chunks until the previous clients finish', async () => {
  const source = await readFile('apps/web/public/sw.js', 'utf8');
  const storage = new Map<string, Map<string, string>>();
  const published = new Map<string, string>();
  const origin = 'https://synthetic.example';
  const caches = {
    async open(name: string) {
      if (!storage.has(name)) storage.set(name, new Map());
      const values = storage.get(name)!;
      return {
        async addAll(paths: string[]) {
          const bytes = paths.map((path) => {
            assert.ok(published.has(path), 'install only succeeds with all version assets');
            return [path, published.get(path)!] as const;
          });
          for (const [path, value] of bytes) values.set(path, value);
        },
        async match(path: string) {
          return values.get(path);
        },
      };
    },
    async keys() {
      return [...storage.keys()];
    },
    async delete(name: string) {
      return storage.delete(name);
    },
  };
  function worker(version: string, assets: string[]) {
    const events = new Map<string, (event: any) => void>();
    runInNewContext(
      source
        .replace('__BUILD__', version)
        .replace(/\[\s*\/\* __ASSETS__ \*\/\s*\]/, JSON.stringify(assets)),
      {
        URL,
        location: { origin },
        importScripts: () => {},
        caches,
        self: {
          addEventListener: (name: string, listener: (event: any) => void) =>
            events.set(name, listener),
          skipWaiting: () => assert.fail('a new worker must not evict an active client version'),
          clients: { claim: () => assert.fail('activation must not take over an existing page') },
        },
        fetch: async (request: { url: string }) => {
          const path = new URL(request.url).pathname;
          assert.ok(published.has(path), 'old assets have been removed from the server');
          return published.get(path);
        },
      },
    );
    return {
      async lifecycle(name: string) {
        let pending: Promise<unknown> | undefined;
        events.get(name)!({ waitUntil: (value: Promise<unknown>) => (pending = value) });
        await pending;
      },
      async fetch(path: string) {
        let result: Promise<string> | undefined;
        events.get('fetch')!({
          request: { method: 'GET', url: origin + path },
          respondWith: (value: Promise<string>) => (result = value),
        });
        return result;
      },
    };
  }

  published.set('/', 'old page');
  published.set('/assets/old-lazy.js', 'old lazy feature');
  const old = worker('old', ['/', '/assets/old-lazy.js']);
  await old.lifecycle('install');
  await old.lifecycle('activate');
  await caches.open('unrelated-cache');

  published.clear();
  published.set('/', 'new page');
  published.set('/assets/new-lazy.js', 'new lazy feature');
  const next = worker('next', ['/', '/assets/new-lazy.js']);
  await next.lifecycle('install');
  assert.equal(await old.fetch('/assets/old-lazy.js'), 'old lazy feature');
  assert.equal(await old.fetch('/'), 'old page');
  assert.ok(storage.has('personal-shell-old'));

  // The browser emits activate only after the old controlled clients close.
  await next.lifecycle('activate');
  assert.equal(storage.has('personal-shell-old'), false);
  assert.equal(await next.fetch('/assets/new-lazy.js'), 'new lazy feature');
  assert.ok(storage.has('unrelated-cache'));
  assert.equal(
    await next.fetch('/api/session'),
    undefined,
    'business data never enters shell cache',
  );
});
