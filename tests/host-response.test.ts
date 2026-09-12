import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire as createPackageRequire } from 'node:module';
import {
  HOST_COMMAND_METHODS,
  hostCommandSchema,
  type HostCommand,
  type HostCommandMethod,
} from '../src/bridge/host-command';
import { validateHostResponse, HOST_RESPONSE_FAILED } from '../src/host-response';
import { AppError, type RuntimeWorkspace } from '../src/protocol';

const hash = (text: string | Uint8Array) =>
  'sha256:' + createHash('sha256').update(text).digest('hex');
const version = hash('synthetic catalog'),
  text = '合成文件\n',
  bytes = Buffer.from(text),
  data = bytes.toString('base64');
const scope = { workspaceId: 'runtime', localProjectId: 'project', sessionId: 'session' };
const operationId = 'operation',
  time = '2026-01-02T03:04:05.000Z';
const agent = {
  id: 'agent',
  name: 'Synthetic Agent',
  cliType: 'fixture-cli',
  agentType: 'fixture-agent',
};
const workspace: RuntimeWorkspace = {
  id: scope.workspaceId,
  name: 'Synthetic workspace',
  userId: 'owner',
  machineId: 'machine',
  projects: [
    { id: scope.localProjectId, name: 'Synthetic project', rootPath: '/synthetic/project' },
  ],
  agents: [agent],
  features: [
    'roles-v1',
    'session-mcp-v1',
    'session-control-v1',
    'session-tasks-v1',
    'skills-read-v1',
    'project-preview-v1',
    'github-write-v1',
    'github-read-v1',
    'file-content-v1',
    'attachments-v1',
    'project-tree-v1',
    'project-diff-v1',
    'questions-v1',
    'steer-v1',
    'session-search-v1',
    'git-worktree-v1',
    'session-fork-v1',
  ],
};
const meta = {
  id: scope.sessionId,
  userId: workspace.userId,
  machineId: workspace.machineId,
  project: { kind: 'local', localProjectId: scope.localProjectId },
  agentConfigId: agent.id,
  cliType: agent.cliType,
  agentType: agent.agentType,
};
const content = { version: hash(bytes), byteLength: bytes.length, mediaType: 'text/plain' };
const attachment = { contentVersion: 1, attachmentId: 'attachment', name: 'fixture.txt', content };
const execution = { mode: 'shared', status: 'ready', revision: 0 };
const repository = {
  kind: 'git',
  branches: [],
  changes: [],
  dirty: false,
  partial: false,
  outsideProjectChanges: false,
  version,
  issues: [],
  writeSupported: true,
};
const control = {
  ...scope,
  controlVersion: 1,
  userId: workspace.userId,
  machineId: workspace.machineId,
};
const roleAction = {
  ...scope,
  rolesVersion: 1,
  operationId,
  expectedRevision: 0,
  action: 'save',
  name: 'Fixture',
  agentId: agent.id,
  selection: {},
  instructions: 'Synthetic instructions',
};
const controlAction = { ...control, operationId, action: 'create', agentId: agent.id };
const githubAction = {
  ...scope,
  githubVersion: 1,
  operationId,
  expectedRevision: 0,
  action: 'unbind',
};
const writeAction = {
  ...scope,
  githubWriteVersion: 1,
  operationId,
  confirmed: true,
  action: 'push',
  repositoryId: 1,
  configVersion: version,
  expectedBindingRevision: 0,
  branch: 'main',
  headOid: 'a'.repeat(40),
  expectedRemoteOid: null,
  executionRevision: 0,
};
const previewAction = {
  ...scope,
  previewVersion: 1,
  clientId: 'client',
  operationId,
  confirmed: true,
  action: 'open',
  serviceId: 'service',
  serviceVersion: version,
  executionRevision: 0,
  viewport: { width: 640, height: 480 },
};
const taskSpec = {
  taskId: 'task',
  title: 'Fixture',
  agentId: agent.id,
  instruction: 'Inspect fixture',
  completion: 'Report',
  baseBranch: 'main',
  expectedOid: 'a'.repeat(40),
};
const grant = {
  grantId: 'grant',
  parentSessionId: scope.sessionId,
  parentUserTurnId: 'user-turn',
  parentAssistantTurnId: 'assistant-turn',
  state: 'active',
  createdAt: time,
  expiresAt: '2026-01-02T04:04:05.000Z',
  plan: {
    version: 1,
    tasks: [taskSpec],
    maxParallel: 1,
    maxTurnsPerTask: 1,
    timeoutMs: 1000,
    onParentEnd: 'cancel',
  },
  tasks: [
    {
      taskId: 'task',
      childSessionId: 'child',
      sessionCreated: false,
      title: taskSpec.title,
      agentId: agent.id,
      completion: taskSpec.completion,
      status: 'reserved',
      turnsUsed: 0,
      goalVerified: false,
    },
  ],
  operations: [],
};

