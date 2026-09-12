import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError } from '../protocol';
import {
  e2eeIdSchema,
  e2eeOriginSchema,
  rootPublicJwkSchema,
  trustCheckpointSchema,
  trustPinSchema,
  type TrustCheckpoint,
} from '../security/e2ee-trust';
import {
  publicTrustEntrySchema,
  TRUST_PUBLICATION_LIMITS,
  TRUST_PUBLICATION_VERSION,
  trustPageSchema,
  trustPublishReceiptSchema,
  trustPublishSchema,
  trustReadSchema,
  verifyPublicTrustEntry,
  type PublicTrustEntry,
  type TrustPage,
  type TrustPublishReceipt,
} from '../security/trust-publication';

export const TRUST_PUBLICATION_FAILED = '设备信任分发未能确认，请重新读取后手动重试';
export type TrustPublicationAuthority = { owner: string; origin: string; current: () => void };
type RootRow = { pin: string; root: string; head: string; stored_bytes: number };
type EntryRow = { epoch: number; entry: string; bytes: number };
const json = (value: unknown) => JSON.stringify(value);
const byteLength = (value: unknown) => Buffer.byteLength(json(value), 'utf8');
const same = (left: unknown, right: unknown) => json(left) === json(right);
function fail(status = 409): never {
  throw new AppError(status, TRUST_PUBLICATION_FAILED);
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(400);
  return parsed.data;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Public root-signed trust history only. A relay root record never enrolls a client device. */
export class RelayTrustPublications {
  #closed = false;
  constructor(private readonly db: DatabaseSync) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS trust_publication_root(
          owner TEXT PRIMARY KEY,
          pin TEXT NOT NULL,
          root TEXT NOT NULL,
          head TEXT NOT NULL,
          stored_bytes INTEGER NOT NULL CHECK(stored_bytes>=0)
        );
        CREATE TABLE IF NOT EXISTS trust_publication_entry(
          owner TEXT NOT NULL REFERENCES trust_publication_root(owner),
          epoch INTEGER NOT NULL CHECK(epoch>=1),
          entry TEXT NOT NULL,
          bytes INTEGER NOT NULL CHECK(bytes>=0),
          PRIMARY KEY(owner,epoch)
        );
      `);
    } catch {
      fail();
    }
  }

  #authority(input: TrustPublicationAuthority): TrustPublicationAuthority {
    const owner = parse(e2eeIdSchema, input.owner),
      origin = parse(e2eeOriginSchema, input.origin),
      current = input.current;
    if (typeof current !== 'function') fail(400);
    const authority = { owner, origin, current };
    this.#current(authority);
    return authority;
  }
  #current(authority: TrustPublicationAuthority) {
    if (this.#closed) fail();
    authority.current();
    if (this.#closed) fail();
  }
  #root(owner: string): RootRow | undefined {
    return this.db
      .prepare('SELECT pin,root,head,stored_bytes FROM trust_publication_root WHERE owner=?')
      .get(owner) as RootRow | undefined;
  }
  #entry(owner: string, epoch: number): EntryRow | undefined {
    return this.db
      .prepare('SELECT epoch,entry,bytes FROM trust_publication_entry WHERE owner=? AND epoch=?')
      .get(owner, epoch) as EntryRow | undefined;
  }
  #parseEntry(row: EntryRow): PublicTrustEntry {
    if (typeof row.entry !== 'string' || row.entry.length > TRUST_PUBLICATION_LIMITS.wireBytes)
      fail();
    const entry = parse(publicTrustEntrySchema, JSON.parse(row.entry));
    if (
      entry.checkpoint.epoch !== row.epoch ||
      json(entry) !== row.entry ||
      byteLength(entry) !== row.bytes
    )
      fail();
    return entry;
  }
  #parseRoot(row: RootRow) {
    if (
      [row.pin, row.root, row.head].some(
        (value) => typeof value !== 'string' || value.length > 8192,
      )
    )
      fail();
    const pin = parse(trustPinSchema, JSON.parse(row.pin)),
      rootPublicKey = parse(rootPublicJwkSchema, JSON.parse(row.root)),
      head = parse(trustCheckpointSchema, JSON.parse(row.head));
    if (
      pin.accountId !== head.accountId ||
      pin.serverOrigin !== head.serverOrigin ||
      pin.rootKeyId !== head.rootKeyId ||
      !Number.isSafeInteger(row.stored_bytes) ||
      row.stored_bytes < 0 ||
      row.stored_bytes > TRUST_PUBLICATION_LIMITS.storedBytes ||
      head.epoch > TRUST_PUBLICATION_LIMITS.versions
    )
      fail();
    return { pin, rootPublicKey, head };
  }
  #scope(entry: { pin: PublicTrustEntry['pin'] }, authority: TrustPublicationAuthority) {
    if (entry.pin.accountId !== authority.owner || entry.pin.serverOrigin !== authority.origin)
      fail(403);
  }
  #unchanged(owner: string, before: RootRow | undefined) {
    if (!same(this.#root(owner), before)) fail();
  }

  async publish(input: unknown, context: TrustPublicationAuthority): Promise<TrustPublishReceipt> {
    try {
      const request = parse(trustPublishSchema, input),
        authority = this.#authority(context),
        first = request.entries[0],
        before = this.#root(authority.owner),
        original = before ? this.#parseRoot(before) : undefined;
      for (const entry of request.entries) {
        this.#scope(entry, authority);
        if (!same(entry.pin, first.pin) || !same(entry.rootPublicKey, first.rootPublicKey))
          fail(403);
      }
      if (
        original &&
        (!same(original.pin, first.pin) || !same(original.rootPublicKey, first.rootPublicKey))
      )
        fail();
      let head = original?.head;
      let storedBytes = before?.stored_bytes ?? 0;
      const additions: Array<{ entry: PublicTrustEntry; bytes: number }> = [];
      for (const entry of request.entries) {
        this.#current(authority);
        const verified = await verifyPublicTrustEntry(entry);
        this.#current(authority);
        this.#unchanged(authority.owner, before);
        if (original && entry.checkpoint.epoch <= original.head.epoch) {
          const stored = this.#entry(authority.owner, entry.checkpoint.epoch);
          if (!stored || !same(this.#parseEntry(stored), entry)) fail();
          continue;
        }
        if (
          entry.checkpoint.epoch !== (head?.epoch ?? 0) + 1 ||
          verified.manifest.previous !== (head?.digest ?? null)
        )
          fail();
        const bytes = byteLength(entry);
        storedBytes += bytes;
        if (
          entry.checkpoint.epoch > TRUST_PUBLICATION_LIMITS.versions ||
          storedBytes > TRUST_PUBLICATION_LIMITS.storedBytes
        )
          fail(413);
        additions.push({ entry, bytes });
        head = entry.checkpoint;
      }
      if (!head) fail();
      const receipt = freeze(
        parse(trustPublishReceiptSchema, {
          publicationVersion: TRUST_PUBLICATION_VERSION,
          pin: first.pin,
          rootPublicKey: first.rootPublicKey,
          stored: request.entries.map((entry) => entry.checkpoint),
          head,
        }),
      );
      this.#current(authority);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.#unchanged(authority.owner, before);
        if (!before) {
          this.db
            .prepare(
              'INSERT INTO trust_publication_root(owner,pin,root,head,stored_bytes) VALUES(?,?,?,?,?)',
            )
            .run(
              authority.owner,
              json(first.pin),
              json(first.rootPublicKey),
              json(head),
              storedBytes,
            );
        }
        for (const item of additions) {
          this.db
            .prepare('INSERT INTO trust_publication_entry(owner,epoch,entry,bytes) VALUES(?,?,?,?)')
            .run(authority.owner, item.entry.checkpoint.epoch, json(item.entry), item.bytes);
        }
        if (before && additions.length) {
          const changed = this.db
            .prepare(
              'UPDATE trust_publication_root SET head=?,stored_bytes=? WHERE owner=? AND pin=? AND root=? AND head=? AND stored_bytes=?',
            )
            .run(
              json(head),
              storedBytes,
              authority.owner,
              before.pin,
              before.root,
              before.head,
              before.stored_bytes,
            );
          if (changed.changes !== 1) fail();
        }
        this.#current(authority);
        this.db.exec('COMMIT');
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {}
        throw error;
      }
      return receipt;
    } catch (error) {
      return fail(error instanceof AppError ? error.status : 409);
    }
  }

  async read(input: unknown, context: TrustPublicationAuthority): Promise<TrustPage> {
    try {
      const request = parse(trustReadSchema, input),
        authority = this.#authority(context);
      this.#scope(request, authority);
      const before = this.#root(authority.owner);
      if (!before) fail(404);
      const original = this.#parseRoot(before);
      if (!same(request.pin, original.pin)) fail();
      const head = request.head ?? original.head;
      if (head.epoch > original.head.epoch) fail();
      const headRow = this.#entry(authority.owner, head.epoch);
      if (!headRow) fail();
      const headEntry = this.#parseEntry(headRow);
      if (
        !same(headEntry.checkpoint, head) ||
        !same(headEntry.rootPublicKey, original.rootPublicKey)
      )
        fail();
      const afterRow = request.after
        ? this.#entry(authority.owner, request.after.epoch)
        : undefined;
      if (
        request.after &&
        (!afterRow ||
          !same(this.#parseEntry(afterRow).checkpoint, request.after) ||
          request.after.epoch > head.epoch)
      )
        fail();
      const current = () => {
        this.#current(authority);
        const now = this.#root(authority.owner);
        if (!now) fail();
        const parsed = this.#parseRoot(now);
        if (
          !same(parsed.pin, original.pin) ||
          !same(parsed.rootPublicKey, original.rootPublicKey) ||
          parsed.head.epoch < original.head.epoch
        )
          fail();
        if (
          !same(this.#entry(authority.owner, head.epoch), headRow) ||
          (request.after && !same(this.#entry(authority.owner, request.after.epoch), afterRow))
        )
          fail();
      };
      const verify = async (entry: PublicTrustEntry) => {
        current();
        const result = await verifyPublicTrustEntry(entry);
        current();
        return result;
      };
      await verify(headEntry);
      if (afterRow) await verify(this.#parseEntry(afterRow));
      const rows = this.db
        .prepare(
          'SELECT epoch,entry,bytes FROM trust_publication_entry WHERE owner=? AND epoch>? AND epoch<=? ORDER BY epoch LIMIT ?',
        )
        .all(authority.owner, request.after?.epoch ?? 0, head.epoch, request.limit) as EntryRow[];
      const entries: PublicTrustEntry[] = [];
      let previous: TrustCheckpoint | null = request.after;
      const page = (): TrustPage => ({
        publicationVersion: TRUST_PUBLICATION_VERSION,
        pin: request.pin,
        rootPublicKey: original.rootPublicKey,
        after: request.after,
        head,
        entries,
        complete: !!previous && same(previous, head),
      });
      for (const row of rows) {
        const entry = this.#parseEntry(row);
        entries.push(entry);
        if (byteLength(page()) > TRUST_PUBLICATION_LIMITS.wireBytes) {
          entries.pop();
          break;
        }
        const verified = await verify(entry);
        if (
          !same(this.#entry(authority.owner, row.epoch), row) ||
          entry.checkpoint.epoch !== (previous?.epoch ?? 0) + 1 ||
          verified.manifest.previous !== (previous?.digest ?? null)
        )
          fail();
        previous = entry.checkpoint;
      }
      current();
      return freeze(parse(trustPageSchema, page()));
    } catch (error) {
      return fail(error instanceof AppError ? error.status : 409);
    }
  }

  close() {
    this.#closed = true;
  }
}
