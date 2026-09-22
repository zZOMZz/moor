import { z } from 'zod';
import { actorSchema, attentionContextSchema } from './attention';
import { id } from './protocol';
import { runSelectionSchema } from './run-config';
import { sessionBase64Schema, sessionReadResponseSchema } from './session-responses';

export const COLLABORATION_VERSION = 3;
export const COLLABORATION_OPERATION_VERSION = 1;
export const COLLABORATION_FEATURE = 'collaboration-doc-v3';
export const COLLABORATION_LIMITS = {
  batch: 100,
  requestBytes: 16 * 1024 * 1024,
  promptCharacters: 100000,
} as const;

/** Product identities belong to the sync authority, independently of execution workspaces. */
export const collaborationScopeSchema = z
  .object({ authorityId: id, workspaceId: id, projectId: id, sessionId: id })
  .strict();
export type CollaborationScope = z.infer<typeof collaborationScopeSchema>;

/** A client instance identifies an offline writer; it is never an authorization credential. */
export const collaborationAuthorSchema = z.object({ actor: actorSchema, clientId: id }).strict();
export type CollaborationAuthor = z.infer<typeof collaborationAuthorSchema>;

/** Injected by the authenticated gateway, never accepted from an HTTP body. */
export const collaborationContextSchema = attentionContextSchema
  .extend({
    ownerActor: actorSchema,
    sessionId: id,
  })
  .strict();
export type CollaborationContext = z.infer<typeof collaborationContextSchema>;
export const collaborationReadInputSchema = z.object({}).strict();
export const collaborationMemberSchema = z
  .object({
    accountId: id,
    role: z.enum(['viewer', 'editor', 'operator']).nullable(),
  })
  .strict();

export const collaborationRoleSchema = z.enum(['viewer', 'editor', 'operator', 'owner']);
export type CollaborationRole = z.infer<typeof collaborationRoleSchema>;
export type CollaborationPermission = 'read' | 'edit' | 'submit' | 'manage';
export function collaborationAllows(role: CollaborationRole, permission: CollaborationPermission) {
  return (
    permission === 'read' ||
    (permission === 'edit' && role !== 'viewer') ||
    (permission === 'submit' && (role === 'operator' || role === 'owner')) ||
    (permission === 'manage' && role === 'owner')
  );
}

/** Frozen execution identity. Display names, paths and relay connection ids are not targets. */
export const taskExecutionTargetSchema = z
  .object({
    executionDeviceId: id,
    workspaceId: id,
    userId: z.string().min(1).max(160),
    machineId: id,
    localProjectId: id,
    sessionId: id,
    agentId: id,
  })
  .strict();
export type TaskExecutionTarget = z.infer<typeof taskExecutionTargetSchema>;
export const collaborationReadResponseSchema = z
  .object({
    scope: collaborationScopeSchema,
    target: taskExecutionTargetSchema,
    role: collaborationRoleSchema,
    enabled: z.boolean().default(true),
    session: sessionReadResponseSchema,
  })
  .strict();

export const collaborationInputSchema = z
  .object({
    prompt: z.string().max(COLLABORATION_LIMITS.promptCharacters),
    selection: runSelectionSchema,
  })
  .strict();
export type CollaborationInput = z.infer<typeof collaborationInputSchema>;

const operationBase = z.object({
  version: z.literal(COLLABORATION_OPERATION_VERSION),
  operationId: id,
  scope: collaborationScopeSchema,
  author: collaborationAuthorSchema,
  createdAt: z.number().int().nonnegative().safe(),
});

/** Explicit submission freezes a complete input. Later draft edits cannot authorize other text. */
export const taskIntentSchema = operationBase
  .extend({
    kind: z.literal('submit'),
    input: collaborationInputSchema,
    target: taskExecutionTargetSchema,
    authorization: z
      .object({
        kind: z.literal('execute'),
        // Queue continuation is explicit: execute after preceding accepted work, not on a stale head.
        ordering: z.literal('after-previous'),
        expiresAt: z.number().int().nonnegative().safe(),
      })
      .strict(),
  })
  .strict();
export type TaskIntent = z.infer<typeof taskIntentSchema>;

export const taskWithdrawalSchema = operationBase
  .extend({ kind: z.literal('withdraw'), taskId: id })
  .strict();

export const collaborationOperationSchema = z
  .discriminatedUnion('kind', [taskIntentSchema, taskWithdrawalSchema])
  .superRefine((operation, context) => {
    if (operation.author.actor.authorityId !== operation.scope.authorityId)
      context.addIssue({ code: 'custom', message: '作者与协作空间不属于同一授权服务' });
    if (operation.kind === 'submit') {
      if (!operation.input.prompt.trim())
        context.addIssue({ code: 'custom', message: '提交任务必须包含指令' });
      if (operation.authorization.expiresAt <= operation.createdAt)
        context.addIssue({ code: 'custom', message: '执行授权必须有有效截止时间' });
      if (operation.target.sessionId !== operation.scope.sessionId)
        context.addIssue({ code: 'custom', message: '执行目标与共享会话不匹配' });
    }
  });
