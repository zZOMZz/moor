import test from 'node:test';
import assert from 'node:assert/strict';
import { IndexedStorage } from '../../apps/web/src/platform/indexed-storage';
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
for (const cause of ['deadline', 'close'] as const)
  test(`IndexedDB operation lock waiting is bounded by ${cause} and never starts the task`, async () => {
    const deadline = new AbortController(),
      requested = signal();
    let duration = 0,
      calls = 0;
    const locks = {
      request: ((_key: string, options: LockOptions) =>
        new Promise((_resolve, reject) => {
          const signal = options.signal!;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          if (signal.aborted) reject(signal.reason);
          requested.resolve();
        })) as LockManager['request'],
    };
    const backend = new IndexedStorage({
      databaseName: 'moor-desktop-workspace-v1',
      locks,
      deadline: (milliseconds) => {
        duration = milliseconds;
        return deadline.signal;
      },
    });
    const pending = backend.exclusive('synthetic-operation', current, async () => {
      calls++;
    });
    const rejected = assert.rejects(pending);
    await requested.promise;
    if (cause === 'deadline') deadline.abort(Error('synthetic deadline'));
    else backend.close();
    await rejected;
    assert.equal(duration, 30000);
    assert.equal(calls, 0);
  });

test('missing native Web Locks fails closed instead of using an unsafe per-window mutex', async () => {
  const backend = new IndexedStorage({ databaseName: 'moor-desktop-workspace-v1', locks: null });
  let calls = 0;
  await assert.rejects(
    backend.exclusive('synthetic-operation', current, async () => {
      calls++;
    }),
    /无法协调/,
  );
  assert.equal(calls, 0);
});

function current() {}

test('IndexedDB physically deletes cache keys in the same CAS transaction and rolls deletion back on a lost guard', async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  try {
    for (const failAfterDelete of [false, true]) {
      let values = new Map<string, unknown>([
        ['head', 'old-head'],
        ['cache-old', 'old-page'],
        ['draft', 'keep-draft'],
      ]);
      let valid = true;
      const deletes: string[] = [];
      const db = {
        close() {},
        createObjectStore() {},
        transaction() {
          const staged = new Map(values);
          let pending = 0,
            aborted = false,
            completed = false;
          const transaction: any = {
            abort() {
              aborted = true;
              queueMicrotask(() => transaction.onabort?.());
            },
            objectStore: () => ({
              get: (key: string) =>
                operation((request) => {
                  request.result = staged.get(key);
                }),
              put: (value: unknown, key: string) =>
                operation(() => {
                  staged.set(key, structuredClone(value));
                }),
              delete: (key: string) =>
                operation(() => {
                  deletes.push(key);
                  staged.delete(key);
                  if (failAfterDelete) valid = false;
                }),
            }),
          };
          function complete() {
            queueMicrotask(() => {
              if (!aborted && !completed && !pending) {
                completed = true;
                values = staged;
                transaction.oncomplete?.();
              }
            });
          }
          function operation(work: (request: any) => void) {
            const request: any = {};
            pending++;
            queueMicrotask(() => {
              if (aborted) return;
              work(request);
              request.onsuccess?.();
              pending--;
              complete();
            });
            return request;
          }
          complete();
          return transaction;
        },
      };
      Object.defineProperty(globalThis, 'indexedDB', {
        configurable: true,
        value: {
          open() {
            const request: any = { result: db };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
        },
      });
      const storage = new IndexedStorage({
        databaseName: 'moor-desktop-workspace-v1',
        locks: null,
      });
      const checked = () => {
        if (!valid) throw Error('synthetic lost scope');
      };
      const write = storage.compareAndSetMany(
        [
          { key: 'head', expected: 'old-head', value: 'new-head' },
          { key: 'cache-old', expected: 'old-page', delete: true },
          { key: 'cache-new', expected: null, value: 'new-page' },
        ],
        checked,
      );
      if (failAfterDelete) {
        await assert.rejects(write, /lost scope/);
        assert.deepEqual(
          values,
          new Map([
            ['head', 'old-head'],
            ['cache-old', 'old-page'],
            ['draft', 'keep-draft'],
          ]),
        );
      } else {
        await write;
        assert.equal(values.has('cache-old'), false);
        assert.equal(values.get('head'), 'new-head');
        assert.equal(values.get('cache-new'), 'new-page');
        assert.equal(values.get('draft'), 'keep-draft');
      }
      assert.deepEqual(deletes, ['cache-old']);
      valid = true;
      await assert.rejects(
        storage.compareAndSetMany(
          [{ key: 'draft', expected: 'keep-draft', delete: true, value: 'ambiguous' } as never],
          checked,
        ),
        /不能携带/,
      );
      assert.equal(values.get('draft'), 'keep-draft');
      storage.close();
    }
  } finally {
    if (prior) Object.defineProperty(globalThis, 'indexedDB', prior);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});
