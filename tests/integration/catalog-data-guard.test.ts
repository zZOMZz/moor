import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import {
  assertCatalogDataSettled,
  type CatalogDataScope,
} from '../../apps/web/src/platform/catalog-data-guard';

const scope: CatalogDataScope = {
  owner: 'owner',
  origin: 'https://synthetic.invalid',
  deviceId: 'device',
  workspaceId: 'runtime',
  localProjectId: 'project-a',
  replicaId: 'replica-a',
  catalogWorkspaceId: 'catalog',
  catalogProjectIds: ['logical-a'],
};
const target = (project = 'a') => ({
  source: 'remote',
  target: {
    owner: 'owner',
    serverKey: scope.origin,
    deviceId: 'device',
    workspaceId: 'runtime',
    localProjectId: 'project-' + project,
    replicaId: 'replica-' + project,
  },
});
function environment(
  t: TestContext,
  databases: Map<string, Map<string, unknown>>,
  local = new Map<string, string>(),
) {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const put = (key: string, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  };
  const reads: string[] = [];
  put('location', { origin: scope.origin });
  put('localStorage', {
    get length() {
      return local.size;
    },
    key: (index: number) => [...local.keys()][index],
    getItem: (key: string) => local.get(key) ?? null,
  });
  put('indexedDB', {
    databases: async () => [...databases.keys()].map((name) => ({ name })),
    open(name: string) {
      const values = databases.get(name)!;
      assert(values, 'guard never creates an absent database');
      const opening: any = {
        result: {
          objectStoreNames: { contains: () => true },
          close() {},
          transaction(_name: string, mode: string) {
            assert.equal(mode, 'readonly');
            let aborted = false;
            const tx: any = {
              abort() {
                aborted = true;
                queueMicrotask(() => tx.onabort());
              },
              objectStore() {
                return {
                  openKeyCursor() {
                    const keys = [...values.keys()].sort();
                    let index = 0;
                    const request: any = {};
                    const step = () => {
                      if (aborted) return;
                      const key = keys[index++];
                      request.result =
                        key === undefined ? null : { key, continue: () => queueMicrotask(step) };
                      request.onsuccess();
                      if (key === undefined && !aborted) queueMicrotask(() => tx.oncomplete());
                    };
                    queueMicrotask(step);
                    return request;
                  },
                  get(key: string) {
                    reads.push(key);
                    const request: any = { result: structuredClone(values.get(key)) };
                    queueMicrotask(() => {
                      if (!aborted) request.onsuccess();
                    });
                    return request;
                  },
                };
              },
            };
            return tx;
          },
        },
      };
      queueMicrotask(() => opening.onsuccess());
      return opening;
    },
  });
  t.after(() => {
    for (const [key, descriptor] of descriptors)
      descriptor
        ? Object.defineProperty(globalThis, key, descriptor)
        : Reflect.deleteProperty(globalThis, key);
  });
  return reads;
}

test('routing changes cannot bypass a draft in another saved session while the current view is elsewhere', async (t) => {
  const stored = target(),
    key = canonical(['moor-desktop-draft-v1', stored, 'session-a']);
  const values = new Map([[key, { scope: stored, value: { revision: 3, text: 'Unsent A' } }]]);
  const before = structuredClone(values);
  environment(t, new Map([['moor-desktop-workspace-v1', values]]));
  await assert.rejects(assertCatalogDataSettled(scope), /未发送草稿/);
  assert.deepEqual(values, before);
});

