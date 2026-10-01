import {
  notificationEnvelopeSchema,
  notificationWanted,
  type NotificationEnvelope,
} from '@moor/protocol/notification-protocol';
import type { NotificationLocalState } from './local-state';
import { z } from 'zod';
import { notificationPreferencesSchema } from '@moor/protocol/notification-protocol';
export const notificationBindingMessageSchema = z
  .object({
    type: z.literal('moor:notification-binding'),
    expectedRevision: z.number().int().nonnegative().safe(),
    owner: z.string().min(1).max(1000).optional(),
    preferences: notificationPreferencesSchema.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.owner) === Boolean(value.preferences));
export type WorkerClient = {
  id: string;
  type: string;
  url: string;
  focus?(): Promise<unknown>;
  navigate?(url: string): Promise<unknown>;
};
export type NotificationWorkerDependencies = {
  origin: string;
  now(): number;
  local(
    update?: (state: NotificationLocalState) => NotificationLocalState,
  ): Promise<NotificationLocalState>;
  identity(): Promise<{ owner?: string | null }>;
  show(title: string, options: NotificationOptions & { renotify?: boolean }): Promise<void>;
  close(): Promise<void>;
  client(id: string): Promise<WorkerClient | undefined>;
  clients(): Promise<WorkerClient[]>;
  open(url: string): Promise<unknown>;
};
export const genericNotification = {
  title: 'Moor 提醒',
  options: { body: '打开 Moor 查看当前状态。', tag: 'moor-generic', renotify: false, data: null },
};
const titles = {
  completed: 'Moor：回合已完成',
  failed: 'Moor：回合未完成',
  'approval-required': 'Moor：需要查看权限请求',
};
export function currentNotification(value: unknown, now: number): NotificationEnvelope | undefined {
  const parsed = notificationEnvelopeSchema.safeParse(value);
  if (!parsed.success || parsed.data.createdAt > now + 60000 || parsed.data.expiresAt <= now)
    return;
  return parsed.data;
}
export class NotificationWorker {
  constructor(private deps: NotificationWorkerDependencies) {}
  private async allowed(value: unknown) {
    const event = currentNotification(value, this.deps.now());
    if (!event) return;
    const state = await this.deps.local();
    if (
      state.binding?.owner !== event.owner ||
      !notificationWanted(state.binding.preferences, event)
    )
      return;
    const identity = await this.deps.identity();
    if (identity.owner !== event.owner) return;
    // A logout/disable during the identity request must invalidate this push.
    const latest = await this.deps.local();
    if (
      latest.binding?.owner !== event.owner ||
      !notificationWanted(latest.binding.preferences, event)
    )
      return;
    if (event.expiresAt <= this.deps.now()) return;
    return event;
  }
  async push(value: unknown) {
    let event: NotificationEnvelope | undefined;
    try {
      event = await this.allowed(value);
    } catch {
      /* Always display a generic fallback. */
    }
    await this.deps.show(
      event ? titles[event.kind] : genericNotification.title,
      event
        ? {
            body: '打开 Moor 重新读取当前状态。',
            tag: event.eventId,
            renotify: false,
            data: event,
          }
        : genericNotification.options,
    );
  }
  async binding(sourceId: string, value: unknown) {
    const message = notificationBindingMessageSchema.parse(value);
    const client = await this.deps.client(sourceId);
    if (!client || client.type !== 'window' || new URL(client.url).origin !== this.deps.origin)
      throw new Error('通知设置来源无效。');
    if (message.owner && (await this.deps.identity()).owner !== message.owner)
      throw new Error('登录账号已改变。');
    await this.deps.local((state) => {
      if (state.revision !== message.expectedRevision) throw new Error('通知设置已更新。');
      return {
        ...state,
        revision: state.revision + 1,
        binding: message.owner
          ? { owner: message.owner, preferences: message.preferences! }
          : undefined,
      };
    });
    if (!message.owner && !(await this.deps.local()).binding) await this.deps.close();
  }
  async click(value: unknown) {
    let event: NotificationEnvelope | undefined;
    try {
      event = await this.allowed(value);
    } catch {
      /* Open only the generic home page. */
    }
    const url = new URL('/', this.deps.origin);
    if (event) url.searchParams.set('notification', JSON.stringify(event));
    // Fixed same-origin navigation only. Never use a URL supplied in push data.
    const client = (await this.deps.clients()).find(
      (client) =>
        client.type === 'window' &&
        new URL(client.url).origin === this.deps.origin &&
        client.navigate,
    );
    if (client) {
      await client.navigate!(url.href);
      await client.focus?.();
    } else await this.deps.open(url.href);
  }
}
