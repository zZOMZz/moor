import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkspaceStore,
  type WorkspaceScope,
  type WorkspaceLedger,
} from '../../apps/web/src/features/workspace/workspace-store';
import {
  WORKSPACE_RECENT_OPERATIONS,
  WORKSPACE_RECENT_OPERATION_BYTES,
  workspaceLedgerKey,
  workspaceRecordKey,
} from '../../apps/web/src/features/workspace/workspace-records';
import { createAttachmentDraftItem } from '../../apps/web/src/features/attachments/attachments';
import { emptyInteractionSaved } from '../../apps/web/src/features/interactions/interactions';
import type { StorageBackend, StorageChange } from '../../apps/web/src/platform/indexed-storage';
import type { SessionOriginalOperation } from '@moor/protocol/session-control-protocol';

const scope: WorkspaceScope = {
  source: 'local',
  target: {
    serverKey: 'local:machine',
    owner: 'synthetic-owner',
    deviceId: 'device',
    userId: 'user',
    machineId: 'machine',
    workspaceId: 'workspace',
    localProjectId: 'project',
    catalogWorkspaceId: 'catalog',
    catalogProjectId: 'catalog-project',
    replicaId: 'replica',
  },
};
const current = () => {};
const operation = (id: string, sessionId = 'session'): SessionOriginalOperation => ({
  kind: 'control',
  value: {
    controlVersion: 1,
    action: 'create',
    operationId: id,
    agentId: 'agent',
    sessionId,
    workspaceId: 'workspace',
    localProjectId: 'project',
    userId: 'user',
    machineId: 'machine',
  },
});
class Memory implements StorageBackend {
  values = new Map<string, unknown>();
  reads: string[] = [];
  batches: StorageChange[][] = [];
  fail = false;
  beforeCommit?: () => void;
  locks = new Map<string, Promise<unknown>>();
  async read(key: string) {
    this.reads.push(key);
    return structuredClone(this.values.get(key) ?? null);
  }
  async exclusive<T>(key: string, check: () => void, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key);
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, done);
    await previous;
    try {
      check();
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === done) this.locks.delete(key);
    }
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, check: () => void) {
    return this.compareAndSetMany([{ key, expected, value }], check);
  }
  async compareAndSetMany(changes: StorageChange[], check: () => void) {
    this.beforeCommit?.();
    check();
    if (this.fail) throw Error('Synthetic transaction failure');
    for (const change of changes)
      assert.deepEqual(this.values.get(change.key) ?? null, change.expected, 'CAS conflict');
    const copied = structuredClone(changes);
    check();
    for (const change of copied) this.values.set(change.key, change.value);
    this.batches.push(copied);
  }
}

test('completed operations pass the former lifetime limit, keep a bounded hot index and preserve unknown originals', async () => {
  const memory = new Memory(),
    store = new WorkspaceStore(memory);
  const unknown = operation('unknown', 'other-session');
  await store.stage(scope, unknown, undefined, current);
  for (let index = 0; index < 530; index++) {
    const original = operation('completed-' + index);
    await store.stage(scope, original, undefined, current);
    await store.finish(scope, original, 'confirmed', current);
  }
  const restored = new WorkspaceStore(memory),
    ledger = await restored.read(scope, current);
  assert.equal(ledger.operations.length, WORKSPACE_RECENT_OPERATIONS + 1);
  assert.equal(ledger.operations.filter((value) => value.status === 'pending').length, 1);
  assert.deepEqual((await restored.operation(scope, 'unknown', current))?.original, unknown);
  const archived = await restored.operation(scope, 'completed-0', current);
  assert.equal(archived?.status, 'confirmed');
  assert.deepEqual(archived?.original, operation('completed-0'));
  assert.deepEqual(
    await restored.stage(scope, operation('completed-0'), undefined, current),
    archived,
  );
  await assert.rejects(
    restored.stage(scope, operation('completed-0', 'different-session'), undefined, current),
    /改变/,
  );
  assert.equal(
    (await restored.read(scope, current)).operations.length,
    WORKSPACE_RECENT_OPERATIONS + 1,
  );
});

