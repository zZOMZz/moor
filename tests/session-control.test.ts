import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/runtime/store';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { AppError, mutationSchema, type Mutation } from '../src/protocol';
import { Flock, LoroDoc, delta, mirror, metas, putMeta, vv } from '../src/model';
import { syntheticCapabilities } from './support/agent-capabilities';
import {
  sessionControlActionSchema,
  sessionOperationSchema,
  validateSessionControlReceipt,
  validateSessionOperationResult,
  type SessionControlAction,
  type SessionOperation,
} from '../src/session-control-protocol';
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-control-'))),
    project = join(root, 'project');
  mkdirSync(project);
  const file = join(root, 'runtime.sqlite'),
    store = new RuntimeStore(file),
    projectId = store.registerProject(project);
  store.registerAgent('synthetic-preset', {
    id: 'synthetic-agent',
    name: 'Synthetic',
    machineId: store.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/not-executed', args: ['--private-synthetic'] },
  });
  let opens = 0,
    prompts = 0,
    cancels = 0;
  const started = signal(),
    finished = signal();
  const host = new HostWorkspace(
    store,
    {
      open: async () => {
        opens++;
        return {
          id: 'synthetic-native',
          capabilities: syntheticCapabilities,
          prompt: async () => {
            prompts++;
            started.resolve();
            await finished.promise;
          },
          cancel: async () => {
            cancels++;
            finished.resolve();
          },
          close: () => {
            finished.resolve();
          },
        };
      },
    },
    () => {},
    () => {},
  );
  const scope = {
    controlVersion: 1 as const,
    workspaceId: store.workspace.id,
    machineId: store.workspace.machineId,
    userId: store.workspace.userId,
    localProjectId: projectId,
    sessionId: 'synthetic-session',
  };
  const create = (extra = {}): SessionControlAction => ({
    ...scope,
    operationId: 'create-operation',
    action: 'create',
    agentId: 'synthetic-agent',
    title: '合成空会话',
    ...extra,
  });
  const recover = (
    request: SessionOperation['request'],
    action: 'inspect' | 'abandon' = 'inspect',
    extra = {},
  ): SessionOperation => ({ ...scope, action, request, ...extra });
  t.after(async () => {
    finished.resolve();
    await Promise.all([...host.active.values()].map((run) => run.done));
    host.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    file,
    store,
    host,
    scope,
    create,
    recover,
    started,
    finished,
    counts: () => ({ opens, prompts, cancels }),
  };
}
function mutation(f: ReturnType<typeof fixture>, operationId = 'send-operation'): Mutation {
  const doc = f.store.doc(f.scope.sessionId),
    before = vv(doc),
    view = mirror(doc, f.scope.sessionId),
    flock = Flock.fromFile(f.store.meta.exportFile()),
    version = flock.version(),
    userId = operationId + '-user';
  view.setState((state) => {
    state.history.push({
      id: userId,
      role: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      userId: f.scope.userId,
      userTurnId: undefined,
      read: undefined,
      finished: true,
      status: 'pending',
      fileDiff: null,
      items: [{ type: 'text', text: 'synthetic input' }],
      inputConfig: {
        prompt: 'synthetic input',
        cliType: 'custom',
        agentType: 'synthetic',
        mcpServerIds: [],
        taskToolsEnabled: false,
      },
    });
  });
  view.dispose();
  doc.commit();
  const previous = metas(f.store.meta)['session-' + f.scope.sessionId];
  putMeta(flock, 'session-' + f.scope.sessionId, { latestUserMsgId: userId, lastMessageAt: 1 });
  return mutationSchema.parse({
    workspaceId: f.scope.workspaceId,
    sessionId: f.scope.sessionId,
    operationId,
    kind: 'turn',
    expectedTurnId: (previous.latestUserMsgId as string | undefined) ?? null,
    update: delta(doc, before),
    metaBundle: flock.exportJson(version),
  });
}
test('empty creation binds Agent and scope atomically, survives restart and never starts an Agent', async (t) => {
  const f = fixture(t),
    action = f.create(),
    original = { kind: 'control' as const, value: action };
  const accepted = await f.host.controlManager.control(action, f.scope.localProjectId);
  assert.equal(validateSessionControlReceipt(accepted, f.scope, original).status, 'accepted');
  assert.deepEqual(await f.host.controlManager.control(action), accepted);
  const read = await f.host.read(f.scope.sessionId, undefined, f.scope.localProjectId);
  const doc = new LoroDoc();
  doc.import(Buffer.from(read.update, 'base64'));
  const view = mirror(doc, f.scope.sessionId);
  assert.equal(view.getState().session.id, f.scope.sessionId);
  assert.deepEqual(view.getState().history, []);
  view.dispose();
  assert.equal(read.meta.agentConfigId, 'synthetic-agent');
  assert.equal(read.meta.metadataRevision, 0);
  assert.equal(f.store.agents.binding(f.scope)?.id, 'synthetic-agent');
  assert.equal(f.host.list(f.scope.localProjectId).length, 1);
  const reopened = new RuntimeStore(f.file);
  try {
    assert.equal(reopened.agents.binding(f.scope)?.id, 'synthetic-agent');
    assert.equal(metas(reopened.meta)['session-' + f.scope.sessionId].title, '合成空会话');
  } finally {
    reopened.close();
  }
  assert.deepEqual(f.counts(), { opens: 0, prompts: 0, cancels: 0 });
});
test('create receipt failure rolls back metadata, empty document, scope and binding together', async (t) => {
  const f = fixture(t),
    before = f.store.meta;
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_control BEFORE INSERT ON operation BEGIN SELECT RAISE(ABORT,'synthetic-failure'); END",
  );
  await assert.rejects(f.host.controlManager.control(f.create()), /synthetic-failure/);
  assert.equal(f.store.meta, before);
  for (const table of ['session', 'session_agent_binding', 'attachment_scope', 'operation'])
    assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM ' + table).get()?.n, 0);
  assert.equal(f.host.list().length, 0);
});
test('creation rejects foreign identities, absent or disabled versions, busy directories and existing IDs', async (t) => {
  const f = fixture(t);
  for (const extra of [
    { userId: 'foreign' },
    { machineId: 'foreign' },
    { workspaceId: 'foreign' },
    { localProjectId: 'foreign' },
    { agentId: 'foreign' },
  ])
    await assert.rejects(f.host.controlManager.control(f.create(extra)), AppError);
  f.store.machine.set(['disabledAgent', 'synthetic-agent'], true);
  f.host.updateCatalogue();
  await assert.rejects(f.host.controlManager.control(f.create()), /Agent/);
  f.store.machine.set(['disabledAgent', 'synthetic-agent'], false);
  f.host.updateCatalogue();
  f.host.executionManager.busy.add(f.scope.sessionId);
  await assert.rejects(f.host.controlManager.control(f.create()), /目录/);
  f.host.executionManager.busy.delete(f.scope.sessionId);
  await f.host.controlManager.control(f.create());
  await assert.rejects(
    f.host.controlManager.control(f.create({ operationId: 'another' })),
    /已存在/,
  );
  await assert.rejects(f.host.controlManager.control(f.create({ title: 'different' })), /重复编号/);
  assert.deepEqual(f.counts(), { opens: 0, prompts: 0, cancels: 0 });
});
test('create abandonment is durable, reserves the exact project and rejects a foreign fingerprint without storing an empty session', async (t) => {
  const f = fixture(t),
    action = f.create(),
    request = f.recover({ kind: 'control', value: action }, 'abandon');
  const result = await f.host.controlManager.recover(request);
  assert.equal(validateSessionOperationResult(result, request).found, true);
  assert.equal(result.found && result.receipt.status, 'abandoned');
  assert.equal((await f.host.controlManager.control(action)).status, 'abandoned');
  assert.equal(f.host.list().length, 0);
  const second = join(f.root, 'other-project');
  mkdirSync(second);
  const projectId = f.store.registerProject(second);
  f.host.updateCatalogue();
  await assert.rejects(
    f.host.controlManager.control(f.create({ localProjectId: projectId })),
    /不属于/,
  );
  await assert.rejects(
    f.host.controlManager.recover(
      f.recover({ kind: 'control', value: f.create({ title: 'other' }) }, 'abandon'),
    ),
    /重复编号/,
  );
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM session').get()?.n, 0);
});
test('accepted create wins against abandonment and inspect before arrival does not execute or seal', async (t) => {
  const f = fixture(t),
    action = f.create(),
    original = { kind: 'control' as const, value: action };
  assert.equal((await f.host.controlManager.recover(f.recover(original))).found, false);
  assert.equal(f.store.journal.has(action.operationId), false);
  await f.host.controlManager.control(action);
  const result = await f.host.controlManager.recover(f.recover(original, 'abandon'));
  assert.equal(result.found && result.receipt.status, 'accepted');
  assert.equal(f.host.list().length, 1);
});
test('scoped read exports only the requested metadata while retaining original clocks', async (t) => {
  const f = fixture(t);
  await f.host.controlManager.control(f.create());
  await f.host.controlManager.control(
    f.create({
      sessionId: 'other-session',
      operationId: 'other-create',
      title: 'OTHER_SYNTHETIC_METADATA',
    }),
  );
  const full = f.store.meta.exportJson(),
    result = await f.host.read(f.scope.sessionId);
  assert.doesNotMatch(JSON.stringify(result.metaBundle), /other-session|OTHER_SYNTHETIC_METADATA/);
  for (const [key, entry] of Object.entries(result.metaBundle.entries))
    assert.deepEqual(entry, full.entries[key]);
  const imported = Flock.fromJson(result.metaBundle, '1234567890abcdef');
  assert.deepEqual(metas(imported)['session-' + f.scope.sessionId], result.meta);
});
test('unaccepted mutations and metadata actions can be sealed despite later catalogue changes, late requests never execute', async (t) => {
  const f = fixture(t);
  await f.host.controlManager.control(f.create());
  const send = mutation(f),
    action = {
      operationId: 'archive-original',
      workspaceId: f.scope.workspaceId,
      localProjectId: f.scope.localProjectId,
      sessionId: f.scope.sessionId,
      expectedRevision: 0,
      action: 'archive' as const,
    };
  await f.host.sessionAction({
    ...action,
    operationId: 'rename',
    action: 'rename',
    title: 'new title',
  });
  for (const original of [
    { kind: 'mutation' as const, value: send },
    { kind: 'metadata' as const, value: action },
  ]) {
    const result = await f.host.controlManager.recover(f.recover(original, 'abandon'));
    assert.equal(result.found && result.receipt.status, 'abandoned');
  }
  assert.deepEqual(await f.host.mutate(send, f.scope.localProjectId), {
    accepted: false,
    delivered: false,
    abandoned: true,
    operationId: send.operationId,
  });
  assert.equal((await f.host.sessionAction(action)).abandoned, true);
  assert.equal(f.counts().prompts, 0);
  assert.equal(metas(f.store.meta)['session-' + f.scope.sessionId].isArchived, false);
});
test('stop confirms the exact assistant turn once; repeated recovery never cancels another turn', async (t) => {
  const f = fixture(t);
  await f.host.controlManager.control(f.create());
  const send = mutation(f);
  await f.host.mutate(send, f.scope.localProjectId);
  await f.started.promise;
  const turnId = f.host.active.get(f.scope.sessionId)!.turnId;
  const action: SessionControlAction = {
    ...f.scope,
    action: 'stop',
    operationId: 'stop-operation',
    turnId,
  };
  await assert.rejects(f.host.controlManager.control({ ...action, turnId: 'wrong-turn' }), /回合/);
  assert.equal(f.store.journal.has(action.operationId), false);
  const result = await f.host.controlManager.control(action);
  assert.equal(result.status, 'accepted');
  assert.equal(f.host.active.has(f.scope.sessionId), false);
  assert.deepEqual(await f.host.controlManager.control(action), result);
  const recovered = await f.host.controlManager.recover(
    f.recover({ kind: 'control', value: action }, 'abandon'),
  );
  assert.equal(recovered.found && recovered.receipt.status, 'accepted');
  const acceptedSend = await f.host.controlManager.recover(
    f.recover({ kind: 'mutation', value: send }),
  );
  assert.equal(acceptedSend.found && acceptedSend.receipt.status, 'accepted');
  assert.deepEqual(f.counts(), { opens: 1, prompts: 1, cancels: 1 });
});
test('stop intent cannot be dispatched if its durable write fails', async (t) => {
  const f = fixture(t);
  await f.host.controlManager.control(f.create());
  await f.host.mutate(mutation(f), f.scope.localProjectId);
  await f.started.promise;
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_stop BEFORE INSERT ON operation WHEN NEW.phase='control-stopping' BEGIN SELECT RAISE(ABORT,'synthetic-stop-failure'); END",
  );
  await assert.rejects(
    f.host.controlManager.control({
      ...f.scope,
      action: 'stop',
      operationId: 'failed-stop',
      turnId: f.host.active.get(f.scope.sessionId)!.turnId,
    }),
    /synthetic-stop-failure/,
  );
  assert.equal(f.counts().cancels, 0);
  assert.equal(f.host.active.get(f.scope.sessionId)?.stopped, false);
});
test('control and recovery schemas reject raw launch fields, mismatched scope and spoofed receipts', () => {
  const scope = {
      controlVersion: 1 as const,
      workspaceId: 'workspace',
      userId: 'user',
      machineId: 'machine',
      localProjectId: 'project',
      sessionId: 'session',
    },
    action = { ...scope, action: 'create' as const, operationId: 'operation', agentId: 'agent' },
    original = { kind: 'control' as const, value: action };
  assert.equal(
    sessionControlActionSchema.safeParse({ ...action, command: '/synthetic' }).success,
    false,
  );
  assert.equal(
    sessionOperationSchema.safeParse({
      ...scope,
      localProjectId: 'wrong',
      action: 'abandon',
      request: original,
    }).success,
    false,
  );
  assert.throws(() =>
    validateSessionControlReceipt(
      { ...scope, confirmed: true, operationId: 'wrong', kind: 'create', status: 'accepted' },
      scope,
      original,
    ),
  );
});

