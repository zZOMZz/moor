import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationStore } from '@moor/sync/store';
import { CollaborationCoordinator } from '@moor/host/sessions/collaboration-coordinator';
import { CollaborationExecutionPlane } from '@moor/host/sessions/collaboration';
import { LoroDoc, encode } from '@moor/session/model';
import { CollaborationReplica } from '@moor/session/collaboration-replica';
import { CollaborationClient, type CollaborationStorage } from '@moor/client/collaboration-client';
import {
  collaborationKey,
  type CollaborationScope,
  type TaskExecutionTarget,
  type TaskIntent,
  type CollaborationOffer,
} from '@moor/protocol/collaboration-protocol';
import { syntheticCollaboration } from '../fixtures/collaboration-host';
import { buildSessionTurn } from '@moor/session/session-operations';

const actor = { kind: 'relay' as const, authorityId: 'authority', accountId: 'owner' };
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
  localProjectId: 'local',
  sessionId: 'session',
  agentId: 'agent',
};
function inputs(s = scope, t = target, account = actor, suffix = '') {
  const intent: TaskIntent = {
    version: 1,
    operationId: 'intent-op' + suffix,
    kind: 'submit',
    scope: s,
    author: { actor: account, clientId: 'client' },
    createdAt: 1000,
    input: { prompt: 'synthetic intent' + suffix, selection: {} },
    target: t,
    authorization: {
      kind: 'execute',
      ordering: 'after-previous',
      expiresAt: Number.MAX_SAFE_INTEGER - 1,
    },
  };
  return {
    intent,
    offer: {
      version: 3 as const,
      scope: s,
      operationId: intent.operationId,
      operations: [intent],
    },
  };
}
function stateFixture(t: TestContext) {
  const state = new CollaborationStore(':memory:', actor.authorityId, () => 1000);
  state.createWorkspace(actor, scope.workspaceId);
  state.registerSession(actor, scope, target);
  t.after(() => state.close());
  return state;
}
function view(s: CollaborationScope, update: string) {
  const replica = new CollaborationReplica(s, update);
  try {
    return replica.view();
  } finally {
    replica.close();
  }
}
class Memory implements CollaborationStorage {
  data = new Map<string, unknown>();
  async read(key: string) {
    return structuredClone(this.data.get(key));
  }
  async compareAndSet(key: string, before: unknown, value: unknown, current: () => void) {
    current();
    assert.deepEqual(this.data.get(key) ?? null, before);
    this.data.set(key, structuredClone(value));
  }
  async exclusive<T>(_key: string, current: () => void, work: () => Promise<T>) {
    current();
    return work();
  }
}

test('State sync persists a Loro document but cannot accept, withdraw or recover execution by itself', (t) => {
  const state = stateFixture(t),
    { intent } = inputs();
  const response = state.sync(actor, { version: 3, scope, after: 0, operations: [intent] });
  const document = view(scope, response.document.update);
  assert.equal(document.operations.length, 1);
  assert.deepEqual(document.tasks, []);
  assert.equal(
    state.db.prepare("SELECT 1 FROM sqlite_master WHERE name='collaboration_execution'").get(),
    undefined,
  );
  assert.equal(
    state.db.prepare("SELECT 1 FROM sqlite_master WHERE name='collaboration_operation'").get(),
    undefined,
  );
  const coordinator = new CollaborationCoordinator(state);
  coordinator.reconcile(scope);
  assert.equal(state.projection(scope).tasks[0].phase, 'queued');
  state.sync(actor, {
    version: 3,
    scope,
    after: 0,
    operations: [
      {
        version: 1,
        kind: 'withdraw',
        operationId: 'withdraw',
        scope,
        author: intent.author,
        createdAt: 1001,
        taskId: intent.operationId,
      },
    ],
  });
  assert.equal(state.projection(scope).tasks[0].phase, 'queued');
  coordinator.reconcile(scope);
  assert.equal(state.projection(scope).tasks[0].phase, 'cancelled');
});

