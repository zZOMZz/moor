import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/runtime/store';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { buildSessionTurn } from '../src/session-client';
import { syntheticCapabilities } from './support/agent-capabilities';
import {
  taskPlanSchema,
  validateTaskReadResult,
  type TaskAuthorityLease,
  type TaskPlan,
} from '../src/task-protocol';
import type { AgentOpenOptions } from '../src/runtime/agent';
import { metas } from '../src/model';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-task-host-'))),
    project = join(root, 'project');
  mkdirSync(project);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', project, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
  git('init', '-b', 'main');
  writeFileSync(join(project, 'fixture.txt'), 'Synthetic task fixture\n');
  git('add', 'fixture.txt');
  git(
    '-c',
    'user.name=Synthetic',
    '-c',
    'user.email=synthetic@example.invalid',
    'commit',
    '-m',
    'synthetic baseline',
  );
  const oid = git('rev-parse', 'HEAD'),
    store = new RuntimeStore(join(root, 'runtime.sqlite')),
    projectId = store.registerProject(project);
  for (const name of ['parent', 'child'])
    store.registerAgent(name, {
      id: name,
      name,
      machineId: store.workspace.machineId,
      cliType: 'custom',
      agentType: 'synthetic',
      customAcp: { command: '/synthetic/never-executed', args: [] },
    });
  const parentStarted = signal(),
    parentFinish = signal(),
    childStarted = signal(),
    childFinish = signal(),
    allowPrompt = signal();
  let options: AgentOpenOptions | undefined,
    childPrompts = 0,
    childCancels = 0,
    parentPrompts = 0,
    online = true;
  const roots: string[] = [];
  const host = new HostWorkspace(
    store,
    {
      open: async (config, cwd, _native, callbacks, provided) => {
        if (config.id === 'parent') options = provided;
        else roots.push(cwd);
        return {
          id: 'synthetic-' + config.id,
          capabilities: syntheticCapabilities,
          prompt: async (input) => {
            if (config.id === 'parent') {
              parentPrompts++;
              parentStarted.resolve();
              await allowPrompt.promise;
              provided?.taskTools?.onPromptDispatch();
              await parentFinish.promise;
            } else {
              childPrompts++;
              assert.equal(input.prompt, '用户明确授权的合成子任务');
              callbacks.update({
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '合成子任务已开始' },
              });
              childStarted.resolve();
              await childFinish.promise;
            }
          },
          cancel: async () => {
            if (config.id === 'parent') parentFinish.resolve();
            else {
              childCancels++;
              childFinish.resolve();
            }
          },
          close: () => {
            if (config.id === 'parent') parentFinish.resolve();
            else childFinish.resolve();
          },
        };
      },
    },
    () => {},
    () => {},
  );
  const scope = {
    workspaceId: store.workspace.id,
    localProjectId: projectId,
    sessionId: 'parent-session',
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
  };
  const authority: TaskAuthorityLease = {
    serverOrigin: 'https://synthetic.invalid',
    ownerId: 'synthetic-owner',
    deviceId: 'synthetic-device',
    current() {
      assert.equal(online, true);
    },
  };
  const plan: TaskPlan = taskPlanSchema.parse({
    version: 1,
    tasks: [
      {
        taskId: 'task-one',
        title: '合成任务',
        agentId: 'child',
        instruction: '用户明确授权的合成子任务',
        completion: '操作者核对合成输出',
        baseBranch: 'main',
        expectedOid: oid,
      },
    ],
    maxParallel: 1,
    maxTurnsPerTask: 1,
    timeoutMs: 60000,
    onParentEnd: 'cancel',
  });
  await host.controlManager.control(
    {
      ...scope,
      controlVersion: 1,
      operationId: 'create-parent',
      action: 'create',
      agentId: 'parent',
    },
    projectId,
  );
  const mutation = async (extra: { taskPlan?: TaskPlan } = { taskPlan: plan }) =>
    buildSessionTurn({
      scope,
      read: await host.read(scope.sessionId, undefined, projectId),
      agent: host.workspace.agents.find((a) => a.id === 'parent')!,
      prompt: '协调已审查的有限任务',
      operationId: 'parent-send',
      turnId: 'parent-user',
      peerId: '1234567890abcdef',
      now: '2026-09-12T00:00:00.000Z',
      ...extra,
    });
  const read = () => {
    const request = {
      taskVersion: 1 as const,
      workspaceId: scope.workspaceId,
      localProjectId: projectId,
      sessionId: scope.sessionId,
    };
    return Promise.resolve(host.taskManager.read(request, projectId)).then((raw) =>
      validateTaskReadResult(raw, request),
    );
  };
  let rpcId = 0;
  async function rpc(method: string, params?: unknown) {
    assert.ok(options?.taskTools);
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        ...(method.startsWith('notifications/') ? {} : { id: ++rpcId }),
        method,
        ...(params ? { params } : {}),
      }),
    );
    return new Promise<any>((resolve, reject) => {
      const req = request(
        options!.taskTools!.url,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + options!.taskTools!.token,
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            'Content-Length': body.length,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, ...(text ? JSON.parse(text) : {}) });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }
  async function tool(name: string, args: object) {
    const result = await rpc('tools/call', { name, arguments: args });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.ok(!result.error, JSON.stringify(result));
    return JSON.parse(result.result.content[0].text);
  }
  t.after(async () => {
    allowPrompt.resolve();
    parentFinish.resolve();
    childFinish.resolve();
    await Promise.all([...host.active.values()].map((run) => run.done));
    host.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    host,
    store,
    scope,
    plan,
    authority,
    mutation,
    read,
    rpc,
    tool,
    parentStarted,
    parentFinish,
    childStarted,
    allowPrompt,
    roots,
    counts: () => ({ parentPrompts, childPrompts, childCancels }),
    options: () => options,
    disconnect: () => {
      online = false;
      host.taskManager.invalidateUnavailable();
    },
  };
}
test('parent acceptance atomically binds finite task plan and authority; failure rolls back grant and prevents Agent startup', async (t) => {
  const f = await fixture(t),
    original = await f.mutation();
  await assert.rejects(f.host.mutate(original, f.scope.localProjectId), /账号与设备连接/);
  assert.equal((await f.read()).grants.length, 0);
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_parent BEFORE INSERT ON session WHEN NEW.id='parent-session' BEGIN SELECT RAISE(ABORT,'synthetic-task-save-failure'); END",
  );
  await assert.rejects(
    f.host.mutate(original, f.scope.localProjectId, f.authority),
    /synthetic-task-save-failure/,
  );
  assert.equal((await f.read()).grants.length, 0);
  assert.deepEqual(f.counts(), { parentPrompts: 0, childPrompts: 0, childCancels: 0 });
  assert.equal(metas(f.host.meta)['session-parent-session'].latestUserMsgId, undefined);
});
test(
  'actual parent execution mounts scoped MCP only for its prompt; children run in isolated worktrees and parent completion cancels exact owned child',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      original = await f.mutation();
    assert.equal(
      (await f.host.mutate(original, f.scope.localProjectId, f.authority)).accepted,
      true,
    );
    await f.parentStarted.promise;
    const grant = (await f.read()).grants[0]!;
    const init = await f.rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'synthetic-parent', version: '1' },
    });
    assert.ok(init.result);
    assert.equal((await f.rpc('notifications/initialized')).status, 202);
    const early = await f.rpc('tools/call', {
      name: 'moor_task_create',
      arguments: { grantId: grant.grantId, taskId: 'task-one', operationId: 'create-task' },
    });
    assert.ok(early.error);
    assert.equal(
      f.store.journal.db.prepare('SELECT count(*) AS n FROM task_operation').get()?.n,
      0,
    );
    f.allowPrompt.resolve();
    await Promise.resolve();
    const created = await f.tool('moor_task_create', {
      grantId: grant.grantId,
      taskId: 'task-one',
      operationId: 'create-task',
    });
    assert.equal(created.state, 'accepted');
    assert.equal(f.counts().childPrompts, 0);
    const child = grant.tasks[0]!.childSessionId;
    const childRead = await f.host.read(child, undefined, f.scope.localProjectId);
    assert.equal((childRead.meta.taskOrigin as any).parentSessionId, f.scope.sessionId);
    assert.equal((childRead.meta.taskOrigin as any).grantId, grant.grantId);
    const sent = await f.tool('moor_task_send', {
      grantId: grant.grantId,
      taskId: 'task-one',
      operationId: 'send-task',
      expectedUserTurnId: null,
    });
    assert.equal(sent.state, 'accepted');
    await f.childStarted.promise;
    assert.equal(f.roots.length, 1);
    assert.notEqual(f.roots[0], f.host.active.get(f.scope.sessionId)!.rootPath);
    assert.equal((await f.read()).grants[0]!.tasks[0]!.goalVerified, false);
    assert.equal(
      (await f.host.mutate(original, f.scope.localProjectId, f.authority)).accepted,
      true,
    );
    assert.equal(f.counts().parentPrompts, 1);
    const raw = JSON.stringify(
      await f.host.read(f.scope.sessionId, undefined, f.scope.localProjectId),
    );
    assert.ok(!raw.includes(f.options()!.taskTools!.token));
    f.parentFinish.resolve();
    await f.host.active.get(f.scope.sessionId)!.done;
    assert.equal(f.counts().childCancels, 1);
    assert.equal(f.host.active.has(child), false);
    const ended = (await f.read()).grants[0]!;
    assert.equal(ended.state, 'canceled');
    assert.equal(ended.tasks[0]!.terminal, 'canceled');
  },
);
test('normal parent messages mount no task capability or grant', async (t) => {
  const f = await fixture(t);
  await f.host.mutate(await f.mutation({}), f.scope.localProjectId);
  await f.parentStarted.promise;
  assert.equal(f.options()?.taskTools, undefined);
  assert.equal((await f.read()).grants.length, 0);
  f.allowPrompt.resolve();
  f.parentFinish.resolve();
});