test('unfinished operations, attachments and provider drafts block their exact project without reading blobs', async (t) => {
  const stored = target();
  const values = new Map<string, unknown>();
  const reads = environment(t, new Map([['moor-desktop-workspace-v1', values]]));
  const ledger = canonical(['moor-desktop-ledger-v1', stored]);
  values.set(ledger, {
    version: 2,
    scope: stored,
    pending: [{ id: 'unknown-original', sessionId: 'elsewhere' }],
    recent: [],
  });
  await assert.rejects(assertCatalogDataSettled(scope), /待确认操作/);
  values.set(ledger, { version: 2, scope: stored, pending: [], recent: [] });
  const attachment = canonical(['moor-desktop-record-v2', stored, 'attachments', 'session-a']);
  values.set(attachment, {
    version: 2,
    scope: stored,
    kind: 'attachments',
    value: { items: [{ reference: { attachmentId: 'attachment' }, blob: 'immutable-blob' }] },
  });
  const blob = canonical(['moor-desktop-record-v2', stored, 'attachment-blob', 'immutable-blob']);
  values.set(blob, 'large bytes are not needed to check unfinished state');
  await assert.rejects(assertCatalogDataSettled(scope), /附件/);
  assert(!reads.includes(blob));
  values.delete(attachment);
  values.set(canonical(['moor-desktop-record-v2', stored, 'githubWrite', 'session-a']), {
    version: 2,
    scope: stored,
    kind: 'githubWrite',
    value: { drafts: { draft: { values: { body: 'Unsent comment' } } } },
  });
  await assert.rejects(assertCatalogDataSettled(scope), /未发送/);
});

test('completed records and another project do not block a settled project', async (t) => {
  const stored = target(),
    other = target('b');
  const values = new Map<string, unknown>([
    [
      canonical(['moor-desktop-ledger-v1', stored]),
      { version: 2, scope: stored, pending: [], recent: [{ id: 'complete', status: 'confirmed' }] },
    ],
    [
      canonical(['moor-desktop-draft-v1', other, 'session-b']),
      { scope: other, value: { text: 'Other project draft' } },
    ],
    [
      canonical(['moor-desktop-record-v2', stored, 'git', 'session-a']),
      { version: 2, scope: stored, kind: 'git', value: { receipt: { phase: 'accepted' } } },
    ],
  ]);
  const reads = environment(t, new Map([['moor-desktop-workspace-v1', values]]));
  await assertCatalogDataSettled(scope);
  assert(!reads.some((key) => key.includes('session-b')));
});

test('legacy browser outboxes and collaboration composers are also protected', async (t) => {
  const legacy = new Map<string, unknown>([
    ['owner/device/runtime/session-a/pending', { operationId: 'old-original' }],
  ]);
  const composer = new Map<string, string>();
  environment(t, new Map([['moor-runtime-v1', legacy]]), composer);
  await assert.rejects(assertCatalogDataSettled(scope), /待确认/);
  legacy.clear();
  composer.set(
    JSON.stringify([
      'moor-collaboration-composer',
      scope.origin,
      { accountId: scope.owner },
      { workspaceId: 'catalog', projectId: 'logical-a' },
      'shared-draft',
    ]),
    JSON.stringify({ text: 'Still editable' }),
  );
  await assert.rejects(assertCatalogDataSettled(scope), /草稿/);
});

test('saved attention continuation drafts remain reachable until handled', async (t) => {
  const stored = target();
  const values = new Map<string, unknown>([
    [
      canonical(['moor-desktop-record-v2', stored, 'attention', 'bucket']),
      {
        version: 2,
        scope: stored,
        kind: 'attention',
        value: {
          entries: { 'item/draft': { text: 'Unsent continuation', saved: true, shared: false } },
        },
      },
    ],
  ]);
  environment(t, new Map([['moor-desktop-workspace-v1', values]]));
  await assert.rejects(assertCatalogDataSettled(scope), /未发送草稿/);
});

test('legacy attention nested keys retain drafts and original operations for their machine', async (t) => {
  const attention = JSON.stringify([
    'attention-v1',
    scope.origin,
    JSON.stringify(['account', 'authority', scope.owner]),
    'machine',
    scope.workspaceId,
    scope.localProjectId,
  ]);
  const item = JSON.stringify([attention, 'old-session', 'old-item']);
  const values = new Map<string, unknown>([
    [item + '/draft', { text: 'Saved before upgrade', saved: true, shared: false }],
  ]);
  environment(t, new Map([['moor-runtime-v1', values]]));
  await assert.rejects(assertCatalogDataSettled({ ...scope, machineId: 'machine' }), /草稿/);
  await assertCatalogDataSettled({ ...scope, machineId: 'other-machine' });
  values.clear();
  values.set(item + '/pending/' + scope.deviceId, {
    operation: { kind: 'continue', body: { operationId: 'original' } },
  });
  await assert.rejects(assertCatalogDataSettled({ ...scope, machineId: 'machine' }), /待确认/);
});