test('execution ledger and Loro status projection roll back together, while the already-stored intent survives', (t) => {
  const state = stateFixture(t),
    coordinator = new CollaborationCoordinator(state),
    { intent } = inputs();
  state.sync(actor, { version: 3, scope, after: 0, operations: [intent] });
  state.db.exec(
    "CREATE TRIGGER fail_projection BEFORE UPDATE ON collaboration_document BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END",
  );
  assert.throws(() => coordinator.reconcile(scope), /projection failure/);
  assert.equal(state.db.prepare('SELECT count(*) AS n FROM collaboration_execution').get()!.n, 0);
  assert.equal(coordinator.queue.through(scope), 0);
  assert.equal(state.projection(scope).operations.length, 1);
  assert.deepEqual(state.projection(scope).tasks, []);
  state.db.exec('DROP TRIGGER fail_projection');
  coordinator.reconcile(scope);
  const first = state.read(actor, scope);
  coordinator.reconcile(scope);
  assert.equal(state.read(actor, scope).revision, first.revision);
  assert.equal(state.projection(scope).tasks.length, 1);
});

test('Loro incremental reads converge and contain execution projections without a second queue response', (t) => {
  const state = stateFixture(t),
    coordinator = new CollaborationCoordinator(state),
    { intent } = inputs();
  const initial = state.read(actor, scope),
    replica = new CollaborationReplica(scope, initial.document.update);
  t.after(() => replica.close());
  state.sync(actor, { version: 3, scope, after: 0, operations: [intent] });
  coordinator.reconcile(scope);
  const delta = state.read(actor, scope, initial.document.version);
  replica.import(delta.document.update);
  replica.import(delta.document.update);
  assert.deepEqual(replica.view(), state.projection(scope));
  assert.equal(replica.view().tasks[0].phase, 'queued');
  const before = Number(state.db.prepare('SELECT total_changes() AS n').get()!.n);
  state.read(actor, scope, delta.document.version);
  assert.equal(Number(state.db.prepare('SELECT total_changes() AS n').get()!.n), before);
});

test('reading an unopened collaboration session never enables sharing or starts a coordinator', async (t) => {
  const f = await syntheticCollaboration();
  t.after(f.close);
  const before = Number(f.runtime.journal.db.prepare('SELECT total_changes() AS n').get()!.n);
  for (let index = 0; index < 3; index++) {
    const response = await f.ownerApi(f.route + '/read');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).enabled, false);
  }
  assert.equal(
    Number(f.runtime.journal.db.prepare('SELECT total_changes() AS n').get()!.n),
    before,
  );
  assert.equal(
    f.runtime.journal.db.prepare('SELECT count(*) AS n FROM collaboration_session').get()!.n,
    0,
  );
  assert.equal(f.prompts.length, 0);
  const enabled = await f.ownerApi(f.route + '/enable', {});
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).enabled, true);
});

test('a read cannot recover an existing claimed task or promote pending intent into execution', async (t) => {
  const f = await syntheticCollaboration();
  t.after(f.close);
  const read = await (await f.ownerApi(f.route + '/read')).json();
  const author = {
    kind: 'relay' as const,
    authorityId: f.accounts.authorityId,
    accountId: f.ownerId,
  };
  const state = new CollaborationStore(f.runtime.journal.db, author.authorityId, () => 1000);
  state.createWorkspace(author, read.scope.workspaceId);
  state.registerSession(author, read.scope, read.target);
  const { intent } = inputs(read.scope, read.target, author),
    coordinator = new CollaborationCoordinator(state);
  state.append(author, read.scope, [intent]);
  coordinator.reconcile(read.scope);
  assert.ok(coordinator.queue.claim(read.scope, read.target, 'claimed-before-read'));
  const before = Number(f.runtime.journal.db.prepare('SELECT total_changes() AS n').get()!.n);
  assert.equal((await f.ownerApi(f.route + '/read')).status, 200);
  assert.equal(
    Number(f.runtime.journal.db.prepare('SELECT total_changes() AS n').get()!.n),
    before,
  );
  assert.equal(state.projection(read.scope).tasks[0].phase, 'claimed');
  assert.equal(f.prompts.length, 0);
});

