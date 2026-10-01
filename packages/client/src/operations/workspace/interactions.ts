import type { StorageBackend } from '@moor/client/operations/storage';
import { type InteractionSaved } from '../../features/interactions/interactions';
import type { WorkspaceLedgerPersistence } from './ledger';
import { conflict, WorkspaceScope } from './model';
import type { WorkspaceOperationsPersistence } from './operations';
/** Consumer-owned capabilities. Ledger commits remain one storage transaction. */
export interface WorkspaceInteractionsPersistencePorts {
  ledger: Pick<WorkspaceLedgerPersistence, 'validateInteraction' | 'change'>;
  operations: Pick<
    WorkspaceOperationsPersistence,
    'forkBlocked' | 'githubBlocked' | 'attentionBlocked'
  >;
}
export class WorkspaceInteractionsPersistence {
  constructor(
    readonly backend: StorageBackend,
    readonly ports: WorkspaceInteractionsPersistencePorts,
  ) {}
  async saveInteraction(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: InteractionSaved,
    current: () => void,
  ) {
    const value = this.ports.ledger.validateInteraction(scope, sessionId, input);
    return this.ports.ledger.change(scope, current, [sessionId], (state) => {
      if ((state.interactions?.[sessionId]?.revision ?? 0) !== expectedRevision) throw conflict();
      if (
        value.pending &&
        !state.interactions?.[sessionId]?.value.pending &&
        (this.ports.operations.forkBlocked(state, sessionId) ||
          this.ports.operations.githubBlocked(state, sessionId) ||
          this.ports.operations.attentionBlocked(state, sessionId) ||
          state.git?.[sessionId]?.pending ||
          state.operations.some(
            (item) => item.status === 'pending' && item.original.value.sessionId === sessionId,
          ))
      )
        throw Error('请先核查此会话原操作，再提交交互。');
      const document = { revision: expectedRevision + 1, value };
      Object.defineProperty((state.interactions ??= {}), sessionId, {
        value: document,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return structuredClone(document);
    });
  }
}
