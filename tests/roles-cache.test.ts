import test from 'node:test';
import assert from 'node:assert/strict';

// The production module opens its shared database at import. These tests use
// the actual CAS factory with a separate, explicitly driven transaction peer.
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  value: { open: () => ({}) },
});
const { createCacheCompareDraftBundle } = await import('../src/web/cache');
if (originalIndexedDB) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDB);
else Reflect.deleteProperty(globalThis, 'indexedDB');

type Request = {
  result?: unknown;
  error?: Error;
  onsuccess?: () => void;
  onerror?: () => void;
};
type Transaction = {
  error?: Error;
  oncomplete?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  objectStore(name: string): {
    get(key: string): Request;
    put(value: unknown, key: string): Request;
  };
  abort(): void;
  read(): void;
  complete(): void;
  lateRead(): void;
  lateComplete(): void;
  putCount: number;
  aborted: boolean;
  finished: boolean;
};
function fixture(initial?: { [key: string]: unknown }) {
  const rows = new Map(Object.entries(initial ?? {})),
    transactions: Transaction[] = [],
    observers = new Set<() => void>(),
    timers = new Set<() => void>();
  let aborts = 0;
  const database = {
    transaction(storeName: string, mode: IDBTransactionMode) {
      assert.equal(storeName, 'cache');
      assert.equal(mode, 'readwrite');
      const requests = new Map<string, Request>(),
        writes = new Map<string, unknown>(),
        puts: Request[] = [];
      const transaction: Transaction = {
        putCount: 0,
        aborted: false,
        finished: false,
        objectStore(name) {
          assert.equal(name, 'cache');
          return {
            get(key) {
              const request: Request = {};
              requests.set(key, request);
              return request;
            },
            put(value, key) {
              transaction.putCount++;
              assert.equal(transaction.aborted, false, 'no request may write after abort');
              assert.equal(transaction.finished, false);
              writes.set(key, structuredClone(value));
              const result: Request = {};
              puts.push(result);
              return result;
            },
          };
        },
        abort() {
          if (transaction.finished) return;
          aborts++;
          transaction.aborted = true;
          transaction.finished = true;
          writes.clear();
          transaction.onabort?.();
        },
        read() {
          assert.equal(
            transactions.find((entry) => !entry.finished),
            transaction,
          );
          for (const [key, request] of requests) {
            request.result = structuredClone(rows.get(key));
            request.onsuccess?.();
          }
        },
        complete() {
          if (transaction.finished) return;
          assert.equal(
            transactions.find((entry) => !entry.finished),
            transaction,
          );
          for (const put of puts) put.onsuccess?.();
          if (transaction.aborted) return;
          for (const [key, value] of writes) rows.set(key, structuredClone(value));
          transaction.finished = true;
          transaction.oncomplete?.();
        },
        lateRead() {
          for (const request of requests.values()) {
            request.result = undefined;
            request.onsuccess?.();
          }
        },
        lateComplete() {
          transaction.oncomplete?.();
        },
      };
      transactions.push(transaction);
      for (const observe of observers) observe();
      return transaction;
    },
  };
  const compareDraftBundle = createCacheCompareDraftBundle({
    database: async () => database as unknown as IDBDatabase,
    schedule: (callback) => {
      timers.add(callback);
      return callback;
    },
    cancel: (timer) => timers.delete(timer as () => void),
  });
  return {
    compareDraftBundle,
    rows,
    timers,
    transactions,
    get aborts() {
      return aborts;
    },
    transaction(count = 1) {
      return new Promise<Transaction>((resolve) => {
        const inspect = () => {
          if (transactions.length >= count) {
            observers.delete(inspect);
            resolve(transactions[count - 1]!);
          }
        };
        observers.add(inspect);
        inspect();
      });
    },
    timeout() {
      assert.equal(timers.size, 1);
      [...timers][0]!();
    },
  };
}

const initial = {
  draft: 'original',
  run: { base: 'turn', selection: { modelId: 'before' } },
  marker: undefined,
  options: { project: 'project', agent: 'before' },
};
const replacement = {
  draft: 'original + instructions',
  run: { base: 'turn', selection: { modelId: 'after' } },
  marker: { roleId: 'role', version: 1 },
  options: { project: 'project', agent: 'after' },
};
const entries = () =>
  Object.keys(initial).map((key) => ({
    key,
    expected: initial[key as keyof typeof initial],
    value: replacement[key as keyof typeof replacement],
  }));
test('role draft transaction saves all four keys together and rejects a competing page without partial writes', async () => {
  const f = fixture(initial);
  const a = f.compareDraftBundle(entries(), () => true),
    b = f.compareDraftBundle(entries(), () => true);
  const ta = await f.transaction(),
    tb = await f.transaction(2);
  ta.read();
  assert.deepEqual(Object.fromEntries(f.rows), initial, 'puts are invisible before commit');
  ta.complete();
  assert.equal(await a, true);
  tb.read();
  tb.complete();
  assert.equal(await b, false);
  assert.equal(tb.putCount, 0);
  assert.deepEqual(Object.fromEntries(f.rows), replacement);
});
test('a changed run selection or marker aborts role application without changing the plain draft', async () => {
  for (const key of ['run', 'marker']) {
    const f = fixture({ ...initial, [key]: { different: 'another tab' } });
    const work = f.compareDraftBundle(entries(), () => true),
      tx = await f.transaction();
    tx.read();
    tx.complete();
    assert.equal(await work, false);
    assert.equal(tx.putCount, 0);
    assert.equal(f.rows.get('draft'), 'original');
  }
});
test('role application cancellation or timeout rolls back every staged key and ignores late completion', async () => {
  for (const reason of ['cancel', 'timeout'])
    for (const beforePut of [true, false]) {
      const f = fixture(initial),
        signal = new AbortController();
      const work = f.compareDraftBundle(entries(), () => true, signal.signal),
        rejected = assert.rejects(work);
      const tx = await f.transaction();
      if (!beforePut) tx.read();
      if (reason === 'cancel') signal.abort();
      else f.timeout();
      await rejected;
      tx.lateRead();
      tx.lateComplete();
      tx.complete();
      assert.equal(tx.aborted, true);
      assert.deepEqual(Object.fromEntries(f.rows), initial);
    }
});
test('a scope change while reading prevents all role bundle writes', async () => {
  const f = fixture(initial);
  let current = true;
  const work = f.compareDraftBundle(entries(), () => current),
    rejected = assert.rejects(work),
    tx = await f.transaction();
  current = false;
  tx.read();
  await rejected;
  assert.equal(tx.putCount, 0);
  assert.deepEqual(Object.fromEntries(f.rows), initial);
});
