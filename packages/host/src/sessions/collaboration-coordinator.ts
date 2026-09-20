import { assert } from '@moor/protocol/protocol';
import {
  COLLABORATION_VERSION,
  collaborationKey,
  collaborationOfferSchema,
  type CollaborationScope,
} from '@moor/protocol/collaboration-protocol';
import type { AttentionActor } from '@moor/protocol/attention';
import type { CollaborationStore } from '@moor/sync/store';
import { CollaborationExecutionStore } from '../persistence/collaboration-execution-store';

/** Doc notifications and RPC offers converge here; transport never owns dispatch decisions. */
export class CollaborationCoordinator {
  readonly queue: CollaborationExecutionStore;
  constructor(readonly state: CollaborationStore) {
    this.queue = new CollaborationExecutionStore(state);
  }
  reconcile(scope: CollaborationScope) {
    this.state.atomic(() => {
      const document = this.state.projection(scope),
        through = this.queue.through(scope);
      const incoming = document.operations
        .filter((op) => (document.admissions[op.operationId] ?? 0) > through)
        .sort((a, b) => document.admissions[a.operationId] - document.admissions[b.operationId]);
      for (const operation of incoming) {
        const sequence = document.admissions[operation.operationId];
        if (operation.kind === 'submit') this.queue.enqueue(operation, sequence);
        else if (operation.kind === 'withdraw') this.queue.withdraw(scope, operation.taskId);
        this.queue.reconciled(scope, sequence);
      }
    });
  }
  offer(actor: AttentionActor, scope: CollaborationScope, raw: unknown) {
    const request = collaborationOfferSchema.parse(raw);
    assert(collaborationKey(request.scope) === collaborationKey(scope), 403, 'RPC 意图范围不匹配');
    const subject = request.operations.find((op) => op.operationId === request.operationId);
    assert(
      subject && ['submit', 'withdraw'].includes(subject.kind),
      400,
      'RPC 必须指向一份明确提交的意图',
    );
    // Persist the same frozen input before reconciling. A later Doc delivery is a duplicate.
    this.state.append(actor, scope, request.operations);
    this.reconcile(scope);
    return {
      version: COLLABORATION_VERSION,
      scope,
      operationId: request.operationId,
      stored: true as const,
    };
  }
}