test(
  'explicitly enabling sharing during an ordinary turn does not recover or interrupt that turn',
  { timeout: 10000 },
  async (t) => {
    const f = await syntheticCollaboration();
    t.after(f.close);
    const read = await (await f.ownerApi(f.route + '/read')).json(),
      hold = f.pauseNextPrompt();
    const command = buildSessionTurn({
      scope: read.target,
      read: read.session,
      agent: read.session.agent,
      prompt: 'ordinary active work',
      operationId: 'ordinary-active',
      turnId: 'ordinary-user',
      peerId: 'ordinary-peer',
      now: new Date(1000).toISOString(),
    });
    try {
      await f.host.mutate(command, read.target.localProjectId);
      await hold.started;
      const active = f.host.active.get(read.target.sessionId)!;
      const response = await f.ownerApi(f.route + '/enable', {});
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      assert.equal(f.host.active.get(read.target.sessionId), active);
      assert.equal(active.stopped, false);
      assert.equal(f.prompts.length, 1);
      hold.release();
      await active.done;
    } finally {
      hold.release();
    }
  },
);

for (const order of ['rpc-first', 'doc-first'] as const) {
  test(
    `${order}: Doc and RPC converge to one durable intent and one actual Host prompt`,
    { timeout: 10000 },
    async (t) => {
      const f = await syntheticCollaboration();
      t.after(f.close);
      const read = await (await f.ownerApi(f.route + '/enable', {})).json();
      const author = {
        kind: 'relay' as const,
        authorityId: f.accounts.authorityId,
        accountId: f.ownerId,
      };
      const { intent, offer } = inputs(read.scope, read.target, author);
      const sync = { version: 3, scope: read.scope, after: 0, operations: [intent] };
      const prompt = f.waitForPrompts(1);
      const first = await f.ownerApi(
        f.route + (order === 'rpc-first' ? '/offer' : '/sync'),
        order === 'rpc-first' ? offer : sync,
      );
      assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
      await prompt;
      await f.host.active.get(read.target.sessionId)?.done;
      for (const [method, body] of [
        ['/offer', offer],
        ['/sync', sync],
        ['/offer', offer],
      ] as const)
        assert.equal((await f.ownerApi(f.route + method, body)).status, 200);
      assert.equal(f.prompts.length, 1);
      const projected = await (
        await f.ownerApi(f.route + '/sync', { ...sync, operations: [] })
      ).json();
      const document = view(read.scope, projected.document.update);
      assert.equal(document.operations.filter((op) => op.kind === 'submit').length, 1);
      assert.equal(document.tasks[0].phase, 'completed');
      const mismatched = structuredClone(offer);
      mismatched.operations[0].input.prompt = 'changed';
      assert.equal((await f.ownerApi(f.route + '/offer', mismatched)).status, 409);
      assert.equal(f.prompts.length, 1);
    },
  );
}

test('RPC acknowledgement loss leaves the durable outbox intact and sync recovers the same intent', async (t) => {
  const state = stateFixture(t),
    coordinator = new CollaborationCoordinator(state),
    storage = new Memory();
  let next = 0,
    received!: () => void;
  const offered = new Promise<void>((resolve) => {
    received = resolve;
  });
  const client = new CollaborationClient({
    scope,
    author: { actor, clientId: 'client' },
    storage,
    transport: {
      sync: async (request) => state.sync(actor, request),
      offer: async (request) => {
        coordinator.offer(actor, scope, request);
        received();
        throw Error('synthetic lost RPC acknowledgement');
      },
    },
    current: () => {},
    now: () => 1000,
    uuid: () => 'local-' + ++next,
  });
  const draft = { input: { prompt: 'durable', selection: {} } };
  const intent = await client.control.sendTurn({
    input: draft.input,
    target,
    expiresAt: 9000,
  });
  await offered;
  assert.ok(client.state.snapshot().pending.includes(intent.operationId));
  await client.state.sync();
  assert.equal(client.state.snapshot().pending.length, 0);
  assert.equal(client.state.snapshot().tasks.length, 1);
  const persisted = [...storage.data.values()][0] as Record<string, unknown>;
  assert.equal(persisted.storageVersion, 3);
  assert.equal(typeof persisted.snapshot, 'string');
  assert.equal('operations' in persisted || 'tasks' in persisted, false);
});