for (const first of ['create', 'abandon'] as const)
  test(`project control serial ordering preserves ${first} as the original durable result`, async (t) => {
    const f = fixture(t),
      blocked = signal(),
      release = signal();
    const held = f.host.serial(f.scope.sessionId, async () => {
      blocked.resolve();
      await release.promise;
    });
    await blocked.promise;
    const original = f.create(),
      seal = f.recover({ kind: 'control', value: original }, 'abandon');
    const runCreate = () => f.host.controlManager.control(original);
    const runSeal = () => f.host.controlManager.recover(seal);
    const results = first === 'create' ? [runCreate(), runSeal()] : [runSeal(), runCreate()];
    release.resolve();
    await held;
    await Promise.all(results);
    const status = (await f.host.controlManager.control(original)).status;
    assert.equal(status, first === 'create' ? 'accepted' : 'abandoned');
    assert.equal(f.host.list().length, first === 'create' ? 1 : 0);
  });

test('sealing an unreceived stop leaves its active turn running and prevents later cancellation', async (t) => {
  const f = fixture(t);
  await f.host.controlManager.control(f.create());
  await f.host.mutate(mutation(f), f.scope.localProjectId);
  await f.started.promise;
  const action: SessionControlAction = {
    ...f.scope,
    action: 'stop',
    operationId: 'unreceived-stop',
    turnId: f.host.active.get(f.scope.sessionId)!.turnId,
  };
  const result = await f.host.controlManager.recover(
    f.recover({ kind: 'control', value: action }, 'abandon'),
  );
  assert.equal(result.found && result.receipt.status, 'abandoned');
  assert.equal((await f.host.controlManager.control(action)).status, 'abandoned');
  assert.equal(f.host.active.get(f.scope.sessionId)?.stopped, false);
  assert.equal(f.counts().cancels, 0);
});

