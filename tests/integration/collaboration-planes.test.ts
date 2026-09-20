import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CollaborationClient,
  collaborationSyncBatch,
  type CollaborationStorage,
} from '@moor/client/collaboration-client';
import { CollaborationStore } from '@moor/sync/store';
import { CollaborationCoordinator } from '@moor/host/sessions/collaboration-coordinator';
import { CollaborationReplica } from '@moor/session/collaboration-replica';
import { CollaborationExecutionPlane } from '@moor/host/sessions/collaboration';
import { RuntimeStore } from '@moor/host/persistence/store';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { mergeCollaborationOperations } from '@moor/session/collaboration-document';
import { actorSchema } from '@moor/protocol/attention';
import {
  collaborationOperationSchema,
  COLLABORATION_LIMITS,
  validateCollaborationSyncResponse,
  type CollaborationScope,
  type TaskExecutionTarget,
} from '@moor/protocol/collaboration-protocol';
import { syntheticCapabilities } from '../fixtures/agent-capabilities';

class MemoryStorage implements CollaborationStorage {
  values = new Map<string, unknown>();
  locks = new Map<string, Promise<unknown>>();
  failWrite = false;
  async read(key: string) {
    return structuredClone(this.values.get(key));
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    current();
    if (this.failWrite) throw Error('synthetic disk failure');
    assert.deepEqual(this.values.get(key) ?? null, expected);
    this.values.set(key, structuredClone(value));
  }
  async exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => {
        current();
        return task();
      });
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
}
const actor = (accountId: string) =>
  actorSchema.parse({ kind: 'relay', authorityId: 'authority', accountId });
const scope: CollaborationScope = {
  authorityId: 'authority',
  workspaceId: 'space',
  projectId: 'project',
  sessionId: 'session',
};
const target: TaskExecutionTarget = {
  executionDeviceId: 'device',
  workspaceId: 'runtime',
  userId: 'user',
  machineId: 'machine',
  localProjectId: 'local-project',
  sessionId: 'session',
  agentId: 'agent',
};
function fixture(t: TestContext, execution = target) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-collaboration-')));
  let now = 1000;
  const path = join(root, 'sync.sqlite'),
    store = new CollaborationStore(path, scope.authorityId, () => now);
  store.createWorkspace(actor('owner'), scope.workspaceId);
  store.setMember(actor('owner'), scope.workspaceId, actor('b'), 'operator');
  store.setMember(actor('owner'), scope.workspaceId, actor('c'), 'operator');
  store.registerSession(actor('owner'), scope, execution);
  const coordinator = new CollaborationCoordinator(store);
  store.subscribe(({ scope, authored }) => {
    if (authored) coordinator.reconcile(scope);
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const client = (account: string, storage = new MemoryStorage()) => {
    let holdReply: (() => Promise<void>) | undefined;
    let counter = 0,
      online = true,
      loseReply = false,
      calls = 0;
    const options = {
      scope,
      author: { actor: actor(account), clientId: account + '-client' },
      storage,
      transport: {
        sync: async (request: Parameters<CollaborationStore['sync']>[1]) => {
          calls++;
          if (!online) throw Error('offline');
          const result = store.sync(actor(account), request);
          await holdReply?.();
          if (loseReply) {
            loseReply = false;
            throw Error('lost reply');
          }
          return result;
        },
      },
      uuid: () => account + '-' + ++counter,
      now: () => now,
      current: () => {},
    };
    return {
      value: new CollaborationClient(options),
      storage,
      reopen: () => new CollaborationClient(options),
      holdReply: (hold?: () => Promise<void>) => {
        holdReply = hold;
      },
      online: (value: boolean) => {
        online = value;
      },
      loseReply: () => {
        loseReply = true;
      },
      calls: () => calls,
    };
  };
  return {
    store,
    queue: coordinator.queue,
    coordinator,
    client,
    root,
    path,
    clock: (value: number) => {
      now = value;
    },
  };
}

test('explicitly authorized local input survives restart and deduplicates lost acknowledgements', async (t) => {
  const f = fixture(t),
    b = f.client('b'),
    c = f.client('c');
  b.online(false);
  const input = { prompt: 'synthetic task', selection: {} };
  const submitting = b.value.control.sendTurn({ input, target, expiresAt: 9000 });
  input.prompt = 'later local edit';
  const intent = await submitting;
  assert.equal(b.calls(), 0);
  await assert.rejects(b.value.state.sync(), /offline/);
  const reopened = b.reopen();
  await reopened.state.recover();
  assert.equal(reopened.state.snapshot().pending.length, 1);
  b.online(true);
  b.loseReply();
  await assert.rejects(reopened.state.sync(), /lost reply/);
  assert.equal(reopened.state.snapshot().pending.length, 1);
  await reopened.state.sync();
  await c.value.state.sync();
  assert.equal(c.value.state.snapshot().operations.length, 1);
  assert.equal(c.value.state.snapshot().tasks.length, 1);
  const claim = f.queue.claim(scope, target, 'claim')!;
  assert.equal(claim.intent.operationId, intent.operationId);
  assert.equal(claim.intent.input.prompt, 'synthetic task');
  assert.equal(f.queue.claim(scope, target, 'duplicate'), undefined);
  const operations = c.value.state.snapshot().operations;
  assert.deepEqual(
    mergeCollaborationOperations(scope, operations, [...operations].reverse()),
    operations,
  );
});

test(
  'a late first-sync snapshot cannot roll back another page newer Loro state',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      b = f.client('b'),
      second = b.reopen();
    let entered!: () => void,
      release!: () => void,
      firstReply = true;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await b.value.control.sendTurn({
      target,
      expiresAt: 9000,
      input: { prompt: 'initial', selection: {} },
    });
    b.holdReply(async () => {
      if (firstReply) {
        firstReply = false;
        entered();
        await gate;
      }
    });
    const firstSync = b.value.state.sync();
    await waiting;
    const later = await second.control.sendTurn({
      target,
      expiresAt: 9000,
      input: { prompt: 'newer page', selection: {} },
    });
    await second.state.sync();
    const version = second.state.snapshot().cursor;
    release();
    await firstSync;
    assert.equal(b.value.state.snapshot().cursor, version);
    assert.ok(
      b.value.state.snapshot().operations.some((op) => op.operationId === later.operationId),
    );
    assert.equal(b.value.state.snapshot().pending.length, 0);
  },
);