test('a version-one ledger migrates atomically on its first write, preserving every completed and unknown request', async () => {
  const memory = new Memory(),
    store = new WorkspaceStore(memory);
  const original: WorkspaceLedger = {
    version: 1,
    scope,
    revision: 9,
    operations: Array.from({ length: 512 }, (_, index) => ({
      original: operation('legacy-' + index),
      status: index === 511 ? 'pending' : 'confirmed',
    })),
  };
  memory.values.set(workspaceLedgerKey(scope), structuredClone(original));
  assert.deepEqual(await store.read(scope, current), original);
  assert.equal(memory.values.size, 1, 'reading valid legacy data is non-mutating');
  memory.fail = true;
  await assert.rejects(
    store.saveInteraction(scope, 'other-session', 0, emptyInteractionSaved(), current),
    /transaction failure/,
  );
  assert.deepEqual(memory.values.get(workspaceLedgerKey(scope)), original);
  assert.equal(memory.values.size, 1, 'failed migration leaves no partial records');
  memory.fail = false;
  await store.saveInteraction(scope, 'other-session', 0, emptyInteractionSaved(), current);
  assert.equal((memory.values.get(workspaceLedgerKey(scope)) as { version: number }).version, 2);
  for (const expected of original.operations)
    assert.deepEqual(
      await store.operation(scope, expected.original.value.operationId, current),
      expected,
    );
  const reopened = await new WorkspaceStore(memory).read(scope, current);
  assert.equal(reopened.operations.filter((value) => value.status === 'pending').length, 1);
  assert.equal(reopened.operations.length, WORKSPACE_RECENT_OPERATIONS + 1);
  await store.stage(scope, operation('after-migration'), undefined, current);
  assert.equal(
    (await store.read(scope, current)).operations.at(-1)!.original.value.operationId,
    'after-migration',
  );
});

test('a session transaction neither reads nor rewrites another session attachment bytes or archived history', async () => {
  const memory = new Memory(),
    store = new WorkspaceStore(memory);
  const item = await createAttachmentDraftItem(
    new File(['a'.repeat(512 * 1024)], 'synthetic.txt', { type: 'text/plain' }),
    'attachment-a',
  );
  await store.saveAttachments(scope, 'session-a', 0, [item], current);
  const aKey = workspaceRecordKey(scope, 'attachments', 'session-a');
  const a = structuredClone(memory.values.get(aKey));
  assert(
    !JSON.stringify(a).includes(item.data),
    'feature state contains only an immutable blob reference',
  );
  memory.reads = [];
  memory.batches = [];
  await store.saveInteraction(scope, 'session-b', 0, emptyInteractionSaved(), current);
  const b = await store.read(scope, current, 'session-b');
  assert.equal(b.attachments, undefined);
  assert(!memory.reads.includes(aKey));
  assert(!memory.reads.some((key) => key.includes('attachment-blob')));
  assert(
    memory.batches.every((batch) =>
      batch.every((change) => change.key !== aKey && !change.key.includes('attachment-blob')),
    ),
  );
  assert.deepEqual(memory.values.get(aKey), a);
  assert.deepEqual(
    (await store.read(scope, current, 'session-a')).attachments?.['session-a']?.items[0],
    item,
  );
});

test('stale record versions abort an operation and its attachment transition as one transaction', async () => {
  const memory = new Memory(),
    store = new WorkspaceStore(memory);
  const item = await createAttachmentDraftItem(
    new File(['frozen'], 'synthetic.txt', { type: 'text/plain' }),
    'attachment',
  );
  await store.saveAttachments(scope, 'session', 0, [item], current);
  const upload: SessionOriginalOperation = {
    kind: 'attachment',
    value: {
      action: 'upload',
      operationId: 'upload',
      contentVersion: 1,
      workspaceId: 'workspace',
      localProjectId: 'project',
      sessionId: 'session',
      attachment: item.reference,
      data: item.data,
    },
  };
  const before = structuredClone(memory.values);
  memory.fail = true;
  await assert.rejects(store.stage(scope, upload, undefined, current), /transaction failure/);
  assert.deepEqual(memory.values, before);
  memory.fail = false;
  await store.stage(scope, upload, undefined, current);
  const pending = structuredClone(memory.values);
  memory.fail = true;
  await assert.rejects(store.finish(scope, upload, 'confirmed', current), /transaction failure/);
  assert.deepEqual(memory.values, pending);
  memory.fail = false;
  await new WorkspaceStore(memory).finish(scope, upload, 'confirmed', current);
  assert.equal((await store.operation(scope, 'upload', current))?.status, 'confirmed');
  const attachments = (await store.read(scope, current, 'session')).attachments!.session!;
  assert.equal(attachments.items[0]!.uploaded, true);
  assert.equal(attachments.items[0]!.pending, undefined);
});

