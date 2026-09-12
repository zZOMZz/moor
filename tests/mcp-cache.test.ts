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
const entries = [
  {
    key: 'mcp',
    expected: { cacheRevision: 2, review: 'original-version' },
    value: { cacheRevision: 3, delivery: 'original-operation' },
  },
  {
    key: 'tasks',
    expected: undefined,
    value: { cacheRevision: 1, delivery: 'original-operation' },
  },
  {
    key: 'pending',
    expected: undefined,
    value: { operationId: 'original-operation', update: 'synthetic' },
  },
];
test('MCP version review, task plan and original mutation become durable together', async () => {
  const f = fixture({ mcp: entries[0]!.expected });
  const saving = f.compare(entries, () => true);
  await f.started;
  f.read();
  assert.deepEqual(f.rows.get('mcp'), entries[0]!.expected);
  assert.equal(f.rows.has('tasks'), false);
  assert.equal(f.rows.has('pending'), false);
  f.complete();
  assert.equal(await saving, true);
  for (const entry of entries) assert.deepEqual(f.rows.get(entry.key), entry.value);
});
test('a competing MCP version or unknown mutation aborts all three records', async () => {
  for (const initial of [
    { mcp: { cacheRevision: 3, review: 'another-version' } },
    { mcp: entries[0]!.expected, pending: { operationId: 'another-operation' } },
  ]) {
    const f = fixture(initial);
    const before = new Map(f.rows);
    const saving = f.compare(entries, () => true);
    await f.started;
    f.read();
    f.complete();
    assert.equal(await saving, false);
    assert.deepEqual(f.rows, before);
    assert.equal(f.rows.has('tasks'), false);
  }
});
test('MCP submission timeout or target switch never commits partial authorization', async () => {
  for (const reason of ['timeout', 'target'] as const) {
    const f = fixture({ mcp: entries[0]!.expected });
    let current = true;
    const saving = f.compare(entries, () => current);
    await f.started;
    if (reason === 'target') current = false;
    f.read();
    if (reason === 'timeout') f.expire();
    await assert.rejects(saving);
    f.complete();
    assert.equal(f.aborted, true);
    assert.deepEqual(f.rows, new Map([['mcp', entries[0]!.expected]]));
  }
});
