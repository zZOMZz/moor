import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, SessionTaskManager, type TaskAuthority } from '../src/runtime/session-tasks';
import { RuntimeStore, type AttachmentScope } from '../src/runtime/store';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { AppError } from '../src/protocol';
import { metas, mirror } from '../src/model';
import { syntheticCapabilities } from './support/agent-capabilities';
import { type TaskPlan } from '../src/task-protocol';
import { buildSessionTurn } from '../src/session-client';

const scope: AttachmentScope = {
  workspaceId: 'workspace',
  userId: 'user',
  machineId: 'machine',
  localProjectId: 'project',
  sessionId: 'parent',
};
const authority: TaskAuthority = {
  serverOrigin: 'https://synthetic.invalid',
  ownerId: 'owner',
  deviceId: 'device',
};
const plan = (extra: Partial<TaskPlan> = {}): TaskPlan => ({
  version: 1,
  tasks: [
    {
      taskId: 'one',
      title: '合成任务',
      agentId: 'agent',
      instruction: '用户明确冻结的说明',
      completion: '由用户核验结果',
      baseBranch: 'main',
      expectedOid: 'a'.repeat(40),
    },
  ],
  maxParallel: 1,
  maxTurnsPerTask: 2,
  timeoutMs: 10000,
  onParentEnd: 'cancel',
  ...extra,
});
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function memory(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const store = new TaskStore(db, { now: () => 1000 });
  t.after(() => db.close());
  return { db, store };
}

test('task grants freeze full authority, finite plans and stable child reservations without sharing local credentials', (t) => {
  const { store } = memory(t),
    original = plan(),
    grant = store.prepareGrant(scope, 'parent-user', 'parent-assistant', original, authority);
  assert.equal(grant.slots.length, 1);
  assert.notEqual(grant.slots[0].childSessionId, scope.sessionId);
  assert.equal(grant.expiresAt, 11000);
  original.tasks[0].instruction = 'changed after grant';
  grant.slots[0].status = 'terminal';
  const saved = store.grant(scope, grant.id);
  assert.equal(saved.plan.tasks[0].instruction, '用户明确冻结的说明');
  assert.equal(saved.slots[0].status, 'reserved');
  assert.equal(
    store.prepareGrant(scope, 'parent-user', 'parent-assistant', plan(), authority).id,
    grant.id,
  );
  assert.throws(() =>
    store.prepareGrant(scope, 'parent-user', 'parent-assistant', plan(), {
      ...authority,
      deviceId: 'other',
    }),
  );
  for (const field of [
    'workspaceId',
    'userId',
    'machineId',
    'localProjectId',
    'sessionId',
  ] as const)
    assert.throws(() => store.grant({ ...scope, [field]: 'other' }, grant.id));
  const child = { ...scope, sessionId: saved.slots[0].childSessionId };
  assert.deepEqual(store.origin(child), {
    version: 1,
    grantId: grant.id,
    taskId: 'one',
    parentSessionId: 'parent',
    parentUserTurnId: 'parent-user',
    parentAssistantTurnId: 'parent-assistant',
    completion: '由用户核验结果',
  });
  assert.throws(() => store.origin({ ...child, localProjectId: 'neighbor' }));
  assert.throws(
    () => store.prepareGrant(child, 'nested-user', 'nested-assistant', plan(), authority),
    /下一层/,
  );
});

test('parent transaction rollback removes grant, child reservations and tool intent together', (t) => {
  const { db, store } = memory(t);
  db.exec('BEGIN IMMEDIATE');
  const grant = store.prepareGrant(scope, 'user-turn', 'assistant-turn', plan(), authority);
  store.stage(grant, {
    grantId: grant.id,
    taskId: 'one',
    operationId: 'create-op',
    action: 'create',
  });
  db.exec('ROLLBACK');
  assert.equal(store.get(grant.id), undefined);
  for (const table of ['task_grant', 'task_slot', 'task_operation'])
    assert.equal(db.prepare('SELECT count(*) AS n FROM ' + table).get()?.n, 0);
});