test('a later RPC preserves its writer preceding intents when messages arrive in reverse order', async (t) => {
  const state = stateFixture(t),
    coordinator = new CollaborationCoordinator(state),
    offers: CollaborationOffer[] = [],
    storage = new Memory();
  let next = 0,
    both!: () => void;
  const received = new Promise<void>((resolve) => {
    both = resolve;
  });
  const client = new CollaborationClient({
    scope,
    author: { actor, clientId: 'client' },
    storage,
    transport: {
      sync: async (request) => state.sync(actor, request),
      offer: async (request) => {
        offers.push(request);
        if (offers.length === 2) both();
        throw Error('synthetic deferred transport');
      },
    },
    current: () => {},
    now: () => 1000,
    uuid: () => 'local-' + ++next,
  });
  const draft = { input: { prompt: 'same input', selection: {} } };
  const first = await client.control.sendTurn({
    input: draft.input,
    target,
    expiresAt: 9000,
  });
  const second = await client.control.sendTurn({
    input: draft.input,
    target,
    expiresAt: 9000,
  });
  await received;
  coordinator.offer(
    actor,
    scope,
    offers.find((offer) => offer.operationId === second.operationId)!,
  );
  coordinator.offer(actor, scope, offers.find((offer) => offer.operationId === first.operationId)!);
  assert.deepEqual(
    state.projection(scope).tasks.map((task) => task.taskId),
    [first.operationId, second.operationId],
  );
});

test('legacy local records migrate to Loro without changing frozen intent or sending an RPC', async (t) => {
  const state = stateFixture(t),
    storage = new Memory();
  let next = 0,
    rpc = 0;
  const options = {
    scope,
    author: { actor, clientId: 'client' },
    storage,
    transport: {
      sync: async (request: Parameters<CollaborationStore['sync']>[1]) =>
        state.sync(actor, request),
    },
    current: () => {},
    now: () => 1000,
    uuid: () => 'local-' + ++next,
  };
  const original = new CollaborationClient(options);
  const draft = { input: { prompt: 'legacy frozen input', selection: {} } };
  await original.control.sendTurn({ input: draft.input, target, expiresAt: 9000 });
  const { admissions: _admissions, ...legacy } = original.state.snapshot();
  const old = legacySnapshot();
  storage.data.set([...storage.data.keys()][0], {
    ...legacy,
    operations: [
      old.draft,
      ...legacy.operations.map((op) => ({
        ...op,
        draftId: 'draft',
        draftRevisionId: old.draft.operationId,
      })),
    ],
    pending: [old.draft.operationId, ...legacy.pending],
  });
  const reopened = new CollaborationClient({
    ...options,
    transport: {
      ...options.transport,
      offer: async () => {
        rpc++;
        throw Error();
      },
    },
  });
  await reopened.state.recover();
  assert.equal(rpc, 0);
  assert.deepEqual(reopened.state.snapshot().operations, legacy.operations);
  assert.deepEqual(reopened.state.snapshot().pending, legacy.pending);
  assert.equal(
    ((await storage.read([...storage.data.keys()][0])) as { storageVersion: number })
      .storageVersion,
    3,
  );
});

