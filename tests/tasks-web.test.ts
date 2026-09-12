import test from 'node:test';
import assert from 'node:assert/strict';
import { TasksController, tasksKey, validateTaskReview, type TaskDraft } from '../src/web/tasks';
import type { GitTarget } from '../src/web/git-workspace';
import type { Mutation } from '../src/protocol';
import type { TaskGrantView, TaskAction } from '../src/task-protocol';
const target: GitTarget = {
  owner: 'owner',
  deviceId: 'device',
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'parent',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
};
const plan: TaskDraft = {
  version: 1,
  tasks: [
    {
      taskId: 'task',
      title: 'Synthetic task',
      agentId: 'agent',
      instruction: 'Inspect synthetic fixture',
      completion: 'Report result',
      baseBranch: 'main',
      expectedOid: 'a'.repeat(40),
    },
  ],
  maxParallel: 1,
  maxTurnsPerTask: 1,
  timeoutMs: 60000,
  onParentEnd: 'cancel',
};
const mutation: Mutation = {
  operationId: 'send-op',
  workspaceId: 'runtime',
  sessionId: 'parent',
  kind: 'turn',
  expectedTurnId: null,
  update: 'YQ==',
  metaBundle: {},
};
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
}
function fixture() {
  const rows = new Map<string, any>(),
    calls: { path: string; body: any }[] = [];
  let current = true,
    online = true,
    failWrite = false,
    gate: undefined | (() => Promise<void>),
    response: unknown;
  const deps = {
    read: async (key: string) => structuredClone(rows.get(key)),
    compareWrite: async (
      key: string,
      expected: number,
      value: { cacheRevision: number },
      isCurrent: () => boolean,
    ) => {
      await gate?.();
      if (failWrite) throw Error('storage failed');
      if (!isCurrent()) throw Error('scope changed');
      if ((rows.get(key)?.cacheRevision ?? 0) !== expected) return false;
      rows.set(key, structuredClone(value));
      return true;
    },
    compareSubmission: async (
      entries: readonly { key: string; expected: unknown; value: unknown }[],
      isCurrent: () => boolean,
    ) => {
      await gate?.();
      if (failWrite) throw Error('storage failed');
      if (!isCurrent()) throw Error('scope changed');
      if (entries.some((e) => JSON.stringify(rows.get(e.key)) !== JSON.stringify(e.expected)))
        return false;
      for (const e of entries) rows.set(e.key, structuredClone(e.value));
      return true;
    },
    request: async (path: string, body: unknown) => {
      calls.push({ path, body: structuredClone(body) });
      await gate?.();
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? (response as any)(body) : structuredClone(response);
    },
    current: () => current,
    online: () => online,
    changed: () => {},
    uuid: () => `operation-${calls.length}-${rows.get(tasksKey(target))?.cacheRevision ?? 0}`,
  };
  return {
    rows,
    calls,
    create: () => new TasksController(target, deps),
    set current(v: boolean) {
      current = v;
    },
    set online(v: boolean) {
      online = v;
    },
    set failWrite(v: boolean) {
      failWrite = v;
    },
    set gate(v: typeof gate) {
      gate = v;
    },
    set response(v: unknown) {
      response = v;
    },
  };
}
function grant(): TaskGrantView {
  return {
    grantId: 'grant',
    parentSessionId: 'parent',
    parentUserTurnId: 'parent-user',
    parentAssistantTurnId: 'parent-assistant',
    state: 'interrupted',
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-01T01:00:00Z',
    plan,
    tasks: [
      {
        taskId: 'task',
        childSessionId: 'child',
        sessionCreated: false,
        title: plan.tasks[0]!.title,
        agentId: 'agent',
        completion: 'Report result',
        status: 'unknown',
        turnsUsed: 0,
        execution: { mode: 'worktree', status: 'ready', revision: 1, executionId: 'execution' },
        goalVerified: false,
      },
    ],
    operations: [{ operationId: 'tool-op', taskId: 'task', kind: 'create', state: 'unknown' }],
  };
}
async function enabled(f: ReturnType<typeof fixture>) {
  const c = f.create();
  await c.load();
  await c.edit(plan);
  await c.enable(plan, 'parent-agent');
  return c;
}
test('task review requires current child Agent and exact local baseline, forbids recursive plans', () => {
  const context = {
    parentAgentId: 'parent-agent',
    child: false,
    agents: [{ id: 'agent' }],
    branches: [{ name: 'main', oid: 'a'.repeat(40) }],
  };
  assert.deepEqual(validateTaskReview(plan, context), plan);
  assert.throws(() => validateTaskReview(plan, { ...context, child: true }), /不能/);
  assert.throws(() => validateTaskReview(plan, { ...context, agents: [] }), /Agent/);
  assert.throws(
    () =>
      validateTaskReview(plan, { ...context, branches: [{ name: 'main', oid: 'b'.repeat(40) }] }),
    /基线/,
  );
  assert.throws(
    () =>
      validateTaskReview(
        { ...plan, tasks: [{ ...plan.tasks[0]!, selection: { modelId: 'unavailable' } }] },
        context,
      ),
    /模型/,
  );
});
test('reviewed task and parent mutation stage together; refresh only restores; original confirmation preserves newer task edits', async () => {
  const f = fixture(),
    c = await enabled(f);
  await c.stageSubmission(mutation, 'parent/pending', mutation);
  assert.equal(f.calls.length, 0);
  assert.equal(f.rows.get('parent/pending').operationId, mutation.operationId);
  const restored = f.create();
  await restored.load();
  assert.equal(restored.delivery!.operationId, mutation.operationId);
  assert.equal(await restored.verifySubmission(mutation), true);
  await assert.rejects(
    restored.verifySubmission({ ...mutation, operationId: 'another' }),
    /原任务/,
  );
  await restored.edit({
    ...plan,
    tasks: [{ ...plan.tasks[0]!, instruction: 'A later local draft' }],
  });
  await restored.confirmSubmission(mutation.operationId);
  assert.equal(restored.delivery, undefined);
  assert.equal(restored.draft.tasks[0]!.instruction, 'A later local draft');
  assert.equal(restored.enabled, undefined);
  assert.equal(f.calls.length, 0);
});
test('task CAS conflict, target invalidation and storage failure cannot leave a half staged parent or overwrite other tabs', async () => {
  const f = fixture(),
    a = await enabled(f),
    b = f.create();
  await b.load();
  await a.edit({ ...plan, maxParallel: 2 });
  await assert.rejects(b.stageSubmission(mutation, 'pending', mutation));
  assert.ok(b.loadError);
  assert.equal(f.rows.has('pending'), false);
  assert.equal(f.rows.get(tasksKey(target)).draft.maxParallel, 2);
  const failed = fixture(),
    c = await enabled(failed);
  failed.failWrite = true;
  await assert.rejects(c.stageSubmission(mutation, 'pending', mutation));
  assert.equal(failed.rows.has('pending'), false);
  assert.equal(failed.rows.get(tasksKey(target)).delivery, undefined);
  const stale = fixture(),
    d = await enabled(stale),
    entered = signal(),
    release = signal();
  stale.gate = async () => {
    entered.resolve();
    await release.promise;
  };
  const staging = d.stageSubmission(mutation, 'pending', mutation);
  await entered.promise;
  stale.current = false;
  release.resolve();
  await assert.rejects(staging);
  assert.equal(stale.rows.has('pending'), false);
  assert.equal(stale.calls.length, 0);
});
test('queued task input is saved before enabling and concurrent edits cannot replace an in-flight review', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  const entered = signal(),
    release = signal();
  f.gate = async () => {
    entered.resolve();
    await release.promise;
  };
  const edit = c.edit(plan);
  await entered.promise;
  const enabling = c.enable(plan, 'parent-agent');
  assert.throws(() => c.edit({ ...plan, maxParallel: 2 }), /等待/);
  release.resolve();
  await edit;
  await enabling;
  assert.deepEqual(c.enabled!.plan, plan);
});
test('unknown cleanup is durable and retries exact parameters; inspect remains read-only and terminal receipt clears pending', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  f.response = Error('response lost');
  await assert.rejects(
    c.action('cleanup', 'grant', 'cleanup-op', { taskId: 'task', expectedExecutionRevision: 1 }),
  );
  const original = structuredClone(c.pending);
  assert.equal(f.rows.get(tasksKey(target)).pending.operationId, 'cleanup-op');
  const restored = f.create();
  await restored.load();
  assert.equal(f.calls.length, 1);
  f.response = (request: TaskAction) => ({
    ...request,
    confirmed: true,
    grant: grant(),
    operation: { operationId: 'cleanup-op', taskId: 'task', kind: 'cleanup', state: 'unknown' },
  });
  await restored.retry();
  assert.deepEqual(f.calls[1]!.body, original);
  assert.ok(restored.pending);
  f.response = (request: TaskAction) => ({
    ...request,
    confirmed: true,
    grant: grant(),
    operation: { operationId: 'cleanup-op', taskId: 'task', kind: 'cleanup', state: 'accepted' },
  });
  await restored.action('inspect', 'grant', 'cleanup-op');
  assert.equal(f.calls[2]!.body.action, 'inspect');
  assert.equal(restored.pending, undefined);
  assert.equal(restored.receipt!.operation!.state, 'accepted');
});
test('abandon retains unknown original and validates full scope; revoked grants do not imply stopped children', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  f.response = (request: TaskAction) => ({
    ...request,
    sessionId: 'another',
    confirmed: true,
    grant: grant(),
  });
  await assert.rejects(c.action('abandon', 'grant', 'tool-op'));
  assert.equal(c.pending!.operationId, 'tool-op');
  f.response = (request: TaskAction) => ({
    ...request,
    confirmed: true,
    grant: grant(),
    operation: { operationId: 'tool-op', taskId: 'task', kind: 'create', state: 'unknown' },
  });
  await c.retry();
  assert.ok(c.pending);
  f.response = (request: TaskAction) => ({
    ...request,
    confirmed: true,
    grant: grant(),
    operation: { operationId: 'tool-op', taskId: 'task', kind: 'create', state: 'abandoned' },
  });
  await c.retry();
  assert.equal(c.pending, undefined);
  f.response = Error('lost revoke');
  await assert.rejects(c.action('revoke', 'grant', 'revoke-op'));
  await assert.rejects(c.action('inspect', 'grant', 'revoke-op'), /撤销/);
  f.response = (request: TaskAction) => ({
    ...request,
    confirmed: true,
    grant: { ...grant(), state: 'canceled', tasks: [{ ...grant().tasks[0]!, status: 'running' }] },
  });
  await c.retry();
  assert.equal(c.pending, undefined);
  assert.equal(c.receipt!.grant.tasks[0]!.status, 'running');
});
test('closing or offline clears host grant bodies, rejects late status responses and never executes restored drafts', async () => {
  const f = fixture(),
    c = await enabled(f);
  const entered = signal(),
    release = signal();
  f.gate = async () => {
    entered.resolve();
    await release.promise;
  };
  f.response = (request: any) => ({
    ...request,
    confirmed: true,
    grants: [grant()],
    truncated: false,
  });
  const read = c.refresh();
  await entered.promise;
  c.invalidate();
  release.resolve();
  await read;
  assert.equal(c.list, undefined);
  assert.equal(c.receipt, undefined);
  f.online = false;
  await assert.rejects(c.refresh(), /离线/);
  assert.equal(f.calls.length, 1);
  const restored = f.create();
  await restored.load();
  assert.ok(restored.enabled);
  assert.equal(f.calls.length, 1);
});
test('going offline while a task operation is being saved retains the exact request without dispatching', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  const entered = signal(),
    release = signal();
  f.gate = async () => {
    entered.resolve();
    await release.promise;
  };
  const operation = c.action('cleanup', 'grant', 'cleanup-offline', {
    taskId: 'task',
    expectedExecutionRevision: 1,
  });
  await entered.promise;
  f.online = false;
  release.resolve();
  await assert.rejects(operation, /离线/);
  assert.equal(f.calls.length, 0);
  assert.equal(c.pending!.operationId, 'cleanup-offline');
  assert.equal(f.rows.get(tasksKey(target)).pending.operationId, 'cleanup-offline');
  const staged = fixture(),
    parent = await enabled(staged);
  await parent.stageSubmission(mutation, 'pending', mutation);
  staged.online = false;
  await assert.rejects(parent.verifySubmission(mutation), /离线/);
  assert.equal(staged.rows.get('pending').operationId, mutation.operationId);
  assert.ok(parent.delivery);
});
