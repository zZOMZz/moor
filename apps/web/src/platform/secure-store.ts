import { z } from 'zod';
import {
  secureOperationSchema,
  secureTargetSchema,
  secureOperationDigestSource,
  type SecureCliOperation,
  type SecureCliTarget,
} from '@moor/client/secure-operation';
import { productCanonicalJson } from '@moor/client/encrypted-product';

export type SecureAuthority = Pick<
  SecureCliTarget,
  'origin' | 'owner' | 'rootKeyId' | 'clientDeviceId'
>;
export type SecureStorageBackend = {
  read(key: string): Promise<unknown>;
  exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T>;
  compareAndSet(key: string, expected: unknown, value: unknown, current: () => void): Promise<void>;
  close?(): void;
};
const authoritySchema = secureTargetSchema
  .pick({
    origin: true,
    owner: true,
    rootKeyId: true,
    clientDeviceId: true,
  })
  .strip();
const ledgerSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    operations: z.array(secureOperationSchema).max(512),
  })
  .strict();
const LIMIT_BYTES = 96 * 1024 * 1024;
const CONFLICT = '本机原操作或草稿已在另一页面改变，请重新读取后继续。';
const canonical = (value: unknown) => productCanonicalJson(value ?? null);
const authorityKey = (authority: SecureAuthority) =>
  canonical(['moor-secure-operations-v1', authoritySchema.parse(authority)]);
const matches = (target: SecureCliTarget, authority: SecureAuthority) =>
  canonical(authoritySchema.parse(target)) === canonical(authoritySchema.parse(authority));
const operationLockKey = (operation: SecureCliOperation) =>
  canonical([
    'moor-secure-operation-lock-v1',
    authoritySchema.parse(operation.target),
    operation.operationId,
  ]);
const draftKey = (target: SecureCliTarget) =>
  canonical(['moor-secure-draft-v1', secureTargetSchema.parse(target)]);
