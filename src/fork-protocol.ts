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
export const SECURE_FORK_OPERATIONS_FEATURE = 'secure-fork-operations-v1';
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
    phase: z.enum(['accepted', 'rejected', 'unknown', 'abandoned']),
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

export const forkOperationSchema = z
  .object({ action: z.enum(['inspect', 'abandon']), request: sessionForkSchema })
  .strict();
export type ForkOperation = z.infer<typeof forkOperationSchema>;
const operationResult = scope.extend({
  action: z.enum(['inspect', 'abandon']),
  operationId: id,
  requestVersion: contentVersionSchema,
  confirmed: z.literal(true),
});
export const forkOperationResultSchema = z.discriminatedUnion('found', [
  operationResult.extend({ found: z.literal(false) }).strict(),
  operationResult.extend({ found: z.literal(true), receipt: forkReceiptSchema }).strict(),
]);
export type ForkOperationResult = z.infer<typeof forkOperationResultSchema>;
export async function forkRequestVersion(input: SessionFork): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(sessionForkSchema.parse(input))),
  );
  return (
    'sha256:' + Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
  );
}
export function validateForkActionReceipt(raw: unknown, input: SessionFork): ForkReceipt {
  const result = forkReceiptSchema.parse(raw);
  if (
    result.workspaceId !== input.workspaceId ||
    result.localProjectId !== input.localProjectId ||
    result.sessionId !== input.sessionId ||
    result.operationId !== input.operationId ||
    result.childSessionId !== input.childSessionId ||
    (result.origin &&
      (result.origin.sourceSessionId !== input.sessionId ||
        result.origin.sourceVersion !== input.expectedSourceVersion ||
        JSON.stringify(result.origin.cutoff) !== JSON.stringify(input.cutoff) ||
        result.origin.directory !== input.directory.kind)) ||
    (input.directory.kind === 'worktree' &&
      result.execution?.mode === 'worktree' &&
      (result.execution.revision !== 1 ||
        result.execution.branch !== input.directory.newBranch ||
        result.execution.baseOid !== input.directory.expectedOid)) ||
    (result.phase === 'accepted' &&
      (input.directory.kind === 'worktree'
        ? result.execution?.mode !== 'worktree' ||
          result.execution.revision !== 1 ||
          result.execution.branch !== input.directory.newBranch ||
          result.execution.baseOid !== input.directory.expectedOid ||
          result.origin?.branch !== input.directory.newBranch ||
          result.origin?.baseOid !== input.directory.expectedOid
        : result.execution?.revision !== input.expectedExecutionRevision ||
          result.execution.mode !==
            (input.expectedExecutionRevision === 0 ? 'shared' : 'worktree')))
  )
    throw Error('Fork 原操作回执不匹配');
  return result;
}
export async function validateForkOperationResult(raw: unknown, input: ForkOperation) {
  const operation = forkOperationSchema.parse(input),
    result = forkOperationResultSchema.parse(raw),
    original = operation.request;
  if (
    result.action !== operation.action ||
    result.workspaceId !== original.workspaceId ||
    result.localProjectId !== original.localProjectId ||
    result.sessionId !== original.sessionId ||
    result.operationId !== original.operationId ||
    result.requestVersion !== (await forkRequestVersion(original)) ||
    (operation.action === 'abandon' && !result.found)
  )
    throw Error('Fork 原操作核查不匹配');
  if (result.found) validateForkActionReceipt(result.receipt, original);
  return result;
}
