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

/** The application constructs this single graph, including lifetime disposal. */
export function createWorkspace(options: WorkspaceOptions) {
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
    context: capabilities(
      () => context,
      [
        'value',
        'closed',
        'request',
        'generation',
        'emit',
        'current',
        'context',
        'execute',
        'command',
      ],
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
    store: options.store,
  });
  sync = new WorkspaceSyncService({
    context: capabilities(
      () => context,
      ['closed', 'value', 'emit', 'schedule', 'generation', 'current'],
    ),
    sessions: capabilities(() => sessions, ['refreshSession']),
    catalog: capabilities(
      () => catalog,
      ['catalogReads', 'projectRevision', 'refreshCatalog', 'invalidateProject', 'refreshSessions'],
    ),
  });
  sessions = new WorkspaceSessionsService(
    {
      context: capabilities(
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
      ),
      store: options.store,
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
            mark(workspace, sessionId, version))
        );
      },
    },
  );
  drafts = new WorkspaceDraftsService({
    context: capabilities(() => context, ['value', 'schedule', 'closed', 'current', 'emit']),
    interactions: capabilities(() => interactions, ['interactionWrites']),
    store: options.store,
    sessions: capabilities(() => sessions, ['rememberSessionDraft']),
  });
  interactions = new WorkspaceInteractionsService({
    store: options.store,
    context: capabilities(() => context, ['uuid', 'execute', 'command', 'context', 'value']),
    drafts: capabilities(() => drafts, ['reloadLedger', 'flushDraft', 'draftInput']),
    sessions: capabilities(() => sessions, ['refreshSession']),
  });
  commands = new WorkspaceCommandsService({
    context: capabilities(
      () => context,
      ['value', 'context', 'uuid', 'execute', 'command', 'emit', 'generation', 'closed'],
    ),
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger', 'draftInput']),
    sessions: capabilities(
      () => sessions,
      ['refreshSession', 'refreshAgentOptions', 'exportSessionSnapshot'],
    ),
    store: options.store,
    catalog: capabilities(
      () => catalog,
      ['refreshSessions', 'projectContext', 'invalidateProject'],
    ),
    sync: capabilities(() => sync, ['scheduleSync']),
    attachments: capabilities(() => attachments, ['performAttachmentAction']),
  });
  attachments = new WorkspaceAttachmentsService({
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
    context: capabilities(() => context, ['context', 'value', 'uuid', 'execute', 'command']),
    store: options.store,
    commands: capabilities(() => commands, ['deliverOperation']),
  });
  fork = new WorkspaceForkService({
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
    context: capabilities(() => context, ['context', 'uuid', 'value', 'execute', 'command']),
    store: options.store,
    catalog: capabilities(() => catalog, ['refreshSessions']),
  });
  attention = new WorkspaceAttentionService(
    {
      drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
      context: capabilities(
        () => context,
        ['context', 'value', 'request', 'uuid', 'execute', 'command'],
      ),
      store: options.store,
      sessions: capabilities(() => sessions, ['refreshSession', 'openSession']),
      catalog: capabilities(() => catalog, ['refreshSessions', 'selectProject']),
    },
    options,
  );
  files = new WorkspaceFilesService({
    store: options.store,
    context: capabilities(
      () => context,
      ['context', 'value', 'execute', 'command', 'emit', 'contextRevision'],
    ),
    drafts: capabilities(() => drafts, ['flushDraft']),
    sessions: capabilities(() => sessions, ['openSession']),
  });
  github = new WorkspaceGithubService({
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
    context: capabilities(
      () => context,
      ['context', 'contextRevision', 'value', 'uuid', 'execute', 'command'],
    ),
    store: options.store,
  });
  git = new WorkspaceGitService({
    context: capabilities(() => context, ['context', 'execute', 'command', 'value', 'uuid']),
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
    store: options.store,
    sessions: capabilities(() => sessions, ['refreshSession']),
  });
  skills = new WorkspaceSkillsService({
    context: capabilities(() => context, ['context', 'value', 'execute', 'command']),
    drafts: capabilities(() => drafts, ['flushDraft', 'reloadLedger']),
    store: options.store,
  });

  const workspace = {
    store: options.store,
    get state() {
      return context.state;
    },
    subscribe: context.subscribe.bind(context),
    get navigationRevision() {
      return catalog.navigationRevision;
    },
    projectRevision: catalog.projectRevision.bind(catalog),
    scheduleSync: sync.scheduleSync.bind(sync),
    synchronize: sync.synchronize.bind(sync),
    get contextRevision() {
      return context.contextRevision;
    },
    refreshCatalog: catalog.refreshCatalog.bind(catalog),
    disconnectSource: catalog.disconnectSource.bind(catalog),
    selectProject: catalog.selectProject.bind(catalog),
    refreshSessions: catalog.refreshSessions.bind(catalog),
    listProjectSessions: catalog.listProjectSessions.bind(catalog),
    refreshProjectSessions: catalog.refreshProjectSessions.bind(catalog),
    listProjectSessionPage: catalog.listProjectSessionPage.bind(catalog),
    readGitContext: git.readGitContext.bind(git),
    openSession: sessions.openSession.bind(sessions),
    refreshSession: sessions.refreshSession.bind(sessions),
    refreshAgentOptions: sessions.refreshAgentOptions.bind(sessions),
    saveApprovalDefault: sessions.saveApprovalDefault.bind(sessions),
    saveRunDefaults: sessions.saveRunDefaults.bind(sessions),
    readUsage: sessions.readUsage.bind(sessions),
    queueDraft: drafts.queueDraft.bind(drafts),
    flushDraft: drafts.flushDraft.bind(drafts),
    saveDraft: drafts.saveDraft.bind(drafts),
    openFork: fork.openFork.bind(fork),
    openAttention: attention.openAttention.bind(attention),
    metadata: commands.metadata.bind(commands),
    projectMetadata: commands.projectMetadata.bind(commands),
    openSearch: files.openSearch.bind(files),
    openProjectContent: files.openProjectContent.bind(files),
    openGithub: github.openGithub.bind(github),
    openGit: git.openGit.bind(git),
    openSkills: skills.openSkills.bind(skills),
    reloadDraft: drafts.reloadDraft.bind(drafts),
    createSession: commands.createSession.bind(commands),
    saveQuestionDraft: interactions.saveQuestionDraft.bind(interactions),
    saveSteerDraft: interactions.saveSteerDraft.bind(interactions),
    answerQuestion: interactions.answerQuestion.bind(interactions),
    steer: interactions.steer.bind(interactions),
    steerDraft: interactions.steerDraft.bind(interactions),
    retryInteraction: interactions.retryInteraction.bind(interactions),
    dismissInteraction: interactions.dismissInteraction.bind(interactions),
    recoverRetiredTask: commands.recoverRetiredTask.bind(commands),
    send: commands.send.bind(commands),
    addAttachments: attachments.addAttachments.bind(attachments),
    readAttachment: attachments.readAttachment.bind(attachments),
    uploadAttachment: attachments.uploadAttachment.bind(attachments),
    removeAttachment: attachments.removeAttachment.bind(attachments),
    respondPermission: commands.respondPermission.bind(commands),
    stop: commands.stop.bind(commands),
    retry: commands.retry.bind(commands),
    inspect: commands.inspect.bind(commands),
    abandon: commands.abandon.bind(commands),
    close: () => {
      sync.dispose();
      drafts.dispose();
      context.dispose();
      sessions.dispose();
      catalog.dispose();
      options.store.close();
    },
  };
  return workspace;
}
export type Workspace = ReturnType<typeof createWorkspace>;
