import type { StorageBackend } from '@moor/client/operations/storage';
import { workspaceProjectTargetSchema } from '@moor/protocol/workspace-client-protocol';
import {
  emptyWorkspaceAttachments,
  validateWorkspaceAttachments,
  type WorkspaceAttachmentDraft,
} from '../../features/attachments/workspace-attachments';
import type { WorkspaceLedgerPersistence } from './ledger';
import { conflict, same, WorkspaceScope } from './model';
/** Consumer-owned capabilities. Ledger commits remain one storage transaction. */
export interface WorkspaceAttachmentsPersistencePorts {
  ledger: Pick<WorkspaceLedgerPersistence, 'change'>;
}
export class WorkspaceAttachmentsPersistence {
  constructor(
    readonly backend: StorageBackend,
    readonly ports: WorkspaceAttachmentsPersistencePorts,
  ) {}
  async saveAttachments(
    scope: WorkspaceScope,
    sessionId: string,
    expectedRevision: number,
    input: WorkspaceAttachmentDraft['items'],
    current: () => void,
  ) {
    workspaceProjectTargetSchema.parse({ ...scope.target, sessionId });
    const next = await validateWorkspaceAttachments(
      { revision: expectedRevision + 1, items: input },
      { ...scope.target, sessionId },
      current,
    );
    return this.ports.ledger.change(scope, current, [sessionId], (state) => {
      const before = state.attachments?.[sessionId] ?? emptyWorkspaceAttachments();
      if (before.revision !== expectedRevision) throw conflict();
      for (const item of before.items)
        if (item.pending && !next.items.some((other) => same(item, other)))
          throw Error('待确认附件必须先核查原操作。');
      for (const item of next.items) {
        const previous = before.items.find(
          (other) => other.reference.attachmentId === item.reference.attachmentId,
        );
        if (previous ? !same(previous, item) : item.uploaded || item.pending) throw conflict();
      }
      for (const item of before.items)
        if (
          item.uploaded &&
          !next.items.some((other) => other.reference.attachmentId === item.reference.attachmentId)
        )
          throw Error('移除已上传附件需要主机确认。');
      Object.defineProperty((state.attachments ??= {}), sessionId, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return structuredClone(next);
    });
  }
}