test(
  'an accepted turn publishes its result after disconnect while later queued work waits for a current connection',
  { timeout: 10000 },
  async (t) => {
    const f = await syntheticCollaboration();
    t.after(f.close);
    const read = await (await f.ownerApi(f.route + '/read')).json();
    const author = {
      kind: 'relay' as const,
      authorityId: f.accounts.authorityId,
      accountId: f.ownerId,
    };
    const state = new CollaborationStore(f.runtime.journal.db, author.authorityId, () => 1000);
    state.createWorkspace(author, read.scope.workspaceId);
    state.registerSession(author, read.scope, read.target);
    const first = inputs(read.scope, read.target, author, '-1'),
      second = inputs(read.scope, read.target, author, '-2');
    state.append(author, read.scope, [...first.offer.operations, ...second.offer.operations]);
    const coordinator = new CollaborationCoordinator(state),
      hold = f.pauseNextPrompt();
    let connected = true,
      counter = 0;
    const worker = new CollaborationExecutionPlane({
      host: f.host,
      queue: coordinator.queue,
      scope: read.scope,
      target: read.target,
      reconcile: () => coordinator.reconcile(read.scope),
      current: () => {
        if (!connected) throw Error('synthetic disconnected');
      },
      uuid: () => 'claim-' + ++counter,
      now: () => 1000,
    });
    try {
      const running = worker.wake();
      await hold.started;
      connected = false;
      hold.release();
      await assert.rejects(running, /disconnected/);
      assert.deepEqual(
        state.projection(read.scope).tasks.map((task) => task.phase),
        ['completed', 'queued'],
      );
      assert.equal(f.prompts.length, 1);
      connected = true;
      await worker.wake();
      assert.deepEqual(
        state.projection(read.scope).tasks.map((task) => task.phase),
        ['completed', 'completed'],
      );
      assert.equal(f.prompts.length, 2);
    } finally {
      hold.release();
      worker.close();
    }
  },
);

test('legacy Host state migrates once and interrupted execution is not re-enqueued', (t) => {
  const state = new CollaborationStore(':memory:', actor.authorityId, () => 1000);
  t.after(() => state.close());
  state.createWorkspace(actor, scope.workspaceId);
  state.db
    .prepare('INSERT INTO collaboration_session VALUES(?,?)')
    .run(collaborationKey(scope), JSON.stringify(target));
  state.db.exec(`CREATE TABLE collaboration_operation(id TEXT PRIMARY KEY,scope TEXT,body TEXT);
    CREATE TABLE collaboration_task(id TEXT PRIMARY KEY,scope TEXT,sequence INTEGER,intent TEXT,state TEXT,claim TEXT,command TEXT);`);
  const { intent, oldIntent, draft } = legacySnapshot(),
    task = {
      taskId: intent.operationId,
      scope,
      phase: 'dispatching',
      sequence: 2,
      revision: 3,
      updatedAt: 1000,
      executionOperationId: 'original-command',
    };
  for (const operation of [draft, oldIntent])
    state.db
      .prepare('INSERT INTO collaboration_operation VALUES(?,?,?)')
      .run(operation.operationId, collaborationKey(scope), JSON.stringify(operation));
  state.db
    .prepare('INSERT INTO collaboration_task VALUES(?,?,?,?,?,?,?)')
    .run(
      intent.operationId,
      collaborationKey(scope),
      2,
      JSON.stringify(oldIntent),
      JSON.stringify(task),
      'old-claim',
      '{"operationId":"original-command"}',
    );
  state.migrate(scope);
  const coordinator = new CollaborationCoordinator(state);
  coordinator.queue.interruptExecution(scope, target);
  coordinator.reconcile(scope);
  assert.equal(coordinator.queue.claim(scope, target, 'never-replay'), undefined);
  assert.equal(state.projection(scope).tasks[0].phase, 'interrupted');
  assert.deepEqual(
    state.projection(scope).operations.find((op) => op.kind === 'submit'),
    intent,
  );
  const before = state.read(actor, scope).document;
  state.migrate(scope);
  coordinator.reconcile(scope);
  assert.deepEqual(state.read(actor, scope).document, before);
  assert.equal(
    state.db.prepare('SELECT command FROM collaboration_execution').get()!.command,
    '{"operationId":"original-command"}',
  );
});