test('reopening private task tables interrupts authority and preserves exact unknown intent without dispatch', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-task-store-'))),
    file = join(root, 'runtime.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let db = new DatabaseSync(file),
    store = new TaskStore(db, { now: () => 1000 });
  const grant = store.prepareGrant(scope, 'user-turn', 'assistant-turn', plan(), authority),
    slot = grant.slots[0];
  const request = {
    grantId: grant.id,
    taskId: 'one',
    operationId: 'original-create',
    action: 'create' as const,
  };
  store.stage(grant, request);
  slot.status = 'preparing';
  slot.lastOperationId = request.operationId;
  store.putSlot(grant.id, slot);
  db.close();
  db = new DatabaseSync(file);
  store = new TaskStore(db, { now: () => 2000 });
  try {
    const restored = store.grant(scope, grant.id);
    assert.equal(restored.status, 'interrupted');
    assert.equal(restored.slots[0].status, 'unknown');
    assert.equal(store.operation(restored, request)?.phase, 'unknown');
    assert.throws(
      () => store.operation(restored, { ...request, action: 'send', expectedUserTurnId: null }),
      /不同任务/,
    );
    assert.equal(store.blocked({ ...scope, sessionId: slot.childSessionId }), true);
  } finally {
    db.close();
  }
});

function git(root: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      '-C',
      root,
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
        ),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  ).trim();
}
async function fixture(t: TestContext, extra: Partial<TaskPlan> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-task-manager-'))),
    project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'file.txt'), 'synthetic baseline\n');
  git(project, 'init', '--initial-branch=main');
  git(project, 'add', '.');
  git(project, 'commit', '-m', 'Synthetic');
  const store = new RuntimeStore(join(root, 'private', 'runtime.sqlite')),
    projectId = store.registerProject(project);
  store.registerAgent('synthetic', {
    id: 'agent',
    name: 'Synthetic',
    machineId: store.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/not-executed', args: [] },
  });
  store.machine.set(['runCapabilities', 'agent'], syntheticCapabilities as never);
  store.saveMachine();
  const prompts: {
    sessionId: string;
    cwd: string;
    prompt: string;
    done: ReturnType<typeof signal>;
  }[] = [];
  const waiting = new Set<() => void>();
  let opens = 0,
    cancels = 0,
    now = 1000,
    alive = true;
  const timers = new Map<object, () => void>();
  const host = new HostWorkspace(
    store,
    {
      open: async (_agent, cwd, _native, callbacks) => {
        opens++;
        const done = signal();
        return {
          id: 'synthetic-native-' + opens,
          capabilities: syntheticCapabilities,
          prompt: async (input, binding) => {
            prompts.push({ sessionId: binding!.sessionId, cwd, prompt: input.prompt, done });
            for (const wake of waiting) wake();
            waiting.clear();
            callbacks.update({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '合成结果' },
            });
            await done.promise;
          },
          cancel: async () => {
            cancels++;
            done.resolve();
          },
          close: () => done.resolve(),
        };
      },
    },
    () => {},
    () => {},
  );
  const manager = new SessionTaskManager(host, {
    now: () => now,
    schedule: (callback) => {
      const id = {};
      timers.set(id, callback);
      return id;
    },
    cancelTimer: (id) => {
      timers.delete(id as object);
    },
  });
  host.taskManager = manager;
  const parent = {
    workspaceId: store.workspace.id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
    localProjectId: projectId,
    sessionId: 'parent',
  };
  await host.controlManager.control(
    {
      ...parent,
      controlVersion: 1,
      operationId: 'parent-create',
      action: 'create',
      agentId: 'agent',
    },
    projectId,
  );
  const input = plan({
    ...extra,
    tasks: (extra.tasks ?? plan().tasks).map((task) => ({
      ...task,
      expectedOid: git(project, 'rev-parse', 'HEAD'),
    })),
  });
  manager.validatePlan(parent, input, authority);
  const grant = store.transaction(() =>
    store.tasks.prepareGrant(parent, 'parent-user', 'parent-assistant', input, authority),
  );
  const tools = manager.activate(grant.id, () => {
    assert(alive, 'synthetic connection revoked');
  });
  t.after(async () => {
    for (const prompt of prompts) prompt.done.resolve();
    await Promise.all([...host.active.values()].map((run) => run.done));
    host.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (
    name: 'create' | 'send' | 'read' | 'wait' | 'cancel',
    args: Record<string, unknown> = {},
  ) =>
    tools.call(('moor_task_' + name) as never, {
      grantId: grant.id,
      taskId: 'one',
      ...args,
    }) as Promise<any>;
  const started = async (count = 1) => {
    while (prompts.length < count) await new Promise<void>((r) => waiting.add(r));
    return prompts[count - 1];
  };
  return {
    root,
    project,
    store,
    host,
    manager,
    parent,
    grant,
    tools,
    call,
    started,
    prompts,
    timers,
    counts: () => ({ opens, cancels, prompts: prompts.length }),
    revoke: () => {
      alive = false;
      manager.invalidateUnavailable();
    },
    expire: () => {
      now = grant.expiresAt;
      for (const timer of [...timers.values()]) timer();
    },
    action: (
      action: 'inspect' | 'abandon' | 'revoke' | 'cleanup',
      operationId: string,
      extra = {},
    ) =>
      manager.action({
        workspaceId: parent.workspaceId,
        localProjectId: parent.localProjectId,
        sessionId: parent.sessionId,
        taskVersion: 1,
        grantId: grant.id,
        action,
        operationId,
        ...extra,
      }),
  };
}

test('authorized tasks create independent actual worktrees and empty sessions before the fixed first instruction is sent', async (t) => {
  const f = await fixture(t),
    child = f.grant.slots[0].childSessionId;
  assert.deepEqual(f.counts(), { opens: 0, cancels: 0, prompts: 0 });
  await assert.rejects(
    f.host.controlManager.control({
      ...f.parent,
      sessionId: child,
      controlVersion: 1,
      operationId: 'bypass',
      action: 'create',
      agentId: 'agent',
    }),
  );
  const created = await f.call('create', { operationId: 'create-one' });
  assert.equal(created.state, 'accepted');
  assert.deepEqual(f.counts(), { opens: 0, cancels: 0, prompts: 0 });
  const metadata = metas(f.host.meta)['session-' + child];
  assert.equal((metadata.taskOrigin as any).grantId, f.grant.id);
  const scope = { ...f.parent, sessionId: child },
    execution = f.host.executionLease(scope);
  assert.notEqual(execution.rootPath, f.project);
  assert.equal(git(execution.rootPath, 'branch', '--show-current'), f.grant.slots[0].branch);
  const sent = await f.call('send', {
    operationId: 'send-one',
    expectedUserTurnId: null,
    prompt: 'MUST NOT OVERRIDE FIRST INSTRUCTION',
  });
  assert.equal(sent.state, 'accepted');
  const prompt = await f.started();
  assert.equal(prompt.prompt, '用户明确冻结的说明');
  assert.equal(prompt.cwd, execution.rootPath);
  const repeated = await f.call('send', {
    operationId: 'send-one',
    expectedUserTurnId: null,
    prompt: 'MUST NOT OVERRIDE FIRST INSTRUCTION',
  });
  assert.equal(repeated.state, 'accepted');
  assert.equal(f.counts().prompts, 1);
  await assert.rejects(
    f.call('send', { operationId: 'send-one', expectedUserTurnId: null, prompt: 'changed' }),
  );
  prompt.done.resolve();
  await f.host.active.get(child)?.done;
  const read = await f.call('read');
  assert.equal(read.goalVerified, false);
  assert.equal(read.status, 'terminal');
  assert.match(JSON.stringify(read.history), /合成结果/);
  await f.manager.endParent(f.parent, 'parent-assistant', 'canceled');
  assert.equal(f.store.tasks.get(f.grant.id)?.status, 'canceled');
  await assert.rejects(f.call('read'));
});

test('parallel and per-task turn budgets are enforced before dispatch while followups keep exact user history', async (t) => {
  const second = { ...plan().tasks[0], taskId: 'two', title: 'Second' };
  const f = await fixture(t, {
    tasks: [plan().tasks[0], second],
    maxParallel: 1,
    maxTurnsPerTask: 2,
  });
  await f.call('create', { operationId: 'create-one' });
  await f.call('create', { operationId: 'create-two', taskId: 'two' });
  const first = await f.call('send', { operationId: 'send-one', expectedUserTurnId: null });
  const p1 = await f.started();
  await assert.rejects(
    f.call('send', { operationId: 'send-two', taskId: 'two', expectedUserTurnId: null }),
    /并行/,
  );
  assert.equal(f.store.tasks.operationById(f.store.tasks.get(f.grant.id)!, 'send-two'), undefined);
  p1.done.resolve();
  await f.host.active.get(p1.sessionId)?.done;
  await assert.rejects(
    f.call('send', { operationId: 'bad-head', expectedUserTurnId: null, prompt: 'follow' }),
    /历史/,
  );
  const follow = await f.call('send', {
    operationId: 'follow',
    expectedUserTurnId: first.userTurnId,
    prompt: '有限后续说明',
  });
  const p2 = await f.started(2);
  assert.equal(p2.prompt, '有限后续说明');
  p2.done.resolve();
  await f.host.active.get(p2.sessionId)?.done;
  await assert.rejects(
    f.call('send', {
      operationId: 'over-budget',
      expectedUserTurnId: follow.userTurnId,
      prompt: 'third',
    }),
    /预算/,
  );
  assert.equal(f.counts().prompts, 2);
});

test('authority expiry revokes tools and stops only the exact child turn dispatched by its grant', async (t) => {
  const f = await fixture(t);
  await f.call('create', { operationId: 'create' });
  await f.call('send', { operationId: 'send', expectedUserTurnId: null });
  const prompt = await f.started(),
    done = f.host.active.get(prompt.sessionId)!.done;
  f.expire();
  await done;
  assert.equal(f.counts().cancels, 1);
  assert.equal(f.store.tasks.get(f.grant.id)?.status, 'expired');
  await assert.rejects(f.call('send', { operationId: 'late', expectedUserTurnId: null }));
  assert.equal(f.counts().prompts, 1);
});

test('ending a grant does not cancel a user turn subsequently sent to the completed child', async (t) => {
  const f = await fixture(t);
  await f.call('create', { operationId: 'create' });
  await f.call('send', { operationId: 'send', expectedUserTurnId: null });
  const first = await f.started();
  first.done.resolve();
  await f.host.active.get(first.sessionId)?.done;
  const scope = { ...f.parent, sessionId: first.sessionId },
    read = await f.host.read(scope.sessionId, undefined, scope.localProjectId);
  const mutation = buildSessionTurn({
    scope,
    read,
    agent: read.agent!,
    prompt: '用户另发的回合',
    operationId: 'separate-user-send',
    turnId: 'separate-user-turn',
    peerId: '1234123412341234',
    now: new Date(2000).toISOString(),
  });
  await f.host.mutate(mutation, scope.localProjectId);
  const user = await f.started(2);
  await f.manager.endParent(f.parent, 'parent-assistant');
  assert.equal(f.counts().cancels, 0);
  assert.equal(f.host.active.get(user.sessionId)?.stopped, false);
  user.done.resolve();
});

test('lost child creation confirmation blocks fresh IDs, while manual inspect accepts the original saved receipt without another create', async (t) => {
  const f = await fixture(t),
    original = f.host.controlManager.control.bind(f.host.controlManager);
  let calls = 0;
  f.host.controlManager.control = async (...args) => {
    calls++;
    const result = await original(...args);
    throw new AppError(502, 'Synthetic lost receipt');
  };
  const unknown = await f.call('create', { operationId: 'lost-create' });
  assert.equal(unknown.state, 'unknown');
  assert.equal((await f.call('create', { operationId: 'lost-create' })).state, 'unknown');
  assert.equal(calls, 1);
  await assert.rejects(f.call('create', { operationId: 'new-id' }), /原编号/);
  const recovered = await f.action('inspect', 'lost-create');
  assert.equal(recovered.operation?.state, 'accepted');
  assert.equal(calls, 1);
  assert.equal(f.counts().opens, 0);
  f.host.controlManager.control = original;
  const child = f.grant.slots[0].childSessionId;
  assert.equal(f.manager.allowsMutation(child, 'ordinary-user-operation'), true);
});

test('failed empty creation leaves its worktree visible for explicit abandon then clean-directory cleanup', async (t) => {
  const f = await fixture(t),
    original = f.host.controlManager.control;
  f.host.controlManager.control = async () => {
    throw new AppError(409, 'Synthetic create refusal');
  };
  const unknown = await f.call('create', { operationId: 'failed-create' });
  assert.equal(unknown.state, 'unknown');
  const child = f.grant.slots[0].childSessionId,
    scope = { ...f.parent, sessionId: child },
    execution = f.host.store.executions.get(scope)!;
  assert(existsSync(execution.plan.targetPath));
  assert.equal(metas(f.host.meta)['session-' + child], undefined);
  f.host.controlManager.control = original;
  const abandoned = await f.action('abandon', 'failed-create');
  assert.equal(abandoned.operation?.state, 'abandoned');
  assert(existsSync(execution.plan.targetPath));
  await f.action('revoke', 'revoke-grant');
  writeFileSync(join(execution.managed!.cwd, 'dirty.txt'), 'synthetic unsaved');
  await assert.rejects(
    f.action('cleanup', 'dirty-cleanup', {
      taskId: 'one',
      expectedExecutionRevision: execution.execution.revision,
    }),
    /修改/,
  );
  rmSync(join(execution.managed!.cwd, 'dirty.txt'));
  const cleaned = await f.action('cleanup', 'cleanup', {
    taskId: 'one',
    expectedExecutionRevision: execution.execution.revision,
  });
  assert.equal(cleaned.operation?.state, 'accepted');
  assert.equal(existsSync(execution.plan.targetPath), false);
  assert.equal(
    (
      await f.action('cleanup', 'cleanup', {
        taskId: 'one',
        expectedExecutionRevision: execution.execution.revision,
      })
    ).operation?.state,
    'accepted',
  );
  assert(git(f.project, 'branch', '--list', f.grant.slots[0].branch));
});

test('an accepted send with a lost confirmation conservatively keeps its parallel slot until exact recovery and completion', async (t) => {
  const f = await fixture(t, {
    tasks: [plan().tasks[0], { ...plan().tasks[0], taskId: 'two', title: 'Second' }],
    maxParallel: 1,
  });
  await f.call('create', { operationId: 'create-one' });
  await f.call('create', { taskId: 'two', operationId: 'create-two' });
  const original = f.host.mutate.bind(f.host);
  let dispatches = 0;
  f.host.mutate = async (...args) => {
    dispatches++;
    await original(...args);
    throw new AppError(502, 'Synthetic lost send confirmation');
  };
  const sent = await f.call('send', { operationId: 'lost-send', expectedUserTurnId: null });
  assert.equal(sent.state, 'unknown');
  const first = await f.started();
  await assert.rejects(
    f.call('send', { taskId: 'two', operationId: 'second-send', expectedUserTurnId: null }),
    /并行/,
  );
  assert.equal(dispatches, 1);
  const recovered = await f.action('inspect', 'lost-send');
  assert.equal(recovered.operation?.state, 'accepted');
  assert.equal(dispatches, 1);
  await assert.rejects(
    f.call('send', { taskId: 'two', operationId: 'second-send', expectedUserTurnId: null }),
    /并行/,
  );
  first.done.resolve();
  await f.host.active.get(first.sessionId)?.done;
  f.host.mutate = original;
  assert.equal(
    (await f.call('send', { taskId: 'two', operationId: 'second-send', expectedUserTurnId: null }))
      .state,
    'accepted',
  );
  (await f.started(2)).done.resolve();
});

test('task reads cap multilingual plans and large child output with explicit truncation', async (t) => {
  const f = await fixture(t);
  const huge = plan({
    tasks: Array.from({ length: 8 }, (_, index) => ({
      ...plan().tasks[0],
      taskId: 'large-' + index,
      instruction: '测'.repeat(10000),
      completion: '验'.repeat(2000),
    })),
  });
  for (let index = 0; index < 6; index++)
    f.store.tasks.prepareGrant(
      f.parent,
      'large-user-' + index,
      'large-assistant-' + index,
      huge,
      authority,
    );
  const request = {
    taskVersion: 1 as const,
    workspaceId: f.parent.workspaceId,
    localProjectId: f.parent.localProjectId,
    sessionId: f.parent.sessionId,
  };
  const read = f.manager.read(request);
  assert.equal(read.truncated, true);
  assert(read.grants.length < 7);
  assert(Buffer.byteLength(JSON.stringify(read)) < 1024 * 1024);
  await f.call('create', { operationId: 'create' });
  await f.call('send', { operationId: 'send', expectedUserTurnId: null });
  const prompt = await f.started();
  f.host.update(prompt.sessionId, f.host.active.get(prompt.sessionId)!, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '测'.repeat(50000) },
  });
  const childRead = await f.call('read');
  assert.equal(childRead.truncated, true);
  assert(Buffer.byteLength(JSON.stringify(childRead)) < 1024 * 1024);
  assert(childRead.history.every((turn: any) => turn.text.length <= 16000));
  prompt.done.resolve();
});

