import { z } from 'zod';
import { id } from './protocol';

export const NOTIFICATIONS_FEATURE = 'notifications-v1';
export const NOTIFICATION_LIMITS = {
  terminalTtl: 24 * 60 * 60 * 1000,
  approvalTtl: 30 * 60 * 1000,
  events: 1000,
  subscriptions: 20,
  payloadBytes: 3000,
} as const;
const owner = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const notificationScopeSchema = z
  .object({
    userId: owner,
    machineId: id,
    workspaceId: id,
    localProjectId: id,
    sessionId: id,
    turnId: id,
  })
  .strict();
const fields = notificationScopeSchema.extend({
  notificationVersion: z.literal(1),
  eventId: z.string().regex(/^notification_[a-f0-9]{64}$/),
  kind: z.enum(['completed', 'failed', 'approval-required']),
  requestId: id.optional(),
  createdAt: timestamp,
  expiresAt: timestamp,
});
const validEvent = (event: z.infer<typeof fields>) =>
  (event.kind === 'approval-required' ? !!event.requestId : event.requestId === undefined) &&
  event.expiresAt > event.createdAt &&
  event.expiresAt - event.createdAt <=
    (event.kind === 'approval-required'
      ? NOTIFICATION_LIMITS.approvalTtl
      : NOTIFICATION_LIMITS.terminalTtl);
export const hostNotificationEventSchema = fields
  .strict()
  .refine(validEvent, '通知类型、有效期或审批请求无效');
export type HostNotificationEvent = z.infer<typeof hostNotificationEventSchema>;
export type NotificationScope = z.infer<typeof notificationScopeSchema>;
// The relay stamps its own account/device identities. A host's local userId
// is deliberately distinct from the authenticated relay account's owner.
export const notificationEnvelopeSchema = fields
  .extend({
    owner,
    deviceId: id,
    catalogWorkspaceId: id,
    replicaId: id,
  })
  .strict()
  .refine(validEvent, '通知类型、有效期或审批请求无效');
export type NotificationEnvelope = z.infer<typeof notificationEnvelopeSchema>;
export function notificationIdentity(
  event: NotificationScope & { kind: HostNotificationEvent['kind']; requestId?: string },
) {
  return JSON.stringify([
    1,
    event.userId,
    event.machineId,
    event.workspaceId,
    event.localProjectId,
    event.sessionId,
    event.turnId,
    event.kind === 'approval-required' ? ['approval', event.requestId] : 'terminal',
  ]);
}

export const notificationPreferencesSchema = z
  .object({
    completed: z.boolean(),
    failed: z.boolean(),
    approvals: z.boolean(),
  })
  .strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  completed: true,
  failed: true,
  approvals: true,
};
export function notificationWanted(
  preferences: NotificationPreferences,
  event: Pick<HostNotificationEvent, 'kind'>,
) {
  return event.kind === 'approval-required' ? preferences.approvals : preferences[event.kind];
}
export const pushSubscriptionSchema = z
  .object({
    endpoint: z.string().url().max(2048),
    expirationTime: timestamp.nullable().optional(),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
      })
      .strict(),
  })
  .strict();
export const pushSubscriptionRequestSchema = z
  .object({
    notificationVersion: z.literal(1),
    expectedOwner: owner,
    subscription: pushSubscriptionSchema,
    preferences: notificationPreferencesSchema,
  })
  .strict();
export type MoorPushSubscription = z.infer<typeof pushSubscriptionSchema>;
