import { deadline } from './deadline';
const db = new Promise<IDBDatabase>((resolve, reject) => {
  const r = indexedDB.open('moor-runtime-v1', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('cache');
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.onblocked = () => reject(new Error('本地缓存被其他页面占用，请关闭旧页面后重试。'));
});
// Opening IndexedDB may fail before boot reaches its first cache operation.
void db.catch(() => {});
const bounded = <T>(work: Promise<T>) =>
  deadline(work, 5000, '本地缓存读取或保存超时，请重新打开页面。');
export async function read<T>(key: string): Promise<T | undefined> {
  const d = await bounded(db);
  return bounded(
    new Promise<T | undefined>((resolve, reject) => {
      const r = d.transaction('cache').objectStore('cache').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }),
  );
}
export async function write(key: string, value: unknown) {
  const d = await bounded(db);
  return bounded(
    new Promise<void>((resolve, reject) => {
      const t = d.transaction('cache', 'readwrite');
      t.objectStore('cache').put(value, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('本地缓存保存被中止'));
    }),
  );
}
/** Git outboxes use an atomic revision check across pages; other caches do not. */
export function createCacheCompareWrite(deps: {
  database(): Promise<IDBDatabase>;
  schedule(callback: () => void): unknown;
  cancel(timer: unknown): void;
}) {
  return async (
    key: string,
    expectedRevision: number,
    value: { cacheRevision: number },
    current: () => boolean,
  ): Promise<boolean> => {
    const requireCurrent = () => {
      if (!current()) throw new Error('执行目标已改变，请重新打开原会话。');
    };
    requireCurrent();
    const d = await deps.database();
    requireCurrent();
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      value.cacheRevision !== expectedRevision + 1 ||
      !Number.isSafeInteger(value.cacheRevision)
    )
      throw new Error('Git 操作缓存版本无效。');
    return new Promise<boolean>((resolve, reject) => {
      const tx = d.transaction('cache', 'readwrite');
      let settled = false,
        written = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        deps.cancel(timer);
        if (error) reject(error);
        else resolve(written);
      };
      const abort = (error: unknown) => {
        finish(error);
        try {
          tx.abort();
        } catch {
          /* Already complete. */
        }
      };
      const timer = deps.schedule(() => abort(new Error('Git 操作保存超时，请重新打开原会话。')));
      const store = tx.objectStore('cache'),
        request = store.get(key);
      request.onsuccess = () => {
        if (settled) return;
        try {
          requireCurrent();
          const revision = request.result?.cacheRevision ?? 0;
          if (revision !== expectedRevision) return;
          requireCurrent();
          store.put(value, key);
          written = true;
        } catch (error) {
          abort(error);
        }
      };
      request.onerror = () => abort(request.error ?? new Error('Git 操作缓存无法读取。'));
      tx.oncomplete = () => finish();
      tx.onerror = () => abort(tx.error ?? new Error('Git 操作未保存。'));
      tx.onabort = () => finish(tx.error ?? new Error('Git 操作保存被中止。'));
    });
  };
}
export const compareWrite = createCacheCompareWrite({
  database: () => bounded(db),
  schedule: (callback) => setTimeout(callback, 5000),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
/** Preserve the existing plain-text draft format while appending reviewed content atomically. */
export function createCacheCompareText(deps: {
  database(): Promise<IDBDatabase>;
  schedule(callback: () => void): unknown;
  cancel(timer: unknown): void;
}) {
  return async (
    key: string,
    expected: string | undefined,
    value: string,
    current: () => boolean,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const requireCurrent = () => {
      if (signal?.aborted || !current()) throw new Error('草稿或执行目标已改变，请重新加入说明。');
    };
    requireCurrent();
    const database = await deps.database();
    requireCurrent();
    return new Promise<boolean>((resolve, reject) => {
      const tx = database.transaction('cache', 'readwrite');
      let settled = false,
        written = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        deps.cancel(timer);
        signal?.removeEventListener('abort', cancelled);
        if (error) reject(error);
        else resolve(written);
      };
      const abort = (error: unknown) => {
        finish(error);
        try {
          tx.abort();
        } catch {
          /* Already complete. */
        }
      };
      const cancelled = () => abort(new Error('草稿或执行目标已改变，请重新加入说明。'));
      const timer = deps.schedule(() => abort(new Error('草稿保存超时，请重新加入说明。')));
      signal?.addEventListener('abort', cancelled, { once: true });
      const store = tx.objectStore('cache'),
        request = store.get(key);
      request.onsuccess = () => {
        if (settled) return;
        try {
          requireCurrent();
          if (request.result !== expected) return;
          store.put(value, key);
          written = true;
        } catch (error) {
          abort(error);
        }
      };
      request.onerror = () => abort(request.error ?? new Error('草稿无法读取。'));
      tx.oncomplete = () => finish();
      tx.onerror = () => abort(tx.error ?? new Error('草稿未保存。'));
      tx.onabort = () => finish(tx.error ?? new Error('草稿保存被中止。'));
    });
  };
}
export const compareText = createCacheCompareText({
  database: () => bounded(db),
  schedule: (callback) => setTimeout(callback, 5000),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
export type DraftBundleEntry = { key: string; expected: unknown; value: unknown };
function sameDraftValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameDraftValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
/** Role application changes the draft, run options and frozen marker as one transaction. */
export function createCacheCompareDraftBundle(deps: {
  database(): Promise<IDBDatabase>;
  schedule(callback: () => void): unknown;
  cancel(timer: unknown): void;
  minimumEntries?: 2 | 3;
  subject?: '角色' | '任务计划';
}) {
  const subject = deps.subject ?? '角色';
  return async (
    input: readonly DraftBundleEntry[],
    current: () => boolean,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    if (
      input.length < (deps.minimumEntries ?? 3) ||
      input.length > 4 ||
      new Set(input.map((entry) => entry.key)).size !== input.length
    )
      throw new Error(`${subject}草稿保存范围无效。`);
    const entries = structuredClone(input);
    const requireCurrent = () => {
      if (signal?.aborted || !current())
        throw new Error(`草稿或执行目标已改变，请重新确认${subject}。`);
    };
    requireCurrent();
    const database = await deps.database();
    requireCurrent();
    return new Promise<boolean>((resolve, reject) => {
      const tx = database.transaction('cache', 'readwrite');
      let settled = false,
        written = false,
        remaining = entries.length;
      const values = new Map<string, unknown>();
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        deps.cancel(timer);
        signal?.removeEventListener('abort', cancelled);
        if (error) reject(error);
        else resolve(written);
      };
      const abort = (error: unknown) => {
        finish(error);
        try {
          tx.abort();
        } catch {
          /* Already complete. */
        }
      };
      const cancelled = () => abort(new Error(`草稿或执行目标已改变，请重新确认${subject}。`));
      const timer = deps.schedule(() => abort(new Error(`${subject}草稿保存超时，请重新确认。`)));
      signal?.addEventListener('abort', cancelled, { once: true });
      const store = tx.objectStore('cache');
      for (const entry of entries) {
        const request = store.get(entry.key);
        request.onsuccess = () => {
          if (settled) return;
          try {
            requireCurrent();
            values.set(entry.key, request.result);
            if (--remaining) return;
            if (entries.some((value) => !sameDraftValue(values.get(value.key), value.expected)))
              return;
            for (const value of entries) {
              requireCurrent();
              store.put(value.value, value.key);
            }
            written = true;
          } catch (error) {
            abort(error);
          }
        };
        request.onerror = () => abort(request.error ?? new Error(`${subject}草稿无法读取。`));
      }
      tx.oncomplete = () => finish();
      tx.onerror = () => abort(tx.error ?? new Error(`${subject}草稿未保存。`));
      tx.onabort = () => finish(tx.error ?? new Error(`${subject}草稿保存被中止。`));
    });
  };
}
export const compareDraftBundle = createCacheCompareDraftBundle({
  database: () => bounded(db),
  schedule: (callback) => setTimeout(callback, 5000),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
/** A task-plan submission and the original mutation outbox must commit together. */
export const compareTaskSubmission = createCacheCompareDraftBundle({
  database: () => bounded(db),
  schedule: (callback) => setTimeout(callback, 5000),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  minimumEntries: 2,
  subject: '任务计划',
});
export async function clear() {
  const d = await bounded(db);
  return bounded(
    new Promise<void>((resolve, reject) => {
      const t = d.transaction('cache', 'readwrite');
      t.objectStore('cache').clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('本地缓存清理被中止'));
    }),
  );
}
