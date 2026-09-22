import type { HostCommandInput, HostCommandMethod } from '@moor/protocol/host-command';

export const scope = { workspaceId: 'workspace', localProjectId: 'project', sessionId: 'session' };
const version = 'sha256:' + '1'.repeat(64);
export const operationId = 'original-operation';
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
const gitOriginal = {
  ...scope,
  gitVersion: 1 as const,
  operationId,
  expectedRevision: 0,
  action: 'detach' as const,
  executionId: 'execution',
};
const forkOriginal = {
  ...scope,
  forkVersion: 1 as const,
  operationId,
  childSessionId: 'child',
  expectedSourceVersion: version,
  expectedExecutionRevision: 0,
  cutoff: { kind: 'current' as const },
  directory: { kind: 'same-directory' as const },
};
export const cases: {
  [M in HostCommandMethod]: {
    params: Extract<HostCommandInput, { method: M }>['params'];
    call: string;
  };
} = {
  sessions: { params: {}, call: 'list' },
  'sessions-page': {
    params: {
      pageVersion: 1,
      workspaceId: scope.workspaceId,
      localProjectId: scope.localProjectId,
    },
    call: 'readSessionPage',
  },
  'agent-usage': { params: { agentId: 'agent', sessionId: 'session' }, call: 'readAgentUsage' },
  'run-preferences': { params: { agentId: 'agent', action: 'read' }, call: 'runPreferences' },
  'agent-options': {
    params: { agentId: 'agent', sessionId: 'session', modelId: 'synthetic-model' },
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
  'tasks-read': { params: { ...scope, taskVersion: 1 }, call: 'readTasks' },
  'tasks-action': {
    params: { ...scope, taskVersion: 1, grantId: 'grant', operationId, action: 'inspect' },
    call: 'inspectTask',
  },
  'roles-action': {
    params: {
      action: 'inspect',
      request: {
        ...scope,
        rolesVersion: 1,
        operationId,
        expectedRevision: 0,
        action: 'remove',
        id: 'role',
      },
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
  'send-turn': {
    params: {
      ...scope,
      intentVersion: 1,
      operationId,
      userId: 'user',
      machineId: 'machine',
      expectedTurnId: null,
      agentId: 'agent',
      turnId: 'new-turn',
      prompt: 'Synthetic instruction',
      selection: {},
      attachments: [],
    },
    call: 'sendTurn',
  },
  'respond-permission': {
    params: {
      ...scope,
      intentVersion: 1,
      operationId,
      userId: 'user',
      machineId: 'machine',
      expectedTurnId: 'user-turn',
      requestId: 'request',
      permissionReview: { version: 1, assistantTurnId: 'assistant', itemJson: '{}' },
      outcome: { outcome: 'cancelled' },
    },
    call: 'respondPermission',
  },
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
  'git-operations': { params: { action: 'inspect', request: gitOriginal }, call: 'gitOperations' },
  'fork-operations': {
    params: { action: 'abandon', request: forkOriginal },
    call: 'forkOperations',
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
