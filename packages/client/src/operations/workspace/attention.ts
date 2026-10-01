import type { StorageBackend } from '@moor/client/operations/storage';
import {
  attentionScopeKey,
  pendingAttentionSchema,
  type AttentionRoute,
} from '../../features/attention/attention';
import {
  validateWorkspaceAttentionBucket,
  validateWorkspaceAttentionEntry,
  workspaceAttentionKey,
} from '../../features/attention/workspace-attention';
import type { WorkspaceLedgerPersistence } from './ledger';
import { conflict, same, WorkspaceScope } from './model';
import type { WorkspaceOperationsPersistence } from './operations';
/** Consumer-owned capabilities. Ledger commits remain one storage transaction. */
export interface WorkspaceAttentionPersistencePorts {
  ledger: Pick<WorkspaceLedgerPersistence, 'change' | 'validateOriginal'>;
  operations: Pick<
    WorkspaceOperationsPersistence,
    'attentionBlocked' | 'githubBlocked' | 'forkBlocked'
  >;
}
export class WorkspaceAttentionPersistence {
  constructor(
    readonly backend: StorageBackend,
    readonly ports: WorkspaceAttentionPersistencePorts,
  ) {}
  async saveAttention(
    scope: WorkspaceScope,
    route: AttentionRoute,
    key: string,
    input: unknown,
    current: () => void,
    compare?: { expected: unknown },
  ) {
    const value = validateWorkspaceAttentionEntry(route, key, input);
    const bucketKey = attentionScopeKey(route),
      kind = workspaceAttentionKey(route, key);
    validateWorkspaceAttentionBucket({ route, entries: {} }, scope.target);
    return this.ports.ledger.change(
      scope,
      current,
      kind.kind === 'page' ? [] : [kind.sessionId],
      (state) => {
        const bucket = state.attention?.[bucketKey] ?? { route, entries: {} };
        if (!same(bucket.route, route)) throw conflict();
        const previous = bucket.entries[key];
        if (compare && !same(previous ?? null, compare.expected ?? null)) return false;
        if (kind.kind === 'pending' && value !== undefined) {
          const pending = pendingAttentionSchema.parse(value);
          if (previous && !same(previous, value)) throw conflict();
          if (!previous && ['continue', 'permission'].includes(pending.operation.kind)) {
            const sessionId = pending.sessionId;
            if (
              this.ports.operations.attentionBlocked(state, sessionId) ||
              this.ports.operations.githubBlocked(state, sessionId) ||
              this.ports.operations.forkBlocked(state, sessionId) ||
              state.git?.[sessionId]?.pending ||
              state.interactions?.[sessionId]?.value.pending ||
              state.tasks?.[sessionId]?.pending ||
              state.mcp?.[sessionId]?.delivery ||
              state.operations.some(
                (entry) =>
                  entry.status === 'pending' && entry.original.value.sessionId === sessionId,
              )
            )
              throw Error('请先核查原会话操作，再发送待办指令或审批。');
          }
          if (pending.operation.kind === 'continue')
            this.ports.ledger.validateOriginal(
              scope,
              'turn' in pending.operation.body
                ? { kind: 'send-turn', value: pending.operation.body.turn }
                : { kind: 'mutation', value: pending.operation.body.mutation },
            );
        }
        const entries = { ...bucket.entries };
        if (value === undefined) delete entries[key];
        else
          Object.defineProperty(entries, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        Object.defineProperty((state.attention ??= {}), bucketKey, {
          value: { route, entries },
          enumerable: true,
          writable: true,
          configurable: true,
        });
        return true;
      },
    );
  }
}
