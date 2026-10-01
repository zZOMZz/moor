import { type SessionExecution } from '@moor/protocol/git-protocol';
import type { AttachmentScope } from '../attachments/model';
import { type GitRepository, type ManagedWorktree, type WorktreePlan } from './model';
export type ExecutionRecord = {
  scope: AttachmentScope;
  execution: SessionExecution;
  repository: GitRepository;
  plan: WorktreePlan;
  managed?: ManagedWorktree;
  operationId: string;
  /** Explicit false proves the guarded writer has never dispatched; absent is legacy unknown. */
  dispatched?: boolean;
};
export type ExecutionLease = AttachmentScope & {
  rootPath: string;
  projectRoot: string;
  executionId: string;
  executionRevision: number;
};