function command(method: HostCommandMethod, params: unknown): HostCommand {
  return hostCommandSchema.parse({
    method,
    workspaceId: scope.workspaceId,
    localProjectId: scope.localProjectId,
    params,
  });
}
function writeReceipt(request: unknown = writeAction) {
  const original = command('github-write-action', request).params;
  return {
    ...scope,
    githubWriteVersion: 1,
    operationId,
    action: 'push',
    requestVersion: hash(JSON.stringify(original)),
    phase: 'unknown',
    confirmed: false,
    message: 'Synthetic outcome unknown',
    checkedAt: time,
  };
}
function previewReceipt() {
  const original = command('preview-action', previewAction).params;
  return {
    ...scope,
    previewVersion: 1,
    clientId: 'client',
    operationId,
    action: 'open',
    requestVersion: hash(JSON.stringify(original)),
    phase: 'unknown',
    closed: false,
    message: 'Synthetic outcome unknown',
    checkedAt: time,
  };
}
type Fixture = { params: unknown; result: unknown };
const fixtures = {
  sessions: { params: {}, result: [meta] },
  'agent-options': { params: { agentId: agent.id }, result: agent },
  session: {
    params: { sessionId: scope.sessionId },
    result: {
      meta,
      metaBundle: { version: 1, entries: {} },
      update: '',
      synced: true,
      online: true,
      agent,
    },
  },
  'roles-read': {
    params: { ...scope, rolesVersion: 1 },
    result: { ...scope, rolesVersion: 1, confirmed: true, catalogRevision: 0, roles: [] },
  },
  'mcp-read': {
    params: { ...scope, mcpVersion: 1 },
    result: { ...scope, mcpVersion: 1, confirmed: true, catalogRevision: 0, servers: [] },
  },
  'session-control': {
    params: controlAction,
    result: { ...control, operationId, confirmed: true, kind: 'create', status: 'accepted' },
  },
  'session-operations': {
    params: { ...control, action: 'inspect', request: { kind: 'control', value: controlAction } },
    result: { ...control, action: 'inspect', operationId, confirmed: true, found: false },
  },
  'tasks-read': {
    params: { ...scope, taskVersion: 1 },
    result: { ...scope, taskVersion: 1, confirmed: true, grants: [grant], truncated: false },
  },
  'tasks-action': {
    params: { ...scope, taskVersion: 1, grantId: 'grant', operationId, action: 'inspect' },
    result: {
      ...scope,
      taskVersion: 1,
      grantId: 'grant',
      operationId,
      action: 'inspect',
      confirmed: true,
      grant,
    },
  },
  'roles-action': {
    params: roleAction,
    result: {
      ...scope,
      rolesVersion: 1,
      confirmed: true,
      operationId,
      action: 'save',
      accepted: true,
      catalogRevision: 1,
      roleId: 'role',
    },
  },
  'skills-read': {
    params: { ...scope, skillsVersion: 1, view: 'list' },
    result: {
      ...scope,
      skillsVersion: 1,
      view: 'list',
      confirmed: true,
      catalogVersion: version,
      executionRevision: 0,
      sources: [],
      skills: [],
      issues: [],
      truncated: false,
    },
  },
  'preview-read': {
    params: { ...scope, previewVersion: 1, view: 'options' },
    result: {
      ...scope,
      previewVersion: 1,
      view: 'options',
      confirmed: true,
      available: true,
      execution,
      services: [],
    },
  },
  'preview-action': { params: previewAction, result: previewReceipt() },
  'preview-inspect': { params: { request: previewAction }, result: previewReceipt() },
  'preview-close': {
    params: { request: previewAction },
    result: { ...previewReceipt(), phase: 'closed', closed: true },
  },
  'github-write-read': {
    params: { ...scope, githubWriteVersion: 1, view: 'overview' },
    result: {
      ...scope,
      githubWriteVersion: 1,
      view: 'overview',
      confirmed: true,
      readAt: time,
      writesEnabled: false,
      bindingRevision: 0,
      git: repository,
      execution,
      canCommit: false,
    },
  },
  'github-write-action': { params: writeAction, result: writeReceipt() },
  'github-write-inspect': { params: { request: writeAction, page: 1 }, result: writeReceipt() },
  'github-write-abandon': {
    params: { request: writeAction },
    result: { ...writeReceipt(), phase: 'abandoned' },
  },
  'github-read': {
    params: { ...scope, githubVersion: 1, view: 'overview' },
    result: {
      ...scope,
      githubVersion: 1,
      view: 'overview',
      confirmed: true,
      readAt: time,
      status: 'unavailable',
      binding: { revision: 0 },
    },
  },
  'github-action': {
    params: githubAction,
    result: { ...scope, githubVersion: 1, operationId, confirmed: true, binding: { revision: 1 } },
  },
  'github-abandon': {
    params: githubAction,
    result: {
      ...scope,
      githubVersion: 1,
      operationId,
      confirmed: true,
      binding: { revision: 0 },
      abandoned: true,
    },
  },
  mutate: {
    params: {
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      operationId,
      kind: 'turn',
      expectedTurnId: null,
      update: '',
    },
    result: { operationId, accepted: true, delivered: true },
  },
  'session-action': {
    params: {
      ...scope,
      operationId,
      expectedRevision: 0,
      action: 'rename',
      title: 'Fixture renamed',
    },
    result: {
      operationId,
      accepted: true,
      delivered: true,
      meta: { ...meta, metadataRevision: 1, title: 'Fixture renamed', titleSource: 'user' },
    },
  },
  'file-content': {
    params: { ...scope, contentVersion: 1, path: 'fixture.txt' },
    result: {
      ...scope,
      contentVersion: 1,
      path: 'fixture.txt',
      content,
      confirmed: true,
      status: 'content',
      encoding: 'base64',
      data,
    },
  },
  'attachment-action': {
    params: { ...scope, contentVersion: 1, operationId, action: 'upload', attachment, data },
    result: {
      ...scope,
      contentVersion: 1,
      operationId,
      accepted: true,
      delivered: true,
      attachment,
    },
  },
  'read-attachment': {
    params: { ...scope, contentVersion: 1, attachmentId: attachment.attachmentId },
    result: { ...scope, contentVersion: 1, confirmed: true, attachment, data },
  },
  'read-project-tree': {
    params: { ...scope, contentVersion: 1 },
    result: {
      ...scope,
      contentVersion: 1,
      confirmed: true,
      version,
      source: 'git',
      entries: [],
      offset: 0,
      total: 0,
      partial: false,
      enumerationComplete: true,
      issues: [],
    },
  },
  'read-turn-diff': {
    params: { ...scope, contentVersion: 1, turnId: 'turn' },
    result: {
      ...scope,
      contentVersion: 1,
      confirmed: true,
      turnId: 'turn',
      state: 'not-recorded',
      changes: [],
      partial: true,
      issues: [],
      attribution: 'shared-project',
    },
  },
  'read-diff-file': {
    params: {
      ...scope,
      contentVersion: 1,
      turnId: 'turn',
      path: 'fixture.txt',
      knownVersion: version,
    },
    result: {
      ...scope,
      contentVersion: 1,
      confirmed: true,
      turnId: 'turn',
      path: 'fixture.txt',
      reference: {
        contentVersion: 1,
        basis: 'project-snapshot',
        turnId: 'turn',
        diffId: 'diff',
        state: 'ready',
        version,
        changeCount: 1,
      },
      before: null,
      after: {
        path: 'fixture.txt',
        size: bytes.length,
        state: 'text',
        version: hash(bytes),
        mediaType: 'text/plain',
        text,
      },
      partial: false,
      issues: [],
      attribution: 'shared-project',
    },
  },
  'answer-question': {
    params: {
      ...scope,
      interactionVersion: 1,
      expectedTurnId: 'turn',
      operationId,
      requestId: 'question',
      answer: { action: 'decline' },
    },
    result: {
      ...scope,
      interactionVersion: 1,
      expectedTurnId: 'turn',
      operationId,
      requestId: 'question',
      accepted: true,
      delivered: true,
    },
  },
  steer: {
    params: { ...scope, expectedTurnId: 'turn', operationId, prompt: 'Inspect fixture' },
    result: {
      ...scope,
      expectedTurnId: 'turn',
      operationId,
      accepted: true,
      delivered: true,
      activityBound: true,
    },
  },
  'search-sessions': {
    params: { ...scope, searchVersion: 1, scope: 'session', query: 'fixture', limit: 3 },
    result: {
      ...scope,
      searchVersion: 1,
      scope: 'session',
      query: 'fixture',
      confirmed: true,
      source: 'host-index',
      hits: [],
      more: false,
      partial: false,
    },
  },
  'git-state': {
    params: { ...scope, gitVersion: 1 },
    result: {
      ...scope,
      gitVersion: 1,
      confirmed: true,
      repository,
      execution,
      canPrepare: true,
      canRemove: false,
      boundSessions: 1,
      canDetach: false,
    },
  },
  'git-action': {
    params: {
      ...scope,
      gitVersion: 1,
      operationId,
      expectedRevision: 0,
      action: 'prepare',
      baseBranch: 'main',
      expectedOid: 'a'.repeat(40),
      newBranch: 'fixture',
    },
    result: {
      ...scope,
      gitVersion: 1,
      operationId,
      phase: 'accepted',
      confirmed: true,
      execution: {
        mode: 'worktree',
        status: 'ready',
        revision: 1,
        executionId: 'execution',
        branch: 'fixture',
        baseOid: 'a'.repeat(40),
      },
    },
  },
  'fork-options': {
    params: { ...scope, forkVersion: 1, turnId: 'turn' },
    result: {
      ...scope,
      forkVersion: 1,
      confirmed: true,
      sourceVersion: version,
      execution,
      agent: { id: agent.id, name: agent.name, agentType: agent.agentType },
      capabilities: { sameDirectory: true, worktree: true, turnCutoff: true },
      currentAvailable: true,
      turns: [{ turnId: 'turn', ordinal: 1, timestamp: time, available: true }],
      partial: false,
    },
  },
  'fork-action': {
    params: {
      ...scope,
      forkVersion: 1,
      operationId,
      childSessionId: 'child',
      expectedSourceVersion: version,
      expectedExecutionRevision: 0,
      cutoff: { kind: 'turn', turnId: 'turn' },
      directory: { kind: 'same-directory' },
    },
    result: {
      ...scope,
      forkVersion: 1,
      operationId,
      childSessionId: 'child',
      phase: 'accepted',
      confirmed: true,
      origin: {
        version: 1,
        sourceSessionId: scope.sessionId,
        sourceVersion: version,
        sourceTitle: 'Fixture',
        cutoff: { kind: 'turn', turnId: 'turn' },
        directory: 'same-directory',
        createdAt: time,
      },
      execution,
    },
  },
  cancel: { params: { sessionId: scope.sessionId, turnId: 'turn' }, result: { success: true } },
} satisfies Record<HostCommandMethod, Fixture>;

