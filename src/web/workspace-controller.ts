import { ProjectContentController } from './project-content-controller';
import { workspaceContentCache } from './workspace-content-cache';
import { projectContentKey } from './project-content';
import {
  projectDiffReferenceSchema,
  PROJECT_TREE_FEATURE,
  PROJECT_DIFF_FEATURE,
} from '../project-content-protocol';
import { actorKey } from '../attention';
import {
  AttentionController,
  deliverAttention,
  attentionScopeKey,
  attentionRouteSchema,
  attentionPendingKey,
  type AttentionRoute,
  type AttentionDependencies,
} from './attention';
import { workspaceAttentionKey, workspaceAttentionRequest } from './workspace-attention';
import { validateWorkspaceAttentionResponse } from '../desktop/workspace-attention';
import { searchSessionContent, type SessionSearchView } from './session-search';
import { SESSION_SEARCH_FEATURE, type SearchHit } from '../search-protocol';
import { GithubSessionController, type SecureGithubMode } from './secure-github';
import { githubKey } from './github';
import { githubWriteKey } from './github-write';
import { GITHUB_FEATURE } from '../github-protocol';
import { GITHUB_WRITE_FEATURE } from '../github-write-protocol';
import { z } from 'zod';
import {
  desktopWorkspaceCatalogSchema,
  desktopWorkspaceTargetSchema,
  type DesktopWorkspaceCatalog,
  type DesktopWorkspaceRequest,
  type DesktopWorkspaceSource,
} from '../desktop/workspace-protocol';
import {
  agentSchema,
  AGENT_MODEL_OPTIONS_FEATURE,
  sessionActionSchema,
  type SessionAction,
} from '../protocol';
import type { HostCommand } from '../bridge/host-command';
import { validateHostResponse } from '../host-response';
import {
  buildSessionTurn,
  buildSessionPermission,
  readClientSession,
  type SessionPermissionReview,
  type SessionPermissionOutcome,
} from '../session-client';
import {
  sessionListSchema,
  mutationReceiptSchema,
  type SessionMetadata,
  validateSessionActionReceipt,
} from '../session-responses';
import {
  legacyCacheRecoverySchema,
  legacyIndexSchema,
  legacyIndexCursorSchema,
  type LegacyIndexCursor,
  type LegacyReadSelection,
  legacyDraftRecoverySchema,
  matchesLegacyDraft,
  type LegacyDraftRecovery,
  legacySessionRecoverySchema,
  type LegacySessionRecovery,
} from '../desktop/legacy-cache';
import {
  sessionControlActionSchema,
  validateSessionControlReceipt,
  validateSessionOperationResult,
  type SessionOriginalOperation,
} from '../session-control-protocol';
import type { RunSelection } from '../run-config';
import { publicAgentFailure } from '../agent-errors';
import {
  WorkspaceStore,
  type WorkspaceScope,
  type WorkspaceDraft,
  type WorkspaceLedger,
} from './workspace-store';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { createAttachmentDraftItem } from './attachments';
import { emptyWorkspaceAttachments } from './workspace-attachments';
import {
  attachmentActionSchema,
  attachmentReceiptSchema,
  attachmentContentSchema,
  ATTACHMENTS_FEATURE,
  MAX_TURN_ATTACHMENTS,
} from '../attachment-protocol';
import { attachmentReferenceSchema, type AttachmentReference } from '../content-protocol';
import { verifyAttachmentBytes } from './attachments';
import {
  InteractionController,
  interactionSavedSchema,
  interactionKey,
  emptyInteractionSaved,
  type QuestionDraftValues,
} from './interactions';
import {
  questionRequestSchema,
  type QuestionRequest,
  type QuestionAnswer,
  QUESTIONS_FEATURE,
  STEER_FEATURE,
} from '../interaction-protocol';
import { workspaceInteractionSnapshot } from './workspace-interactions';
import { SkillsController } from './skills';
import { SKILLS_FEATURE } from '../skills-protocol';
import { McpController, mcpKey, type McpSaved } from './mcp';
import { MCP_FEATURE } from '../mcp-protocol';
import { workspaceFeatureTarget } from './workspace-mcp';
import {
  TasksController,
  tasksKey,
  validateTaskReview,
  taskDraftSchema,
  type TaskDraft,
} from './tasks';
import {
  SESSION_TASKS_FEATURE,
  taskPlanSchema,
  type TaskPlan,
  type TaskAction,
} from '../task-protocol';
import { gitStateResultSchema, type GitRepositoryState } from '../git-protocol';
import { RolesController, rolesKey, roleSelection, type RoleEdit } from './roles';
import { ROLE_FEATURE, roleViewSchema, type RoleView } from '../role-protocol';
import {
  ProjectPreviewController,
  PreviewAnnotationStore,
  projectPreviewKey,
  previewAnnotationKey,
} from './project-preview';
import { PREVIEW_FEATURE } from '../preview-protocol';
import { attachmentBytes } from './attachments';
import { SessionForkController, sessionForkKey, type ForkSaved } from './session-fork';
import { workspaceForkPending } from './workspace-fork';
import {
  SESSION_FORK_FEATURE,
  SECURE_FORK_OPERATIONS_FEATURE,
  forkCutoffSchema,
  forkDirectorySchema,
  validateForkOperationResult,
  type ForkCutoff,
  type ForkDirectory,
} from '../fork-protocol';
import { GitWorkspaceController, gitWorkspaceKey, type GitSaved } from './git-workspace';
import {
  GIT_WORKTREE_FEATURE,
  SECURE_GIT_OPERATIONS_FEATURE,
  validateGitOperationResult,
} from '../git-protocol';

type Project = DesktopWorkspaceCatalog['targets'][number];
type Session = ReturnType<typeof readClientSession>;
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
  sessionId?: string;
  session?: Session;
  offline: boolean;
  ledger?: WorkspaceLedger;
  draft?: WorkspaceDraft;
  modelError?: string;
  searchFocus?: SearchHit;
  focusedTurnId?: string;
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

