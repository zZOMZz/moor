import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '@moor/host/persistence/store';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { AppError } from '@moor/protocol/protocol';
import { metas } from '@moor/session/model';
import { CliState } from '../../apps/cli/src/state';
import { CliClient } from '../../apps/cli/src/client';
import { CliHttp } from '@moor/client/node/http';
import { buildSessionTurn } from '@moor/client/session-client';
import { SESSION_INTENTS_FEATURE } from '@moor/protocol/session-intent-protocol';
import { replicaBase } from '@moor/client/node/targets';
import {
  localCliProof,
  type LocalCliConnectionLease,
} from '@moor/protocol/node/local-cli-connection';
import { CliError, parseCliArgs } from '../../apps/cli/src/args';
import { syntheticCapabilities } from '../fixtures/agent-capabilities';
import type { AgentOpenOptions } from '@moor/host/agents/driver';
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-cli-client-'))),
    project = join(root, 'project');
  mkdirSync(project);
  const store = new RuntimeStore(join(root, 'host.sqlite')),
    projectId = store.registerProject(project);
  store.registerAgent('synthetic', {
    id: 'agent',
    name: 'Synthetic',
    machineId: store.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/never-run', args: ['PRIVATE_LAUNCH_ARGUMENT'] },
  });
  let opens = 0,
    prompts = 0,
    cancels = 0;
  let agentOptions: AgentOpenOptions | undefined;
  let completion = signal(),
    started = signal();
  const host = new HostWorkspace(
    store,
    {
      open: async (_agent, _cwd, _nativeId, _callbacks, options) => {
        agentOptions = options;
        opens++;
        return {
          id: 'native-' + opens,
          capabilities: syntheticCapabilities,
          prompt: async () => {
            prompts++;
            started.resolve();
            await completion.promise;
          },
          cancel: async () => {
            cancels++;
            completion.resolve();
          },
          close: () => completion.resolve(),
        };
      },
    },
    () => {},
    () => {},
  );
  const fault: {
    lost?: 'before' | 'after';
    reject?: boolean;
    retired?: boolean;
    wrongReceipt?: boolean;
    catalog?: string;
    device?: string;
    owner?: string;
    hung?: boolean;
    mutationHung?: boolean;
    proofHold?: () => Promise<void>;
    legacyHost?: boolean;
  } = {};
  const mutationEntered = signal();
  const requests: { path: string; body?: string }[] = [];
  const origin = 'https://synthetic.invalid';
  const fetcher = (async (url, init) => {
    const path = new URL(String(url)).pathname,
      body = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({ path, body });
    const data = body ? JSON.parse(body) : undefined;
    const runtime = {
      ...host.workspace,
      features: host.workspace.features?.filter(
        (feature) => !fault.legacyHost || feature !== SESSION_INTENTS_FEATURE,
      ),
    };
    if (path === '/api/local-instance') {
      const challenge = new URL(String(url)).searchParams.get('challenge')!;
      await fault.proofHold?.();
      return Response.json({
        instanceId: 'instance',
        challenge,
        proof: localCliProof('instance', challenge, 'a'.repeat(32)),
      });
    }
    if (path === '/api/login')
      return Response.json(
        { ok: true },
        { headers: { 'Set-Cookie': 'personal=' + 'a'.repeat(32) + '; HttpOnly' } },
      );
    if (path === '/api/logout') return Response.json({ ok: true });
    if (path === '/api/me') return Response.json({ owner: fault.owner ?? 'owner' });
    if (path === '/api/devices')
      return Response.json([
        { id: fault.device ?? 'device', name: 'Synthetic', online: true, workspaces: [runtime] },
      ]);
    if (path === '/api/workspaces')
      return Response.json([
        {
          id: fault.catalog ?? 'catalog',
          name: 'Synthetic',
          hosts: [
            {
              id: 'host',
              deviceId: fault.device ?? 'device',
              machineId: runtime.machineId,
              runtimeWorkspaceId: runtime.id,
              name: 'Synthetic',
              online: true,
              agents: runtime.agents,
            },
          ],
          projects: [{ id: 'logical', name: 'Project' }],
          replicas: [
            {
              id: 'replica',
              projectId: 'logical',
              hostId: 'host',
              localProjectId: projectId,
              available: true,
            },
          ],
        },
      ]);
    const suffix = path.split('/').slice(6).join('/');
    if (suffix === 'send-turn') mutationEntered.resolve();
    if (fault.hung || (fault.mutationHung && suffix === 'send-turn'))
      return new Promise<Response>(() => {});
    const writing = [
      'session-control',
      'mutations',
      'send-turn',
      'respond-permission',
      'session-actions',
    ].includes(suffix);
    if (writing && fault.retired)
      return Response.json(
        { rejected: true, error: '此功能已退场；仅可读取原记录，不会执行或改写原状态。' },
        { status: 410 },
      );
    if (writing && fault.reject)
      return Response.json({ rejected: true, error: 'SYNTHETIC_PRIVATE_ERROR' }, { status: 409 });
    if (writing && fault.lost === 'before') {
      fault.lost = undefined;
      throw new Error('synthetic lost before host');
    }
    let result: unknown;
    try {
      if (suffix === 'session-control') result = await host.controlManager.control(data, projectId);
      else if (suffix === 'session-operations')
        result = await host.controlManager.recover(data, projectId);
      else if (suffix === 'send-turn')
        result = await host.sendTurn(data, projectId, {
          serverOrigin: origin,
          ownerId: 'owner',
          deviceId: 'device',
          current() {
            assert.equal(fault.owner ?? 'owner', 'owner');
            assert.equal(fault.device ?? 'device', 'device');
          },
        });
      else if (suffix === 'respond-permission')
        result = await host.respondPermission(data, projectId, {
          serverOrigin: origin,
          ownerId: 'owner',
          deviceId: 'device',
          current() {
            assert.equal(fault.owner ?? 'owner', 'owner');
            assert.equal(fault.device ?? 'device', 'device');
          },
        });
      else if (suffix === 'mutations')
        result = await host.mutate(data, projectId, {
          serverOrigin: origin,
          ownerId: 'owner',
          deviceId: 'device',
          current() {
            assert.equal(fault.owner ?? 'owner', 'owner');
            assert.equal(fault.device ?? 'device', 'device');
          },
        });
      else if (suffix === 'mcp/read') result = host.readMcp(data, projectId);
      else if (suffix === 'session-actions') result = await host.sessionAction(data, projectId);
      else if (suffix === 'sessions')
        result = Object.values(metas(host.meta)).filter(
          (meta) => (meta.project as { localProjectId: string }).localProjectId === projectId,
        );
      else if (suffix.startsWith('sessions/'))
        result = await host.read(suffix.slice(9), undefined, projectId);
      else throw new Error('Unexpected request ' + path);
    } catch (error) {
      if (error instanceof AppError)
        return Response.json(
          { rejected: error.rejected, error: 'synthetic server failure' },
          { status: error.status },
        );
      throw error;
    }
    if (writing && fault.lost === 'after') {
      fault.lost = undefined;
      throw new Error('synthetic lost response');
    }
    if (writing && fault.wrongReceipt) {
      fault.wrongReceipt = false;
      result = { ...(result as object), operationId: 'wrong-operation' };
    }
    return Response.json(result);
  }) as typeof fetch;
  let state = new CliState(join(root, 'private')),
    text = '',
    clock = Date.parse('2026-09-12T01:00:00Z');
  const deadlines = new Map<number, ReturnType<typeof signal>>();
  const deadlineControllers: { ms: number; controller: AbortController }[] = [];
  const deps = {
    state,
    fetch: fetcher,
    stdin: {
      async *[Symbol.asyncIterator]() {
        yield text;
      },
    },
    now: () => clock,
    deadline: (ms: number) => {
      const controller = new AbortController();
      deadlineControllers.push({ ms, controller });
      deadlines.get(ms)?.resolve();
      return controller.signal;
    },
    pause: async (ms: number) => {
      clock += ms;
    },
  };
  let client = new CliClient(deps);
  const run = (argv: string[], input = '') => {
    text = input;
    return client.run(parseCliArgs(argv));
  };
  await run(
    ['auth', 'login', '--server', origin, '--stdin'],
    JSON.stringify({ email: 'synthetic@example.invalid', password: 'SYNTHETIC_PASSWORD' }),
  );
  await run(['targets', 'use', '--workspace', 'catalog', '--replica', 'replica']);
  t.after(async () => {
    completion.resolve();
    await Promise.all([...host.active.values()].map((run) => run.done));
    host.close();
    store.close();
    state.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    mutationEntered,
    fetcher,
    host,
    store,
    fault,
    requests,
    run,
    deadlineControllers,
    reachedDeadline: (ms: number) => {
      if (deadlineControllers.some((d) => d.ms === ms)) return Promise.resolve();
      let seen = deadlines.get(ms);
      if (!seen) {
        seen = signal();
        deadlines.set(ms, seen);
      }
      return seen.promise;
    },
    get state() {
      return state;
    },
    get client() {
      return client;
    },
    get agentOptions() {
      return agentOptions;
    },
    get started() {
      return started;
    },
    counts: () => ({ opens, prompts, cancels }),
    finish: async () => {
      completion.resolve();
      await Promise.all([...host.active.values()].map((run) => run.done));
    },
    next: () => {
      completion = signal();
      started = signal();
    },
    restart: () => {
      state.close();
      state = new CliState(join(root, 'private'));
      deps.state = state;
      client = new CliClient(deps);
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
test('CLI creates without Agent, builds host-accepted turn, waits, stops exact active turn and manages metadata', async (t) => {
  const f = await fixture(t),
    created = (await f.run(
      ['session', 'create', '--agent', 'agent', '--stdin'],
      '合成标题',
    )) as any;
  assert.equal(created.state, 'accepted');
  assert.deepEqual(f.counts(), { opens: 0, prompts: 0, cancels: 0 });
  const sessionId = created.target.sessionId;
  const send = (await f.run(['session', 'send', '--stdin'], '请保留中文 `text`')) as any;
  await f.started.promise;
  assert.equal(send.state, 'accepted');
  assert.equal(f.counts().prompts, 1);
  const active = f.host.active.get(sessionId)!;
  const stop = (await f.run(['session', 'stop', '--wait'])) as any;
  assert.equal(stop.operation.state, 'accepted');
  const stopBody = JSON.parse(
    f.requests.find((r) => r.body && JSON.parse(r.body).action === 'stop')!.body!,
  );
  assert.equal(stopBody.turnId, active.turnId);
  assert.equal(f.counts().cancels, 1);
  const read = (await f.run(['session', 'read'])) as any;
  assert.equal(read.meta.agentConfigId, 'agent');
  assert.ok(JSON.stringify(read.history).includes('请保留中文'));
  assert.ok(!JSON.stringify(read).includes('PRIVATE_LAUNCH_ARGUMENT'));
  for (const command of ['archive', 'restore', 'pin', 'unpin'])
    assert.equal(((await f.run(['session', command])) as any).state, 'accepted');
  assert.equal(
    ((await f.run(['session', 'rename', '--stdin'], '新标题')) as any).receipt.meta.title,
    '新标题',
  );
  assert.equal(((await f.run(['session', 'list'])) as any).sessions.length, 1);
  const config = await f.run(['config', 'show']);
  assert.ok(!JSON.stringify(config).includes('personal='));
  assert.ok(!JSON.stringify(config).includes('SYNTHETIC_PASSWORD'));
});
test('CLI rejects new per-turn MCP before storage or dispatch and can read an empty retired catalog', async (t) => {
  const f = await fixture(t);
  await f.run(['session', 'create', '--agent', 'agent']);
  const before = f.state.operations().length;
  assert.throws(
    () => f.run(['session', 'send', '--stdin', '--mcp-server-ids', 'old-version'], 'blocked'),
    /已退场/,
  );
  assert.equal(f.state.operations().length, before);
  assert.equal(f.counts().opens, 0);
  const result = (await f.run(['session', 'mcp'])) as any;
  assert.deepEqual(result.servers, []);
});
test('CLI retains explicit retirement errors and does not convert an older unknown original into a new rejection', async (t) => {
  const f = await fixture(t);
  await f.run(['session', 'create', '--agent', 'agent']);
  f.fault.retired = true;
  await assert.rejects(
    f.run(['session', 'send', '--stdin'], 'New explicit input'),
    (error: any) => error.code === 'retired' && error.exitCode === 5,
  );
  assert.equal(
    f.state.operations().find((operation) => operation.kind === 'send-turn')!.state,
    'rejected',
  );
  f.fault.retired = false;
  f.fault.lost = 'before';
  await assert.rejects(f.run(['session', 'send', '--stdin'], 'Older unknown input'));
  const original = f.state
    .operations()
    .find((operation) => operation.kind === 'send-turn' && operation.state === 'pending')!;
  f.fault.retired = true;
  await assert.rejects(
    f.run(['operation', 'retry', original.operationId]),
    (error: any) => error.code === 'retired' && error.exitCode === 6,
  );
  assert.deepEqual(f.state.operation(original.operationId), original);
  assert.equal(f.counts().opens, 0);
});
test('lost confirmation survives restart; inspect never dispatches, retry uses exact original bytes and original Agent', async (t) => {
  const f = await fixture(t);
  await f.run(['session', 'create', '--agent', 'agent']);
  f.fault.lost = 'after';
  await assert.rejects(
    f.run(['session', 'send', '--stdin'], 'frozen original'),
    (error) => error instanceof CliError && error.exitCode === 6,
  );
  await f.started.promise;
  const op = f.state.operations().find((op) => op.kind === 'send-turn')!;
  const originalBytes = op.body;
  f.restart();
  await f.run(['operation', 'list']);
  await f.run(['session', 'read']);
  assert.equal(f.requests.filter((r) => r.path.endsWith('/send-turn')).length, 1);
  f.fault.catalog = 'moved-catalog';
  await f.run(['operation', 'retry', op.operationId]);
  const mutations = f.requests.filter((r) => r.path.endsWith('/send-turn'));
  assert.equal(mutations.length, 2);
  assert.equal(mutations[1]!.body, originalBytes);
  assert.ok(mutations[1]!.path.includes('moved-catalog'));
  assert.equal(f.counts().prompts, 1);
  await f.run(['operation', 'inspect', op.operationId]);
  assert.equal(f.requests.filter((r) => r.path.endsWith('/send-turn')).length, 2);
  await f.finish();
});
test('undelivered unknown can be explicitly sealed; rejected retry and wrong receipt keep original pending', async (t) => {
  const f = await fixture(t);
  await f.run(['session', 'create', '--agent', 'agent']);
  f.fault.lost = 'before';
  await assert.rejects(f.run(['session', 'send', '--stdin'], 'unreceived'), /原请求/);
  let op = f.state.operations().find((op) => op.kind === 'send-turn')!;
  f.fault.reject = true;
  await assert.rejects(f.run(['operation', 'retry', op.operationId]));
  f.restart();
  assert.equal(f.state.operation(op.operationId)?.state, 'pending');
  f.fault.reject = false;
  const inspected = (await f.run(['operation', 'inspect', op.operationId])) as any;
  assert.equal(inspected.inspection.found, false);
  assert.equal(f.counts().prompts, 0);
  const ended = (await f.run(['operation', 'abandon', op.operationId])) as any;
  assert.equal(ended.state, 'abandoned');
  assert.equal(f.counts().prompts, 0);
  const request = JSON.parse(op.body);
  assert.equal((await f.host.sendTurn(request, f.state.target()!.localProjectId)).abandoned, true);
  f.fault.wrongReceipt = true;
  await assert.rejects(f.run(['session', 'send', '--stdin'], 'second'));
  await f.started.promise;
  op = f.state.operations().find((op) => op.kind === 'send-turn' && op.state === 'pending')!;
  assert.ok(op);
  await f.run(['operation', 'inspect', op.operationId]);
  assert.equal(f.state.operation(op.operationId)?.state, 'accepted');
  assert.equal(f.counts().prompts, 1);
});
test('first definite rejection permits new stage; a different device cannot recover or receive original bytes', async (t) => {
  const f = await fixture(t);
  await f.run(['session', 'create', '--agent', 'agent']);
  f.fault.reject = true;
  await assert.rejects(
    f.run(['session', 'send', '--stdin'], 'rejected'),
    (error) => error instanceof CliError && error.exitCode === 5,
  );
  assert.equal(f.state.operations()[0]!.state, 'rejected');
  f.fault.reject = false;
  f.fault.lost = 'before';
  await assert.rejects(f.run(['session', 'send', '--stdin'], 'original'));
  const op = f.state.operations()[0]!,
    count = f.requests.filter((r) => r.body?.includes(op.operationId)).length;
  f.fault.device = 'another-device';
  await assert.rejects(f.run(['operation', 'retry', op.operationId]));
  assert.equal(f.requests.filter((r) => r.body?.includes(op.operationId)).length, count);
  assert.equal(f.state.operation(op.operationId)?.state, 'pending');
});
test('wait timeout or explicit abort never stops or sends; HTTP deadline keeps a staged action unknown', async (t) => {
  const f = await fixture(t);
  await f.run(['session', 'create', '--agent', 'agent']);
  await f.run(['session', 'send', '--stdin'], 'working');
  await f.started.promise;
  await assert.rejects(
    f.run(['session', 'read', '--wait', '--timeout', '3']),
    (error) => error instanceof CliError && error.exitCode === 7,
  );
  assert.equal(f.counts().cancels, 0);
  assert.equal(f.counts().prompts, 1);
  await f.finish();
  f.fault.hung = true;
  const pending = f.run(['session', 'read', '--wait', '--timeout', '9']);
  // Resolve deterministic promise boundaries until the read fetch has registered its deadline.
  await f.reachedDeadline(9);
  f.deadlineControllers.find((d) => d.ms === 9)!.controller.abort();
  await assert.rejects(pending, (error) => error instanceof CliError && error.exitCode === 7);
  assert.equal(f.counts().cancels, 0);
});

test('proof-await ending from another CLI prevents the staged request from being dispatched', async (t) => {
  const f = await fixture(t),
    workspace = f.host.workspace,
    target = {
      ...f.state.target()!,
      serverKey: 'local:' + workspace.machineId,
      sessionId: 'local-new',
    };
  const op = f.state.stage({
    operationId: 'local-op',
    kind: 'create',
    target,
    path: '/api/workspaces/catalog/replicas/replica/session-control',
    body: JSON.stringify({
      controlVersion: 1,
      userId: workspace.userId,
      machineId: workspace.machineId,
      workspaceId: workspace.id,
      localProjectId: target.localProjectId,
      sessionId: 'local-new',
      operationId: 'local-op',
      action: 'create',
      agentId: 'agent',
    }),
  });
  const local: LocalCliConnectionLease = {
    connection: {
      version: 1,
      instanceId: 'instance',
      origin: 'http://127.0.0.1:12345',
      secret: 'a'.repeat(32),
      ownerId: 'owner',
      deviceId: 'device',
      runtimeWorkspaceId: workspace.id,
      machineId: workspace.machineId,
      userId: workspace.userId,
    },
    assertCurrent() {},
  };
  const proofStarted = signal(),
    release = signal();
  let proofs = 0;
  f.fault.proofHold = async () => {
    if (++proofs === 4) {
      proofStarted.resolve();
      await release.promise;
    }
  };
  const http = new CliHttp(
    {
      origin: local.connection.origin,
      cookie: 'personal=' + local.connection.secret,
      owner: 'owner',
    },
    { local, fetch: f.fetcher },
  );
  const pending = f.client.deliver(http, op);
  await proofStarted.promise;
  const other = new CliState(join(f.root, 'private'));
  other.transition(op.operationId, ['pending'], 'ending');
  other.close();
  release.resolve();
  await assert.rejects(pending);
  assert.equal(f.requests.filter((r) => r.path.endsWith('/session-control')).length, 0);
  assert.equal(f.state.operation(op.operationId)?.state, 'ending');
  assert.equal(f.counts().opens, 0);
});
test('waiting for a completed original turn is not extended by a later turn from another client', async (t) => {
  const f = await fixture(t);
  await f.run(['session', 'create', '--agent', 'agent']);
  await f.run(['session', 'send', '--stdin'], 'original');
  await f.started.promise;
  const sessionId = f.state.target()!.sessionId!,
    original = f.host.active.get(sessionId)!.userTurnId;
  await f.finish();
  f.next();
  await f.run(['session', 'send', '--stdin'], 'later');
  await f.started.promise;
  const http = await f.client.http(parseCliArgs(['session', 'read'])),
    result = await f.client.wait(
      http,
      f.state.target()!,
      parseCliArgs(['session', 'read', '--wait', '--timeout', '1']),
      original,
    );
  assert.equal(result.waited, true);
  assert.ok(f.host.active.has(sessionId));
  assert.equal(f.counts().cancels, 0);
});
test('a timed out mutation retains its exact outbox bytes and does not cancel the active turn', async (t) => {
  const f = await fixture(t);
  await f.run(['session', 'create', '--agent', 'agent']);
  f.fault.mutationHung = true;
  const before = f.deadlineControllers.length,
    waiting = f.run(['session', 'send', '--stdin'], 'timeout original');
  // The HTTP fixture itself reports entry, so no wall-clock sleeps are used.
  await f.mutationEntered.promise;
  f.deadlineControllers.at(-1)!.controller.abort();
  await assert.rejects(waiting, (error) => error instanceof CliError && error.exitCode === 6);
  const op = f.state.operations().find((op) => op.kind === 'send-turn')!;
  assert.equal(op.state, 'pending');
  assert.ok(op.body.includes(op.operationId));
  assert.equal(f.requests.filter((r) => r.path.endsWith('/send-turn')).length, 1);
  assert.ok(f.deadlineControllers.length > before);
  assert.equal(f.counts().cancels, 0);
});

test('new CLI sends persist semantic bodies and reject a Host without the new feature before staging', async (t) => {
  const f = await fixture(t);
  await f.run(['session', 'create', '--agent', 'agent']);
  f.fault.legacyHost = true;
  const before = f.state.operations().length;
  await assert.rejects(
    f.run(['session', 'send', '--stdin'], 'Must stay local'),
    (error: any) => error.code === 'unsupported',
  );
  assert.equal(f.state.operations().length, before);
  assert(
    !f.requests.some(
      (request) => request.path.endsWith('/mutations') || request.path.endsWith('/send-turn'),
    ),
  );
  f.fault.legacyHost = false;
  f.fault.lost = 'before';
  await assert.rejects(f.run(['session', 'send', '--stdin'], 'Frozen typed input'));
  const original = f.state.operations().find((operation) => operation.kind === 'send-turn')!;
  const body = JSON.parse(original.body);
  assert.equal(body.intentVersion, 1);
  assert.equal(body.prompt, 'Frozen typed input');
  assert.equal(body.localProjectId, original.target.localProjectId);
  assert.equal(body.userId, original.target.userId);
  assert.equal(body.machineId, original.target.machineId);
  assert(!('update' in body) && !('meta' in body));
  f.restart();
  assert.deepEqual(f.state.operation(original.operationId), original);
  await f.run(['operation', 'retry', original.operationId]);
  await f.started.promise;
  assert.equal(
    f.requests.filter((request) => request.path.endsWith('/send-turn')).at(-1)!.body,
    original.body,
  );
  const confirmed = f.state.operation(original.operationId)!;
  assert.equal(confirmed.path, original.path);
  assert.equal(confirmed.requestVersion, original.requestVersion);
});

test('cold CLI recovery preserves an old Mutation body, fingerprint and saved path without converting it to an intent', async (t) => {
  const f = await fixture(t);
  await f.run(['session', 'create', '--agent', 'agent']);
  const target = { ...f.state.target()!, sessionId: f.state.target()!.sessionId! };
  const read = await f.host.read(target.sessionId, undefined, target.localProjectId);
  const value = buildSessionTurn({
    scope: target,
    read,
    agent: read.agent!,
    prompt: 'Old explicitly submitted work',
    selection: {},
    operationId: 'old-client-operation',
    turnId: 'old-user-turn',
    peerId: 'old-client-peer',
    now: '2026-09-22T00:00:00.000Z',
  });
  const op = f.state.stage({
    operationId: value.operationId,
    kind: 'turn',
    target,
    path: replicaBase(target) + '/mutations',
    body: JSON.stringify(value, null, 2),
  });
  f.restart();
  await f.run(['operation', 'list']);
  await f.run(['session', 'read']);
  assert.deepEqual(f.state.operation(op.operationId), op);
  assert.equal(f.counts().prompts, 0);
  await f.run(['operation', 'retry', op.operationId]);
  await f.started.promise;
  const sent = f.requests.filter((request) => request.path.endsWith('/mutations'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body, op.body);
  assert(!f.requests.some((request) => request.path.endsWith('/send-turn')));
  const done = f.state.operation(op.operationId)!;
  assert.equal(done.kind, 'turn');
  assert.equal(done.body, op.body);
  assert.equal(done.path, op.path);
  assert.equal(done.requestVersion, op.requestVersion);
});
