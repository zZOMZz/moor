import { z } from 'zod';
import { id } from '../protocol';
import { taskPlanSchema, taskSpecSchema, taskActionSchema } from '../task-protocol';
import { gitTargetSchema } from './git-workspace';
export const taskDraftSchema = z
  .object({
    version: z.literal(1),
    tasks: z
      .array(
        z
          .object({
            taskId: id,
            title: z.string().max(120),
            agentId: z.string().max(160),
            instruction: z.string().max(10000),
            completion: z.string().max(2000),
            selection: taskSpecSchema.shape.selection,
            baseBranch: z.string().max(300),
            expectedOid: z.string().max(64),
          })
          .strict(),
      )
      .max(8),
    maxParallel: z.number().int().min(1).max(4),
    maxTurnsPerTask: z.number().int().min(1).max(3),
    timeoutMs: z.number().int().min(1000).max(3600000),
    onParentEnd: z.literal('cancel'),
  })
  .strict();
export const taskReviewedSchema = z
  .object({ reviewId: id, parentAgentId: id, plan: taskPlanSchema })
  .strict();
export type ReviewedTasks = z.infer<typeof taskReviewedSchema>;
const deliverySchema = z
  .object({
    operationId: id,
    review: taskReviewedSchema,
    requestVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export const tasksStoredSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().nonnegative().safe(),
    target: gitTargetSchema,
    draft: taskDraftSchema,
    enabled: taskReviewedSchema.optional(),
    delivery: deliverySchema.optional(),
    pending: taskActionSchema.optional(),
  })
  .strict();
