import { productCanonicalJson } from '@moor/protocol/canonical-json';
const canonical = (value: unknown) => productCanonicalJson(value ?? null);
const CONFLICT = '本机原操作或草稿已在另一页面改变，请重新读取后继续。';

export type StorageBackend = {
  read(key: string): Promise<unknown>;
  exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T>;
  compareAndSet(key: string, expected: unknown, value: unknown, current: () => void): Promise<void>;
  /** Comparisons, writes and explicit deletions commit together, or none do. */
  compareAndSetMany?(changes: StorageChange[], current: () => void): Promise<void>;
  close?(): void;
};
export type StorageChange =
  | { key: string; expected: unknown; value: unknown; delete?: never }
  | { key: string; expected: unknown; delete: true; value?: never };
/** Separate from legacy HTTP caches; no migration or automatic dispatch is performed. */
export class IndexedStorage implements StorageBackend {
  #database?: Promise<IDBDatabase>;
  #closed = false;
  #lifetime = new AbortController();
  constructor(
    private readonly options: {
      locks?: Pick<LockManager, 'request'> | null;
      deadline?: (milliseconds: number) => AbortSignal;
      databaseName: 'moor-desktop-workspace-v1' | 'moor-collaboration-v1';
    },
  ) {}
  async exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T> {
    current();
    if (this.#closed) throw Error('本机存储已关闭。');
    const locks =
      this.options.locks !== undefined ? this.options.locks : globalThis.navigator?.locks;
    if (!locks || typeof locks.request !== 'function')
      throw Error('当前桌面环境无法协调本机原操作，尚未发送或封存。');
    const signal = AbortSignal.any([
      this.#lifetime.signal,
      (this.options.deadline ?? ((milliseconds) => AbortSignal.timeout(milliseconds)))(30000),
    ]);
    return locks.request(key, { mode: 'exclusive', signal }, async (lock) => {
      if (!lock || this.#closed) throw Error('本机存储已关闭。');
      current();
      // The lock remains held until the actual request settles. A deadline only bounds waiting;
      // releasing a granted lock early could let a sealing request overtake an in-flight send.
      return await task();
    });
  }
  #open() {
    if (this.#closed) throw Error('本机存储已关闭。');
    return (this.#database ??= new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = indexedDB.open(this.options.databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => {
        settled = true;
        reject(Error('无法打开工作区的本机存储。'));
      };
      request.onblocked = () => {
        settled = true;
        reject(Error('本机存储更新受另一页面阻挡，请关闭旧页面。'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (this.#closed || settled) {
          db.close();
          reject(Error('本机存储已关闭。'));
          return;
        }
        settled = true;
        db.onversionchange = () => {
          db.close();
          this.#closed = true;
        };
        resolve(db);
      };
    }));
  }
  async read(key: string): Promise<unknown> {
    const db = await this.#open();
    if (this.#closed) throw Error('本机存储已关闭。');
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('state', 'readonly');
      const request = transaction.objectStore('state').get(key);
      let value: unknown;
      request.onsuccess = () => {
        value = request.result ?? null;
      };
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = transaction.onabort = () => reject(Error('无法读取本机原操作。'));
    });
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    return this.compareAndSetMany([{ key, expected, value }], current);
  }
  async compareAndSetMany(changes: StorageChange[], current: () => void) {
    if (new Set(changes.map(({ key }) => key)).size !== changes.length)
      throw Error('本机事务包含重复记录。');
    if (
      changes.some(
        (change) =>
          'delete' in change && (change.delete !== true || Object.hasOwn(change, 'value')),
      )
    )
      throw Error('本机删除事务必须明确删除且不能携带写入值。');
    const snapshots = changes.map((change) => ({
      key: change.key,
      original: canonical(change.expected),
      ...(change.delete === true
        ? { delete: true as const }
        : { delete: false as const, value: structuredClone(change.value) }),
    }));
    const db = await this.#open();
    current();
    if (this.#closed) throw Error('本机存储已关闭。');
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('state', 'readwrite', { durability: 'strict' });
      const store = transaction.objectStore('state');
      let failure: unknown;
      const abort = (error: unknown) => {
        failure = error;
        transaction.abort();
      };
      let remaining = snapshots.length;
      const writeAll = () => {
        try {
          current();
          for (const snapshot of snapshots) {
            const write = snapshot.delete
              ? store.delete(snapshot.key)
              : store.put(snapshot.value, snapshot.key);
            write.onsuccess = () => {
              try {
                current();
              } catch (error) {
                abort(error);
              }
            };
          }
        } catch (error) {
          abort(error);
        }
      };
      for (const snapshot of snapshots) {
        const request = store.get(snapshot.key);
        request.onsuccess = () => {
          try {
            current();
            if (canonical(request.result) !== snapshot.original) throw Error(CONFLICT);
            if (--remaining === 0) writeAll();
          } catch (error) {
            abort(error);
          }
        };
      }
      transaction.oncomplete = () => {
        try {
          current();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      transaction.onerror = transaction.onabort = () =>
        reject(failure ?? Error('无法持久保存原操作，尚未发送。'));
    });
  }
  close() {
    this.#closed = true;
    this.#lifetime.abort();
    void this.#database?.then(
      (db) => db.close(),
      () => {},
    );
  }
}
