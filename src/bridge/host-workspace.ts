import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Flock, LoroDoc, delta, metas, mirror, putMeta } from '../model';
import { assert, sessionActionSchema, type Mutation, type SessionAction } from '../protocol';
import { validateMutation } from './validate-mutation';
import { RuntimeStore, type AttachmentScope } from '../runtime/store';
import type {
  AgentConfig,
  AgentDriver,
  AgentSession,
  AgentRunBinding,
  PermissionOutcome,
} from '../runtime/agent';
import { runCapabilitiesSchema } from '../run-config';
import {
  CONTENT_VERSION,
  FILE_CONTENT_FEATURE,
  projectFileReadSchema,
  type ProjectFileRead,
  type ProjectFileResult,
  type ContentScope,
  type AttachmentReference,
} from '../content-protocol';
import { readProjectFileBytes } from '../runtime/project-files';
import {
  normalizeAgentContent,
  normalizeAgentToolContent,
  safeAgentMetadata,
} from '../runtime/agent-attachments';
import {
  ATTACHMENTS_FEATURE,
  MAX_SESSION_ATTACHMENT_BYTES,
  attachmentActionSchema,
  attachmentReadSchema,
  promptInputCapabilitiesSchema,
  type AttachmentAction,
  type AttachmentRead,
  type AttachmentReceipt,
  type AttachmentContent,
  type PromptInputCapabilities,
} from '../attachment-protocol';

import {
  PROJECT_TREE_FEATURE,
  PROJECT_DIFF_FEATURE,
  projectTreeReadSchema,
  projectTurnDiffReadSchema,
  projectDiffFileReadSchema,
  projectTreeResultSchema,
  projectTurnDiffResultSchema,
  projectDiffFileResultSchema,
  projectDiffReferenceSchema,
  type ProjectTreeRead,
  type ProjectTreeResult,
  type ProjectTurnDiffRead,
  type ProjectTurnDiffResult,
  type ProjectDiffFileRead,
  type ProjectDiffFileResult,
  type ProjectDiffReference,
  type ProjectContentIssue,
} from '../project-content-protocol';
import {
  captureProjectSnapshot,
  enumerateProjectFiles,
  type ProjectSnapshot,
} from '../runtime/project-snapshot';
import type { ProjectHistoryScope } from '../runtime/project-history';
import { searchHostSessions } from './host-search';
import { SESSION_SEARCH_FEATURE, type SessionSearchRequest } from '../search-protocol';
import {
  QUESTIONS_FEATURE,
  STEER_FEATURE,
  questionRequestSchema,
  type QuestionAnswer,
  type SteerRequest,
} from '../interaction-protocol';
import {
  SessionInteractions,
  cancelledQuestionAnswer,
  expireSessionInteractions,
  type InteractionTurn,
} from './session-interactions';
import {
  runtimeFeatureReportSchema,
  sessionEventSchema,
  sessionEventStateSchema,
  type SessionEvent,
} from '../runtime/session-events';
import {
  NOTIFICATIONS_FEATURE,
  NOTIFICATION_LIMITS,
  type HostNotificationEvent,
} from '../notification-protocol';

