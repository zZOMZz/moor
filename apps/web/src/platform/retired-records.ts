export type RetiredRecord = { key: string; value: unknown };
export type RetiredRecordExport = {
  format: 'moor-retired-secure-v1' | 'moor-retired-web-v1';
  records: RetiredRecord[];
};
const MAX_BYTES = 96 * 1024 * 1024;
export async function readLegacyWebRecord<T>(key: string): Promise<T | undefined> {
  if (
    typeof indexedDB.databases === 'function' &&
    !(await indexedDB.databases()).some((database) => database.name === 'moor-runtime-v1')
  )
    return undefined;
  const database = await new Promise<IDBDatabase | null>((resolve, reject) => {
    let absent = false;
    const request = indexedDB.open('moor-runtime-v1');
    request.onupgradeneeded = () => {
      absent = true;
      request.transaction?.abort();
    };
    request.onerror = () => (absent ? resolve(null) : reject(request.error));
    request.onsuccess = () => resolve(request.result);
    request.onblocked = () => reject(Error('旧网页记录正在使用中。'));
  });
  if (!database) return undefined;
  try {
    if (!database.objectStoreNames.contains('cache')) return undefined;
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = database.transaction('cache', 'readonly');
      const request = transaction.objectStore('cache').get(key);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

/** Explicit local inspection only. Opening a missing database aborts its creation. */
async function readRetiredRecords(
  DATABASE: 'moor-secure-workspace-v1' | 'moor-runtime-v1',
  STORE: 'state' | 'cache',
): Promise<RetiredRecord[]> {
  if (
    typeof indexedDB.databases === 'function' &&
    !(await indexedDB.databases()).some((database) => database.name === DATABASE)
  )
    return [];
  const database = await new Promise<IDBDatabase | null>((resolve, reject) => {
    let absent = false;
    const request = indexedDB.open(DATABASE);
    request.onupgradeneeded = () => {
      absent = true;
      request.transaction?.abort();
    };
    request.onerror = () =>
      absent ? resolve(null) : reject(Error('历史记录无法读取，原数据保持不变。'));
    request.onblocked = () => reject(Error('历史记录正由另一页面使用，请关闭旧页面后重试。'));
    request.onsuccess = () => resolve(request.result);
  });
  if (!database) return [];
  try {
    if (!database.objectStoreNames.contains(STORE)) throw Error('历史记录格式不可识别。');
    return await new Promise<RetiredRecord[]>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readonly');
      const request = transaction.objectStore(STORE).openCursor();
      const records: RetiredRecord[] = [];
      let bytes = 0,
        failure: unknown;
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor) return;
          if (typeof cursor.key !== 'string') throw Error('历史记录键格式不可识别。');
          const record = { key: cursor.key, value: cursor.value as unknown };
          bytes += new TextEncoder().encode(JSON.stringify(record)).byteLength;
          if (records.length >= 10000 || bytes > MAX_BYTES)
            throw Error('历史记录超过一次读取预算；原数据未改变，请保留本机数据目录。');
          records.push(record);
          cursor.continue();
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(records);
      transaction.onerror = transaction.onabort = () =>
        reject(failure ?? Error('历史记录读取失败，原数据未改变。'));
    });
  } finally {
    database.close();
  }
}
export const readRetiredSecureRecords = () =>
  readRetiredRecords('moor-secure-workspace-v1', 'state');
export const readRetiredWebRecords = () => readRetiredRecords('moor-runtime-v1', 'cache');
export async function exportRetiredRecords(
  records: RetiredRecord[],
  format: RetiredRecordExport['format'] = 'moor-retired-secure-v1',
) {
  const value: RetiredRecordExport = { format, records };
  const bridge = (
    window as unknown as {
      moorWorkspace?: {
        exportRetiredData?: (value: RetiredRecordExport) => Promise<{ canceled: boolean }>;
      };
    }
  ).moorWorkspace;
  if (bridge?.exportRetiredData) return bridge.exportRetiredData(value);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = format + '.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { canceled: false };
}