function valid(
  method: HostCommandMethod,
  result: unknown = fixtures[method].result,
  params: unknown = fixtures[method].params,
  current?: () => void,
) {
  return validateHostResponse(result, { command: command(method, params), workspace, current });
}
const failure = (error: unknown) =>
  error instanceof AppError &&
  error.status === 502 &&
  error.message === HOST_RESPONSE_FAILED &&
  error.rejected === false;

for (const method of HOST_COMMAND_METHODS) {
  test('host response accepts the original ' + method + ' response', async () => {
    const result = await valid(method);
    assert.deepEqual(result, fixtures[method].result);
    assert.notEqual(result, fixtures[method].result);
  });
  test(
    'host response rejects malformed ' +
      method +
      ' without private diagnostics or rejection authority',
    async () => {
      await assert.rejects(
        valid(method, { secret: 'PRIVATE_DIAGNOSTIC', delivered: true }),
        failure,
      );
      await assert.rejects(
        validateHostResponse(fixtures[method].result, {
          command: command(method, fixtures[method].params),
          workspace: { ...workspace, id: 'another-runtime' },
        }),
        failure,
      );
    },
  );
}

test('every scoped response, including wrapper recovery, remains inside the requested project and session', async () => {
  for (const method of HOST_COMMAND_METHODS) {
    const fixture = fixtures[method].result;
    if (Array.isArray(fixture) || !('workspaceId' in fixture)) continue;
    for (const key of ['workspaceId', 'localProjectId', 'sessionId'])
      await assert.rejects(
        valid(method, { ...fixture, [key]: 'different' }),
        failure,
        method + ':' + key,
      );
  }
  for (const method of [
    'preview-inspect',
    'preview-close',
    'github-write-inspect',
    'github-write-abandon',
  ] as const) {
    const input = structuredClone(fixtures[method].params);
    input.request.localProjectId = 'another-project';
    const response = { ...fixtures[method].result, localProjectId: 'another-project' };
    await assert.rejects(valid(method, response, input), failure);
  }
  await assert.rejects(
    valid(
      'roles-action',
      { ...fixtures['roles-action'].result, localProjectId: 'another-project' },
      { action: 'abandon', request: { ...roleAction, localProjectId: 'another-project' } },
    ),
    failure,
  );
});

