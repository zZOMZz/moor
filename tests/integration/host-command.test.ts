import { cases, scope, operationId } from '../fixtures/host-command-cases';
import { assertHostCommandActive, hostCommandFeatures } from '@moor/protocol/host-command-contract';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  HOST_COMMAND_METHODS,
  hostCommandSchemas,
  hostCommandSchema,
  HostCommandDispatcher,
  type HostCommandInput,
  type HostCommandMethod,
  type HostCommandWorkspace,
} from '@moor/host/commands/host-command';
import { AppError } from '@moor/protocol/protocol';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { RuntimeStore } from '@moor/host/persistence/store';
import { buildSessionTurn } from '@moor/client/session-client';
import { syntheticCapabilities } from '../fixtures/agent-capabilities';
import type { AgentOpenOptions } from '@moor/host/agents/driver';

function fixture() {
  const calls: { method: string; args: unknown[] }[] = [];
  const result = { sentinel: 'same host result' };
  const receiver = (prefix = '') =>
    new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'closed') return closed;
          if (key === 'workspace')
            return {
              id: scope.workspaceId,
              name: 'Synthetic',
              userId: 'user',
              machineId: 'machine',
              projects: [{ id: scope.localProjectId, name: 'Synthetic', rootPath: '/synthetic' }],
              agents: [],
              features: ['session-page-v1'],
            };
          if (key === 'controlManager') return receiver(String(key) + '.');
          return (...args: unknown[]) => {
            calls.push({ method: prefix + String(key), args });
            return result;
          };
        },
      },
    );
  const workspace = receiver() as HostCommandWorkspace;
  const known = new Set<string>();
  let ready = true,
    closed = false;
  const dispatcher = new HostCommandDispatcher({
    ready: () => ready,
    workspace: (id) => (id === scope.workspaceId ? workspace : undefined),
    hasOperation: (id) => known.has(id),
  });
  return {
    dispatcher,
    calls,
    result,
    known,
    unavailable() {
      ready = false;
    },
    close() {
      closed = true;
    },
  };
}
const envelope = (method: HostCommandMethod, params: unknown = cases[method].params) => ({
  method,
  workspaceId: scope.workspaceId,
  localProjectId: scope.localProjectId,
  params,
});
const status = (code: number) => (error: unknown) =>
  error instanceof AppError && error.status === code;

test('all 45 commands preserve the exact delegate, parsed payload, project and authority', async () => {
  assert.equal(HOST_COMMAND_METHODS.length, 45);
  assert.equal(new Set(HOST_COMMAND_METHODS).size, 45);
  assert.deepEqual(Object.keys(hostCommandSchemas).sort(), Object.keys(cases).sort());
  const f = fixture();
  const authority = {
    serverOrigin: 'https://synthetic.invalid',
    ownerId: 'owner',
    deviceId: 'device',
    current() {},
  };
  const checkpoint = () => {};
  for (const method of HOST_COMMAND_METHODS) {
    const { call } = cases[method];
    const params = hostCommandSchemas[method].parse(cases[method].params);
    if (['preview-read', 'preview-action', 'preview-close'].includes(method)) {
      const before = f.calls.length;
      await assert.rejects(f.dispatcher.execute(envelope(method)), status(410));
      assert.equal(f.calls.length, before);
      continue;
    }
    assert.equal(
      await f.dispatcher.execute(envelope(method), { authority, current: checkpoint }),
      f.result,
      method,
    );
    const expected =
      method === 'sessions'
        ? [scope.localProjectId]
        : method === 'agent-options'
          ? ['agent', scope.localProjectId, 'session', 'synthetic-model', undefined]
          : method === 'session'
            ? ['session', 'YQ==', scope.localProjectId]
            : method === 'cancel'
              ? ['session', 'turn', scope.localProjectId]
              : method === 'mutate' ||
                  method === 'send-turn' ||
                  method === 'respond-permission' ||
                  method.startsWith('preview-')
                ? [params, scope.localProjectId, authority]
                : method.startsWith('github-') ||
                    method.startsWith('git-') ||
                    method.startsWith('fork-')
                  ? [params, scope.localProjectId, checkpoint]
                  : [params, scope.localProjectId];
    assert.deepEqual(f.calls.pop(), { method: call, args: expected }, method);
  }
});