type Active = {
  turnId: string;
  userTurnId: string;
  doc: LoroDoc;
  session?: AgentSession;
  stopped: boolean;
  done?: Promise<void>;
  projectScope: ProjectHistoryScope;
  rootPath: string;
  before?: ProjectSnapshot;
  snapshotIssues: ProjectContentIssue[];
  terminal?: { status: string; message?: string };
  finalizing?: Promise<void>;
  permissions: Map<
    string,
    { options: any[]; resolve: (value: { outcome: PermissionOutcome }) => void }
  >;
};
export class HostWorkspace {
  closed = false;
  locks = new Map<string, Promise<unknown>>();
  active = new Map<string, Active>();
  settlementFailures = new Map<string, LoroDoc>();
  interactions: SessionInteractions<Active>;
  watches = new Set<string>();
  get workspace() {
    return this.store.workspace;
  }
  get meta() {
    return this.store.meta;
  }
  get machine() {
    return this.store.machine;
  }
  constructor(
    public store: RuntimeStore,
    private driver: AgentDriver,
    private catalogue: () => void,
    private changed: (sessionId?: string) => void,
    private fileReader = readProjectFileBytes,
    private projectContent = { capture: captureProjectSnapshot, tree: enumerateProjectFiles },
  ) {
    this.interactions = new SessionInteractions<Active>({
      journal: store.journal,
      getRun: (sessionId) => this.active.get(sessionId),
      serial: (sessionId, work) => this.serial(sessionId, work),
      scopeCheck: (scope, localProjectId) => {
        const lease = this.projectLease(scope, localProjectId);
        return { userId: lease.userId, machineId: lease.machineId, rootPath: lease.rootPath };
      },
      persist: (sessionId, run, edit, write) =>
        this.persistInteraction(sessionId, run, edit, write),
    });
    this.updateCatalogue();
  }
  ensureConnected() {
    assert(!this.closed, 409, '本机执行服务已停止，指令未送达');
  }
  async ready() {
    this.ensureConnected();
  }
  updateCatalogue() {
    this.workspace.features = [
      'session-actions',
      FILE_CONTENT_FEATURE,
      ATTACHMENTS_FEATURE,
      PROJECT_TREE_FEATURE,
      PROJECT_DIFF_FEATURE,
      SESSION_SEARCH_FEATURE,
      QUESTIONS_FEATURE,
      STEER_FEATURE,
      NOTIFICATIONS_FEATURE,
    ];
    this.workspace.projects = this.machine
      .scan({ prefix: ['localProject'] })
      .map((r) => r.value as any);
    this.workspace.agents = this.machine
      .scan({ prefix: ['agentConfig'] })
      .map((r) => r.value as AgentConfig)
      .filter((a) => a.machineId === this.workspace.machineId)
      .map((a) => {
        const options = runCapabilitiesSchema.safeParse(this.machine.get(['capabilities', a.id]));
        const input = promptInputCapabilitiesSchema.safeParse(
          this.machine.get(['inputCapabilities', a.id]),
        );
        return {
          id: a.id,
          name: a.name,
          cliType: a.cliType,
          agentType: a.agentType,
          runConfig: options.success ? options.data : undefined,
          inputCapabilities: input.success ? input.data : undefined,
        };
      });
    this.catalogue();
  }
  async refreshAgentOptions(agentId: string, localProjectId?: string) {
    return this.serial('capabilities/' + agentId, async () => {
      this.ensureConnected();
      const agent = this.machine.get(['agentConfig', agentId]) as AgentConfig | undefined;
      const project =
        this.workspace.projects.find((p) => p.id === localProjectId) ??
        (!localProjectId ? this.workspace.projects[0] : undefined);
      assert(agent?.machineId === this.workspace.machineId, 404, 'Agent 配置不可用');
      assert(project, 404, '请先登记项目');
      const session = await this.driver.open(agent, project.rootPath, undefined, {
        update: () => {},
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      });
      try {
        this.ensureConnected();
        this.machine.set(['capabilities', agentId], session.capabilities as never);
        this.machine.set(['inputCapabilities', agentId], session.inputCapabilities as never);
        this.store.saveMachine();
        this.updateCatalogue();
        return this.workspace.agents.find((a) => a.id === agentId)!;
      } finally {
        session.close();
      }
    });
  }
  async watch(sessionId: string, on: boolean) {
    this.ensureConnected();
    if (on && metas(this.meta)['session-' + sessionId]?.machineId === this.workspace.machineId)
      this.watches.add(sessionId);
    else this.watches.delete(sessionId);
  }
  list(localProjectId?: string) {
    this.ensureConnected();
    return Object.entries(metas(this.meta))
      .filter(
        ([name, m]) =>
          name.startsWith('session-') &&
          m.id &&
          m.machineId === this.workspace.machineId &&
          (!localProjectId || (m.project as any)?.localProjectId === localProjectId),
      )
      .map(([, m]) => m)
      .sort((a: any, b: any) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }
  checkProject(sessionId: string, localProjectId?: string) {
    const meta = metas(this.meta)['session-' + sessionId];
    assert(
      meta?.machineId === this.workspace.machineId && meta.userId === this.workspace.userId,
      404,
      '会话不属于这台电脑',
    );
    if (localProjectId)
      assert((meta.project as any)?.localProjectId === localProjectId, 404, '会话不属于该项目副本');
  }
  async read(sessionId: string, version?: string, localProjectId?: string) {
    this.ensureConnected();
    this.checkProject(sessionId, localProjectId);
    return {
      meta: metas(this.meta)['session-' + sessionId],
      metaBundle: this.meta.exportJson(),
      update: delta(
        this.active.get(sessionId)?.doc ??
          this.settlementFailures.get(sessionId) ??
          this.store.doc(sessionId),
        version,
      ),
      synced: true,
      persisted: !this.settlementFailures.has(sessionId),
      ...(this.settlementFailures.has(sessionId)
        ? { persistenceError: 'Agent 回合已停止，但结果尚未保存；请重启执行服务后再发送新的指令。' }
        : {}),
      online: true,
    };
  }
  async sessionAction(input: SessionAction, localProjectId?: string) {
    const action = sessionActionSchema.parse(input);
    return this.serial(action.sessionId, async () => {
      this.ensureConnected();
      assert(action.workspaceId === this.workspace.id, 400, '会话执行目标不匹配');
      assert(
        this.workspace.projects.some((project) => project.id === action.localProjectId),
        404,
        '项目副本已从主机移除',
      );
      assert(
        !localProjectId || action.localProjectId === localProjectId,
        400,
        '执行项目与副本不匹配',
      );
      // Scope is checked before looking up a receipt, including an accepted retry.
      this.checkProject(action.sessionId, action.localProjectId);
      const journal = this.store.journal;
      const receipt = journal.lookup(this.workspace.id, action);
      if (receipt?.phase === 'accepted') return JSON.parse(receipt.result);
      const name = 'session-' + action.sessionId,
        current = metas(this.meta)[name],
        revision = current.metadataRevision ?? 0;
      assert(revision === action.expectedRevision, 409, '会话信息已更新，请刷新后重试');
      if (action.action === 'archive') {
        const view = mirror(this.store.doc(action.sessionId), action.sessionId);
        const pending = view
          .getState()
          .history.some(
            (turn) =>
              (turn.role === 'assistant' && !turn.finished) ||
              (turn.role === 'user' && !turn.read && turn.status === 'pending'),
          );
        view.dispose();
        assert(
          !this.active.has(action.sessionId) &&
            (current.status as any)?.type !== 'working' &&
            (!current.latestUserMsgId ||
              current.latestUserMsgId === current.lastHandledUserMsgId) &&
            !pending,
          409,
          '请等待当前指令完成或停止后再归档',
        );
      }
      const next = Flock.fromFile(this.meta.exportFile());
      putMeta(next, name, {
        isArchived: current.isArchived === true,
        isPinned: current.isPinned === true,
        metadataRevision: action.expectedRevision + 1,
        ...(action.action === 'rename' ? { title: action.title, titleSource: 'user' } : {}),
        ...(['archive', 'restore'].includes(action.action)
          ? { isArchived: action.action === 'archive' }
          : {}),
        ...(['pin', 'unpin'].includes(action.action) ? { isPinned: action.action === 'pin' } : {}),
      });
      const result = this.store.transaction(() => {
        this.store.save('meta', next.exportFile());
        return journal.acceptSessionAction(this.workspace.id, action, metas(next)[name]);
      });
      this.store.meta = next;
      this.changed(action.sessionId);
      return result;
    });
  }
  async readProjectFile(
    input: ProjectFileRead,
    localProjectId?: string,
  ): Promise<ProjectFileResult> {
    const request = projectFileReadSchema.parse(input);
    const scope = () => {
      this.ensureConnected();
      assert(request.workspaceId === this.workspace.id, 400, '文件读取目标不匹配');
      assert(
        !localProjectId || request.localProjectId === localProjectId,
        400,
        '读取项目与副本不匹配',
      );
      this.checkProject(request.sessionId, request.localProjectId);
      const project = this.machine.get(['localProject', request.localProjectId]) as
        | { id: string; rootPath: string }
        | undefined;
      assert(
        project?.id === request.localProjectId &&
          this.workspace.projects.some(
            (item) => item.id === project.id && item.rootPath === project.rootPath,
          ),
        404,
        '项目副本已从主机移除',
      );
      return {
        rootPath: project.rootPath,
        userId: this.workspace.userId,
        machineId: this.workspace.machineId,
      };
    };
    const before = scope();
    const { bytes, content } = await this.fileReader(before.rootPath, request.path);
    const after = scope();
    assert(
      before.rootPath === after.rootPath &&
        before.userId === after.userId &&
        before.machineId === after.machineId,
      409,
      '文件读取范围已变化，请重试',
    );
    const base: Omit<ProjectFileResult, 'status'> = {
      contentVersion: CONTENT_VERSION,
      workspaceId: request.workspaceId,
      localProjectId: request.localProjectId,
      sessionId: request.sessionId,
      path: request.path,
      content,
      confirmed: true as const,
    };
    return request.knownVersion === content.version
      ? { ...base, status: 'not-modified' }
      : { ...base, status: 'content', encoding: 'base64', data: bytes.toString('base64') };
  }
  projectLease(input: ContentScope, localProjectId?: string) {
    const scope = this.attachmentScope(input, localProjectId);
    this.checkProject(input.sessionId, input.localProjectId);
    const rootPath = this.workspace.projects.find(
      (project) => project.id === input.localProjectId,
    )!.rootPath;
    return { ...scope, rootPath };
  }
  checkProjectLease(lease: ProjectHistoryScope & { rootPath: string }) {
    const current = this.projectLease(lease);
    assert(isDeepStrictEqual(current, lease), 409, '项目执行范围已变化');
  }
  searchSessions(input: SessionSearchRequest, localProjectId?: string) {
    return searchHostSessions(this, input, localProjectId);
  }
  isNotificationCurrent(event: HostNotificationEvent) {
    if (event.expiresAt <= this.store.notifications.now()) return false;
    try {
      const stored = this.store.notifications.get(event.eventId, true);
      if (!stored || !isDeepStrictEqual(stored, event)) return false;
      const lease = this.projectLease({
        workspaceId: event.workspaceId,
        localProjectId: event.localProjectId,
        sessionId: event.sessionId,
      });
      if (
        lease.userId !== event.userId ||
        lease.machineId !== event.machineId ||
        metas(this.meta)['session-' + event.sessionId]?.id !== event.sessionId
      )
        return false;
      if (event.kind !== 'approval-required') return !!this.store.searchSource(event.sessionId);
      const run = this.active.get(event.sessionId);
      if (
        !run ||
        run.turnId !== event.turnId ||
        run.stopped ||
        !run.permissions.has(event.requestId!)
      )
        return false;
      return this.boundRun(event.sessionId, run, this.runBinding(event.sessionId, run));
    } catch {
      return false;
    }
  }
  pendingNotifications(channel: string, limit = 100): HostNotificationEvent[] {
    this.ensureConnected();
    assert(
      Number.isInteger(limit) && limit > 0 && limit <= NOTIFICATION_LIMITS.events,
      400,
      '通知数量限制无效',
    );
    const result: HostNotificationEvent[] = [];
    for (const event of this.store.notifications.pending(channel, NOTIFICATION_LIMITS.events)) {
      if (!this.isNotificationCurrent(event)) this.store.notifications.discard(event.eventId);
      else if (result.length < limit) result.push(event);
    }
    return result;
  }
  acknowledgeNotification(channel: string, eventId: string, status: 'submitted' | 'suppressed') {
    const event = this.store.notifications.get(eventId);
    if (!event) return;
    if (this.isNotificationCurrent(event))
      this.store.notifications.acknowledge(channel, eventId, status);
    else this.store.notifications.discard(eventId);
  }
  retryNotification(channel: string, eventId: string, delayMs = 2000) {
    const event = this.store.notifications.get(eventId);
    if (!event) return;
    if (this.isNotificationCurrent(event))
      this.store.notifications.retry(channel, eventId, delayMs);
    else this.store.notifications.discard(eventId);
  }
  answerQuestion(input: QuestionAnswer, localProjectId?: string) {
    return this.interactions.answerQuestion(input, localProjectId);
  }
  steer(input: SteerRequest, localProjectId?: string) {
    return this.interactions.steer(input, localProjectId);
  }
  persistInteraction(
    id: string,
    run: Active | undefined,
    edit: ((turn: InteractionTurn) => void) | undefined,
    write?: () => void,
  ) {
    this.ensureConnected();
    assert(!run || this.active.get(id) === run, 409, '原交互回合已变化');
    const doc = run && edit ? new LoroDoc() : undefined;
    if (doc) doc.import(run!.doc.export({ mode: 'snapshot' }));
    const view = doc ? mirror(doc, id) : undefined;
    try {
      this.store.transaction(() => {
        if (view && doc) {
          view.setState((state) => {
            const turn = state.history.find((turn) => turn.id === run!.turnId);
            assert(turn, 409, '原交互回合已变化');
            edit!(turn);
          });
          this.store.persist(id, doc);
        }
        write?.();
      });
      if (doc) run!.doc = doc;
    } finally {
      view?.dispose();
    }
    if (doc) this.changed(id);
  }
  runBinding(id: string, run: Active): AgentRunBinding {
    return {
      workspaceId: run.projectScope.workspaceId,
      localProjectId: run.projectScope.localProjectId,
      sessionId: id,
      expectedTurnId: run.turnId,
    };
  }
  boundRun(id: string, run: Active, binding: AgentRunBinding) {
    if (
      this.closed ||
      run.stopped ||
      this.active.get(id) !== run ||
      !isDeepStrictEqual(binding, this.runBinding(id, run))
    )
      return false;
    try {
      this.checkProjectLease({ ...run.projectScope, rootPath: run.rootPath });
      return true;
    } catch {
      return false;
    }
  }
  sessionEvent(id: string, run: Active, input: SessionEvent, binding: AgentRunBinding) {
    if (!this.boundRun(id, run, binding)) return;
    const parsed = sessionEventSchema.safeParse(input);
    if (!parsed.success) return;
    this.edit(id, run, (turn) => this.applyTurnEvent(turn, parsed.data));
  }
  applyTurnEvent(turn: InteractionTurn, event: SessionEvent) {
    const items = (turn.items ??= []);
    // Each turn freezes its latest bounded observations. Replacing an existing
    // observation keeps ordinary message/tool navigation indexes stable.
    const key = (value: SessionEvent) =>
      value.kind === 'plan' || value.kind === 'plan-removed'
        ? ['plan', value.planId ?? null]
        : [value.kind];
    const existing = items.findIndex(
      (item) => item?.type === 'session_event' && isDeepStrictEqual(key(item.event), key(event)),
    );
    const item = { type: 'session_event', event };
    if (existing >= 0) items[existing] = item;
    else if (items.filter((item) => item?.type === 'session_event').length < 104) items.push(item);
    else if (!items.some((item) => item?.type === 'system_notice' && item.name === 'event_limit'))
      items.push({
        type: 'system_notice',
        name: 'event_limit',
        message: '运行事件数量达到历史保存上限；部分计划快照未保存。',
      });
  }
  saveAgentFeatures(id: string, run: Active, session: AgentSession) {
    const runtime = runtimeFeatureReportSchema.safeParse(session.runtimeFeatures);
    const current = sessionEventStateSchema.safeParse(session.currentEvents);
    const capabilities = session.interactionCapabilities;
    this.edit(id, run, (turn) => {
      (turn.items ??= []).push({
        type: 'agent_features',
        ...(runtime.success ? { runtimeFeatures: runtime.data } : {}),
        interactionCapabilities: {
          questions: capabilities?.questions === true,
          steer: capabilities?.steer === true && typeof session.steer === 'function',
          ...(typeof capabilities?.steerUnavailableReason === 'string'
            ? { steerUnavailableReason: capabilities.steerUnavailableReason.slice(0, 1000) }
            : {}),
        },
      });
      if (current.success) {
        const state = current.data;
        if (state.commands)
          this.applyTurnEvent(turn, {
            version: 1,
            source: 'acp',
            kind: 'commands',
            commands: state.commands,
          });
        for (const plan of state.plans)
          this.applyTurnEvent(turn, { version: 1, source: 'acp', kind: 'plan', ...plan });
        if (state.contextUsage) this.applyTurnEvent(turn, state.contextUsage);
        if (state.tokenUsage) this.applyTurnEvent(turn, state.tokenUsage);
      }
    });
  }
  projectTurn(input: ContentScope & { turnId: string }, localProjectId?: string) {
    const lease = this.projectLease(input, localProjectId);
    const view = mirror(
      this.active.get(input.sessionId)?.doc ??
        this.settlementFailures.get(input.sessionId) ??
        this.store.doc(input.sessionId),
      input.sessionId,
    );
    const turn = view
      .getState()
      .history.find((turn) => turn.id === input.turnId && turn.role === 'assistant');
    const reference = projectDiffReferenceSchema.safeParse(turn?.fileDiff);
    view.dispose();
    assert(turn, 404, '回合不属于当前会话');
    return { lease, reference: reference.success ? reference.data : undefined };
  }
  async readProjectTree(
    input: ProjectTreeRead,
    localProjectId?: string,
  ): Promise<ProjectTreeResult> {
    const request = projectTreeReadSchema.parse(input),
      lease = this.projectLease(request, localProjectId);
    const tree = await this.projectContent.tree(lease.rootPath);
    this.checkProjectLease(lease);
    const version = 'sha256:' + createHash('sha256').update(JSON.stringify(tree)).digest('hex');
    assert(
      !request.knownVersion || request.knownVersion === version,
      409,
      '项目文件树已变化，请从第一页刷新',
    );
    const offset = request.offset ?? 0,
      limit = request.limit ?? 200;
    assert(offset <= tree.entries.length, 409, '文件树分页已失效，请刷新');
    const entries = tree.entries.slice(offset, offset + limit),
      nextOffset = offset + entries.length;
    return projectTreeResultSchema.parse({
      contentVersion: 1,
      workspaceId: request.workspaceId,
      localProjectId: request.localProjectId,
      sessionId: request.sessionId,
      confirmed: true,
      version,
      source: tree.source,
      entries,
      offset,
      total: tree.entries.length,
      ...(nextOffset < tree.entries.length ? { nextOffset } : {}),
      partial: tree.partial,
      enumerationComplete: tree.enumerationComplete,
      issues: tree.issues,
    });
  }
  async readTurnDiff(
    input: ProjectTurnDiffRead,
    localProjectId?: string,
  ): Promise<ProjectTurnDiffResult> {
    const request = projectTurnDiffReadSchema.parse(input),
      { lease, reference } = this.projectTurn(request, localProjectId);
    const saved = this.store.projectHistory.read(lease, request.turnId);
    const failedPersistence =
      !!reference &&
      (!saved || (reference.state === 'unavailable' && saved.reference.state === 'pending'));
    return projectTurnDiffResultSchema.parse({
      contentVersion: 1,
      workspaceId: request.workspaceId,
      localProjectId: request.localProjectId,
      sessionId: request.sessionId,
      confirmed: true,
      turnId: request.turnId,
      state: failedPersistence ? 'unavailable' : (saved?.reference.state ?? 'not-recorded'),
      ...(failedPersistence
        ? { reference: { ...reference!, state: 'unavailable', changeCount: 0 } }
        : saved
          ? { reference: saved.reference }
          : {}),
      changes: failedPersistence ? [] : (saved?.changes ?? []),
      partial: failedPersistence || saved?.partial !== false,
      issues: failedPersistence
        ? [{ reason: 'persistence-failed' }]
        : (saved?.issues ?? [{ reason: 'not-recorded' }]),
      attribution: 'shared-project',
    });
  }
  async readDiffFile(
    input: ProjectDiffFileRead,
    localProjectId?: string,
  ): Promise<ProjectDiffFileResult> {
    const request = projectDiffFileReadSchema.parse(input),
      { lease } = this.projectTurn(request, localProjectId);
    const content = this.store.projectHistory.readFile(
      lease,
      request.turnId,
      request.path,
      request.knownVersion,
    );
    return projectDiffFileResultSchema.parse({
      contentVersion: 1,
      workspaceId: request.workspaceId,
      localProjectId: request.localProjectId,
      sessionId: request.sessionId,
      confirmed: true,
      turnId: request.turnId,
      path: request.path,
      ...content,
      attribution: 'shared-project',
    });
  }
  attachmentScope(input: ContentScope, localProjectId?: string): AttachmentScope {
    this.ensureConnected();
    assert(input.workspaceId === this.workspace.id, 400, '附件执行目标不匹配');
    assert(!localProjectId || input.localProjectId === localProjectId, 400, '附件项目与副本不匹配');
    const project = this.machine.get(['localProject', input.localProjectId]) as
      | { id: string; rootPath: string }
      | undefined;
    assert(
      project?.id === input.localProjectId &&
        this.workspace.projects.some((p) => p.id === project.id && p.rootPath === project.rootPath),
      404,
      '项目副本已从主机移除',
    );
    if (metas(this.meta)['session-' + input.sessionId])
      this.checkProject(input.sessionId, input.localProjectId);
    const scope = {
      workspaceId: input.workspaceId,
      localProjectId: input.localProjectId,
      sessionId: input.sessionId,
      userId: this.workspace.userId,
      machineId: this.workspace.machineId,
    };
    assert(this.store.attachmentScopeMatches(scope), 404, '附件会话不属于该项目副本');
    return scope;
  }
  async attachmentAction(
    input: AttachmentAction,
    localProjectId?: string,
  ): Promise<AttachmentReceipt> {
    const action = attachmentActionSchema.parse(input);
    return this.serial(action.sessionId, async () => {
      const scope = this.attachmentScope(action, localProjectId);
      const journal = this.store.journal;
      const receipt = journal.lookup(this.workspace.id, action);
      if (receipt?.phase === 'accepted') return JSON.parse(receipt.result);
      const id = action.action === 'upload' ? action.attachment.attachmentId : action.attachmentId;
      const stored = this.store.attachment(scope, id);
      let bytes: Buffer | undefined;
      if (action.action === 'upload') {
        assert(
          metas(this.meta)['session-' + action.sessionId]?.isArchived !== true,
          409,
          '请先恢复已归档会话，再上传附件',
        );
        assert(!stored, 409, '附件编号已使用，请重新添加附件');
        bytes = Buffer.from(action.data, 'base64');
        assert(
          bytes.length === action.attachment.content.byteLength &&
            'sha256:' + createHash('sha256').update(bytes).digest('hex') ===
              action.attachment.content.version,
          400,
          '附件内容摘要或字节数不匹配',
        );
        assert(
          this.store.attachmentBytes(scope) + bytes.length <= MAX_SESSION_ATTACHMENT_BYTES,
          413,
          '会话附件总量超过 64 MiB，请移除未发送的附件',
        );
      } else {
        assert(stored, 404, '附件不存在');
        assert(!stored.referenced, 409, '历史回合使用的附件不能删除');
      }
      return this.store.transaction(() => {
        this.store.reserveAttachmentScope(scope);
        if (action.action === 'upload') this.store.saveAttachment(scope, action.attachment, bytes!);
        else this.store.removeAttachment(scope, id);
        const result: AttachmentReceipt = {
          contentVersion: CONTENT_VERSION,
          workspaceId: action.workspaceId,
          localProjectId: action.localProjectId,
          sessionId: action.sessionId,
          operationId: action.operationId,
          accepted: true,
          delivered: true,
          ...(action.action === 'upload'
            ? { attachment: action.attachment }
            : { removed: true as const }),
        };
        return journal.acceptAttachmentAction(this.workspace.id, action, result);
      });
    });
  }
  async readAttachment(input: AttachmentRead, localProjectId?: string): Promise<AttachmentContent> {
    const request = attachmentReadSchema.parse(input);
    return this.serial(request.sessionId, async () => {
      const scope = this.attachmentScope(request, localProjectId);
      const stored = this.store.attachment(scope, request.attachmentId);
      assert(stored?.bytes, 404, '附件不存在或已删除');
      return {
        contentVersion: CONTENT_VERSION,
        workspaceId: request.workspaceId,
        localProjectId: request.localProjectId,
        sessionId: request.sessionId,
        confirmed: true,
        attachment: stored.reference,
        data: stored.bytes.toString('base64'),
      };
    });
  }
  attachmentData(scope: AttachmentScope, attachments: AttachmentReference[]) {
    return attachments.map((reference) => {
      const stored = this.store.attachment(scope, reference.attachmentId);
      assert(
        stored?.bytes && isDeepStrictEqual(stored.reference, reference),
        400,
        '附件尚未送达、已删除或不属于当前会话',
      );
      return { reference, data: stored.bytes.toString('base64') };
    });
  }
  assertAttachmentCapabilities(
    attachments: AttachmentReference[],
    capabilities?: PromptInputCapabilities,
  ) {
    for (const attachment of attachments) {
      const category = attachment.content.mediaType.split('/')[0];
      assert(
        capabilities?.[
          category === 'image' ? 'image' : category === 'audio' ? 'audio' : 'embeddedContext'
        ] === true,
        400,
        '当前 Agent 不支持该附件类型，请刷新能力或移除附件',
      );
    }
  }
  async mutate(m: Mutation, localProjectId?: string) {
    return this.serial(m.sessionId, async () => {
      this.ensureConnected();
      assert(
        m.workspaceId === this.workspace.id && /^[A-Za-z0-9_-]{1,160}$/.test(m.sessionId),
        400,
        '会话执行目标不匹配',
      );
      const currentMeta = metas(this.meta)['session-' + m.sessionId];
      if (currentMeta)
        this.attachmentScope(
          {
            workspaceId: m.workspaceId,
            sessionId: m.sessionId,
            localProjectId: (currentMeta.project as any)?.localProjectId,
          },
          localProjectId,
        );
      const journal = this.store.journal;
      const record = journal.lookup(this.workspace.id, m);
      if (metas(this.meta)['session-' + m.sessionId] || record)
        this.checkProject(m.sessionId, localProjectId);
      if (record?.phase === 'accepted') return JSON.parse(record.result);
      assert(
        !this.settlementFailures.has(m.sessionId),
        409,
        '上次回合结果尚未保存，请重启执行服务后再发送新的指令',
      );
      const active = this.active.get(m.sessionId);
      const original = active?.doc ?? this.store.doc(m.sessionId);
      const validated = validateMutation(original, this.meta, this.workspace, m);
      const meta = metas(validated.flock)['session-' + m.sessionId];
      if (!metas(this.meta)['session-' + m.sessionId])
        putMeta(validated.flock, 'session-' + m.sessionId, {
          metadataRevision: 0,
          isPinned: false,
          isArchived: false,
        });
      if (localProjectId)
        assert(
          (meta.project as any)?.localProjectId === localProjectId,
          400,
          '执行项目与副本不匹配',
        );
      const attachmentScope = this.attachmentScope(
        {
          workspaceId: m.workspaceId,
          sessionId: m.sessionId,
          localProjectId: (meta.project as any).localProjectId,
        },
        localProjectId,
      );
      const inputView = mirror(validated.doc, m.sessionId);
      const attachments: AttachmentReference[] =
        m.kind === 'turn'
          ? ((
              inputView.getState().history.at(-1)!.inputConfig as {
                attachments?: AttachmentReference[];
              }
            ).attachments ?? [])
          : [];
      inputView.dispose();
      if (attachments.length) {
        this.attachmentData(attachmentScope, attachments);
        const capabilities = this.workspace.agents.find(
          (agent) => agent.id === meta.agentConfigId,
        )?.inputCapabilities;
        this.assertAttachmentCapabilities(attachments, capabilities);
      }
      const turnId = String(meta.latestUserMsgId);
      let permission: Active['permissions'] extends Map<string, infer V> ? V : never;
      let outcome: PermissionOutcome | undefined;
      if (m.kind === 'permission') {
        assert(active && !active.stopped, 409, '审批回合已失效');
        const pending = active.permissions.get(m.requestId!);
        assert(pending, 409, '审批请求已失效');
        permission = pending;
        const view = mirror(validated.doc, m.sessionId);
        const turn = view.getState().history.find((t) => t.id === active.turnId);
        outcome = (
          turn?.items?.find((i: any) => i.permissionRequest?.requestId === m.requestId) as any
        )?.permissionRequest.outcome;
        view.dispose();
        assert(outcome, 409, '审批不属于当前回合');
      } else assert(!active && this.active.size < 32, 409, 'Agent 正在运行或并发会话过多');
      const previousMeta = this.store.meta;
      let result: ReturnType<typeof journal.accept>;
      const assistantId = randomUUID();
      if (m.kind === 'turn') {
        const view = mirror(validated.doc, m.sessionId);
        view.setState((s) => {
          const user = s.history.find((t) => t.id === turnId)!;
          user.read = true;
          user.status = 'processing';
          s.history.push({
            userId: undefined,
            status: undefined,
            read: undefined,
            inputConfig: undefined,
            id: assistantId,
            userTurnId: turnId,
            role: 'assistant',
            timestamp: new Date().toISOString(),
            finished: false,
            items: [],
            fileDiff: null,
          });
        });
        view.dispose();
        putMeta(validated.flock, 'session-' + m.sessionId, {
          lastHandledUserMsgId: turnId,
          status: { type: 'working' },
        });
      }
      try {
        result = this.store.transaction(() => {
          journal.stage(this.workspace.id, m, turnId);
          this.store.reserveAttachmentScope(attachmentScope);
          for (const attachment of attachments)
            this.store.referenceAttachment(attachmentScope, attachment.attachmentId);
          this.store.meta = validated.flock;
          if (m.kind === 'turn') {
            const reference = this.store.projectHistory.begin(attachmentScope, assistantId);
            const view = mirror(validated.doc, m.sessionId);
            view.setState((state) => {
              state.history.find((turn) => turn.id === assistantId)!.fileDiff = reference;
            });
            view.dispose();
          }
          this.store.persist(m.sessionId, validated.doc);
          if (m.kind === 'permission')
            this.store.notifications.resolveApprovals(
              { ...attachmentScope, turnId: active!.turnId },
              m.requestId,
            );
          return journal.accept(m);
        });
      } catch (error) {
        this.store.meta = previousMeta;
        throw error;
      }
      if (m.kind === 'permission') {
        active!.doc = validated.doc;
        active!.permissions.delete(m.requestId!);
        permission!.resolve({ outcome: outcome! });
      } else {
        const run: Active = {
          turnId: assistantId,
          userTurnId: turnId,
          doc: validated.doc,
          stopped: false,
          projectScope: attachmentScope,
          rootPath: this.workspace.projects.find(
            (project) => project.id === attachmentScope.localProjectId,
          )!.rootPath,
          snapshotIssues: [],
          permissions: new Map(),
        };
        this.active.set(m.sessionId, run);
        run.done = this.execute(m.sessionId, run);
      }
      this.changed(m.sessionId);
      return result;
    });
  }
  edit(id: string, run: Active, edit: (turn: any) => void, terminal = false) {
    if ((run.stopped && !terminal) || this.closed) return;
    const view = mirror(run.doc, id);
    try {
      this.store.transaction(() => {
        view.setState((s) => edit(s.history.find((t) => t.id === run.turnId)!));
        this.store.persist(id, run.doc);
      });
    } catch (error) {
      // Restore the last committed in-memory state too; otherwise a later chunk
      // could persist a reference to a blob rolled back by this failed update.
      run.doc = this.store.doc(id);
      this.store.meta = this.store.loadFlock('meta');
      throw error;
    } finally {
      view.dispose();
    }
    this.changed(id);
  }
  update(id: string, run: Active, update: any) {
    this.edit(id, run, (turn) => {
      const items = (turn.items ??= []);
      const meta = metas(this.meta)['session-' + id];
      const scope = this.attachmentScope({
        workspaceId: this.workspace.id,
        localProjectId: (meta.project as any).localProjectId,
        sessionId: id,
      });
      const save = (reference: AttachmentReference, bytes: Buffer) => {
        const existing = this.store.generatedAttachment(scope, reference);
        if (existing) return existing;
        assert(
          this.store.attachmentBytes(scope) + bytes.length <= MAX_SESSION_ATTACHMENT_BYTES,
          413,
          '会话附件容量不足',
        );
        this.store.reserveAttachmentScope(scope);
        this.store.saveAttachment(scope, reference, bytes);
        this.store.referenceAttachment(scope, reference.attachmentId);
        return reference;
      };
      if (
        ['agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate) &&
        update.content?.type === 'text'
      ) {
        const type = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought';
        const last = items.at(-1);
        if (last?.type === type) last.text += update.content.text;
        else items.push({ type, text: update.content.text });
      } else if (['agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate)) {
        items.push(normalizeAgentContent(update.content, save));
      } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
        let tool = items.find(
          (i: any) => i.type === 'tool_call' && i.toolCallId === update.toolCallId,
        );
        if (!tool) items.push((tool = { type: 'tool_call', toolCallId: update.toolCallId }));
        for (const key of ['title', 'kind', 'status'])
          if (update[key] !== undefined) tool[key] = update[key];
        if (update.content !== undefined)
          tool.content = normalizeAgentToolContent(update.content, save);
        for (const key of ['rawInput', 'rawOutput'])
          if (update[key] !== undefined) tool[key] = safeAgentMetadata(update[key]);
      }
    });
  }
  async execute(id: string, run: Active) {
    try {
      try {
        const before = await this.projectContent.capture(run.rootPath);
        if (this.closed) return;
        this.checkProjectLease({ ...run.projectScope, rootPath: run.rootPath });
        run.before = before;
        this.store.transaction(() =>
          this.store.projectHistory.saveBefore(run.projectScope, run.turnId, before),
        );
      } catch {
        if (!this.closed) run.snapshotIssues.push({ reason: 'capture-failed' });
      }
      if (run.stopped || this.closed) return;
      this.checkProjectLease({ ...run.projectScope, rootPath: run.rootPath });
      const meta = metas(this.meta)['session-' + id];
      const agent = this.machine.get(['agentConfig', String(meta.agentConfigId)]) as AgentConfig;
      const project = this.workspace.projects.find(
        (p) => p.id === (meta.project as any).localProjectId,
      )!;
      const session = await this.driver.open(agent, run.rootPath, this.store.nativeSession(id), {
        update: (value) => this.update(id, run, value),
        event: (event, binding) => this.sessionEvent(id, run, event, binding),
        question: (input) => {
          const request = questionRequestSchema.parse(input);
          const { workspaceId, localProjectId, sessionId, expectedTurnId } = request;
          return this.boundRun(id, run, { workspaceId, localProjectId, sessionId, expectedTurnId })
            ? this.interactions.receiveQuestion(request)
            : Promise.resolve(cancelledQuestionAnswer(request));
        },
        permission: (value) => {
          if (!this.boundRun(id, run, this.runBinding(id, run)))
            return Promise.resolve({ outcome: { outcome: 'cancelled' } });
          const requestId = randomUUID();
          return new Promise((resolve) => {
            run.permissions.set(requestId, { options: value.options, resolve });
            try {
              this.edit(id, run, (turn) => {
                let item = turn.items.find(
                  (i: any) => i.type === 'tool_call' && i.toolCallId === value.toolCall.toolCallId,
                );
                if (!item) turn.items.push((item = { ...value.toolCall, type: 'tool_call' }));
                item.permissionRequest = { requestId, options: value.options };
                this.store.notifications.record(
                  { ...run.projectScope, turnId: run.turnId },
                  'approval-required',
                  requestId,
                );
              });
            } catch (error) {
              run.permissions.delete(requestId);
              throw error;
            }
          });
        },
      });
      run.session = session;
      if (run.stopped || this.closed) {
        await session.close();
        return;
      }
      this.checkProjectLease({ ...run.projectScope, rootPath: run.rootPath });
      this.store.setNativeSession(id, session.id);
      this.saveAgentFeatures(id, run, session);
      const view = mirror(run.doc, id),
        input = view.getState().history.find((t) => t.id === run.userTurnId)!.inputConfig as Record<
          string,
          unknown
        > & { attachments?: AttachmentReference[] };
      view.dispose();
      const attachmentScope = this.attachmentScope({
        workspaceId: this.workspace.id,
        localProjectId: project.id,
        sessionId: id,
      });
      const attachmentData = this.attachmentData(attachmentScope, input.attachments ?? []);
      this.assertAttachmentCapabilities(input.attachments ?? [], session.inputCapabilities);
      await session.prompt(
        attachmentData.length ? { ...input, attachmentData } : input,
        this.runBinding(id, run),
      );
      run.terminal ??= { status: 'handled' };
    } catch (error) {
      run.terminal ??= {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Agent 执行失败',
      };
    } finally {
      for (const p of run.permissions.values()) p.resolve({ outcome: { outcome: 'cancelled' } });
      run.permissions.clear();
      run.stopped = true;
      this.interactions.cancelPending(id, run);
      await Promise.resolve(run.session?.close()).catch(() => {});
      if (!this.closed) {
        try {
          await this.finalizeProjectTurn(id, run);
        } catch {
          const view = mirror(run.doc, id);
          view.setState((state) => {
            const turn = state.history.find((turn) => turn.id === run.turnId)!;
            turn.finished = true;
            turn.status = 'failed';
            expireSessionInteractions(turn, 'stopped');
            const reference = projectDiffReferenceSchema.safeParse(turn.fileDiff);
            if (reference.success)
              turn.fileDiff = { ...reference.data, state: 'unavailable', changeCount: 0 };
            (turn.items ??= []).push({
              type: 'system_notice',
              name: 'chat_failed',
              message: 'Agent 回合已停止，但结果未能保存；请重启执行服务后再发送新的指令。',
            });
          });
          view.dispose();
          putMeta(this.meta, 'session-' + id, { status: { type: 'idle' } });
          this.settlementFailures.set(id, run.doc);
          this.changed(id);
        } finally {
          if (this.active.get(id) === run) this.active.delete(id);
        }
      }
    }
  }
  async finalizeProjectTurn(id: string, run: Active) {
    return (run.finalizing ??= (async () => {
      let after: ProjectSnapshot | undefined;
      try {
        this.checkProjectLease({ ...run.projectScope, rootPath: run.rootPath });
        const capturedAfter = await this.projectContent.capture(run.rootPath);
        if (this.closed) return;
        this.checkProjectLease({ ...run.projectScope, rootPath: run.rootPath });
        after = capturedAfter;
      } catch {
        run.snapshotIssues.push({ reason: 'capture-failed' });
      }
      if (this.closed) return;
      const terminal = run.terminal ?? { status: 'canceled' };
      try {
        this.finish(id, run, terminal.status, terminal.message, () =>
          this.store.projectHistory.finish(
            run.projectScope,
            run.turnId,
            run.before,
            after,
            run.snapshotIssues,
          ),
        );
      } catch {
        const saved = this.store.projectHistory.read(run.projectScope, run.turnId);
        this.finish(
          id,
          run,
          terminal.status,
          terminal.message,
          saved ? { ...saved.reference, state: 'unavailable', changeCount: 0 } : undefined,
        );
      }
    })());
  }
  finish(
    id: string,
    run: Active,
    status: string,
    message?: string,
    reference?: ProjectDiffReference | (() => ProjectDiffReference | undefined),
  ) {
    if (this.closed) return;
    this.interactions.cancelPending(id, run);
    putMeta(this.meta, 'session-' + id, { status: { type: 'idle' } });
    this.edit(
      id,
      run,
      (turn) => {
        turn.finished = true;
        turn.status = status;
        expireSessionInteractions(turn, 'stopped');
        if (reference) turn.fileDiff = typeof reference === 'function' ? reference() : reference;
        if (message) turn.items.push({ type: 'system_notice', name: 'chat_failed', message });
        const scope = { ...run.projectScope, turnId: run.turnId };
        this.store.notifications.resolveApprovals(scope);
        if (status === 'handled' || status === 'failed')
          this.store.notifications.record(scope, status === 'handled' ? 'completed' : 'failed');
      },
      true,
    );
    run.stopped = true;
  }
  async cancel(sessionId: string, turnId: string, localProjectId?: string) {
    return this.serial(sessionId, async () => {
      this.ensureConnected();
      this.checkProject(sessionId, localProjectId);
      const run = this.active.get(sessionId);
      assert(run && !run.stopped && run.turnId === turnId, 409, '该回合已经结束');
      run.terminal = { status: 'canceled' };
      run.stopped = true;
      this.interactions.cancelPending(sessionId, run);
      for (const p of run.permissions.values()) p.resolve({ outcome: { outcome: 'cancelled' } });
      await run.session?.cancel().catch(() => {});
      await run.session?.close();
      await run.done;
      return { success: true };
    });
  }
  async serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  close() {
    if (this.closed) return;
    for (const [id, run] of this.active) {
      const terminal = run.terminal ?? {
        status: 'failed',
        message: '执行主机已停止；请手动发送新的指令。',
      };
      this.finish(id, run, terminal.status, terminal.message, () =>
        this.store.projectHistory.interrupt(run.projectScope, run.turnId),
      );
      for (const p of run.permissions.values()) p.resolve({ outcome: { outcome: 'cancelled' } });
      run.session?.close();
    }
    this.closed = true;
    this.active.clear();
    this.watches.clear();
  }
}
