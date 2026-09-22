import {
  fixture as githubFixture,
  target as githubTarget,
} from '../fixtures/secure-github-fixture';
import test from 'node:test';
import { AttentionController } from '../../apps/web/src/features/attention/attention';
import {
  ACTOR_FEATURE,
  ATTENTION_FEATURE,
  FOLLOWUP_FEATURE,
  type AttentionItem,
} from '@moor/protocol/attention';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import type {
  WorkspaceController,
  WorkspaceClientState,
} from '../../apps/web/src/features/workspace/workspace-controller';
import type { SecureUiController } from '../../apps/web/src/app/secure-app';
import type { SecureWorkspaceState } from '../../apps/web/src/platform/secure-controller';
import { desktopWorkspaceCatalogSchema } from '@moor/client/workspace-protocol';
import {
  notificationIdentity,
  type HostNotificationEvent,
} from '@moor/protocol/notification-protocol';
import { createAttachmentDraftItem } from '../../apps/web/src/features/attachments/attachments';
import type { AttachmentReference } from '@moor/protocol/content-protocol';
import type { QuestionRequest, QuestionAnswer } from '@moor/protocol/interaction-protocol';
import { syntheticTaskPlan, syntheticTaskGrant } from '../fixtures/task-plan';
import {
  questionDraftKey,
  emptyInteractionSaved,
  type QuestionDraftValues,
} from '../../apps/web/src/features/interactions/interactions';

