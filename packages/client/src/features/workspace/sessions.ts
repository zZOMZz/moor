import {
  AGENT_CONTROLS_FEATURE,
  AGENT_RUN_DEFAULTS_FEATURE,
  agentUsageResponseSchema,
  runDefaultsResponseSchema,
  runPreferencesResponseSchema,
} from '@moor/protocol/agent-controls';
import { publicAgentFailure } from '@moor/protocol/agent-errors';
import { productCanonicalJson } from '@moor/protocol/canonical-json';
import { agentSchema } from '@moor/protocol/protocol';
import {
  approvalModeSchema,
  canonicalMode,
  initializeRunSelection,
  selectionFromInput,
  type RunSelection,
} from '@moor/protocol/run-config';
import { ClientSessionReplica } from '@moor/session/client-session-replica';
import { z } from 'zod';
import { WorkspacePersistence, type WorkspaceScope } from '../../operations/workspace/compose';
import type { WorkspaceContextService } from './context';
import type { WorkspaceDraftsService } from './drafts';
import type { WorkspaceOptions } from './model';
import {
  ClientSessionDelta,
  Context,
  immutableJsonBytes,
  immutableSnapshot,
  same,
  Session,
  SESSION_LOADING_DELAY_MS,
  SESSION_VIEW_BYTES,
  SESSION_VIEW_LIMIT,
  SessionView,
  sessionViewBudget,
} from './model';
import type { WorkspaceSyncService } from './sync';
/** Capabilities consumed by sessions use cases; supplied only by the workspace composition root. */
export interface WorkspaceSessionsPorts {
  context: Pick<
    WorkspaceContextService,
    | 'value'
    | 'context'
    | 'emit'
    | 'generation'
    | 'current'
    | 'schedule'
    | 'closed'
    | 'execute'
    | 'command'
  >;
  store: Pick<
    WorkspacePersistence,
    'cacheSessionDelta' | 'read' | 'loadSessionCache' | 'readDraft' | 'saveDraft'
  >;
  drafts: Pick<WorkspaceDraftsService, 'flushDraft'>;
  sync: Pick<WorkspaceSyncService, 'sessionSyncPending' | 'syncAfterRead' | 'drainSessionSync'>;
}
export class WorkspaceSessionsService {
  constructor(
    readonly ports: WorkspaceSessionsPorts,
    readonly options: Pick<WorkspaceOptions, 'yieldCache' | 'restoreLegacy' | 'sessionReceived'>,
  ) {}
  catalogAttempts = new Map<string, string | undefined>();
  sessionViews = new Map<string, SessionView>();
  sessionViewBytes = 0;
  sessionReplica?: ClientSessionReplica;
  sessionReplicaKey?: string;
  sessionCacheQueue?: {
    replica: ClientSessionReplica;
    pending: { read: ClientSessionDelta; bytes: number }[];
    bytes: number;
    current: () => void;
    context: Context;
    running?: Promise<void>;
  };
  sessionFlight?: { generation: number; again: boolean; promise: Promise<void> };
  sessionReadVersion = 0;
  modelReadVersion = 0;
  usageReadGeneration?: number;
  sessionViewKey(scope: WorkspaceScope, sessionId: string) {
    return productCanonicalJson(['workspace-session-view-v1', scope, sessionId]);
  }
  discardSessionCacheQueue(queue = this.sessionCacheQueue) {
    if (queue) {
      queue.pending = [];
      queue.bytes = 0;
    }
    if (this.sessionCacheQueue === queue) {
      this.sessionCacheQueue = undefined;
      delete this.ports.context.value.sessionCache;
    }
  }
  discardSessionReplica(replica = this.sessionReplica) {
    replica?.dispose();
    if (this.sessionReplica === replica) {
      this.discardSessionCacheQueue();
      this.sessionReplica = undefined;
      this.sessionReplicaKey = undefined;
    }
  }
  replica(scope: WorkspaceScope, sessionId: string) {
    const key = this.sessionViewKey(scope, sessionId);
    if (!this.sessionReplica || this.sessionReplicaKey !== key) {
      this.discardSessionReplica();
      this.sessionReplica = new ClientSessionReplica({ ...scope.target, sessionId });
      this.sessionReplicaKey = key;
    }
    return this.sessionReplica;
  }
  queueSessionCache(replica: ClientSessionReplica, read: ClientSessionDelta) {
    if (read.response.persisted === false || read.response.persistenceError) {
      this.ports.context.value.sessionCache = { status: 'unavailable' };
      return;
    }
    let queue = this.sessionCacheQueue;
    if (!queue || queue.replica !== replica) {
      const context = this.ports.context.context();
      queue = { replica, context, pending: [], bytes: 0, current: () => {} };
      const captured = queue;
      queue.current = () => {
        context.current();
        const catalog = this.ports.context.value.catalogs[context.scope.source];
        if (
          this.sessionCacheQueue !== captured ||
          this.sessionReplica !== replica ||
          catalog?.connectionId !== context.connectionId ||
          catalog.owner !== context.scope.target.owner
        )
          throw Error('缓存保存范围已改变');
      };
      this.sessionCacheQueue = queue;
    }
    // Retain small normal deltas, not one full export per response. A stalled
    // writer holds at most one active write plus 32 / 1MiB pending envelopes
    // (or one protocol-bounded oversized envelope). A skipped base checkpoints
    // the captured final confirmed version when the writer catches up.
    const bytes = immutableJsonBytes(read.response);
    if (queue.pending.length >= 32 || queue.bytes + bytes > 1024 * 1024) {
      queue.pending = [];
      queue.bytes = 0;
    }
    queue.pending.push({ read, bytes });
    queue.bytes += bytes;
    this.ports.context.value.sessionCache = {
      status: 'saving',
      version: this.ports.context.value.sessionCache?.version,
    };
    if (queue.running) return;
    const captured = queue;
    const drain = async () => {
      while (captured.pending.length) {
        // Publishing the Host view never waits for storage or compaction. Yield
        // between commits so a cache backlog cannot occupy one continuous task.
        await (this.options.yieldCache?.() ?? new Promise<void>((done) => setTimeout(done, 0)));
        try {
          captured.current();
        } catch {
          this.discardSessionCacheQueue(captured);
          return;
        }
        const next = captured.pending.shift()!;
        captured.bytes -= next.bytes;
        let savedVersion: string | undefined;
        let failed = false;
        try {
          savedVersion = await this.ports.store.cacheSessionDelta(
            captured.context.scope,
            captured.context.sessionId!,
            next.read,
            captured.current,
            () => {
              captured.current();
              return replica.exportSnapshotAt(next.read);
            },
          );
        } catch {
          failed = true;
        }
        try {
          captured.current();
        } catch {
          this.discardSessionCacheQueue(captured);
          return;
        }
        if (!captured.pending.length && replica.lastRead === next.read) {
          this.ports.context.value.sessionCache = failed
            ? { status: 'failed', version: this.ports.context.value.sessionCache?.version }
            : { status: 'saved', version: savedVersion };
          this.ports.context.emit();
        }
      }
    };
    const start = () => {
      captured.running = drain().finally(() => {
        captured.running = undefined;
        if (captured.pending.length && this.sessionCacheQueue === captured) start();
      });
    };
    start();
  }
  exportSessionSnapshot(context: Context) {
    context.current();
    const replica = this.sessionReplica;
    if (
      !context.sessionId ||
      !replica ||
      this.sessionReplicaKey !== this.sessionViewKey(context.scope, context.sessionId) ||
      !replica.view ||
      replica.view.version !== this.ports.context.value.session?.version
    )
      throw Error('当前会话副本已改变，请重新读取。');
    return {
      ...replica.exportSnapshot(),
      agent: this.ports.context.value.session.agent,
      accountUsage: this.ports.context.value.session.accountUsage,
    };
  }
  sessionView(scope: WorkspaceScope, sessionId: string) {
    const key = this.sessionViewKey(scope, sessionId),
      value = this.sessionViews.get(key);
    if (!value) return;
    this.sessionViews.delete(key);
    this.sessionViews.set(key, value);
    return value;
  }
  rememberSessionView(scope: WorkspaceScope, sessionId: string) {
    const session = this.ports.context.value.session,
      draft = this.ports.context.value.draft;
    if (!session || !draft || session.meta.id !== sessionId) return;
    immutableSnapshot(session);
    immutableSnapshot(draft);
    const key = this.sessionViewKey(scope, sessionId),
      previous = this.sessionViews.get(key),
      sessionBytes =
        previous?.session === session ? previous.sessionBytes : sessionViewBudget(session),
      draftBytes = previous?.draft === draft ? previous.draftBytes : sessionViewBudget(draft),
      // Exact JSON wrapper overhead for {"session":...,"draft":...}.
      bytes = sessionBytes + draftBytes + 21;
    if (previous) this.sessionViewBytes -= previous.bytes;
    this.sessionViews.delete(key);
    if (bytes > SESSION_VIEW_BYTES) return;
    this.sessionViews.set(
      key,
      immutableSnapshot({ session, draft, sessionBytes, draftBytes, bytes }),
    );
    this.sessionViewBytes += bytes;
    this.trimSessionViews();
  }
  rememberSessionDraft(scope: WorkspaceScope, sessionId: string) {
    const key = this.sessionViewKey(scope, sessionId),
      value = this.sessionViews.get(key),
      draft = this.ports.context.value.draft;
    if (!value || !draft || this.ports.context.value.sessionId !== sessionId) return;
    this.sessionViewBytes -= value.bytes;
    const draftBytes = sessionViewBudget(immutableSnapshot(draft)),
      bytes = value.sessionBytes + draftBytes + 21;
    this.sessionViews.delete(key);
    this.sessionViews.set(key, immutableSnapshot({ ...value, draft, draftBytes, bytes }));
    this.sessionViewBytes += bytes;
    this.trimSessionViews();
  }
  trimSessionViews() {
    while (
      this.sessionViews.size > SESSION_VIEW_LIMIT ||
      this.sessionViewBytes > SESSION_VIEW_BYTES
    ) {
      const oldest = this.sessionViews.keys().next().value!,
        removed = this.sessionViews.get(oldest)!;
      this.sessionViews.delete(oldest);
      this.sessionViewBytes -= removed.bytes;
    }
  }
  async openSession(sessionId: string, turnId?: string) {
    this.ports.context.value.modelLoading = false;
    this.ports.context.value.searchFocus = undefined;
    this.ports.context.value.focusedTurnId = undefined;
    await this.ports.drafts.flushDraft();
    const scope = this.ports.context.context(sessionId).scope,
      view = this.sessionView(scope, sessionId);
    this.ports.context.generation++;
    this.ports.sync.sessionSyncPending = false;
    this.ports.sync.syncAfterRead = false;
    this.discardSessionReplica();
    const replica = this.replica(scope, sessionId);
    this.ports.context.value.sessionId = sessionId;
    delete this.ports.context.value.usageLoading;
    delete this.ports.context.value.modelError;
    delete this.ports.context.value.sendProgress;
    const current = this.ports.context.current();
    let cancelLoading = () => {};
    if (view) {
      this.ports.context.value.session = view.session;
      this.ports.context.value.draft = view.draft;
      this.ports.context.value.sessionLoad = { status: 'refreshing', source: 'cache' };
      this.ports.context.emit();
    } else {
      delete this.ports.context.value.session;
      delete this.ports.context.value.draft;
      // Publish the new scope immediately so the previous composer can no
      // longer accept input. Only the visual loading indicator is delayed.
      this.ports.context.value.sessionLoad = { status: 'loading-cache', showIndicator: false };
      this.ports.context.emit();
      cancelLoading = this.ports.context.schedule(SESSION_LOADING_DELAY_MS, () => {
        try {
          current();
          if (this.ports.context.value.sessionLoad.status !== 'loading-cache') return;
          this.ports.context.value.sessionLoad = { status: 'loading-cache', showIndicator: true };
          this.ports.context.emit();
        } catch {
          // A newer navigation owns the visible session.
        }
      });
    }
    let cached: Session | null;
    try {
      await this.options.restoreLegacy?.(scope, sessionId, current);
      const [ledger, storedSession] = await Promise.all([
        this.ports.store.read(scope, current, sessionId),
        this.ports.store.loadSessionCache(scope, sessionId, current),
      ]);
      current();
      this.ports.context.value.ledger = ledger;
      this.ports.context.value.draft = await this.ports.store.readDraft(
        scope,
        sessionId,
        current,
        ledger,
      );
      cached = null;
      if (storedSession) {
        cached = replica.read(storedSession.checkpoint);
        for (const delta of storedSession.deltas) cached = replica.read(delta);
        if (storedSession.version && cached.version !== storedSession.version)
          throw Error('缓存会话版本与增量链不匹配。');
      }
    } catch (error) {
      cancelLoading();
      current();
      this.discardSessionReplica(replica);
      this.ports.context.value.sessionLoad = {
        status: 'failed',
        source: view ? 'cache' : 'none',
        reason: 'local',
      };
      this.ports.context.emit();
      throw error;
    }
    cancelLoading();
    current();
    if (!view && cached) this.ports.context.value.session = cached;
    if (this.ports.context.value.session) this.rememberSessionView(scope, sessionId);
    this.ports.context.value.sessionLoad = this.ports.context.value.session
      ? { status: 'refreshing', source: 'cache' }
      : { status: 'loading-cache' };
    this.ports.context.emit();
    await this.refreshSession({ announce: false, settle: false });
    let optionsRefreshed = false;
    try {
      await this.refreshAgentOptions();
      optionsRefreshed = true;
      if (!this.ports.context.value.session?.accountUsage?.observedAt)
        await this.readUsage().catch(() => {});
    } finally {
      current();
      this.ports.context.value.sessionLoad = { status: 'ready', source: 'host' };
      if (!optionsRefreshed) this.rememberSessionView(scope, sessionId);
      this.ports.context.emit();
      if (this.ports.sync.syncAfterRead) {
        this.ports.sync.syncAfterRead = false;
        this.ports.sync.sessionSyncPending = true;
        void this.ports.sync.drainSessionSync();
      }
    }
    current();
    if (turnId && this.ports.context.value.session?.history.some((turn) => turn.id === turnId)) {
      this.ports.context.value.focusedTurnId = turnId;
      this.ports.context.emit();
    }
  }
  refreshSession({
    announce = true,
    settle = true,
    background = false,
  }: { announce?: boolean; settle?: boolean; background?: boolean } = {}): Promise<void> {
    if (
      background &&
      ['loading-cache', 'refreshing'].includes(this.ports.context.value.sessionLoad.status)
    ) {
      this.ports.sync.syncAfterRead = true;
      return Promise.resolve();
    }
    const previous = this.sessionFlight;
    if (previous?.generation === this.ports.context.generation) {
      previous.again = true;
      return previous.promise;
    }
    const flight = {
      generation: this.ports.context.generation,
      again: false,
      promise: Promise.resolve(),
    };
    this.sessionFlight = flight;
    flight.promise = Promise.resolve().then(async () => {
      try {
        do {
          flight.again = false;
          if (flight.generation !== this.ports.context.generation || this.ports.context.closed)
            return;
          await this.readSessionOnce({ announce, settle });
          announce = false;
        } while (flight.again);
      } finally {
        // Clear the flight before its promise resolves: a request arriving in a
        // following microtask must start a read, not join an already-drained one.
        if (this.sessionFlight === flight) this.sessionFlight = undefined;
      }
    });
    return flight.promise;
  }
  async readSessionOnce({ announce, settle }: { announce: boolean; settle: boolean }) {
    const context = this.ports.context.context(),
      generation = this.ports.context.generation;
    const version = ++this.sessionReadVersion,
      selected = context.current;
    context.current = () => {
      selected();
      if (version !== this.sessionReadVersion) throw Error('会话读取已由较新的请求替代。');
    };
    if (!context.sessionId) throw Error('请先选择会话。');
    const replica = this.replica(context.scope, context.sessionId),
      base = replica.view;
    const source =
      this.ports.context.value.sessionLoad.status === 'ready'
        ? 'host'
        : 'source' in this.ports.context.value.sessionLoad
          ? this.ports.context.value.sessionLoad.source
          : this.ports.context.value.session
            ? 'cache'
            : 'none';
    if (announce) {
      this.ports.context.value.sessionLoad = { status: 'refreshing', source };
      this.ports.context.emit();
    }
    try {
      const raw = await this.ports.context.execute(
        context,
        this.ports.context.command(context.scope, 'session', {
          sessionId: context.sessionId,
          ...(base?.version ? { version: base.version } : {}),
        }),
      );
      const markPerformance = this.options.sessionReceived?.();
      let session: Session;
      try {
        session = replica.read(raw);
      } catch (error) {
        this.discardSessionReplica(replica);
        throw error;
      }
      this.queueSessionCache(replica, replica.lastRead!);
      context.current();
      this.ports.context.value.session = session;
      if (base?.version && session.version && base.version !== session.version)
        markPerformance?.(this, context.sessionId, session.version);
      this.ports.context.value.offline = false;
      this.ports.context.value.sessionLoad = settle
        ? { status: 'ready', source: 'host' }
        : { status: 'refreshing', source: 'host' };
      if (settle) this.rememberSessionView(context.scope, context.sessionId);
    } catch (error) {
      context.current();
      this.ports.context.value.offline = true;
      this.ports.context.value.sessionLoad = { status: 'failed', source, reason: 'connection' };
      throw error;
    } finally {
      // Single-flight already serializes reads within this selection. Older
      // selections may still be waiting, but must not delay its pending notice.
      if (generation === this.ports.context.generation && this.ports.sync.syncAfterRead) {
        this.ports.sync.syncAfterRead = false;
        this.ports.sync.sessionSyncPending = true;
        void this.ports.sync.drainSessionSync();
      }
      context.current();
      this.ports.context.emit();
    }
  }
  async refreshAgentOptions(force = false) {
    await this.ports.drafts.flushDraft();
    const context = this.ports.context.context(),
      session = this.ports.context.value.session;
    const version = ++this.modelReadVersion,
      selected = context.current;
    context.current = () => {
      selected();
      if (version !== this.modelReadVersion) throw Error('模型读取已由较新的请求替代。');
    };
    if (!session || !context.sessionId) throw Error('请先读取会话。');
    const key = (agent: typeof session.agent) =>
      JSON.stringify([
        context.scope,
        agent?.id,
        agent?.capabilityContext?.programFingerprint,
        agent?.capabilityContext?.directoryFingerprint ?? context.sessionId,
      ]);
    const attempt = key(session.agent);
    if (!force && this.catalogAttempts.has(attempt)) {
      this.ports.context.value.modelError = this.catalogAttempts.get(attempt);
      await this.initializeSelection(context);
      return;
    }
    if (this.catalogAttempts.size >= 500) this.catalogAttempts.clear();
    this.catalogAttempts.set(attempt, undefined);
    this.ports.context.value.modelLoading = true;
    this.ports.context.emit();
    try {
      const agent = agentSchema.parse(
        await this.ports.context.execute(
          context,
          this.ports.context.command(context.scope, 'agent-options', {
            sessionId: context.sessionId,
            agentId: session.meta.agentConfigId,
            ...(force ? { refresh: true } : {}),
          }),
        ),
      );
      // Preserve a newer timeline read which may have completed while capabilities loaded.
      this.ports.context.value.session = { ...this.ports.context.value.session!, agent };
      this.catalogAttempts.set(key(agent), undefined);
      await this.initializeSelection(context);
      this.rememberSessionView(context.scope, context.sessionId);
      delete this.ports.context.value.modelError;
    } catch (error) {
      context.current();
      this.ports.context.value.modelError = publicAgentFailure(
        error,
        '模型选项暂不可读取，请在设置中刷新或检查执行电脑。',
      );
      this.catalogAttempts.set(attempt, this.ports.context.value.modelError);
      throw error;
    } finally {
      context.current();
      this.ports.context.value.modelLoading = false;
      this.ports.context.emit();
    }
  }
  async initializeSelection(context: Context) {
    const session = this.ports.context.value.session,
      draft = this.ports.context.value.draft;
    if (!session || !draft || !context.sessionId) return;
    const latest = session.history.findLast((turn) => turn.role === 'user');
    const inherited =
      draft.revision === 0
        ? selectionFromInput(latest?.inputConfig as any, session.agent?.runConfig)
        : {};
    const selection = initializeRunSelection(
      { ...inherited, ...draft.selection },
      session.agent?.runConfig,
      {
        fresh: !session.history.length,
        initialModeId: session.meta.initialModeId,
        initialModelId: session.meta.initialModelId,
        initialReasoningEffort: session.meta.initialReasoningEffort,
        legacyCodex: session.meta.agentType === 'codex',
      },
    );
    // A historical alias already denotes the advertised preset. Rewriting only
    // its spelling would advance Draft State during send and defeat the frozen
    // revision's eventual confirmation cleanup.
    const comparable = {
      ...draft.selection,
      modeId: canonicalMode(draft.selection.modeId, session.agent?.runConfig),
    };
    if (same(JSON.parse(JSON.stringify(comparable)), selection)) return;
    await this.ports.store.saveDraft(
      context.scope,
      context.sessionId,
      draft.revision,
      draft.text,
      selection,
      context.current,
      draft.actor,
    );
    this.ports.context.value.draft = await this.ports.store.readDraft(
      context.scope,
      context.sessionId,
      context.current,
    );
  }
  async saveApprovalDefault(modeId: string) {
    const parsed = approvalModeSchema.safeParse(modeId);
    if (!parsed.success) return;
    const context = this.ports.context.context(),
      session = this.ports.context.value.session;
    if (!session || !context.project.runtime.features?.includes(AGENT_CONTROLS_FEATURE))
      throw Error('执行主机尚不支持保存审批默认值，请升级主机。');
    const selected = parsed.data;
    const params = {
      agentId: session.meta.agentConfigId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    };
    const response = runPreferencesResponseSchema.parse(
      await this.ports.context.execute(
        context,
        this.ports.context.command(context.scope, 'run-preferences', { ...params, action: 'read' }),
      ),
    );
    const saved = runPreferencesResponseSchema.parse(
      await this.ports.context.execute(
        context,
        this.ports.context.command(context.scope, 'run-preferences', {
          ...params,
          action: 'save',
          modeId: selected,
          expectedRevision: response.preferences.revision,
        }),
      ),
    );
    context.current();
    return saved.preferences;
  }
  async saveRunDefaults(selection: RunSelection) {
    const selected = z
      .object({
        modelId: z.string().min(1).max(300),
        reasoningEffort: z.string().min(1).max(300).optional(),
      })
      .strict()
      .parse({
        modelId: selection.modelId,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      });
    const context = this.ports.context.context(),
      session = this.ports.context.value.session;
    if (!session || !context.project.runtime.features?.includes(AGENT_RUN_DEFAULTS_FEATURE))
      throw Error('执行主机尚不支持保存模型默认值，请升级主机。');
    const params = {
      agentId: session.meta.agentConfigId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    };
    const response = runDefaultsResponseSchema.parse(
      await this.ports.context.execute(
        context,
        this.ports.context.command(context.scope, 'run-preferences', {
          ...params,
          action: 'read-defaults',
        }),
      ),
    );
    const saved = runDefaultsResponseSchema.parse(
      await this.ports.context.execute(
        context,
        this.ports.context.command(context.scope, 'run-preferences', {
          ...params,
          action: 'save-defaults',
          selection: selected,
          expectedRevision: response.defaults.revision,
        }),
      ),
    );
    context.current();
    return saved.defaults;
  }
  async readUsage(force = false) {
    const context = this.ports.context.context(),
      session = this.ports.context.value.session;
    if (
      !session ||
      !context.sessionId ||
      !context.project.runtime.features?.includes(AGENT_CONTROLS_FEATURE)
    )
      return;
    if (
      this.ports.context.value.usageLoading &&
      this.usageReadGeneration === this.ports.context.generation
    )
      return;
    this.usageReadGeneration = this.ports.context.generation;
    this.ports.context.value.usageLoading = true;
    this.ports.context.emit();
    try {
      const result = agentUsageResponseSchema.parse(
        await this.ports.context.execute(
          context,
          this.ports.context.command(context.scope, 'agent-usage', {
            agentId: session.meta.agentConfigId,
            sessionId: context.sessionId,
            ...(force ? { refresh: true } : {}),
          }),
        ),
      );
      context.current();
      this.ports.context.value.session = {
        ...this.ports.context.value.session!,
        accountUsage: result.usage,
      };
    } finally {
      context.current();
      this.ports.context.value.usageLoading = false;
      this.ports.context.emit();
    }
  }
  dispose() {
    this.discardSessionReplica();
    this.sessionViews.clear();
    this.sessionViewBytes = 0;
  }
}
