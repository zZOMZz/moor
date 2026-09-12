import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CliState, requestVersion } from '../src/cli/state';
import { secureOriginal, type SecureCliTarget } from '../src/cli/secure-operation';
import { RuntimeStore } from '../src/runtime/store';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { buildSessionTurn } from '../src/session-client';
import { sessionOperationSchema } from '../src/session-control-protocol';

const target: SecureCliTarget = {
  origin: 'https://relay.synthetic.invalid',
  owner: 'owner',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'runtime',
  localProjectId: 'project',
  userId: 'local-owner',
  machineId: 'machine',
  sessionId: 'session',
};
function input(operationId = 'operation', kind: 'create' | 'stop' = 'create') {
  return {
    operationId,
    kind,
    target: structuredClone(target),
    body: JSON.stringify({
      method: 'session-control',
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      params: {
        controlVersion: 1,
        operationId,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        userId: target.userId,
        machineId: target.machineId,
        sessionId: target.sessionId,
        action: kind,
        ...(kind === 'create'
          ? { agentId: 'agent', title: 'synthetic private title' }
          : { turnId: 'exact-turn' }),
      },
    }),
  };
}
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-secure-state-'))),
    state = new CliState(root);
  t.after(() => {
    state.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, state };
}

test('secure outbox persists original bytes independently from the legacy HTTP recovery table', (t) => {
  const f = fixture(t),
    original = input();
  original.body = JSON.stringify(JSON.parse(original.body), null, 2) + '\n';
  const staged = f.state.secureStage(original, '2026-01-02T00:00:00.000Z');
  assert.equal(staged.requestVersion, requestVersion(original.body));
  assert.equal(f.state.operation(staged.operationId), undefined);
  assert.deepEqual(f.state.operationSummaries().operations, []);
  const second = new CliState(f.root);
  try {
    assert.deepEqual(second.secureOperation(staged.operationId), staged);
    assert.deepEqual(secureOriginal(staged).value, JSON.parse(original.body).params);
    assert.equal(second.secureOperation(staged.operationId)?.body, original.body);
    assert.deepEqual(second.secureStage(original), staged);
  } finally {
    second.close();
  }
});

for (const state of ['pending', 'ending'] as const)
  test(`${state} original blocks a competing session request but permits exact stopping`, (t) => {
    const f = fixture(t);
    f.state.secureStage(input());
    if (state === 'ending') f.state.secureTransition('operation', ['pending'], 'ending');
    const second = new CliState(f.root);
    try {
      assert.throws(
        () => second.secureStage(input('competing')),
        (error: any) => {
          assert.equal(error.code, 'pending');
          assert.equal(error.operationId, 'operation');
          return true;
        },
      );
      assert.equal(second.secureStage(input('stop', 'stop')).state, 'pending');
      assert.equal(f.state.secureOperation('operation')?.state, state);
      assert.equal(second.secureOperation('competing'), undefined);
    } finally {
      second.close();
    }
  });

test('secure original IDs cannot be reused for changed bodies or identities across database instances', (t) => {
  const f = fixture(t),
    original = f.state.secureStage(input());
  const second = new CliState(f.root);
  try {
    for (const value of [
      { ...input(), target: { ...target, owner: 'different-owner' } },
      { ...input(), target: { ...target, clientDeviceId: 'different-client' } },
      { ...input(), target: { ...target, rootKeyId: Buffer.alloc(32, 2).toString('base64url') } },
      { ...input(), body: input().body.replace('synthetic private title', 'different title') },
    ])
      assert.throws(() => second.secureStage(value), /原操作编号/);
    assert.deepEqual(f.state.secureOperation('operation'), original);
  } finally {
    second.close();
  }
});

for (const mutation of [
  (value: any) => (value.operationId = 'other-id'),
  (value: any) => (value.requestVersion = 'sha256:' + '0'.repeat(64)),
  (value: any) => (value.body = value.body.replace('synthetic private title', 'unverified body')),
])
  test('secure recovery fails closed for an altered original record', (t) => {
    const f = fixture(t),
      original = f.state.secureStage(input());
    const db = new DatabaseSync(join(f.root, 'moor-cli-v1.sqlite'));
    try {
      const altered = structuredClone(original);
      mutation(altered);
      db.prepare('UPDATE secure_outbox SET value=? WHERE id=?').run(
        JSON.stringify(altered),
        'operation',
      );
      assert.throws(() => f.state.secureOperation('operation'));
    } finally {
      db.close();
    }
  });

for (const field of ['workspaceId', 'localProjectId', 'sessionId', 'userId', 'machineId'] as const)
  test(`secure staging rejects an original command whose inner ${field} contradicts its target`, (t) => {
    const f = fixture(t),
      operation = input(),
      body = JSON.parse(operation.body);
    body.params[field] = 'other-scope';
    operation.body = JSON.stringify(body);
    assert.throws(() => f.state.secureStage(operation));
    assert.equal(f.state.secureOperation(operation.operationId), undefined);
  });