test('persistence failure never publishes an executable intent; empty sync creates no queue item', async (t) => {
  const f = fixture(t),
    b = f.client('b');
  const draft = { input: { prompt: 'draft only', selection: {} } };
  await b.value.state.sync();
  assert.equal(f.queue.claim(scope, target, 'none'), undefined);
  b.storage.failWrite = true;
  await assert.rejects(
    b.value.control.sendTurn({ input: draft.input, target, expiresAt: 9000 }),
    /disk/,
  );
  assert.equal(b.value.state.snapshot().pending.length, 0);
  assert.equal(f.queue.claim(scope, target, 'still-none'), undefined);
});

test('membership, actor spoofing, expired grants, foreign targets and queue withdrawal are enforced at acceptance and dispatch', async (t) => {
  const f = fixture(t),
    b = f.client('b');
  const draft = { input: { prompt: 'task', selection: {} } };
  const task = await b.value.control.sendTurn({
    input: draft.input,
    target,
    expiresAt: 9000,
  });
  assert.throws(
    () => f.store.sync(actor('c'), { version: 3, scope, after: 0, operations: [task] }),
    /代替/,
  );
  assert.throws(
    () =>
      f.store.sync(actor('b'), {
        version: 3,
        scope,
        after: 0,
        operations: [{ ...task, target: { ...target, machineId: 'foreign' } }],
      }),
    /绑定/,
  );
  assert.equal(f.store.projection(scope).operations.length, 0);
  await b.value.state.sync();
  f.store.setMember(actor('owner'), scope.workspaceId, actor('b'), 'editor');
  assert.equal(f.queue.claim(scope, target, 'revoked'), undefined);
  await b.value.state.sync();
  assert.equal(b.value.state.snapshot().tasks[0].phase, 'blocked');
  f.store.setMember(actor('owner'), scope.workspaceId, actor('b'), 'operator');
  const second = await b.value.control.sendTurn({
    input: draft.input,
    target,
    expiresAt: 9000,
  });
  await b.value.state.sync();
  await b.value.control.withdrawTask(second.operationId);
  await b.value.state.sync();
  assert.equal(f.queue.claim(scope, target, 'withdrawn'), undefined);
  await b.value.control.sendTurn({ input: draft.input, target, expiresAt: 9000 });
  await b.value.state.sync();
  f.clock(10000);
  assert.equal(f.queue.claim(scope, target, 'expired'), undefined);
  f.store.setMember(actor('owner'), scope.workspaceId, actor('b'), null);
  await assert.rejects(b.value.state.sync(), /权限/);
});

test('malformed sync responses cannot acknowledge another operation or cross account authority', () => {
  assert.throws(() => collaborationOperationSchema.parse({ kind: 'draft' }));
  assert.throws(
    () =>
      validateCollaborationSyncResponse(
        {
          version: 3,
          scope,
          cursor: 0,
          hasMore: false,
          storedOperationIds: ['foreign'],
          document: { schemaVersion: 2, update: '', version: '' },
        },
        { version: 3, scope, after: 0, operations: [] },
      ),
    /原范围/,
  );
});

