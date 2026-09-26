import {
  taskActionSchema,
  validateTaskActionResult,
  type TaskAction,
} from '@moor/protocol/task-protocol';
import { ProjectContentController } from '../files/project-content-controller';
import { beginSessionPerformanceRead } from '../performance/performance-signals';
import { workspaceContentCache } from '../files/workspace-content-cache';
import { projectContentKey } from '../files/project-content';
import {
  projectDiffReferenceSchema,
  PROJECT_TREE_FEATURE,
  PROJECT_DIFF_FEATURE,
} from '@moor/protocol/project-content-protocol';
import { actorKey, type AttentionActor } from '@moor/protocol/attention';
import {
  AttentionController,
  deliverAttention,
  attentionScopeKey,
  attentionRouteSchema,
  attentionPendingKey,
  type AttentionRoute,
  type AttentionDependencies,
} from '../attention/attention';
import { workspaceAttentionKey, workspaceAttentionRequest } from '../attention/workspace-attention';
import { validateWorkspaceAttentionResponse } from '@moor/client/workspace-attention';
import { searchSessionContent, type SessionSearchView } from '../sessions/session-search';
import { SESSION_SEARCH_FEATURE, type SearchHit } from '@moor/protocol/search-protocol';
import { GithubSessionController, type GithubSessionMode } from '../github/github-session';
import { githubKey } from '../github/github';
import { githubWriteKey } from '../github/github-write';
import { GITHUB_FEATURE } from '@moor/protocol/github-protocol';
import { GITHUB_WRITE_FEATURE } from '@moor/protocol/github-write-protocol';
import { z } from 'zod';
import {
  desktopWorkspaceCatalogSchema,
  desktopWorkspaceTargetSchema,
  desktopWorkspaceChangeSchema,
  type DesktopWorkspaceChange,
  type DesktopWorkspaceCatalog,
  type DesktopWorkspaceRequest,
  type DesktopWorkspaceSource,
} from '@moor/client/workspace-protocol';
import {
  agentSchema,
  AGENT_MODEL_OPTIONS_FEATURE,
  sessionActionSchema,
  type SessionAction,
} from '@moor/protocol/protocol';
import type { HostCommand } from '@moor/protocol/host-command';
import { validateHostResponse } from '@moor/protocol/host-response';
import {
  SESSION_PAGE_FEATURE,
  sessionPageRequestSchema,
  validateSessionPageResult,
  sessionPageMatches,
  compareSessionPageItems,
  type SessionPageRequest,
} from '@moor/protocol/session-page';
import {
  ClientSessionReplica,
  readClientSession,
  type SessionPermissionReview,
  type SessionPermissionOutcome,
} from '@moor/client/session-client';
import { buildSendTurn, buildRespondPermission } from '@moor/client/session-intent';
import { SESSION_INTENTS_FEATURE } from '@moor/protocol/session-intent-protocol';
import {
  sessionListSchema,
  mutationReceiptSchema,
  type SessionMetadata,
  validateSessionActionReceipt,
} from '@moor/protocol/session-responses';
import {
  sessionControlActionSchema,
  validateSessionControlReceipt,
  validateSessionOperationResult,
} from '@moor/protocol/session-control-protocol';
import {
  initializeRunSelection,
  canonicalMode,
  selectionFromInput,
  approvalModeSchema,
  type RunSelection,
} from '@moor/protocol/run-config';
import {
  AGENT_CONTROLS_FEATURE,
  AGENT_RUN_DEFAULTS_FEATURE,
  agentUsageResponseSchema,
  runDefaultsResponseSchema,
  runPreferencesResponseSchema,
} from '@moor/protocol/agent-controls';
import { publicAgentFailure } from '@moor/protocol/agent-errors';
import {
  WorkspaceStore,
  sessionPendingOperations,
  type WorkspaceScope,
  type WorkspaceDraft,
  type WorkspaceLedger,
} from './workspace-store';
import { productCanonicalJson } from '@moor/protocol/canonical-json';
import { createAttachmentDraftItem } from '../attachments/attachments';
import { emptyWorkspaceAttachments } from '../attachments/workspace-attachments';
import {
  attachmentActionSchema,
  attachmentReceiptSchema,
  attachmentContentSchema,
  ATTACHMENTS_FEATURE,
  MAX_TURN_ATTACHMENTS,
} from '@moor/protocol/attachment-protocol';
import {
  attachmentReferenceSchema,
  type AttachmentReference,
} from '@moor/protocol/content-protocol';
import { verifyAttachmentBytes } from '../attachments/attachments';
import {
  InteractionController,
  interactionSavedSchema,
  interactionKey,
  emptyInteractionSaved,
  type QuestionDraftValues,
} from '../interactions/interactions';
import {
  questionRequestSchema,
  type QuestionRequest,
  type QuestionAnswer,
  QUESTIONS_FEATURE,
  STEER_FEATURE,
} from '@moor/protocol/interaction-protocol';
import { workspaceInteractionSnapshot } from '../interactions/workspace-interactions';
import { SkillsController } from '../skills/skills';
import { SKILLS_FEATURE } from '@moor/protocol/skills-protocol';
import { workspaceFeatureTarget } from '../mcp/workspace-mcp';
import { gitStateResultSchema } from '@moor/protocol/git-protocol';
import { SessionForkController, sessionForkKey, type ForkSaved } from '../fork/session-fork';
import { workspaceForkPending } from '../fork/workspace-fork';
import {
  SESSION_FORK_FEATURE,
  FORK_OPERATIONS_FEATURE,
  forkCutoffSchema,
  forkDirectorySchema,
  validateForkOperationResult,
  type ForkCutoff,
  type ForkDirectory,
} from '@moor/protocol/fork-protocol';
import { GitWorkspaceController, gitWorkspaceKey, type GitSaved } from '../git/git-workspace';
import {
  GIT_WORKTREE_FEATURE,
  GIT_OPERATIONS_FEATURE,
  validateGitOperationResult,
} from '@moor/protocol/git-protocol';

type Project = DesktopWorkspaceCatalog['targets'][number];
export type WorkspaceSessionPageOptions = Partial<
  Pick<SessionPageRequest, 'archived' | 'pinned' | 'query' | 'limit' | 'cursor'>
> & { fresh?: boolean };
export type WorkspaceSessionPage = {
  items: SessionMetadata[];
  nextCursor: string | null;
  revision?: string;
  source: 'host' | 'cache';
  partial: boolean;
  legacy: boolean;
};
const projectListingIdentity = (project: Project) => ({
  target: project.target,
  online: project.online,
  runtime: {
    id: project.runtime.id,
    userId: project.runtime.userId,
    machineId: project.runtime.machineId,
    project: project.runtime.projects.find((entry) => entry.id === project.target.localProjectId),
    features: project.runtime.features,
    agents: project.runtime.agents.map(({ id, cliType, agentType }) => ({
      id,
      cliType,
      agentType,
    })),
  },
});
type Session = Omit<ReturnType<typeof readClientSession>, 'update'>;
type ClientSessionDelta = NonNullable<ClientSessionReplica['lastRead']>;
type Context = {
  scope: WorkspaceScope;
  project: Project;
  sessionId?: string;
  connectionId: string;
  current: () => void;
};
export type WorkspaceClientState = {
  catalogs: Partial<Record<DesktopWorkspaceSource, DesktopWorkspaceCatalog>>;
  errors: Partial<Record<DesktopWorkspaceSource, string>>;
  scope?: WorkspaceScope;
  project?: Project;
  sessions: SessionMetadata[];
  sessionPage?: WorkspaceSessionPage;
  sessionListError?: string;
  sessionId?: string;
  session?: Session;
  /** Host confirmation and an offline cache commit are independent facts. */
  sessionCache?: { status: 'saving' | 'saved' | 'failed' | 'unavailable'; version?: string };
  sendProgress?: {
    sessionId: string;
    stage: 'preparing' | 'uploading' | 'sending';
    uploaded?: number;
    total?: number;
  };
  offline: boolean;
  sessionLoad:
    | { status: 'idle' }
    | { status: 'loading-cache'; showIndicator?: boolean }
    | { status: 'refreshing'; source: 'none' | 'cache' | 'host' }
    | { status: 'ready'; source: 'host' }
    | {
        status: 'failed';
        source: 'none' | 'cache' | 'host';
        reason: 'connection' | 'local';
      };
  ledger?: WorkspaceLedger;
  draft?: WorkspaceDraft;
  modelError?: string;
  usageLoading?: boolean;
  modelLoading?: boolean;
  searchFocus?: SearchHit;
  focusedTurnId?: string;
  syncDisconnected?: Partial<Record<DesktopWorkspaceSource, boolean>>;
};
const resultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.string(),
          status: z.number().nullable(),
          rejected: z.boolean(),
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
]);
const same = (a: unknown, b: unknown) => productCanonicalJson(a) === productCanonicalJson(b);
export class WorkspaceRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null,
    readonly rejected: boolean,
  ) {
    super(message);
  }
}
const offlineFailure = (error: unknown) =>
  error instanceof WorkspaceRequestError &&
  (error.code === 'network' || (!error.rejected && [502, 503, 504].includes(error.status ?? 0)));
export const isWorkspaceListOfflineFailure = (error: unknown) =>
  error instanceof WorkspaceRequestError &&
  (error.code === 'network' || (!error.rejected && [503, 504].includes(error.status ?? 0)));
const DRAFT_SAVE_DELAY_MS = 300;
const SESSION_LOADING_DELAY_MS = 120;
const SESSION_VIEW_LIMIT = 30;
const SESSION_VIEW_BYTES = 32 * 1024 * 1024;
type SessionView = {
  session: Session;
  draft: WorkspaceDraft;
  sessionBytes: number;
  draftBytes: number;
  bytes: number;
};
const frozenSnapshots = new WeakSet<object>();
const snapshotSizes = new WeakMap<object, number>();
const viewBudgetSizes = new WeakMap<object, number>();
const snapshotEncoder = new TextEncoder();
function immutableSnapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object' || frozenSnapshots.has(value)) return value;
  frozenSnapshots.add(value);
  for (const child of Object.values(value)) immutableSnapshot(child);
  return Object.freeze(value);
}
// Session views contain JSON data. Count only changed immutable branches rather
// than serializing the entire transcript again for every streaming cache update.
function immutableJsonBytes(value: unknown, viewBudget = false): number {
  // A JSON string needs at most six UTF-8 bytes per UTF-16 code unit (\uXXXX),
  // plus quotes. Only the in-memory view LRU uses this conservative budget:
  // large text may be evicted earlier, without serializing it on every chunk.
  if (viewBudget && typeof value === 'string' && value.length > 4096) return 2 + 6 * value.length;
  if (value === null || typeof value !== 'object')
    return snapshotEncoder.encode(JSON.stringify(value) ?? 'null').byteLength;
  const sizes = viewBudget ? viewBudgetSizes : snapshotSizes;
  const previous = sizes.get(value);
  if (previous !== undefined) return previous;
  let bytes = 2,
    count = 0;
  if (Array.isArray(value)) {
    for (const child of value) {
      bytes += immutableJsonBytes(child, viewBudget);
      count++;
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      bytes += immutableJsonBytes(key, viewBudget) + 1 + immutableJsonBytes(child, viewBudget);
      count++;
    }
  }
  bytes += Math.max(0, count - 1);
  sizes.set(value, bytes);
  return bytes;
}
const sessionViewBudget = (value: unknown) => immutableJsonBytes(value, true);
const withoutSource = <T>(
  values: Partial<Record<DesktopWorkspaceSource, T>>,
  source: DesktopWorkspaceSource,
) => {
  const result = { ...values };
  delete result[source];
  return result;
};
type BufferedDraft = {
  scope: WorkspaceScope;
  sessionId: string;
  text: string;
  selection: RunSelection;
  actor?: AttentionActor;
  failed?: (error: unknown) => void;
  saved?: () => void;
  committed?: WorkspaceDraft;
};