test('synchronous host shutdown revokes tools even when recording the grant interruption fails', async (t) => {
  const f = await fixture(t);
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_task_close BEFORE UPDATE ON task_grant BEGIN SELECT RAISE(ABORT,'synthetic interruption write failure'); END",
  );
  assert.doesNotThrow(() => f.manager.close());
  assert.equal(f.timers.size, 0);
  assert.throws(() => f.tools.current());
  f.store.journal.db.exec('DROP TRIGGER fail_task_close');
});

test('manual recovery settles a durable stopping child intent from its finished turn without another cancellation', async (t) => {
  const f = await fixture(t);
  await f.call('create', { operationId: 'create' });
  const sent = await f.call('send', { operationId: 'send', expectedUserTurnId: null });
  await f.started();
  const original = f.host.controlManager.control.bind(f.host.controlManager);
  f.host.controlManager.control = async (...args) => {
    const receipt = await original(...args);
    if (args[0].action === 'stop') {
      f.store.journal.db
        .prepare('UPDATE operation SET phase=?,result=? WHERE id=?')
        .run(
          'control-stopping',
          JSON.stringify({ ...receipt, status: 'stopping' }),
          args[0].operationId,
        );
      throw new AppError(502, 'Synthetic stopping acknowledgement loss');
    }
    return receipt;
  };
  const canceled = await f.call('cancel', {
    operationId: 'cancel',
    expectedAssistantTurnId: sent.assistantTurnId,
  });
  assert.equal(canceled.state, 'unknown');
  assert.equal(f.counts().cancels, 1);
  const inspected = await f.action('inspect', 'cancel');
  assert.equal(inspected.operation?.state, 'accepted');
  assert.equal(f.counts().cancels, 1);
  f.host.controlManager.control = original;
});

