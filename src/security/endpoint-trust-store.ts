import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireRuntimeLock } from '../runtime/lock';
import { E2EE_CRYPTO_FAILED } from './e2ee-crypto';
import {
  E2EE_TRUST_LIMITS,
  rootPublicJwkSchema,
  trustCheckpointSchema,
  trustPinSchema,
  VerifiedTrust,
  type RootPublicJwk,
  type TrustPin,
} from './e2ee-trust';

export const ENDPOINT_TRUST_STORE_MAX_BYTES = 1024 * 1024;
const APPLICATION_ID = 0x4d455431; // MET1: Moor endpoint trust v1; never open a different database.
type FileIdentity = { dev: bigint; ino: bigint };
type TrustRow = { pin: string; root: string; signed: string; checkpoint: string };
function fail(): never {
  throw new Error(E2EE_CRYPTO_FAILED);
}
function owned(stat: BigIntStats) {
  return (
    (stat.mode & 0o077n) === 0n &&
    (process.getuid === undefined || stat.uid === BigInt(process.getuid()))
  );
}
function fileIdentity(file: string, optional = false): FileIdentity | undefined {
  try {
    const stat = lstatSync(file, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      !owned(stat) ||
      stat.size > BigInt(ENDPOINT_TRUST_STORE_MAX_BYTES)
    )
      fail();
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino;
}
function createPrivateFile(file: string) {
  if (fileIdentity(file, true)) return;
  const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  closeSync(fd);
}
function assertDatabaseIdentity(file: string) {
  const identity = fileIdentity(file)!;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!sameIdentity(identity, stat)) fail();
    if (stat.size === 0n) return;
    const header = Buffer.alloc(100);
    if (
      readSync(fd, header, 0, header.length, 0) !== header.length ||
      header.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0' ||
      header.readUInt32BE(68) !== APPLICATION_ID
    )
      fail();
  } finally {
    closeSync(fd);
  }
}
function parseColumn(value: unknown, maximum: number) {
  if (typeof value !== 'string' || value.length > maximum) fail();
  return JSON.parse(value);
}

/**
 * Endpoint-only trust anchor, never a relay database. It stores public signed state and the
 * local rollback checkpoint, not private keys. Callers provide an existing private directory.
 * Losing this file requires explicit trust recovery; opening an empty store never enrolls a device.
 */
export class EndpointTrustStore {
  readonly #db: DatabaseSync;
  readonly #file: string;
  readonly #directory: FileIdentity;
  readonly #files: ReadonlyMap<string, FileIdentity>;
  readonly #release: () => void;
  #closed = false;
  #trust: VerifiedTrust | undefined;
  #root: RootPublicJwk | undefined;
  #signed: string | undefined;

  private constructor(
    file: string,
    db: DatabaseSync,
    directory: FileIdentity,
    files: ReadonlyMap<string, FileIdentity>,
    release: () => void,
  ) {
    this.#file = file;
    this.#db = db;
    this.#directory = directory;
    this.#files = files;
    this.#release = release;
  }

  static async open(path: string): Promise<EndpointTrustStore> {
    let db: DatabaseSync | undefined;
    let release: (() => void) | undefined;
    let store: EndpointTrustStore | undefined;
    try {
      if (!isAbsolute(path)) fail();
      const file = resolve(path);
      const parent = dirname(file);
      const directory = lstatSync(parent, { bigint: true });
      if (!directory.isDirectory() || !owned(directory) || realpathSync(parent) !== parent) fail();
      for (const base of [file, file + '.lock']) {
        fileIdentity(base, true);
        for (const suffix of ['-journal', '-wal', '-shm']) fileIdentity(base + suffix, true);
      }
      createPrivateFile(file + '.lock');
      release = acquireRuntimeLock(file + '.lock');
      createPrivateFile(file);
      const files = new Map(
        [file, file + '.lock'].map((name) => [name, fileIdentity(name)!] as const),
      );
      const empty = lstatSync(file).size === 0;
      assertDatabaseIdentity(file);
      db = new DatabaseSync(file);
      if (!empty && db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID)
        fail();
      db.exec(`
        PRAGMA trusted_schema=OFF;
        PRAGMA busy_timeout=0;
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        PRAGMA application_id=${APPLICATION_ID};
        CREATE TABLE IF NOT EXISTS endpoint_trust(
          id INTEGER PRIMARY KEY CHECK(id=1),
          version INTEGER NOT NULL CHECK(version=1),
          pin TEXT NOT NULL, root TEXT NOT NULL, signed TEXT NOT NULL, checkpoint TEXT NOT NULL
        );
      `);
      store = new EndpointTrustStore(file, db, directory, files, release);
      store.#assertCurrentFiles();
      const row = db.prepare('SELECT version,pin,root,signed,checkpoint FROM endpoint_trust').get();
      if (row) {
        if (row.version !== 1) fail();
        const pin = trustPinSchema.parse(parseColumn(row.pin, 4096));
        const root = rootPublicJwkSchema.parse(parseColumn(row.root, 1024));
        const checkpoint = trustCheckpointSchema.parse(parseColumn(row.checkpoint, 4096));
        if (
          typeof row.signed !== 'string' ||
          row.signed.length > E2EE_TRUST_LIMITS.signedCharacters
        )
          fail();
        const trust = await VerifiedTrust.verify({
          signed: row.signed,
          rootPublicKey: root,
          pin,
          previous: checkpoint,
        });
        store.#assertCurrentFiles();
        store.#trust = trust;
        store.#root = Object.freeze(root);
        store.#signed = row.signed;
      }
      return store;
    } catch {
      if (store) store.close();
      else {
        db?.close();
        release?.();
      }
      return fail();
    }
  }

