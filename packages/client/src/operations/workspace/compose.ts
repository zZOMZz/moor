import type { WorkspaceSource } from '@moor/protocol/workspace-client-protocol';
import { workspaceContentCache } from '../../features/files/workspace-content-cache';
import type { StorageBackend } from '../storage';
import { WorkspaceAttachmentsPersistence } from './attachments';
import { WorkspaceAttentionPersistence } from './attention';
import { WorkspaceCachePersistence } from './cache';
import { WorkspaceDraftsPersistence } from './drafts';
import { WorkspaceForkPersistence } from './fork';
import { WorkspaceGitPersistence } from './git';
import { WorkspaceGithubPersistence } from './github';
import { WorkspaceInteractionsPersistence } from './interactions';
import { WorkspaceLedgerPersistence } from './ledger';
import { WorkspaceOperationsPersistence } from './operations';
import { WorkspaceRetiredPersistence } from './retired';
export { sessionPendingOperations } from './model';
export type { WorkspaceDraft, WorkspaceLedger, WorkspaceOperation, WorkspaceScope } from './model';

export function createWorkspacePersistence(backend: StorageBackend) {
  let ledger: WorkspaceLedgerPersistence;
  let drafts: WorkspaceDraftsPersistence;
  let operations: WorkspaceOperationsPersistence;
  let interactions: WorkspaceInteractionsPersistence;
  let fork: WorkspaceForkPersistence;
  let attention: WorkspaceAttentionPersistence;
  let github: WorkspaceGithubPersistence;
  let git: WorkspaceGitPersistence;
  let retired: WorkspaceRetiredPersistence;
  let attachments: WorkspaceAttachmentsPersistence;
  let cache: WorkspaceCachePersistence;
  ledger = new WorkspaceLedgerPersistence(backend, {
    drafts: {
      get migrateDraft() {
        return drafts.migrateDraft.bind(drafts);
      },
    },
  });
  drafts = new WorkspaceDraftsPersistence(backend, {
    ledger: {
      get records() {
        return ledger.records;
      },
    },
  });
  operations = new WorkspaceOperationsPersistence(backend, {
    ledger: {
      get validateOriginal() {
        return ledger.validateOriginal.bind(ledger);
      },
      get change() {
        return ledger.change.bind(ledger);
      },
    },
  });
  interactions = new WorkspaceInteractionsPersistence(backend, {
    ledger: {
      get validateInteraction() {
        return ledger.validateInteraction.bind(ledger);
      },
      get change() {
        return ledger.change.bind(ledger);
      },
    },
    operations: {
      get forkBlocked() {
        return operations.forkBlocked.bind(operations);
      },
      get githubBlocked() {
        return operations.githubBlocked.bind(operations);
      },
      get attentionBlocked() {
        return operations.attentionBlocked.bind(operations);
      },
    },
  });
  fork = new WorkspaceForkPersistence(backend, {
    ledger: {
      get change() {
        return ledger.change.bind(ledger);
      },
    },
    operations: {
      get forkBlocked() {
        return operations.forkBlocked.bind(operations);
      },
      get githubBlocked() {
        return operations.githubBlocked.bind(operations);
      },
      get attentionBlocked() {
        return operations.attentionBlocked.bind(operations);
      },
    },
  });
  attention = new WorkspaceAttentionPersistence(backend, {
    ledger: {
      get change() {
        return ledger.change.bind(ledger);
      },
      get validateOriginal() {
        return ledger.validateOriginal.bind(ledger);
      },
    },
    operations: {
      get attentionBlocked() {
        return operations.attentionBlocked.bind(operations);
      },
      get githubBlocked() {
        return operations.githubBlocked.bind(operations);
      },
      get forkBlocked() {
        return operations.forkBlocked.bind(operations);
      },
    },
  });
  github = new WorkspaceGithubPersistence(backend, {
    ledger: {
      get change() {
        return ledger.change.bind(ledger);
      },
    },
    operations: {
      get githubBlocked() {
        return operations.githubBlocked.bind(operations);
      },
      get attentionBlocked() {
        return operations.attentionBlocked.bind(operations);
      },
      get forkBlocked() {
        return operations.forkBlocked.bind(operations);
      },
    },
  });
  git = new WorkspaceGitPersistence(backend, {
    ledger: {
      get change() {
        return ledger.change.bind(ledger);
      },
    },
    operations: {
      get forkBlocked() {
        return operations.forkBlocked.bind(operations);
      },
      get githubBlocked() {
        return operations.githubBlocked.bind(operations);
      },
      get attentionBlocked() {
        return operations.attentionBlocked.bind(operations);
      },
    },
  });
  retired = new WorkspaceRetiredPersistence(backend, {
    ledger: {
      get change() {
        return ledger.change.bind(ledger);
      },
    },
    operations: {
      get forkBlocked() {
        return operations.forkBlocked.bind(operations);
      },
      get githubBlocked() {
        return operations.githubBlocked.bind(operations);
      },
      get attentionBlocked() {
        return operations.attentionBlocked.bind(operations);
      },
    },
  });
  attachments = new WorkspaceAttachmentsPersistence(backend, {
    ledger: {
      get change() {
        return ledger.change.bind(ledger);
      },
    },
  });
  cache = new WorkspaceCachePersistence(backend, {});
  return {
    contentCache: (source: WorkspaceSource) => workspaceContentCache(source, backend),
    get records() {
      return ledger.records;
    },
    read: ledger.read.bind(ledger),
    operation: ledger.operation.bind(ledger),
    readDraft: drafts.readDraft.bind(drafts),
    saveDraft: drafts.saveDraft.bind(drafts),
    clearDraft: drafts.clearDraft.bind(drafts),
    stage: operations.stage.bind(operations),
    attentionBlocked: operations.attentionBlocked.bind(operations),
    githubBlocked: operations.githubBlocked.bind(operations),
    forkBlocked: operations.forkBlocked.bind(operations),
    saveInteraction: interactions.saveInteraction.bind(interactions),
    saveFork: fork.saveFork.bind(fork),
    saveAttention: attention.saveAttention.bind(attention),
    saveGithub: github.saveGithub.bind(github),
    saveGit: git.saveGit.bind(git),
    saveTasks: retired.saveTasks.bind(retired),
    saveRoles: retired.saveRoles.bind(retired),
    savePreview: retired.savePreview.bind(retired),
    saveAnnotations: retired.saveAnnotations.bind(retired),
    saveMcp: retired.saveMcp.bind(retired),
    saveAttachments: attachments.saveAttachments.bind(attachments),
    exclusiveOperation: operations.exclusiveOperation.bind(operations),
    finish: operations.finish.bind(operations),
    cacheSession: cache.cacheSession.bind(cache),
    loadSessionCache: cache.loadSessionCache.bind(cache),
    cacheSessionDelta: cache.cacheSessionDelta.bind(cache),
    sessionList: cache.sessionList.bind(cache),
    sessionPage: cache.sessionPage.bind(cache),
    attachmentContent: cache.attachmentContent.bind(cache),
    cachedSession: cache.cachedSession.bind(cache),
    close: cache.close.bind(cache),
  };
}
export type WorkspacePersistence = ReturnType<typeof createWorkspacePersistence>;
