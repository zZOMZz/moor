import { NotificationWorker, type WorkerClient } from '@moor/client/features/notifications/worker';
import { notificationLocal } from '../platform/browser/notification-storage';
const worker = globalThis as unknown as {
  registration?: ServiceWorkerRegistration;
  location: Location;
  clients?: {
    get(id: string): Promise<WorkerClient | undefined>;
    matchAll(options: object): Promise<WorkerClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  addEventListener(type: string, callback: (event: any) => void): void;
};
if (!worker.registration || !worker.clients) throw Error('通知 Worker 能力未由运行入口提供。');
{
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