test('settings CAS detects auth ABA and preserves newer credentials atomically', (t) => {
  const f = fixture(t),
    auth = {
      kind: 'remote',
      connection: {
        origin: target.origin,
        owner: target.owner,
        cookie: 'personal=' + 'a'.repeat(43),
      },
    };
  f.state.set('auth', auth);
  const revision = f.state.settingsRevision(),
    second = new CliState(f.root);
  try {
    second.set('auth', { ...auth, connection: { ...auth.connection, owner: 'different-owner' } });
    second.set('auth', auth);
    assert.deepEqual(f.state.get('auth'), auth);
    assert.notEqual(f.state.settingsRevision(), revision);
    assert.throws(
      () =>
        f.state.compareAndSetSettings(revision, { auth: undefined, 'google-attempt': undefined }),
      /状态已改变/,
    );
    assert.deepEqual(f.state.get('auth'), auth);
    const current = f.state.settingsRevision();
    assert.equal(
      f.state.compareAndSetSettings(current, {
        auth: undefined,
        'google-attempt': { phase: 'unknown' },
      }),
      current + 1,
    );
    assert.equal(second.get('auth'), undefined);
    assert.deepEqual(second.get('google-attempt'), { phase: 'unknown' });
  } finally {
    second.close();
  }
});

test('a concurrent ending transition is not overwritten by a stale pending completion', (t) => {
  const f = fixture(t);
  f.state.secureStage(input());
  const second = new CliState(f.root);
  try {
    second.secureTransition('operation', ['pending'], 'ending');
    assert.throws(
      () => f.state.secureTransition('operation', ['pending'], 'accepted', { confirmed: true }),
      /状态已改变/,
    );
    assert.equal(f.state.secureOperation('operation')?.state, 'ending');
    assert.equal(
      f.state.secureTransition('operation', ['pending', 'ending'], 'accepted', { confirmed: true })
        .state,
      'accepted',
    );
  } finally {
    second.close();
  }
});

test('secure operation summaries are bounded and omit both original text and receipt bodies', (t) => {
  const f = fixture(t);
  for (let index = 0; index < 102; index++) {
    const op = f.state.secureStage(input('operation-' + index));
    f.state.secureTransition(op.operationId, ['pending'], 'accepted', {
      private: 'synthetic private receipt',
    });
  }
  const summary = f.state.secureOperationSummaries();
  assert.equal(summary.operations.length, 100);
  assert.equal(summary.operations[0].operationId, 'operation-101');
  assert.equal(summary.truncated, true);
  assert.equal(JSON.stringify(summary).includes('synthetic private'), false);
  f.state.secureOperation = () => {
    throw Error('Original bodies must not be loaded for listing');
  };
  assert.equal(f.state.secureOperationSummaries().operations.length, 100);
});

test('a turn built from a real Host session stages and recovers its project scope without inventing mutation fields', async (t) => {
  const f = fixture(t),
    project = join(f.root, 'synthetic-project');
  mkdirSync(project, { mode: 0o700 });
  const runtime = new RuntimeStore(join(f.root, 'host.sqlite')),
    localProjectId = runtime.registerProject(project);
  runtime.registerAgent('synthetic', {
    id: 'synthetic-agent',
    name: 'Synthetic Agent',
    machineId: runtime.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/never-run', args: [] },
  });
  const host = new HostWorkspace(
    runtime,
    {
      open: async () => {
        throw Error('This state test must never start an Agent');
      },
    },
    () => {},
    () => {},
  );
  try {
    const scope = {
      controlVersion: 1 as const,
      workspaceId: runtime.workspace.id,
      localProjectId,
      userId: runtime.workspace.userId,
      machineId: runtime.workspace.machineId,
      sessionId: 'synthetic-real-session',
    };
    await host.controlManager.control(
      {
        ...scope,
        operationId: 'synthetic-create',
        action: 'create',
        agentId: 'synthetic-agent',
      },
      localProjectId,
    );
    const params = buildSessionTurn({
      scope,
      read: await host.read(scope.sessionId, undefined, localProjectId),
      agent: host.workspace.agents[0],
      prompt: 'Synthetic pending request whose project is held by the typed wrapper',
      operationId: 'synthetic-real-turn',
      turnId: 'synthetic-user-turn',
      peerId: 'abcd1234',
      now: '2026-01-02T00:00:00.000Z',
    });
    assert.equal(Object.hasOwn(params, 'localProjectId'), false);
    assert.ok(params.update.length > 0);
    const operation = {
      operationId: params.operationId,
      kind: 'turn' as const,
      target: {
        ...target,
        workspaceId: scope.workspaceId,
        localProjectId,
        userId: scope.userId,
        machineId: scope.machineId,
        sessionId: scope.sessionId,
      },
      body: JSON.stringify({
        method: 'mutate',
        workspaceId: scope.workspaceId,
        localProjectId,
        params,
      }),
    };
    // Reject malformed turns before there is any prior ID or pending record that
    // could mask a missing scope check with an unrelated outbox conflict.
    const invalid = JSON.parse(operation.body);
    invalid.params.workspaceId = 'wrong-runtime';
    assert.throws(() => f.state.secureStage({ ...operation, body: JSON.stringify(invalid) }));
    invalid.params.workspaceId = scope.workspaceId;
    invalid.localProjectId = 'wrong-project';
    assert.throws(() => f.state.secureStage({ ...operation, body: JSON.stringify(invalid) }));
    assert.equal(f.state.secureOperation(operation.operationId), undefined);
    const staged = f.state.secureStage(operation);
    assert.equal(staged.state, 'pending');
    assert.equal(f.state.secureOperation(staged.operationId)?.body, operation.body);
    const original = secureOriginal(staged);
    assert.equal(original.kind, 'mutation');
    assert.deepEqual(original.value, params);
    const recovery = sessionOperationSchema.parse({
      ...scope,
      action: 'inspect',
      request: original,
    });
    assert.equal(recovery.localProjectId, localProjectId);
    assert.equal(Object.hasOwn(recovery.request.value, 'localProjectId'), false);

    assert.deepEqual(f.state.secureOperation(staged.operationId), staged);
    assert.equal(host.active.size, 0);
  } finally {
    host.close();
    runtime.close();
  }
});
