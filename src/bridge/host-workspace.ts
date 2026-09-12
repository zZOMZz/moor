import { randomUUID } from 'node:crypto';
import { Flock, LoroDoc, delta, metas, mirror, putMeta, vv } from '../model';
import { assert, sessionActionSchema, type Mutation, type SessionAction } from '../protocol';
import { validateMutation } from './validate-mutation';
import { RuntimeStore } from '../runtime/store';
import type { AgentConfig, AgentDriver, AgentSession, PermissionOutcome } from '../runtime/agent';
import { runCapabilitiesSchema } from '../run-config';
import {
  ACTOR_FEATURE,
  ATTENTION_FEATURE,
  FOLLOWUP_FEATURE,
  attentionContextSchema,
  attentionSeenSchema,
  attentionDispositionSchema,
  attentionPermissionSchema,
  attentionContinueSchema,
  attentionListQuerySchema,
  type AttentionActor,
  type AttentionContext,
  type AttentionSeen,
  type AttentionDisposition,
  type AttentionPermission,
  type AttentionContinue,
  type AttentionListQuery,
  type AttentionDetail,
  type AttentionReceipt,
  type AttentionCause,
} from '../attention';
import {
  CONTENT_VERSION,
  FILE_CONTENT_FEATURE,
  projectFileReadSchema,
  type ProjectFileRead,
  type ProjectFileResult,
} from '../content-protocol';
import { readProjectFileBytes } from '../runtime/project-files';

