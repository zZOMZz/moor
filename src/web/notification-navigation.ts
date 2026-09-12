import {
  hostNotificationEventSchema,
  notificationEnvelopeSchema,
  type HostNotificationEvent,
  type NotificationEnvelope,
} from '../notification-protocol';
import type { Workspace } from '../catalog';
import type { Device } from './navigation';
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
/** Product routes are mutable. Resolve the event's immutable execution identity. */
export function resolveNotificationNavigation(
  event: HostNotificationEvent | NotificationEnvelope,
  devices: Device[],
  catalog: Workspace[],
) {
  const matches = catalog.flatMap((space) =>
    space.hosts.flatMap((host) => {
      if ('deviceId' in event && host.deviceId !== event.deviceId) return [];
      const device = devices.find((device) => device.id === host.deviceId);
      const runtime = device?.workspaces.find(
        (runtime) =>
          runtime.id === event.workspaceId &&
          runtime.machineId === event.machineId &&
          runtime.userId === event.userId,
      );
      if (
        !runtime ||
        host.machineId !== event.machineId ||
        host.runtimeWorkspaceId !== event.workspaceId
      )
        return [];
      return space.replicas
        .filter(
          (replica) =>
            replica.hostId === host.id &&
            replica.localProjectId === event.localProjectId &&
            space.projects.some((project) => project.id === replica.projectId),
        )
        .map((replica) => ({ space, host, replica }));
    }),
  );
  if (matches.length !== 1)
    throw new Error('此通知的执行目标已移除或映射不唯一，请从会话列表重新选择。');
  return matches[0]!;
}