const runtimeKey = (target: SecureCliTarget) => {
  const { product: _product, ...runtime } = target;
  return canonical(runtime);
};
export async function secureBrowserRequestVersion(
  value: Pick<SecureCliOperation, 'body' | 'target' | 'mcpReview' | 'previewReview' | 'userTurnId'>,
) {
  const source = secureOperationDigestSource(value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return (
    'sha256:' +
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

/** Separate from legacy HTTP caches; no migration or automatic dispatch is performed. */
export class IndexedSecureStorage implements SecureStorageBackend {
  #database?: Promise<IDBDatabase>;
  #closed = false;
  #lifetime = new AbortController();
  constructor(
    private readonly options: {
      locks?: Pick<LockManager, 'request'> | null;
      deadline?: (milliseconds: number) => AbortSignal;
      databaseName?: 'moor-secure-workspace-v1' | 'moor-desktop-workspace-v1';
    } = {},
  ) {}
  async exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T> {
    current();
    if (this.#closed) throw Error('加密本机存储已关闭。');
    const locks =
      this.options.locks !== undefined ? this.options.locks : globalThis.navigator?.locks;
    if (!locks || typeof locks.request !== 'function')
      throw Error('当前桌面环境无法协调本机原操作，尚未发送或封存。');
    const signal = AbortSignal.any([
      this.#lifetime.signal,
      (this.options.deadline ?? ((milliseconds) => AbortSignal.timeout(milliseconds)))(30000),
    ]);
    return locks.request(key, { mode: 'exclusive', signal }, async (lock) => {
      if (!lock || this.#closed) throw Error('加密本机存储已关闭。');
      current();
      // The lock remains held until the actual request settles. A deadline only bounds waiting;
      // releasing a granted lock early could let a sealing request overtake an in-flight send.
      return await task();
    });
  }
  #open() {
    if (this.#closed) throw Error('加密本机存储已关闭。');
    return (this.#database ??= new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = indexedDB.open(this.options.databaseName ?? 'moor-secure-workspace-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => {
        settled = true;
        reject(Error('无法打开加密工作区的本机存储。'));
      };
      request.onblocked = () => {
        settled = true;
        reject(Error('本机存储更新受另一页面阻挡，请关闭旧页面。'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (this.#closed || settled) {
          db.close();
          reject(Error('加密本机存储已关闭。'));
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
    if (this.#closed) throw Error('加密本机存储已关闭。');
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
    const snapshot = structuredClone(value),
      original = canonical(expected);
    const db = await this.#open();
    current();
    if (this.#closed) throw Error('加密本机存储已关闭。');
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('state', 'readwrite', { durability: 'strict' });
      const store = transaction.objectStore('state');
      let failure: unknown;
      const abort = (error: unknown) => {
        failure = error;
        transaction.abort();
      };
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          current();
          if (canonical(request.result) !== original) throw Error(CONFLICT);
          const write = store.put(snapshot, key);
          write.onsuccess = () => {
            try {
              current();
            } catch (error) {
              abort(error);
            }
          };
        } catch (error) {
          abort(error);
        }
      };
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

export class SecureStore {
  constructor(readonly backend: SecureStorageBackend = new IndexedSecureStorage()) {}
  async #load(authority: SecureAuthority) {
    const key = authorityKey(authority),
      raw = await this.backend.read(key);
    const ledger = raw == null ? { revision: 0, operations: [] } : ledgerSchema.parse(raw);
    if (new TextEncoder().encode(canonical(ledger)).byteLength > LIMIT_BYTES)
      throw Error('本机原操作存储超出限制。');
    const ids = new Set<string>();
    for (const operation of ledger.operations) {
      if (
        !matches(operation.target, authority) ||
        !operation.target.product ||
        ids.has(operation.operationId) ||
        operation.requestVersion !== (await secureBrowserRequestVersion(operation))
      )
        throw Error('本机原操作校验失败，未重发任何请求。');
      ids.add(operation.operationId);
    }
    return { key, raw: raw ?? null, ledger };
  }
  async list(authority: SecureAuthority) {
    const { ledger } = await this.#load(authority);
    return structuredClone(ledger.operations).reverse();
  }
  async stage(
    input: Omit<SecureCliOperation, 'state' | 'createdAt' | 'requestVersion'>,
    now: string,
    current: () => void,
  ) {
    const snapshot = structuredClone(input);
    const operation = secureOperationSchema.parse({
      ...snapshot,
      state: 'pending',
      createdAt: now,
      requestVersion: await secureBrowserRequestVersion(snapshot),
    });
    if (!operation.target.product) throw Error('加密桌面原操作必须固定产品副本。');
    current();
    const loaded = await this.#load(operation.target);
    current();
    const prior = loaded.ledger.operations.find(
      (entry) => entry.operationId === operation.operationId,
    );
    if (prior) {
      if (
        prior.requestVersion !== operation.requestVersion ||
        prior.kind !== operation.kind ||
        prior.body !== operation.body ||
        canonical(prior.target) !== canonical(operation.target)
      )
        throw Error(CONFLICT);
      return prior;
    }
    if (
      operation.kind !== 'stop' &&
      loaded.ledger.operations.some(
        (entry) =>
          ['pending', 'ending'].includes(entry.state) &&
          runtimeKey(entry.target) === runtimeKey(operation.target),
      )
    )
      throw Error('请先核查此会话待确认的原操作；仍可单独精确停止当前回合。');
    const next = ledgerSchema.parse({
      revision: loaded.ledger.revision + 1,
      operations: [...loaded.ledger.operations, operation],
    });
    if (new TextEncoder().encode(canonical(next)).byteLength > LIMIT_BYTES)
      throw Error('本机原操作存储已满，尚未发送。');
    await this.backend.compareAndSet(loaded.key, loaded.raw, next, current);
    current();
    return structuredClone(operation);
  }
  async dispatch<T>(
    operation: SecureCliOperation,
    current: () => void,
    send: (original: SecureCliOperation) => Promise<T>,
  ): Promise<T> {
    const snapshot = secureOperationSchema.parse(structuredClone(operation));
    return this.backend.exclusive(operationLockKey(snapshot), current, async () => {
      current();
      const { ledger } = await this.#load(snapshot.target);
      current();
      const prior = ledger.operations.find((entry) => entry.operationId === snapshot.operationId);
      if (
        !prior ||
        prior.state !== 'pending' ||
        prior.requestVersion !== snapshot.requestVersion ||
        prior.body !== snapshot.body ||
        canonical(prior.target) !== canonical(snapshot.target) ||
        prior.kind !== snapshot.kind
      )
        throw Error('原操作状态已改变，未再次发送。');
      // No receipt/state mutation inside this lock: transition() acquires the same lock.
      const result = await send(structuredClone(prior));
      current();
      return result;
    });
  }
  async transition(
    operation: SecureCliOperation,
    from: SecureCliOperation['state'][],
    state: SecureCliOperation['state'],
    receipt: unknown,
    current: () => void,
  ) {
    const snapshot = secureOperationSchema.parse(structuredClone(operation));
    const allowed = [...from],
      receiptSnapshot = structuredClone(receipt);
    return this.backend.exclusive(operationLockKey(snapshot), current, async () => {
      current();
      const loaded = await this.#load(snapshot.target);
      current();
      const prior = loaded.ledger.operations.find(
        (entry) => entry.operationId === snapshot.operationId,
      );
      if (
        !prior ||
        !allowed.includes(prior.state) ||
        prior.requestVersion !== snapshot.requestVersion ||
        prior.body !== snapshot.body ||
        canonical(prior.target) !== canonical(snapshot.target)
      )
        throw Error(CONFLICT);
      const next = secureOperationSchema.parse({
        ...prior,
        state,
        ...(receiptSnapshot === undefined ? {} : { receipt: receiptSnapshot }),
      });
      await this.backend.compareAndSet(
        loaded.key,
        loaded.raw,
        ledgerSchema.parse({
          revision: loaded.ledger.revision + 1,
          operations: loaded.ledger.operations.map((entry) =>
            entry.operationId === next.operationId ? next : entry,
          ),
        }),
        current,
      );
      current();
      return structuredClone(next);
    });
  }
  async readDraft(target: SecureCliTarget) {
    const raw = await this.backend.read(draftKey(target));
    return raw == null ? '' : z.string().max(100000).parse(raw);
  }
  async saveDraft(target: SecureCliTarget, expected: string, value: string, current: () => void) {
    z.string().max(100000).parse(value);
    const key = draftKey(target),
      raw = await this.backend.read(key);
    current();
    if ((raw ?? '') !== expected) throw Error(CONFLICT);
    await this.backend.compareAndSet(key, raw ?? null, value, current);
  }
  close() {
    this.backend.close?.();
  }
}
