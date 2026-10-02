import type { FeatureContext } from './feature-context';
import type { HostCommand } from '@moor/protocol/host-command';
import type { WorkspaceRequest } from '@moor/protocol/workspace-client-protocol';
import type { WorkspaceClientState } from './model';
import { WorkspaceAttachmentsService } from './attachments';
import { WorkspaceAttentionService } from './attention';
import { WorkspaceCatalogService } from './catalog';
import { WorkspaceCommandsService } from './commands';
import { WorkspaceContextService } from './context';
import { WorkspaceDraftsService } from './drafts';
import { WorkspaceFilesService } from './files';
import { WorkspaceForkService } from './fork';
import { WorkspaceGitService } from './git';
import { WorkspaceGithubService } from './github';
import { WorkspaceInteractionsService } from './interactions';
import type { WorkspaceOptions } from './model';
import { WorkspaceSessionsService } from './sessions';
import { WorkspaceSkillsService } from './skills';
import { WorkspaceSyncService } from './sync';
export { isWorkspaceListOfflineFailure } from './model';
export type { WorkspaceClientState, WorkspaceSessionPage } from './model';

/** Bind only listed local capabilities. This helper is private to graph assembly;
 * business modules receive their own narrowed interfaces. */
function capabilities<T, K extends keyof T>(resolve: () => T, keys: readonly K[]): Pick<T, K> {
  const port = {} as Pick<T, K>;
  for (const key of keys)
    Object.defineProperty(port, key, {
      enumerable: true,
      get() {
        const owner = resolve(),
          value = owner[key];
        return typeof value === 'function' ? value.bind(owner) : value;
      },
      set(value: T[K]) {
        resolve()[key] = value;
      },
    });
  return port;
}

/** Assembly grants an explicit state slice and command set to each consumer. */
function contextCapabilities<
  K extends keyof WorkspaceContextService,
  F extends keyof WorkspaceClientState,
  M extends HostCommand['method'],
  A extends WorkspaceRequest['action'],
>(
  resolve: () => WorkspaceContextService,
  keys: readonly K[],
  fields: readonly F[],
  methods: readonly M[],
  actions: readonly A[],
): FeatureContext<K, F, M, A> {
  const allowedFields = new Set<PropertyKey>(fields);
  const allowedMethods = new Set<string>(methods);
  const allowedActions = new Set<string>(actions);
  const view = new Proxy({} as Pick<WorkspaceClientState, F>, {
    get: (_target, key) => (allowedFields.has(key) ? Reflect.get(resolve().value, key) : undefined),
    set(_target, key, value) {
      if (!allowedFields.has(key)) throw Error('此功能没有该状态写入能力。');
      Reflect.set(resolve().value, key, value);
      return true;
    },
    deleteProperty(_target, key) {
      if (!allowedFields.has(key)) throw Error('此功能没有该状态删除能力。');
      return Reflect.deleteProperty(resolve().value, key);
    },
    ownKeys: () => Reflect.ownKeys(resolve().value).filter((key) => allowedFields.has(key)),
    getOwnPropertyDescriptor: (_target, key) =>
      allowedFields.has(key) && Object.hasOwn(resolve().value, key)
        ? {
            configurable: true,
            enumerable: true,
            writable: true,
            value: Reflect.get(resolve().value, key),
          }
        : undefined,
  });
  const port = {};
  for (const key of keys) {
    if (key === 'value') {
      Object.defineProperty(port, key, {
        enumerable: true,
        get: () => view,
        set(value: Pick<WorkspaceClientState, F>) {
          for (const field of Reflect.ownKeys(value))
            if (!allowedFields.has(field)) throw Error('此功能没有该状态写入能力。');
          const next = { ...resolve().value };
          for (const field of fields) {
            if (Object.hasOwn(value, field)) Reflect.set(next, field, value[field]);
            else Reflect.deleteProperty(next, field);
          }
          resolve().value = next;
        },
      });
    } else if (key === 'execute' || key === 'command' || key === 'request') {
      Object.defineProperty(port, key, {
        enumerable: true,
        value:
          key === 'execute'
            ? (
                context: Parameters<WorkspaceContextService['execute']>[0],
                command: HostCommand,
              ) => {
                if (!allowedMethods.has(command.method)) throw Error('此功能没有该命令能力。');
                return resolve().execute(context, command);
              }
            : key === 'command'
              ? (
                  scope: Parameters<WorkspaceContextService['command']>[0],
                  method: HostCommand['method'],
                  params: unknown,
                ) => {
                  if (!allowedMethods.has(method)) throw Error('此功能没有该命令能力。');
                  return resolve().command(scope, method, params);
                }
              : (request: WorkspaceRequest, current: () => void) => {
                  if (!allowedActions.has(request.action)) throw Error('此功能没有该请求能力。');
                  return resolve().request(request, current);
                },
      });
    } else
      Object.defineProperty(port, key, {
        enumerable: true,
        get() {
          const owner = resolve(),
            value = owner[key];
          return typeof value === 'function' ? value.bind(owner) : value;
        },
        set(value: WorkspaceContextService[K]) {
          resolve()[key] = value;
        },
      });
  }
  return port as FeatureContext<K, F, M, A>;
}