export type CollaborationOperation = z.infer<typeof collaborationOperationSchema>;

/** Storage migration only. Never accept retired draft operations through a transport boundary. */
export function migrateCollaborationOperation(raw: unknown): CollaborationOperation | undefined {
  const legacyDraft = operationBase
    .extend({
      kind: z.literal('draft'),
      draftId: id,
      parents: z.array(id).max(100),
      input: collaborationInputSchema,
    })
    .strict();
  if (legacyDraft.safeParse(raw).success) return undefined;
  const legacyIntent = taskIntentSchema.extend({ draftId: id, draftRevisionId: id }).strict();
  const legacy = legacyIntent.safeParse(raw);
  if (legacy.success) {
    const { draftId: _draft, draftRevisionId: _revision, ...intent } = legacy.data;
    return collaborationOperationSchema.parse(intent);
  }
  return collaborationOperationSchema.parse(raw);
}

export const taskPhaseSchema = z.enum([
  'queued',
  'claimed',
  'dispatching',
  'accepted',
  'running',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'blocked',
]);
export type TaskPhase = z.infer<typeof taskPhaseSchema>;
export const taskStateSchema = z
  .object({
    taskId: id,
    scope: collaborationScopeSchema,
    phase: taskPhaseSchema,
    sequence: z.number().int().positive().safe(),
    revision: z.number().int().positive().safe(),
    updatedAt: z.number().int().nonnegative().safe(),
    reason: z.string().max(1000).optional(),
    executionOperationId: id.optional(),
    userTurnId: id.optional(),
    assistantTurnId: id.optional(),
  })
  .strict();
export type TaskState = z.infer<typeof taskStateSchema>;
export type TaskClaim = { intent: TaskIntent; state: TaskState; claimId: string };

export const collaborationSyncRequestSchema = z
  .object({
    version: z.literal(COLLABORATION_VERSION),
    scope: collaborationScopeSchema,
    after: z.number().int().nonnegative().safe(),
    documentVersion: sessionBase64Schema.refine((value) => value.length <= 65536).optional(),
    operations: z.array(collaborationOperationSchema).max(COLLABORATION_LIMITS.batch),
  })
  .strict();
export type CollaborationSyncRequest = z.infer<typeof collaborationSyncRequestSchema>;

/** Stored confirms sync persistence only; execution acceptance has a separate Host receipt. */
export const collaborationSyncResponseSchema = z
  .object({
    version: z.literal(COLLABORATION_VERSION),
    scope: collaborationScopeSchema,
    cursor: z.number().int().nonnegative().safe(),
    hasMore: z.boolean(),
    storedOperationIds: z.array(id).max(COLLABORATION_LIMITS.batch),
    document: z
      .object({
        schemaVersion: z.literal(2),
        update: sessionBase64Schema,
        version: sessionBase64Schema,
      })
      .strict(),
  })
  .strict();
export type CollaborationSyncResponse = z.infer<typeof collaborationSyncResponseSchema>;

export function collaborationKey(scope: CollaborationScope) {
  const value = collaborationScopeSchema.parse(scope);
  return JSON.stringify([value.authorityId, value.workspaceId, value.projectId, value.sessionId]);
}

export function validateCollaborationSyncResponse(
  raw: unknown,
  request: CollaborationSyncRequest,
): CollaborationSyncResponse {
  const result = collaborationSyncResponseSchema.parse(raw),
    key = collaborationKey(request.scope);
  if (
    collaborationKey(result.scope) !== key ||
    result.cursor < request.after ||
    new Set(result.storedOperationIds).size !== result.storedOperationIds.length ||
    result.storedOperationIds.length !== request.operations.length ||
    result.storedOperationIds.some(
      (id) => !request.operations.some((operation) => operation.operationId === id),
    ) ||
    (result.hasMore && result.cursor === request.after)
  )
    throw Error('协作同步响应与原范围或读取进度不匹配');
  return result;
}

/** Online acceleration offers the exact same immutable intent, including preceding submitted intents. */
export const collaborationOfferSchema = z
  .object({
    version: z.literal(COLLABORATION_VERSION),
    scope: collaborationScopeSchema,
    operationId: id,
    operations: z.array(collaborationOperationSchema).min(1).max(COLLABORATION_LIMITS.batch),
  })
  .strict();
export type CollaborationOffer = z.infer<typeof collaborationOfferSchema>;
export const collaborationOfferReceiptSchema = z
  .object({
    version: z.literal(COLLABORATION_VERSION),
    scope: collaborationScopeSchema,
    operationId: id,
    stored: z.literal(true),
  })
  .strict();
export const collaborationMethodSchema = z.enum([
  'collaboration-read',
  'collaboration-sync',
  'collaboration-enable',
  'collaboration-member',
  'collaboration-offer',
]);
