import {
  notificationEnvelopeSchema,
  notificationWanted,
  type NotificationEnvelope,
} from '../notification-protocol';
import { notificationLocal, type NotificationLocalState } from './notification-storage';
import { z } from 'zod';
import { notificationPreferencesSchema } from '../notification-protocol';
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
// This module is also imported by deterministic tests; installation is worker-only.
const worker = globalThis as unknown as {
  document?: unknown;
  registration?: ServiceWorkerRegistration;
  location: Location;
  clients?: {
    get(id: string): Promise<WorkerClient | undefined>;
    matchAll(options: object): Promise<WorkerClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  addEventListener(type: string, callback: (event: any) => void): void;
};
if (!worker.document && worker.registration && worker.clients) {
  const registration = worker.registration,
    clients = worker.clients;
  const handler = new NotificationWorker({
    origin: worker.location.origin,
    now: Date.now,
    local: notificationLocal,
    identity: async () => {
      const response = await fetch('/api/me', {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('身份不可用');
      return response.json();
    },
    show: (title, options) => registration.showNotification(title, options),
    close: async () => {
      for (const item of await registration.getNotifications()) item.close();
    },
    client: (id) => clients.get(id),
    clients: () => clients.matchAll({ type: 'window', includeUncontrolled: true }),
    open: (url) => clients.openWindow(url),
  });
  worker.addEventListener('push', (event) => {
    let value: unknown;
    try {
      const text = event.data?.text();
      if (text && new TextEncoder().encode(text).byteLength <= 3000) value = JSON.parse(text);
    } catch {
      /* Generic reminder. */
    }
    event.waitUntil(handler.push(value));
  });
  worker.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(handler.click(event.notification.data));
  });
  worker.addEventListener('message', (event) => {
    if (event.data?.type !== 'moor:notification-binding' || !event.ports?.[0]) return;
    event.waitUntil(
      handler.binding(event.source?.id ?? '', event.data).then(
        () => event.ports[0].postMessage({ ok: true }),
        () => event.ports[0].postMessage({ ok: false }),
      ),
    );
  });
}
