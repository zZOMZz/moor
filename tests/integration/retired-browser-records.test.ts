import assert from 'node:assert/strict';
import test from 'node:test';
import { readRetiredSecureRecords } from '../../apps/web/src/platform/browser/retired-records';
import {
  createBrowserUiPorts,
  type BrowserUiEnvironment,
} from '../../apps/web/src/platform/browser/ui-ports';
import {
  createDesktopUiPorts,
  type DesktopUiBridge,
} from '../../apps/web/src/platform/desktop/ui-ports';

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
test('retired export uses the explicitly assembled capability and never falls back from missing desktop support', async () => {
  let downloads = 0,
    saves = 0;
  const environment = {
    window: { document: { createElement: () => ({ click: () => downloads++ }) } },
    location: {},
    request: async () => {
      throw Error('export must not request a Host');
    },
  } as unknown as BrowserUiEnvironment;
  const bridge: DesktopUiBridge = {
    version: 1,
    appearance: async () => 'system',
    onAppearance: () => () => {},
    googleAuth: {
      begin: async () => ({ flowId: 'unused', code: 'unused' }),
      complete: async () => ({ completed: false }),
      cancel: async () => {},
    },
    saveAttachment: async () => ({ status: 'cancelled' }),
    cancelAttachmentSave: async () => {},
  };
  const value = {
    format: 'moor-retired-web-v1' as const,
    records: [{ key: 'original', value: { body: 'frozen original bytes' } }],
  };
  const browser = createBrowserUiPorts(environment);
  assert.deepEqual(await browser.retired.export(value, () => true), { status: 'handed-off' });
  assert.equal(downloads, 1);
  assert.throws(
    () => createDesktopUiPorts(environment, bridge, undefined as never),
    /桌面历史数据导出接口不可用/,
  );
  const desktop = createDesktopUiPorts(environment, bridge, async (input) => {
    assert.deepEqual(input, value);
    saves++;
    return { canceled: false };
  });
  assert.deepEqual(await desktop.retired.export(value, () => false), { status: 'cancelled' });
  assert.equal(saves, 0);
  assert.deepEqual(await desktop.retired.export(value, () => true), { status: 'saved' });
  assert.equal(saves, 1);
  assert.equal(downloads, 1);
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