test('a stop interrupted by host restart is reported as interrupted, never redispatched or claimed as normal cancellation', async (t) => {
  const f = fixture(t);
  await f.host.controlManager.control(f.create());
  await f.host.mutate(mutation(f), f.scope.localProjectId);
  await f.started.promise;
  const action = sessionControlActionSchema.parse({
    ...f.scope,
    action: 'stop',
    operationId: 'interrupted-stop',
    turnId: f.host.active.get(f.scope.sessionId)!.turnId,
  });
  const original = { kind: 'control' as const, value: action };
  // A checkpointed synthetic snapshot models death after the durable intent,
  // before the driver receives cancellation. The copied host has no Agent.
  f.store.journal.db
    .prepare('INSERT INTO operation(id,fingerprint,phase,turn_id,result) VALUES(?,?,?,?,?)')
    .run(
      action.operationId,
      f.store.journal.fingerprint(f.scope.workspaceId, action),
      'control-stopping',
      action.action === 'stop' ? action.turnId : null,
      JSON.stringify({
        ...f.scope,
        operationId: action.operationId,
        confirmed: true,
        kind: 'stop',
        status: 'stopping',
      }),
    );
  f.store.journal.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const restoredFile = join(f.root, 'restored.sqlite');
  copyFileSync(f.file, restoredFile);
  const restored = new RuntimeStore(restoredFile),
    host = new HostWorkspace(
      restored,
      {
        open: async () => {
          throw new Error('Must not restart Agent');
        },
      },
      () => {},
      () => {},
    );
  try {
    const request = f.recover(original),
      result = await host.controlManager.recover(request);
    assert.equal(result.found && result.receipt.status, 'interrupted');
    assert.equal((await host.controlManager.control(action)).status, 'interrupted');
    assert.equal(host.active.size, 0);
    assert.equal(f.counts().cancels, 0);
  } finally {
    host.close();
    restored.close();
  }
});
