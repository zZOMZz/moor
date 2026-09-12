import { z } from 'zod';
import { id } from './protocol';
import { contentScopeSchema, contentVersionSchema } from './content-protocol';
import {
  gitBranchSchema,
  gitOidSchema,
  gitRepositoryStateSchema,
  sessionExecutionSchema,
} from './git-protocol';

export const SESSION_FORK_FEATURE = 'session-fork-v1';
export const FORK_LIMITS = { turns: 200, message: 1000 } as const;
const reason = z.string().min(1).max(FORK_LIMITS.message);
export const forkCutoffSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current') }).strict(),
  z.object({ kind: z.literal('turn'), turnId: id }).strict(),
]);
export type ForkCutoff = z.infer<typeof forkCutoffSchema>;
export const forkDirectorySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('same-directory') }).strict(),
  z
    .object({
      kind: z.literal('worktree'),
      baseBranch: gitBranchSchema,
      expectedOid: gitOidSchema,
      newBranch: gitBranchSchema,
    })
    .strict(),
]);
export type ForkDirectory = z.infer<typeof forkDirectorySchema>;
export const forkCapabilitiesSchema = z
  .object({
    sameDirectory: z.boolean(),
    worktree: z.boolean(),
    turnCutoff: z.boolean(),
    sameDirectoryReason: reason.optional(),
    worktreeReason: reason.optional(),
    turnCutoffReason: reason.optional(),
  })
  .strict();
export type ForkCapabilities = z.infer<typeof forkCapabilitiesSchema>;
const scope = contentScopeSchema.extend({ forkVersion: z.literal(1) });
export const forkOptionsReadSchema = scope.extend({ turnId: id.optional() }).strict();
export type ForkOptionsRead = z.infer<typeof forkOptionsReadSchema>;
export const forkOriginSchema = z
  .object({
    version: z.literal(1),
    sourceSessionId: id,
    sourceVersion: contentVersionSchema,
    sourceTitle: z.string().max(200),
    cutoff: forkCutoffSchema,
    directory: z.enum(['same-directory', 'worktree']),
    baseOid: gitOidSchema.optional(),
    branch: gitBranchSchema.optional(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ForkOrigin = z.infer<typeof forkOriginSchema>;
export const forkOptionsResultSchema = scope
  .extend({
    confirmed: z.literal(true),
    sourceVersion: contentVersionSchema,
    execution: sessionExecutionSchema,
    agent: z.object({ id, name: z.string().max(200), agentType: z.string().max(200) }).strict(),
    capabilities: forkCapabilitiesSchema,
    currentAvailable: z.boolean(),
    currentReason: reason.optional(),
    turns: z
      .array(
        z
          .object({
            turnId: id,
            ordinal: z.number().int().positive().safe(),
            timestamp: z.string().max(100),
            available: z.boolean(),
            reason: reason.optional(),
          })
          .strict(),
      )
      .max(FORK_LIMITS.turns),
    partial: z.boolean(),
    repository: gitRepositoryStateSchema.optional(),
  })
  .strict();
export type ForkOptionsResult = z.infer<typeof forkOptionsResultSchema>;
export const sessionForkSchema = scope
  .extend({
    operationId: id,
    childSessionId: id.regex(/^[A-Za-z0-9_-]+$/),
    expectedSourceVersion: contentVersionSchema,
    expectedExecutionRevision: z.number().int().nonnegative().safe(),
    cutoff: forkCutoffSchema,
    directory: forkDirectorySchema,
  })
  .strict()
  .refine((value) => value.childSessionId !== value.sessionId, 'Fork 必须创建另一份会话');
export type SessionFork = z.infer<typeof sessionForkSchema>;
export const forkReceiptSchema = scope
  .extend({
    operationId: id,
    childSessionId: id,
    phase: z.enum(['accepted', 'rejected', 'unknown']),
    confirmed: z.boolean(),
    origin: forkOriginSchema.optional(),
    execution: sessionExecutionSchema.optional(),
    message: reason.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.confirmed !== (value.phase === 'accepted'))
      ctx.addIssue({ code: 'custom', message: 'Fork 确认状态不匹配' });
    if (value.phase === 'accepted' && (!value.origin || value.execution?.status !== 'ready'))
      ctx.addIssue({ code: 'custom', message: 'Fork 尚未确认来源与执行目录' });
  });
export type ForkReceipt = z.infer<typeof forkReceiptSchema>;