function legacySnapshot() {
  const doc = new LoroDoc();
  const { intent } = inputs();
  const draft = {
    version: 1,
    operationId: 'retired-draft',
    kind: 'draft',
    scope,
    author: intent.author,
    createdAt: 1000,
    draftId: 'draft',
    parents: [],
    input: { prompt: 'SYNTHETIC_UNSUBMITTED_PRIVATE_DRAFT', selection: {} },
  };
  const oldIntent = { ...intent, draftId: 'draft', draftRevisionId: draft.operationId };
  try {
    doc.getMap('identity').set('scope', collaborationKey(scope));
    doc.getMap('identity').set('schemaVersion', 1);
    for (const [index, operation] of [draft, oldIntent].entries()) {
      doc.getMap('operations').set(operation.operationId, JSON.stringify(operation));
      doc.getMap('admissions').set(operation.operationId, index + 1);
    }
    doc.commit();
    return {
      snapshot: encode(doc.export({ mode: 'snapshot' })),
      peer: doc.peerIdStr,
      draft,
      intent,
      oldIntent,
    };
  } finally {
    doc.free();
  }
}

test('Host rebuilds TaskDoc v1 without drafts or their CRDT history and preserves admitted task identity', (t) => {
  const state = stateFixture(t),
    old = legacySnapshot();
  state.db
    .prepare(
      'UPDATE collaboration_document SET snapshot=?,peer=?,revision=12,sequence=2 WHERE scope=?',
    )
    .run(old.snapshot, old.peer, collaborationKey(scope));
  state.migrate(scope);
  const read = state.read(actor, scope);
  assert.equal(read.document.schemaVersion, 2);
  assert.equal(read.revision, 13);
  assert.deepEqual(state.projection(scope).operations, [old.intent]);
  assert.deepEqual(state.projection(scope).admissions, { [old.intent.operationId]: 2 });
  // Inspect the entire exported CRDT history, including deleted or overwritten values.
  const replica = new CollaborationReplica(scope, read.document.update);
  try {
    assert.equal(JSON.stringify(replica.doc.toJSON()).includes(old.draft.input.prompt), false);
    assert.equal(
      JSON.stringify(replica.doc.exportJsonUpdates()).includes(old.draft.input.prompt),
      false,
    );
  } finally {
    replica.close();
  }
  state.migrate(scope);
  assert.deepEqual(state.read(actor, scope), read);
  const coordinator = new CollaborationCoordinator(state);
  coordinator.reconcile(scope);
  assert.equal(
    coordinator.queue.claim(scope, target, 'migrated')?.intent.operationId,
    old.intent.operationId,
  );
});

test('old client snapshot drops pending drafts before sync and retains the original submitted intent', async (t) => {
  const state = stateFixture(t),
    storage = new Memory(),
    old = legacySnapshot();
  const author = old.intent.author;
  const key = JSON.stringify(['moor-collaboration-v1', collaborationKey(scope), author]);
  storage.data.set(key, {
    storageVersion: 2,
    scope,
    author,
    cursor: 42,
    pending: [old.draft.operationId, old.intent.operationId],
    snapshot: old.snapshot,
    peer: old.peer,
    documentVersion: 'retired-version',
  });
  const requests: unknown[] = [];
  let offers = 0;
  const client = new CollaborationClient({
    scope,
    author,
    storage,
    current: () => {},
    now: () => 1000,
    uuid: () => 'unused',
    transport: {
      sync: async (request) => {
        requests.push(request);
        return state.sync(actor, request);
      },
      offer: async () => {
        offers++;
        throw Error('unexpected offer');
      },
    },
  });
  await client.state.recover();
  assert.equal(offers, 0);
  assert.deepEqual(client.state.snapshot().pending, [old.intent.operationId]);
  assert.deepEqual(client.state.snapshot().operations, [old.intent]);
  assert.equal(client.state.snapshot().cursor, 0);
  const stored = storage.data.get(key) as { storageVersion: number; documentVersion?: string };
  assert.equal(stored.storageVersion, 3);
  assert.equal(stored.documentVersion, undefined);
  await client.state.sync();
  assert.equal(JSON.stringify(requests).includes(old.draft.input.prompt), false);
  assert.deepEqual(state.projection(scope).operations, [old.intent]);
  assert.equal(offers, 0);
});