test('strict outer and every params schema reject malformed commands before any delegate executes', async () => {
  const f = fixture();
  for (const raw of [
    null,
    [],
    {},
    { ...envelope('sessions'), workspaceId: '../bad' },
    { ...envelope('sessions'), localProjectId: null },
    { ...envelope('sessions'), authorityOwner: 'untrusted-owner' },
    { ...envelope('sessions'), unknown: true },
  ]) {
    await assert.rejects(f.dispatcher.execute(raw), z.ZodError);
  }
  for (const method of HOST_COMMAND_METHODS)
    await assert.rejects(f.dispatcher.execute(envelope(method, null)), z.ZodError, method);
  await assert.rejects(
    f.dispatcher.execute({ ...envelope('sessions'), method: 'raw-shell' }),
    status(400),
  );
  assert.equal(
    hostCommandSchema.safeParse({ ...envelope('sessions'), method: 'raw-shell' }).success,
    false,
  );
  assert.equal(f.calls.length, 0);
});

test('legacy sessions, agent options, session version and cancel now enforce the existing HTTP input boundaries', async () => {
  const f = fixture();
  for (const [method, params] of [
    ['sessions', { ignoredBefore: true }],
    ['agent-options', {}],
    ['agent-options', { agentId: '../invalid' }],
    ['agent-options', { agentId: 'agent', sessionId: 4 }],
    ['session', { sessionId: 'session', version: 'not base64' }],
    ['session', { sessionId: 'session', version: 'YQ=='.repeat(16385) }],
    ['cancel', { sessionId: 'session' }],
    ['cancel', { sessionId: 'session', turnId: 'turn', force: true }],
  ] as const)
    await assert.rejects(f.dispatcher.execute(envelope(method, params)), z.ZodError);
  assert.equal(f.calls.length, 0);
  await f.dispatcher.execute(
    envelope('session', { sessionId: 'session', version: 'AAAA'.repeat(16384) }),
  );
  assert.equal(f.calls.length, 1);
  const search = { ...cases['search-sessions'].params };
  delete search.limit;
  await f.dispatcher.execute(envelope('search-sessions', search));
  assert.equal((f.calls.at(-1)!.args[0] as { limit: number }).limit, 30);
});

test('direct and nested workspace mismatches, unavailable workspaces and rejected entry guards never execute', async () => {
  const f = fixture();
  for (const method of [
    'mcp-read',
    'file-content',
    'send-turn',
    'respond-permission',
    'mutate',
    'preview-action',
    'github-write-action',
  ] as const) {
    await assert.rejects(
      f.dispatcher.execute(envelope(method, { ...cases[method].params, workspaceId: 'other' })),
      status(method === 'preview-action' ? 410 : 400),
    );
  }
  for (const method of [
    'preview-inspect',
    'preview-close',
    'github-write-inspect',
    'github-write-abandon',
  ] as const) {
    const params = cases[method].params;
    await assert.rejects(
      f.dispatcher.execute(
        envelope(method, { ...params, request: { ...params.request, workspaceId: 'other' } }),
      ),
      status(method === 'preview-close' ? 410 : 400),
    );
  }
  await assert.rejects(
    f.dispatcher.execute({ ...envelope('sessions'), workspaceId: 'missing' }),
    status(409),
  );
  await assert.rejects(
    f.dispatcher.execute(envelope('sessions'), {
      current() {
        throw new AppError(403, 'scope revoked');
      },
    }),
    status(403),
  );
  f.unavailable();
  await assert.rejects(f.dispatcher.execute(envelope('sessions')), status(409));
  const closed = fixture();
  closed.close();
  await assert.rejects(closed.dispatcher.execute(envelope('sessions')), status(409));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(closed.calls, []);
});

test('safe errors preserve journal rejection evidence for legacy and typed session commands and never mark unknown operations delivered', () => {
  const f = fixture();
  const rejected = new Set([
    'send-turn',
    'respond-permission',
    'mutate',
    'session-action',
    'attachment-action',
    'git-action',
    'fork-action',
    'github-action',
    'github-abandon',
    'github-write-action',
    'preview-action',
  ]);
  for (const method of HOST_COMMAND_METHODS) {
    const raw = envelope(method, { operationId });
    assert.deepEqual(f.dispatcher.error(raw, new Error('synthetic private diagnostic')), {
      status: 502,
      message: '本地主机处理失败',
      rejected: rejected.has(method),
    });
    f.known.add(operationId);
    assert.equal(f.dispatcher.error(raw, new Error('unknown delivery')).rejected, false);
    f.known.clear();
    assert.deepEqual(f.dispatcher.error(raw, new AppError(409, 'fixed rejection', true)), {
      status: 409,
      message: 'fixed rejection',
      rejected: true,
    });
  }
  for (const raw of [
    null,
    {},
    envelope('mutate', { operationId: 1 }),
    envelope('preview-close', { request: { operationId } }),
  ])
    assert.equal(f.dispatcher.error(raw, new Error()).rejected, false);
});

