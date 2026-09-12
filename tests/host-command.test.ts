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
} from '../src/bridge/host-command';
import { AppError } from '../src/protocol';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { buildSessionTurn } from '../src/session-client';
import { syntheticCapabilities } from './support/agent-capabilities';
import type { AgentOpenOptions } from '../src/runtime/agent';

const scope = { workspaceId: 'workspace', localProjectId: 'project', sessionId: 'session' };
const version = 'sha256:' + '1'.repeat(64);
const operationId = 'original-operation';
const control = {
  ...scope,
  userId: 'user',
  machineId: 'machine',
  controlVersion: 1 as const,
  action: 'create' as const,
  operationId,
  agentId: 'agent',
};
const preview = {
  ...scope,
  previewVersion: 1 as const,
  clientId: 'client',
  operationId,
  confirmed: true as const,
  action: 'open' as const,
  serviceId: 'service',
  serviceVersion: version,
  executionRevision: 0,
  viewport: { width: 390, height: 800 },
};
const githubWrite = {
  ...scope,
  githubWriteVersion: 1 as const,
  operationId,
  confirmed: true as const,
  action: 'issue-comment' as const,
  repositoryId: 1,
  configVersion: version,
  expectedBindingRevision: 0,
  subject: 'issue' as const,
  number: 1,
  expectedVersion: version,
  body: 'Synthetic comment',
};
const github = {
  ...scope,
  githubVersion: 1 as const,
  operationId,
  expectedRevision: 0,
  action: 'unbind' as const,
};
const cases: {
  [M in HostCommandMethod]: {
    params: Extract<HostCommandInput, { method: M }>['params'];
    call: string;
  };
} = {
  sessions: { params: {}, call: 'list' },
  'agent-options': {
    params: { agentId: 'agent', sessionId: 'session' },
    call: 'refreshAgentOptions',
  },
  session: { params: { sessionId: 'session', version: 'YQ==' }, call: 'read' },
  'roles-read': { params: { ...scope, rolesVersion: 1 }, call: 'readRoles' },
  'mcp-read': { params: { ...scope, mcpVersion: 1 }, call: 'readMcp' },
  'session-control': { params: control, call: 'controlManager.control' },
  'session-operations': {
    params: {
      ...scope,
      userId: 'user',
      machineId: 'machine',
      controlVersion: 1,
      action: 'inspect',
      request: { kind: 'control', value: control },
    },
    call: 'controlManager.recover',
  },
  'tasks-read': { params: { ...scope, taskVersion: 1 }, call: 'taskManager.read' },
  'tasks-action': {
    params: { ...scope, taskVersion: 1, grantId: 'grant', operationId, action: 'inspect' },
    call: 'taskManager.action',
  },
  'roles-action': {
    params: {
      ...scope,
      rolesVersion: 1,
      operationId,
      expectedRevision: 0,
      action: 'remove',
      id: 'role',
    },
    call: 'roleAction',
  },
  'skills-read': { params: { ...scope, skillsVersion: 1, view: 'list' }, call: 'readSkills' },
  'preview-read': { params: { ...scope, previewVersion: 1, view: 'options' }, call: 'readPreview' },
  'preview-action': { params: preview, call: 'previewAction' },
  'preview-inspect': { params: { request: preview }, call: 'inspectPreview' },
  'preview-close': { params: { request: preview }, call: 'closePreview' },
  'github-write-read': {
    params: { ...scope, githubWriteVersion: 1, view: 'overview' },
    call: 'readGithubWrite',
  },
  'github-write-action': { params: githubWrite, call: 'githubWriteAction' },
  'github-write-inspect': { params: { request: githubWrite, page: 1 }, call: 'inspectGithubWrite' },
  'github-write-abandon': { params: { request: githubWrite }, call: 'abandonGithubWrite' },
  'github-read': { params: { ...scope, githubVersion: 1, view: 'overview' }, call: 'readGithub' },
  'github-action': { params: github, call: 'githubAction' },
  'github-abandon': { params: github, call: 'abandonGithub' },
  mutate: {
    params: {
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      operationId,
      kind: 'turn',
      expectedTurnId: null,
      update: 'YQ==',
    },
    call: 'mutate',
  },
  'session-action': {
    params: { ...scope, operationId, expectedRevision: 0, action: 'pin' },
    call: 'sessionAction',
  },
  'file-content': {
    params: { ...scope, contentVersion: 1, path: 'synthetic.txt' },
    call: 'readProjectFile',
  },
  'attachment-action': {
    params: {
      ...scope,
      contentVersion: 1,
      operationId,
      action: 'remove',
      attachmentId: 'attachment',
    },
    call: 'attachmentAction',
  },
  'read-attachment': {
    params: { ...scope, contentVersion: 1, attachmentId: 'attachment' },
    call: 'readAttachment',
  },
  'read-project-tree': { params: { ...scope, contentVersion: 1 }, call: 'readProjectTree' },
  'read-turn-diff': {
    params: { ...scope, contentVersion: 1, turnId: 'turn' },
    call: 'readTurnDiff',
  },
  'read-diff-file': {
    params: { ...scope, contentVersion: 1, turnId: 'turn', path: 'synthetic.txt' },
    call: 'readDiffFile',
  },
  'answer-question': {
    params: {
      ...scope,
      expectedTurnId: 'turn',
      interactionVersion: 1,
      operationId,
      requestId: 'request',
      answer: { action: 'decline' },
    },
    call: 'answerQuestion',
  },
  steer: {
    params: { ...scope, expectedTurnId: 'turn', operationId, prompt: 'Synthetic steering' },
    call: 'steer',
  },
  'search-sessions': {
    params: { ...scope, searchVersion: 1, scope: 'session', query: 'synthetic', limit: 30 },
    call: 'searchSessions',
  },
  'git-state': { params: { ...scope, gitVersion: 1 }, call: 'readGitState' },
  'git-action': {
    params: {
      ...scope,
      gitVersion: 1,
      operationId,
      expectedRevision: 0,
      action: 'detach',
      executionId: 'execution',
    },
    call: 'gitAction',
  },
  'fork-options': { params: { ...scope, forkVersion: 1 }, call: 'readForkOptions' },
  'fork-action': {
    params: {
      ...scope,
      forkVersion: 1,
      operationId,
      childSessionId: 'child',
      expectedSourceVersion: version,
      expectedExecutionRevision: 0,
      cutoff: { kind: 'current' },
      directory: { kind: 'same-directory' },
    },
    call: 'forkSession',
  },
  cancel: { params: { sessionId: 'session', turnId: 'turn' }, call: 'cancel' },
};
function fixture() {
  const calls: { method: string; args: unknown[] }[] = [];
  const result = { sentinel: 'same host result' };
  const receiver = (prefix = '') =>
    new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'closed') return closed;
          if (key === 'controlManager' || key === 'taskManager') return receiver(String(key) + '.');
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

