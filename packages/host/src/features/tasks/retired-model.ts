import { id } from '@moor/protocol/protocol';
import { taskAuthoritySchema, taskPlanSchema } from '@moor/protocol/task-protocol';
import { z } from 'zod';
export const scopeSchema = z
  .object({ workspaceId: id, userId: z.string(), machineId: id, localProjectId: id, sessionId: id })
  .strict();
export const slotSchema = z
  .object({
    taskId: id,
    childSessionId: id,
    branch: z.string(),
    status: z.enum(['reserved', 'preparing', 'ready', 'running', 'terminal', 'unknown']),
    turnCount: z.number().int().nonnegative(),
    latestUserTurnId: id.optional(),
    latestAssistantTurnId: id.optional(),
    lastOperationId: id.optional(),
  })
  .strict();
export const grantSchema = z
  .object({
    id,
    scope: scopeSchema,
    authority: taskAuthoritySchema,
    parentUserTurnId: id,
    parentAssistantTurnId: id,
    plan: taskPlanSchema,
    createdAt: z.number(),
    expiresAt: z.number(),
    status: z.enum(['active', 'expired', 'interrupted', 'canceled']),
  })
  .strict();
export const requestSchema = z
  .object({
    grantId: id,
    taskId: id,
    operationId: id,
    action: z.enum(['create', 'send', 'cancel', 'cleanup']),
  })
  .passthrough();
export const operationSchema = z
  .object({
    request: requestSchema,
    phase: z.enum(['pending', 'accepted', 'rejected', 'unknown', 'abandoned']),
    nested: z.object({}).passthrough(),
    reason: z.string().optional(),
    userTurnId: id.optional(),
    assistantTurnId: id.optional(),
    previousUserTurnId: id.optional(),
    previousAssistantTurnId: id.optional(),
  })
  .strict();
export type Grant = z.infer<typeof grantSchema> & { slots: z.infer<typeof slotSchema>[] };
export type RetiredTaskOperation = import('zod').infer<typeof operationSchema>;
