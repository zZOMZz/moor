import { z } from 'zod';
import type { AttentionItem, AttentionGroup, AttentionPage, AttentionDetail } from './attention';

const revision = z.number().int().nonnegative();
export const attentionItemSchema: z.ZodType<AttentionItem> = z.object({
  itemId: z.string(),
  sessionId: z.string(),
  localProjectId: z.string(),
  assistantTurnId: z.string(),
  userTurnId: z.string(),
  kind: z.enum(['permission', 'outcome']),
  lifecycle: z.enum(['active', 'resolved', 'invalidated', 'ended', 'historical']),
  requestId: z.string().optional(),
  cause: z
    .enum([
      'agent_returned',
      'execution_failed',
      'host_stopped',
      'host_restarted',
      'user_canceled',
      'unknown',
    ])
    .optional(),
  eventRevision: revision,
  sequence: revision,
  occurredAt: z.number().nullable(),
  summary: z.string().max(10000),
  seenRevision: revision,
  disposition: z.enum(['pending', 'checked', 'needs_followup', 'continued']),
  observationRevision: revision,
  followupUserTurnId: z.string().optional(),
});
const attentionGroupSchema: z.ZodType<AttentionGroup> = z.object({
  sessionId: z.string(),
  title: z.string(),
  isArchived: z.boolean(),
  items: z.array(attentionItemSchema).max(50),
  itemCount: revision,
  nextItemsCursor: z.string().optional(),
});
export const attentionPageSchema: z.ZodType<AttentionPage> = z.object({
  sessions: z.array(attentionGroupSchema).max(50),
  total: revision,
  nextCursor: z.string().optional(),
  version: revision,
});
export const attentionDetailSchema: z.ZodType<AttentionDetail> = z.object({
  item: attentionItemSchema,
  title: z.string(),
  isArchived: z.boolean(),
  turn: z.unknown(),
  userTurn: z.unknown(),
  permission: z
    .object({
      requestId: z.string(),
      expectedTurnId: z.string(),
      options: z.array(z.object({ optionId: z.string(), name: z.string(), kind: z.string() })),
      toolCall: z.unknown(),
    })
    .optional(),
}) as z.ZodType<AttentionDetail>;

export const attentionItemsPageSchema = z.object({
  items: z.array(attentionItemSchema).max(50),
  total: revision,
  nextCursor: z.string().optional(),
  version: revision,
});