async function runningChild(f: Awaited<ReturnType<typeof fixture>>) {
  await f.host.mutate(await f.mutation(), f.scope.localProjectId, f.authority);
  f.allowPrompt.resolve();
  await f.parentStarted.promise;
  const grant = (await f.read()).grants[0]!;
  await f.rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'synthetic-parent', version: '1' },
  });
  await f.rpc('notifications/initialized');
  assert.equal(
    (
      await f.tool('moor_task_create', {
        grantId: grant.grantId,
        taskId: 'task-one',
        operationId: 'create-task',
      })
    ).state,
    'accepted',
  );
  assert.equal(
    (
      await f.tool('moor_task_send', {
        grantId: grant.grantId,
        taskId: 'task-one',
        operationId: 'send-task',
        expectedUserTurnId: null,
      })
    ).state,
    'accepted',
  );
  await f.childStarted.promise;
  const child = grant.tasks[0]!.childSessionId;
  return { grant, child, run: f.host.active.get(child)! };
}
for (const invalidation of ['project removed', 'connection lost'] as const)
  test(
    `grant revocation still stops its exact child after ${invalidation}`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        { grant, child, run } = await runningChild(f);
      if (invalidation === 'project removed') {
        f.store.machine.delete(['localProject', f.scope.localProjectId]);
        f.host.updateCatalogue();
      } else f.disconnect();
      await run.done;
      assert.equal(f.counts().childCancels, 1);
      assert.equal(f.host.active.has(child), false);
      assert.notEqual(f.store.tasks.grant(f.scope, grant.grantId).status, 'active');
      assert.throws(() => f.options()!.taskTools!.assertCurrent());
    },
  );

