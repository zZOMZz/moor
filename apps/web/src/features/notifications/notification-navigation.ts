import {
  hostNotificationEventSchema,
  notificationEnvelopeSchema,
  type HostNotificationEvent,
  type NotificationEnvelope,
} from '@moor/protocol/notification-protocol';
export function parseNotificationNavigation(
  raw: string,
  owner: string,
  localOnly: boolean,
  now: number,
) {
  if (new TextEncoder().encode(raw).byteLength > 3000)
    throw new Error('通知内容无效，请从会话列表查看当前状态。');
  const value: unknown = JSON.parse(raw);
  const remote = notificationEnvelopeSchema.safeParse(value);
  let event: HostNotificationEvent | NotificationEnvelope;
  if (remote.success) {
    if (remote.data.owner !== owner)
      throw new Error('此通知属于其他账号，请从当前账号的会话列表查看。');
    event = remote.data;
  } else {
    if (!localOnly) throw new Error('通知来源无效，请从会话列表查看。');
    event = hostNotificationEventSchema.parse(value);
  }
  if (event.createdAt > now + 60000 || event.expiresAt <= now)
    throw new Error('此通知已过期，请从会话列表重新查看当前状态。');
  return event;
}