test('receipts never borrow operation, turn, request, metadata revision or Agent identity', async () => {
  for (const method of HOST_COMMAND_METHODS) {
    const fixture = fixtures[method].result;
    if (Array.isArray(fixture) || !('operationId' in fixture)) continue;
    await assert.rejects(
      valid(method, { ...fixture, operationId: 'another-operation' }),
      failure,
      method,
    );
  }
  for (const method of ['answer-question', 'steer'] as const)
    await assert.rejects(
      valid(method, { ...fixtures[method].result, expectedTurnId: 'old-turn' }),
      failure,
    );
  await assert.rejects(
    valid('answer-question', { ...fixtures['answer-question'].result, requestId: 'old-question' }),
    failure,
  );
  for (const key of ['userId', 'machineId', 'id', 'cliType', 'agentType'] as const) {
    await assert.rejects(
      valid('session', { ...fixtures.session.result, meta: { ...meta, [key]: 'different' } }),
      failure,
    );
    if (key !== 'id')
      await assert.rejects(valid('sessions', [{ ...meta, [key]: 'different' }]), failure);
  }
  await assert.rejects(
    valid('session-action', {
      ...fixtures['session-action'].result,
      meta: { ...fixtures['session-action'].result.meta, metadataRevision: 2 },
    }),
    failure,
  );
  await assert.rejects(
    valid('session', { ...fixtures.session.result, agent: { ...agent, agentType: 'different' } }),
    failure,
  );
  await assert.rejects(valid('agent-options', { ...agent, cliType: 'different' }), failure);
  await assert.rejects(valid('sessions', [meta, meta]), failure);
});

test('metadata bundles cannot smuggle another session or overwrite immutable identity', async () => {
  for (const [key, value] of [
    [['m', 'session-other', 'title'], 'Unrequested'],
    [['m', 'session-session', 'userId'], 'different'],
    [['m', 'session-session', 'unknown'], 'private'],
  ] as const) {
    await assert.rejects(
      valid('session', {
        ...fixtures.session.result,
        metaBundle: { version: 1, entries: { [JSON.stringify(key)]: { c: 'clock', d: value } } },
      }),
      failure,
    );
  }
  const result = (await valid('agent-options', {
    ...agent,
    launchOptions: { secret: 'do-not-forward' },
  })) as typeof agent;
  assert.deepEqual(result, agent);
});

test('file and attachment content requires actual byte digests, canonical encoding and bound conditional versions', async () => {
  await assert.rejects(
    valid('file-content', { ...fixtures['file-content'].result, content: { ...content, version } }),
    failure,
  );
  await assert.rejects(
    valid('read-attachment', {
      ...fixtures['read-attachment'].result,
      attachment: { ...attachment, content: { ...content, version } },
    }),
    failure,
  );
  await assert.rejects(
    valid('attachment-action', {
      ...fixtures['attachment-action'].result,
      attachment: { ...attachment, name: 'different.txt' },
    }),
    failure,
  );
  const wrong = { ...attachment, content: { ...content, version } };
  await assert.rejects(
    valid(
      'attachment-action',
      { ...fixtures['attachment-action'].result, attachment: wrong },
      { ...fixtures['attachment-action'].params, attachment: wrong },
    ),
    failure,
  );
  await assert.rejects(
    valid('file-content', {
      ...fixtures['file-content'].result,
      data: 'Zh==',
      content: { ...content, byteLength: 1 },
    }),
    failure,
  );
  const conditional = {
    ...scope,
    contentVersion: 1,
    path: 'fixture.txt',
    content,
    confirmed: true,
    status: 'not-modified',
  };
  await assert.rejects(valid('file-content', conditional), failure);
  assert.deepEqual(
    await valid('file-content', conditional, {
      ...fixtures['file-content'].params,
      knownVersion: content.version,
    }),
    conditional,
  );
  await assert.rejects(
    valid('read-diff-file', {
      ...fixtures['read-diff-file'].result,
      after: { ...fixtures['read-diff-file'].result.after, version },
    }),
    failure,
  );
});