/** The application constructs this single graph, including lifetime disposal. */
export function createWorkspace(options: WorkspaceOptions) {
  const observationIdentity = Object.freeze({});
  let context: WorkspaceContextService;
  let catalog: WorkspaceCatalogService;
  let sync: WorkspaceSyncService;
  let sessions: WorkspaceSessionsService;
  let drafts: WorkspaceDraftsService;
  let interactions: WorkspaceInteractionsService;
  let commands: WorkspaceCommandsService;
  let attachments: WorkspaceAttachmentsService;
  let fork: WorkspaceForkService;
  let attention: WorkspaceAttentionService;
  let files: WorkspaceFilesService;
  let github: WorkspaceGithubService;
  let git: WorkspaceGitService;
  let skills: WorkspaceSkillsService;
  context = new WorkspaceContextService(options);
  catalog = new WorkspaceCatalogService({
    context: contextCapabilities(
      () => context,
      [
        'value',
        'closed',
        'request',
        'generation',
        'emit',
        'current',
        'context',
        'resetSelection',
        'execute',
        'command',
      ],
      [
        'catalogs',
        'errors',
        'ledger',
        'offline',
        'project',
        'scope',
        'sessionListError',
        'sessionLoad',
        'sessionPage',
        'sessions',
        'syncDisconnected',
      ],
      ['agent-options', 'agent-usage', 'sessions-page', 'sessions'],
      ['catalog'],
    ),
    drafts: capabilities(
      () => drafts,
      ['flushDraft', 'cancelDraftSave', 'draftBuffer', 'draftInput', 'draftWrites'],
    ),
    sessions: capabilities(() => sessions, ['discardSessionCacheQueue', 'discardSessionReplica']),
    sync: capabilities(
      () => sync,
      [
        'syncAfterCatalog',
        'scheduleSync',
        'syncPending',
        'sessionSyncPending',
        'syncAfterRead',
        'sessionListReads',
        'syncAfterList',
      ],
    ),
    interactions: capabilities(() => interactions, ['interactionWrites']),
    store: capabilities(() => options.store, ['read', 'sessionPage', 'sessionList']),
  });
  sync = new WorkspaceSyncService({
    context: contextCapabilities(
      () => context,
      ['closed', 'value', 'emit', 'schedule', 'generation', 'current'],
      ['catalogs', 'scope', 'sessionId', 'sessionLoad', 'syncDisconnected'],
      [],
      [],
    ),
    sessions: capabilities(() => sessions, ['refreshSession']),
    catalog: capabilities(
      () => catalog,
      ['catalogReads', 'projectRevision', 'refreshCatalog', 'invalidateProject', 'refreshSessions'],
    ),
  });
  sessions = new WorkspaceSessionsService(
    {
      context: contextCapabilities(
        () => context,
        [
          'value',
          'context',
          'emit',
          'generation',
          'current',
          'schedule',
          'closed',
          'execute',
          'command',
        ],
        [
          'catalogs',
          'draft',
          'focusedTurnId',
          'ledger',
          'modelError',
          'modelLoading',
          'offline',
          'searchFocus',
          'sendProgress',
          'session',
          'sessionCache',
          'sessionId',
          'sessionLoad',
          'usageLoading',
        ],
        ['session', 'agent-options', 'run-preferences', 'agent-usage'],
        [],
      ),
      store: capabilities(
        () => options.store,
        ['read', 'saveDraft', 'cacheSessionDelta', 'loadSessionCache', 'readDraft'],
      ),
      drafts: capabilities(() => drafts, ['flushDraft']),
      sync: capabilities(() => sync, ['sessionSyncPending', 'syncAfterRead', 'drainSessionSync']),
    },
    {
      ...options,
      sessionReceived: () => {
        const mark = options.sessionReceived?.();
        return (
          mark &&
          ((_owner: object, sessionId: string, version: string) =>
            mark(observationIdentity, sessionId, version))
        );
      },
    },
  );
  drafts = new WorkspaceDraftsService({
    context: contextCapabilities(
      () => context,
      ['value', 'schedule', 'closed', 'current', 'emit'],
      ['catalogs', 'draft', 'ledger', 'scope', 'sessionId'],
      [],
      [],
    ),
    interactions: capabilities(() => interactions, ['interactionWrites']),
    store: capabilities(() => options.store, ['read', 'saveDraft', 'readDraft']),
    sessions: capabilities(() => sessions, ['rememberSessionDraft']),
  });
  interactions = new WorkspaceInteractionsService({
    store: capabilities(
      () => options.store,
      [
        'read',
        'saveInteraction',
        'exclusiveOperation',
        'forkBlocked',
        'githubBlocked',
        'attentionBlocked',
        'clearDraft',
      ],
    ),
    context: contextCapabilities(
      () => context,
      ['uuid', 'execute', 'command', 'context', 'value'],
      ['draft', 'ledger', 'offline', 'session', 'sessionLoad'],
      ['answer-question', 'steer'],
      [],
    ),
    drafts: capabilities(() => drafts, ['reloadLedger', 'flushDraft', 'draftInput']),
    sessions: capabilities(() => sessions, ['refreshSession']),
  });
  commands = new WorkspaceCommandsService({
    context: contextCapabilities(
      () => context,
      ['value', 'context', 'uuid', 'execute', 'command', 'emit', 'generation', 'closed'],
      ['draft', 'ledger', 'offline', 'scope', 'sendProgress', 'session', 'sessionId'],
      [
        'session',
        'tasks-action',
        'send-turn',
        'respond-permission',
        'mutate',
        'session-control',
        'session-action',
        'attachment-action',
        'session-operations',
      ],
      [],
    ),
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger', 'draftInput']),
    sessions: capabilities(
      () => sessions,
      ['refreshSession', 'refreshAgentOptions', 'exportSessionSnapshot'],
    ),
    store: capabilities(
      () => options.store,
      [
        'read',
        'operation',
        'exclusiveOperation',
        'forkBlocked',
        'githubBlocked',
        'attentionBlocked',
        'stage',
        'saveTasks',
        'finish',
      ],
    ),
    catalog: capabilities(
      () => catalog,
      ['refreshSessions', 'projectContext', 'invalidateProject'],
    ),
    sync: capabilities(() => sync, ['scheduleSync']),
    attachments: capabilities(() => attachments, ['performAttachmentAction']),
  });
  attachments = new WorkspaceAttachmentsService({
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
    context: contextCapabilities(
      () => context,
      ['context', 'value', 'uuid', 'execute', 'command'],
      ['ledger', 'offline'],
      ['read-attachment'],
      [],
    ),
    store: capabilities(() => options.store, ['stage', 'saveAttachments', 'attachmentContent']),
    commands: capabilities(() => commands, ['deliverOperation']),
  });
  fork = new WorkspaceForkService({
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
    context: contextCapabilities(
      () => context,
      ['context', 'uuid', 'value', 'execute', 'command'],
      ['offline', 'project'],
      ['fork-options', 'fork-action', 'fork-operations', 'git-state'],
      [],
    ),
    store: capabilities(() => options.store, ['read', 'exclusiveOperation', 'saveFork']),
    catalog: capabilities(() => catalog, ['refreshSessions']),
  });
  attention = new WorkspaceAttentionService(
    {
      drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
      context: contextCapabilities(
        () => context,
        ['context', 'value', 'request', 'uuid', 'execute', 'command'],
        ['catalogs', 'errors', 'offline', 'scope', 'sessionId'],
        ['session', 'agent-options'],
        ['attention'],
      ),
      store: capabilities(
        () => options.store,
        [
          'read',
          'readDraft',
          'exclusiveOperation',
          'forkBlocked',
          'githubBlocked',
          'attentionBlocked',
          'saveAttention',
        ],
      ),
      sessions: capabilities(() => sessions, ['refreshSession', 'openSession']),
      catalog: capabilities(() => catalog, ['refreshSessions', 'selectProject']),
    },
    options,
  );
  files = new WorkspaceFilesService({
    store: capabilities(() => options.store, ['contentCache', 'cachedSession']),
    context: contextCapabilities(
      () => context,
      ['context', 'value', 'execute', 'command', 'emit', 'contextRevision'],
      ['offline', 'project', 'scope', 'searchFocus', 'session', 'sessions'],
      [
        'search-sessions',
        'read-project-tree',
        'read-turn-diff',
        'read-diff-file',
        'read-attachment',
        'file-content',
      ],
      [],
    ),
    drafts: capabilities(() => drafts, ['flushDraft']),
    sessions: capabilities(() => sessions, ['openSession']),
  });
  github = new WorkspaceGithubService({
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
    context: contextCapabilities(
      () => context,
      ['context', 'contextRevision', 'value', 'uuid', 'execute', 'command'],
      ['catalogs', 'draft', 'offline', 'project', 'session'],
      [
        'github-read',
        'github-action',
        'github-abandon',
        'github-write-read',
        'github-write-action',
        'github-write-inspect',
        'github-write-abandon',
      ],
      [],
    ),
    store: capabilities(
      () => options.store,
      [
        'read',
        'saveDraft',
        'exclusiveOperation',
        'forkBlocked',
        'githubBlocked',
        'attentionBlocked',
        'saveGithub',
      ],
    ),
  });
  git = new WorkspaceGitService({
    context: contextCapabilities(
      () => context,
      ['context', 'execute', 'command', 'value', 'uuid'],
      ['offline', 'project', 'sessionId'],
      ['git-state', 'git-action', 'git-operations'],
      [],
    ),
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
    store: capabilities(
      () => options.store,
      ['read', 'exclusiveOperation', 'forkBlocked', 'githubBlocked', 'attentionBlocked', 'saveGit'],
    ),
    sessions: capabilities(() => sessions, ['refreshSession']),
  });
  skills = new WorkspaceSkillsService({
    context: contextCapabilities(
      () => context,
      ['context', 'value', 'execute', 'command'],
      ['catalogs', 'draft', 'offline', 'project', 'session'],
      ['skills-read'],
      [],
    ),
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
    store: capabilities(() => options.store, ['saveDraft']),
  });

  const workspace = {
    view: {
      identity: observationIdentity,
      get state() {
        return context.state;
      },
      subscribe: context.subscribe.bind(context),
      get contextRevision() {
        return context.contextRevision;
      },
    },
    catalog: {
      get navigationRevision() {
        return catalog.navigationRevision;
      },
      projectRevision: catalog.projectRevision.bind(catalog),
      refreshCatalog: catalog.refreshCatalog.bind(catalog),
      disconnectSource: catalog.disconnectSource.bind(catalog),
      selectProject: catalog.selectProject.bind(catalog),
      refreshSessions: catalog.refreshSessions.bind(catalog),
      listProjectSessions: catalog.listProjectSessions.bind(catalog),
      refreshProjectSessions: catalog.refreshProjectSessions.bind(catalog),
      listProjectSessionPage: catalog.listProjectSessionPage.bind(catalog),
    },
    sync: {
      scheduleSync: sync.scheduleSync.bind(sync),
      synchronize: sync.synchronize.bind(sync),
    },
    git: {
      readGitContext: git.readGitContext.bind(git),
      openGit: git.openGit.bind(git),
    },
    sessions: {
      openSession: sessions.openSession.bind(sessions),
      refreshSession: sessions.refreshSession.bind(sessions),
      refreshAgentOptions: sessions.refreshAgentOptions.bind(sessions),
      saveApprovalDefault: sessions.saveApprovalDefault.bind(sessions),
      saveRunDefaults: sessions.saveRunDefaults.bind(sessions),
      readUsage: sessions.readUsage.bind(sessions),
      createSession: commands.createSession.bind(commands),
      send: commands.send.bind(commands),
      respondPermission: commands.respondPermission.bind(commands),
      stop: commands.stop.bind(commands),
    },
    drafts: {
      queueDraft: drafts.queueDraft.bind(drafts),
      flushDraft: drafts.flushDraft.bind(drafts),
      saveDraft: drafts.saveDraft.bind(drafts),
      reloadDraft: drafts.reloadDraft.bind(drafts),
    },
    fork: {
      openFork: fork.openFork.bind(fork),
    },
    attention: {
      openAttention: attention.openAttention.bind(attention),
    },
    metadata: {
      metadata: commands.metadata.bind(commands),
      projectMetadata: commands.projectMetadata.bind(commands),
    },
    files: {
      openSearch: files.openSearch.bind(files),
      openProjectContent: files.openProjectContent.bind(files),
    },
    github: {
      openGithub: github.openGithub.bind(github),
    },
    skills: {
      openSkills: skills.openSkills.bind(skills),
    },
    interactions: {
      saveQuestionDraft: interactions.saveQuestionDraft.bind(interactions),
      saveSteerDraft: interactions.saveSteerDraft.bind(interactions),
      answerQuestion: interactions.answerQuestion.bind(interactions),
      steer: interactions.steer.bind(interactions),
      steerDraft: interactions.steerDraft.bind(interactions),
      retryInteraction: interactions.retryInteraction.bind(interactions),
      dismissInteraction: interactions.dismissInteraction.bind(interactions),
    },
    operations: {
      recoverRetiredTask: commands.recoverRetiredTask.bind(commands),
      retry: commands.retry.bind(commands),
      inspect: commands.inspect.bind(commands),
      abandon: commands.abandon.bind(commands),
    },
    attachments: {
      addAttachments: attachments.addAttachments.bind(attachments),
      readAttachment: attachments.readAttachment.bind(attachments),
      uploadAttachment: attachments.uploadAttachment.bind(attachments),
      removeAttachment: attachments.removeAttachment.bind(attachments),
    },
    lifecycle: {
      close: () => {
        sync.dispose();
        drafts.dispose();
        context.dispose();
        sessions.dispose();
        catalog.dispose();
        options.store.close();
      },
    },
  };
  return workspace;
}
export type WorkspaceGraph = ReturnType<typeof createWorkspace>;