test('real Host keeps project and connection checks, rejects retired MCP, and runs one explicit ordinary prompt', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-command-host-')));
  const store = new RuntimeStore(':memory:'),
    project = store.registerProject(root);
  const agent = store.registerAgent('synthetic', {
    id: 'synthetic-agent',
    name: 'Synthetic',
    machineId: store.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/never-run', args: [] },
  });
  let opens = 0,
    prompts = 0,
    options: AgentOpenOptions | undefined;
  let started!: () => void;
  const prompted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const host = new HostWorkspace(
    store,
    {
      async open(_agent, _cwd, _native, _callbacks, input) {
        opens++;
        options = input;
        return {
          id: 'synthetic-native',
          capabilities: syntheticCapabilities,
          async prompt() {
            prompts++;
            started();
          },
          async cancel() {},
          close() {},
        };
      },
    },
    () => {},
    () => {},
  );
  t.after(async () => {
    await Promise.allSettled([...host.active.values()].map((run) => run.done));
    host.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const method of HOST_COMMAND_METHODS) {
    const command = hostCommandSchema.parse(envelope(method));
    try {
      assertHostCommandActive(command);
    } catch (error) {
      assert(status(410)(error));
      continue;
    }
    for (const feature of hostCommandFeatures(command))
      assert(host.workspace.features?.includes(feature), method + ': Host capability omitted');
  }
  const dispatcher = new HostCommandDispatcher({
    ready: () => true,
    workspace: (id) => (id === host.workspace.id ? host : undefined),
    hasOperation: (id) => store.journal.has(id),
  });
  const localScope = {
    workspaceId: host.workspace.id,
    userId: host.workspace.userId,
    machineId: host.workspace.machineId,
    localProjectId: project,
    sessionId: 'synthetic-session',
  };
  const command = (method: HostCommandMethod, params: unknown) => ({
    method,
    workspaceId: host.workspace.id,
    localProjectId: project,
    params,
  });
  await dispatcher.execute(
    command('session-control', {
      ...localScope,
      controlVersion: 1,
      operationId: 'create',
      action: 'create',
      agentId: agent.id,
    }),
  );
  const request = {
    workspaceId: localScope.workspaceId,
    localProjectId: project,
    sessionId: localScope.sessionId,
    mcpVersion: 1,
  };
  await dispatcher.execute(command('mcp-read', request));
  await assert.rejects(
    dispatcher.execute({ ...command('mcp-read', request), localProjectId: 'other' }),
    status(400),
  );
  assert.equal(opens, 0);
  const turn = buildSessionTurn({
    scope: localScope,
    read: await dispatcher.execute(command('session', { sessionId: localScope.sessionId })),
    agent: host.workspace.agents[0]!,
    prompt: 'Explicit synthetic instruction',
    operationId: 'send-original',
    turnId: 'user-original',
    peerId: 'abcd1234',
    now: '2026-09-13T00:00:00.000Z',
  });
  const extras = buildSessionTurn({
    scope: localScope,
    read: await dispatcher.execute(command('session', { sessionId: localScope.sessionId })),
    agent: host.workspace.agents[0]!,
    prompt: 'Retired extras',
    operationId: 'retired-extra',
    turnId: 'retired-extra-turn',
    peerId: '77',
    now: '2026-09-13T00:00:00.000Z',
    mcpServerIds: ['mcpv_' + '1'.repeat(32)],
  });
  await assert.rejects(dispatcher.execute(command('mutate', extras)), status(410));
  const authority = {
    serverOrigin: 'https://synthetic.invalid',
    ownerId: 'owner',
    deviceId: 'device',
    current() {
      throw new AppError(409, 'original connection revoked');
    },
  };
  await assert.rejects(
    dispatcher.execute(command('mutate', turn), { authority }),
    /original connection revoked/,
  );
  assert.equal(opens, 0);
  assert.equal(store.journal.has('send-original'), false);
  let checks = 0;
  const accepted = await dispatcher.execute(command('mutate', turn), {
    authority: {
      ...authority,
      current() {
        checks++;
      },
    },
  });
  assert.deepEqual(accepted, { accepted: true, delivered: true, operationId: 'send-original' });
  await prompted;
  await Promise.all([...host.active.values()].map((run) => run.done));
  assert.equal(prompts, 1);
  assert.equal(opens, 1);
  assert.ok(checks > 1);
  assert.equal(options, undefined);
  assert.equal(store.journal.has('send-original'), true);
  assert.equal(dispatcher.error(command('mutate', turn), new Error('unknown')).rejected, false);
});