test('packaged workspace opens local projects without an account and preserves drafts while navigating', async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://synthetic.invalid',
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const set = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of [
    'window',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLFormElement',
    'Element',
    'Node',
    'MutationObserver',
    'Event',
    'MouseEvent',
    'navigator',
    'FormData',
    'NodeFilter',
    'Document',
    'DocumentFragment',
    'ShadowRoot',
    'DOMRect',
    'KeyboardEvent',
  ])
    set(key, (dom.window as unknown as Record<string, unknown>)[key]);
  set('IS_REACT_ACT_ENVIRONMENT', true);
  set('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  const animation = (fn: FrameRequestCallback) => {
    queueMicrotask(() => fn(0));
    return 1;
  };
  const resize = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const media = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  for (const [key, value] of Object.entries({
    requestAnimationFrame: animation,
    cancelAnimationFrame: () => {},
    ResizeObserver: resize,
    matchMedia: media,
  })) {
    set(key, value);
    Object.defineProperty(dom.window, key, { configurable: true, value });
  }
  const { createElement, act } = await import('react'),
    { createRoot } = await import('react-dom/client'),
    { WorkspaceApp } = await import('../../apps/web/src/app/workspace-app');
  const root = createRoot(dom.window.document.getElementById('app')!);
  const catalog = desktopWorkspaceCatalogSchema.parse({
    source: 'local',
    connectionId: '00000000-0000-4000-8000-000000000001',
    origin: 'http://127.0.0.1:12345',
    owner: 'local-desktop',
    actor: { kind: 'local', authorityId: 'synthetic-authority', accountId: 'local-desktop' },
    targets: [
      {
        target: {
          serverKey: 'local:machine',
          owner: 'local-desktop',
          deviceId: 'device',
          userId: 'user',
          machineId: 'machine',
          workspaceId: 'runtime',
          localProjectId: 'project',
          catalogWorkspaceId: 'workspace',
          catalogProjectId: 'logical-project',
          replicaId: 'replica',
        },
        workspaceName: 'Workspace',
        projectName: 'Local project',
        hostName: 'My Mac',
        online: true,
        runtime: {
          id: 'runtime',
          machineId: 'machine',
          userId: 'user',
          name: 'Local',
          projects: [{ id: 'project', name: 'Local project', rootPath: '/synthetic' }],
          agents: [
            {
              id: 'agent',
              name: 'Local agent',
              cliType: 'custom',
              agentType: 'synthetic',
              inputCapabilities: { image: true, audio: true, embeddedContext: true },
              runConfig: {
                models: [{ id: 'actual-model', name: 'Installed model', efforts: [] }],
                modes: [],
                currentModelId: 'actual-model',
                sessionKind: 'loaded',
              },
            },
          ],
          features: [
            'attachments-v1',
            'skills-read-v1',
            'session-mcp-v1',
            'git-worktree-v1',
            'session-fork-v1',
          ],
        },
      },
    ],
  });
  const meta = {
    id: 'session',
    userId: 'user',
    machineId: 'machine',
    project: { kind: 'local' as const, localProjectId: 'project' },
    agentConfigId: 'agent',
    cliType: 'custom',
    agentType: 'synthetic',
    title: 'Local session',
  };
  const state: WorkspaceClientState = {
    catalogs: {},
    errors: {},
    sessions: [],
    offline: true,
    sessionLoad: { status: 'idle' },
  };
  const forkOrigin = {
    version: 1 as const,
    sourceSessionId: meta.id,
    sourceTitle: meta.title,
    sourceVersion: 'sha256:' + 'a'.repeat(64),
    cutoff: { kind: 'current' as const },
    directory: 'same-directory' as const,
    createdAt: '2026-09-14T00:00:00.000Z',
  };
  const listeners = new Set<() => void>(),
    calls: string[] = [];
  const emit = () => listeners.forEach((listener) => listener());
  let contextRevision = 0;
  let hold: Promise<void> | undefined;
  let sessionRefresh: Promise<void> | undefined;
  let bufferedDraft: { text: string; selection: object; saved?: () => void } | undefined;
  let attachmentsSaved!: () => void;
  const attachmentSaved = new Promise<void>((resolve) => {
    attachmentsSaved = resolve;
  });
  const flushBufferedDraft = async () => {
    const draft = bufferedDraft;
    if (!draft) return;
    bufferedDraft = undefined;
    calls.push('draft:' + draft.text);
    await hold;
    state.draft = {
      revision: state.draft!.revision + 1,
      text: draft.text,
      selection: draft.selection,
    };
    draft.saved?.();
  };
  const controller = {
    async readGitContext() {
      return undefined;
    },
    async listProjectSessions() {
      return state.sessions;
    },
    get contextRevision() {
      return contextRevision;
    },
    get state() {
      return structuredClone(state);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async refreshCatalog(source: string) {
      calls.push('catalog:' + source);
      assert.equal(source, 'local');
      state.catalogs.local = catalog;
      emit();
    },
    async createSession(agentId: string) {
      assert(state.project!.runtime.agents.some((agent) => agent.id === agentId));
      calls.push('create');
      calls.push('create-agent:' + agentId);
      return 'session';
    },
    async refreshSessions() {
      calls.push('sessions');
      emit();
    },
    async selectProject(_source: string, target: (typeof catalog.targets)[number]['target']) {
      calls.push('project');
      state.project = catalog.targets.find(
        (entry) => entry.target.localProjectId === target.localProjectId,
      )!;
      state.scope = { source: 'local', target: state.project.target };
      state.sessions = [meta];
      emit();
    },
    async openSession(id: string) {
      calls.push('session:' + id);
      state.sessionId = id;
      state.sessionLoad = { status: 'loading-cache' };
      emit();
      state.draft = { revision: 0, text: '', selection: {} };
      state.session = {
        meta,
        metaBundle: { version: 1, entries: {} },
        update: '',
        online: true,
        synced: true,
        persisted: true,
        agent: catalog.targets[0]!.runtime.agents[0],
        history: [
          {
            id: 'assistant',
            role: 'assistant',
            timestamp: '2026-01-01T00:00:00.000Z',
            finished: true,
            items: [
              { type: 'text', text: 'Hello <script>unsafe()</script>' },
              {
                type: 'session_event',
                event: {
                  version: 1,
                  source: 'acp',
                  kind: 'commands',
                  commands: [{ name: 'review', description: 'Review the project' }],
                },
              },
              {
                type: 'session_event',
                event: { version: 1, source: 'acp', kind: 'context-usage', used: 32, size: 256 },
              },
            ],
            status: 'completed',
            fileDiff: null,
          },
        ],
      } as NonNullable<WorkspaceClientState['session']>;
      if (id === 'synthetic-child') {
        state.session.meta = { ...meta, id, forkOrigin };
        state.session.history = [];
      }
      if (id === 'task-child') {
        state.session.meta = {
          ...meta,
          id,
          taskOrigin: {
            version: 1,
            grantId: 'grant',
            parentSessionId: 'session',
            parentUserTurnId: 'parent-user',
            parentAssistantTurnId: 'parent-assistant',
            taskId: 'task-one',
            completion: 'Human verifies synthetic result',
          },
        };
        state.session.history = [];
      }
      state.sessionLoad = { status: 'refreshing', source: 'cache' };
      emit();
      await sessionRefresh;
      state.offline = false;
      state.sessionLoad = { status: 'ready', source: 'host' };
      emit();
    },
    queueDraft(
      text: string,
      selection: object,
      _failed?: (error: unknown) => void,
      saved?: () => void,
    ) {
      bufferedDraft = { text, selection, saved };
    },
    flushDraft: flushBufferedDraft,
    async saveDraft(text: string, selection: object) {
      bufferedDraft = { text, selection };
      await flushBufferedDraft();
    },
    async send() {
      await flushBufferedDraft();
      calls.push('send');
      state.draft = { ...state.draft!, revision: state.draft!.revision + 1, text: '' };
      emit();
    },
    async refreshAgentOptions() {
      calls.push('models');
    },
    async openFork(changed: () => void) {
      const value = {
        loaded: true,
        busy: false,
        loadError: '',
        error: '',
        source: 'host',
        options: undefined as any,
        receipt: undefined as any,
        resources: [],
      };
      return {
        controller: value,
        close() {
          calls.push('fork:close');
        },
        async refresh() {
          calls.push('fork:read');
          value.options = {
            sourceVersion: forkOrigin.sourceVersion,
            execution: { mode: 'shared', status: 'ready', revision: 0 },
            agent: { id: 'agent', name: 'Synthetic', agentType: 'synthetic' },
            currentAvailable: true,
            capabilities: { sameDirectory: true, worktree: false, turnCutoff: true },
            turns: [{ turnId: 'assistant', ordinal: 1, timestamp: '2026-09-14', available: true }],
            partial: false,
          };
          changed();
        },
        async create(cutoff: unknown, directory: unknown) {
          assert.deepEqual(cutoff, { kind: 'current' });
          assert.deepEqual(directory, { kind: 'same-directory' });
          calls.push('fork:create');
          value.receipt = {
            phase: 'accepted',
            childSessionId: 'synthetic-child',
            origin: forkOrigin,
            execution: { mode: 'shared', status: 'ready', revision: 0 },
          };
          changed();
        },
      };
    },
    async openGit(changed: () => void) {
      const oid = 'a'.repeat(40);
      const value = {
        busy: false,
        loaded: true,
        loadError: '',
        error: '',
        source: 'host',
        state: {
          execution: { mode: 'shared', status: 'ready', revision: 0 },
          canPrepare: true,
          canRemove: false,
          repository: {
            kind: 'git',
            branch: 'main',
            headOid: oid,
            branches: [{ name: 'main', oid }],
            changes: [],
            dirty: false,
            partial: false,
            outsideProjectChanges: false,
            issues: [],
            version: 'sha256:' + 'a'.repeat(64),
            writeSupported: true,
          },
        } as any,
        get execution() {
          return value.state.execution;
        },
      };
      return {
        controller: value,
        close() {
          calls.push('git:close');
        },
        async refresh() {
          calls.push('git:read');
          changed();
        },
        async prepare(branch: string, base: string, name: string) {
          assert.deepEqual([branch, base, name], ['main', oid, 'feature/ui']);
          calls.push('git:prepare');
          value.state.execution = {
            mode: 'worktree',
            status: 'ready',
            revision: 1,
            executionId: 'execution',
            branch: name,
            baseOid: oid,
          };
          value.state.canPrepare = false;
          changed();
        },
      };
    },
    async openAttention(changed: () => void) {
      calls.push('attention:open');
      const t = catalog.targets[0]!.target;
      const route = {
        origin: catalog.origin,
        actor: catalog.actor!,
        catalogWorkspaceId: t.catalogWorkspaceId,
        projectId: t.catalogProjectId,
        replicaId: t.replicaId,
        executionDeviceId: t.deviceId,
        machineId: t.machineId,
        runtimeWorkspaceId: t.workspaceId,
        localProjectId: t.localProjectId,
      };
      const item: AttentionItem = {
        itemId: 'synthetic-outcome',
        sessionId: state.sessionId!,
        localProjectId: t.localProjectId,
        assistantTurnId: state.session!.history[0]!.id,
        userTurnId: 'synthetic-user-turn',
        kind: 'outcome',
        lifecycle: 'ended',
        eventRevision: 1,
        observationRevision: 0,
        sequence: 1,
        occurredAt: 1,
        summary: 'Synthetic attention outcome',
        seenRevision: 0,
        disposition: 'pending',
        cause: 'agent_returned',
      };
      const values = new Map<string, unknown>();
      let sequence = 0;
      const attention = new AttentionController({
        changed,
        now: () => 100,
        uuid: () => 'attention-' + ++sequence,
        read: async <T>(key: string) => values.get(key) as T | undefined,
        write: async (key, value) => {
          values.set(key, structuredClone(value));
        },
        compareAndSet: async (key, expected, value) => {
          if (JSON.stringify(values.get(key)) !== JSON.stringify(expected)) return false;
          values.set(key, structuredClone(value));
          return true;
        },
        readSessionDraft: async () => '',
        prepareTurn: async () => {
          throw Error('Not expected in navigation test');
        },
        continued: async () => {
          throw Error('Not expected in navigation test');
        },
        request: async (path, body) => {
          if (body) {
            calls.push('attention:seen');
            assert(path.endsWith('/seen'));
            const input = body as { operationId: string; eventRevision: number };
            item.seenRevision = input.eventRevision;
            return { accepted: true, delivered: true, operationId: input.operationId, item };
          }
          if (path.endsWith('/' + item.itemId))
            return {
              item,
              title: 'Synthetic attention session',
              isArchived: false,
              turn: { items: [{ type: 'text', text: 'Synthetic attention details' }] },
              userTurn: null,
            };
          return {
            sessions: [
              {
                sessionId: item.sessionId,
                title: 'Synthetic attention session',
                isArchived: false,
                items: [item],
                itemCount: 1,
              },
            ],
            total: 1,
            version: 1,
          };
        },
      });
      attention.configure({
        origin: catalog.origin,
        actor: catalog.actor!,
        workspaceId: t.catalogWorkspaceId,
        workspaceName: 'Synthetic workspace',
        connected: true,
        targets: [
          {
            ...route,
            hostName: 'My Mac',
            projectName: 'Local project',
            online: true,
            features: [ACTOR_FEATURE, ATTENTION_FEATURE, FOLLOWUP_FEATURE],
          },
        ],
      });
      await attention.refresh();
      return {
        controller: attention,
        close: () => calls.push('attention:close'),
        openSession: async (value: unknown, sessionId: string) => {
          assert.deepEqual(value, attention.state.lists[0]!.target);
          assert.equal(sessionId, state.sessionId);
          calls.push('attention:navigate');
        },
      };
    },
    openSearch() {
      return {
        close() {
          calls.push('search:close');
        },
        async search(query: string, scope: 'session' | 'project') {
          calls.push('search:' + query);
          return {
            source: 'host-index' as const,
            query,
            scope,
            partial: false,
            more: false,
            hits: [
              {
                sessionId: state.sessionId!,
                turnId: state.session!.history[0]!.id,
                itemIndex: 0,
                kind: 'message' as const,
                excerpt: 'Synthetic result',
              },
            ],
          };
        },
        async openHit(hit: any) {
          calls.push('search:open');
          state.searchFocus = hit;
          emit();
        },
      };
    },
    async projectMetadata(
      source: string,
      target: (typeof catalog.targets)[number]['target'],
      shown: typeof meta,
      action: string,
      title?: string,
    ) {
      calls.push(`sidebar:${source}:${target.localProjectId}:${shown.id}:${action}`);
      if (title === 'conflict') throw Error('Synthetic metadata conflict');
      state.sessions = state.sessions.map((session) =>
        session.id === shown.id
          ? {
              ...session,
              ...(action === 'pin' || action === 'unpin' ? { isPinned: action === 'pin' } : {}),
              ...(action === 'rename' ? { title } : {}),
            }
          : session,
      );
      emit();
    },
    async metadata(action: string, title?: string) {
      calls.push('metadata:' + action);
      if (action === 'rename') state.session!.meta.title = title;
      if (action === 'pin') state.session!.meta.isPinned = true;
      emit();
    },
    async openGithub(changed: () => void) {
      const fixture = githubFixture();
      fixture.controller.subscribe(changed);
      await fixture.controller.open(githubTarget);
      calls.push('github:open');
      return fixture.controller;
    },
    openSkills(changed: () => void) {
      const source = {
        id: 'project-skills',
        label: '.agents/skills',
        scope: 'project',
        status: 'available',
      };
      const skill = {
        id: 'skill',
        name: 'Synthetic skill',
        sourceId: source.id,
        path: 'synthetic/SKILL.md',
        version: 'sha256:synthetic',
        byteLength: 30,
      };
      const value = {
        busy: false,
        error: '',
        list: undefined as any,
        detail: undefined as any,
        async refresh() {
          calls.push('skills:read');
          value.list = { sources: [source], skills: [skill], issues: [], truncated: false };
          changed();
        },
        async select(id: string) {
          assert.equal(id, skill.id);
          calls.push('skills:detail');
          value.detail = { source, skill, text: 'Reviewed skill <script>unsafe()</script>' };
          changed();
        },
      };
      return {
        controller: value,
        close() {
          value.list = value.detail = undefined;
          calls.push('skills:close');
          changed();
        },
        async addToDraft() {
          assert(value.detail);
          calls.push('skills:add');
          state.draft = {
            ...state.draft!,
            revision: state.draft!.revision + 1,
            text: 'Reviewed skill',
          };
          emit();
        },
      };
    },
    async saveQuestionDraft(request: QuestionRequest, values: QuestionDraftValues) {
      calls.push('question:draft');
      const document = (state.ledger!.interactions ??= {});
      document[request.sessionId] ??= { revision: 0, value: emptyInteractionSaved() };
      document[request.sessionId]!.value.drafts[questionDraftKey(request)] = values;
      document[request.sessionId]!.revision++;
      emit();
    },
    async answerQuestion(request: QuestionRequest, answer: QuestionAnswer['answer']) {
      calls.push('question:answer');
      assert.equal(request.expectedTurnId, 'assistant');
      assert.deepEqual(answer, { action: 'accept', values: { color: 'green' } });
      const item = (state.session!.history[0]!.items as any[]).find(
        (item) => item.type === 'question',
      );
      item.status = 'answered';
      item.answer = answer;
      emit();
    },
    async saveSteerDraft(prompt: string) {
      state.ledger!.interactions![state.sessionId!]!.value.steerDraft = prompt;
      emit();
    },
    async steer(turnId: string, prompt: string) {
      calls.push('steer:' + turnId + ':' + prompt);
    },
    async addAttachments(files: File[]) {
      calls.push('attachments:add');
      const items = await Promise.all(
        files.map((file, index) => createAttachmentDraftItem(file, 'synthetic-file-' + index)),
      );
      state.ledger ??= { version: 1, scope: state.scope!, revision: 1, operations: [] };
      state.ledger.attachments = { [state.sessionId!]: { revision: 1, items } };
      emit();
      attachmentsSaved();
    },
    async uploadAttachment(id: string) {
      calls.push('attachment:upload:' + id);
      const draft = state.ledger!.attachments![state.sessionId!]!;
      draft.items[0]!.uploaded = true;
      draft.revision++;
      emit();
    },
    async removeAttachment(id: string) {
      calls.push('attachment:remove:' + id);
      state.ledger!.attachments![state.sessionId!]!.items = [];
      emit();
    },
    async readAttachment(reference: AttachmentReference) {
      calls.push('attachment:read:' + reference.attachmentId);
      const item = state.ledger!.attachments![state.sessionId!]!.items.find(
        (item) => item.reference.attachmentId === reference.attachmentId,
      )!;
      return { reference: item.reference, data: item.data, source: 'host', cacheSaved: true };
    },
    async openProjectContent(changed: () => void, mode: 'tree' | 'changes' = 'tree') {
      calls.push('content:open:' + mode);
      let value: { title: string; mode: 'tree' | 'changes'; turns: [] } | null = {
        title: 'Synthetic project files',
        mode,
        turns: [],
      };
      return {
        get state() {
          return value;
        },
        async setMode(next: 'tree' | 'changes') {
          calls.push('content:mode:' + next);
          value!.mode = next;
          changed();
        },
        async treeMore() {},
        async file() {},
        async turn() {},
        async diffFile() {},
        async refresh() {
          calls.push('content:refresh');
        },
        close() {
          calls.push('content:close');
          value = null;
          changed();
        },
        dispose() {
          calls.push('content:dispose');
          value = null;
        },
      };
    },
  } as unknown as WorkspaceController;
  const encrypted: SecureWorkspaceState = {
    status: null,
    hostId: null,
    catalog: null,
    replicaId: null,
    sessions: [],
    session: null,
    operations: [],
    draft: '',
    attachmentDraft: [],
    mcpDraft: null,
    previewAnnotations: [],
    extensionBlock: null,
    permissionReviews: [],
    notice: null,
    busy: false,
  };
  const secure = {
    get state() {
      return structuredClone(encrypted);
    },
    get contentContext() {
      return { target: null, online: false, generation: 0 };
    },
    subscribe() {
      return () => {};
    },
    invalidate() {
      calls.push('secure-invalidate');
    },
  } as unknown as SecureUiController;
  const visibleButton = (label: string) => {
    const result = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        !button.closest('[hidden]') &&
        (button.textContent?.trim() === label || button.getAttribute('aria-label') === label),
    );
    assert(result, 'visible button: ' + label);
    return result;
  };
  let desktopChanged: (() => void) | undefined;
  const desktop = {
    localReady: false,
    view: 'local',
    revision: 1,
    notification: null as HostNotificationEvent | null,
  };
  try {
    await act(async () => {
      root.render(
        createElement(WorkspaceApp, {
          controller,
          secure,
          accountApi: async () => ({ ok: false as const, error: { message: 'No remote account' } }),
          openSettings: async () => {
            calls.push('settings');
          },
          addLocalProject: async () => {
            calls.push('add-project');
            return {
              canceled: false,
              projectId: 'project',
              settingsSaved: true,
              identity: {
                owner: 'local-desktop',
                deviceId: 'device',
                workspaceId: 'runtime',
                userId: 'user',
                machineId: 'machine',
              },
            };
          },
          readDesktopContext: async () => structuredClone(desktop),
          subscribeDesktopChanges: (listener) => {
            desktopChanged = listener;
            return () => {
              desktopChanged = undefined;
            };
          },
        }),
      );
    });
    assert.deepEqual(calls, ['secure-invalidate']);
    assert.match(dom.window.document.body.textContent!, /执行组件正在准备/);
    await act(async () => {
      desktop.localReady = true;
      desktopChanged!();
    });
    assert.deepEqual(calls, ['secure-invalidate', 'catalog:local']);
    assert.equal(dom.window.document.querySelectorAll('iframe').length, 0);
    const project = dom.window.document.querySelector<HTMLButtonElement>('.workspace-project')!;
    assert.match(project.textContent!, /Local project.*My Mac/s);
    await act(async () => visibleButton('添加项目').click());
    assert.equal(calls.includes('add-project'), true);
    assert.equal(state.project?.projectName, 'Local project');
    assert.equal(calls.includes('settings'), false);
    assert.match(dom.window.document.body.textContent!, /项目已添加/);
    await act(async () => project.click());
    await act(async () => visibleButton('Local sessionsynthetic').click());
    assert.match(
      dom.window.document.querySelector('.workspace-history')!.textContent!,
      /Hello <script>unsafe\(\)<\/script>/,
    );
    assert.equal(dom.window.document.querySelector('.workspace-history script'), null);
    assert.match(
      dom.window.document.querySelector('.run-controls')!.textContent!,
      /Installed model/,
    );
    let finishSessionRefresh!: () => void;
    sessionRefresh = new Promise<void>((resolve) => {
      finishSessionRefresh = resolve;
    });
    await act(async () => visibleButton('Local sessionsynthetic').click());
    assert.equal(state.offline, false);
    assert.deepEqual(state.sessionLoad, { status: 'refreshing', source: 'cache' });
    assert.equal(project.disabled, false);
    assert.equal(visibleButton('Local sessionsynthetic').disabled, false);
    assert.equal(visibleButton('连接其他电脑').disabled, false);
    const sync = dom.window.document.querySelector<HTMLElement>('.workspace-session-sync');
    assert(sync);
    assert.equal(sync.getAttribute('role'), 'status');
    assert.equal(sync.getAttribute('aria-label'), '正在与执行电脑同步会话');
    assert(sync.querySelector('svg')?.classList.contains('spin'));
    assert.doesNotMatch(dom.window.document.body.textContent!, /正在与执行电脑同步会话/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /执行电脑暂不可达/);
    await act(async () => {
      finishSessionRefresh();
      await sessionRefresh;
      await Promise.resolve();
    });
    sessionRefresh = undefined;
    assert.equal(dom.window.document.querySelector('.workspace-session-sync'), null);
    const visibleSession = structuredClone(state.session!);
    await act(async () => {
      delete state.session;
      state.sessionLoad = { status: 'loading-cache' };
      emit();
    });
    const loading = dom.window.document.querySelector<HTMLElement>('.workspace-session-loading');
    assert(loading);
    assert.equal(loading.getAttribute('aria-label'), '正在打开会话');
    assert.equal(
      loading.querySelector<HTMLImageElement>('img')?.getAttribute('src'),
      '/moor-logo.png',
    );
    assert.equal(loading.querySelector('svg'), null);
    assert.equal(loading.querySelector('h1'), null);
    assert.equal(loading.querySelector('p'), null);
    await act(async () => {
      state.session = visibleSession;
      state.sessionLoad = { status: 'ready', source: 'host' };
      emit();
    });
    const information =
      dom.window.document.querySelector<HTMLDetailsElement>('.session-information')!;
    assert.equal(information.open, false);
    assert.doesNotMatch(
      dom.window.document.querySelector('.workspace-history')!.textContent!,
      /Review the project|用量|命令快照/,
    );
    assert.equal(
      dom.window.document.querySelector('.workspace-history button[title="从此回合创建副本"]')
        ?.textContent,
      '',
    );
    assert.doesNotMatch(
      dom.window.document.querySelector('.workspace-history')!.textContent!,
      /查看回合文件变更/,
    );
    await act(async () => information.querySelector('summary')!.click());
    const sendsBeforeCommand = calls.filter((call) => call === 'send').length;
    await act(async () => visibleButton('/review').click());
    assert.equal(
      dom.window.document.querySelector<HTMLTextAreaElement>('textarea')!.value,
      '/review',
    );
    assert.equal(calls.filter((call) => call === 'send').length, sendsBeforeCommand);
    await act(async () => controller.saveDraft('', {}));
    await act(async () => visibleButton('关闭会话信息').click());
    assert.equal(information.open, false);
    let textarea = dom.window.document.querySelector('textarea')!;
    const composerSurface = dom.window.document.querySelector('.workspace-input-box')!;
    assert(
      composerSurface.querySelector('.workspace-compose-actions > .run-controls'),
      'permission and model controls stay inside the input toolbar',
    );
    assert(
      composerSurface.querySelector('.workspace-compose-actions > .usage-trigger'),
      'context usage stays inside the input toolbar',
    );
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Keep this draft',
      );
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => controller.refreshSessions());
    assert.equal(
      textarea.value,
      'Keep this draft',
      'an unrelated global update keeps newer UI State',
    );
    assert.equal(project.disabled, false);
    assert.equal(visibleButton('发送').disabled, false);
    assert.equal(visibleButton('连接其他电脑').disabled, false);
    await act(async () => {
      release();
      await hold;
    });
    assert.equal(textarea.value, 'Keep this draft');
    await act(async () => visibleButton('发送').click());
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    await act(async () => visibleButton('待我处理').click());
    assert.match(
      dom.window.document.querySelector('.workspace-attention-panel')!.textContent!,
      /Synthetic attention outcome/,
    );
    const attentionRow = dom.window.document.querySelector<HTMLButtonElement>('.attention-row')!;
    await act(async () => attentionRow.click());
    assert.match(
      dom.window.document.querySelector('.attention-detail')!.textContent!,
      /Synthetic attention details/,
    );
    await act(async () => visibleButton('打开原会话').click());
    assert.equal(dom.window.document.querySelector('.workspace-attention-panel'), null);
    assert(calls.includes('attention:navigate'));
    assert(calls.includes('attention:close'));
    await act(async () => visibleButton('待我处理').click());
    assert(dom.window.document.querySelector('.workspace-attention-panel'));
    await act(async () => {
      contextRevision++;
      emit();
    });
    assert.equal(dom.window.document.querySelector('.workspace-attention-panel'), null);

    assert.equal(calls.filter((value) => value === 'send').length, 1);
    await act(async () => visibleButton('Skills').click());
    assert.equal(calls.filter((value) => value === 'skills:read').length, 1);
    await act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>('.skills-list button')!.click(),
    );
    assert.match(
      dom.window.document.querySelector('.skills-detail')!.textContent!,
      /Reviewed skill/,
    );
    assert.equal(dom.window.document.querySelector('.skills-detail script'), null);
    await act(async () => visibleButton('将说明加入本次指令').click());
    assert.equal(textarea.value, 'Reviewed skill');
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    await act(async () => visibleButton('关闭 Skills').click());
    assert.equal(dom.window.document.querySelector('.skills-panel'), null);
    assert(calls.includes('skills:close'));
    await act(async () => {
      state.project!.runtime.features!.push('project-preview-v1', 'roles-v1', 'session-tasks-v1');
      emit();
    });
    await act(async () => visibleButton('GitHub').click());
    assert(calls.includes('github:open'));
    assert(dom.window.document.querySelector('.github-panel'));
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    await act(async () => visibleButton('关闭 GitHub 面板').click());
    assert.equal(dom.window.document.querySelector('.github-panel'), null);
    await act(async () => visibleButton('正文搜索').click());
    const queryInput =
      dom.window.document.querySelector<HTMLInputElement>('[aria-label="搜索正文"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        queryInput,
        'needle',
      );
      queryInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      dom.window.document
        .querySelector<HTMLFormElement>('.session-search-form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert(calls.includes('search:needle'));
    assert.match(
      dom.window.document.querySelector('.session-search-results')!.textContent!,
      /Synthetic result/,
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>('.session-search-results button')!
        .click(),
    );
    assert(calls.includes('search:open'));
    assert(dom.window.document.querySelector('.workspace-search-focus'));
    await act(async () => visibleButton('整理会话').click());
    await act(async () =>
      dom.window.document
        .querySelector<HTMLFormElement>('.workspace-metadata-panel form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    assert(calls.includes('metadata:rename'));
    assert.equal(dom.window.document.querySelector('.workspace-metadata-panel'), null);
    await act(async () => visibleButton('整理会话').click());
    await act(async () => visibleButton('置顶会话').click());
    assert(calls.includes('metadata:pin'));
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    for (const label of ['额外 MCP', '网页预览', '项目预览', '角色预设', '协作任务']) {
      assert(
        !Array.from(dom.window.document.querySelectorAll('button')).some(
          (button) =>
            button.textContent?.includes(label) || button.getAttribute('aria-label') === label,
        ),
      );
    }
    const originalHistory = structuredClone(state.session!.history);
    await act(async () => {
      state.session!.history = [];
      emit();
    });
    assert.equal(
      dom.window.document.querySelector('.workspace-menu-environment:not([hidden])'),
      null,
    );
    await act(async () =>
      dom.window.document
        .querySelector<HTMLButtonElement>('.workspace-composer-context > button')!
        .click(),
    );
    assert(calls.includes('git:read'));
    const baseline = dom.window.document.querySelector<HTMLSelectElement>(
      '.git-workspace-panel select',
    )!;
    await act(async () => {
      baseline.value = JSON.stringify(['main', 'a'.repeat(40)]);
      baseline.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    const newBranch = dom.window.document.querySelector<HTMLInputElement>(
      '.git-workspace-panel input[maxlength="200"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        newBranch,
        'feature/ui',
      );
      newBranch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () =>
      dom.window.document
        .querySelector<HTMLFormElement>('.git-workspace-panel form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    assert.equal(calls.filter((value) => value === 'git:prepare').length, 1);
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    assert.match(
      dom.window.document.querySelector('.git-workspace-panel')!.textContent!,
      /feature\/ui/,
    );
    await act(async () => visibleButton('关闭 Git 与工作目录').click());
    assert.equal(dom.window.document.querySelector('.git-workspace-panel'), null);
    await act(async () => {
      state.session!.history = originalHistory;
      emit();
    });
    await act(async () => visibleButton('创建会话副本').click());
    assert.equal(calls.filter((value) => value === 'fork:read').length, 1);
    const forkSelects = dom.window.document.querySelectorAll<HTMLSelectElement>(
      '.session-fork-panel select',
    );
    await act(async () => {
      forkSelects[0]!.value = 'current';
      forkSelects[0]!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      forkSelects[1]!.value = 'same-directory';
      forkSelects[1]!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await act(async () => visibleButton('创建原生会话副本').click());
    assert.equal(calls.filter((value) => value === 'fork:create').length, 1);
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    await act(async () => visibleButton('打开已确认的副本').click());
    assert(calls.includes('session:synthetic-child'));
    assert.match(dom.window.document.querySelector('.fork-origin')!.textContent!, /Local session/);
    assert.equal(dom.window.document.querySelector('.session-fork-panel'), null);
    await act(async () => visibleButton('打开源会话').click());
    textarea = dom.window.document.querySelector('textarea')!;
    const scope = {
      userId: 'user',
      machineId: 'wrong-machine',
      workspaceId: 'runtime',
      localProjectId: 'project',
      sessionId: 'session',
      turnId: 'turn',
      kind: 'completed' as const,
    };
    const notification = {
      ...scope,
      notificationVersion: 1 as const,
      eventId:
        'notification_' + createHash('sha256').update(notificationIdentity(scope)).digest('hex'),
      createdAt: 1000,
      expiresAt: 2000,
    };
    const previousReads = calls.filter((value) => value.startsWith('session:')).length;
    await act(async () => {
      desktop.notification = notification;
      desktopChanged!();
    });
    assert.equal(calls.filter((value) => value.startsWith('session:')).length, previousReads);
    assert.match(
      dom.window.document.querySelector('.workspace-error')!.textContent!,
      /对应的本机项目尚不可用/,
    );
    const correct = { ...notification, machineId: 'machine' };
    correct.eventId =
      'notification_' + createHash('sha256').update(notificationIdentity(correct)).digest('hex');
    await act(async () => {
      desktop.notification = correct;
      desktopChanged!();
    });
    assert.equal(calls.filter((value) => value.startsWith('session:')).length, previousReads + 1);
    await act(async () => desktopChanged!());
    assert.equal(calls.filter((value) => value.startsWith('session:')).length, previousReads + 1);
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    assert.equal(textarea.value, '');
    await act(async () => visibleButton('设置').click());
    await act(async () => visibleButton('设备、Agent 与连接设置').click());
    await act(async () => visibleButton('关闭设置').click());
    assert(calls.includes('settings'));
    await act(async () => visibleButton('连接其他电脑').click());
    assert.equal(
      dom.window.document.querySelector('.workspace-conversation')!.hasAttribute('hidden'),
      true,
    );
    assert.match(
      dom.window.document.querySelector('.workspace-secure-content')!.textContent!,
      /账号状态未确认/,
    );
    const navigationCalls = calls.length;
    await act(async () => project.click());
    assert.equal(calls.length, navigationCalls, 'project headings only expand or collapse');
    assert.equal(
      dom.window.document.querySelector('.workspace-conversation')!.hasAttribute('hidden'),
      true,
    );
    await act(async () => visibleButton('Local sessionsynthetic').click());
    assert.equal(
      dom.window.document.querySelector('.workspace-conversation')!.hasAttribute('hidden'),
      false,
    );
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    const fileInput = dom.window.document.querySelector<HTMLInputElement>(
      'input[type="file"][aria-label="添加附件"]',
    )!;
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [new File(['<script>unsafe()</script>'], 'draft.txt', { type: 'text/plain' })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await attachmentSaved;
    });
    assert.equal(calls.filter((value) => value.startsWith('attachment:upload')).length, 0);
    assert.equal(visibleButton('发送').disabled, true);
    const attachmentPanel = dom.window.document.querySelector('.workspace-attachments')!;
    assert.match(attachmentPanel.textContent!, /draft.txt/);
    assert.equal(attachmentPanel.querySelector('script'), null);
    await act(async () => visibleButton('上传附件').click());
    assert.equal(
      visibleButton('发送').disabled,
      false,
      'an uploaded attachment can be sent without text',
    );
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    const attachment = state.ledger!.attachments![state.sessionId!]!.items[0]!;
    const saves: unknown[] = [];
    let completeSave: ((value: { status: string }) => void) | undefined;
    (dom.window as any).moorDesktop = {
      version: 1,
      saveAttachment: async (input: unknown) => {
        saves.push(structuredClone(input));
        return { status: 'saved' };
      },
      cancelAttachmentSave: async () => {
        calls.push('attachment:cancel-save');
        completeSave?.({ status: 'cancelled' });
      },
    };
    await act(async () => {
      state.session!.history[0]!.items!.push({
        type: 'attachment',
        attachment: attachment.reference,
      } as never);
      emit();
    });
    await act(async () => visibleButton('查看附件').click());
    const history = dom.window.document.querySelector('.workspace-history')!;
    assert.equal(history.querySelector('script'), null);
    await act(async () => visibleButton('保存附件').click());
    assert.deepEqual(saves[0], {
      scope: {
        owner: 'local-desktop',
        deviceId: 'device',
        workspaceId: 'runtime',
        localProjectId: 'project',
        sessionId: 'session',
      },
      reference: attachment.reference,
      data: attachment.data,
    });
    assert.match(history.textContent!, /附件已保存/);
    (dom.window as any).moorDesktop.saveAttachment = () =>
      new Promise((resolve) => {
        completeSave = resolve;
      });
    await act(async () => visibleButton('保存附件').click());
    assert.equal(
      project.disabled,
      false,
      'expanding a project does not navigate during an attachment save',
    );
    assert.equal(visibleButton('Local sessionsynthetic').disabled, true);
    await act(async () => {
      state.session!.history[0]!.items!.pop();
      emit();
    });
    assert(calls.includes('attachment:cancel-save'));
    await act(async () => visibleButton('移除附件').click());
    const question: QuestionRequest = {
      interactionVersion: 1,
      workspaceId: 'runtime',
      localProjectId: 'project',
      sessionId: 'session',
      expectedTurnId: 'assistant',
      requestId: 'ui-question',
      message: 'Pick <script>unsafe()</script>',
      fields: [
        { id: 'color', kind: 'text', label: 'Color', required: true, minLength: 1, maxLength: 20 },
      ],
    };
    await act(async () => {
      state.session!.history[0]!.finished = false;
      state.session!.history[0]!.items!.push(
        { type: 'agent_features', interactionCapabilities: { questions: true, steer: true } },
        { type: 'question', request: question, status: 'pending' },
      );
      emit();
    });
    await act(async () => visibleButton('等待回答 · Agent 问题').click());
    const answerInput = dom.window.document.getElementById('agent-question-0')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        answerInput,
        'green',
      );
      answerInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert(calls.includes('question:draft'));
    await act(async () => visibleButton('提交回答').click());
    assert.equal(calls.filter((value) => value === 'question:answer').length, 1);
    assert.equal(
      calls.filter((value) => value === 'send').length,
      1,
      'portal answer submission cannot submit the main composer',
    );
    await act(async () => visibleButton('关闭').click());
    await act(async () => visibleButton('回合内追加').click());
    const steerInput = dom.window.document.getElementById('steer-draft')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        steerInput,
        'Keep working',
      );
      steerInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => visibleButton('追加到活动回合').click());
    assert(calls.includes('steer:assistant:Keep working'));
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    await act(async () => {
      state.session!.history[0]!.finished = true;
      emit();
    });
    assert.equal(visibleButton('追加到活动回合').disabled, true);
    await act(async () => visibleButton('关闭').click());
    assert.equal(
      calls.some((call) => call.startsWith('content:open:')),
      false,
    );
    await act(async () => visibleButton('项目文件').click());
    assert(dom.window.document.querySelector('.project-content-panel'));
    assert.equal(calls.filter((call) => call === 'content:open:tree').length, 1);
    await act(async () => visibleButton('关闭文件与变更').click());
    assert.equal(dom.window.document.querySelector('.project-content-panel'), null);
    await act(async () => visibleButton('历史文件变更').click());
    assert.equal(calls.filter((call) => call === 'content:open:changes').length, 1);
    await act(async () => visibleButton('关闭文件与变更').click());
    assert.equal(calls.filter((call) => call === 'send').length, 1);
    assert.equal(dom.window.document.querySelector('.workspace-legacy-recovery'), null);
    assert.equal(dom.window.document.querySelector('[aria-label="恢复旧客户端草稿"]'), null);
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    const activeSession = state.sessionId;
    await act(async () => {
      state.sessions = [
        meta,
        ...Array.from({ length: 7 }, (_, index) => ({
          ...meta,
          id: 'sidebar-' + index,
          title: 'Sidebar ' + index,
          isPinned: false,
        })),
      ];
      emit();
    });
    if (project.getAttribute('aria-expanded') !== 'true') await act(async () => project.click());
    const group = dom.window.document.querySelector('.workspace-project-group')!;
    assert.equal(group.querySelectorAll('.workspace-session-row').length, 5);
    await act(async () => visibleButton('展开显示').click());
    assert.equal(group.querySelectorAll('.workspace-session-row').length, 8);
    const contextKey = () =>
      new dom.window.KeyboardEvent('keydown', {
        key: 'F10',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
    await act(async () => visibleButton('Sidebar 0synthetic').dispatchEvent(contextKey()));
    assert.match(
      dom.window.document.querySelector('[role="menu"]')!.textContent!,
      /重命名.*置顶.*归档/s,
    );
    await act(async () =>
      Array.from(dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent === '置顶')!
        .click(),
    );
    assert.equal(state.sessionId, activeSession);
    assert(calls.includes('sidebar:local:project:sidebar-0:pin'));
    assert(
      dom.window.document.querySelector('.workspace-pinned')!.textContent!.includes('Sidebar 0'),
    );
    await act(async () => visibleButton('Sidebar 0synthetic').dispatchEvent(contextKey()));
    await act(async () =>
      Array.from(dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent === '重命名')!
        .click(),
    );
    const renameInput =
      dom.window.document.querySelector<HTMLInputElement>('[aria-label="会话名称"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        renameInput,
        'conflict',
      );
      renameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () =>
      renameInput
        .closest('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    assert.match(
      dom.window.document.querySelector('[role="dialog"] [role="alert"]')!.textContent!,
      /Synthetic metadata conflict/,
    );
    assert.equal(state.sessionId, activeSession);
    await act(async () => visibleButton('取消').click());
    const selectedBeforeExpand = state.sessionId;
    const secondProject = structuredClone(catalog.targets[0]!);
    secondProject.projectName = 'Second project';
    secondProject.target.localProjectId = 'project-two';
    secondProject.target.catalogProjectId = 'logical-two';
    secondProject.target.replicaId = 'replica-two';
    secondProject.runtime.agents[0]!.id = 'agent-two';
    await act(async () => {
      catalog.targets.push(secondProject);
      state.catalogs.local = catalog;
      emit();
    });
    const secondHeading = visibleButton('Second projectMy Mac · 本机');
    const beforeExpand = calls.length;
    await act(async () => secondHeading.click());
    assert.equal(secondHeading.getAttribute('aria-expanded'), 'true');
    assert.equal(state.sessionId, selectedBeforeExpand);
    assert.equal(calls.length, beforeExpand);
    await act(async () => project.click());
    assert.equal(
      secondHeading.getAttribute('aria-expanded'),
      'true',
      'projects expand independently',
    );
    await act(async () => visibleButton('在 Second project 中新建对话').click());
    assert.equal(state.scope!.target.localProjectId, 'project-two');
    assert(
      calls.includes('create-agent:agent-two'),
      'new conversation chooses an Agent from the clicked project',
    );
    assert.equal(calls.filter((value) => value === 'send').length, 1);
    const { useNavigationSessions } =
      await import('../../apps/web/src/features/sessions/workspace-navigation');
    let listRevision = 0,
      releaseLists!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseLists = resolve;
    });
    const listReads: number[] = [];
    const listing = {
      get navigationRevision() {
        return listRevision;
      },
      async listProjectSessions(_source: string, target: typeof secondProject.target) {
        const version = listRevision;
        listReads.push(version);
        if (listReads.length <= 2) await listGate;
        return [{ ...meta, id: target.localProjectId, title: 'revision-' + version }];
      },
    } as unknown as WorkspaceController;
    function NavigationProbe() {
      const value = useNavigationSessions(listing, {
        ...state,
        project: undefined,
        scope: undefined,
        sessions: [],
      });
      return createElement(
        'output',
        { 'data-testid': 'navigation-values' },
        JSON.stringify(value.sessions),
      );
    }
    await act(async () => root.render(createElement(NavigationProbe)));
    assert.equal(listReads.length, 2);
    for (let index = 1; index <= 20; index++) {
      listRevision = index;
      await act(async () => root.render(createElement(NavigationProbe)));
    }
    assert.equal(listReads.length, 2, 'bursts cannot restart in-flight project reads');
    await act(async () => {
      releaseLists();
      await listGate;
    });
    assert.deepEqual(
      listReads,
      [0, 0, 20, 20],
      'each project catches up directly to the latest requested revision',
    );
    assert.match(
      dom.window.document.querySelector('[data-testid="navigation-values"]')!.textContent!,
      /revision-20/,
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