test('two windows cannot overwrite the same feature revision and a changed head preserves the competing writer', async () => {
  const memory = new Memory(),
    first = new WorkspaceStore(memory),
    second = new WorkspaceStore(memory);
  const results = await Promise.allSettled([
    first.saveInteraction(scope, 'session', 0, emptyInteractionSaved(), current),
    second.saveInteraction(scope, 'session', 0, emptyInteractionSaved(), current),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const headKey = workspaceLedgerKey(scope);
  const head = structuredClone(memory.values.get(headKey)) as { revision: number };
  memory.beforeCommit = () => {
    memory.beforeCommit = undefined;
    memory.values.set(headKey, { ...head, revision: head.revision + 1 });
  };
  await assert.rejects(
    first.stage(scope, operation('competing'), undefined, current),
    /CAS conflict/,
  );
  assert.equal(memory.values.has(workspaceRecordKey(scope, 'operation', 'competing')), false);
  assert.equal((memory.values.get(headKey) as { revision: number }).revision, head.revision + 1);
});

test('draft confirmation survives hot-index eviction and never clears a later editable draft', async () => {
  const memory = new Memory(),
    store = new WorkspaceStore(memory);
  const draft = await store.saveDraft(scope, 'session', 0, 'Frozen prompt', {}, current);
  const send: SessionOriginalOperation = {
    kind: 'mutation',
    value: {
      operationId: 'send',
      workspaceId: 'workspace',
      sessionId: 'session',
      kind: 'turn',
      expectedTurnId: null,
      update: 'AA==',
    },
  };
  await store.stage(scope, send, { sessionId: 'session', revision: draft.revision }, current);
  await store.finish(scope, send, 'confirmed', current);
  for (let index = 0; index <= WORKSPACE_RECENT_OPERATIONS; index++) {
    const value = operation('later-' + index, 'another-session');
    await store.stage(scope, value, undefined, current);
    await store.finish(scope, value, 'confirmed', current);
  }
  const ledger = await store.read(scope, current, 'session');
  assert.equal(ledger.operations.length, 0);
  const cleared = await store.readDraft(scope, 'session', current, ledger);
  assert.equal(cleared.text, '');
  const newer = await store.saveDraft(
    scope,
    'session',
    cleared.revision,
    'Next editable draft',
    {},
    current,
  );
  assert.deepEqual(await store.readDraft(scope, 'session', current), newer);
});

test('large completed requests leave the hot byte budget while their exact archived body remains readable', async () => {
  const memory = new Memory(),
    store = new WorkspaceStore(memory);
  const item = await createAttachmentDraftItem(
    new File(['x'.repeat(WORKSPACE_RECENT_OPERATION_BYTES)], 'large.txt', { type: 'text/plain' }),
    'large-attachment',
  );
  await store.saveAttachments(scope, 'session', 0, [item], current);
  const original: SessionOriginalOperation = {
    kind: 'attachment',
    value: {
      action: 'upload',
      operationId: 'large-upload',
      contentVersion: 1,
      workspaceId: 'workspace',
      localProjectId: 'project',
      sessionId: 'session',
      attachment: item.reference,
      data: item.data,
    },
  };
  await store.stage(scope, original, undefined, current);
  assert.equal((await store.read(scope, current)).operations[0]!.status, 'pending');
  await store.finish(scope, original, 'confirmed', current);
  const head = memory.values.get(workspaceLedgerKey(scope)) as { recent: unknown[] };
  assert.equal(head.recent.length, 0);
  assert.deepEqual((await store.operation(scope, 'large-upload', current))?.original, original);
});

test('pending references have no count-based eviction and malformed cross-scope records fail closed', async () => {
  const memory = new Memory(),
    store = new WorkspaceStore(memory);
  for (let index = 0; index < 515; index++)
    await store.stage(scope, operation('pending-' + index, 'session-' + index), undefined, current);
  const restored = await new WorkspaceStore(memory).read(scope, current);
  assert.equal(restored.operations.length, 515);
  assert(restored.operations.every((value) => value.status === 'pending'));
  const key = workspaceRecordKey(scope, 'operation', 'pending-0');
  const original = structuredClone(memory.values.get(key)) as { scope: WorkspaceScope };
  memory.values.set(key, {
    ...original,
    scope: { ...scope, target: { ...scope.target, owner: 'foreign' } },
  });
  await assert.rejects(store.read(scope, current, 'session-0'), /引用不完整/);
  await assert.rejects(store.operation(scope, 'pending-0', current), /引用不完整/);
});

test('semantic originals retain immutable attachment selection and atomically confirm without clearing newer drafts', async () => {
  const memory = new Memory(),
    store = new WorkspaceStore(memory);
  const sessionId = 'semantic-session';
  const item = await createAttachmentDraftItem(
    new File(['frozen bytes'], 'frozen.txt', { type: 'text/plain' }),
    'semantic-attachment',
  );
  await store.saveAttachments(scope, sessionId, 0, [item], current);
  const upload: SessionOriginalOperation = {
    kind: 'attachment',
    value: {
      contentVersion: 1,
      operationId: 'semantic-upload',
      workspaceId: scope.target.workspaceId,
      localProjectId: scope.target.localProjectId,
      sessionId,
      action: 'upload',
      attachment: item.reference,
      data: item.data,
    },
  };
  await store.stage(scope, upload, undefined, current);
  await store.finish(scope, upload, 'confirmed', current);
  const saved = (await store.read(scope, current, sessionId)).attachments![sessionId]!;
  const draft = await store.saveDraft(
    scope,
    sessionId,
    0,
    'Reviewed prompt',
    { modelId: 'model' },
    current,
  );
  const original: SessionOriginalOperation = {
    kind: 'send-turn',
    value: {
      intentVersion: 1,
      operationId: 'semantic-turn',
      workspaceId: scope.target.workspaceId,
      localProjectId: scope.target.localProjectId,
      userId: scope.target.userId,
      machineId: scope.target.machineId,
      sessionId,
      expectedTurnId: null,
      turnId: 'semantic-user-turn',
      agentId: 'agent',
      prompt: 'Reviewed prompt',
      selection: { modelId: 'model' },
      attachments: [item.reference],
    },
  };
  const frozenDraft = { sessionId, revision: draft.revision, attachmentRevision: saved.revision };
  await assert.rejects(
    store.stage(
      scope,
      { ...original, value: { ...original.value, attachments: [] } },
      frozenDraft,
      current,
    ),
    /附件草稿/,
  );
  await store.stage(scope, original, frozenDraft, current);
  const restarted = new WorkspaceStore(memory);
  assert.deepEqual(
    (await restarted.operation(scope, original.value.operationId, current))!.original,
    original,
  );
  await restarted.saveDraft(scope, sessionId, draft.revision, 'Newer unsent prompt', {}, current);
  memory.fail = true;
  await assert.rejects(
    restarted.finish(scope, original, 'confirmed', current),
    /transaction failure/,
  );
  memory.fail = false;
  assert.equal(
    (await restarted.operation(scope, original.value.operationId, current))!.status,
    'pending',
  );
  assert.equal(
    (await restarted.read(scope, current, sessionId)).attachments![sessionId]!.items.length,
    1,
  );
  await restarted.finish(scope, original, 'confirmed', current);
  assert.equal(
    (await restarted.operation(scope, original.value.operationId, current))!.status,
    'confirmed',
  );
  assert.equal(
    (await restarted.read(scope, current, sessionId)).attachments![sessionId]!.items.length,
    0,
  );
  assert.equal((await restarted.readDraft(scope, sessionId, current)).text, 'Newer unsent prompt');
  assert.deepEqual(
    (await restarted.operation(scope, original.value.operationId, current))!.original,
    original,
  );
});
