import test from 'node:test';
import assert from 'node:assert/strict';

// The production module opens its shared database at import. These tests use
// the actual CAS factory with a separate, explicitly driven transaction peer.
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  value: { open: () => ({}) },
});
const { createCacheCompareText } = await import('../src/web/cache');
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
  const compareText = createCacheCompareText({
    database: async () => database as unknown as IDBDatabase,
    schedule: (callback) => {
      timers.add(callback);
      return callback;
    },
    cancel: (timer) => timers.delete(timer as () => void),
  });
  return {
    compareText,
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

test('text draft CAS preserves the string format and competing tabs cannot overwrite each other', async () => {
  const f = fixture({ draft: 'original' });
  const a = f.compareText('draft', 'original', 'original + reviewed A', () => true);
  const b = f.compareText('draft', 'original', 'original + reviewed B', () => true);
  const ta = await f.transaction(),
    tb = await f.transaction(2);
  ta.read();
  ta.complete();
  assert.equal(await a, true);
  tb.read();
  tb.complete();
  assert.equal(await b, false);
  assert.equal(f.rows.get('draft'), 'original + reviewed A');
});
test('text append cancellation after put aborts the actual transaction and preserves the old draft', async () => {
  const f = fixture({ draft: 'original' }),
    signal = new AbortController();
  const writing = f.compareText('draft', 'original', 'must not commit', () => true, signal.signal);
  const rejected = assert.rejects(writing),
    tx = await f.transaction();
  tx.read();
  assert.equal(tx.putCount, 1);
  signal.abort();
  await rejected;
  tx.complete();
  tx.lateRead();
  tx.lateComplete();
  assert.equal(tx.aborted, true);
  assert.equal(f.rows.get('draft'), 'original');
});
test('text CAS timeout aborts before or after put, never commits after reporting failure', async () => {
  for (const beforePut of [true, false]) {
    const f = fixture({ draft: 'original' });
    const writing = f.compareText('draft', 'original', 'must not commit', () => true);
    const rejected = assert.rejects(writing, /超时/),
      tx = await f.transaction();
    if (!beforePut) tx.read();
    f.timeout();
    await rejected;
    tx.lateRead();
    tx.complete();
    tx.lateComplete();
    assert.equal(tx.aborted, true);
    assert.equal(f.rows.get('draft'), 'original');
  }
});
test('a target invalidated while reading the text draft cannot issue a put', async () => {
  const f = fixture({ draft: 'original' });
  let current = true;
  const writing = f.compareText('draft', 'original', 'must not commit', () => current);
  const rejected = assert.rejects(writing),
    tx = await f.transaction();
  current = false;
  tx.read();
  await rejected;
  assert.equal(tx.putCount, 0);
  assert.equal(f.rows.get('draft'), 'original');
});