type Active = {
  turnId: string;
  userTurnId: string;
  doc: LoroDoc;
  session?: AgentSession;
  stopped: boolean;
  done?: Promise<void>;
  permissions: Map<
    string,
    { options: any[]; toolCall: unknown; resolve: (value: { outcome: PermissionOutcome }) => void }
  >;
};
export class HostWorkspace {
  closed = false;
  private attentionChanged: (actor: AttentionActor, sessionId: string) => void = () => {};
  setAttentionListener(listener: (actor: AttentionActor, sessionId: string) => void) {
    this.attentionChanged = listener;
  }
  locks = new Map<string, Promise<unknown>>();
  active = new Map<string, Active>();
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
  ) {
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
      ATTENTION_FEATURE,
      ACTOR_FEATURE,
      FOLLOWUP_FEATURE,
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
        return {
          id: a.id,
          name: a.name,
          cliType: a.cliType,
          agentType: a.agentType,
          runConfig: options.success ? options.data : undefined,
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
      update: delta(this.active.get(sessionId)?.doc ?? this.store.doc(sessionId), version),
      synced: true,
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
  private attentionTarget(input: AttentionContext, session = false) {
    this.ensureConnected();
    const context = attentionContextSchema.parse(input);
    assert(
      context.machineId === this.workspace.machineId &&
        context.runtimeWorkspaceId === this.workspace.id,
      404,
      '待办不属于这台执行电脑',
    );
    assert(
      this.workspace.projects.some((p) => p.id === context.localProjectId),
      404,
      '项目副本已从主机移除',
    );
    if (session) {
      assert(context.sessionId, 400, '缺少待办会话');
      this.checkProject(context.sessionId, context.localProjectId);
    }
    return context;
  }
  private reconcileAttention(localProjectId: string) {
    this.store.attention.reconcilePermissions(localProjectId, (item) => {
      const run = this.active.get(item.sessionId);
      return (
        !!run &&
        !run.stopped &&
        run.turnId === item.assistantTurnId &&
        !!item.requestId &&
        run.permissions.has(item.requestId)
      );
    });
  }
  attentionList(input: AttentionContext, query: AttentionListQuery) {
    const context = this.attentionTarget(input);
    this.reconcileAttention(context.localProjectId);
    return this.store.attention.list(context, attentionListQuerySchema.parse(query));
  }
  attentionItems(input: AttentionContext, query: AttentionListQuery) {
    const context = this.attentionTarget(input, true);
    this.reconcileAttention(context.localProjectId);
    return this.store.attention.sessionItems(context, attentionListQuerySchema.parse(query));
  }
  attentionDetail(input: AttentionContext, itemId: string): AttentionDetail {
    const context = this.attentionTarget(input, true);
    this.reconcileAttention(context.localProjectId);
    const item = this.store.attention.get(context, itemId);
    const run = this.active.get(item.sessionId);
    const view = mirror(run?.doc ?? this.store.doc(item.sessionId), item.sessionId);
    const state = view.getState();
    const turn = state.history.find((t) => t.id === item.assistantTurnId);
    const userTurn = state.history.find((t) => t.id === item.userTurnId);
    view.dispose();
    assert(turn, 404, '待办对应的回合不可用');
    const meta = metas(this.meta)['session-' + item.sessionId];
    const pending = item.requestId ? run?.permissions.get(item.requestId) : undefined;
    const tool = turn.items?.find((i: any) => i.permissionRequest?.requestId === item.requestId);
    return {
      item,
      title: String(meta.title ?? '未命名会话'),
      isArchived: meta.isArchived === true,
      turn,
      userTurn,
      permission:
        item.kind === 'permission' &&
        item.lifecycle === 'active' &&
        run &&
        !run.stopped &&
        run.turnId === item.assistantTurnId &&
        pending &&
        tool
          ? {
              requestId: item.requestId!,
              expectedTurnId: run.userTurnId,
              options: pending.options,
              toolCall: pending.toolCall,
            }
          : undefined,
    };
  }
  async attentionSeen(input: AttentionContext, itemId: string, inputRequest: AttentionSeen) {
    const request = attentionSeenSchema.parse(inputRequest);
    const context = this.attentionTarget(input, true);
    return this.serial(context.sessionId!, async () => {
      this.attentionTarget(context, true);
      const result = this.store.attention.seen(context, itemId, request);
      this.attentionChanged(context.actor, context.sessionId!);
      return result;
    });
  }
  async attentionDisposition(
    input: AttentionContext,
    itemId: string,
    inputRequest: AttentionDisposition,
  ) {
    const request = attentionDispositionSchema.parse(inputRequest);
    const context = this.attentionTarget(input, true);
    return this.serial(context.sessionId!, async () => {
      this.attentionTarget(context, true);
      const result = this.store.attention.disposition(context, itemId, request);
      this.attentionChanged(context.actor, context.sessionId!);
      return result;
    });
  }
  private attentionBinding(
    context: AttentionContext,
    itemId: string,
    method: string,
    request: unknown,
  ) {
    return {
      method,
      actor: context.actor,
      executionDeviceId: context.executionDeviceId,
      machineId: context.machineId,
      runtimeWorkspaceId: context.runtimeWorkspaceId,
      localProjectId: context.localProjectId,
      sessionId: context.sessionId,
      itemId,
      request,
    };
  }
  async attentionContinue(
    input: AttentionContext,
    itemId: string,
    inputRequest: AttentionContinue,
  ) {
    const request = attentionContinueSchema.parse(inputRequest);
    const context = this.attentionTarget(input, true);
    assert(
      request.mutation.sessionId === context.sessionId &&
        request.mutation.workspaceId === context.runtimeWorkspaceId,
      400,
      '后续指令与原待办执行目标不匹配',
    );
    return this.serial(context.sessionId!, async () => {
      this.attentionTarget(context, true);
      const previous = this.store.attention.lookupReceipt(
        context,
        itemId,
        'continue',
        request,
        request.mutation.operationId,
      );
      if (previous) return previous;
      this.store.attention.prepareContinue(context, itemId, request);
      const result = await this.mutateAccepted(request.mutation, context.localProjectId, {
        binding: this.attentionBinding(context, itemId, 'continue', request),
        commit: (userTurnId) => this.store.attention.continue(context, itemId, request, userTurnId),
      });
      this.attentionChanged(context.actor, context.sessionId!);
      return result;
    });
  }
  async attentionPermission(
    input: AttentionContext,
    itemId: string,
    inputRequest: AttentionPermission,
  ) {
    const request = attentionPermissionSchema.parse(inputRequest);
    const context = this.attentionTarget(input, true);
    return this.serial(context.sessionId!, async () => {
      this.attentionTarget(context, true);
      const previous = this.store.attention.lookupReceipt(
        context,
        itemId,
        'permission',
        request,
        request.operationId,
      );
      if (previous) return previous;
      const detail = this.attentionDetail(context, itemId);
      assert(
        detail.item.eventRevision === request.eventRevision &&
          detail.permission?.requestId === request.requestId &&
          detail.permission.expectedTurnId === request.expectedTurnId,
        409,
        '审批请求已更新或失效',
      );
      assert(
        request.optionId === null ||
          detail.permission.options.some((o) => o.optionId === request.optionId),
        400,
        '审批选项无效',
      );
      const run = this.active.get(context.sessionId!)!;
      const candidate = new LoroDoc();
      candidate.import(run.doc.export({ mode: 'snapshot' }));
      const before = vv(candidate),
        view = mirror(candidate, context.sessionId!);
      view.setState((s) => {
        const turn = s.history.find((t) => t.id === detail.item.assistantTurnId)!;
        const tool = turn.items?.find(
          (i: any) => i.permissionRequest?.requestId === request.requestId,
        ) as any;
        tool.permissionRequest.outcome =
          request.optionId === null
            ? { outcome: 'cancelled' }
            : { outcome: 'selected', optionId: request.optionId };
      });
      view.dispose();
      const mutation: Mutation = {
        operationId: request.operationId,
        workspaceId: context.runtimeWorkspaceId,
        sessionId: context.sessionId!,
        kind: 'permission',
        expectedTurnId: request.expectedTurnId,
        requestId: request.requestId,
        update: delta(candidate, before),
      };
      return this.mutateAccepted(mutation, context.localProjectId, {
        binding: this.attentionBinding(context, itemId, 'permission', request),
        commit: () =>
          this.store.attention.acceptReceipt(
            context,
            itemId,
            'permission',
            request,
            request.operationId,
          ),
      });
    });
  }
  async mutate(m: Mutation, localProjectId?: string) {
    return this.serial(m.sessionId, () => this.mutateAccepted(m, localProjectId));
  }
  private async mutateAccepted(
    m: Mutation,
    localProjectId?: string,
    effect?: {
      binding: unknown;
      commit: (userTurnId: string) => AttentionReceipt;
    },
  ) {
    this.ensureConnected();
    assert(
      m.workspaceId === this.workspace.id && /^[A-Za-z0-9_-]{1,160}$/.test(m.sessionId),
      400,
      '会话执行目标不匹配',
    );
    const journal = this.store.journal;
    const record = journal.lookup(this.workspace.id, m, effect?.binding);
    if (metas(this.meta)['session-' + m.sessionId] || record)
      this.checkProject(m.sessionId, localProjectId);
    if (record?.phase === 'accepted') return JSON.parse(record.result);
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
      assert((meta.project as any)?.localProjectId === localProjectId, 400, '执行项目与副本不匹配');
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
        journal.stage(this.workspace.id, m, turnId, undefined, effect?.binding);
        this.store.meta = validated.flock;
        this.store.persist(m.sessionId, validated.doc);
        if (m.kind === 'permission')
          this.store.attention.resolvePermission(
            m.sessionId,
            active!.turnId,
            m.requestId!,
            'resolved',
          );
        const accepted = journal.accept(m);
        return effect?.commit(turnId) ?? accepted;
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
        permissions: new Map(),
      };
      this.active.set(m.sessionId, run);
      run.done = this.execute(m.sessionId, run).catch((error) => {
        // A background run has no awaiting HTTP caller after delivery. If its
        // final state cannot be persisted, stop accepting work and close owned
        // Agents instead of leaking an unhandled rejection or reporting idle.
        console.error('执行回合状态无法保存，已停止本机工作区', error);
        try {
          this.close();
        } catch (closeError) {
          console.error(closeError);
        }
        this.catalogue();
      });
    }
    this.changed(m.sessionId);
    return result;
  }
  edit(id: string, run: Active, edit: (turn: any) => void, persist?: (turn: any) => void) {
    if (run.stopped || this.closed) return;
    const candidate = new LoroDoc();
    candidate.import(run.doc.export({ mode: 'snapshot' }));
    const view = mirror(candidate, id);
    view.setState((s) => edit(s.history.find((t) => t.id === run.turnId)!));
    const turn = view.getState().history.find((t) => t.id === run.turnId)!;
    view.dispose();
    this.store.transaction(() => {
      this.store.persist(id, candidate);
      persist?.(turn);
    });
    run.doc = candidate;
    this.changed(id);
  }
  update(id: string, run: Active, update: any) {
    this.edit(id, run, (turn) => {
      const items = (turn.items ??= []);
      if (
        ['agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate) &&
        update.content?.type === 'text'
      ) {
        const type = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought';
        const last = items.at(-1);
        if (last?.type === type) last.text += update.content.text;
        else items.push({ type, text: update.content.text });
      } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
        let tool = items.findLast(
          (i: any) => i.type === 'tool_call' && i.toolCallId === update.toolCallId,
        );
        if (!tool) items.push((tool = { type: 'tool_call', toolCallId: update.toolCallId }));
        for (const key of ['title', 'kind', 'status', 'content', 'rawInput', 'rawOutput'])
          if (update[key] !== undefined) tool[key] = update[key];
      }
    });
  }
  async execute(id: string, run: Active) {
    try {
      const meta = metas(this.meta)['session-' + id];
      const agent = this.machine.get(['agentConfig', String(meta.agentConfigId)]) as AgentConfig;
      const project = this.workspace.projects.find(
        (p) => p.id === (meta.project as any).localProjectId,
      )!;
      const session = await this.driver.open(
        agent,
        project.rootPath,
        this.store.nativeSession(id),
        {
          update: (value) => this.update(id, run, value),
          permission: (value) => {
            if (run.stopped || this.closed)
              return Promise.resolve({ outcome: { outcome: 'cancelled' } });
            const requestId = randomUUID();
            return new Promise((resolve) => {
              const request = structuredClone(value);
              run.permissions.set(requestId, {
                options: request.options,
                toolCall: request.toolCall,
                resolve,
              });
              try {
                this.edit(
                  id,
                  run,
                  (turn) => {
                    let item = turn.items.findLast(
                      (i: any) =>
                        i.type === 'tool_call' && i.toolCallId === request.toolCall.toolCallId,
                    );
                    // A tool may ask again or have concurrent permission requests.
                    // Keep every request addressable by its own immutable id.
                    if (!item || item.permissionRequest) turn.items.push((item = {}));
                    Object.assign(item, request.toolCall, {
                      type: 'tool_call',
                      permissionRequest: { requestId, options: request.options },
                    });
                  },
                  () => {
                    this.store.attention.recordPermission({
                      sessionId: id,
                      assistantTurnId: run.turnId,
                      userTurnId: run.userTurnId,
                      localProjectId: project.id,
                      requestId,
                      summary: String(request.toolCall.title ?? '等待审批').slice(0, 240),
                    });
                  },
                );
              } catch (error) {
                run.permissions.delete(requestId);
                resolve({ outcome: { outcome: 'cancelled' } });
                throw error;
              }
            });
          },
        },
      );
      run.session = session;
      if (run.stopped || this.closed) {
        await session.close();
        return;
      }
      this.store.setNativeSession(id, session.id);
      const view = mirror(run.doc, id),
        input = view.getState().history.find((t) => t.id === run.userTurnId)!.inputConfig;
      view.dispose();
      await session.prompt(input);
      this.finish(id, run, 'handled');
    } catch (error) {
      this.finish(id, run, 'failed', error instanceof Error ? error.message : 'Agent 执行失败');
    } finally {
      for (const p of run.permissions.values()) p.resolve({ outcome: { outcome: 'cancelled' } });
      run.permissions.clear();
      await run.session?.close();
      if (this.active.get(id) === run) this.active.delete(id);
    }
  }
  finish(id: string, run: Active, status: string, message?: string, cause?: AttentionCause) {
    if (run.stopped || this.closed) return;
    const previous = this.store.meta;
    this.store.meta = Flock.fromFile(previous.exportFile());
    putMeta(this.meta, 'session-' + id, { status: { type: 'idle' } });
    try {
      this.edit(
        id,
        run,
        (turn) => {
          turn.finished = true;
          turn.status = status;
          if (message) turn.items.push({ type: 'system_notice', name: 'chat_failed', message });
        },
        (turn) => {
          const project = metas(this.meta)['session-' + id]?.project as { localProjectId: string };
          const text = [...(turn.items ?? [])].reverse().find((i: any) => i.type === 'text')?.text;
          this.store.attention.recordOutcome({
            sessionId: id,
            assistantTurnId: run.turnId,
            userTurnId: run.userTurnId,
            localProjectId: project.localProjectId,
            cause:
              cause ??
              (status === 'handled'
                ? 'agent_returned'
                : status === 'canceled'
                  ? 'user_canceled'
                  : 'execution_failed'),
            summary: String(
              message ?? text ?? (status === 'handled' ? '本轮执行结束' : '本轮执行未完成'),
            ).slice(0, 240),
          });
        },
      );
    } catch (error) {
      this.store.meta = previous;
      throw error;
    }
    run.stopped = true;
  }
  async cancel(sessionId: string, turnId: string, localProjectId?: string) {
    return this.serial(sessionId, async () => {
      this.ensureConnected();
      this.checkProject(sessionId, localProjectId);
      const run = this.active.get(sessionId);
      assert(run && !run.stopped && run.turnId === turnId, 409, '该回合已经结束');
      this.finish(sessionId, run, 'canceled');
      for (const p of run.permissions.values()) p.resolve({ outcome: { outcome: 'cancelled' } });
      await run.session?.cancel().catch(() => {});
      await run.session?.close();
      this.active.delete(sessionId);
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
    const errors: unknown[] = [];
    for (const [id, run] of this.active) {
      try {
        this.finish(id, run, 'failed', '执行主机已停止；请手动发送新的指令。', 'host_stopped');
      } catch (error) {
        errors.push(error);
      } finally {
        // Failure to persist the terminal fact must never keep our Agent alive.
        // The unfinished persisted turn is recovered on the next host startup.
        run.stopped = true;
        for (const p of run.permissions.values()) p.resolve({ outcome: { outcome: 'cancelled' } });
        run.permissions.clear();
        try {
          void Promise.resolve(run.session?.close()).catch((error) => console.error(error));
        } catch (error) {
          errors.push(error);
        }
      }
    }
    this.closed = true;
    this.active.clear();
    this.watches.clear();
    if (errors.length) throw new AggregateError(errors, '主机已停止，但部分回合状态未能保存');
  }
}