test(
  'internal task cancellation rejects stale turn and project identities',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      { child, run } = await runningChild(f),
      scope = { ...f.scope, sessionId: child };
    await f.host.cancelTaskTurn({ ...scope, userId: 'another-user' }, run.turnId, run.userTurnId);
    await f.host.cancelTaskTurn(scope, run.turnId, 'stale-user-turn');
    await f.host.cancelTaskTurn(scope, 'stale-assistant-turn', run.userTurnId);
    assert.equal(f.counts().childCancels, 0);
    assert.equal(f.host.active.get(child), run);
    await f.host.cancelTaskTurn(scope, run.turnId, run.userTurnId);
    assert.equal(f.counts().childCancels, 1);
    assert.equal(f.host.active.has(child), false);
  },
);

test(
  'host shutdown releases every Agent and tool capability even if grant and turn persistence fail',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await runningChild(f);
    const runs = [...f.host.active.values()];
    let closed = 0;
    for (const run of runs) {
      const original = run.session!.close.bind(run.session);
      run.session!.close = () => {
        closed++;
        return original();
      };
    }
    f.host.taskManager.close = () => {
      throw new Error('synthetic grant persistence failure');
    };
    f.host.finish = () => {
      throw new Error('synthetic turn persistence failure');
    };
    assert.doesNotThrow(() => f.host.close());
    assert.equal(closed, 2);
    assert.equal(f.host.closed, true);
    assert.equal(f.host.active.size, 0);
    assert.throws(() => f.options()!.taskTools!.assertCurrent());
    await Promise.all(runs.map((run) => run.done));
  },
);
