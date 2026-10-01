import type { StorageBackend } from '@moor/client/operations/storage';
import {
  validateWorkspaceGithub,
  validateWorkspaceGithubWrite,
} from '../../features/github/workspace-github';
import type { WorkspaceLedgerPersistence } from './ledger';
import { conflict, same, WorkspaceScope } from './model';
import type { WorkspaceOperationsPersistence } from './operations';
/** Consumer-owned capabilities. Ledger commits remain one storage transaction. */
export interface WorkspaceGithubPersistencePorts {
  ledger: Pick<WorkspaceLedgerPersistence, 'change'>;
  operations: Pick<
    WorkspaceOperationsPersistence,
    'githubBlocked' | 'attentionBlocked' | 'forkBlocked'
  >;
}
export class WorkspaceGithubPersistence {
  constructor(
    readonly backend: StorageBackend,
    readonly ports: WorkspaceGithubPersistencePorts,
  ) {}
  async saveGithub(
    scope: WorkspaceScope,
    sessionId: string,
    kind: 'github' | 'githubWrite',
    expectedRevision: number,
    input: unknown,
    current: () => void,
  ) {
    const target = { ...scope.target, sessionId };
    const value =
      kind === 'github'
        ? validateWorkspaceGithub(input, target)
        : validateWorkspaceGithubWrite(input, target);
    return this.ports.ledger.change(scope, current, [sessionId], (state) => {
      const previous = state[kind]?.[sessionId];
      if (
        (previous?.cacheRevision ?? 0) !== expectedRevision ||
        value.cacheRevision !== expectedRevision + 1
      )
        throw conflict();
      if (
        value.pending &&
        !previous?.pending &&
        (this.ports.operations.githubBlocked(state, sessionId) ||
          this.ports.operations.attentionBlocked(state, sessionId) ||
          this.ports.operations.forkBlocked(state, sessionId) ||
          state.git?.[sessionId]?.pending ||
          state.interactions?.[sessionId]?.value.pending ||
          state.operations.some(
            (entry) => entry.status === 'pending' && entry.original.value.sessionId === sessionId,
          ))
      )
        throw Error('请先核查此会话原操作，再保存新的 GitHub 操作。');
      if (value.pending && previous?.pending) {
        const { abandon: oldAbandon, ...oldPending } =
          previous.pending as typeof previous.pending & { abandon?: true };
        const { abandon: nextAbandon, ...nextPending } = value.pending as typeof value.pending & {
          abandon?: true;
        };
        if (!same(oldPending, nextPending) || (oldAbandon && !nextAbandon)) throw conflict();
      }
      Object.defineProperty((state[kind] ??= {}), sessionId, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
}
