import { z } from 'zod';
import { id } from './protocol';
import {
  contentScopeSchema,
  contentVersionSchema,
  projectFilePathSchema,
} from './content-protocol';

export const GIT_WORKTREE_FEATURE = 'git-worktree-v1';
export const GIT_LIMITS = { branches: 200, changes: 500, issues: 20 } as const;
export const gitOidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
// Git's check-ref-format remains authoritative on the execution host.
export const gitBranchSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/u);
const issue = z.string().min(1).max(500);
const status = z.enum([' ', 'M', 'A', 'D', 'R', 'C', 'U', '?', '!', 'T']);
export const gitRepositoryStateSchema = z
  .object({
    kind: z.enum(['git', 'unavailable']),
    branch: gitBranchSchema.optional(),
    headOid: gitOidSchema.optional(),
    branches: z
      .array(z.object({ name: gitBranchSchema, oid: gitOidSchema }).strict())
      .max(GIT_LIMITS.branches),
    changes: z
      .array(
        z
          .object({
            path: projectFilePathSchema,
            previousPath: projectFilePathSchema.optional(),
            index: status,
            worktree: status,
          })
          .strict(),
      )
      .max(GIT_LIMITS.changes),
    dirty: z.boolean(),
    partial: z.boolean(),
    outsideProjectChanges: z.boolean(),
    version: contentVersionSchema,
    issues: z.array(issue).max(GIT_LIMITS.issues),
    writeSupported: z.boolean(),
  })
  .strict();
export type GitRepositoryState = z.infer<typeof gitRepositoryStateSchema>;
export const sessionExecutionSchema = z
  .object({
    mode: z.enum(['shared', 'worktree']),
    status: z.enum(['ready', 'creating', 'removing', 'removed', 'unknown']),
    revision: z.number().int().nonnegative().safe(),
    executionId: id.optional(),
    branch: gitBranchSchema.optional(),
    baseOid: gitOidSchema.optional(),
    reason: issue.optional(),
    disposition: z.enum(['removed', 'detached']).optional(),
  })
  .strict()
  .refine((value) => value.mode !== 'worktree' || Boolean(value.executionId));
export type SessionExecution = z.infer<typeof sessionExecutionSchema>;
const scope = contentScopeSchema.extend({ gitVersion: z.literal(1) });
export const gitStateReadSchema = scope.strict();
export type GitStateRead = z.infer<typeof gitStateReadSchema>;
export const gitStateResultSchema = scope
  .extend({
    confirmed: z.literal(true),
    repository: gitRepositoryStateSchema,
    execution: sessionExecutionSchema,
    canPrepare: z.boolean(),
    canRemove: z.boolean(),
    boundSessions: z.number().int().nonnegative().safe().default(1),
    canDetach: z.boolean().default(false),
  })
  .strict();
export type GitStateResult = z.input<typeof gitStateResultSchema>;
const action = scope.extend({
  operationId: id,
  expectedRevision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
});
export const gitPrepareSchema = action
  .extend({
    action: z.literal('prepare'),
    baseBranch: gitBranchSchema,
    expectedOid: gitOidSchema,
    newBranch: gitBranchSchema,
  })
  .strict();
export const gitRemoveSchema = action
  .extend({
    action: z.literal('remove'),
    executionId: id,
    expectedStateVersion: contentVersionSchema,
  })
  .strict();
export const gitDetachSchema = action
  .extend({ action: z.literal('detach'), executionId: id })
  .strict();
export const gitActionSchema = z.discriminatedUnion('action', [
  gitPrepareSchema,
  gitRemoveSchema,
  gitDetachSchema,
]);
export type GitAction = z.infer<typeof gitActionSchema>;
export type GitPrepare = z.infer<typeof gitPrepareSchema>;
export type GitRemove = z.infer<typeof gitRemoveSchema>;
export const gitActionReceiptSchema = scope
  .extend({
    operationId: id,
    phase: z.enum(['accepted', 'rejected', 'unknown']),
    confirmed: z.boolean(),
    execution: sessionExecutionSchema,
    message: issue.optional(),
  })
  .strict()
  .refine((value) => value.confirmed === (value.phase === 'accepted'), 'Git 操作确认状态不匹配');
export type GitActionReceipt = z.infer<typeof gitActionReceiptSchema>;