test('a live grant pins parent directory identity and MCP current failure revokes its tools', async (t) => {
  const f = await fixture(t),
    old = f.project + '-original';
  renameSync(f.project, old);
  mkdirSync(f.project);
  try {
    assert.throws(() => f.tools.current(), /目录身份/);
    assert.equal(f.store.tasks.get(f.grant.id)?.status, 'canceled');
    assert.equal(f.timers.size, 0);
    await assert.rejects(f.call('create', { operationId: 'late' }));
    assert.equal(f.counts().opens, 0);
  } finally {
    rmSync(f.project, { recursive: true, force: true });
    renameSync(old, f.project);
  }
});

test('abandoning a proven undispatched send restores the authorized history head without refunding its budget', async (t) => {
  const f = await fixture(t);
  await f.call('create', { operationId: 'create' });
  const original = f.host.mutate.bind(f.host);
  f.host.mutate = async () => {
    throw new AppError(409, 'Synthetic refused before journal');
  };
  assert.equal(
    (await f.call('send', { operationId: 'unsent', expectedUserTurnId: null })).state,
    'unknown',
  );
  assert.equal(f.counts().prompts, 0);
  const abandoned = await f.action('abandon', 'unsent');
  assert.equal(abandoned.operation?.state, 'abandoned');
  const slot = f.store.tasks.get(f.grant.id)!.slots[0];
  assert.equal(slot.latestUserTurnId, undefined);
  assert.equal(slot.turnCount, 1);
  f.host.mutate = original;
  assert.equal(
    (
      await f.call('send', {
        operationId: 'new-authorized-send',
        expectedUserTurnId: null,
        prompt: 'cannot replace initial instruction',
      })
    ).state,
    'accepted',
  );
  const prompt = await f.started();
  assert.equal(prompt.prompt, '用户明确冻结的说明');
  prompt.done.resolve();
});

