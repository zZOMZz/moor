import type { AttachmentScope } from '../attachments/model';
import type { ExecutionLease, ExecutionRecord } from '../git/execution-model';

/** Capabilities consumed by Host session policies; no storage implementation is imported. */
export interface ExecutionPersistence {
  scopeMatches(scope: AttachmentScope): boolean;
  get(scope: AttachmentScope): ExecutionRecord | undefined;
  put(record: ExecutionRecord): void;
  removeRejected(scope: AttachmentScope, operationId: string): void;
  info(scope: AttachmentScope): {
    status: 'unknown' | 'removed' | 'ready' | 'creating' | 'removing';
    revision: number;
    mode: 'worktree' | 'shared';
    disposition?: 'removed' | 'detached' | undefined;
    branch?: string | undefined;
    executionId?: string | undefined;
    baseOid?: string | undefined;
    reason?: string | undefined;
  };
  boundSessions(scope: AttachmentScope, executionId?: string): number;
  target(executionId: string): string;
  lease(
    scope: AttachmentScope & {
      rootPath: string;
    },
  ): ExecutionLease;
}