test('offline sync batches fit the wire byte limit even when prompts expand under JSON escaping', () => {
  const operations = Array.from({ length: 30 }, (_, index) =>
    collaborationOperationSchema.parse({
      version: 1,
      kind: 'submit',
      target,
      authorization: { kind: 'execute', ordering: 'after-previous', expiresAt: 9000 },
      scope,
      operationId: 'escaped-' + index,
      author: { actor: actor('b'), clientId: 'browser' },
      createdAt: 1000,
      input: { prompt: '\u0000'.repeat(100000), selection: {} },
    }),
  );
  const first = collaborationSyncBatch(scope, 0, operations);
  assert.ok(first.operations.length > 0 && first.operations.length < operations.length);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(first)).byteLength <= COLLABORATION_LIMITS.requestBytes,
  );
  const second = collaborationSyncBatch(scope, 0, operations.slice(first.operations.length));
  assert.deepEqual([...first.operations, ...second.operations], operations);
});

test('sync drains multiple bounded pages and survives local checkpoint persistence failure without dropping authoring records', async (t) => {
  const f = fixture(t),
    b = f.client('b'),
    c = f.client('c');
  for (let index = 0; index < 125; index++)
    await b.value.control.sendTurn({
      target,
      expiresAt: 9000,
      input: { prompt: 'synthetic-' + index, selection: {} },
    });
  b.storage.failWrite = true;
  await assert.rejects(b.value.state.sync(), /disk/);
  b.storage.failWrite = false;
  const restored = b.reopen();
  await restored.state.recover();
  assert.equal(restored.state.snapshot().pending.length, 125);
  await restored.state.sync();
  await c.value.state.sync();
  assert.equal(restored.state.snapshot().pending.length, 0);
  assert.equal(c.value.state.snapshot().operations.length, 125);
  assert.equal(c.value.state.snapshot().tasks.length, 125);
});

test('queued authorized work is drained through actual Host acceptance once and in order, while uncertain work is never replayed', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-collaboration-host-'))),
    project = join(root, 'project');
  mkdirSync(project);
  const runtime = new RuntimeStore(join(root, 'runtime.sqlite')),
    localProjectId = runtime.registerProject(project);
  runtime.registerAgent('synthetic', {
    id: 'agent',
    name: 'Synthetic',
    machineId: runtime.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/not-executed', args: [] },
  });
  const prompts: string[] = [];
  const host = new HostWorkspace(
    runtime,
    {
      open: async () => ({
        id: 'synthetic-native',
        capabilities: syntheticCapabilities,
        prompt: async (input) => {
          prompts.push(typeof input === 'string' ? input : JSON.stringify(input));
        },
        close: () => {},
        cancel: async () => {},
      }),
    },
    () => {},
    () => {},
  );
  t.after(() => {
    host.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const execution = {
    ...target,
    workspaceId: runtime.workspace.id,
    machineId: runtime.workspace.machineId,
    userId: runtime.workspace.userId,
    localProjectId,
  };
  await host.controlManager.control({
    controlVersion: 1,
    action: 'create',
    operationId: 'create',
    agentId: 'agent',
    workspaceId: execution.workspaceId,
    userId: execution.userId,
    machineId: execution.machineId,
    localProjectId,
    sessionId: execution.sessionId,
  });
  const f = fixture(t, execution),
    b = f.client('b');
  for (const prompt of ['first task', 'second task']) {
    const draft = { input: { prompt, selection: {} } };
    await b.value.control.sendTurn({
      input: draft.input,
      target: execution,
      expiresAt: 9000,
    });
  }
  await b.value.state.sync();
  assert.equal(prompts.length, 0);
  let counter = 0;
  const worker = new CollaborationExecutionPlane({
    host,
    queue: f.queue,
    scope,
    target: execution,
    current: () => {},
    uuid: () => 'claim-' + ++counter,
    now: () => 1000,
  });
  await worker.recover();
  await worker.wake();
  await worker.wake();
  await b.value.state.sync();
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /first task/);
  assert.match(prompts[1], /second task/);
  assert.deepEqual(
    b.value.state.snapshot().tasks.map((task) => task.phase),
    ['completed', 'completed'],
  );
  const last = { input: { prompt: 'uncertain task', selection: {} } };
  await b.value.control.sendTurn({
    input: last.input,
    target: execution,
    expiresAt: 9000,
  });
  await b.value.state.sync();
  assert.ok(f.queue.claim(scope, execution, 'crashed-claim'));
  const reopened = new CollaborationStore(f.path, scope.authorityId, () => 1000);
  try {
    const restoredQueue = new CollaborationCoordinator(reopened).queue;
    restoredQueue.interruptExecution(scope, execution);
    assert.equal(restoredQueue.claim(scope, execution, 'do-not-replay'), undefined);
  } finally {
    reopened.close();
  }
  await worker.wake();
  assert.equal(prompts.length, 2);
});