test('history, tree and search reads are tied to their original version, page, path and session', async () => {
  await assert.rejects(
    valid('read-diff-file', {
      ...fixtures['read-diff-file'].result,
      reference: { ...fixtures['read-diff-file'].result.reference, version: hash('different') },
    }),
    failure,
  );
  await assert.rejects(
    valid('read-turn-diff', { ...fixtures['read-turn-diff'].result, turnId: 'other-turn' }),
    failure,
  );
  await assert.rejects(
    valid('read-project-tree', { ...fixtures['read-project-tree'].result, offset: 1, total: 1 }),
    failure,
  );
  await assert.rejects(
    valid('read-project-tree', fixtures['read-project-tree'].result, {
      ...fixtures['read-project-tree'].params,
      knownVersion: hash('different'),
    }),
    failure,
  );
  await assert.rejects(
    valid('search-sessions', { ...fixtures['search-sessions'].result, query: 'other' }),
    failure,
  );
  await assert.rejects(
    valid('search-sessions', {
      ...fixtures['search-sessions'].result,
      hits: [
        { sessionId: 'other', turnId: 'turn', itemIndex: 0, kind: 'message', excerpt: 'fixture' },
      ],
    }),
    failure,
  );
});

test('Git and Fork execution and origin details must confirm the selected operation', async () => {
  for (const patch of [
    { revision: 2 },
    { branch: 'other' },
    { baseOid: 'b'.repeat(40) },
    { status: 'removed' },
  ])
    await assert.rejects(
      valid('git-action', {
        ...fixtures['git-action'].result,
        execution: { ...fixtures['git-action'].result.execution, ...patch },
      }),
      failure,
    );
  await assert.rejects(
    valid('fork-action', { ...fixtures['fork-action'].result, childSessionId: 'another-child' }),
    failure,
  );
  await assert.rejects(
    valid('fork-action', {
      ...fixtures['fork-action'].result,
      origin: { ...fixtures['fork-action'].result.origin, cutoff: { kind: 'current' } },
    }),
    failure,
  );
  await assert.rejects(
    valid('fork-action', {
      ...fixtures['fork-action'].result,
      execution: { ...execution, revision: 2 },
    }),
    failure,
  );
  await assert.rejects(
    valid('fork-options', { ...fixtures['fork-options'].result, turns: [] }),
    failure,
  );
  const request = {
    ...fixtures['fork-action'].params,
    directory: {
      kind: 'worktree',
      baseBranch: 'main',
      expectedOid: 'a'.repeat(40),
      newBranch: 'child-branch',
    },
  };
  const result = {
    ...fixtures['fork-action'].result,
    execution: {
      mode: 'worktree',
      status: 'ready',
      revision: 1,
      executionId: 'child-execution',
      branch: 'child-branch',
      baseOid: 'a'.repeat(40),
    },
    origin: {
      ...fixtures['fork-action'].result.origin,
      directory: 'worktree',
      branch: 'child-branch',
      baseOid: 'a'.repeat(40),
    },
  };
  assert.deepEqual(await valid('fork-action', result, request), result);
  await assert.rejects(
    valid(
      'fork-action',
      { ...result, origin: { ...result.origin, baseOid: 'b'.repeat(40) } },
      request,
    ),
    failure,
  );
});

test('shared role, MCP, task and recovery validators preserve nested references', async () => {
  await assert.rejects(
    valid('roles-read', {
      ...fixtures['roles-read'].result,
      catalogRevision: 0,
      roles: [
        {
          id: 'role',
          name: 'Fixture',
          revision: 1,
          agentId: agent.id,
          selection: {},
          instructions: 'Fixture',
          available: true,
        },
      ],
    }),
    failure,
  );
  const server = { id: 'server', name: 'Fixture', description: 'Synthetic', transport: 'stdio' };
  await assert.rejects(
    valid('mcp-read', { ...fixtures['mcp-read'].result, servers: [server, server] }),
    failure,
  );
  await assert.rejects(
    valid('tasks-read', {
      ...fixtures['tasks-read'].result,
      grants: [{ ...grant, tasks: [{ ...grant.tasks[0], agentId: 'other-agent' }] }],
    }),
    failure,
  );
  await assert.rejects(
    valid('tasks-action', {
      ...fixtures['tasks-action'].result,
      grant: { ...grant, parentSessionId: 'other-session' },
    }),
    failure,
  );
  await assert.rejects(
    valid('session-control', { ...fixtures['session-control'].result, userId: 'other-owner' }),
    failure,
  );
  await assert.rejects(
    valid('session-operations', {
      ...fixtures['session-operations'].result,
      found: true,
      receipt: { ...fixtures['session-control'].result, operationId: 'other-operation' },
    }),
    failure,
  );
  const inspect = { action: 'inspect', request: roleAction };
  const result = {
    ...scope,
    rolesVersion: 1,
    confirmed: true,
    operationId,
    action: 'inspect',
    found: true,
    receipt: fixtures['roles-action'].result,
  };
  assert.deepEqual(await valid('roles-action', result, inspect), result);
  await assert.rejects(
    valid(
      'roles-action',
      { ...result, receipt: { ...result.receipt, catalogRevision: 2 } },
      inspect,
    ),
    failure,
  );
});