test('all 38 commands preserve the exact delegate, parsed payload, project and authority', async () => {
  assert.equal(HOST_COMMAND_METHODS.length, 38);
  assert.equal(new Set(HOST_COMMAND_METHODS).size, 38);
  assert.deepEqual(Object.keys(hostCommandSchemas).sort(), Object.keys(cases).sort());
  const f = fixture();
  const authority = {
    serverOrigin: 'https://synthetic.invalid',
    ownerId: 'owner',
    deviceId: 'device',
    current() {},
  };
  for (const method of HOST_COMMAND_METHODS) {
    const { params, call } = cases[method];
    assert.equal(await f.dispatcher.execute(envelope(method), { authority }), f.result, method);
    const expected =
      method === 'sessions'
        ? [scope.localProjectId]
        : method === 'agent-options'
          ? ['agent', scope.localProjectId, 'session']
          : method === 'session'
            ? ['session', 'YQ==', scope.localProjectId]
            : method === 'cancel'
              ? ['session', 'turn', scope.localProjectId]
              : method === 'mutate'
                ? [params, scope.localProjectId, authority]
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
    'mutate',
    'preview-action',
    'github-write-action',
  ] as const) {
    await assert.rejects(
      f.dispatcher.execute(envelope(method, { ...cases[method].params, workspaceId: 'other' })),
      status(400),
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
      status(400),
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

test('safe errors preserve precisely the existing nine journal rejection fallbacks and never mark unknown operations delivered', () => {
  const f = fixture();
  const rejected = new Set([
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

test('real Host keeps project and MCP authority checks through dispatch, with one explicit synthetic prompt only', async (t) => {
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
  const config = await host.mcpSettings.handle({
    action: 'save',
    expectedRevision: 0,
    name: 'Synthetic',
    description: '',
    projectIds: [project],
    enabled: true,
    connection: { transport: 'http', url: 'https://synthetic.invalid/mcp', headers: {} },
  });
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
    mcpServerIds: [config.presets[0]!.versionId],
  });
  await assert.rejects(dispatcher.execute(command('mutate', turn)), status(409));
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
  assert.equal(options?.mcp?.servers.length, 1);
  assert.equal(store.journal.has('send-original'), true);
  assert.equal(dispatcher.error(command('mutate', turn), new Error('unknown')).rejected, false);
});
