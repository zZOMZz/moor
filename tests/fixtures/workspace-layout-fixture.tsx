// Synthetic presentation fixture. Every action stays in memory; there is no Agent or account.
import { createRoot } from 'react-dom/client';
import { applyAppearance } from '../../apps/web/src/components/appearance';
applyAppearance(localStorage.getItem('moor-appearance') ?? 'system');
import { WorkspaceApp } from '../../apps/web/src/app/workspace-app';
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
    models: [{ id: 'fixture-model', name: '本机模型', efforts: [] }],
    modes: [],
    currentModelId: 'fixture-model',
    sessionKind: 'loaded',
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
  features: ['session-fork-v1', 'project-diff-v1', 'project-tree-v1'],
};
const project = {
  target,
  projectName: 'Moor 客户端设计与长名称项目',
  hostName: 'MacBook · 本机',
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
  project: { kind: 'local', localProjectId: 'project' },
  isPinned: i < 2,
  isArchived: i >= 37,
  status: { type: 'idle' },
}));
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
  catalogs: { local: catalog },
  errors: {},
  sessions,
  scope: { source: 'local', target },
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
};
const listeners = new Set<() => void>();
const emit = () => {
  state = { ...state };
  listeners.forEach((fn) => fn());
};
const calls: string[] = [];
const controller: any = {
  get state() {
    return state;
  },
  contextRevision: 0,
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
  async readGitContext() {
    return { execution: { branch: 'codex/ui' }, repository: { branch: 'main' } };
  },
  async listProjectSessions(_source: string, target: any) {
    return target.localProjectId === 'project' ? sessions : [];
  },
  async refreshSessions() {
    emit();
  },
  async selectProject(_source: string, selected: any) {
    state.project = catalog.targets.find(
      (entry) => entry.target.localProjectId === selected.localProjectId,
    );
    state.scope = { source: 'local', target: selected };
    state.session = undefined;
    state.sessionId = undefined;
    state.sessions = selected.localProjectId === 'project' ? sessions : [];
    emit();
  },
  async createSession() {
    calls.push('create');
    return sessions[0]!.id;
  },
  async openSession(id: string) {
    state.draft ??= { revision: 0, text: '', selection: {} };
    state.ledger ??= { operations: [] };
    state.sessionId = id;
    state.session = {
      meta: sessions.find((entry) => entry.id === id),
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
  async send() {
    calls.push('send');
  },
};
const secureState: any = {
  hostId: null,
  catalog: null,
  replicaId: null,
  sessions: [],
  session: null,
  status: null,
  operations: [],
  draft: '',
  attachmentDraft: [],
  mcpDraft: null,
  previewAnnotations: [],
  extensionBlock: null,
  permissionReviews: [],
  busy: false,
};
const secure: any = {
  state: secureState,
  subscribe: () => () => {},
  invalidate() {},
  contentContext: { target: null, online: false, generation: 0 },
};
const fixture = {
  calls,
  empty() {
    state = {
      catalogs: { local: { ...catalog, targets: [] } },
      errors: {},
      sessions: [],
      offline: false,
    };
    emit();
  },
  newConversation() {
    state = { ...state, session: { ...state.session, history: [] } };
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
    secure={secure}
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
