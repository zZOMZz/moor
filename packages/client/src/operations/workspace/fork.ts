import type { StorageBackend } from '@moor/client/operations/storage';
import { type ForkSaved } from '../../features/fork/session-fork';
import { validateWorkspaceFork, workspaceForkPending } from '../../features/fork/workspace-fork';
import type { WorkspaceLedgerPersistence } from './ledger';
import { conflict, same, WorkspaceScope } from './model';
import type { WorkspaceOperationsPersistence } from './operations';
/** Consumer-owned capabilities. Ledger commits remain one storage transaction. */
export interface WorkspaceForkPersistencePorts {
  ledger: Pick<WorkspaceLedgerPersistence, 'change'>;
  operations: Pick<
    WorkspaceOperationsPersistence,
    'forkBlocked' | 'githubBlocked' | 'attentionBlocked'
  >;
}
export class WorkspaceForkPersistence {
  constructor(
    readonly backend: StorageBackend,
    readonly ports: WorkspaceForkPersistencePorts,
  ) {}
  async saveFork(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: ForkSaved,
    current: () => void,
  ) {
    const value = validateWorkspaceFork(input, { ...scope.target, sessionId });
    return this.ports.ledger.change(
      scope,
      current,
      [
        sessionId,
        ...(workspaceForkPending(value)
          ? [workspaceForkPending(value)!.request.childSessionId]
          : []),
      ],
      (state) => {
        const previous = state.forks?.[sessionId],
          pending = workspaceForkPending(value),
          old = workspaceForkPending(previous);
        if (
          (previous?.cacheRevision ?? 0) !== expectedRevision ||
          value.cacheRevision !== expectedRevision + 1
        )
          throw conflict();
        if (old && !same(old, value.operation ?? null)) throw conflict();
        if (
          pending &&
          !old &&
          (this.ports.operations.forkBlocked(state, sessionId) ||
            this.ports.operations.githubBlocked(state, sessionId) ||
            this.ports.operations.attentionBlocked(state, sessionId) ||
            this.ports.operations.forkBlocked(state, pending.request.childSessionId) ||
            state.git?.[sessionId]?.pending ||
            state.operations.some(
              (item) =>
                item.status === 'pending' &&
                [sessionId, pending.request.childSessionId].includes(item.original.value.sessionId),
            ) ||
            state.interactions?.[sessionId]?.value.pending ||
            state.mcp?.[sessionId]?.delivery)
        )
          throw Error('请先核查原会话操作，再创建副本。');
        Object.defineProperty((state.forks ??= {}), sessionId, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      },
    );
  }
}
