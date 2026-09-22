// Synthetic presentation fixture. Every action stays in memory; there is no Agent or account.
import { createRoot } from 'react-dom/client';
import { applyAppearance } from '../../apps/web/src/components/appearance';
applyAppearance(localStorage.getItem('moor-appearance') ?? 'system');
import { WorkspaceApp } from '../../apps/web/src/app/workspace-app';
import {
  SESSION_PAGE_FEATURE,
  compareSessionPageItems,
  sessionPageMatches,
  sessionPageRequestSchema,
  validateSessionPageResult,
} from '@moor/protocol/session-page';
const target = {
  serverKey: 'local:machine',
  owner: 'local-desktop',
  deviceId: 'device',
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  catalogWorkspaceId: 'workspace',
  catalogProjectId: 'logical',
  replicaId: 'replica',
};
const agent = {
  id: 'agent',
  name: 'Synthetic Agent',
  cliType: 'custom',
  agentType: 'synthetic',
  runConfig: {
    models: [
      {
        id: 'fixture-model',
        name: '本机模型',
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      },
    ],
    modes: [],
    currentModelId: 'fixture-model',
    currentReasoningEffort: 'high',
    defaultModelId: 'fixture-model',
    effortConfigId: 'reasoning_effort',
    sessionKind: 'new',
  },
  capabilityContext: {
    workspaceId: 'runtime',
    userId: 'user',
    machineId: 'machine',
    localProjectId: 'project',
    programFingerprint: 'a'.repeat(64),
    directoryFingerprint: 'b'.repeat(64),
    observedAt: Date.parse('2026-09-18T02:00:00.000Z'),
  },
  inputCapabilities: { image: true, audio: false, embeddedContext: true },
};
const runtime = {
  id: 'runtime',
  machineId: 'machine',
  userId: 'user',
  name: '我的电脑',
  projects: [{ id: 'project', name: 'Moor', rootPath: '/synthetic/project' }],
  agents: [agent],
  features: [
    SESSION_PAGE_FEATURE,
    'session-fork-v1',
    'project-diff-v1',
    'project-tree-v1',
    'agent-run-defaults-v1',
  ],
};
const project = {
  target,
  projectName: 'Moor 客户端设计与长名称项目',
  hostName: 'MacBook',
  workspaceName: 'Workspace',
  online: true,
  runtime,
};
const catalog = {
  source: 'local',
  connectionId: '00000000-0000-4000-8000-000000000001',
  origin: 'http://127.0.0.1:12345',
  owner: 'local-desktop',
  targets: [
    project,
    ...Array.from({ length: 3 }, (_, index) => ({
      ...project,
      projectName: ['文档与演示', '服务端', '实验项目'][index],
      target: {
        ...target,
        localProjectId: 'project-' + index,
        catalogProjectId: 'logical-' + index,
        replicaId: 'replica-' + index,
      },
    })),
  ],
};
const sessions = Array.from({ length: 40 }, (_, i) => ({
  id: 'session-' + i,
  title:
    i === 0
      ? '整理工作区界面与模型选择'
      : `会话 ${i} · ${i % 3 === 0 ? '检查长名称项目中的文件与历史上下文' : '继续处理项目'}`,
  agentType: 'synthetic',
  cliType: 'custom',
  agentConfigId: 'agent',
  userId: 'user',
  machineId: 'machine',
  project: { kind: 'local' as const, localProjectId: 'project' },
  isPinned: i < 2,
  isArchived: i >= 37,
  status: { type: 'idle' },
}));
const grouped = new URLSearchParams(location.search).has('grouped');
if (grouped) {
  catalog.source = 'remote';
  catalog.origin = 'https://synthetic-relay.invalid';
  catalog.owner = 'synthetic-account';
  for (const entry of catalog.targets) {
    entry.target.serverKey = catalog.origin;
    entry.target.owner = catalog.owner;
  }
  const other = catalog.targets[1]!;
  other.projectName = project.projectName;
  other.hostName = 'Mac mini';
  other.target.catalogProjectId = target.catalogProjectId;
  other.target.deviceId = 'other-device';
  other.target.machineId = 'other-machine';
  other.runtime = { ...other.runtime, machineId: 'other-machine' };
  for (const index of [2, 3])
    sessions.push({
      ...sessions[index]!,
      machineId: 'other-machine',
      title: `另一台电脑的会话 ${index}`,
      project: { kind: 'local', localProjectId: other.target.localProjectId },
    });
}
const history = [
  {
    id: 'user-turn',
    role: 'user',
    finished: true,
    timestamp: '2026-09-14T00:00:00.000Z',
    items: [{ type: 'text', text: '请检查本机模型，并整理项目界面。' }],
  },
  {
    id: 'assistant-turn',
    role: 'assistant',
    finished: true,
    timestamp: '2026-09-14T00:00:01.000Z',
    items: [
      {
        type: 'text',
        text: '已从当前执行主机读取模型目录。\n\n项目和会话集中在左侧，命令、计划和用量可以从右上角查看。',
      },
      {
        type: 'session_event',
        event: {
          version: 1,
          source: 'acp',
          kind: 'commands',
          commands: [{ name: 'review', description: '检查当前项目' }],
        },
      },
      {
        type: 'session_event',
        event: { version: 1, source: 'acp', kind: 'context-usage', used: 18000, size: 128000 },
      },
      {
        type: 'tool_call',
        title: '读取项目目录',
        status: 'completed',
        content: 'Synthetic tool output',
      },
    ],
  },
];
let state: any = {
  catalogs: { [catalog.source]: catalog },
  errors: {},
  sessions,
  scope: { source: catalog.source, target },
  project,
  sessionId: sessions[0]!.id,
  session: {
    meta: sessions[0],
    metaBundle: { version: 1, entries: {} },
    history,
    agent,
    online: true,
    synced: true,
    persisted: true,
  },
  draft: { revision: 0, text: '', selection: {} },
  ledger: { operations: [] },
  offline: false,
  sessionLoad: { status: 'ready', source: 'host' },
};
const listeners = new Set<() => void>();
const emit = () => {
  state = { ...state };
  listeners.forEach((fn) => fn());
};
const calls: string[] = [];
const pageReads: {
  projectId: string;
  pinned: string;
  limit: number;
  query: string;
  cursor?: string;
}[] = [];
const controller: any = {
  get state() {
    return state;
  },
  contextRevision: 0,
  navigationRevision: 0,
  scheduleSync() {},
  async synchronize() {
    this.navigationRevision++;
    emit();
  },
  async projectMetadata(_source: string, target: any, shown: any, action: string, title?: string) {
    const entry = sessions.find(
      (session) =>
        session.id === shown.id && session.project.localProjectId === target.localProjectId,
    )!;
    if (action === 'rename') entry.title = title!;
    if (action === 'pin' || action === 'unpin') entry.isPinned = action === 'pin';
    if (action === 'archive' || action === 'restore') entry.isArchived = action === 'archive';
    this.navigationRevision++;
    emit();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  async refreshCatalog() {
    return catalog;
  },
  async refreshSession() {
    emit();
  },
  async refreshAgentOptions() {},
  async saveRunDefaults(selection: { modelId?: string; reasoningEffort?: string }) {
    calls.push(`defaults:${selection.modelId ?? ''}:${selection.reasoningEffort ?? ''}`);
  },
  async readGitContext() {
    return { execution: { branch: 'codex/ui' }, repository: { branch: 'main' } };
  },
  async listProjectSessions(_source: string, target: any) {
    return sessions.filter((session) => session.project.localProjectId === target.localProjectId);
  },
  async listProjectSessionPage(_source: string, selected: any, options: any = {}) {
    const { fresh: _fresh, ...filters } = options;
    const request = sessionPageRequestSchema.parse({
      pageVersion: 1,
      workspaceId: selected.workspaceId,
      localProjectId: selected.localProjectId,
      ...filters,
    });
    const rows = sessions
      .filter(
        (session) =>
          session.project.localProjectId === selected.localProjectId &&
          sessionPageMatches(session, request),
      )
      .sort(compareSessionPageItems);
    const offset = request.cursor ? Number(request.cursor.replace(/^fixture_/, '')) : 0;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (request.cursor && request.cursor !== `fixture_${offset}`)
    )
      throw Error('Synthetic pagination cursor is invalid');
    const end = offset + request.limit;
    const { cursor: _cursor, ...page } = request;
    const result = validateSessionPageResult(request, {
      ...page,
      confirmed: true,
      revision: 'sha256:' + this.navigationRevision.toString(16).padStart(64, '0'),
      items: rows.slice(offset, end),
      nextCursor: end < rows.length ? `fixture_${end}` : null,
    });
    pageReads.push({
      projectId: selected.localProjectId,
      pinned: request.pinned,
      limit: request.limit,
      query: request.query,
      cursor: request.cursor,
    });
    return { ...result, source: 'host', partial: result.nextCursor !== null };
  },
  async refreshSessions() {
    state.sessions = sessions.filter(
      (session) => session.project.localProjectId === state.scope.target.localProjectId,
    );
    emit();
  },
  async selectProject(source: string, selected: any) {
    if (grouped) calls.push(`select:${source}:${selected.deviceId}:${selected.localProjectId}`);
    state.project = catalog.targets.find(
      (entry) => entry.target.localProjectId === selected.localProjectId,
    );
    state.scope = { source, target: selected };
    state.session = undefined;
    state.sessionId = undefined;
    state.sessions = sessions.filter(
      (session) => session.project.localProjectId === selected.localProjectId,
    );
    emit();
  },
  async createSession() {
    calls.push('create');
    const id = 'session-' + sessions.length;
    sessions.push({
      ...sessions[2]!,
      id,
      title: '新对话',
      project: { kind: 'local', localProjectId: state.scope.target.localProjectId },
      isPinned: false,
      isArchived: false,
    });
    return id;
  },
  async openSession(id: string) {
    if (grouped)
      calls.push(`open:${state.scope.target.deviceId}:${state.scope.target.localProjectId}:${id}`);
    state.draft ??= { revision: 0, text: '', selection: {} };
    state.ledger ??= { operations: [] };
    state.sessionId = id;
    state.session = {
      meta: sessions.find(
        (entry) =>
          entry.id === id && entry.project.localProjectId === state.scope.target.localProjectId,
      ),
      history,
      agent,
      online: true,
      synced: true,
      persisted: true,
    };
    emit();
  },
  async saveDraft(text: string, selection: unknown) {
    state.draft = { revision: state.draft.revision + 1, text, selection };
    emit();
  },
  queueDraft(
    text: string,
    selection: unknown,
    _failed?: (error: unknown) => void,
    saved?: () => void,
  ) {
    state.draft = { revision: state.draft.revision + 1, text, selection };
    saved?.();
    emit();
  },
  async flushDraft() {},
  async send() {
    calls.push('send');
  },
};
const fixture = {
  calls,
  pageReads,
  selection: () => ({ scope: state.scope, sessionId: state.sessionId }),
  empty() {
    state = {
      catalogs: { local: { ...catalog, targets: [] } },
      errors: {},
      sessions: [],
      offline: false,
      sessionLoad: { status: 'idle' },
    };
    emit();
  },
  newConversation() {
    state = {
      ...state,
      modelError: '模型目录刷新失败，当前缓存仍可用于选择。',
      draft: {
        ...state.draft,
        revision: state.draft.revision + 1,
        selection: { modelId: 'fixture-model', reasoningEffort: 'high' },
      },
      session: { ...state.session, history: [] },
    };
    emit();
  },
  conversation() {
    location.reload();
  },
};
Object.assign(window, { __moorFixture: fixture });
createRoot(document.getElementById('app')!).render(
  <WorkspaceApp
    controller={controller}
    localAvailable={!grouped}
    accountApi={async () => ({ ok: false, error: { message: 'Synthetic offline account' } })}
    openSettings={async () => {
      calls.push('settings');
    }}
    addLocalProject={async () => {
      calls.push('add');
      state = { ...state, catalogs: { local: catalog } };
      emit();
      return {
        canceled: false,
        projectId: 'project',
        identity: {
          owner: 'local-desktop',
          deviceId: 'device',
          workspaceId: 'runtime',
          machineId: 'machine',
          userId: 'user',
        },
        settingsSaved: true,
      };
    }}
  />,
);