test('MCP child read accounts for JSON escaping and returns bounded partial history', async (t) => {
  const f = await fixture(t);
  await f.call('create', { operationId: 'create' });
  await f.call('send', { operationId: 'send', expectedUserTurnId: null });
  const prompt = await f.started();
  const run = f.host.active.get(prompt.sessionId)!,
    view = mirror(run.doc, prompt.sessionId);
  view.setState((state) => {
    const template = JSON.parse(
      JSON.stringify(state.history.find((turn) => turn.role === 'assistant')!),
    );
    for (let i = 0; i < 20; i++)
      state.history.push({
        ...template,
        id: 'synthetic-history-' + i,
        finished: true,
        status: 'handled',
        items: [{ type: 'text', text: '\u0001'.repeat(16000) }],
      });
  });
  view.dispose();
  f.store.persist(prompt.sessionId, run.doc);
  const read = await f.call('read', { offset: 2, limit: 20 });
  assert.equal(read.truncated, true);
  assert(read.history.length < 20);
  assert(
    Buffer.byteLength(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify(read) }] },
      }),
    ) <
      1024 * 1024,
  );
  prompt.done.resolve();
});

test('revoking a removed project still stops its original active child using immutable run scope', async (t) => {
  const f = await fixture(t);
  await f.call('create', { operationId: 'create' });
  await f.call('send', { operationId: 'send', expectedUserTurnId: null });
  const prompt = await f.started(),
    done = f.host.active.get(prompt.sessionId)!.done;
  f.store.machine.set(['localProject', f.parent.localProjectId], undefined as never);
  f.store.saveMachine();
  f.host.updateCatalogue();
  await f.manager.endParent(f.parent, 'parent-assistant');
  await done;
  assert.equal(f.counts().cancels, 1);
  assert.equal(f.host.active.has(prompt.sessionId), false);
  assert.equal(f.store.tasks.get(f.grant.id)?.status, 'canceled');
});

