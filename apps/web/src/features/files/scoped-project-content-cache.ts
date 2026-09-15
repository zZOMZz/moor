import { z } from 'zod';
import { productCanonicalJson } from '@moor/client/encrypted-product';
import { IndexedSecureStorage, type SecureStorageBackend } from '../../platform/secure-store';

const MAX_ENTRIES = 96;
const MAX_BYTES = 24 * 1024 * 1024;
const canonical = productCanonicalJson;
const entryKey = <T>(target: T, key: string) => canonical([target, key]);
const size = (value: unknown) => new TextEncoder().encode(canonical(value)).byteLength;

/** A bounded, disposable content cache. Original operations and legacy caches are never read. */
export class ScopedProjectContentCache<T> {
  readonly #rowSchema;
  constructor(
    readonly options: {
      parseTarget(input: unknown): T;
      authority(target: T): unknown;
      namespace: string;
    },
    readonly backend: SecureStorageBackend = new IndexedSecureStorage(),
  ) {
    this.#rowSchema = z
      .object({
        revision: z.number().int().nonnegative().safe(),
        entries: z
          .array(
            z
              .object({ target: z.unknown(), key: z.string().max(20000), value: z.unknown() })
              .strict(),
          )
          .max(MAX_ENTRIES),
      })
      .strict();
  }
  #bucket(target: T) {
    return canonical([this.options.namespace, this.options.authority(target)]);
  }

  async #load(target: T, current: () => void) {
    current();
    const raw = (await this.backend.read(this.#bucket(target))) ?? null;
    current();
    const parsed = raw === null ? { revision: 0, entries: [] } : this.#rowSchema.parse(raw);
    const row = {
      ...parsed,
      entries: parsed.entries.map((entry) => ({
        ...entry,
        target: this.options.parseTarget(entry.target),
      })),
    };
    if (size(row) > MAX_BYTES) throw Error('本机文件缓存超出限制。');
    const keys = new Set<string>();
    for (const entry of row.entries) {
      const key = entryKey(entry.target, entry.key);
      if (
        canonical(this.options.authority(entry.target)) !==
          canonical(this.options.authority(target)) ||
        keys.has(key)
      )
        throw Error('本机文件缓存的身份或内容范围无效。');
      keys.add(key);
    }
    return { raw, row };
  }

  async read(input: T, key: string, current: () => void): Promise<unknown> {
    const target = this.options.parseTarget(input);
    const { row } = await this.#load(target, current);
    current();
    const selected = entryKey(target, key);
    return structuredClone(
      row.entries.find((entry) => entryKey(entry.target, entry.key) === selected)?.value,
    );
  }

  async writeBatch(
    input: T,
    values: ReadonlyMap<string, unknown>,
    current: () => void,
  ): Promise<void> {
    const target = this.options.parseTarget(input);
    const entries = [...values].map(([key, value]) => ({
      target,
      key,
      value: structuredClone(value),
    }));
    if (!entries.length) return;
    // A single read is retained atomically, including its last-read selectors.
    this.#rowSchema.parse({ revision: 0, entries });
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
      this.#rowSchema.parse(next);
      current();
      try {
        await this.backend.compareAndSet(this.#bucket(target), raw, next, current);
        current();
        return;
      } catch (error) {
        current();
        if (attempt === 2) throw error;
      }
    }
  }
}