test('Skills detail checks the requested source, execution revision and actual UTF-8 bytes', async () => {
  const source = {
    id: 'source',
    label: 'Fixture',
    scope: 'project',
    convention: 'registered',
    version,
    status: 'available',
  };
  const skill = {
    id: 'skill',
    sourceId: 'source',
    path: 'fixture/SKILL.md',
    name: 'Fixture',
    description: 'Synthetic',
    version: hash(text),
    byteLength: bytes.length,
    metadata: 'parsed',
  };
  const request = {
    ...scope,
    skillsVersion: 1,
    view: 'detail',
    sourceId: 'source',
    skillId: 'skill',
    version: hash(text),
    catalogVersion: version,
    executionRevision: 0,
  };
  const result = {
    ...scope,
    skillsVersion: 1,
    view: 'detail',
    catalogVersion: version,
    executionRevision: 0,
    confirmed: true,
    source,
    skill,
    text,
  };
  assert.deepEqual(await valid('skills-read', result, request), result);
  await assert.rejects(
    valid('skills-read', { ...result, text: text.replace('合', '成') }, request),
    failure,
  );
  await assert.rejects(valid('skills-read', { ...result, executionRevision: 1 }, request), failure);
  await assert.rejects(
    valid('skills-read', { ...result, skill: { ...skill, sourceId: 'different' } }, request),
    failure,
  );
});

test('GitHub and preview recoveries hash the exact original action and preserve unknown outcomes', async () => {
  for (const method of [
    'github-write-action',
    'github-write-inspect',
    'github-write-abandon',
    'preview-action',
    'preview-inspect',
    'preview-close',
  ] as const)
    await assert.rejects(
      valid(method, { ...fixtures[method].result, requestVersion: version }),
      failure,
    );
  const pushed = {
    ...writeReceipt(),
    phase: 'accepted',
    confirmed: true,
    result: { sha: 'a'.repeat(40) },
  };
  assert.deepEqual(await valid('github-write-action', pushed), pushed);
  await assert.rejects(
    valid('github-write-action', { ...pushed, result: { sha: 'b'.repeat(40) } }),
    failure,
  );
  await assert.rejects(
    valid('github-action', { ...fixtures['github-action'].result, binding: { revision: 2 } }),
    failure,
  );
  await assert.rejects(valid('preview-close', previewReceipt()), failure);
  const unknown = (await valid('github-write-action')) as Record<string, unknown>;
  assert.equal(unknown.phase, 'unknown');
  assert.equal(unknown.confirmed, false);
  assert.equal(unknown.delivered, undefined);
});

test('preview frames validate PNG header, pixels dimensions, preview id and actual bytes', async () => {
  // Header-only fixture exercises bounded header verification, not full image decoding.
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  const frame = {
    previewId: 'preview',
    frameId: 'frame',
    documentId: 'document',
    revision: 0,
    viewport: { width: 640, height: 480 },
    path: '/',
    title: 'Fixture',
    capturedAt: time,
    image: {
      mediaType: 'image/png',
      version: hash(png),
      byteLength: png.length,
      data: png.toString('base64'),
    },
  };
  const request = {
    ...scope,
    previewVersion: 1,
    view: 'frame',
    clientId: 'client',
    previewId: 'preview',
  };
  const result = {
    ...scope,
    previewVersion: 1,
    view: 'frame',
    clientId: 'client',
    previewId: 'preview',
    confirmed: true,
    expiresAt: 1000,
    frame,
  };
  assert.deepEqual(await valid('preview-read', result, request), result);
  for (const changed of [
    { ...frame, previewId: 'another-preview' },
    { ...frame, viewport: { width: 641, height: 480 } },
    { ...frame, image: { ...frame.image, version } },
    {
      ...frame,
      image: {
        ...frame.image,
        data: Buffer.alloc(24).toString('base64'),
        version: hash(Buffer.alloc(24)),
      },
    },
  ])
    await assert.rejects(valid('preview-read', { ...result, frame: changed }, request), failure);
  const actionResult = { ...previewReceipt(), phase: 'accepted', previewId: 'preview', frame };
  assert.deepEqual(await valid('preview-action', actionResult), actionResult);
  const changedInput = { ...previewAction, viewport: { width: 641, height: 480 } };
  await assert.rejects(
    valid(
      'preview-action',
      {
        ...actionResult,
        requestVersion: hash(JSON.stringify(command('preview-action', changedInput).params)),
      },
      changedInput,
    ),
    failure,
  );
  const locate = {
    ...scope,
    previewVersion: 1,
    view: 'locate',
    clientId: 'client',
    previewId: 'preview',
    frameId: 'frame',
    x: 1,
    y: 1,
  };
  const located = {
    ...scope,
    previewVersion: 1,
    view: 'locate',
    clientId: 'client',
    previewId: 'preview',
    frameId: 'old-frame',
    confirmed: true,
    element: null,
  };
  await assert.rejects(valid('preview-read', located, locate), failure);
});

