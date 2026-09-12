import test from 'node:test';
import assert from 'node:assert/strict';

// The production module opens its shared database at import. These tests use
// the actual CAS factory with a separate, explicitly driven transaction peer.
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  value: { open: () => ({}) },
});
const { createCacheCompareWrite } = await import('../src/web/cache');
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
      const request: Request = {},
        writes = new Map<string, unknown>(),
        puts: Request[] = [];
      let readKey: string | undefined;
      const transaction: Transaction = {
        putCount: 0,
        aborted: false,
        finished: false,
        objectStore(name) {
          assert.equal(name, 'cache');
          return {
            get(key) {
              readKey = key;
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
          assert.ok(readKey);
          request.result = structuredClone(rows.get(readKey));
          request.onsuccess?.();
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
          request.result = undefined;
          request.onsuccess?.();
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
  const compareWrite = createCacheCompareWrite({
    database: async () => database as unknown as IDBDatabase,
    schedule: (callback) => {
      timers.add(callback);
      return callback;
    },
    cancel: (timer) => timers.delete(timer as () => void),
  });
  return {
    compareWrite,
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
const pending = (operationId: string, cacheRevision: number) => ({
  cacheRevision,
  pending: { operationId },
});

test('actual cache CAS serializes competing readwrite transactions so a stale controller cannot overwrite newer pending state', async () => {
  const f = fixture(),
    first = pending('original-operation', 1),
    second = pending('competing-operation', 1),
    writing = f.compareWrite('git-target', 0, first, () => true),
    competing = f.compareWrite('git-target', 0, second, () => true);
  const firstTransaction = await f.transaction(),
    secondTransaction = await f.transaction(2);
  firstTransaction.read();
  assert.equal(firstTransaction.putCount, 1);
  assert.equal(f.rows.has('git-target'), false, 'a put request alone is not a durable write');
  firstTransaction.complete();
  assert.equal(await writing, true);
  secondTransaction.read();
  secondTransaction.complete();
  assert.equal(await competing, false);
  assert.equal(secondTransaction.putCount, 0);
  assert.deepEqual(f.rows.get('git-target'), first);
  assert.equal(f.timers.size, 0);
});

test('actual cache CAS upgrades a legacy zero revision but rejects an old completion after a newer revision was saved', async () => {
  const f = fixture({ 'git-target': { pending: { operationId: 'legacy-operation' } } }),
    newer = pending('new-operation', 1),
    upgrade = f.compareWrite('git-target', 0, newer, () => true),
    transaction = await f.transaction();
  transaction.read();
  transaction.complete();
  assert.equal(await upgrade, true);
  const stale = f.compareWrite('git-target', 0, { cacheRevision: 1 }, () => true),
    staleTransaction = await f.transaction(2);
  staleTransaction.read();
  staleTransaction.complete();
  assert.equal(await stale, false);
  assert.equal(staleTransaction.putCount, 0);
  assert.deepEqual(f.rows.get('git-target'), newer);
});

test('actual cache CAS rejects an invalidated controller before the delayed read can write and ignores late completion', async () => {
  const original = pending('original-operation', 2),
    f = fixture({ 'git-target': original });
  let current = true;
  const writing = f.compareWrite('git-target', 2, pending('late-operation', 3), () => current),
    failed = assert.rejects(writing),
    transaction = await f.transaction();
  current = false;
  transaction.read();
  transaction.complete();
  await failed;
  assert.equal(transaction.putCount, 0);
  transaction.lateComplete();
  assert.deepEqual(f.rows.get('git-target'), original);
  assert.equal(f.timers.size, 0);
});

test('actual cache CAS timeout aborts a pending read and its late success cannot issue a put', async () => {
  const original = pending('original-operation', 4),
    f = fixture({ 'git-target': original }),
    writing = f.compareWrite('git-target', 4, pending('late-operation', 5), () => true),
    failed = assert.rejects(writing, /超时/),
    transaction = await f.transaction();
  f.timeout();
  await failed;
  assert.equal(f.aborts, 1);
  assert.equal(transaction.aborted, true);
  transaction.lateRead();
  transaction.lateComplete();
  assert.equal(transaction.putCount, 0);
  assert.deepEqual(f.rows.get('git-target'), original);
});

test('actual cache CAS timeout rolls back an already queued put instead of letting it commit after rejection', async () => {
  const original = pending('original-operation', 7),
    f = fixture({ 'git-target': original }),
    writing = f.compareWrite('git-target', 7, pending('late-operation', 8), () => true),
    failed = assert.rejects(writing, /超时/),
    transaction = await f.transaction();
  transaction.read();
  assert.equal(transaction.putCount, 1);
  assert.deepEqual(f.rows.get('git-target'), original);
  f.timeout();
  await failed;
  assert.equal(f.aborts, 1);
  transaction.complete();
  transaction.lateComplete();
  assert.deepEqual(f.rows.get('git-target'), original);
  assert.equal(f.timers.size, 0);
});
