const db = new Promise<IDBDatabase>((resolve, reject) => {
  const r = indexedDB.open('lody-personal', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('cache');
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
export async function read<T>(key: string): Promise<T | undefined> {
  const d = await db;
  return new Promise((resolve, reject) => {
    const r = d.transaction('cache').objectStore('cache').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function write(key: string, value: unknown) {
  const d = await db;
  return new Promise<void>((resolve, reject) => {
    const t = d.transaction('cache', 'readwrite');
    t.objectStore('cache').put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
export async function clear() {
  const d = await db;
  return new Promise<void>((resolve, reject) => {
    const t = d.transaction('cache', 'readwrite');
    t.objectStore('cache').clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