test('validation rechecks the lease after crypto and snapshots original requests, catalog and bytes', async () => {
  let calls = 0;
  await assert.rejects(
    valid('file-content', undefined, undefined, () => {
      if (++calls === 3) throw new Error('PRIVATE_LEASE_DETAIL');
    }),
    failure,
  );
  assert.equal(calls, 3);
  const request = command('github-write-action', writeAction),
    catalog = structuredClone(workspace),
    response = structuredClone(writeReceipt());
  let entered = 0;
  const result = await validateHostResponse(response, {
    command: request,
    workspace: catalog,
    current: () => {
      if (++entered !== 2) return;
      if (request.method === 'github-write-action')
        request.params.operationId = 'mutated-after-snapshot';
      catalog.projects.length = 0;
      response.operationId = 'mutated-after-snapshot';
    },
  });
  assert.deepEqual(result, writeReceipt());
  assert.ok(entered >= 4);
  await assert.rejects(
    validateHostResponse(fixtures['file-content'].result, {
      command: command('file-content', fixtures['file-content'].params),
      workspace: { ...workspace, features: [] },
    }),
    failure,
  );
  await assert.rejects(
    validateHostResponse(fixtures.sessions.result, {
      command: command('sessions', {}),
      workspace: { ...workspace, projects: [workspace.projects[0]!, workspace.projects[0]!] },
    }),
    failure,
  );
});

test('wire size is checked before public projection strips private fields', async () => {
  await assert.rejects(valid('cancel', { success: true, private: 'x'.repeat(65536) }), failure);
  await assert.rejects(
    valid('agent-options', { ...agent, private: 'x'.repeat(16 * 1024 * 1024) }),
    failure,
  );
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await assert.rejects(valid('sessions', cycle), failure);
});

test('GitHub reads retain the requested repository, config, page, filter and PR identity', async () => {
  const repository = {
    id: 1,
    owner: 'synthetic',
    name: 'fixture',
    defaultBranch: 'main',
    private: true,
    url: 'https://github.com/synthetic/fixture',
  };
  const baseRequest = { ...scope, githubVersion: 1, repositoryId: 1, configVersion: version };
  const baseResult = {
    ...scope,
    githubVersion: 1,
    confirmed: true,
    repository,
    configVersion: version,
    binding: { revision: 0 },
    readAt: time,
  };
  const page = { items: [], page: 2, hasNext: false, partial: false };
  for (const view of ['branches', 'issues', 'pulls', 'comments', 'checks'] as const) {
    const input = {
      ...baseRequest,
      view,
      page: 2,
      ...(['issues', 'pulls'].includes(view) ? { state: 'open' } : {}),
      ...(view === 'comments' ? { subject: 'issue', number: 4 } : {}),
      ...(view === 'checks' ? { number: 4, headSha: 'a'.repeat(40) } : {}),
    };
    const result = {
      ...baseResult,
      view,
      ...(view === 'checks'
        ? {
            number: 4,
            headSha: 'a'.repeat(40),
            checks: page,
            statuses: { ...page, state: 'success', totalCount: 0 },
          }
        : { result: page }),
      ...(['issues', 'pulls'].includes(view) ? { state: 'open' } : {}),
      ...(view === 'comments' ? { subject: 'issue', number: 4 } : {}),
    };
    assert.deepEqual(await valid('github-read', result, input), result);
    await assert.rejects(
      valid('github-read', { ...result, repository: { ...repository, id: 2 } }, input),
      failure,
    );
    await assert.rejects(
      valid('github-read', { ...result, configVersion: hash('another config') }, input),
      failure,
    );
    await assert.rejects(
      valid(
        'github-read',
        view === 'checks'
          ? { ...result, statuses: { ...page, page: 3, state: 'success', totalCount: 0 } }
          : { ...result, result: { ...page, page: 3 } },
        input,
      ),
      failure,
    );
    if (view === 'issues' || view === 'pulls')
      await assert.rejects(valid('github-read', { ...result, state: 'closed' }, input), failure);
    if (view === 'comments')
      await assert.rejects(valid('github-read', { ...result, subject: 'pull' }, input), failure);
    if (view === 'checks')
      await assert.rejects(
        valid('github-read', { ...result, headSha: 'b'.repeat(40) }, input),
        failure,
      );
  }
  const itemBase = {
    id: 2,
    number: 4,
    title: 'Synthetic issue',
    state: 'open',
    author: 'fixture',
    url: 'https://github.com/synthetic/fixture/issues/4',
    updatedAt: time,
    body: 'Fixture',
    bodyTruncated: false,
    labels: [],
    version,
  };
  for (const view of ['issue', 'pull'] as const) {
    const request = { ...baseRequest, view, number: 4 };
    const ref = { id: repository.id, owner: repository.owner, name: repository.name };
    const item = {
      ...itemBase,
      kind: view,
      ...(view === 'pull'
        ? {
            head: { sha: 'a'.repeat(40), branch: 'fixture', repository: ref },
            base: { sha: 'b'.repeat(40), branch: 'main', repository: ref },
            mergeable: null,
          }
        : {}),
    };
    const result = { ...baseResult, view, item };
    assert.deepEqual(await valid('github-read', result, request), result);
    await assert.rejects(
      valid('github-read', { ...result, item: { ...item, number: 5 } }, request),
      failure,
    );
  }
});

