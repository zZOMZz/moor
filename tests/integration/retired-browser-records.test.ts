import test from 'node:test';
import assert from 'node:assert/strict';
import { readRetiredSecureRecords } from '../../apps/web/src/platform/retired-records';

test('retired-data inspection does not create a missing database', async (t) => {
  let opened = false;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      databases: async () => [{ name: 'moor-desktop-workspace-v1' }],
      open: () => {
        opened = true;
        throw Error('must not create storage');
      },
    },
  });
  t.after(() =>
    descriptor
      ? Object.defineProperty(globalThis, 'indexedDB', descriptor)
      : Reflect.deleteProperty(globalThis, 'indexedDB'),
  );
  assert.deepEqual(await readRetiredSecureRecords(), []);
  assert.equal(opened, false);
});

test('retired-data inspection only opens readonly transactions and preserves unknown request bytes', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const records = [
    {
      key: '["moor-secure-operations-v1",{"owner":"synthetic"}]',
      value: {
        operations: [{ operationId: 'original-id', body: '{"text":"frozen"}', state: 'pending' }],
      },
    },
  ];
  let closed = false;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      databases: async () => [{ name: 'moor-secure-workspace-v1' }],
      open: (name: string) => {
        assert.equal(name, 'moor-secure-workspace-v1');
        const open: any = {
          result: {
            objectStoreNames: { contains: (store: string) => store === 'state' },
            close: () => {
              closed = true;
            },
            transaction(store: string, mode: string) {
              assert.equal(store, 'state');
              assert.equal(mode, 'readonly');
              const transaction: any = {
                objectStore: () => ({
                  openCursor: () => {
                    const cursor: any = {
                      result: {
                        ...structuredClone(records[0]),
                        continue: () => {
                          queueMicrotask(() => {
                            cursor.result = null;
                            cursor.onsuccess();
                            transaction.oncomplete();
                          });
                        },
                      },
                    };
                    queueMicrotask(() => cursor.onsuccess());
                    return cursor;
                  },
                }),
              };
              return transaction;
            },
          },
        };
        queueMicrotask(() => open.onsuccess());
        return open;
      },
    },
  });
  t.after(() =>
    descriptor
      ? Object.defineProperty(globalThis, 'indexedDB', descriptor)
      : Reflect.deleteProperty(globalThis, 'indexedDB'),
  );
  assert.deepEqual(await readRetiredSecureRecords(), records);
  assert.equal(closed, true);
  assert.equal(records[0]!.value.operations[0]!.state, 'pending');
});
