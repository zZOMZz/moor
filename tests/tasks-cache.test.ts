import test from 'node:test';
import assert from 'node:assert/strict';
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open: () => ({}) } });
const { createCacheCompareDraftBundle } = await import('../src/web/cache');
if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
else Reflect.deleteProperty(globalThis, 'indexedDB');
function fixture(initial: Record<string, unknown> = {}) {
  const rows = new Map(Object.entries(initial)),
    requests = new Map<string, any>(),
    writes = new Map<string, unknown>();
  let ready!: () => void;
  const started = new Promise<void>((r) => {
    ready = r;
  });
  let timeout!: () => void,
    aborted = false;
  const tx: any = {
    objectStore: () => ({
      get: (key: string) => {
        const request = { result: undefined, onsuccess: () => {} };
        requests.set(key, request);
        return request;
      },
      put: (value: unknown, key: string) => {
        assert.equal(aborted, false);
        writes.set(key, structuredClone(value));
        return {};
      },
    }),
    abort: () => {
      aborted = true;
      writes.clear();
      tx.onabort?.();
    },
  };
  const compare = createCacheCompareDraftBundle({
    database: async () =>
      ({
        transaction: () => {
          ready();
          return tx;
        },
      }) as unknown as IDBDatabase,
    schedule: (callback) => {
      timeout = callback;
      return callback;
    },
    cancel: () => {},
    minimumEntries: 2,
    subject: '任务计划',
  });
  return {
    rows,
    compare,
    started,
    expire: () => timeout(),
    read: () => {
      for (const [key, request] of requests) {
        request.result = rows.get(key);
        request.onsuccess();
      }
    },
    complete: () => {
      if (!aborted) for (const [key, value] of writes) rows.set(key, value);
      tx.oncomplete?.();
    },
    get aborted() {
      return aborted;
    },
  };
}
test('task selection delivery and the original parent mutation commit atomically', async () => {
  const f = fixture(),
    value = { operationId: 'original', body: 'synthetic' },
    pending = f.compare(
      [
        { key: 'tasks', expected: undefined, value: { cacheRevision: 1, delivery: 'original' } },
        { key: 'pending', expected: undefined, value },
      ],
      () => true,
    );
  await f.started;
  f.read();
  assert.equal(f.rows.has('tasks'), false);
  assert.equal(f.rows.has('pending'), false);
  f.complete();
  assert.equal(await pending, true);
  assert.equal((f.rows.get('tasks') as any).delivery, 'original');
  assert.deepEqual(f.rows.get('pending'), value);
});
test('competing pending mutation and timed out transactions never leave only the task selection delivered', async () => {
  const stale = fixture({ pending: { operationId: 'another' } }),
    saving = stale.compare(
      [
        { key: 'tasks', expected: undefined, value: { delivery: 'original' } },
        { key: 'pending', expected: undefined, value: { operationId: 'original' } },
      ],
      () => true,
    );
  await stale.started;
  stale.read();
  stale.complete();
  assert.equal(await saving, false);
  assert.equal(stale.rows.has('tasks'), false);
  assert.equal((stale.rows.get('pending') as any).operationId, 'another');
  const f = fixture(),
    pending = f.compare(
      [
        { key: 'tasks', expected: undefined, value: { delivery: 'original' } },
        { key: 'pending', expected: undefined, value: { operationId: 'original' } },
      ],
      () => true,
    );
  await f.started;
  f.read();
  f.expire();
  await assert.rejects(pending, /任务计划/);
  f.complete();
  assert.equal(f.aborted, true);
  assert.equal(f.rows.size, 0);
});