test('GitHub write previews bind selected files, PR head and base, and local push branch', async () => {
  const repository = {
    id: 1,
    owner: 'synthetic',
    name: 'fixture',
    defaultBranch: 'main',
    private: true,
    url: 'https://github.com/synthetic/fixture',
  };
  const baseRequest = { ...scope, githubWriteVersion: 1, repositoryId: 1, configVersion: version };
  const baseResult = {
    ...scope,
    githubWriteVersion: 1,
    confirmed: true,
    readAt: time,
    repository,
    configVersion: version,
    writesEnabled: true,
    bindingRevision: 0,
  };
  for (const view of ['files', 'review-comments'] as const) {
    const request = {
      ...baseRequest,
      view,
      number: 4,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      page: 2,
    };
    const result = {
      ...baseResult,
      view,
      number: 4,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      result: { items: [], page: 2, hasNext: false, partial: false },
    };
    assert.deepEqual(await valid('github-write-read', result, request), result);
    for (const patch of [
      { number: 5 },
      { headSha: 'c'.repeat(40) },
      { baseSha: 'c'.repeat(40) },
      { result: { ...result.result, page: 3 } },
    ])
      await assert.rejects(valid('github-write-read', { ...result, ...patch }, request), failure);
  }
  const request = {
    ...scope,
    githubWriteVersion: 1,
    view: 'commit-preview',
    paths: ['fixture.txt'],
  };
  const file = {
    path: 'fixture.txt',
    kind: 'add',
    version: hash(text),
    byteLength: bytes.length,
    mode: '100644',
    afterText: text,
    binary: false,
    truncated: false,
  };
  const result = {
    ...scope,
    githubWriteVersion: 1,
    view: 'commit-preview',
    confirmed: true,
    readAt: time,
    candidateVersion: version,
    branch: 'main',
    parentOid: 'a'.repeat(40),
    indexVersion: version,
    files: [file],
    execution,
  };
  assert.deepEqual(await valid('github-write-read', result, request), result);
  await assert.rejects(
    valid('github-write-read', { ...result, files: [{ ...file, path: 'other.txt' }] }, request),
    failure,
  );
  await assert.rejects(
    valid('github-write-read', { ...result, files: [file, file] }, request),
    failure,
  );
  const pushRequest = {
    ...baseRequest,
    view: 'push-preview',
    branch: 'fixture',
    headOid: 'a'.repeat(40),
  };
  const pushResult = {
    ...baseResult,
    view: 'push-preview',
    branch: 'fixture',
    headOid: 'a'.repeat(40),
    expectedRemoteOid: null,
    canPush: true,
    execution,
  };
  assert.deepEqual(await valid('github-write-read', pushResult, pushRequest), pushResult);
  await assert.rejects(
    valid('github-write-read', { ...pushResult, branch: 'other' }, pushRequest),
    failure,
  );
  await assert.rejects(
    valid('github-write-read', { ...pushResult, headOid: 'b'.repeat(40) }, pushRequest),
    failure,
  );
});

test('GitHub binding confirms the selected context and preserved abandonment revision', async () => {
  const subject = { kind: 'issue', number: 4, version };
  const input = {
    ...scope,
    githubVersion: 1,
    operationId,
    expectedRevision: 0,
    action: 'bind',
    repositoryId: 1,
    configVersion: version,
    branch: 'fixture',
    subject,
  };
  const context = {
    repository: { id: 1, owner: 'synthetic', name: 'fixture' },
    branch: 'fixture',
    subject,
    updatedAt: time,
  };
  const result = {
    ...scope,
    githubVersion: 1,
    operationId,
    confirmed: true,
    binding: { revision: 1, context },
  };
  assert.deepEqual(await valid('github-action', result, input), result);
  for (const patch of [
    { branch: 'other' },
    { subject: { ...subject, number: 5 } },
    { repository: { ...context.repository, id: 2 } },
  ])
    await assert.rejects(
      valid(
        'github-action',
        { ...result, binding: { ...result.binding, context: { ...context, ...patch } } },
        input,
      ),
      failure,
    );
  const abandoned = {
    ...scope,
    githubVersion: 1,
    operationId,
    confirmed: true,
    abandoned: true,
    binding: { revision: 0 },
  };
  assert.deepEqual(await valid('github-abandon', abandoned, input), abandoned);
  await assert.rejects(
    valid('github-abandon', { ...abandoned, binding: { revision: 1 } }, input),
    failure,
  );
});

test('session document bytes use canonical base64 and preserve archived Agent versions', async () => {
  await assert.rejects(valid('session', { ...fixtures.session.result, update: 'Zh==' }), failure);
  const oldMeta = {
    ...meta,
    agentConfigId: 'archived-agent',
    cliType: 'old-cli',
    agentType: 'old-agent',
  };
  const oldAgent = { ...agent, id: 'archived-agent', cliType: 'old-cli', agentType: 'old-agent' };
  const result = { ...fixtures.session.result, meta: oldMeta, agent: oldAgent };
  assert.deepEqual(await valid('session', result), result);
  assert.deepEqual(
    await valid('agent-options', oldAgent, {
      agentId: 'archived-agent',
      sessionId: scope.sessionId,
    }),
    oldAgent,
  );
  await assert.rejects(valid('agent-options', oldAgent, { agentId: 'archived-agent' }), failure);
});

test('the entire validation module bundles for a browser without a Node runtime', async () => {
  const { build } = createPackageRequire(import.meta.url)('esbuild') as typeof import('esbuild');
  const output = await build({
    entryPoints: ['src/host-response.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  assert.ok(output.outputFiles[0]?.contents.length);
  assert.equal(
    Object.keys(output.metafile.inputs).some(
      (path) => path.includes('bridge/host-') || path.includes('preview-validation'),
    ),
    false,
  );
  assert.equal(output.outputFiles[0]!.text.includes('node:'), false);
});
