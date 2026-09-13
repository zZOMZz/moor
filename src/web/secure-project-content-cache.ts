import { z } from 'zod';
import { secureTargetSchema, type SecureCliTarget } from '../cli/secure-operation';
import { productCanonicalJson } from '../security/encrypted-product-catalog';
import { IndexedSecureStorage, type SecureStorageBackend } from './secure-store';

const MAX_ENTRIES = 96;
const MAX_BYTES = 24 * 1024 * 1024;
const rowSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    entries: z
      .array(
        z
          .object({ target: secureTargetSchema, key: z.string().max(20000), value: z.unknown() })
          .strict(),
      )
      .max(MAX_ENTRIES),
  })
  .strict();
const canonical = productCanonicalJson;
const authority = (target: SecureCliTarget) => {
  const { origin, owner, rootKeyId, clientDeviceId } = target;
  return { origin, owner, rootKeyId, clientDeviceId };
};
const bucket = (target: SecureCliTarget) =>
  canonical(['moor-secure-project-content-v1', authority(target)]);
const entryKey = (target: SecureCliTarget, key: string) => canonical([target, key]);
const size = (value: unknown) => new TextEncoder().encode(canonical(value)).byteLength;

/** A bounded, disposable content cache. Original operations and legacy caches are never read. */
export class SecureProjectContentCache {
  constructor(readonly backend: SecureStorageBackend = new IndexedSecureStorage()) {}

  async #load(target: SecureCliTarget, current: () => void) {
    current();
    const raw = (await this.backend.read(bucket(target))) ?? null;
    current();
    const row = raw === null ? { revision: 0, entries: [] } : rowSchema.parse(raw);
    if (size(row) > MAX_BYTES) throw Error('本机文件缓存超出限制。');
    const keys = new Set<string>();
    for (const entry of row.entries) {
      const key = entryKey(entry.target, entry.key);
      if (
        !entry.target.product ||
        canonical(authority(entry.target)) !== canonical(authority(target)) ||
        keys.has(key)
      )
        throw Error('本机文件缓存的身份或内容范围无效。');
      keys.add(key);
    }
    return { raw, row };
  }

  async read(input: SecureCliTarget, key: string, current: () => void): Promise<unknown> {
    const target = secureTargetSchema.parse(input);
    if (!target.product) throw Error('文件缓存必须绑定已确认的项目副本。');
    const { row } = await this.#load(target, current);
    current();
    const selected = entryKey(target, key);
    return structuredClone(
      row.entries.find((entry) => entryKey(entry.target, entry.key) === selected)?.value,
    );
  }

  async writeBatch(
    input: SecureCliTarget,
    values: ReadonlyMap<string, unknown>,
    current: () => void,
  ): Promise<void> {
    const target = secureTargetSchema.parse(input);
    if (!target.product) throw Error('文件缓存必须绑定已确认的项目副本。');
    const entries = [...values].map(([key, value]) => ({
      target,
      key,
      value: structuredClone(value),
    }));
    if (!entries.length) return;
    // A single read is retained atomically, including its last-read selectors.
    rowSchema.parse({ revision: 0, entries });
    if (size({ revision: 0, entries }) > MAX_BYTES) throw Error('文件内容超出本机缓存容量。');
    const replaced = new Set(entries.map((entry) => entryKey(entry.target, entry.key)));
    for (let attempt = 0; attempt < 3; attempt++) {
      const { raw, row } = await this.#load(target, current);
      const kept = row.entries.filter((entry) => !replaced.has(entryKey(entry.target, entry.key)));
      const next = { revision: row.revision + 1, entries: [...kept, ...entries] };
      while (next.entries.length > MAX_ENTRIES || size(next) > MAX_BYTES) {
        if (next.entries.length <= entries.length) throw Error('文件内容超出本机缓存容量。');
        next.entries.shift();
      }
      rowSchema.parse(next);
      current();
      try {
        await this.backend.compareAndSet(bucket(target), raw, next, current);
        current();
        return;
      } catch (error) {
        current();
        if (attempt === 2) throw error;
      }
    }
  }
}