test('a followup read failure preserves the previous durable head through abandonment and the next authorized send', async (t) => {
  const f = await fixture(t);
  await f.call('create', { operationId: 'create' });
  const first = await f.call('send', { operationId: 'first-send', expectedUserTurnId: null });
  const firstPrompt = await f.started();
  firstPrompt.done.resolve();
  await f.host.active.get(firstPrompt.sessionId)?.done;
  const original = f.host.read.bind(f.host);
  f.host.read = async () => {
    const saved = f.store.tasks.operationById(f.store.tasks.get(f.grant.id)!, 'failed-read');
    assert.equal(saved?.previousUserTurnId, first.userTurnId);
    assert.equal(saved?.previousAssistantTurnId, first.assistantTurnId);
    throw new AppError(409, 'Synthetic read failed before a new mutation existed');
  };
  const failed = await f.call('send', {
    operationId: 'failed-read',
    expectedUserTurnId: first.userTurnId,
    prompt: '未派发的后续说明',
  });
  assert.equal(failed.state, 'unknown');
  assert.equal(f.counts().prompts, 1);
  f.host.read = original;
  assert.equal((await f.action('abandon', 'failed-read')).operation?.state, 'abandoned');
  const slot = f.store.tasks.get(f.grant.id)!.slots[0];
  assert.equal(slot.latestUserTurnId, first.userTurnId);
  assert.equal(slot.latestAssistantTurnId, first.assistantTurnId);
  assert.equal(slot.turnCount, 1);
  const next = await f.call('send', {
    operationId: 'next-send',
    expectedUserTurnId: first.userTurnId,
    prompt: '按原历史继续的明确说明',
  });
  assert.equal(next.state, 'accepted');
  const nextPrompt = await f.started(2);
  assert.equal(nextPrompt.prompt, '按原历史继续的明确说明');
  nextPrompt.done.resolve();
});
