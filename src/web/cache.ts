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
// A single IndexedDB transaction serializes tabs sharing the same request slot.
// A late response can clear only the exact operation it originally persisted.
export async function compareAndSet(key: string, expected: unknown, value: unknown) {
  const d = await bounded(db);
  return bounded(
    new Promise<boolean>((resolve, reject) => {
      const t = d.transaction('cache', 'readwrite');
      const store = t.objectStore('cache');
      const request = store.get(key);
      let matched = false;
      request.onsuccess = () => {
        try {
          matched = JSON.stringify(request.result) === JSON.stringify(expected);
          if (matched) store.put(value, key);
        } catch {
          t.abort();
        }
      };
      t.oncomplete = () => resolve(matched);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('本地请求记录保存被中止'));
    }),
  );
}
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
