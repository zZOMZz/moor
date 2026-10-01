import {
  matchesFreshRequestRejection,
  type FreshRequestRejection,
} from '@moor/client/operations/request-rejection';
import type { StorageBackend } from '@moor/client/operations/storage';
import { validateGitActionReceipt } from '@moor/protocol/git-protocol';
import { type GitSaved } from '../../features/git/git-workspace';
import { validateWorkspaceGit } from '../../features/git/workspace-git';
import type { WorkspaceLedgerPersistence } from './ledger';
import { conflict, same, WorkspaceScope } from './model';
import type { WorkspaceOperationsPersistence } from './operations';
/** Consumer-owned capabilities. Ledger commits remain one storage transaction. */
export interface WorkspaceGitPersistencePorts {
  ledger: Pick<WorkspaceLedgerPersistence, 'change'>;
  operations: Pick<
    WorkspaceOperationsPersistence,
    'forkBlocked' | 'githubBlocked' | 'attentionBlocked'
  >;
}
export class WorkspaceGitPersistence {
  constructor(
    readonly backend: StorageBackend,
    readonly ports: WorkspaceGitPersistencePorts,
  ) {}
  async saveGit(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: GitSaved,
    current: () => void,
    freshRejection?: FreshRequestRejection,
  ) {
    const value = validateWorkspaceGit(input, { ...scope.target, sessionId });
    return this.ports.ledger.change(scope, current, [sessionId], (state) => {
      const previous = state.git?.[sessionId];
      if (
        value.pending &&
        !previous?.pending &&
        (this.ports.operations.forkBlocked(state, sessionId) ||
          this.ports.operations.githubBlocked(state, sessionId) ||
          this.ports.operations.attentionBlocked(state, sessionId) ||
          state.operations.some(
            (item) => item.status === 'pending' && item.original.value.sessionId === sessionId,
          ) ||
          state.interactions?.[sessionId]?.value.pending ||
          state.mcp?.[sessionId]?.delivery)
      )
        throw Error('请先核查此会话原操作，再改变工作目录。');
      if (
        (previous?.cacheRevision ?? 0) !== expectedRevision ||
        value.cacheRevision !== expectedRevision + 1
      )
        throw conflict();
      if (previous?.pending) {
        if (value.pending && !same(previous.pending, value.pending)) throw conflict();
        if (
          !value.pending &&
          !matchesFreshRequestRejection(previous.pending.request, freshRejection)
        ) {
          const receipt = validateGitActionReceipt(value.receipt, previous.pending.request);
          if (receipt.phase === 'unknown') throw conflict();
        }
      }
      Object.defineProperty((state.git ??= {}), sessionId, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
}
