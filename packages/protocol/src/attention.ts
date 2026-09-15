import { z } from 'zod';
import { id, mutationSchema } from './protocol';

export const ATTENTION_FEATURE = 'attention-v1';
export const ACTOR_FEATURE = 'actor-context-v1';
export const FOLLOWUP_FEATURE = 'attention-followup-v1';
export const actorSchema = z
  .object({
    kind: z.enum(['local', 'relay']),
    authorityId: id,
    accountId: id,
  })
  .strict();
export type AttentionActor = z.infer<typeof actorSchema>;
export const attentionContextSchema = z
  .object({
    actor: actorSchema,
    executionDeviceId: id,
    machineId: id,
    catalogWorkspaceId: id,
    projectId: id,
    replicaId: id,
    runtimeWorkspaceId: id,
    localProjectId: id,
    sessionId: id.optional(),
  })
  .strict();
export type AttentionContext = z.infer<typeof attentionContextSchema>;
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const attentionSeenSchema = z.object({ operationId: id, eventRevision: revision }).strict();
export const attentionDispositionSchema = attentionSeenSchema
  .extend({
    observationRevision: revision,
    disposition: z.enum(['pending', 'checked', 'needs_followup']),
  })
  .strict();
export const attentionPermissionSchema = attentionSeenSchema
  .extend({
    requestId: id,
    expectedTurnId: id,
    optionId: z.string().min(1).max(200).nullable(),
  })
  .strict();
export const attentionContinueSchema = z
  .object({
    mutation: mutationSchema.refine((m) => m.kind === 'turn', '继续必须是用户回合'),
    eventRevision: revision,
    observationRevision: revision,
  })
  .strict();
export const attentionListQuerySchema = z
  .object({
    view: z.enum(['pending', 'processed']).default('pending'),
    cursor: z.string().max(2000).optional(),
    limit: z.number().int().min(1).max(50).default(50),
  })
  .strict();
export type AttentionSeen = z.infer<typeof attentionSeenSchema>;
export type AttentionDisposition = z.infer<typeof attentionDispositionSchema>;
export type AttentionPermission = z.infer<typeof attentionPermissionSchema>;
export type AttentionContinue = z.infer<typeof attentionContinueSchema>;
export type AttentionListQuery = z.infer<typeof attentionListQuerySchema>;
export type AttentionCause =
  | 'agent_returned'
  | 'execution_failed'
  | 'host_stopped'
  | 'host_restarted'
  | 'user_canceled'
  | 'unknown';
export type AttentionItem = {
  itemId: string;
  sessionId: string;
  localProjectId: string;
  assistantTurnId: string;
  userTurnId: string;
  kind: 'permission' | 'outcome';
  lifecycle: 'active' | 'resolved' | 'invalidated' | 'ended' | 'historical';
  requestId?: string;
  cause?: AttentionCause;
  eventRevision: number;
  sequence: number;
  occurredAt: number | null;
  summary: string;
  seenRevision: number;
  disposition: 'pending' | 'checked' | 'needs_followup' | 'continued';
  observationRevision: number;
  followupUserTurnId?: string;
};
export type AttentionGroup = {
  sessionId: string;
  title: string;
  isArchived: boolean;
  items: AttentionItem[];
  itemCount: number;
  nextItemsCursor?: string;
};
export type AttentionItemPage = {
  items: AttentionItem[];
  total: number;
  nextCursor?: string;
  version: number;
};
export type AttentionPage = {
  sessions: AttentionGroup[];
  total: number;
  nextCursor?: string;
  version: number;
};
export type AttentionDetail = {
  item: AttentionItem;
  title: string;
  isArchived: boolean;
  turn: unknown;
  userTurn: unknown;
  permission?: {
    requestId: string;
    expectedTurnId: string;
    options: { optionId: string; name: string; kind: string }[];
    toolCall: unknown;
  };
};
export type AttentionReceipt = {
  accepted: true;
  delivered: true;
  operationId: string;
  item?: AttentionItem;
};
export const actorKey = (actor: AttentionActor) =>
  JSON.stringify([actor.kind, actor.authorityId, actor.accountId]);
