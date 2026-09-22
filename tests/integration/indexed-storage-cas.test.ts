import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { IndexedStorage } from '../../apps/web/src/platform/indexed-storage';

type Request = { result?: unknown; onsuccess?: () => void };
function fixture(t: TestContext, initial: [string, unknown][]) {
  const rows = new Map(initial),
    transactions: { read(): void; complete(): void; finished: boolean; puts: number }[] = [],
    observers = new Set<() => void>();
  const database = {
    close() {},
    transaction(name: string, mode: string) {
      assert.equal(name, 'state');
      assert.equal(mode, 'readwrite');
      const reads: [string, Request][] = [],
        writes: [string, unknown, Request][] = [];
      const tx = {
        finished: false,
        puts: 0,
        onabort: undefined as (() => void) | undefined,
        oncomplete: undefined as (() => void) | undefined,
        objectStore() {
          return {
            get(key: string) {
              const request: Request = {};
              reads.push([key, request]);
              return request;
            },
            put(value: unknown, key: string) {
              assert.equal(tx.finished, false, 'no late write after abort or completion');
              tx.puts++;
              const request: Request = {};
              writes.push([key, structuredClone(value), request]);
              return request;
            },
          };
        },
        abort() {
          if (tx.finished) return;
          tx.finished = true;
          writes.length = 0;
          tx.onabort?.();
        },
        read() {
          assert.equal(
            transactions.find((candidate) => !candidate.finished),
            tx,
          );
          for (const [key, request] of reads) {
            request.result = structuredClone(rows.get(key));
            request.onsuccess?.();
          }
        },
        complete() {
          if (tx.finished) return;
          for (const [, , request] of writes) request.onsuccess?.();
          if (tx.finished) return;
          for (const [key, value] of writes) rows.set(key, value);
          tx.finished = true;
          tx.oncomplete?.();
        },
      };
      transactions.push(tx);
      for (const observe of observers) observe();
      return tx;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open() {
        const request: Request & { result: unknown } = { result: database };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
  });
  const storage = new IndexedStorage({ databaseName: 'moor-desktop-workspace-v1', locks: null });
  t.after(() => {
    storage.close();
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
  return {
    rows,
    storage,
    transaction(count: number) {
      return new Promise<(typeof transactions)[number]>((resolve) => {
        const observe = () => {
          if (transactions.length >= count) {
            observers.delete(observe);
            resolve(transactions[count - 1]!);
          }
        };
        observers.add(observe);
        observe();
      });
    },
  };
}

test('current IndexedStorage confirms only committed CAS and rejects a competing page without overwriting its original', async (t) => {
  const original = { pending: 'original', revision: 1 },
    newer = { pending: 'new', revision: 2 };
  const f = fixture(t, [['operation', original]]);
  let confirmed = false;
  const first = f.storage
    .compareAndSet('operation', original, newer, () => {})
    .then(() => {
      confirmed = true;
    });
  const competing = f.storage.compareAndSet(
    'operation',
    original,
    { pending: 'competing' },
    () => {},
  );
  const rejected = assert.rejects(competing, /另一页面改变/);
  const firstTx = await f.transaction(1),
    secondTx = await f.transaction(2);
  firstTx.read();
  assert.equal(confirmed, false);
  assert.deepEqual(f.rows.get('operation'), original);
  firstTx.complete();
  await first;
  secondTx.read();
  secondTx.complete();
  await rejected;
  assert.equal(secondTx.puts, 0);
  assert.deepEqual(f.rows.get('operation'), newer);
});

for (const afterPut of [false, true])
  test(`current IndexedStorage scope invalidation ${afterPut ? 'after put' : 'before read'} preserves the operation and draft together`, async (t) => {
    const f = fixture(t, [
      ['operation', 'original'],
      ['draft', 'edited text'],
    ]);
    let valid = true;
    const writing = f.storage.compareAndSetMany(
      [
        { key: 'operation', expected: 'original', value: 'confirmed' },
        { key: 'draft', expected: 'edited text', value: '' },
      ],
      () => {
        if (!valid) throw Error('synthetic changed target');
      },
    );
    const rejected = assert.rejects(writing, /changed target/);
    const tx = await f.transaction(1);
    if (afterPut) {
      tx.read();
      assert.equal(tx.puts, 2);
    }
    valid = false;
    if (!afterPut) tx.read();
    tx.complete();
    await rejected;
    assert.deepEqual(
      [...f.rows],
      [
        ['operation', 'original'],
        ['draft', 'edited text'],
      ],
    );
    assert.equal(tx.puts, afterPut ? 2 : 0);
  });