/** Plain local/relay controller. Encrypted targets retain their own authenticated transport. */
export class WorkspaceController {
  #state: WorkspaceClientState = { catalogs: {}, errors: {}, sessions: [], offline: true };
  #generation = 0;
  #closed = false;
  #listeners = new Set<() => void>();
  #draftWrites: Promise<void> = Promise.resolve();
  #catalogVersions = { local: 0, remote: 0 };
  #sessionReadVersion = 0;
  #modelReadVersion = 0;
  constructor(
    private readonly options: {
      request: (request: DesktopWorkspaceRequest) => Promise<unknown>;
      legacy?: (request: unknown) => Promise<unknown>;
      store?: WorkspaceStore;
      uuid?: () => string;
      now?: () => string;
      schedule?: (ms: number, work: () => void) => () => void;
    },
  ) {
    this.store = options.store ?? new WorkspaceStore();
  }
  readonly store: WorkspaceStore;
  get canRecoverLegacy() {
    return !!this.options.legacy;
  }
  get state() {
    return structuredClone(this.#state);
  }
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #emit() {
    for (const listener of this.#listeners) listener();
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
  async #request(request: DesktopWorkspaceRequest, current: () => void) {
    current();
    const result = resultSchema.parse(await this.options.request(structuredClone(request)));
    current();
    if (!result.ok)
      throw Error(
        publicAgentFailure(
          Error(result.error.message),
          '执行电脑暂不可用，原草稿和待确认操作已保留。',
        ),
      );
    return result.value;
  }
  async refreshCatalog(source: DesktopWorkspaceSource) {
    const version = ++this.#catalogVersions[source];
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
      ) {
        this.#clearSelection();
      }
      this.#state.catalogs[source] = catalog;
      if (this.#state.scope?.source === source)
        this.#state.project = structuredClone(
          catalog.targets.find((entry) => same(entry.target, this.#state.scope!.target))!,
        );
      delete this.#state.errors[source];
    } catch (error) {
      current();
      this.#state.errors[source] = '暂时无法连接此电脑列表。';
      if (this.#state.scope?.source === source) {
        this.#generation++;
        this.#state.offline = true;
      }
      throw error;
    } finally {
      if (!this.#closed && this.#catalogVersions[source] === version) this.#emit();
    }
  }
  #clearSelection() {
    this.#generation++;
    this.#state = {
      catalogs: this.#state.catalogs,
      errors: this.#state.errors,
      sessions: [],
      offline: true,
    };
    this.#draftWrites = Promise.resolve();
  }
  async selectProject(source: DesktopWorkspaceSource, target: Project['target']) {
    await this.#draftWrites;
    const project = this.#state.catalogs[source]?.targets.find((entry) =>
      same(entry.target, target),
    );
    if (!project) throw Error('项目不属于当前电脑列表。');
    this.#clearSelection();
    this.#state.scope = { source, target: structuredClone(project.target) };
    this.#state.project = structuredClone(project);
    const current = this.#current();
    this.#state.ledger = await this.store.read(this.#state.scope, current);
    this.#emit();
    await this.refreshSessions();
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
  async refreshSessions() {
    const context = this.#context();
    try {
      const sessions = sessionListSchema.parse(
        await this.#execute(
          { ...context, sessionId: undefined },
          this.#command(context.scope, 'sessions', {}),
        ),
      );
      if (
        sessions.some(
          (item) =>
            item.userId !== context.scope.target.userId ||
            item.machineId !== context.scope.target.machineId ||
            item.project.localProjectId !== context.scope.target.localProjectId,
        )
      )
        throw Error('会话列表执行范围不匹配。');
      const recovered = this.#state.ledger?.legacy ?? [];
      this.#state.sessions = [
        ...sessions,
        ...recovered
          .filter(
            (item, index) =>
              !sessions.some((session) => session.id === item.sessionId) &&
              recovered.findIndex((other) => other.sessionId === item.sessionId) === index,
          )
          .map((item) => item.snapshot.meta),
      ];
      this.#state.offline = false;
    } catch (error) {
      context.current();
      this.#state.offline = true;
      throw error;
    } finally {
      context.current();
      this.#emit();
    }
  }
  async openSession(sessionId: string, turnId?: string) {
    this.#state.searchFocus = undefined;
    this.#state.focusedTurnId = undefined;
    await this.#draftWrites;
    const scope = this.#context(sessionId).scope;
    this.#generation++;
    this.#state.sessionId = sessionId;
    delete this.#state.session;
    delete this.#state.modelError;
    const current = this.#current();
    this.#state.ledger = await this.store.read(scope, current);
    this.#state.draft = this.#state.ledger.drafts[sessionId] ?? {
      revision: 0,
      text: '',
      selection: {},
    };
    const cached = await this.store.cachedSession(scope, sessionId, current);
    if (cached) this.#state.session = cached;
    this.#state.offline = true;
    this.#emit();
    await this.refreshSession();
    await this.refreshAgentOptions();
    current();
    if (turnId && this.#state.session?.history.some((turn) => turn.id === turnId)) {
      this.#state.focusedTurnId = turnId;
      this.#emit();
    }
  }
  async refreshSession() {
    const context = this.#context();
    const version = ++this.#sessionReadVersion,
      selected = context.current;
    context.current = () => {
      selected();
      if (version !== this.#sessionReadVersion) throw Error('会话读取已由较新的请求替代。');
    };
    if (!context.sessionId) throw Error('请先选择会话。');
    try {
      const raw = await this.#execute(
        context,
        this.#command(context.scope, 'session', { sessionId: context.sessionId }),
      );
      const session = readClientSession(raw, {
        ...context.scope.target,
        sessionId: context.sessionId,
      });
      await this.store.cacheSession(context.scope, context.sessionId, raw, context.current);
      context.current();
      this.#state.session = session;
      this.#state.offline = false;
    } catch (error) {
      context.current();
      this.#state.offline = true;
      throw error;
    } finally {
      context.current();
      this.#emit();
    }
  }
  async refreshAgentOptions() {
    const context = this.#context(),
      session = this.#state.session;
    const version = ++this.#modelReadVersion,
      selected = context.current;
    context.current = () => {
      selected();
      if (version !== this.#modelReadVersion) throw Error('模型读取已由较新的请求替代。');
    };
    if (!session || !context.sessionId) throw Error('请先读取会话。');
    try {
      const agent = agentSchema.parse(
        await this.#execute(
          context,
          this.#command(context.scope, 'agent-options', {
            sessionId: context.sessionId,
            agentId: session.meta.agentConfigId,
            ...(context.project.runtime.features?.includes(AGENT_MODEL_OPTIONS_FEATURE) &&
            this.#state.draft?.selection.modelId
              ? { modelId: this.#state.draft.selection.modelId }
              : {}),
          }),
        ),
      );
      // Preserve a newer timeline read which may have completed while capabilities loaded.
      this.#state.session = { ...this.#state.session!, agent };
      delete this.#state.modelError;
    } catch (error) {
      context.current();
      this.#state.modelError = publicAgentFailure(
        error,
        '模型选项暂不可读取，请刷新或检查执行电脑。',
      );
      throw error;
    } finally {
      context.current();
      this.#emit();
    }
  }
  saveDraft(text: string, selection: RunSelection) {
    const scope = this.#state.scope,
      sessionId = this.#state.sessionId,
      current = this.#current();
    if (!scope || !sessionId || !this.#state.draft) return Promise.reject(Error('请先打开会话。'));
    const snapshot = structuredClone({ text, selection });
    const write = this.#draftWrites.then(async () => {
      current();
      this.#state.draft = await this.store.saveDraft(
        scope,
        sessionId,
        this.#state.draft!.revision,
        snapshot.text,
        snapshot.selection,
        current,
        this.#state.catalogs[scope.source]?.actor,
      );
      current();
      this.#emit();
    });
    this.#draftWrites = write;
    return write;
  }
  async openFork(changed: () => void = () => {}) {
    await this.#draftWrites;
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
        return (await this.store.read(context.scope, current)).forks?.[sessionId];
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
      await this.#draftWrites;
      current();
      if (kind === 'create') await this.#checkLegacyBeforeSend(context, sessionId);
      return this.store.exclusiveOperation(
        context.scope,
        'fork:' + sessionId,
        current,
        async () => {
          const ledger = await this.store.read(context.scope, current),
            saved = ledger.forks?.[sessionId];
          if (
            ['create', 'retry'].includes(kind) &&
            (ledger.git?.[sessionId]?.pending ||
              ledger.operations.some(
                (item) => item.status === 'pending' && item.original.value.sessionId === sessionId,
              ) ||
              ledger.interactions?.[sessionId]?.value.pending ||
              ledger.mcp?.[sessionId]?.delivery ||
              this.store.recoveryBlocked(ledger, sessionId))
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
              !this.#state.project?.runtime.features?.includes(SECURE_FORK_OPERATIONS_FEATURE)
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
            read as import('../git-protocol').GitStateResult,
          );
        }),
    };
  }
  async openAttention(changed: () => void = () => {}) {
    await this.#draftWrites;
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
      const ledger = await this.store.read(context.scope, current);
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
        await this.#draftWrites;
        check();
        if (['continue', 'permission'].includes(original.operation.kind))
          await this.#checkLegacyBeforeSend(context, original.sessionId);
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
        await this.#draftWrites;
        const context = scoped(route, sessionId),
          ledger = await this.store.read(context.scope, current);
        const draft = ledger.drafts[sessionId];
        return draft?.actor && actorKey(draft.actor) === actorKey(actor)
          ? draft.text
          : { text: '', unscoped: !!draft?.text };
      },
      prepareTurn: async (route, sessionId, text) => {
        await this.#draftWrites;
        const context = scoped(route, sessionId);
        await this.#checkLegacyBeforeSend(context, sessionId);
        const ledger = await this.store.read(context.scope, current),
          draft = ledger.drafts[sessionId];
        if (
          this.store.attentionBlocked(ledger, sessionId) ||
          this.store.githubBlocked(ledger, sessionId) ||
          this.store.forkBlocked(ledger, sessionId) ||
          this.store.recoveryBlocked(ledger, sessionId) ||
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
        const latest = await this.store.read(context.scope, current);
        if (!same(latest.drafts[sessionId]?.selection ?? {}, draft?.selection ?? {}))
          throw Error('运行选项已改变，请重新查看后续要求。');
        return buildSessionTurn({
          scope: { ...context.scope.target, sessionId },
          read,
          agent,
          prompt: text,
          selection: draft?.selection,
          operationId: this.#uuid(),
          turnId: this.#uuid(),
          peerId: this.#uuid(),
          now: (this.options.now ?? (() => new Date().toISOString()))(),
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
        await this.#draftWrites;
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
    await this.#draftWrites;
    const context = this.#context();
    if (!shown || shown.id !== context.sessionId) throw Error('请先读取原会话。');
    if (this.#state.offline) throw Error('执行电脑离线，请连接后手动整理会话。');
    await this.#checkLegacyBeforeSend(context, shown.id);
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
  #contentCache(scope: WorkspaceScope) {
    const cache = workspaceContentCache(scope.source, this.store.backend);
    return {
      read: async (target: Parameters<typeof cache.read>[0], key: string, current: () => void) => {
        current();
        if (!same({ ...scope.target, sessionId: target.sessionId }, target))
          throw Error('文件缓存目标已改变。');
        const fresh = await cache.read(target, key, current);
        if (fresh !== undefined) return fresh;
        const ledger = await this.store.read(scope, current);
        const values = [...(ledger.legacy ?? []), ...(ledger.legacyDrafts ?? [])]
          .filter((record) => record.sessionId === target.sessionId)
          .flatMap((record) => record.content?.filter((entry) => entry.key === key) ?? []);
        if (values.some((entry) => !same(entry.value, values[0]!.value)))
          throw Error('多个旧来源的文件缓存版本不一致，请连接原主机重新读取。');
        current();
        return structuredClone(values[0]?.value);
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
        await this.#draftWrites;
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
    await this.#draftWrites;
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
  async openGithub(changed: () => void = () => {}, mode: SecureGithubMode = 'read') {
    await this.#draftWrites;
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
            return (await this.store.read(context.scope, check))[kindFor(target, key)]?.[sessionId];
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
          const ledger = await this.store.read(context.scope, current);
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
        await this.#draftWrites;
        checkTarget(target, current);
        await this.#checkLegacyBeforeSend({ ...context, current }, sessionId);
        const ledger = await this.store.read(context.scope, current);
        if (
          this.store.githubBlocked(ledger, sessionId) ||
          this.store.attentionBlocked(ledger, sessionId) ||
          this.store.forkBlocked(ledger, sessionId) ||
          ledger.git?.[sessionId]?.pending ||
          ledger.interactions?.[sessionId]?.value.pending ||
          ledger.operations.some(
            (entry) => entry.status === 'pending' && entry.original.value.sessionId === sessionId,
          ) ||
          this.store.recoveryBlocked(ledger, sessionId)
        )
          throw Error('请先核查此会话原操作，再确认新的 GitHub 操作。');
      },
      appendInstruction: async (target, text, current) => {
        await this.#draftWrites;
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
    await this.#draftWrites;
    const context = this.#context(resourceSessionId ?? this.#state.sessionId);
    if (!context.sessionId) throw Error('请先打开会话。');
    if (resourceSessionId && resourceSessionId !== this.#state.sessionId) {
      const ledger = await this.store.read(context.scope, context.current);
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
        return (await this.store.read(context.scope, current)).git?.[sessionId];
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
      await this.#draftWrites;
      current();
      const recovery = ['retry', 'inspect', 'abandon'].includes(kind);
      if (kind !== 'refresh' && !recovery) await this.#checkLegacyBeforeSend(context, sessionId);
      return this.store.exclusiveOperation(context.scope, 'git:' + sessionId, current, async () => {
        const ledger = await this.store.read(context.scope, current);
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
            ledger.mcp?.[sessionId]?.delivery ||
            this.store.recoveryBlocked(ledger, sessionId))
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
            !this.#state.project?.runtime.features?.includes(SECURE_GIT_OPERATIONS_FEATURE)
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
  async #loadTasks(context: Context, changed: () => void = () => {}) {
    if (!context.sessionId) throw Error('请先打开会话。');
    const sessionId = context.sessionId,
      target = workspaceFeatureTarget({ ...context.scope.target, sessionId }),
      key = tasksKey(target);
    const controller = new TasksController(target, {
      uuid: () => this.#uuid(),
      changed,
      current: () => {
        try {
          context.current();
          return true;
        } catch {
          return false;
        }
      },
      online: () =>
        !this.#state.offline &&
        !!this.#state.project?.runtime.features?.includes(SESSION_TASKS_FEATURE),
      read: async (requested) => {
        if (requested !== key) throw Error('任务草稿范围不匹配。');
        return (await this.store.read(context.scope, context.current)).tasks?.[sessionId];
      },
      compareWrite: async (requested, revision, value, valid) => {
        if (requested !== key) throw Error('任务草稿范围不匹配。');
        const check = () => {
          context.current();
          if (!valid()) throw Error('任务面板已改变。');
        };
        await this.store.saveTasks(context.scope, sessionId, revision, value, check);
        await this.#reloadLedger({ ...context, current: check });
        return true;
      },
      compareSubmission: async () => {
        throw Error('任务授权只能与父指令一起保存。');
      },
      request: (path, value) => {
        const prefix = `/api/workspaces/${target.catalogWorkspaceId}/replicas/${target.replicaId}/tasks-`;
        if (path === prefix + 'read')
          return this.#execute(context, this.#command(context.scope, 'tasks-read', value));
        if (path === prefix + 'action')
          return this.#execute(context, this.#command(context.scope, 'tasks-action', value));
        throw Error('任务请求不属于当前项目。');
      },
    });
    await controller.load();
    return controller;
  }
  async #taskBranches(context: Context) {
    context.current();
    const value = gitStateResultSchema.parse(
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
    if (!value.repository.writeSupported || value.execution.status !== 'ready')
      throw Error('当前目录不能准备独立任务工作目录。');
    return value.repository;
  }
  async #taskAgent(context: Context, id: string, modelId?: string) {
    context.current();
    const original = this.#state.project?.runtime.agents.find((item) => item.id === id);
    if (!original) throw Error('子任务 Agent 版本当前不可选择。');
    const agent = agentSchema.parse(
      await this.#execute(
        context,
        this.#command(context.scope, 'agent-options', {
          agentId: id,
          ...(modelId && context.project.runtime.features?.includes(AGENT_MODEL_OPTIONS_FEATURE)
            ? { modelId }
            : {}),
        }),
      ),
    );
    if (
      agent.id !== id ||
      agent.cliType !== original.cliType ||
      agent.agentType !== original.agentType
    )
      throw Error('模型选项不属于原任务 Agent。');
    Object.assign(original, agent);
    this.#emit();
    return agent;
  }
  async #reviewTasks(context: Context, input: TaskDraft, parentAgentId: string) {
    const draft = taskDraftSchema.parse(input);
    context.current();
    if (
      !this.#state.session?.persisted ||
      this.#state.session.persistenceError ||
      this.#state.session.meta.isArchived
    )
      throw Error('请先读取可编辑的父会话。');
    if (!this.#state.project?.runtime.features?.includes(SESSION_TASKS_FEATURE))
      throw Error('此执行电脑尚未支持协作任务。');
    if (
      this.#state.session?.meta.taskOrigin ||
      this.#state.session?.meta.agentConfigId !== parentAgentId
    )
      throw Error('父会话或 Agent 已变化，请重新审查任务计划。');
    const repository = await this.#taskBranches(context);
    // A task may review a different model of the same Agent; validate each against its own probe.
    for (const task of draft.tasks) {
      const agent = await this.#taskAgent(context, task.agentId, task.selection?.modelId);
      validateTaskReview(
        { ...draft, tasks: [task] },
        { parentAgentId, child: false, agents: [agent], branches: repository.branches },
      );
    }
    context.current();
    return { plan: taskPlanSchema.parse(draft), repository };
  }
  async openTasks(changed: () => void = () => {}) {
    await this.#draftWrites;
    const original = this.#context();
    if (!original.sessionId) throw Error('请先打开会话。');
    const sessionId = original.sessionId;
    let open = true;
    const current = () => {
      original.current();
      if (!open) throw Error('任务面板已关闭。');
    };
    const context = { ...original, current };
    const controller = await this.#loadTasks(context, changed);
    let repository: GitRepositoryState | undefined;
    const review = async () => {
      await controller.flush();
      current();
      const draft = structuredClone(controller.draft),
        parent = this.#state.session!.meta.agentConfigId;
      await this.#checkLegacyBeforeSend(context, sessionId);
      await this.refreshSession();
      current();
      const result = await this.#reviewTasks(context, draft, parent);
      if (!same(draft, controller.draft)) throw Error('任务草稿已改变，请重新审查。');
      repository = result.repository;
      changed();
      return result.plan;
    };
    const action = async (
      kind: TaskAction['action'] | 'retry',
      grantId?: string,
      operationId?: string,
      cleanup?: { taskId: string; expectedExecutionRevision: number },
    ) => {
      await controller.flush();
      current();
      const pending = structuredClone(controller.pending);
      return this.store.exclusiveOperation(
        context.scope,
        'tasks:' + sessionId,
        current,
        async () => {
          const latest = (await this.store.read(context.scope, current)).tasks?.[sessionId];
          if (!same(pending ?? null, latest?.pending ?? null))
            throw Error('原任务操作已改变，请重新读取。');
          await controller.load();
          return kind === 'retry'
            ? controller.retry()
            : controller.action(kind, grantId!, operationId, cleanup);
        },
      );
    };
    return {
      controller,
      review,
      action,
      get repository() {
        return repository;
      },
      close: () => {
        open = false;
        controller.dispose();
      },
      readBranches: async () => {
        repository = await this.#taskBranches(context);
        changed();
      },
      refreshAgent: (id: string) => this.#taskAgent(context, id),
      enable: async (plan: TaskPlan) => {
        const expected = taskPlanSchema.parse(plan),
          fresh = await review();
        if (!same(expected, fresh)) throw Error('任务审查内容已变化，请重新核对。');
        await controller.enable(fresh, this.#state.session!.meta.agentConfigId);
      },
      openSession: async (id: string) => {
        current();
        await controller.refresh();
        current();
        if (
          !controller.list?.grants.some((grant) =>
            grant.tasks.some((task) => task.sessionCreated && task.childSessionId === id),
          )
        )
          throw Error('此子任务会话尚未由主机确认。');
        await this.openSession(id);
      },
    };
  }
  async openRoles(changed: () => void = () => {}) {
    await this.#draftWrites;
    const context = this.#context();
    if (!context.sessionId) throw Error('请先打开会话。');
    const sessionId = context.sessionId,
      target = workspaceFeatureTarget({ ...context.scope.target, sessionId }),
      key = rolesKey(target),
      endpoint = `/api/workspaces/${target.catalogWorkspaceId}/replicas/${target.replicaId}/roles/`;
    let open = true;
    const current = () => {
      context.current();
      if (!open) throw Error('角色面板已关闭。');
    };
    const scoped = { ...context, current };
    const controller = new RolesController(target, {
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
      online: () =>
        !this.#state.offline && !!this.#state.project?.runtime.features?.includes(ROLE_FEATURE),
      read: async (requested) => {
        if (requested !== key) throw Error('角色缓存范围不匹配。');
        return (await this.store.read(context.scope, current)).roles?.[sessionId];
      },
      compareWrite: async (requested, revision, value, valid) => {
        if (requested !== key) throw Error('角色缓存范围不匹配。');
        const check = () => {
          current();
          if (!valid()) throw Error('角色操作已改变。');
        };
        await this.store.saveRoles(context.scope, sessionId, revision, value, check);
        await this.#reloadLedger({ ...context, current: check });
        return true;
      },
      request: (path, value) => {
        current();
        if (path === endpoint + 'read')
          return this.#execute(scoped, this.#command(context.scope, 'roles-read', value));
        if (path === endpoint + 'action')
          return this.#execute(scoped, this.#command(context.scope, 'roles-action', value));
        throw Error('角色请求不属于当前项目。');
      },
    });
    await controller.load();
    const perform = async (
      action: 'save' | 'remove' | 'retry' | 'inspect' | 'abandon',
      edit?: RoleEdit,
      id?: string,
    ) => {
      const original = structuredClone(controller.pending);
      const ending = controller.ending;
      return this.store.exclusiveOperation(
        context.scope,
        'roles:' + sessionId,
        current,
        async () => {
          await controller.load();
          if (
            ['retry', 'inspect', 'abandon'].includes(action) &&
            (!original ||
              !same(original, controller.pending ?? null) ||
              ending !== controller.ending)
          )
            throw Error('原角色操作已改变，请重新读取。');
          if (action === 'save') return controller.saveRole(edit!);
          if (action === 'remove') return controller.remove(id!);
          return controller[action]();
        },
      );
    };
    const refreshAgent = async (id: string, modelId?: string) => {
      current();
      const agent =
        this.#state.session?.agent?.id === id
          ? this.#state.session.agent
          : this.#state.project?.runtime.agents.find((item) => item.id === id);
      if (!agent) throw Error('此角色的 Agent 版本当前不可选择。');
      const updated = agentSchema.parse(
        await this.#execute(
          scoped,
          this.#command(context.scope, 'agent-options', {
            agentId: id,
            ...(this.#state.session?.meta.agentConfigId === id ? { sessionId } : {}),
            ...(modelId && context.project.runtime.features?.includes(AGENT_MODEL_OPTIONS_FEATURE)
              ? { modelId }
              : {}),
          }),
        ),
      );
      if (
        updated.id !== agent.id ||
        updated.cliType !== agent.cliType ||
        updated.agentType !== agent.agentType
      )
        throw Error('模型选项不属于所选角色的 Agent 版本。');
      current();
      const item = this.#state.project?.runtime.agents.find((item) => item.id === id);
      if (item) Object.assign(item, updated);
      if (this.#state.session?.agent?.id === id) this.#state.session.agent = updated;
      this.#emit();
      changed();
      return updated;
    };
    const freshRole = async (input: RoleView) => {
      const role = roleViewSchema.parse(input);
      current();
      if (controller.pending) throw Error('请先核查原角色操作。');
      return controller.freshRole(role);
    };
    const apply = async (input: RoleView) => {
      await this.#draftWrites;
      current();
      const draft = structuredClone(this.#state.draft);
      if (!draft) throw Error('原会话草稿不可用。');
      await this.#checkLegacyBeforeSend(scoped, sessionId);
      const role = await freshRole(input);
      await this.refreshSession();
      current();
      const session = this.#state.session;
      if (!session?.persisted || session.persistenceError || session.meta.isArchived)
        throw Error('请先读取可编辑的原会话。');
      if (session.meta.agentConfigId !== role.agentId)
        throw Error('已有会话已固定另一 Agent，请明确创建新会话后应用此角色。');
      const agent = await refreshAgent(role.agentId, role.selection.modelId);
      const selection = roleSelection(role, draft.selection, agent.runConfig);
      await freshRole(role);
      const base = session.history.findLast((turn) => turn.role === 'user')?.id ?? '';
      await this.store.applyRole(
        context.scope,
        sessionId,
        draft.revision,
        base,
        role,
        selection,
        current,
      );
      await this.#reloadLedger(scoped);
    };
    return {
      controller,
      refreshAgent,
      apply,
      refresh: () => controller.refresh(),
      save: (edit: RoleEdit) => perform('save', structuredClone(edit)),
      remove: (id: string) => perform('remove', undefined, id),
      retry: () => perform('retry'),
      inspect: () => perform('inspect'),
      abandon: () => perform('abandon'),
      close: () => {
        open = false;
        controller.invalidate();
      },
      createFromRole: async (input: RoleView) => {
        const role = await freshRole(input);
        const agent = await refreshAgent(role.agentId, role.selection.modelId);
        roleSelection(role, {}, agent.runConfig);
        current();
        const id = await this.createSession(role.agentId, role.name);
        current();
        await this.refreshSessions();
        await this.openSession(id);
        const next = await this.openRoles();
        try {
          await next.apply(role);
        } finally {
          next.close();
        }
        return id;
      },
    };
  }
  async #loadAnnotations(context: Context, changed: () => void = () => {}) {
    if (!context.sessionId) throw Error('请先打开会话。');
    const sessionId = context.sessionId,
      target = workspaceFeatureTarget({ ...context.scope.target, sessionId }),
      key = previewAnnotationKey(target);
    const annotations = new PreviewAnnotationStore(target, {
      uuid: () => this.#uuid(),
      now: this.options.now,
      changed,
      current: () => {
        try {
          context.current();
          return true;
        } catch {
          return false;
        }
      },
      read: async (requested) => {
        if (requested !== key) throw Error('标注缓存范围不匹配。');
        return (await this.store.read(context.scope, context.current)).annotations?.[sessionId];
      },
      compareWrite: async (requested, revision, value, valid) => {
        if (requested !== key) throw Error('标注缓存范围不匹配。');
        const check = () => {
          context.current();
          if (!valid()) throw Error('标注面板已改变。');
        };
        await this.store.saveAnnotations(context.scope, sessionId, revision, value, check);
        await this.#reloadLedger({ ...context, current: check });
        return true;
      },
    });
    await annotations.load();
    return annotations;
  }
  async openPreview(changed: () => void = () => {}) {
    await this.#draftWrites;
    const context = this.#context();
    if (!context.sessionId) throw Error('请先打开会话。');
    const sessionId = context.sessionId,
      target = workspaceFeatureTarget({ ...context.scope.target, sessionId }),
      key = projectPreviewKey(target),
      endpoint = `/api/workspaces/${target.catalogWorkspaceId}/replicas/${target.replicaId}/preview/`;
    let open = true;
    const current = () => {
      context.current();
      if (!open) throw Error('预览面板已关闭。');
    };
    const scoped = { ...context, current };
    const annotations = await this.#loadAnnotations(scoped, changed);
    let heartbeat: (() => void) | undefined;
    let heartbeatId = 0;
    const stopHeartbeat = () => {
      heartbeatId++;
      heartbeat?.();
      heartbeat = undefined;
    };
    const update = () => {
      changed();
      let valid = false;
      try {
        current();
        valid = true;
      } catch {
        /* The old connection cannot renew its lease. */
      }
      if (
        !valid ||
        this.#state.offline ||
        !controller.active ||
        controller.busy ||
        controller.pending ||
        controller.closing ||
        controller.error ||
        controller.loadError
      ) {
        stopHeartbeat();
        return;
      }
      if (heartbeat) return;
      const id = ++heartbeatId;
      const schedule =
        this.options.schedule ??
        ((ms: number, work: () => void) => {
          const timer = setTimeout(work, ms);
          return () => clearTimeout(timer);
        });
      heartbeat = schedule(12000, () => {
        if (id !== heartbeatId) return;
        heartbeat = undefined;
        try {
          current();
        } catch {
          return;
        }
        // Renew only an already active connection with a read. Never reopen or replay.
        void controller.status().catch(() => {});
      });
    };
    const controller = new ProjectPreviewController(target, {
      uuid: () => this.#uuid(),
      changed: update,
      current: () => {
        try {
          current();
          return true;
        } catch {
          return false;
        }
      },
      online: () =>
        !this.#state.offline && !!this.#state.project?.runtime.features?.includes(PREVIEW_FEATURE),
      read: async (requested) => {
        if (requested !== key) throw Error('预览缓存范围不匹配。');
        return (await this.store.read(context.scope, current)).previews?.[sessionId];
      },
      compareWrite: async (requested, revision, value, valid) => {
        if (requested !== key) throw Error('预览缓存范围不匹配。');
        const check = () => {
          current();
          if (!valid()) throw Error('预览连接已改变。');
        };
        await this.store.savePreview(context.scope, sessionId, revision, value, check);
        await this.#reloadLedger({ ...context, current: check });
        return true;
      },
      request: async (path, value) => {
        current();
        const methods = {
          read: 'preview-read',
          action: 'preview-action',
          inspect: 'preview-inspect',
          close: 'preview-close',
        } as const;
        const kind = Object.keys(methods).find((item) => path === endpoint + item) as
          | keyof typeof methods
          | undefined;
        if (!kind) throw Error('预览请求不属于当前项目。');
        return this.#execute(scoped, this.#command(context.scope, methods[kind], value));
      },
    });
    await controller.load();
    return {
      controller,
      annotations,
      close: async () => {
        stopHeartbeat();
        try {
          if (controller.openRequest) await controller.close();
        } finally {
          open = false;
          controller.invalidate();
        }
      },
      dispose: () => {
        stopHeartbeat();
        // Release only this captured connection. Navigation can invalidate its authority;
        // in that case the host lease expires and the saved record requires manual close.
        const release = controller.dispose();
        open = false;
        void release.catch(() => {});
      },
      addImage: async (id: string) => {
        current();
        await annotations.settled();
        const fresh = await this.#loadAnnotations(scoped),
          item = annotations.items.find((value) => value.id === id),
          latest = fresh.items.find((value) => value.id === id);
        if (!item?.snapshot.image || !latest || item.version !== latest.version)
          throw Error('原截图已改变，请重新打开标注。');
        const image = item.snapshot.image;
        current();
        await this.addAttachments(
          [
            new File([attachmentBytes(image.data)], `网页标注-${id.slice(0, 32)}.png`, {
              type: 'image/png',
            }),
          ],
          current,
        );
        current();
      },
    };
  }
  async #loadMcp(context: Context, changed: () => void = () => {}) {
    if (!context.sessionId) throw Error('请先打开会话。');
    const sessionId = context.sessionId,
      target = workspaceFeatureTarget({ ...context.scope.target, sessionId }),
      key = mcpKey(target);
    const current = () => {
      try {
        context.current();
        return true;
      } catch {
        return false;
      }
    };
    const controller = new McpController(target, {
      uuid: () => this.#uuid(),
      current,
      changed,
      online: () =>
        !this.#state.offline && !!this.#state.project?.runtime.features?.includes(MCP_FEATURE),
      read: async (requested) => {
        if (requested !== key) throw Error('MCP 缓存范围不匹配。');
        return (await this.store.read(context.scope, context.current)).mcp?.[sessionId];
      },
      compareWrite: async (requested, revision, value, valid) => {
        if (requested !== key) throw Error('MCP 缓存范围不匹配。');
        const check = () => {
          context.current();
          if (!valid()) throw Error('MCP 面板已改变。');
        };
        await this.store.saveMcp(context.scope, sessionId, revision, value as McpSaved, check);
        await this.#reloadLedger({ ...context, current: check });
        return true;
      },
      compareSubmission: async () => {
        throw Error('MCP 授权只能与原指令一起保存。');
      },
      request: (path, value) => {
        if (
          path !==
          `/api/workspaces/${target.catalogWorkspaceId}/replicas/${target.replicaId}/mcp/read`
        )
          throw Error('MCP 请求不属于当前项目。');
        return this.#execute(context, this.#command(context.scope, 'mcp-read', value));
      },
    });
    await controller.load();
    return controller;
  }
  async openMcp(changed: () => void = () => {}) {
    await this.#draftWrites;
    const context = this.#context();
    let open = true;
    const controller = await this.#loadMcp(
      {
        ...context,
        current: () => {
          context.current();
          if (!open) throw Error('MCP 面板已关闭。');
        },
      },
      changed,
    );
    return {
      controller,
      close: () => {
        open = false;
        controller.dispose();
      },
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
        await this.#draftWrites;
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
        await this.#draftWrites;
        current();
        await this.store.saveDraft(
          context.scope,
          context.sessionId!,
          draft.revision,
          [draft.text, instruction].filter(Boolean).join('\n\n'),
          draft.selection,
          current,
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
    await this.#draftWrites.catch(() => {});
    current();
    const ledger = await this.store.read(scope, current);
    this.#state.ledger = ledger;
    this.#state.draft = ledger.drafts[sessionId] ?? { revision: 0, text: '', selection: {} };
    this.#draftWrites = Promise.resolve();
    this.#emit();
  }
  async #reloadLedger(context: Context) {
    this.#state.ledger = await this.store.read(context.scope, context.current);
    if (this.#state.sessionId)
      this.#state.draft = this.#state.ledger.drafts[this.#state.sessionId] ?? {
        revision: 0,
        text: '',
        selection: {},
      };
    this.#emit();
  }
  async #legacy(
    action: 'list' | 'read' | 'index',
    origin?: string,
    context = this.#context(),
    extra: { selection?: LegacyReadSelection; cursor?: LegacyIndexCursor } = {},
  ) {
    await this.#draftWrites;
    if (!this.options.legacy) throw Error('当前客户端不支持读取旧缓存。');
    context.current();
    const result = z
      .discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
        z
          .object({
            ok: z.literal(false),
            error: z
              .object({ message: z.string(), code: z.literal('index-changed').optional() })
              .strict(),
          })
          .strict(),
      ])
      .parse(
        await this.options.legacy({
          action,
          source: context.scope.source,
          target: context.scope.target,
          connectionId: context.connectionId,
          ...(origin ? { origin } : {}),
          ...extra,
        }),
      );
    context.current();
    if (!result.ok)
      throw Error(
        result.error.code === 'index-changed'
          ? '旧缓存目录已变化，请从第一页重新读取。'
          : '旧缓存暂不可读取，原分区中的数据保持不变。',
      );
    return { context, value: result.value };
  }
  async legacyOrigins() {
    return this.#legacyOrigins(this.#context());
  }
  async #legacyOrigins(context: Context) {
    return z
      .object({ origins: z.array(z.string().url()).max(256) })
      .strict()
      .parse((await this.#legacy('list', undefined, context)).value).origins;
  }
  async legacyIndex(origin: string, cursor?: LegacyIndexCursor) {
    const context = this.#context();
    const page = legacyIndexSchema.parse(
      (
        await this.#legacy(
          'index',
          origin,
          context,
          cursor ? { cursor: legacyIndexCursorSchema.parse(cursor) } : {},
        )
      ).value,
    );
    if (
      !same(page.scope, { ...context.scope, origin }) ||
      (cursor &&
        (cursor.version !== page.version || page.sessionIds.some((id) => id <= cursor.after)))
    )
      throw Error('旧缓存目录分页范围不匹配，请重新读取。');
    return page;
  }
  async readLegacy(origin: string, selection?: LegacyReadSelection) {
    return this.#readLegacy(this.#context(), origin, selection);
  }
  async #readLegacy(context: Context, origin: string, selection?: LegacyReadSelection) {
    const { value } = await this.#legacy('read', origin, context, selection ? { selection } : {});
    const recovered = legacyCacheRecoverySchema.parse(value);
    if (
      !same(recovered.scope, { ...context.scope, origin }) ||
      !same(recovered.selection ?? null, selection ?? null) ||
      recovered.sessions.some((item) => !same(item.scope, recovered.scope)) ||
      (recovered.newDraft && !same(recovered.newDraft.scope, recovered.scope))
    )
      throw Error('旧缓存身份与当前项目不匹配。');
    return recovered;
  }
  async restoreLegacy(input: LegacySessionRecovery) {
    await this.#draftWrites;
    const context = this.#context(),
      reviewed = legacySessionRecoverySchema.parse(input);
    if (!same(reviewed.scope, { ...context.scope, origin: reviewed.scope.origin }))
      throw Error('旧记录不属于当前电脑和项目。');
    // Re-read through the native authority before committing the reviewed record.
    const latest = await this.#readLegacy(context, reviewed.scope.origin, {
      kind: 'session',
      sessionId: reviewed.sessionId,
    });
    context.current();
    if (!latest.sessions.some((item) => same(item, reviewed)))
      throw Error('旧缓存已改变，请重新预览后恢复。');
    await this.store.restoreLegacy(context.scope, reviewed, context.current);
    await this.#reloadLedger(context);
    if (!this.#state.sessions.some((item) => item.id === reviewed.sessionId))
      this.#state.sessions.push(reviewed.snapshot.meta);
    this.#emit();
  }
  async restoreLegacyDraft(input: LegacyDraftRecovery) {
    await this.#draftWrites;
    const context = this.#context(),
      reviewed = legacyDraftRecoverySchema.parse(input);
    const latest = await this.#readLegacy(context, reviewed.scope.origin, { kind: 'new' });
    context.current();
    if (!latest.newDraft || !same(latest.newDraft, reviewed))
      throw Error('旧新会话草稿已改变，请重新预览。');
    const ledger = await this.store.read(context.scope, context.current);
    const mapped = reviewed.sessionId ?? ledger.legacyDraftSlots?.[reviewed.scope.origin];
    const previous = ledger.legacyDrafts?.find(
      (item) =>
        item.scope.origin === reviewed.scope.origin &&
        (mapped ? item.sessionId === mapped : matchesLegacyDraft(item, reviewed)),
    );
    const sessionId = mapped ?? previous?.sessionId ?? this.#uuid();
    await this.store.restoreLegacyDraft(context.scope, reviewed, sessionId, context.current);
    await this.#reloadLedger(context);
    return sessionId;
  }
  async openLegacyDraft(sessionId: string, selectedAgentId?: string) {
    await this.#draftWrites;
    const context = this.#context(sessionId);
    await this.store.exclusiveOperation(
      context.scope,
      'legacy-draft:' + sessionId,
      context.current,
      async () => {
        const ledger = await this.store.read(context.scope, context.current);
        const record = ledger.legacyDrafts?.find((item) => item.sessionId === sessionId);
        if (!record) throw Error('请先恢复原新会话草稿。');
        await this.#checkLegacyBeforeSend(context, sessionId);
        const originals = ledger.operations.filter(
          (item) => item.original.value.sessionId === sessionId,
        );
        if (
          originals.some((item) => item.status === 'pending' && item.original.kind === 'mutation')
        )
          throw Error('首次指令尚未确认，请先核查或明确重试原请求。');
        const sessions = sessionListSchema.parse(
          await this.#execute(
            { ...context, sessionId: undefined },
            this.#command(context.scope, 'sessions', {}),
          ),
        );
        const existing = sessions.find((item) => item.id === sessionId);
        const agentId = record.pending ? record.agentId : (selectedAgentId ?? record.agentId);
        if (existing) {
          if (
            existing.project.localProjectId !== context.scope.target.localProjectId ||
            existing.machineId !== context.scope.target.machineId ||
            existing.userId !== context.scope.target.userId ||
            (agentId && existing.agentConfigId !== agentId)
          )
            throw Error('预留会话与原项目或 Agent 不匹配。');
        } else {
          if (record.pending)
            throw Error('原首次指令未创建会话，请先核查原请求；不会另建替代会话。');
          if (record.unresolvedKeys.length) throw Error('旧草稿还有未识别记录，请先完成恢复。');
          if (!agentId || !context.project.runtime.agents.some((agent) => agent.id === agentId))
            throw Error('请为原草稿选择当前电脑已登记的 Agent；过期 Agent 不会被静默替换。');
          const prior = originals.find(
            (item) => item.original.kind === 'control' && item.original.value.action === 'create',
          );
          if (prior) {
            if (
              prior.original.kind !== 'control' ||
              prior.original.value.action !== 'create' ||
              prior.original.value.agentId !== agentId
            )
              throw Error('原创建请求使用不同 Agent，请先核查。');
            if (prior.status !== 'pending')
              throw Error('原创建请求已有结果，但会话不可读取，请核对原主机。');
            await this.retry(prior.original.value.operationId);
          } else {
            const target = context.scope.target;
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
            });
            await this.store.stage(
              context.scope,
              { kind: 'control', value },
              undefined,
              context.current,
            );
            await this.#reloadLedger(context);
            await this.retry(value.operationId);
          }
        }
      },
    );
    context.current();
    await this.refreshSessions();
    await this.openSession(sessionId);
  }
  async #checkLegacyBeforeSend(context: Context, sessionId: string) {
    if (!this.options.legacy) return;
    const origins = await this.#legacyOrigins(context);
    context.current();
    const ledger = await this.store.read(context.scope, context.current);
    for (const origin of origins) {
      const cache = await this.#readLegacy(context, origin, { kind: 'session', sessionId });
      const newCache = await this.#readLegacy(context, origin, { kind: 'new' });
      context.current();
      const newDraft = newCache.newDraft;
      const reserved =
        newDraft?.sessionId ??
        ledger.legacyDraftSlots?.[origin] ??
        (newDraft
          ? ledger.legacyDrafts?.find(
              (item) => item.scope.origin === origin && matchesLegacyDraft(item, newDraft),
            )?.sessionId
          : undefined);
      if (
        newDraft &&
        reserved === sessionId &&
        !ledger.legacyDrafts?.some(
          (item) => item.sessionId === sessionId && matchesLegacyDraft(item, newDraft),
        )
      )
        throw Error('旧新会话草稿或首次请求尚未恢复，请先核对原记录。');
      const record = cache.sessions.find((item) => item.sessionId === sessionId);
      if (
        record &&
        (record.fork ||
          record.git ||
          record.github ||
          record.githubWrite ||
          record.attention ||
          record.tasks ||
          record.roles ||
          record.roleApplied ||
          record.preview ||
          record.annotations ||
          record.mcp ||
          record.interactions ||
          record.pending ||
          record.metadata ||
          record.attachments?.items.length ||
          record.unresolvedKeys.length) &&
        !ledger.legacy?.some((item) => same(item, record))
      )
        throw Error('旧客户端还有此会话的待确认或未识别记录，请先打开“恢复旧客户端草稿”核对。');
    }
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
        const ledger = await this.store.read(context.scope, context.current);
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
  #saveInteraction(task: (controller: InteractionController) => Promise<void>) {
    const context = this.#context();
    const work = this.#draftWrites.then(() =>
      this.#withInteractions(context, (controller) => {
        if (controller.pending)
          throw Error('原交互尚未确认，当前输入未保存，请先核查或重新读取草稿。');
        return task(controller);
      }),
    );
    this.#draftWrites = work;
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
      ledger = await this.store.read(context.scope, context.current);
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
      this.store.attentionBlocked(ledger, context.sessionId!) ||
      this.store.recoveryBlocked(ledger, context.sessionId!)
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
    await this.#draftWrites;
    const context = this.#context();
    await this.#checkLegacyBeforeSend(context, context.sessionId!);
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
    await this.#draftWrites;
    const context = this.#context();
    await this.#checkLegacyBeforeSend(context, context.sessionId!);
    return this.#withInteractions(context, async (controller) => {
      const snapshot = await this.#freshInteraction(context, 'steer');
      if (snapshot.activeId !== expectedTurnId)
        throw Error('原回合已结束或改变，追加草稿不会转为新指令。');
      await controller.steer(expectedTurnId, prompt, {
        ...context.scope.target,
        sessionId: context.sessionId!,
      });
      await this.refreshSession();
    });
  }
  async retryInteraction() {
    await this.#draftWrites;
    const context = this.#context();
    return this.#withInteractions(context, async (controller) => {
      await controller.retry({ ...context.scope.target, sessionId: context.sessionId! });
      await this.refreshSession();
    });
  }
  async dismissInteraction() {
    await this.#draftWrites;
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
  async send() {
    await this.#draftWrites;
    const context = this.#context(),
      sessionId = context.sessionId;
    if (!sessionId || !this.#state.draft) throw Error('请先打开会话。');
    const draft = structuredClone(this.#state.draft);
    const mcpRevision = this.#state.ledger?.mcp?.[sessionId]?.cacheRevision ?? 0;
    const taskRevision = this.#state.ledger?.tasks?.[sessionId]?.cacheRevision ?? 0;
    const annotationRevision = this.#state.ledger?.annotations?.[sessionId]?.cacheRevision ?? 0;
    const attachments = structuredClone(
      this.#state.ledger?.attachments?.[sessionId] ?? emptyWorkspaceAttachments(),
    );
    await this.#checkLegacyBeforeSend(context, sessionId);
    await this.refreshSession();
    await this.refreshAgentOptions();
    context.current();
    const ledger = await this.store.read(context.scope, context.current);
    if (this.store.recoveryBlocked(ledger, sessionId))
      throw Error('此会话还有未识别的旧记录，请先完成恢复；原草稿保持可编辑。');
    if (
      ledger.operations.some(
        (entry) => entry.status === 'pending' && entry.original.value.sessionId === sessionId,
      )
    )
      throw Error('请先核查此会话尚未确认的原操作。');
    if (this.store.attentionBlocked(ledger, sessionId)) throw Error('请先核查原待办指令或审批。');
    if (this.store.githubBlocked(ledger, sessionId))
      throw Error('请先确认 GitHub 原操作，再发送新指令。');
    if (ledger.git?.[sessionId]?.pending) throw Error('请先确认原 Git 操作，再发送新指令。');
    if (this.store.forkBlocked(ledger, sessionId)) throw Error('请先核查原 Fork，再发送新指令。');
    const mcp = await this.#loadMcp(context);
    const mcpReview = await mcp.prepareSend();
    const annotations = await this.#loadAnnotations(context);
    const composed = annotations.compose(draft.text);
    const taskReview = ledger.tasks?.[sessionId]?.enabled;
    if (taskReview)
      await this.#reviewTasks(context, ledger.tasks![sessionId]!.draft, taskReview.parentAgentId);
    context.current();
    const value = buildSessionTurn({
      scope: { ...context.scope.target, sessionId },
      read: this.#state.session,
      agent: this.#state.session!.agent!,
      prompt: composed.prompt,
      selection: draft.selection,
      operationId: this.#uuid(),
      turnId: this.#uuid(),
      peerId: this.#uuid(),
      now: (this.options.now ?? (() => new Date().toISOString()))(),
      attachments: attachments.items.map((item) => item.reference),
      mcpServerIds: mcpReview?.servers.map((server) => server.id),
      taskPlan: taskReview?.plan,
    });
    await this.store.stage(
      context.scope,
      { kind: 'mutation', value },
      {
        sessionId,
        revision: draft.revision,
        attachmentRevision: attachments.revision,
        mcpRevision,
        taskRevision,
        annotationRevision,
      },
      context.current,
      mcpReview,
      composed.submission.selection.length ? composed.submission : undefined,
      taskReview,
    );
    await this.#reloadLedger(context);
    await this.retry(value.operationId);
  }
  async addAttachments(files: readonly File[], expectedCurrent: () => void = () => {}) {
    await this.#draftWrites;
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
    await this.#draftWrites;
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
    await this.store.stage(
      context.scope,
      { kind: 'attachment', value },
      undefined,
      context.current,
    );
    await this.#reloadLedger(context);
    await this.retry(value.operationId);
  }
  async respondPermission(review: SessionPermissionReview, outcome: SessionPermissionOutcome) {
    const context = this.#context();
    if (!context.sessionId) throw Error('请先打开会话。');
    await this.refreshSession();
    context.current();
    const value = buildSessionPermission({
      scope: { ...context.scope.target, sessionId: context.sessionId },
      read: this.#state.session,
      review,
      outcome,
      operationId: this.#uuid(),
    });
    await this.store.stage(context.scope, { kind: 'mutation', value }, undefined, context.current);
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
    await this.store.exclusiveOperation(context.scope, operationId, context.current, async () => {
      const ledger = await this.store.read(context.scope, context.current);
      const entry = ledger.operations.find(
        (item) => item.original.value.operationId === operationId,
      );
      if (!entry || entry.status !== 'pending') throw Error('此原操作无需重试，请重新读取。');
      const original = entry.original;
      if (
        original.kind === 'mutation' &&
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
    await this.#reloadLedger(context);
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
      const ledger = await this.store.read(context.scope, context.current);
      const entry = ledger.operations.find(
        (item) => item.original.value.operationId === operationId,
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
    this.#closed = true;
    this.#generation++;
    this.#listeners.clear();
    this.store.close();
  }
}