  #assertCurrentFiles() {
    if (this.#closed) fail();
    const parent = dirname(this.#file);
    const directory = lstatSync(parent, { bigint: true });
    if (
      !directory.isDirectory() ||
      !owned(directory) ||
      !sameIdentity(directory, this.#directory) ||
      realpathSync(parent) !== parent
    )
      fail();
    for (const [file, identity] of this.#files) {
      if (!sameIdentity(fileIdentity(file)!, identity)) fail();
      for (const suffix of ['-journal', '-wal', '-shm']) fileIdentity(file + suffix, true);
    }
  }

  current(): VerifiedTrust | undefined {
    try {
      this.#assertCurrentFiles();
      return this.#trust;
    } catch {
      return fail();
    }
  }

  /** Explicit first-use pin approval only. There is deliberately no replace/reset method. */
  async initialize(input: { signed: string; rootPublicKey: RootPublicJwk; pin: TrustPin }) {
    try {
      this.#assertCurrentFiles();
      if (this.#trust) fail();
      const signed = input.signed;
      const root = rootPublicJwkSchema.parse(input.rootPublicKey);
      const pin = trustPinSchema.parse(input.pin);
      const trust = await VerifiedTrust.verify({ signed, rootPublicKey: root, pin });
      this.#assertCurrentFiles();
      if (this.#trust) fail();
      this.#db
        .prepare(
          'INSERT INTO endpoint_trust(id,version,pin,root,signed,checkpoint) VALUES(1,1,?,?,?,?)',
        )
        .run(JSON.stringify(pin), JSON.stringify(root), signed, JSON.stringify(trust.checkpoint));
      this.#trust = trust;
      this.#root = Object.freeze(root);
      this.#signed = signed;
      return trust;
    } catch {
      return fail();
    }
  }

  /** Verify the next signed epoch, persist it, then make it visible to active channels. */
  async install(signed: string): Promise<VerifiedTrust> {
    try {
      this.#assertCurrentFiles();
      const before = this.#trust;
      const root = this.#root;
      if (!before || !root) fail();
      const trust = await VerifiedTrust.verify({
        signed,
        rootPublicKey: root,
        pin: {
          accountId: before.checkpoint.accountId,
          serverOrigin: before.checkpoint.serverOrigin,
          rootKeyId: before.checkpoint.rootKeyId,
        },
        previous: before.checkpoint,
      });
      this.#assertCurrentFiles();
      if (this.#trust !== before) fail();
      if (before.checkpoint.digest === trust.checkpoint.digest) return before;
      const result = this.#db
        .prepare('UPDATE endpoint_trust SET signed=?,checkpoint=? WHERE id=1 AND checkpoint=?')
        .run(signed, JSON.stringify(trust.checkpoint), JSON.stringify(before.checkpoint));
      if (result.changes !== 1) fail();
      this.#trust = trust;
      this.#signed = signed;
      return trust;
    } catch {
      return fail();
    }
  }

  /** Public state only, for a separately authenticated device/recovery workflow. */
  snapshot(): Readonly<TrustRow> | undefined {
    try {
      this.#assertCurrentFiles();
      if (!this.#trust || !this.#root || !this.#signed) return undefined;
      const { accountId, serverOrigin, rootKeyId } = this.#trust.checkpoint;
      return Object.freeze({
        pin: JSON.stringify({ accountId, serverOrigin, rootKeyId }),
        root: JSON.stringify(this.#root),
        signed: this.#signed,
        checkpoint: JSON.stringify(this.#trust.checkpoint),
      });
    } catch {
      return fail();
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#trust = undefined;
    this.#root = undefined;
    this.#signed = undefined;
    try {
      this.#db.close();
    } finally {
      this.#release();
    }
  }
}