/** Shared browser/desktop controller over the finite local or relay transport. */
export class WorkspaceController {
  #catalogAttempts = new Map<string, string | undefined>();
  #warmScopes = new Set<string>();
  #state: WorkspaceClientState = {
    catalogs: {},
    errors: {},
    sessions: [],
    offline: true,
    sessionLoad: { status: 'idle' },
  };
  #snapshot?: WorkspaceClientState;
  #generation = 0;
  #closed = false;
  #listeners = new Set<() => void>();
  #draftWrites: Promise<void> = Promise.resolve();
  #interactionWrites: Promise<void> = Promise.resolve();
  #draftBuffer?: BufferedDraft;
  // Keep the latest input addressable while flushDraft has taken it out of the
  // buffer but its write is still pending. Explicit actions freeze that input.
  #draftInput?: BufferedDraft;
  #cancelDraftSave?: () => void;
  #sessionViews = new Map<string, SessionView>();
  #sessionViewBytes = 0;
  #sessionReplica?: ClientSessionReplica;
  #sessionReplicaKey?: string;
  #sessionCacheQueue?: {
    replica: ClientSessionReplica;
    pending: { read: ClientSessionDelta; bytes: number }[];
    bytes: number;
    current: () => void;
    context: Context;
    running?: Promise<void>;
  };
  #sessionFlight?: { generation: number; again: boolean; promise: Promise<void> };
  #sendFlight?: { generation: number };
  #sessionSyncPending = false;
  #sessionSyncing?: { generation: number; promise: Promise<void> };
  #catalogVersions = { local: 0, remote: 0 };
  #sessionReadVersion = 0;
  #sessionListReadVersion = 0;
  #modelReadVersion = 0;
  #usageReadGeneration?: number;
  #projectRevisions = new Map<string, number>();
  #sessionPages = new Map<string, { page: WorkspaceSessionPage; scope: string; bytes: number }>();
  #sessionPageBytes = 0;
  #sessionPagesReading = new Map<string, Promise<WorkspaceSessionPage>>();
  #legacyListsReading = new Map<string, Promise<SessionMetadata[]>>();
  #catalogFailures = new Map<DesktopWorkspaceSource, unknown>();
  #syncPending = new Map<
    DesktopWorkspaceSource,
    DesktopWorkspaceChange & { catalogOnly: boolean }
  >();
  #syncing?: Promise<void>;
  #cancelSync?: () => void;
  #sessionListReads = 0;
  #syncAfterRead = false;
  #syncAfterList = false;
  #catalogReads = { local: 0, remote: 0 };
  #syncAfterCatalog = new Set<DesktopWorkspaceSource>();
  constructor(
    private readonly options: {
      request: (request: DesktopWorkspaceRequest) => Promise<unknown>;
      store?: WorkspaceStore;
      uuid?: () => string;
      now?: () => string;
      schedule?: (ms: number, work: () => void) => () => void;
      /** Yield low-priority cache work; tests inject deterministic barriers. */
      yieldCache?: () => Promise<void>;
      restoreLegacy?: (
        scope: WorkspaceScope,
        sessionId: string,
        current: () => void,
      ) => Promise<void>;
    },
  ) {
    this.store = options.store ?? new WorkspaceStore();
  }
  readonly store: WorkspaceStore;
  /** An immutable view. Changed branches are replaced; retained snapshots never
   * observe later edits, and reading a snapshot does not copy session history. */
  get state() {
    const keys = Object.keys(this.#state) as (keyof WorkspaceClientState)[];
    if (
      !this.#snapshot ||
      keys.length !== Object.keys(this.#snapshot).length ||
      keys.some(
        (key) => !Object.hasOwn(this.#snapshot!, key) || this.#snapshot![key] !== this.#state[key],
      )
    )
      this.#snapshot = immutableSnapshot({ ...this.#state });
    return this.#snapshot;
  }
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #emit() {
    // Navigation revisions also live outside #state. A notification publishes a
    // new root while unchanged immutable session/ledger branches stay shared.
    this.#snapshot = undefined;
    for (const listener of this.#listeners) listener();
  }
  get navigationRevision() {
    return this.#catalogVersions.local + this.#catalogVersions.remote;
  }
  projectRevision(source: DesktopWorkspaceSource, target: Project['target']) {
    return this.#projectRevisions.get(productCanonicalJson([source, target])) ?? 0;
  }
  #invalidateProject(source: DesktopWorkspaceSource, target: Project['target']) {
    const key = productCanonicalJson([source, target]);
    this.#projectRevisions.set(key, this.projectRevision(source, target) + 1);
    this.#forgetSessionPages(key);
  }
  #forgetSessionPages(scope: string) {
    for (const [key, value] of this.#sessionPages)
      if (value.scope === scope) {
        this.#sessionPages.delete(key);
        this.#sessionPageBytes -= value.bytes;
      }
  }
  #enqueueSync(raw?: unknown) {
    if (this.#closed) return;
    if (raw === undefined) {
      for (const catalog of Object.values(this.#state.catalogs))
        this.#enqueueSync({
          source: catalog.source,
          connectionId: catalog.connectionId,
          owner: catalog.owner,
          kind: 'connected',
        });
      return;
    }
    const parsed = desktopWorkspaceChangeSchema.safeParse(raw);
    if (!parsed.success) return;
    const notice = parsed.data,
      catalog = this.#state.catalogs[notice.source];
    if (!catalog || catalog.connectionId !== notice.connectionId || catalog.owner !== notice.owner)
      return;
    if (
      notice.deviceId &&
      !catalog.targets.some(
        ({ target }) =>
          target.deviceId === notice.deviceId &&
          (!notice.workspaceId || target.workspaceId === notice.workspaceId),
      )
    )
      return;
    this.#state.syncDisconnected = {
      ...this.#state.syncDisconnected,
      [notice.source]: notice.kind === 'disconnected',
    };
    if (notice.kind === 'disconnected') {
      this.#emit();
      return;
    }
    const scope = this.#state.scope;
    if (
      this.#state.sessionId &&
      scope?.source === notice.source &&
      (!notice.deviceId || scope.target.deviceId === notice.deviceId) &&
      (!notice.workspaceId || scope.target.workspaceId === notice.workspaceId) &&
      (!notice.sessionId || notice.sessionId === this.#state.sessionId) &&
      (notice.kind === 'connected' || notice.workspaceId || notice.sessionId)
    )
      this.#sessionSyncPending = true;
    const prior = this.#syncPending.get(notice.source),
      catalogOnly = notice.kind === 'changed' && !notice.workspaceId && !notice.sessionId;
    this.#syncPending.set(
      notice.source,
      prior
        ? {
            ...notice,
            kind: prior.kind === 'connected' ? 'connected' : notice.kind,
            deviceId: prior.deviceId === notice.deviceId ? notice.deviceId : undefined,
            workspaceId: prior.workspaceId === notice.workspaceId ? notice.workspaceId : undefined,
            sessionId: prior.sessionId === notice.sessionId ? notice.sessionId : undefined,
            catalogOnly: prior.catalogOnly && catalogOnly,
          }
        : { ...notice, catalogOnly },
    );
  }
  /** Read-only catch-up. Never retries a draft, approval or pending operation. */
  scheduleSync(raw?: unknown) {
    this.#enqueueSync(raw);
    void this.#drainSessionSync();
    this.#scheduleSidebarSync();
  }
  #scheduleSidebarSync() {
    if (this.#closed || this.#cancelSync || !this.#syncPending.size) return;
    this.#cancelSync = this.#schedule(500, () => {
      this.#cancelSync = undefined;
      void this.#drainSync();
    });
  }
  async synchronize(raw?: unknown) {
    this.#enqueueSync(raw);
    this.#cancelSync?.();
    this.#cancelSync = undefined;
    await Promise.all([this.#drainSessionSync(), this.#drainSync()]);
    await this.#drainSessionSync();
  }
  #drainSessionSync(): Promise<void> {
    if (this.#sessionSyncing?.generation === this.#generation) return this.#sessionSyncing.promise;
    if (this.#closed || !this.#sessionSyncPending) return Promise.resolve();
    const drain = { generation: this.#generation, promise: Promise.resolve() };
    this.#sessionSyncing = drain;
    // A microtask joins a synchronous notification burst without adding a timer
    // to the active transcript. Subsequent reads only chase notices received in flight.
    drain.promise = Promise.resolve()
      .then(async () => {
        while (
          !this.#closed &&
          this.#generation === drain.generation &&
          this.#sessionSyncing === drain &&
          this.#sessionSyncPending
        ) {
          this.#sessionSyncPending = false;
          if (!this.#state.sessionId) continue;
          if (['loading-cache', 'refreshing'].includes(this.#state.sessionLoad.status)) {
            this.#syncAfterRead = true;
            break;
          }
          try {
            await this.refreshSession({ announce: false, background: true });
          } catch {
            // The read retains the confirmed transcript and reports connectivity.
          }
        }
      })
      .finally(() => {
        // A response from a previous selection cannot consume its successor's
        // pending notice or clear the new selection's in-flight drain.
        if (this.#sessionSyncing !== drain) return;
        this.#sessionSyncing = undefined;
        if (drain.generation === this.#generation && this.#sessionSyncPending && !this.#closed)
          void this.#drainSessionSync();
      });
    return drain.promise;
  }
  #drainSync(): Promise<void> {
    if (this.#syncing) return this.#syncing;
    this.#syncing = (async () => {
      if (!this.#closed && this.#syncPending.size) {
        const pending = [...this.#syncPending.values()];
        this.#syncPending.clear();
        for (const notice of pending) {
          const catalog = this.#state.catalogs[notice.source];
          if (catalog?.connectionId !== notice.connectionId || catalog.owner !== notice.owner)
            continue;
          try {
            if (this.#catalogReads[notice.source]) {
              this.#syncAfterCatalog.add(notice.source);
              continue;
            }
            const selected = this.#state.scope,
              selectedRevision = selected
                ? this.projectRevision(selected.source, selected.target)
                : undefined;
            if (notice.kind === 'connected' || !notice.workspaceId)
              await this.refreshCatalog(notice.source);
            const targets = this.#state.catalogs[notice.source]?.targets ?? [];
            for (const { target } of targets)
              if (
                !notice.catalogOnly &&
                (!notice.deviceId || target.deviceId === notice.deviceId) &&
                (!notice.workspaceId || target.workspaceId === notice.workspaceId)
              )
                this.#invalidateProject(notice.source, target);
            this.#emit();
            const scope = this.#state.scope;
            if (
              !scope ||
              scope.source !== notice.source ||
              (notice.deviceId && scope.target.deviceId !== notice.deviceId) ||
              (notice.workspaceId && scope.target.workspaceId !== notice.workspaceId)
            )
              continue;
            if (
              notice.catalogOnly &&
              same(selected, scope) &&
              selectedRevision === this.projectRevision(scope.source, scope.target)
            )
              continue;
            const current = this.#current();
            await this.refreshSessions({ background: true });
            current();
            if (notice.kind === 'connected' && this.#state.sessionId) {
              this.#sessionSyncPending = true;
              void this.#drainSessionSync();
            }
          } catch {
            // Read methods retain the last confirmed view and expose their connection state.
          }
        }
      }
    })().finally(() => {
      this.#syncing = undefined;
      this.#scheduleSidebarSync();
    });
    return this.#syncing;
  }
  get contextRevision() {
    return this.#generation;
  }
  #current() {
    const generation = this.#generation;
    return () => {
      if (this.#closed || generation !== this.#generation)
        throw Error('当前电脑、项目或会话已改变，请重新读取。');
    };
  }
  #uuid() {
    return (this.options.uuid ?? (() => crypto.randomUUID()))();
  }
  #sessionViewKey(scope: WorkspaceScope, sessionId: string) {
    return productCanonicalJson(['workspace-session-view-v1', scope, sessionId]);
  }
  #discardSessionCacheQueue(queue = this.#sessionCacheQueue) {
    if (queue) {
      queue.pending = [];
      queue.bytes = 0;
    }
    if (this.#sessionCacheQueue === queue) {
      this.#sessionCacheQueue = undefined;
      delete this.#state.sessionCache;
    }
  }
  #discardSessionReplica(replica = this.#sessionReplica) {
    replica?.dispose();
    if (this.#sessionReplica === replica) {
      this.#discardSessionCacheQueue();
      this.#sessionReplica = undefined;
      this.#sessionReplicaKey = undefined;
    }
  }
  #replica(scope: WorkspaceScope, sessionId: string) {
    const key = this.#sessionViewKey(scope, sessionId);
    if (!this.#sessionReplica || this.#sessionReplicaKey !== key) {
      this.#discardSessionReplica();
      this.#sessionReplica = new ClientSessionReplica({ ...scope.target, sessionId });
      this.#sessionReplicaKey = key;
    }
    return this.#sessionReplica;
  }
  #queueSessionCache(replica: ClientSessionReplica, read: ClientSessionDelta) {
    if (read.response.persisted === false || read.response.persistenceError) {
      this.#state.sessionCache = { status: 'unavailable' };
      return;
    }
    let queue = this.#sessionCacheQueue;
    if (!queue || queue.replica !== replica) {
      const context = this.#context();
      queue = { replica, context, pending: [], bytes: 0, current: () => {} };
      const captured = queue;
      queue.current = () => {
        context.current();
        const catalog = this.#state.catalogs[context.scope.source];
        if (
          this.#sessionCacheQueue !== captured ||
          this.#sessionReplica !== replica ||
          catalog?.connectionId !== context.connectionId ||
          catalog.owner !== context.scope.target.owner
        )
          throw Error('缓存保存范围已改变');
      };
      this.#sessionCacheQueue = queue;
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
    this.#state.sessionCache = { status: 'saving', version: this.#state.sessionCache?.version };
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
          this.#discardSessionCacheQueue(captured);
          return;
        }
        const next = captured.pending.shift()!;
        captured.bytes -= next.bytes;
        let savedVersion: string | undefined;
        let failed = false;
        try {
          savedVersion = await this.store.cacheSessionDelta(
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
          this.#discardSessionCacheQueue(captured);
          return;
        }
        if (!captured.pending.length && replica.lastRead === next.read) {
          this.#state.sessionCache = failed
            ? { status: 'failed', version: this.#state.sessionCache?.version }
            : { status: 'saved', version: savedVersion };
          this.#emit();
        }
      }
    };
    const start = () => {
      captured.running = drain().finally(() => {
        captured.running = undefined;
        if (captured.pending.length && this.#sessionCacheQueue === captured) start();
      });
    };
    start();
  }
  #exportSessionSnapshot(context: Context) {
    context.current();
    const replica = this.#sessionReplica;
    if (
      !context.sessionId ||
      !replica ||
      this.#sessionReplicaKey !== this.#sessionViewKey(context.scope, context.sessionId) ||
      !replica.view ||
      replica.view.version !== this.#state.session?.version
    )
      throw Error('当前会话副本已改变，请重新读取。');
    return {
      ...replica.exportSnapshot(),
      agent: this.#state.session.agent,
      accountUsage: this.#state.session.accountUsage,
    };
  }
  #sessionView(scope: WorkspaceScope, sessionId: string) {
    const key = this.#sessionViewKey(scope, sessionId),
      value = this.#sessionViews.get(key);
    if (!value) return;
    this.#sessionViews.delete(key);
    this.#sessionViews.set(key, value);
    return value;
  }
  #rememberSessionView(scope: WorkspaceScope, sessionId: string) {
    const session = this.#state.session,
      draft = this.#state.draft;
    if (!session || !draft || session.meta.id !== sessionId) return;
    immutableSnapshot(session);
    immutableSnapshot(draft);
    const key = this.#sessionViewKey(scope, sessionId),
      previous = this.#sessionViews.get(key),
      sessionBytes =
        previous?.session === session ? previous.sessionBytes : sessionViewBudget(session),
      draftBytes = previous?.draft === draft ? previous.draftBytes : sessionViewBudget(draft),
      // Exact JSON wrapper overhead for {"session":...,"draft":...}.
      bytes = sessionBytes + draftBytes + 21;
    if (previous) this.#sessionViewBytes -= previous.bytes;
    this.#sessionViews.delete(key);
    if (bytes > SESSION_VIEW_BYTES) return;
    this.#sessionViews.set(
      key,
      immutableSnapshot({ session, draft, sessionBytes, draftBytes, bytes }),
    );
    this.#sessionViewBytes += bytes;
    this.#trimSessionViews();
  }
  #rememberSessionDraft(scope: WorkspaceScope, sessionId: string) {
    const key = this.#sessionViewKey(scope, sessionId),
      value = this.#sessionViews.get(key),
      draft = this.#state.draft;
    if (!value || !draft || this.#state.sessionId !== sessionId) return;
    this.#sessionViewBytes -= value.bytes;
    const draftBytes = sessionViewBudget(immutableSnapshot(draft)),
      bytes = value.sessionBytes + draftBytes + 21;
    this.#sessionViews.delete(key);
    this.#sessionViews.set(key, immutableSnapshot({ ...value, draft, draftBytes, bytes }));
    this.#sessionViewBytes += bytes;
    this.#trimSessionViews();
  }
  #trimSessionViews() {
    while (
      this.#sessionViews.size > SESSION_VIEW_LIMIT ||
      this.#sessionViewBytes > SESSION_VIEW_BYTES
    ) {
      const oldest = this.#sessionViews.keys().next().value!,
        removed = this.#sessionViews.get(oldest)!;
      this.#sessionViews.delete(oldest);
      this.#sessionViewBytes -= removed.bytes;
    }
  }
  #schedule(milliseconds: number, work: () => void) {
    if (this.options.schedule) return this.options.schedule(milliseconds, work);
    const timer = setTimeout(work, milliseconds);
    return () => clearTimeout(timer);
  }
  async #request(request: DesktopWorkspaceRequest, current: () => void) {
    current();
    const result = resultSchema.parse(await this.options.request(structuredClone(request)));
    current();
    if (!result.ok)
      throw new WorkspaceRequestError(
        publicAgentFailure(
          Error(result.error.message),
          '执行电脑暂不可用，原草稿和待确认操作已保留。',
        ),
        result.error.code,
        result.error.status,
        result.error.rejected,
      );
    return result.value;
  }
  async refreshCatalog(source: DesktopWorkspaceSource) {
    if (this.#state.scope?.source === source) await this.flushDraft();
    const version = ++this.#catalogVersions[source];
    this.#catalogReads[source]++;
    const current = () => {
      if (this.#closed || this.#catalogVersions[source] !== version)
        throw Error('电脑列表读取已过期。');
    };
    try {
      const catalog = desktopWorkspaceCatalogSchema.parse(
        await this.#request({ action: 'catalog', source }, current),
      );
      if (catalog.source !== source) throw Error('电脑列表来源不匹配。');
      const previous = this.#state.catalogs[source];
      if (
        this.#state.scope?.source === source &&
        (!previous ||
          previous.connectionId !== catalog.connectionId ||
          previous.owner !== catalog.owner ||
          !same(previous.actor ?? null, catalog.actor ?? null) ||
          !catalog.targets.some((entry) => same(entry.target, this.#state.scope!.target)))
      )
        this.#clearSelection();
      this.#state.catalogs = { ...this.#state.catalogs, [source]: catalog };
      const identityChanged =
        !previous ||
        previous.connectionId !== catalog.connectionId ||
        previous.owner !== catalog.owner ||
        !same(previous.actor ?? null, catalog.actor ?? null);
      for (const project of catalog.targets) {
        const old = previous?.targets.find((entry) => same(entry.target, project.target));
        if (
          identityChanged ||
          !old ||
          !same(projectListingIdentity(old), projectListingIdentity(project)) ||
          !same(old.runtime.agents, project.runtime.agents)
        )
          this.#invalidateProject(source, project.target);
      }
      for (const old of previous?.targets ?? [])
        if (!catalog.targets.some((entry) => same(entry.target, old.target)))
          this.#invalidateProject(source, old.target);
      if (this.#state.scope?.source === source) {
        const active = catalog.targets.find((entry) =>
          same(entry.target, this.#state.scope!.target),
        )!;
        this.#state.project = structuredClone(active);
        this.#state.offline = !active.online;
      }
      this.#state.errors = withoutSource(this.#state.errors, source);
      this.#catalogFailures.delete(source);
    } catch (error) {
      current();
      this.#catalogFailures.set(source, error);
      this.#state.errors = { ...this.#state.errors, [source]: '暂时无法连接此电脑列表。' };
      if (this.#state.scope?.source === source) {
        this.#generation++;
        // The visible replica can resume after reconnect, but its cache writer
        // holds the old connection generation and must never be reused.
        this.#discardSessionCacheQueue();
        this.#state.offline = true;
      }
      throw error;
    } finally {
      this.#catalogReads[source]--;
      if (!this.#catalogReads[source] && this.#syncAfterCatalog.delete(source)) this.scheduleSync();
      if (!this.#closed && this.#catalogVersions[source] === version) this.#emit();
    }
  }
  async disconnectSource(source: DesktopWorkspaceSource) {
    if (this.#state.scope?.source === source) {
      await this.flushDraft();
      this.#clearSelection();
    }
    this.#catalogVersions[source]++;
    this.#syncPending.delete(source);
    this.#state.catalogs = withoutSource(this.#state.catalogs, source);
    this.#catalogFailures.delete(source);
    this.#state.errors = withoutSource(this.#state.errors, source);
    if (this.#state.syncDisconnected)
      this.#state.syncDisconnected = withoutSource(this.#state.syncDisconnected, source);
    this.#emit();
  }
  #clearSelection() {
    this.#sessionSyncPending = false;
    this.#syncAfterRead = false;
    this.#cancelDraftSave?.();
    this.#cancelDraftSave = undefined;
    this.#draftBuffer = undefined;
    this.#draftInput = undefined;
    this.#discardSessionReplica();
    this.#generation++;
    this.#state = {
      catalogs: this.#state.catalogs,
      errors: this.#state.errors,
      sessions: [],
      offline: true,
      sessionLoad: { status: 'idle' },
    };
    this.#draftWrites = Promise.resolve();
    this.#interactionWrites = Promise.resolve();
  }
  async selectProject(source: DesktopWorkspaceSource, target: Project['target']) {
    await this.flushDraft();
    const project = this.#state.catalogs[source]?.targets.find((entry) =>
      same(entry.target, target),
    );
    if (!project) throw Error('项目不属于当前电脑列表。');
    this.#clearSelection();
    this.#state.scope = { source, target: structuredClone(project.target) };
    this.#state.project = structuredClone(project);
    this.#state.offline = !project.online;
    const current = this.#current();
    this.#emit();
    this.#state.ledger = await this.store.read(this.#state.scope, current, []);
    this.#emit();
    await this.refreshSessions();
    const warmKey = JSON.stringify([source, target]);
    if (
      project.online &&
      project.runtime.features?.includes('agent-catalog-cache-v1') &&
      !this.#warmScopes.has(warmKey)
    ) {
      this.#warmScopes.add(warmKey);
      const context = this.#context();
      // Workspace readiness owns initialization; native probes are coalesced by the host.
      for (const agent of project.runtime.agents) {
        void this.#execute(
          context,
          this.#command(context.scope, 'agent-options', { agentId: agent.id }),
        ).catch(() => {});
        void this.#execute(
          context,
          this.#command(context.scope, 'agent-usage', { agentId: agent.id }),
        ).catch(() => {});
      }
    }
  }
  #context(sessionId = this.#state.sessionId): Context {
    const scope = this.#state.scope,
      project = this.#state.project;
    if (!scope || !project) throw Error('请先选择电脑和项目。');
    const catalog = this.#state.catalogs[scope.source];
    if (!catalog || catalog.owner !== scope.target.owner) throw Error('请重新连接原电脑。');
    const current = this.#current();
    return {
      scope: structuredClone(scope),
      project: structuredClone(project),
      sessionId,
      connectionId: catalog.connectionId,
      current,
    };
  }
  async #execute(context: Context, command: HostCommand) {
    const { scope, sessionId, current, connectionId, project } = context;
    if (this.#state.errors[scope.source]) throw Error('请重新连接原电脑；可以继续编辑本机草稿。');
    const raw = await this.#request(
      {
        action: 'execute',
        source: scope.source,
        connectionId,
        target: { ...scope.target, ...(sessionId ? { sessionId } : {}) },
        command,
      },
      current,
    );
    const value = await validateHostResponse(raw, { command, workspace: project.runtime, current });
    current();
    return value;
  }
  #command(scope: WorkspaceScope, method: HostCommand['method'], params: unknown): HostCommand {
    // All request variants are revalidated by the finite native boundary before dispatch.
    return {
      method,
      params,
      workspaceId: scope.target.workspaceId,
      localProjectId: scope.target.localProjectId,
    } as HostCommand;
  }
  async refreshSessions({ background = false }: { background?: boolean } = {}) {
    if (background && this.#sessionListReads) {
      this.#syncAfterList = true;
      return;
    }
    const context = this.#context();
    this.#sessionListReads++;
    const version = ++this.#sessionListReadVersion,
      selected = context.current;
    context.current = () => {
      selected();
      if (version !== this.#sessionListReadVersion) throw Error('会话列表读取已由较新的请求替代。');
    };
    try {
      const page = await this.listProjectSessionPage(context.scope.source, context.scope.target, {
        fresh: true,
      });
      context.current();
      this.#state.sessions = page.items;
      this.#state.sessionPage = page;
      delete this.#state.sessionListError;
      this.#state.offline = page.source === 'cache';
    } catch (error) {
      context.current();
      if (isWorkspaceListOfflineFailure(error)) this.#state.offline = true;
      this.#state.sessions = [];
      delete this.#state.sessionPage;
      this.#state.sessionListError = '会话列表尚未确认，请重新读取。';
      throw error;
    } finally {
      this.#sessionListReads--;
      if (!this.#sessionListReads && this.#syncAfterList) {
        this.#syncAfterList = false;
        this.scheduleSync();
      }
      context.current();
      this.#emit();
    }
  }
  async listProjectSessions(source: DesktopWorkspaceSource, target: Project['target']) {
    return (await this.listProjectSessionPage(source, target, { fresh: true })).items;
  }
  async refreshProjectSessions(source: DesktopWorkspaceSource, target: Project['target']) {
    await this.refreshCatalog(source);
    const context = this.#projectContext(source, target);
    context.current();
    this.#invalidateProject(source, target);
    this.#emit();
    if (same(this.#state.scope, context.scope)) await this.refreshSessions();
  }
  async listProjectSessionPage(
    source: DesktopWorkspaceSource,
    target: Project['target'],
    options: WorkspaceSessionPageOptions = {},
  ): Promise<WorkspaceSessionPage> {
    const context = this.#projectContext(source, target);
    const revision = this.projectRevision(source, target),
      identity = projectListingIdentity(context.project),
      current = context.current;
    context.current = () => {
      current();
      const latest = this.#state.catalogs[source]?.targets.find((entry) =>
        same(entry.target, target),
      );
      if (
        !latest ||
        revision !== this.projectRevision(source, target) ||
        !same(identity, projectListingIdentity(latest))
      )
        throw Error('项目列表已改变，请重新读取。');
    };
    const { fresh = false, ...filters } = options;
    const request = sessionPageRequestSchema.parse({
      pageVersion: 1,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      ...filters,
    });
    const key = productCanonicalJson([
      context.scope,
      context.connectionId,
      identity,
      revision,
      request,
    ]);
    context.current();
    if (!fresh && context.project.online && !this.#state.errors[source]) {
      const saved = this.#sessionPages.get(key);
      if (saved) return structuredClone(saved.page);
    }
    const active = this.#sessionPagesReading.get(key);
    if (active) return structuredClone(await active);
    const read = (async (): Promise<WorkspaceSessionPage> => {
      const paged = context.project.runtime.features?.includes(SESSION_PAGE_FEATURE) === true;
      let online = context.project.online;
      const checkItems = (items: SessionMetadata[]) => {
        if (
          items.some(
            (item) =>
              item.userId !== target.userId ||
              item.machineId !== target.machineId ||
              item.project.localProjectId !== target.localProjectId,
          )
        )
          throw Error('会话列表执行范围不匹配。');
      };
      if (paged) {
        let page;
        try {
          if (this.#state.errors[source])
            throw this.#catalogFailures.get(source) ?? Error('请重新连接原电脑。');
          if (!online) throw new WorkspaceRequestError('执行电脑离线。', 'network', null, false);
          page = validateSessionPageResult(
            request,
            await this.#execute(context, this.#command(context.scope, 'sessions-page', request)),
          );
          checkItems(page.items);
          await this.store
            .sessionPage(context.scope, context.current, request, page)
            .catch(() => context.current());
        } catch (error) {
          context.current();
          this.#forgetSessionPages(productCanonicalJson([source, target]));
          if (!isWorkspaceListOfflineFailure(error)) throw error;
          page = await this.store.sessionPage(context.scope, context.current, request);
          if (!page) throw error;
          online = false;
        }
        return {
          items: page.items,
          nextCursor: page.nextCursor,
          revision: page.revision,
          source: online ? 'host' : 'cache',
          partial: !online || page.nextCursor !== null,
          legacy: false,
        };
      }
      if (request.cursor) throw Error('旧主机没有可继续的分页游标，请重新读取。');
      // Only an unadvertised capability chooses this compatibility path. An
      // unsuccessful modern page never retries using the full-list endpoint.
      let sessions: SessionMetadata[];
      try {
        if (this.#state.errors[source])
          throw this.#catalogFailures.get(source) ?? Error('请重新连接原电脑。');
        if (!online) throw new WorkspaceRequestError('执行电脑离线。', 'network', null, false);
        const legacyKey = productCanonicalJson([
          context.scope,
          context.connectionId,
          identity,
          revision,
        ]);
        let pending = this.#legacyListsReading.get(legacyKey);
        if (!pending) {
          pending = (async () => {
            const items = sessionListSchema.parse(
              await this.#execute(context, this.#command(context.scope, 'sessions', {})),
            );
            checkItems(items);
            await this.store
              .sessionList(context.scope, context.current, items)
              .catch(() => context.current());
            return items;
          })().finally(() => this.#legacyListsReading.delete(legacyKey));
          this.#legacyListsReading.set(legacyKey, pending);
        }
        sessions = await pending;
      } catch (error) {
        context.current();
        this.#forgetSessionPages(productCanonicalJson([source, target]));
        if (!isWorkspaceListOfflineFailure(error)) throw error;
        const cached = await this.store.sessionList(context.scope, context.current);
        if (!cached) throw error;
        sessions = cached;
        online = false;
      }
      return {
        items: sessions
          .filter((item) => sessionPageMatches(item, request))
          .sort(compareSessionPageItems),
        nextCursor: null,
        source: online ? 'host' : 'cache',
        partial: !online,
        legacy: true,
      };
    })()
      .then((page) => {
        context.current();
        if (page.source === 'host') {
          const bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
          const previous = this.#sessionPages.get(key);
          if (previous) {
            this.#sessionPages.delete(key);
            this.#sessionPageBytes -= previous.bytes;
          }
          if (bytes <= 8 * 1024 * 1024) {
            this.#sessionPages.set(key, {
              page: structuredClone(page),
              scope: productCanonicalJson([source, target]),
              bytes,
            });
            this.#sessionPageBytes += bytes;
          }
          while (this.#sessionPages.size > 64 || this.#sessionPageBytes > 8 * 1024 * 1024) {
            const oldest = this.#sessionPages.keys().next().value!;
            this.#sessionPageBytes -= this.#sessionPages.get(oldest)!.bytes;
            this.#sessionPages.delete(oldest);
          }
        }
        return page;
      })
      .finally(() => this.#sessionPagesReading.delete(key));
    this.#sessionPagesReading.set(key, read);
    return structuredClone(await read);
  }
  #projectContext(
    source: DesktopWorkspaceSource,
    target: Project['target'],
    sessionId?: string,
  ): Context {
    const catalog = this.#state.catalogs[source];
    const project = catalog?.targets.find((entry) => same(entry.target, target));
    if (!catalog || !project) throw Error('项目不属于当前电脑列表。');
    const current = () => {
      const latest = this.#state.catalogs[source];
      if (
        this.#closed ||
        latest?.connectionId !== catalog.connectionId ||
        latest.owner !== catalog.owner ||
        !same(latest.actor ?? null, catalog.actor ?? null) ||
        !latest.targets.some((entry) => same(entry.target, target))
      )
        throw Error('项目列表已改变，请重新读取。');
    };
    const scope = { source, target: structuredClone(project.target) };
    return {
      scope,
      project: structuredClone(project),
      connectionId: catalog.connectionId,
      current,
      sessionId,
    };
  }
  async readGitContext() {
    const context = this.#context();
    if (!context.sessionId || !context.project.runtime.features?.includes(GIT_WORKTREE_FEATURE))
      return;
    return gitStateResultSchema.parse(
      await this.#execute(
        context,
        this.#command(context.scope, 'git-state', {
          gitVersion: 1,
          workspaceId: context.scope.target.workspaceId,
          localProjectId: context.scope.target.localProjectId,
          sessionId: context.sessionId,
        }),
      ),
    );
  }
  async openSession(sessionId: string, turnId?: string) {
    this.#state.modelLoading = false;
    this.#state.searchFocus = undefined;
    this.#state.focusedTurnId = undefined;
    await this.flushDraft();
    const scope = this.#context(sessionId).scope,
      view = this.#sessionView(scope, sessionId);
    this.#generation++;
    this.#sessionSyncPending = false;
    this.#syncAfterRead = false;
    this.#discardSessionReplica();
    const replica = this.#replica(scope, sessionId);
    this.#state.sessionId = sessionId;
    delete this.#state.usageLoading;
    delete this.#state.modelError;
    delete this.#state.sendProgress;
    const current = this.#current();
    let cancelLoading = () => {};
    if (view) {
      this.#state.session = view.session;
      this.#state.draft = view.draft;
      this.#state.sessionLoad = { status: 'refreshing', source: 'cache' };
      this.#emit();
    } else {
      delete this.#state.session;
      delete this.#state.draft;
      // Publish the new scope immediately so the previous composer can no
      // longer accept input. Only the visual loading indicator is delayed.
      this.#state.sessionLoad = { status: 'loading-cache', showIndicator: false };
      this.#emit();
      cancelLoading = this.#schedule(SESSION_LOADING_DELAY_MS, () => {
        try {
          current();
          if (this.#state.sessionLoad.status !== 'loading-cache') return;
          this.#state.sessionLoad = { status: 'loading-cache', showIndicator: true };
          this.#emit();
        } catch {
          // A newer navigation owns the visible session.
        }
      });
    }
    let cached: Session | null;
    try {
      await this.options.restoreLegacy?.(scope, sessionId, current);
      const [ledger, storedSession] = await Promise.all([
        this.store.read(scope, current, sessionId),
        this.store.loadSessionCache(scope, sessionId, current),
      ]);
      current();
      this.#state.ledger = ledger;
      this.#state.draft = await this.store.readDraft(scope, sessionId, current, ledger);
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
      this.#discardSessionReplica(replica);
      this.#state.sessionLoad = {
        status: 'failed',
        source: view ? 'cache' : 'none',
        reason: 'local',
      };
      this.#emit();
      throw error;
    }
    cancelLoading();
    current();
    if (!view && cached) this.#state.session = cached;
    if (this.#state.session) this.#rememberSessionView(scope, sessionId);
    this.#state.sessionLoad = this.#state.session
      ? { status: 'refreshing', source: 'cache' }
      : { status: 'loading-cache' };
    this.#emit();
    await this.refreshSession({ announce: false, settle: false });
    let optionsRefreshed = false;
    try {
      await this.refreshAgentOptions();
      optionsRefreshed = true;
      if (!this.#state.session?.accountUsage?.observedAt) await this.readUsage().catch(() => {});
    } finally {
      current();
      this.#state.sessionLoad = { status: 'ready', source: 'host' };
      if (!optionsRefreshed) this.#rememberSessionView(scope, sessionId);
      this.#emit();
      if (this.#syncAfterRead) {
        this.#syncAfterRead = false;
        this.#sessionSyncPending = true;
        void this.#drainSessionSync();
      }
    }
    current();
    if (turnId && this.#state.session?.history.some((turn) => turn.id === turnId)) {
      this.#state.focusedTurnId = turnId;
      this.#emit();
    }
  }
  refreshSession({
    announce = true,
    settle = true,
    background = false,
  }: { announce?: boolean; settle?: boolean; background?: boolean } = {}): Promise<void> {
    if (background && ['loading-cache', 'refreshing'].includes(this.#state.sessionLoad.status)) {
      this.#syncAfterRead = true;
      return Promise.resolve();
    }
    const previous = this.#sessionFlight;
    if (previous?.generation === this.#generation) {
      previous.again = true;
      return previous.promise;
    }
    const flight = { generation: this.#generation, again: false, promise: Promise.resolve() };
    this.#sessionFlight = flight;
    flight.promise = Promise.resolve().then(async () => {
      try {
        do {
          flight.again = false;
          if (flight.generation !== this.#generation || this.#closed) return;
          await this.#readSessionOnce({ announce, settle });
          announce = false;
        } while (flight.again);
      } finally {
        // Clear the flight before its promise resolves: a request arriving in a
        // following microtask must start a read, not join an already-drained one.
        if (this.#sessionFlight === flight) this.#sessionFlight = undefined;
      }
    });
    return flight.promise;
  }
  async #readSessionOnce({ announce, settle }: { announce: boolean; settle: boolean }) {
    const context = this.#context(),
      generation = this.#generation;
    const version = ++this.#sessionReadVersion,
      selected = context.current;
    context.current = () => {
      selected();
      if (version !== this.#sessionReadVersion) throw Error('会话读取已由较新的请求替代。');
    };
    if (!context.sessionId) throw Error('请先选择会话。');
    const replica = this.#replica(context.scope, context.sessionId),
      base = replica.view;
    const source =
      this.#state.sessionLoad.status === 'ready'
        ? 'host'
        : 'source' in this.#state.sessionLoad
          ? this.#state.sessionLoad.source
          : this.#state.session
            ? 'cache'
            : 'none';
    if (announce) {
      this.#state.sessionLoad = { status: 'refreshing', source };
      this.#emit();
    }
    try {
      const raw = await this.#execute(
        context,
        this.#command(context.scope, 'session', {
          sessionId: context.sessionId,
          ...(base?.version ? { version: base.version } : {}),
        }),
      );
      const markPerformance = beginSessionPerformanceRead();
      let session: Session;
      try {
        session = replica.read(raw);
      } catch (error) {
        this.#discardSessionReplica(replica);
        throw error;
      }
      this.#queueSessionCache(replica, replica.lastRead!);
      context.current();
      this.#state.session = session;
      if (base?.version && session.version && base.version !== session.version)
        markPerformance?.(this, context.sessionId, session.version);
      this.#state.offline = false;
      this.#state.sessionLoad = settle
        ? { status: 'ready', source: 'host' }
        : { status: 'refreshing', source: 'host' };
      if (settle) this.#rememberSessionView(context.scope, context.sessionId);
    } catch (error) {
      context.current();
      this.#state.offline = true;
      this.#state.sessionLoad = { status: 'failed', source, reason: 'connection' };
      throw error;
    } finally {
      // Single-flight already serializes reads within this selection. Older
      // selections may still be waiting, but must not delay its pending notice.
      if (generation === this.#generation && this.#syncAfterRead) {
        this.#syncAfterRead = false;
        this.#sessionSyncPending = true;
        void this.#drainSessionSync();
      }
      context.current();
      this.#emit();
    }
  }
  async refreshAgentOptions(force = false) {
    await this.flushDraft();
    const context = this.#context(),
      session = this.#state.session;
    const version = ++this.#modelReadVersion,
      selected = context.current;
    context.current = () => {
      selected();
      if (version !== this.#modelReadVersion) throw Error('模型读取已由较新的请求替代。');
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
    if (!force && this.#catalogAttempts.has(attempt)) {
      this.#state.modelError = this.#catalogAttempts.get(attempt);
      await this.#initializeSelection(context);
      return;
    }
    if (this.#catalogAttempts.size >= 500) this.#catalogAttempts.clear();
    this.#catalogAttempts.set(attempt, undefined);
    this.#state.modelLoading = true;
    this.#emit();
    try {
      const agent = agentSchema.parse(
        await this.#execute(
          context,
          this.#command(context.scope, 'agent-options', {
            sessionId: context.sessionId,
            agentId: session.meta.agentConfigId,
            ...(force ? { refresh: true } : {}),
          }),
        ),
      );
      // Preserve a newer timeline read which may have completed while capabilities loaded.
      this.#state.session = { ...this.#state.session!, agent };
      this.#catalogAttempts.set(key(agent), undefined);
      await this.#initializeSelection(context);
      this.#rememberSessionView(context.scope, context.sessionId);
      delete this.#state.modelError;
    } catch (error) {
      context.current();
      this.#state.modelError = publicAgentFailure(
        error,
        '模型选项暂不可读取，请在设置中刷新或检查执行电脑。',
      );
      this.#catalogAttempts.set(attempt, this.#state.modelError);
      throw error;
    } finally {
      context.current();
      this.#state.modelLoading = false;
      this.#emit();
    }
  }
  async #initializeSelection(context: Context) {
    const session = this.#state.session,
      draft = this.#state.draft;
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
    await this.store.saveDraft(
      context.scope,
      context.sessionId,
      draft.revision,
      draft.text,
      selection,
      context.current,
      draft.actor,
    );
    this.#state.draft = await this.store.readDraft(
      context.scope,
      context.sessionId,
      context.current,
    );
  }
  async saveApprovalDefault(modeId: string) {
    const parsed = approvalModeSchema.safeParse(modeId);
    if (!parsed.success) return;
    const context = this.#context(),
      session = this.#state.session;
    if (!session || !context.project.runtime.features?.includes(AGENT_CONTROLS_FEATURE))
      throw Error('执行主机尚不支持保存审批默认值，请升级主机。');
    const selected = parsed.data;
    const params = {
      agentId: session.meta.agentConfigId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    };
    const response = runPreferencesResponseSchema.parse(
      await this.#execute(
        context,
        this.#command(context.scope, 'run-preferences', { ...params, action: 'read' }),
      ),
    );
    const saved = runPreferencesResponseSchema.parse(
      await this.#execute(
        context,
        this.#command(context.scope, 'run-preferences', {
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
    const context = this.#context(),
      session = this.#state.session;
    if (!session || !context.project.runtime.features?.includes(AGENT_RUN_DEFAULTS_FEATURE))
      throw Error('执行主机尚不支持保存模型默认值，请升级主机。');
    const params = {
      agentId: session.meta.agentConfigId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    };
    const response = runDefaultsResponseSchema.parse(
      await this.#execute(
        context,
        this.#command(context.scope, 'run-preferences', { ...params, action: 'read-defaults' }),
      ),
    );
    const saved = runDefaultsResponseSchema.parse(
      await this.#execute(
        context,
        this.#command(context.scope, 'run-preferences', {
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
    const context = this.#context(),
      session = this.#state.session;
    if (
      !session ||
      !context.sessionId ||
      !context.project.runtime.features?.includes(AGENT_CONTROLS_FEATURE)
    )
      return;
    if (this.#state.usageLoading && this.#usageReadGeneration === this.#generation) return;
    this.#usageReadGeneration = this.#generation;
    this.#state.usageLoading = true;
    this.#emit();
    try {
      const result = agentUsageResponseSchema.parse(
        await this.#execute(
          context,
          this.#command(context.scope, 'agent-usage', {
            agentId: session.meta.agentConfigId,
            sessionId: context.sessionId,
            ...(force ? { refresh: true } : {}),
          }),
        ),
      );
      context.current();
      this.#state.session = { ...this.#state.session!, accountUsage: result.usage };
    } finally {
      context.current();
      this.#state.usageLoading = false;
      this.#emit();
    }
  }
  queueDraft(
    text: string,
    selection: RunSelection,
    failed?: (error: unknown) => void,
    saved?: () => void,
  ) {
    const scope = this.#state.scope,
      sessionId = this.#state.sessionId;
    if (!scope || !sessionId || !this.#state.draft) throw Error('请先打开会话。');
    this.#draftInput = this.#draftBuffer = {
      scope: structuredClone(scope),
      sessionId,
      text,
      selection: structuredClone(selection),
      actor: structuredClone(this.#state.catalogs[scope.source]?.actor),
      failed,
      saved,
    };
    this.#cancelDraftSave?.();
    this.#cancelDraftSave = this.#schedule(DRAFT_SAVE_DELAY_MS, () => {
      this.#cancelDraftSave = undefined;
      void this.flushDraft().catch(() => {});
    });
  }
  async flushDraft() {
    this.#cancelDraftSave?.();
    this.#cancelDraftSave = undefined;
    for (;;) {
      const pending = this.#draftBuffer;
      if (!pending) {
        const draftWrites = this.#draftWrites,
          interactionWrites = this.#interactionWrites;
        await draftWrites;
        await interactionWrites;
        if (
          this.#draftBuffer ||
          draftWrites !== this.#draftWrites ||
          interactionWrites !== this.#interactionWrites
        )
          continue;
        return;
      }
      this.#draftBuffer = undefined;
      const current = () => {
        if (
          this.#closed ||
          !same(this.#state.scope, pending.scope) ||
          this.#state.sessionId !== pending.sessionId
        )
          throw Error('当前电脑、项目或会话已改变，请重新读取。');
      };
      const write = this.#draftWrites.then(async () => {
        current();
        const draft = this.#state.draft;
        if (!draft) throw Error('请先打开会话。');
        this.#state.draft = await this.store.saveDraft(
          pending.scope,
          pending.sessionId,
          draft.revision,
          pending.text,
          pending.selection,
          current,
          pending.actor,
        );
        pending.committed = this.#state.draft;
        if (this.#draftInput === pending) this.#draftInput = undefined;
        this.#rememberSessionDraft(pending.scope, pending.sessionId);
        current();
      });
      // A failed recoverable draft write must not poison later explicit retries.
      this.#draftWrites = write.catch(() => {});
      try {
        await write;
      } catch (error) {
        if (!this.#draftBuffer) this.#draftBuffer = pending;
        try {
          pending.failed?.(error);
        } catch {
          // UI notification callbacks never control persistence or retry state.
        }
        throw error;
      }
      try {
        pending.saved?.();
      } catch {
        // UI notification callbacks never control persistence or retry state.
      }
    }
  }
  saveDraft(text: string, selection: RunSelection) {
    this.queueDraft(text, selection);
    return this.flushDraft();
  }
  async openFork(changed: () => void = () => {}) {
    await this.flushDraft();
    const context = this.#context();
    if (!context.sessionId) throw Error('请先打开源会话。');
    const sessionId = context.sessionId,
      target = workspaceFeatureTarget({ ...context.scope.target, sessionId }),
      key = sessionForkKey(target);
    let open = true;
    const current = () => {
      context.current();
      if (!open) throw Error('Fork 面板已关闭。');
    };
    const controller = new SessionForkController(target, {
      uuid: () => this.#uuid(),
      changed,
      current: () => {
        try {
          current();
          return true;
        } catch {
          return false;
        }
      },
      read: async (requested) => {
        if (requested !== key) throw Error('Fork 缓存范围不匹配。');
        return (await this.store.read(context.scope, current, context.sessionId ?? [])).forks?.[
          sessionId
        ];
      },
      compareWrite: async (requested, revision, value, valid) => {
        if (requested !== key) throw Error('Fork 缓存范围不匹配。');
        const check = () => {
          current();
          if (!valid()) throw Error('Fork 面板已改变。');
        };
        await this.store.saveFork(context.scope, sessionId, revision, value as ForkSaved, check);
        await this.#reloadLedger({ ...context, current: check });
        return true;
      },
      request: (path, value) => {
        current();
        if (
          this.#state.offline ||
          !this.#state.project?.runtime.features?.includes(SESSION_FORK_FEATURE)
        )
          throw Error('执行电脑离线或尚不支持原生会话副本。');
        const prefix = `/api/workspaces/${target.catalogWorkspaceId}/replicas/${target.replicaId}/fork/`;
        const method =
          path === prefix + 'options'
            ? 'fork-options'
            : path === prefix + 'action'
              ? 'fork-action'
              : null;
        if (!method) throw Error('Fork 请求不属于当前项目。');
        return this.#execute({ ...context, current }, this.#command(context.scope, method, value));
      },
    });
    await controller.load();
    const perform = async (
      kind: 'refresh' | 'create' | 'retry' | 'inspect' | 'abandon',
      input?: { cutoff: ForkCutoff; directory: ForkDirectory },
      turnId?: string,
    ) => {
      const reviewed = structuredClone(controller.options),
        pending = structuredClone(controller.pending);
      const proposal = input && {
        cutoff: forkCutoffSchema.parse(input.cutoff),
        directory: forkDirectorySchema.parse(input.directory),
      };
      await this.flushDraft();
      current();
      return this.store.exclusiveOperation(
        context.scope,
        'fork:' + sessionId,
        current,
        async () => {
          const ledger = await this.store.read(context.scope, current, context.sessionId ?? []),
            saved = ledger.forks?.[sessionId];
          if (
            ['create', 'retry'].includes(kind) &&
            (ledger.git?.[sessionId]?.pending ||
              ledger.operations.some(
                (item) => item.status === 'pending' && item.original.value.sessionId === sessionId,
              ) ||
              ledger.interactions?.[sessionId]?.value.pending ||
              ledger.mcp?.[sessionId]?.delivery)
          )
            throw Error('请先核查源会话原操作，再创建或重试 Fork。');
          if (
            ['retry', 'inspect', 'abandon'].includes(kind) &&
            (!pending || !same(pending, workspaceForkPending(saved)))
          )
            throw Error('原 Fork 已改变或已有结果，请重新读取。');
          await controller.load();
          if (kind === 'refresh') await controller.refresh(turnId);
          else if (kind === 'create') {
            if (!reviewed || !same(reviewed, controller.options))
              throw Error('Fork 选项已改变，请重新审阅。');
            await controller.create(proposal!.cutoff, proposal!.directory);
          } else if (kind === 'retry') await controller.retry();
          else {
            if (
              this.#state.offline ||
              !this.#state.project?.runtime.features?.includes(FORK_OPERATIONS_FEATURE)
            )
              throw Error('此执行电脑尚不支持核查原 Fork。');
            const query = { action: kind, request: pending!.request };
            const result = await validateForkOperationResult(
              await this.#execute(
                { ...context, current },
                this.#command(context.scope, 'fork-operations', query),
              ),
              query,
            );
            current();
            if (!result.found) throw Error('主机尚未记录原 Fork，请明确重试或封存。');
            await this.store.saveFork(
              context.scope,
              sessionId,
              saved!.cacheRevision,
              { ...saved!, cacheRevision: saved!.cacheRevision + 1, receipt: result.receipt },
              current,
            );
            await this.#reloadLedger({ ...context, current });
            await controller.load();
            if (result.receipt.phase === 'unknown') throw Error('Fork 结果仍未知，原记录已保留。');
          }
          await this.refreshSessions();
        },
      );
    };
    return {
      controller,
      close: () => {
        open = false;
      },
      refresh: (turnId?: string) => perform('refresh', undefined, turnId),
      create: (cutoff: ForkCutoff, directory: ForkDirectory) =>
        perform('create', { cutoff, directory }),
      retry: () => perform('retry'),
      inspect: () => perform('inspect'),
      abandon: () => perform('abandon'),
      confirmCleanup: (childSessionId: string) =>
        this.store.exclusiveOperation(context.scope, 'fork:' + sessionId, current, async () => {
          await controller.load();
          const receipt =
            controller.receipt?.childSessionId === childSessionId
              ? controller.receipt
              : controller.resources.find((item) => item.receipt.childSessionId === childSessionId)
                  ?.receipt;
          if (!receipt || receipt.execution?.mode !== 'worktree')
            throw Error('清理目录不属于此 Fork。');
          const read = await this.#execute(
            { ...context, sessionId: childSessionId, current },
            this.#command(context.scope, 'git-state', {
              gitVersion: 1,
              workspaceId: target.workspaceId,
              localProjectId: target.localProjectId,
              sessionId: childSessionId,
            }),
          );
          await controller.confirmResourceCleanup(
            childSessionId,
            read as import('@moor/protocol/git-protocol').GitStateResult,
          );
        }),
    };
  }
  async openAttention(changed: () => void = () => {}) {
    await this.flushDraft();
    const base = this.#context(),
      catalog = structuredClone(this.#state.catalogs[base.scope.source]!);
    if (!catalog.actor) throw Error('原连接尚未提供可核对的待办账号，请重新连接或更新主机。');
    const actor = catalog.actor;
    let open = true;
    const current = () => {
      base.current();
      if (!open || !same(this.#state.catalogs[base.scope.source]?.actor, actor))
        throw Error('待办账号、面板或执行目标已改变。');
    };
    const projects = catalog.targets.filter(
      (entry) => entry.target.catalogWorkspaceId === base.scope.target.catalogWorkspaceId,
    );
    const routes = projects.map((project) => ({
      origin: catalog.origin,
      actor,
      catalogWorkspaceId: project.target.catalogWorkspaceId,
      projectId: project.target.catalogProjectId,
      replicaId: project.target.replicaId,
      executionDeviceId: project.target.deviceId,
      machineId: project.target.machineId,
      runtimeWorkspaceId: project.target.workspaceId,
      localProjectId: project.target.localProjectId,
    }));
    const scoped = (route: AttentionRoute, sessionId?: string) => {
      current();
      route = attentionRouteSchema.parse(
        Object.fromEntries(
          Object.keys(attentionRouteSchema.shape).map((key) => [
            key,
            route[key as keyof AttentionRoute],
          ]),
        ),
      );
      const index = routes.findIndex((item) => same(item, route));
      if (index < 0) throw Error('待办不属于原账号的已确认项目。');
      const project = projects[index]!;
      return {
        ...base,
        project,
        scope: { source: base.scope.source, target: project.target },
        sessionId,
        current,
      };
    };
    const routeForKey = (key: string) => {
      current();
      for (const route of routes) {
        try {
          workspaceAttentionKey(route, key);
          return route;
        } catch {}
      }
      throw Error('待办存储键不属于原项目。');
    };
    const read = async <T>(key: string): Promise<T | undefined> => {
      const route = routeForKey(key),
        context = scoped(route);
      const ledger = await this.store.read(context.scope, current, context.sessionId ?? []);
      return structuredClone(ledger.attention?.[attentionScopeKey(route)]?.entries[key]) as
        | T
        | undefined;
    };
    const save = async (key: string, value: unknown, compare?: { expected: unknown }) => {
      const route = routeForKey(key),
        context = scoped(route);
      const saved = await this.store.saveAttention(
        context.scope,
        route,
        key,
        value,
        current,
        compare,
      );
      if (same(context.scope, this.#state.scope)) await this.#reloadLedger(context);
      return saved;
    };
    const request = async (path: string, body?: unknown) => {
      current();
      const route = routes.find((item) =>
        path.startsWith(
          `/api/workspaces/${encodeURIComponent(item.catalogWorkspaceId)}/replicas/${encodeURIComponent(item.replicaId)}/`,
        ),
      );
      if (!route) throw Error('不支持的待办请求。');
      const parsed = workspaceAttentionRequest(route, path, body),
        context = scoped(route, parsed.sessionId);
      if (this.#state.offline || this.#state.errors[base.scope.source])
        throw Error('执行电脑离线，原待办记录保留。');
      const target = {
        ...context.scope.target,
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      };
      const value = await this.#request(
        {
          action: 'attention',
          source: context.scope.source,
          connectionId: context.connectionId,
          target,
          actor,
          command: parsed.command,
        },
        current,
      );
      current();
      return validateWorkspaceAttentionResponse(value, target, parsed.command);
    };
    const dependencies: AttentionDependencies = {
      read,
      write: async (key, value) => {
        await save(key, value);
      },
      compareAndSet: (key, expected, value) => save(key, value, { expected }),
      request,
      now: () => Date.parse((this.options.now ?? (() => new Date().toISOString()))()),
      uuid: () => this.#uuid(),
      changed,
      deliver: async (original, retry, authorized, onPending) => {
        const context = scoped(original.route, original.sessionId);
        const check = () => {
          current();
          if (!authorized()) throw Error('待办原事项已改变。');
        };
        await this.flushDraft();
        check();
        return this.store.exclusiveOperation(
          context.scope,
          'attention:' + original.sessionId,
          check,
          async () => {
            const key = attentionPendingKey(original),
              previous = await read(key);
            check();
            if (retry && (!previous || !same(previous, original)))
              throw Error('原待办操作已改变或已有结果，请重新读取。');
            return deliverAttention(original, {
              read,
              compareAndSet: dependencies.compareAndSet,
              request,
              onPending,
              isAuthorized: () => {
                try {
                  check();
                  return true;
                } catch {
                  return false;
                }
              },
            });
          },
        );
      },
      readSessionDraft: async (route, sessionId) => {
        await this.flushDraft();
        const context = scoped(route, sessionId),
          ledger = await this.store.read(context.scope, current, context.sessionId ?? []),
          draft = await this.store.readDraft(context.scope, sessionId, current, ledger);
        return draft?.actor && actorKey(draft.actor) === actorKey(actor)
          ? draft.text
          : { text: '', unscoped: !!draft?.text };
      },
      prepareTurn: async (route, sessionId, text) => {
        await this.flushDraft();
        const context = scoped(route, sessionId);
        const ledger = await this.store.read(context.scope, current, context.sessionId ?? []),
          draft = await this.store.readDraft(context.scope, sessionId, current, ledger);
        if (
          this.store.attentionBlocked(ledger, sessionId) ||
          this.store.githubBlocked(ledger, sessionId) ||
          this.store.forkBlocked(ledger, sessionId) ||
          ledger.git?.[sessionId]?.pending ||
          ledger.interactions?.[sessionId]?.value.pending ||
          ledger.tasks?.[sessionId]?.pending ||
          ledger.mcp?.[sessionId]?.delivery ||
          ledger.operations.some(
            (entry) => entry.status === 'pending' && entry.original.value.sessionId === sessionId,
          )
        )
          throw Error('请先核查原会话操作，再发送后续指令。');
        const raw = await this.#execute(
          context,
          this.#command(context.scope, 'session', { sessionId }),
        );
        const read = readClientSession(raw, { ...context.scope.target, sessionId });
        const agent = agentSchema.parse(
          await this.#execute(
            context,
            this.#command(context.scope, 'agent-options', {
              sessionId,
              agentId: read.meta.agentConfigId,
              ...(context.project.runtime.features?.includes(AGENT_MODEL_OPTIONS_FEATURE) &&
              draft?.selection.modelId
                ? { modelId: draft.selection.modelId }
                : {}),
            }),
          ),
        );
        const latestLedger = await this.store.read(context.scope, current, context.sessionId ?? []),
          latest = await this.store.readDraft(context.scope, sessionId, current, latestLedger);
        if (!same(latest.selection, draft.selection))
          throw Error('运行选项已改变，请重新查看后续要求。');
        if (!context.project.runtime.features?.includes(SESSION_INTENTS_FEATURE))
          throw Error('请先升级执行电脑，再发送新的待办后续指令。');
        return buildSendTurn({
          scope: { ...context.scope.target, sessionId },
          read,
          agent,
          prompt: text,
          selection: draft.selection,
          operationId: this.#uuid(),
          turnId: this.#uuid(),
        });
      },
      continued: async (route, sessionId) => {
        const context = scoped(route, sessionId);
        if (same(context.scope, this.#state.scope) && this.#state.sessionId === sessionId)
          await this.refreshSession();
        current();
        await this.refreshSessions();
      },
    };
    const controller = new AttentionController(dependencies);
    controller.configure({
      origin: catalog.origin,
      actor,
      workspaceId: base.scope.target.catalogWorkspaceId,
      workspaceName: base.project.workspaceName,
      connected: !this.#state.offline,
      targets: routes.map((route, index) => ({
        ...route,
        hostName: projects[index]!.hostName,
        projectName: projects[index]!.projectName,
        online: projects[index]!.online,
        features: projects[index]!.runtime.features ?? [],
      })),
    });
    await controller.refresh();
    current();
    return {
      controller,
      close: () => {
        open = false;
        controller.configure(undefined);
      },
      openSession: async (route: AttentionRoute, sessionId: string, turnId?: string) => {
        const context = scoped(route, sessionId);
        await this.flushDraft();
        current();
        if (!same(context.scope, this.#state.scope))
          await this.selectProject(context.scope.source, context.scope.target);
        await this.openSession(sessionId, turnId);
      },
    };
  }
  async metadata(
    action: SessionAction['action'],
    title?: string,
    reviewed = this.#state.session?.meta,
  ) {
    const shown = structuredClone(reviewed);
    await this.flushDraft();
    const context = this.#context();
    if (!shown || shown.id !== context.sessionId) throw Error('请先读取原会话。');
    if (this.#state.offline) throw Error('执行电脑离线，请连接后手动整理会话。');
    await this.refreshSession();
    context.current();
    const read = this.#state.session!;
    if (
      !read.persisted ||
      read.persistenceError ||
      (read.meta.metadataRevision ?? 0) !== (shown.metadataRevision ?? 0)
    )
      throw Error('会话信息已改变，请重新查看后操作。');
    const request = sessionActionSchema.parse({
      action,
      operationId: this.#uuid(),
      workspaceId: context.scope.target.workspaceId,
      localProjectId: context.scope.target.localProjectId,
      sessionId: shown.id,
      expectedRevision: shown.metadataRevision ?? 0,
      ...(action === 'rename' ? { title } : {}),
    });
    await this.store.stage(
      context.scope,
      { kind: 'metadata', value: request },
      undefined,
      context.current,
    );
    await this.#reloadLedger(context);
    await this.retry(request.operationId);
    await this.refreshSession();
    await this.refreshSessions();
  }
  async projectMetadata(
    source: DesktopWorkspaceSource,
    target: Project['target'],
    reviewed: SessionMetadata,
    action: SessionAction['action'],
    title?: string,
  ) {
    const shown = structuredClone(reviewed);
    const context = this.#projectContext(source, target, shown.id);
    if (
      shown.userId !== target.userId ||
      shown.machineId !== target.machineId ||
      shown.project.localProjectId !== target.localProjectId
    )
      throw Error('会话信息与原执行范围不匹配。');
    if (!context.project.online) throw Error('执行电脑离线，请连接后手动整理会话。');
    const read = readClientSession(
      await this.#execute(
        context,
        this.#command(context.scope, 'session', { sessionId: shown.id }),
      ),
      { ...target, sessionId: shown.id },
    );
    if (
      !read.persisted ||
      read.persistenceError ||
      (read.meta.metadataRevision ?? 0) !== (shown.metadataRevision ?? 0)
    )
      throw Error('会话信息已改变，请重新查看后操作。');
    const request = sessionActionSchema.parse({
      action,
      operationId: this.#uuid(),
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      sessionId: shown.id,
      expectedRevision: shown.metadataRevision ?? 0,
      ...(action === 'rename' ? { title } : {}),
    });
    await this.store.stage(
      context.scope,
      { kind: 'metadata', value: request },
      undefined,
      context.current,
    );
    try {
      await this.#deliverOperation(context, request.operationId);
    } finally {
      context.current();
      this.#invalidateProject(source, target);
      // Only the journal changes here: a sidebar action cannot overwrite an in-memory draft.
      if (same(context.scope, this.#state.scope)) {
        const ledger = await this.store.read(
          context.scope,
          context.current,
          this.#state.sessionId ?? [],
        );
        if (same(context.scope, this.#state.scope)) this.#state.ledger = ledger;
      }
      this.#emit();
      this.scheduleSync({
        source,
        owner: target.owner,
        connectionId: context.connectionId,
        kind: 'changed',
        deviceId: target.deviceId,
        workspaceId: target.workspaceId,
        sessionId: shown.id,
      });
    }
    if (same(context.scope, this.#state.scope)) {
      await this.refreshSessions();
      if (this.#state.sessionId === shown.id)
        await this.refreshSession({ announce: false, background: true });
    }
  }
  #contentCache(scope: WorkspaceScope) {
    const cache = workspaceContentCache(scope.source, this.store.backend);
    return {
      read: async (target: Parameters<typeof cache.read>[0], key: string, current: () => void) => {
        current();
        if (!same({ ...scope.target, sessionId: target.sessionId }, target))
          throw Error('文件缓存目标已改变。');
        return cache.read(target, key, current);
      },
      writeBatch: cache.writeBatch.bind(cache),
    };
  }
  openSearch() {
    const context = this.#context();
    if (!context.sessionId) throw Error('请先打开会话。');
    const target = context.scope.target;
    const contentTarget = (sessionId: string) => ({
      owner: target.owner,
      deviceId: target.deviceId,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      catalogWorkspaceId: target.catalogWorkspaceId,
      replicaId: target.replicaId,
      sessionId,
    });
    const sessions = this.#state.sessions.map((item) => ({
      id: item.id,
      title: item.title ?? '未命名会话',
    }));
    const online = !this.#state.offline;
    const files = this.#contentCache(context.scope);
    let open = true,
      version = 0,
      result: SessionSearchView | undefined;
    const current = () => {
      context.current();
      if (!open || online === this.#state.offline)
        throw Error('搜索面板或连接已改变，请重新打开。');
    };
    return {
      close: () => {
        open = false;
        version++;
        result = undefined;
      },
      search: async (query: string, scope: 'session' | 'project') => {
        current();
        const serial = ++version;
        result = undefined;
        if (online && !this.#state.project?.runtime.features?.includes(SESSION_SEARCH_FEATURE))
          throw Error('此执行电脑尚未提供正文搜索能力。');
        const value = await searchSessionContent(
          contentTarget(context.sessionId!),
          { query, scope },
          online,
          sessions,
          {
            read: async (key) => {
              current();
              if (!key.startsWith('project-content-v1/')) throw Error('不支持的搜索缓存键。');
              const parts = JSON.parse(key.slice('project-content-v1/'.length)) as unknown;
              if (
                !Array.isArray(parts) ||
                typeof parts[4] !== 'string' ||
                !sessions.some((session) => session.id === parts[4]) ||
                !key.startsWith(projectContentKey(contentTarget(parts[4])).slice(0, -1) + ',')
              )
                throw Error('搜索文件缓存不属于当前项目。');
              return files.read({ ...target, sessionId: parts[4] }, key, current);
            },
            write: async () => {
              throw Error('正文搜索不修改文件缓存。');
            },
            readHistory: async (requested) => {
              current();
              if (!same(requested, contentTarget(requested.sessionId)))
                throw Error('搜索缓存范围不匹配。');
              const read = await this.store.cachedSession(
                context.scope,
                requested.sessionId,
                current,
              );
              return read?.history;
            },
            request: (path, params) => {
              current();
              if (
                path !==
                `/api/workspaces/${target.catalogWorkspaceId}/replicas/${target.replicaId}/session-search`
              )
                throw Error('不支持的搜索请求。');
              return this.#execute(
                { ...context, current },
                this.#command(context.scope, 'search-sessions', params),
              );
            },
          },
        );
        current();
        if (serial !== version) throw Error('搜索结果已被新的查询替代。');
        result = structuredClone(value);
        return value;
      },
      openHit: async (hit: SearchHit) => {
        current();
        if (!result?.hits.some((item) => same(item, hit))) throw Error('此结果不属于当前搜索。');
        await this.flushDraft();
        current();
        try {
          await this.openSession(hit.sessionId);
        } catch (error) {
          if (
            online ||
            !same(this.#state.scope, context.scope) ||
            this.#state.session?.meta.id !== hit.sessionId ||
            !this.#state.offline
          )
            throw error;
        }
        const selected = this.#context();
        selected.current();
        if (
          !same(selected.scope, context.scope) ||
          selected.sessionId !== hit.sessionId ||
          !this.#state.session?.history.some((turn) => turn.id === hit.turnId)
        )
          throw Error('原搜索位置已改变或尚未缓存，请重新搜索。');
        this.#state.searchFocus = structuredClone(hit);
        this.#emit();
      },
    };
  }
  async openProjectContent(
    changed: () => void = () => {},
    mode: 'tree' | 'changes' = 'tree',
    turnId?: string,
  ) {
    await this.flushDraft();
    const context = this.#context();
    if (!context.sessionId || !this.#state.session) throw Error('请先打开会话。');
    const sessionId = context.sessionId;
    const identity = { ...context.scope.target, sessionId };
    type Target = typeof identity;
    const parseTarget = (input: unknown): Target => {
      const target = desktopWorkspaceTargetSchema.parse(input);
      if (!target.sessionId) throw Error('文件缓存必须绑定原会话。');
      return { ...target, sessionId: target.sessionId };
    };
    const panel = new ProjectContentController<Target>({
      context: () => {
        try {
          context.current();
          return {
            target: identity,
            generation: this.contextRevision,
            online: !this.#state.offline,
          };
        } catch {
          return { target: null, generation: this.contextRevision, online: false };
        }
      },
      parseTarget: (input) => {
        const target = parseTarget(input);
        if (!same(target, identity)) throw Error('文件读取目标已改变。');
        return target;
      },
      contentTarget: ({
        owner,
        deviceId,
        catalogWorkspaceId,
        replicaId,
        workspaceId,
        localProjectId,
        sessionId,
      }) => ({
        owner,
        deviceId,
        catalogWorkspaceId,
        replicaId,
        workspaceId,
        localProjectId,
        sessionId,
      }),
      cache: this.#contentCache(context.scope),
      request: async (target, method, params) => {
        context.current();
        if (!same(target, identity)) throw Error('文件读取目标已改变。');
        const feature =
          method === 'read-project-tree' || method === 'file-content'
            ? PROJECT_TREE_FEATURE
            : PROJECT_DIFF_FEATURE;
        if (!context.project.runtime.features?.includes(feature))
          throw Error('执行电脑尚未提供此文件读取能力。');
        return this.#execute(context, this.#command(context.scope, method, params));
      },
    });
    const unsubscribe = panel.subscribe(changed);
    const turns = this.#state.session.history
      .filter((turn) => turn.role === 'assistant')
      .map((turn) => {
        const reference = projectDiffReferenceSchema.safeParse(turn.fileDiff);
        return {
          id: turn.id,
          label: turn.id,
          ...(reference.success ? { reference: reference.data } : {}),
        };
      })
      .reverse();
    try {
      await panel.open(mode, turns, context.project.projectName + ' · 项目文件', turnId);
      context.current();
    } catch (error) {
      unsubscribe();
      panel.close();
      throw error;
    }
    return Object.assign(panel, {
      dispose: () => {
        unsubscribe();
        panel.close();
      },
    });
  }
  async openGithub(changed: () => void = () => {}, mode: GithubSessionMode = 'read') {
    await this.flushDraft();
    const context = this.#context();
    if (!context.sessionId) throw Error('请先打开会话。');
    const sessionId = context.sessionId;
    const identity = { ...context.scope.target, sessionId };
    type Target = typeof identity;
    const checkTarget = (target: Target, check: () => void) => {
      context.current();
      check();
      if (!same(identity, target)) throw Error('GitHub 原执行范围已改变。');
    };
    const kindFor = (target: Target, key: string) => {
      const projected = workspaceFeatureTarget(target);
      if (key === githubKey(projected)) return 'github' as const;
      if (key === githubWriteKey(projected)) return 'githubWrite' as const;
      throw Error('GitHub 缓存键不属于原会话。');
    };
    const panel = new GithubSessionController<Target>({
      context: () => {
        try {
          context.current();
          return {
            target: identity,
            generation: this.contextRevision,
            online: !this.#state.offline,
          };
        } catch {
          return { target: null, generation: this.contextRevision, online: false };
        }
      },
      parseTarget: (input) => {
        const target = desktopWorkspaceTargetSchema.parse(input);
        if (!target.sessionId || !same(target, identity))
          throw Error('GitHub 目标不属于当前会话。');
        return { ...target, sessionId: target.sessionId };
      },
      gitTarget: workspaceFeatureTarget,
      uuid: () => this.#uuid(),
      storage: {
        forTarget: (target, check) => ({
          read: async (key) => {
            checkTarget(target, check);
            return (await this.store.read(context.scope, check, sessionId))[kindFor(target, key)]?.[
              sessionId
            ];
          },
          compareWrite: async (key, revision, value, valid) => {
            const current = () => {
              checkTarget(target, check);
              if (!valid()) throw Error('GitHub 面板已改变。');
            };
            current();
            await this.store.saveGithub(
              context.scope,
              sessionId,
              kindFor(target, key),
              revision,
              value,
              current,
            );
            return true;
          },
        }),
        list: async (target, current) => {
          checkTarget(target, current);
          const ledger = await this.store.read(context.scope, current, context.sessionId ?? []);
          const projected = workspaceFeatureTarget(target);
          return [
            ...(ledger.github?.[sessionId]
              ? [{ target, key: githubKey(projected), value: ledger.github[sessionId] }]
              : []),
            ...(ledger.githubWrite?.[sessionId]
              ? [{ target, key: githubWriteKey(projected), value: ledger.githubWrite[sessionId] }]
              : []),
          ];
        },
        exclusive: (target, _namespace, current, work) => {
          checkTarget(target, current);
          return this.store.exclusiveOperation(context.scope, 'github:' + sessionId, current, work);
        },
      },
      request: (target, method, params, current) => {
        checkTarget(target, current);
        const feature = method.startsWith('github-write-') ? GITHUB_WRITE_FEATURE : GITHUB_FEATURE;
        if (this.#state.offline || !this.#state.project?.runtime.features?.includes(feature))
          throw Error('执行电脑离线或尚未提供此 GitHub 能力。');
        return this.#execute({ ...context, current }, this.#command(context.scope, method, params));
      },
      beforeWrite: async (target, current) => {
        await this.flushDraft();
        checkTarget(target, current);
        const ledger = await this.store.read(context.scope, current, context.sessionId ?? []);
        if (
          this.store.githubBlocked(ledger, sessionId) ||
          this.store.attentionBlocked(ledger, sessionId) ||
          this.store.forkBlocked(ledger, sessionId) ||
          ledger.git?.[sessionId]?.pending ||
          ledger.interactions?.[sessionId]?.value.pending ||
          ledger.operations.some(
            (entry) => entry.status === 'pending' && entry.original.value.sessionId === sessionId,
          )
        )
          throw Error('请先核查此会话原操作，再确认新的 GitHub 操作。');
      },
      appendInstruction: async (target, text, current) => {
        await this.flushDraft();
        checkTarget(target, current);
        if (
          !this.#state.session?.persisted ||
          this.#state.session.persistenceError ||
          this.#state.session.meta.isArchived
        )
          throw Error('请先读取可编辑的原会话。');
        const draft = structuredClone(this.#state.draft!);
        await this.store.saveDraft(
          context.scope,
          sessionId,
          draft.revision,
          [draft.text, text].filter(Boolean).join('\n\n'),
          draft.selection,
          current,
          this.#state.catalogs[context.scope.source]?.actor,
        );
        await this.#reloadLedger({ ...context, current });
      },
      changed: async (target, current) => {
        checkTarget(target, current);
        await this.#reloadLedger({ ...context, current });
      },
    });
    panel.subscribe(changed);
    try {
      await panel.open(identity, mode);
    } catch (error) {
      if (!panel.state) {
        panel.dispose();
        throw error;
      }
    }
    return panel;
  }
  async openGit(changed: () => void = () => {}, resourceSessionId?: string) {
    await this.flushDraft();
    const context = this.#context(resourceSessionId ?? this.#state.sessionId);
    if (!context.sessionId) throw Error('请先打开会话。');
    if (resourceSessionId && resourceSessionId !== this.#state.sessionId) {
      const ledger = await this.store.read(context.scope, context.current, context.sessionId ?? []);
      const receipts = Object.values(ledger.forks ?? {}).flatMap((record) => [
        record.receipt,
        ...record.resources.map((item) => item.receipt),
      ]);
      if (
        !receipts.some(
          (receipt) =>
            receipt?.childSessionId === resourceSessionId &&
            receipt.execution?.mode === 'worktree' &&
            receipt.phase !== 'unknown',
        )
      )
        throw Error('未找到属于当前项目的已确认 Fork 目录。');
    }
    const sessionId = context.sessionId,
      target = workspaceFeatureTarget({ ...context.scope.target, sessionId }),
      key = gitWorkspaceKey(target);
    let open = true;
    const current = () => {
      context.current();
      if (!open) throw Error('Git 面板已关闭。');
    };
    const controller = new GitWorkspaceController(target, {
      uuid: () => this.#uuid(),
      changed,
      current: () => {
        try {
          current();
          return true;
        } catch {
          return false;
        }
      },
      read: async (requested) => {
        if (requested !== key) throw Error('Git 缓存范围不匹配。');
        return (await this.store.read(context.scope, current, context.sessionId ?? [])).git?.[
          sessionId
        ];
      },
      compareWrite: async (requested, revision, value, valid) => {
        if (requested !== key) throw Error('Git 缓存范围不匹配。');
        const check = () => {
          current();
          if (!valid()) throw Error('Git 面板已改变。');
        };
        await this.store.saveGit(context.scope, sessionId, revision, value as GitSaved, check);
        await this.#reloadLedger({ ...context, current: check });
        return true;
      },
      request: (path, value) => {
        current();
        if (
          this.#state.offline ||
          !this.#state.project?.runtime.features?.includes(GIT_WORKTREE_FEATURE)
        )
          throw Error('执行电脑离线或尚不支持 Git 工作目录操作。');
        const prefix = `/api/workspaces/${target.catalogWorkspaceId}/replicas/${target.replicaId}/git`;
        const method =
          path === prefix + '/state'
            ? 'git-state'
            : path === prefix + '/action'
              ? 'git-action'
              : null;
        if (!method) throw Error('Git 请求不属于当前项目。');
        return this.#execute({ ...context, current }, this.#command(context.scope, method, value));
      },
    });
    await controller.load();
    const perform = async (
      kind: 'refresh' | 'retry' | 'inspect' | 'abandon' | 'prepare' | 'remove' | 'detach',
      args: string[] = [],
    ) => {
      const reviewed = structuredClone(controller.state),
        pending = structuredClone(controller.pending);
      await this.flushDraft();
      current();
      const recovery = ['retry', 'inspect', 'abandon'].includes(kind);
      return this.store.exclusiveOperation(context.scope, 'git:' + sessionId, current, async () => {
        const ledger = await this.store.read(context.scope, current, context.sessionId ?? []);
        if (
          kind !== 'refresh' &&
          (!recovery || kind === 'retry') &&
          (ledger.operations.some(
            (item) => item.status === 'pending' && item.original.value.sessionId === sessionId,
          ) ||
            ledger.interactions?.[sessionId]?.value.pending ||
            this.store.forkBlocked(ledger, sessionId) ||
            this.store.githubBlocked(ledger, sessionId) ||
            this.store.attentionBlocked(ledger, sessionId) ||
            ledger.mcp?.[sessionId]?.delivery)
        )
          throw Error('请先核查此会话原操作，再改变工作目录。');
        if (recovery && (!pending || !same(pending, ledger.git?.[sessionId]?.pending)))
          throw Error('原 Git 操作已改变或已有结果，请重新读取。');
        await controller.load();
        if (kind === 'refresh') await controller.refresh();
        else if (kind === 'retry') await controller.retry();
        else if (kind === 'inspect' || kind === 'abandon') {
          if (
            this.#state.offline ||
            !this.#state.project?.runtime.features?.includes(GIT_OPERATIONS_FEATURE)
          )
            throw Error('此执行电脑尚不支持核查 Git 原操作。');
          const query = { action: kind, request: pending!.request };
          const result = await validateGitOperationResult(
            await this.#execute(
              { ...context, current },
              this.#command(context.scope, 'git-operations', query),
            ),
            query,
          );
          current();
          if (!result.found)
            throw Error('主机尚未记录此原操作；本机原请求保留，请明确重试或封存。');
          const saved = ledger.git![sessionId]!;
          await this.store.saveGit(
            context.scope,
            sessionId,
            saved.cacheRevision,
            {
              ...saved,
              cacheRevision: saved.cacheRevision + 1,
              receipt: result.receipt,
              pending: result.receipt.phase === 'unknown' ? saved.pending : undefined,
            },
            current,
          );
          await this.#reloadLedger({ ...context, current });
          await controller.load();
          if (result.receipt.phase === 'unknown')
            throw Error('Git 原操作结果仍未知，原请求已保留。');
        } else if (kind === 'prepare') await controller.prepare(args[0]!, args[1]!, args[2]!);
        else {
          if (!reviewed) throw Error('请先读取并审阅工作目录。');
          await controller[kind](reviewed);
        }
        await this.refreshSession();
      });
    };
    return {
      controller,
      close: () => {
        open = false;
      },
      refresh: () => perform('refresh'),
      retry: () => perform('retry'),
      inspect: () => perform('inspect'),
      abandon: () => perform('abandon'),
      prepare: (branch: string, oid: string, name: string) =>
        perform('prepare', [branch, oid, name]),
      remove: () => perform('remove'),
      detach: () => perform('detach'),
    };
  }
  openSkills(changed: () => void = () => {}) {
    const context = this.#context();
    if (!context.sessionId) throw Error('请先打开会话。');
    let open = true;
    const current = () => {
      context.current();
      if (!open) throw Error('Skills 面板已关闭，请重新打开。');
      if (this.#state.offline) throw Error('执行电脑离线，请连接后手动重新读取 Skills。');
    };
    const {
      owner,
      deviceId,
      userId,
      machineId,
      workspaceId,
      localProjectId,
      catalogWorkspaceId,
      replicaId,
    } = context.scope.target;
    const skills = new SkillsController(
      {
        owner,
        deviceId,
        userId,
        machineId,
        workspaceId,
        localProjectId,
        catalogWorkspaceId,
        replicaId,
        sessionId: context.sessionId,
      },
      {
        current: () => {
          try {
            current();
            return true;
          } catch {
            return false;
          }
        },
        online: () => !this.#state.offline,
        changed,
        request: (path, value) => {
          current();
          if (!this.#state.project?.runtime.features?.includes(SKILLS_FEATURE))
            throw Error('此执行电脑尚未提供 Skills 读取能力。');
          if (path !== `/api/workspaces/${catalogWorkspaceId}/replicas/${replicaId}/skills/read`)
            throw Error('Skills 请求不属于当前项目。');
          return this.#execute(
            { ...context, current },
            this.#command(context.scope, 'skills-read', value),
          );
        },
      },
    );
    return {
      controller: skills,
      close: () => {
        open = false;
        skills.invalidate();
      },
      addToDraft: async () => {
        await this.flushDraft();
        current();
        const draft = structuredClone(this.#state.draft!);
        if (
          !draft ||
          !this.#state.session?.persisted ||
          this.#state.session.persistenceError ||
          this.#state.session.meta.isArchived
        )
          throw Error('请先读取可编辑的原会话。');
        const instruction = await skills.instructionForDraft();
        await this.flushDraft();
        current();
        await this.store.saveDraft(
          context.scope,
          context.sessionId!,
          draft.revision,
          [draft.text, instruction].filter(Boolean).join('\n\n'),
          draft.selection,
          current,
          this.#state.catalogs[context.scope.source]?.actor,
        );
        await this.#reloadLedger({ ...context, current });
      },
    };
  }
  /** Explicit conflict recovery; the editor retains unsaved text until the user chooses this. */
  async reloadDraft() {
    const scope = this.#state.scope,
      sessionId = this.#state.sessionId,
      current = this.#current();
    if (!scope || !sessionId) throw Error('请先打开会话。');
    await this.flushDraft().catch(() => {});
    current();
    this.#draftBuffer = undefined;
    this.#draftInput = undefined;
    this.#cancelDraftSave?.();
    this.#cancelDraftSave = undefined;
    this.#state.ledger = await this.store.read(scope, current, sessionId);
    this.#state.draft = await this.store.readDraft(scope, sessionId, current, this.#state.ledger);
    this.#rememberSessionDraft(scope, sessionId);
    this.#draftWrites = Promise.resolve();
    this.#interactionWrites = Promise.resolve();
    this.#emit();
  }
  async #reloadLedger(context: Context) {
    this.#state.ledger = await this.store.read(
      context.scope,
      context.current,
      this.#state.sessionId ?? [],
    );
    if (this.#state.sessionId)
      this.#state.draft = await this.store.readDraft(
        context.scope,
        this.#state.sessionId,
        context.current,
        this.#state.ledger,
      );
    if (this.#state.sessionId) this.#rememberSessionDraft(context.scope, this.#state.sessionId);
    this.#emit();
  }
  async createSession(agentId: string, title?: string) {
    const sessionId = this.#uuid(),
      context = this.#context(sessionId);
    if (!context.project.runtime.agents.some((agent) => agent.id === agentId))
      throw Error('Agent 不属于所选电脑。');
    const { target } = context.scope;
    const value = sessionControlActionSchema.parse({
      controlVersion: 1,
      action: 'create',
      operationId: this.#uuid(),
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      userId: target.userId,
      machineId: target.machineId,
      sessionId,
      agentId,
      ...(title ? { title } : {}),
    });
    await this.store.stage(context.scope, { kind: 'control', value }, undefined, context.current);
    await this.#reloadLedger(context);
    await this.retry(value.operationId);
    return sessionId;
  }
  async #withInteractions<T>(
    context: Context,
    task: (controller: InteractionController) => Promise<T>,
  ) {
    const sessionId = context.sessionId;
    if (!sessionId) throw Error('请先打开会话。');
    const target = { ...context.scope.target, sessionId },
      key = interactionKey(target);
    return this.store.exclusiveOperation(
      context.scope,
      'interaction:' + sessionId,
      context.current,
      async () => {
        const ledger = await this.store.read(
          context.scope,
          context.current,
          context.sessionId ?? [],
        );
        let document = ledger.interactions?.[sessionId] ?? {
          revision: 0,
          value: emptyInteractionSaved(),
        };
        const interaction = new InteractionController(target, {
          uuid: () => this.#uuid(),
          read: async <V>(requested: string) => {
            context.current();
            if (requested !== key) throw Error('交互缓存范围不匹配。');
            return structuredClone(document.value) as V;
          },
          write: async (requested, raw) => {
            if (requested !== key) throw Error('交互缓存范围不匹配。');
            document = await this.store.saveInteraction(
              context.scope,
              sessionId,
              document.revision,
              interactionSavedSchema.parse(raw),
              context.current,
            );
            await this.#reloadLedger(context);
          },
          request: async (path, raw) => {
            const prefix = `/api/workspaces/${target.catalogWorkspaceId}/replicas/${target.replicaId}/`;
            const method =
              path === prefix + 'question-answers'
                ? 'answer-question'
                : path === prefix + 'steer'
                  ? 'steer'
                  : undefined;
            if (!method) throw Error('交互请求路径无效。');
            return this.#execute(context, this.#command(context.scope, method, raw));
          },
        });
        await interaction.load();
        return task(interaction);
      },
    );
  }
  async #saveInteraction(task: (controller: InteractionController) => Promise<void>) {
    const context = this.#context();
    await this.flushDraft();
    context.current();
    const work = this.#interactionWrites.then(() =>
      this.#withInteractions(context, (controller) => {
        if (controller.pending)
          throw Error('原交互尚未确认，当前输入未保存，请先核查或重新读取草稿。');
        return task(controller);
      }),
    );
    this.#interactionWrites = work;
    return work;
  }
  saveQuestionDraft(input: QuestionRequest, values: QuestionDraftValues) {
    const request = questionRequestSchema.parse(input),
      snapshot = structuredClone(values);
    return this.#saveInteraction((controller) => controller.saveQuestionDraft(request, snapshot));
  }
  saveSteerDraft(prompt: string) {
    return this.#saveInteraction((controller) => controller.saveSteerDraft(prompt));
  }
  async #freshInteraction(context: Context, kind: 'question' | 'steer') {
    await this.refreshSession();
    context.current();
    const session = this.#state.session,
      ledger = await this.store.read(context.scope, context.current, context.sessionId ?? []);
    if (
      !session ||
      session.persisted === false ||
      session.persistenceError ||
      session.meta.isArchived
    )
      throw Error('请先恢复会话并取得主机持久化确认。');
    if (
      ledger.operations.some(
        (item) => item.status === 'pending' && item.original.value.sessionId === context.sessionId,
      ) ||
      ledger.git?.[context.sessionId!]?.pending ||
      this.store.forkBlocked(ledger, context.sessionId!) ||
      this.store.githubBlocked(ledger, context.sessionId!) ||
      this.store.attentionBlocked(ledger, context.sessionId!)
    )
      throw Error('请先核查此会话的原操作。');
    const snapshot = workspaceInteractionSnapshot(this.#state);
    if (!snapshot.activeId) throw Error('原活动回合已结束；交互草稿不会转为新指令。');
    if (
      !context.project.runtime.features?.includes(
        kind === 'question' ? QUESTIONS_FEATURE : STEER_FEATURE,
      ) ||
      snapshot.capabilities?.[kind === 'question' ? 'questions' : 'steer'] !== true
    )
      throw Error(
        kind === 'steer'
          ? snapshot.capabilities?.steerUnavailableReason || '当前运行时不支持回合内追加。'
          : '当前运行时不支持问题回答。',
      );
    return snapshot;
  }
  async answerQuestion(input: QuestionRequest, answer: QuestionAnswer['answer']) {
    const request = questionRequestSchema.parse(input),
      reviewed = structuredClone(answer);
    await this.flushDraft();
    const context = this.#context();
    return this.#withInteractions(context, async (controller) => {
      const snapshot = await this.#freshInteraction(context, 'question');
      const item = snapshot.questions.find(
        (item) => item.status === 'pending' && same(item.request, request),
      );
      if (!item || snapshot.activeId !== request.expectedTurnId)
        throw Error('问题或原活动回合已改变，请重新读取并审阅。');
      await controller.answer(request, reviewed, {
        ...context.scope.target,
        sessionId: context.sessionId!,
      });
      await this.refreshSession();
    });
  }
  async steer(expectedTurnId: string, prompt: string) {
    await this.flushDraft();
    const context = this.#context();
    return this.#withInteractions(context, async (controller) => {
      const snapshot = await this.#freshInteraction(context, 'steer');
      if (snapshot.activeId !== expectedTurnId)
        throw Error('原回合已结束或改变，追加草稿不会转为新指令。');
      await controller.steer(expectedTurnId, prompt, {
        ...context.scope.target,
        sessionId: context.sessionId!,
      });
      try {
        await this.refreshSession();
      } catch (cause) {
        throw new Error('追加已送达，但会话尚未重新同步；请勿重复提交。', { cause });
      }
    });
  }
  /** Explicit composer submission; a later edit is never part of this request. */
  async steerDraft(expectedTurnId: string, reviewedPrompt: string) {
    const context = this.#context(),
      sessionId = context.sessionId,
      input = this.#draftInput,
      originalDraft = this.#state.draft;
    if (!sessionId || !originalDraft) throw Error('请先打开会话。');
    if (typeof reviewedPrompt !== 'string' || !reviewedPrompt.trim())
      throw Error('请填写要追加的正文。');
    if (reviewedPrompt.length > 16000) throw Error('追加正文最多 16000 个字符，请缩短后重试。');
    if ((input?.text ?? originalDraft.text) !== reviewedPrompt)
      throw Error('主输入草稿已改变，请重新确认要追加的正文。');
    if (this.#state.offline || this.#state.sessionLoad.status !== 'ready')
      throw Error('请先同步当前会话；草稿不会在重连后自动追加。');
    if (this.#state.ledger?.attachments?.[sessionId]?.items.length)
      throw Error('回合内追加不能携带附件；附件和正文均保留在草稿中。');

    await this.flushDraft();
    context.current();
    // The input object carries the revision written for the click-time input,
    // including a write already in flight. Never adopt a newer equal-text draft.
    const revision = input ? input.committed?.revision : originalDraft.revision;
    let delivered = false;
    try {
      await this.#withInteractions(context, async (controller) => {
        if (controller.steerDraft) throw Error('“回合内追加”面板中还有独立草稿，请先处理该草稿。');
        const snapshot = await this.#freshInteraction(context, 'steer');
        if (snapshot.activeId !== expectedTurnId)
          throw Error('原回合已结束或改变，主输入草稿不会转为新指令。');
        const ledger = await this.store.read(context.scope, context.current, sessionId);
        if (ledger.attachments?.[sessionId]?.items.length)
          throw Error('附件草稿已改变，回合内追加不能携带附件；正文仍保留。');
        await controller.steer(
          expectedTurnId,
          reviewedPrompt,
          { ...context.scope.target, sessionId },
          () => {
            delivered = true;
          },
        );
      });
    } catch (error) {
      if (!delivered) throw error;
      return {
        delivered: true as const,
        draftCleared: false,
        warning: '已追加到原活动回合，但本机确认状态未能更新；主输入草稿未清理，请核查原交互。',
      };
    }

    let draftCleared = false,
      warning: string | undefined;
    try {
      context.current();
      // Persist subsequent typing before the revision CAS. It cannot replace
      // the reviewed prompt, and the CAS cannot clear that later input.
      await this.flushDraft();
      context.current();
      if (revision !== undefined) {
        const draft = await this.store.clearDraft(
          context.scope,
          sessionId,
          revision,
          context.current,
        );
        draftCleared = draft.revision === revision + 1 && draft.text === '';
      }
      await this.#reloadLedger(context);
    } catch {
      warning = '已追加到原活动回合，但本机草稿状态未能更新；请勿重复追加同一正文。';
    }
    try {
      context.current();
      await this.refreshSession();
      context.current();
    } catch {
      warning ??= '已追加到原活动回合，会话尚未重新同步；请勿重复追加同一正文。';
    }
    return { delivered: true as const, draftCleared, ...(warning ? { warning } : {}) };
  }
  async retryInteraction() {
    await this.flushDraft();
    const context = this.#context();
    return this.#withInteractions(context, async (controller) => {
      await controller.retry({ ...context.scope.target, sessionId: context.sessionId! });
      await this.refreshSession();
    });
  }
  async dismissInteraction() {
    await this.flushDraft();
    const context = this.#context();
    return this.#withInteractions(context, async (controller) => {
      await this.refreshSession();
      context.current();
      const pending = controller.pending,
        snapshot = workspaceInteractionSnapshot(this.#state);
      if (!pending || !this.#state.session?.persisted || this.#state.session.persistenceError)
        throw Error('原交互尚不可关闭。');
      const notInjected =
        pending.kind === 'steer' &&
        snapshot.steers.some(
          (item) =>
            item.operationId === pending.request.operationId &&
            item.expectedTurnId === pending.request.expectedTurnId &&
            item.status === 'not-injected',
        );
      if (!notInjected && !snapshot.finished.includes(pending.request.expectedTurnId))
        throw Error('原回合尚未结束，请先重试原请求核查结果。');
      await controller.dismiss(
        notInjected ? 'not-injected' : 'unknown',
        notInjected
          ? '主机确认原追加未进入活动回合。'
          : '原回合已结束；关闭本机记录不代表原交互送达成功。',
      );
    });
  }
  // Recovery only: no task plans, grants, or new operation IDs can be created here.
  async recoverRetiredTask(shown: TaskAction, mode: 'inspect' | 'retry') {
    const original = taskActionSchema.parse(structuredClone(shown));
    if (mode !== 'inspect' && mode !== 'retry') throw Error('仅支持核查或重试原操作。');
    await this.flushDraft();
    const context = this.#context(),
      sessionId = context.sessionId;
    if (!sessionId) throw Error('请先打开原会话。');
    return this.store.exclusiveOperation(
      context.scope,
      'tasks:' + sessionId,
      context.current,
      async () => {
        const saved = (
          await this.store.read(context.scope, context.current, context.sessionId ?? [])
        ).tasks?.[sessionId];
        if (!saved?.pending || !same(saved.pending, original))
          throw Error('原任务操作已改变，请重新读取会话。');
        const request =
          mode === 'retry'
            ? original
            : taskActionSchema.parse({
                taskVersion: original.taskVersion,
                workspaceId: original.workspaceId,
                localProjectId: original.localProjectId,
                sessionId: original.sessionId,
                grantId: original.grantId,
                operationId: original.operationId,
                action: 'inspect',
              });
        const result = validateTaskActionResult(
          await this.#execute(context, this.#command(context.scope, 'tasks-action', request)),
          request,
        );
        context.current();
        if (
          (result.operation &&
            ['accepted', 'abandoned', 'rejected'].includes(result.operation.state)) ||
          (original.action === 'revoke' && result.grant.state !== 'active')
        ) {
          await this.store.saveTasks(
            context.scope,
            sessionId,
            saved.cacheRevision,
            { ...saved, cacheRevision: saved.cacheRevision + 1, pending: undefined },
            context.current,
          );
          await this.#reloadLedger(context);
        }
        return result;
      },
    );
  }
  async send() {
    const context = this.#context(),
      sessionId = context.sessionId;
    if (!sessionId || !this.#state.draft) throw Error('请先打开会话。');
    if (this.#sendFlight?.generation === this.#generation)
      throw Error('此会话正在准备或发送，请等待本次发送结果。');
    // Freeze the click before flushDraft can await a write and receive later
    // input. Only the captured write's committed revision is filled in later.
    const input = this.#draftInput,
      draft = structuredClone(
        input
          ? { text: input.text, selection: input.selection, revision: this.#state.draft.revision }
          : this.#state.draft,
      );
    const mcpRevision = this.#state.ledger?.mcp?.[sessionId]?.cacheRevision ?? 0;
    const taskRevision = this.#state.ledger?.tasks?.[sessionId]?.cacheRevision ?? 0;
    const annotationRevision = this.#state.ledger?.annotations?.[sessionId]?.cacheRevision ?? 0;
    const attachments = structuredClone(
      this.#state.ledger?.attachments?.[sessionId] ?? emptyWorkspaceAttachments(),
    );
    const flight = { generation: this.#generation };
    this.#sendFlight = flight;
    this.#state.sendProgress = { sessionId, stage: 'preparing' };
    this.#emit();
    try {
      await this.flushDraft();
      context.current();
      if (input) {
        if (!input.committed) throw Error('发送时的草稿已改变，请确认当前内容后再次发送。');
        draft.revision = input.committed.revision;
      }
      if (!context.project.runtime.features?.includes(SESSION_INTENTS_FEATURE))
        throw Error('执行电脑不支持新的会话发送接口，请升级主机；草稿未发送。');
      // This explicit send authorizes only these bytes and options. Later edits
      // remain a separate draft, including while uploads wait for their receipts.
      const readAttachments = async () => {
        const ledger = await this.store.read(context.scope, context.current, sessionId);
        const current = ledger.attachments?.[sessionId] ?? emptyWorkspaceAttachments();
        if (
          current.items.length !== attachments.items.length ||
          current.items.some((item, index) => {
            const expected = attachments.items[index]!;
            return (
              !same(item.reference, expected.reference) ||
              item.data !== expected.data ||
              item.uploaded !== expected.uploaded ||
              !!item.pending ||
              !!expected.pending
            );
          })
        )
          throw Error('附件草稿已改变或原上传尚未确认，请重新读取后继续。');
        return { ledger, attachments: current };
      };
      await this.refreshSession();
      await this.refreshAgentOptions();
      context.current();
      const { ledger } = await readAttachments();
      if (sessionPendingOperations(ledger, sessionId).length)
        throw Error('请先核查此会话尚未确认的原操作。');
      if (this.store.attentionBlocked(ledger, sessionId)) throw Error('请先核查原待办指令或审批。');
      if (this.store.githubBlocked(ledger, sessionId))
        throw Error('请先确认 GitHub 原操作，再发送新指令。');
      if (ledger.git?.[sessionId]?.pending) throw Error('请先确认原 Git 操作，再发送新指令。');
      if (this.store.forkBlocked(ledger, sessionId)) throw Error('请先核查原 Fork，再发送新指令。');
      // Validate the fixed prompt, Agent capabilities and idle turn before any upload.
      const value = buildSendTurn({
        scope: { ...context.scope.target, sessionId },
        read: this.#exportSessionSnapshot(context),
        agent: this.#state.session!.agent!,
        prompt: draft.text,
        selection: draft.selection,
        operationId: this.#uuid(),
        turnId: this.#uuid(),
        attachments: attachments.items.map((item) => item.reference),
      });
      const uploads = attachments.items.filter((item) => !item.uploaded);
      if (uploads.length && !context.project.runtime.features?.includes(ATTACHMENTS_FEATURE))
        throw Error('执行电脑暂不支持附件，请更新主机。');
      for (const [index, item] of uploads.entries()) {
        await readAttachments();
        this.#state.sendProgress = {
          sessionId,
          stage: 'uploading',
          uploaded: index,
          total: uploads.length,
        };
        this.#emit();
        await this.#performAttachmentAction(
          context,
          attachmentActionSchema.parse({
            contentVersion: 1,
            operationId: this.#uuid(),
            workspaceId: context.scope.target.workspaceId,
            localProjectId: context.scope.target.localProjectId,
            sessionId,
            action: 'upload',
            attachment: item.reference,
            data: item.data,
          }),
        );
        item.uploaded = true;
      }
      // Saving new input never expands the submitted prompt. A failed upload
      // exits before creating a send operation; reconnect/retry cannot resume it.
      await this.flushDraft();
      context.current();
      const confirmed = await readAttachments();
      this.#state.sendProgress = { sessionId, stage: 'sending' };
      this.#emit();
      await this.store.stage(
        context.scope,
        { kind: 'send-turn', value },
        {
          sessionId,
          revision: draft.revision,
          attachmentRevision: confirmed.attachments.revision,
          mcpRevision,
          taskRevision,
          annotationRevision,
        },
        context.current,
        undefined,
        undefined,
        undefined,
        true,
      );
      await this.#reloadLedger(context);
      await this.#deliverOperation(context, value.operationId);
      await this.#reloadLedger(context);
    } finally {
      if (this.#sendFlight === flight) {
        this.#sendFlight = undefined;
        if (!this.#closed && this.#state.sendProgress) {
          delete this.#state.sendProgress;
          this.#emit();
        }
      }
    }
  }
  async addAttachments(files: readonly File[], expectedCurrent: () => void = () => {}) {
    await this.flushDraft();
    expectedCurrent();
    const context = this.#context(),
      sessionId = context.sessionId;
    if (!sessionId) throw Error('请先打开会话。');
    const before = structuredClone(
      this.#state.ledger?.attachments?.[sessionId] ?? emptyWorkspaceAttachments(),
    );
    if (files.length + before.items.length > MAX_TURN_ATTACHMENTS)
      throw Error(`每条指令最多添加 ${MAX_TURN_ATTACHMENTS} 个附件。`);
    const additions = [];
    for (const file of [...files]) {
      additions.push(await createAttachmentDraftItem(file, this.#uuid()));
      context.current();
    }
    await this.store.saveAttachments(
      context.scope,
      sessionId,
      before.revision,
      [...before.items, ...additions],
      context.current,
    );
    await this.#reloadLedger(context);
  }
  async readAttachment(input: AttachmentReference) {
    const reference = attachmentReferenceSchema.parse(input),
      context = this.#context(),
      sessionId = context.sessionId;
    if (!sessionId) throw Error('请先打开会话。');
    if (this.#state.offline) {
      const cached = await this.store.attachmentContent(
        context.scope,
        sessionId,
        reference,
        context.current,
      );
      if (!cached) throw Error('本机尚无此附件缓存，请恢复原电脑连接后读取。');
      return { reference, data: cached.data, source: 'cache' as const, cacheSaved: true };
    }
    const target = context.scope.target;
    const value = attachmentContentSchema.parse(
      await this.#execute(
        context,
        this.#command(context.scope, 'read-attachment', {
          contentVersion: 1,
          workspaceId: target.workspaceId,
          localProjectId: target.localProjectId,
          sessionId,
          attachmentId: reference.attachmentId,
        }),
      ),
    );
    if (!same(reference, value.attachment)) throw Error('附件内容与所选引用不匹配。');
    await verifyAttachmentBytes(reference, value.data);
    context.current();
    let cacheSaved = false;
    try {
      await this.store.attachmentContent(
        context.scope,
        sessionId,
        reference,
        context.current,
        value,
      );
      cacheSaved = true;
    } catch {
      context.current();
    }
    return { reference, data: value.data, source: 'host' as const, cacheSaved };
  }
  async uploadAttachment(attachmentId: string) {
    return this.#attachmentAction(attachmentId, 'upload');
  }
  async removeAttachment(attachmentId: string) {
    return this.#attachmentAction(attachmentId, 'remove');
  }
  async #attachmentAction(attachmentId: string, action: 'upload' | 'remove') {
    await this.flushDraft();
    const context = this.#context(),
      sessionId = context.sessionId;
    if (!sessionId) throw Error('请先打开会话。');
    const attachments = structuredClone(
      this.#state.ledger?.attachments?.[sessionId] ?? emptyWorkspaceAttachments(),
    );
    const item = attachments.items.find((item) => item.reference.attachmentId === attachmentId);
    if (!item) throw Error('附件不存在，请重新读取。');
    if (item.pending) throw Error('附件尚未确认，请先核查或手动重试原操作。');
    if (action === 'remove' && !item.uploaded) {
      await this.store.saveAttachments(
        context.scope,
        sessionId,
        attachments.revision,
        attachments.items.filter((entry) => entry.reference.attachmentId !== attachmentId),
        context.current,
      );
      await this.#reloadLedger(context);
      return;
    }
    if (action === 'upload' && item.uploaded) return;
    if (!context.project.runtime.features?.includes(ATTACHMENTS_FEATURE))
      throw Error('执行电脑暂不支持附件，请更新主机。');
    const target = context.scope.target;
    const value = attachmentActionSchema.parse({
      contentVersion: 1,
      operationId: this.#uuid(),
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      sessionId,
      action,
      ...(action === 'upload' ? { attachment: item.reference, data: item.data } : { attachmentId }),
    });
    return this.#performAttachmentAction(context, value);
  }
  async #performAttachmentAction(context: Context, value: z.infer<typeof attachmentActionSchema>) {
    await this.store.stage(
      context.scope,
      { kind: 'attachment', value },
      undefined,
      context.current,
    );
    await this.#reloadLedger(context);
    await this.#deliverOperation(context, value.operationId);
    await this.#reloadLedger(context);
  }
  async respondPermission(review: SessionPermissionReview, outcome: SessionPermissionOutcome) {
    const context = this.#context();
    if (!context.sessionId) throw Error('请先打开会话。');
    if (!context.project.runtime.features?.includes(SESSION_INTENTS_FEATURE))
      throw Error('执行电脑不支持新的审批接口，请升级主机；审批未发送。');
    await this.refreshSession();
    context.current();
    const value = buildRespondPermission({
      scope: { ...context.scope.target, sessionId: context.sessionId },
      read: this.#exportSessionSnapshot(context),
      review,
      outcome,
      operationId: this.#uuid(),
    });
    await this.store.stage(
      context.scope,
      { kind: 'respond-permission', value },
      undefined,
      context.current,
    );
    await this.#reloadLedger(context);
    await this.retry(value.operationId);
  }
  async stop(turnId: string) {
    const context = this.#context();
    if (!context.sessionId) throw Error('请先打开会话。');
    await this.refreshSession();
    context.current();
    if (
      !this.#state.session?.history.some(
        (turn) => turn.role === 'assistant' && turn.id === turnId && !turn.finished,
      )
    )
      throw Error('此回合已经结束或改变，请重新读取。');
    const { target } = context.scope;
    const value = sessionControlActionSchema.parse({
      controlVersion: 1,
      action: 'stop',
      operationId: this.#uuid(),
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      userId: target.userId,
      machineId: target.machineId,
      sessionId: context.sessionId,
      turnId,
    });
    await this.store.stage(context.scope, { kind: 'control', value }, undefined, context.current);
    await this.#reloadLedger(context);
    await this.retry(value.operationId);
  }
  /** Explicit user action only. Nothing calls this on mount, polling or reconnection. */
  async retry(operationId: string) {
    const context = this.#context();
    await this.#deliverOperation(context, operationId);
    await this.#reloadLedger(context);
  }
  async #deliverOperation(context: Context, operationId: string) {
    await this.store.exclusiveOperation(context.scope, operationId, context.current, async () => {
      const entry = await this.store.operation(context.scope, operationId, context.current);
      const ledger = await this.store.read(
        context.scope,
        context.current,
        entry?.original.value.sessionId ?? [],
      );
      if (!entry || entry.status !== 'pending') throw Error('此原操作无需重试，请重新读取。');
      const original = entry.original;
      if (
        (original.kind === 'send-turn' || original.kind === 'respond-permission') &&
        !context.project.runtime.features?.includes(SESSION_INTENTS_FEATURE)
      )
        throw Error('执行电脑不支持原会话请求接口，请升级主机后手动核查。');
      if (
        ['mutation', 'send-turn', 'respond-permission'].includes(original.kind) &&
        (ledger.git?.[original.value.sessionId]?.pending ||
          this.store.forkBlocked(ledger, original.value.sessionId) ||
          this.store.githubBlocked(ledger, original.value.sessionId) ||
          this.store.attentionBlocked(ledger, original.value.sessionId))
      )
        throw Error('请先核查原 Git 操作，再重试会话指令。');
      const command = this.#command(
        context.scope,
        original.kind === 'control'
          ? 'session-control'
          : original.kind === 'metadata'
            ? 'session-action'
            : original.kind === 'attachment'
              ? 'attachment-action'
              : original.kind === 'send-turn' || original.kind === 'respond-permission'
                ? original.kind
                : 'mutate',
        original.value,
      );
      const raw = await this.#execute({ ...context, sessionId: original.value.sessionId }, command);
      let status: 'confirmed' | 'abandoned';
      if (original.kind === 'control') {
        const receipt = validateSessionControlReceipt(raw, original.value, original);
        if (receipt.status === 'stopping') return;
        status = receipt.status === 'abandoned' ? 'abandoned' : 'confirmed';
      } else if (original.kind === 'metadata') {
        const receipt = validateSessionActionReceipt(original.value, raw);
        status = receipt.accepted ? 'confirmed' : 'abandoned';
      } else if (original.kind === 'attachment') {
        const receipt = attachmentReceiptSchema.parse(raw),
          request = original.value;
        if (
          receipt.operationId !== operationId ||
          receipt.workspaceId !== request.workspaceId ||
          receipt.localProjectId !== request.localProjectId ||
          receipt.sessionId !== request.sessionId ||
          (request.action === 'upload'
            ? !same(receipt.attachment, request.attachment)
            : receipt.removed !== true)
        )
          throw Error('附件回执与完整原请求不匹配。');
        status = 'confirmed';
      } else {
        const receipt = mutationReceiptSchema.parse(raw);
        if (receipt.operationId !== operationId) throw Error('主机回执与原操作不匹配。');
        status = receipt.accepted ? 'confirmed' : 'abandoned';
      }
      await this.store.finish(context.scope, original, status, context.current);
    });
    this.#invalidateProject(context.scope.source, context.scope.target);
    this.scheduleSync({
      source: context.scope.source,
      connectionId: context.connectionId,
      owner: context.scope.target.owner,
      kind: 'changed',
      deviceId: context.scope.target.deviceId,
      workspaceId: context.scope.target.workspaceId,
      sessionId: context.sessionId,
    });
  }
  inspect(operationId: string) {
    return this.#recover(operationId, 'inspect');
  }
  abandon(operationId: string) {
    return this.#recover(operationId, 'abandon');
  }
  async #recover(operationId: string, action: 'inspect' | 'abandon') {
    const context = this.#context();
    await this.store.exclusiveOperation(context.scope, operationId, context.current, async () => {
      const entry = await this.store.operation(context.scope, operationId, context.current);
      const ledger = await this.store.read(
        context.scope,
        context.current,
        entry?.original.value.sessionId ?? [],
      );
      if (!entry || entry.status !== 'pending') throw Error('此原操作无需核查。');
      const target = context.scope.target,
        sessionId = entry.original.value.sessionId;
      const request = {
        controlVersion: 1 as const,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        userId: target.userId,
        machineId: target.machineId,
        sessionId,
        action,
        request: entry.original,
      };
      const result = validateSessionOperationResult(
        await this.#execute(
          { ...context, sessionId },
          this.#command(context.scope, 'session-operations', request),
        ),
        request,
      );
      if (result.found && result.receipt.status !== 'stopping')
        await this.store.finish(
          context.scope,
          entry.original,
          result.receipt.status === 'abandoned' ? 'abandoned' : 'confirmed',
          context.current,
        );
    });
    await this.#reloadLedger(context);
  }
  close() {
    this.#cancelSync?.();
    this.#syncPending.clear();
    this.#sessionSyncPending = false;
    this.#cancelDraftSave?.();
    this.#cancelDraftSave = undefined;
    this.#draftBuffer = undefined;
    this.#draftInput = undefined;
    this.#closed = true;
    this.#discardSessionReplica();
    this.#sessionViews.clear();
    this.#sessionViewBytes = 0;
    this.#sessionPages.clear();
    this.#sessionPageBytes = 0;
    this.#generation++;
    this.#listeners.clear();
    this.store.close();
  }
}
