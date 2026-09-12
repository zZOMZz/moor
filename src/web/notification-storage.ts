import { z } from 'zod';
import { id } from '../protocol';
import { notificationPreferencesSchema } from '../notification-protocol';
const owner = z
  .string()
  .min(1)
  .max(1000)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const notificationLocalSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().safe().default(0),
    binding: z.object({ owner, preferences: notificationPreferencesSchema }).strict().optional(),
    records: z
      .array(
        z
          .object({
            owner,
            id,
            endpointHash: z.string().regex(/^[a-f0-9]{64}$/),
            pendingDisable: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type NotificationLocalState = z.infer<typeof notificationLocalSchema>;
export type NotificationLocalRecord = NotificationLocalState['records'][number];
const empty = (): NotificationLocalState => ({ version: 1, revision: 0, records: [] });
export function createNotificationStorage(deps: {
  open(): IDBOpenDBRequest;
  schedule(callback: () => void): unknown;
  cancel(timer: unknown): void;
}) {
  function database() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = deps.open();
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        deps.cancel(timer);
        if (error) reject(error);
        else resolve(request.result);
      };
      const timer = deps.schedule(() => {
        finish(new Error('通知设置存储超时。'));
        try {
          request.transaction?.abort();
        } catch {
          /* Already complete. */
        }
      });
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort();
          return;
        }
        request.result.createObjectStore('private');
      };
      request.onsuccess = () => {
        if (settled) request.result.close();
        else finish();
      };
      request.onerror = () => finish(request.error ?? new Error('通知设置无法读取。'));
      request.onblocked = () => finish(new Error('通知设置暂时无法保存。'));
    });
  }
  return async (update?: (state: NotificationLocalState) => NotificationLocalState) => {
    const db = await database();
    try {
      return await new Promise<NotificationLocalState>((resolve, reject) => {
        const tx = db.transaction('private', update ? 'readwrite' : 'readonly');
        let settled = false,
          result = empty();
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          deps.cancel(timer);
          if (error) reject(error);
          else resolve(result);
        };
        const timer = deps.schedule(() => {
          finish(new Error('通知设置存储超时。'));
          try {
            tx.abort();
          } catch {
            /* Already complete. */
          }
        });
        const store = tx.objectStore('private'),
          request = store.get('state');
        request.onsuccess = () => {
          if (settled) return;
          try {
            result =
              request.result === undefined
                ? empty()
                : notificationLocalSchema.parse(request.result);
            if (update) {
              result = notificationLocalSchema.parse(update(result));
              store.put(result, 'state');
            }
          } catch (error) {
            finish(error);
            try {
              tx.abort();
            } catch {
              /* Already complete. */
            }
          }
        };
        tx.oncomplete = () => finish();
        tx.onerror = () => finish(tx.error ?? new Error('通知设置未保存。'));
        tx.onabort = () => finish(tx.error ?? new Error('通知设置未保存。'));
      });
    } finally {
      db.close();
    }
  };
}
/** Separate from session caches: pending server removals survive logout. */
export const notificationLocal = createNotificationStorage({
  open: () => indexedDB.open('moor-notifications-v1', 1),
  schedule: (callback) => setTimeout(callback, 5000),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
export async function rememberNotification(
  record: NotificationLocalRecord,
  expectedRevision?: number,
) {
  await notificationLocal((state) => {
    if (expectedRevision !== undefined && state.revision !== expectedRevision)
      throw new Error('通知设置已改变。');
    return {
      ...state,
      records: [
        ...state.records.filter((row) => row.owner !== record.owner || row.id !== record.id),
        record,
      ].slice(-100),
    };
  });
}
