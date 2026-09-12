import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { acquireRuntimeLock } from '../runtime/lock';
import { PRIVATE_ENDPOINT_FILE_FORMAT } from './private-content';

export { PRIVATE_ENDPOINT_FILE_FORMAT } from './private-content';

export const PRIVATE_ENDPOINT_FILE_MAX_BYTES = 1024 * 1024;
export const PRIVATE_ENDPOINT_FILE_FAILED = '本机私有配置操作失败';
export const PRIVATE_ENDPOINT_FILE_UNKNOWN = '本机私有配置写入状态未知，请重新打开后核对';
export class PrivateEndpointFileError extends Error {
  constructor(readonly outcome: 'unchanged' | 'unknown') {
    super(outcome === 'unknown' ? PRIVATE_ENDPOINT_FILE_UNKNOWN : PRIVATE_ENDPOINT_FILE_FAILED);
  }
}
export type PrivateEndpointFileFs = Pick<
  typeof fs,
  | 'lstatSync'
  | 'fstatSync'
  | 'openSync'
  | 'closeSync'
  | 'readSync'
  | 'writeSync'
  | 'fsyncSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'realpathSync'
>;
export type PrivateEndpointValue = { revision: number; value: unknown };
type Identity = { dev: bigint; ino: bigint };
type Snapshot = { identity: Identity; bytes: Buffer; revision: number };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
function fail(): never {
  throw new PrivateEndpointFileError('unchanged');
}
function owned(stat: fs.BigIntStats, mode: bigint) {
  return (
    (stat.mode & 0o777n) === mode &&
    (process.getuid === undefined || stat.uid === BigInt(process.getuid()))
  );
}
function privateFileStat(
  io: PrivateEndpointFileFs,
  path: string,
  optional = false,
): fs.BigIntStats | undefined {
  try {
    const stat = io.lstatSync(path, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      !owned(stat, 0o600n) ||
      stat.size > BigInt(PRIVATE_ENDPOINT_FILE_MAX_BYTES)
    )
      fail();
    return stat;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Our lifetime lock never creates SQLite pages. Its only journal is the complete,
 * unsynced header produced by BEGIN EXCLUSIVE on an empty database: no magic,
 * records, original pages or payload. Only the checksum nonce is variable.
 * Unknown journal layouts fail closed before SQLite can roll back operator data.
 * https://www.sqlite.org/fileformat.html#the_rollback_journal
 */
function emptyLockJournal(io: PrivateEndpointFileFs, path: string, before: fs.BigIntStats) {
  if (before.size !== 512n) fail();
  const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = io.fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !owned(opened, 0o600n) ||
      !sameIdentity(opened, before) ||
      opened.size !== before.size
    )
      fail();
    const bytes = Buffer.alloc(512);
    let offset = 0;
    while (offset < bytes.length) {
      const count = io.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) fail();
      offset += count;
    }
    const after = io.fstatSync(fd, { bigint: true }),
      current = privateFileStat(io, path)!;
    for (const stat of [after, current])
      if (
        !sameIdentity(stat, before) ||
        stat.size !== before.size ||
        stat.mtimeNs !== before.mtimeNs ||
        stat.ctimeNs !== before.ctimeNs ||
        !owned(stat, 0o600n) ||
        stat.nlink !== 1n
      )
        fail();
    if (
      bytes.subarray(0, 12).some((byte) => byte !== 0) ||
      bytes.readUInt32BE(16) !== 0 ||
      bytes.readUInt32BE(20) !== 512 ||
      bytes.readUInt32BE(24) !== 4096 ||
      bytes.subarray(28).some((byte) => byte !== 0)
    )
      fail();
  } finally {
    io.closeSync(fd);
  }
}
function emptyLockNamespace(io: PrivateEndpointFileFs, path: string, optional = false) {
  const lock = privateFileStat(io, path, optional);
  if (lock && lock.size !== 0n) fail();
  // This lock never uses WAL. Even an empty foreign sidecar must be left untouched.
  for (const suffix of ['-wal', '-shm']) if (privateFileStat(io, path + suffix, true)) fail();
  const journal = privateFileStat(io, path + '-journal', true);
  if (journal) emptyLockJournal(io, path + '-journal', journal);
  const current = privateFileStat(io, path, optional);
  if (
    !!current !== !!lock ||
    (current &&
      lock &&
      (!sameIdentity(current, lock) ||
        current.size !== 0n ||
        current.mtimeNs !== lock.mtimeNs ||
        current.ctimeNs !== lock.ctimeNs))
  )
    fail();
  return lock;
}
function parse(bytes: Buffer): PrivateEndpointValue {
  const input: unknown = JSON.parse(decoder.decode(bytes));
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const row = input as Record<string, unknown>;
  if (
    Object.keys(row).length !== 3 ||
    row.format !== PRIVATE_ENDPOINT_FILE_FORMAT ||
    !Object.hasOwn(row, 'value') ||
    typeof row.revision !== 'number' ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  )
    fail();
  jsonValue(row.value);
  return { revision: row.revision, value: row.value };
}
function jsonValue(value: unknown, parents = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value || parents.has(value)) fail();
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    fail();
  parents.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) fail();
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) fail();
    for (let index = 0; index < value.length; index++) {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      if (!property || !('value' in property)) fail();
      jsonValue(property.value, parents);
    }
  } else
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!property.enumerable || !('value' in property)) fail();
      jsonValue(property.value, parents);
    }
  parents.delete(value);
}

/** Private endpoint storage only: no IPC, enrollment, key generation or automatic recovery. */
export class PrivateEndpointFile {
  readonly #fs: PrivateEndpointFileFs;
  readonly #file: string;
  readonly #parent: string;
  readonly #directory: Identity;
  readonly #directoryFd: number;
  readonly #lock: Identity;
  readonly #release: () => void;
  #snapshot: Snapshot | undefined;
  #closed = false;
  #invalid = false;

  private constructor(
    file: string,
    io: PrivateEndpointFileFs,
    directory: Identity,
    directoryFd: number,
    lock: Identity,
    release: () => void,
  ) {
    this.#file = file;
    this.#parent = dirname(file);
    this.#fs = io;
    this.#directory = directory;
    this.#directoryFd = directoryFd;
    this.#lock = lock;
    this.#release = release;
  }
  static open(
    path: string,
    options: { fs?: Partial<PrivateEndpointFileFs> } = {},
  ): PrivateEndpointFile {
    const io = { ...fs, ...options.fs };
    let fd: number | undefined,
      release: (() => void) | undefined,
      store: PrivateEndpointFile | undefined;
    try {
      if (!isAbsolute(path)) fail();
      const file = resolve(path),
        parent = dirname(file);
      const directory = io.lstatSync(parent, { bigint: true });
      if (
        !directory.isDirectory() ||
        !owned(directory, 0o700n) ||
        io.realpathSync(parent) !== parent
      )
        fail();
      fd = io.openSync(
        parent,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      if (!sameIdentity(directory, io.fstatSync(fd, { bigint: true }))) fail();
      const lockFile = file + '.lock';
      privateFileStat(io, file, true);
      if (!emptyLockNamespace(io, lockFile, true)) {
        const lockFd = io.openSync(
          lockFile,
          fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_WRONLY |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        io.closeSync(lockFd);
      }
      const lock = emptyLockNamespace(io, lockFile)!;
      const currentDirectory = io.lstatSync(parent, { bigint: true });
      if (
        !currentDirectory.isDirectory() ||
        !owned(currentDirectory, 0o700n) ||
        !sameIdentity(directory, currentDirectory) ||
        io.realpathSync(parent) !== parent
      )
        fail();
      release = acquireRuntimeLock(lockFile);
      store = new PrivateEndpointFile(file, io, directory, fd, lock, release);
      store.#assertDirectory();
      store.#snapshot = store.#read(file);
      store.#assertCurrent();
      return store;
    } catch {
      if (store) store.close();
      else {
        try {
          if (fd !== undefined) io.closeSync(fd);
        } catch {}
        try {
          release?.();
        } catch {}
      }
      return fail();
    }
  }
  #fileStat(path: string, optional = false): fs.BigIntStats | undefined {
    return privateFileStat(this.#fs, path, optional);
  }
  #assertDirectory() {
    if (this.#closed || this.#invalid) fail();
    const path = this.#fs.lstatSync(this.#parent, { bigint: true });
    const opened = this.#fs.fstatSync(this.#directoryFd, { bigint: true });
    if (
      !path.isDirectory() ||
      !owned(path, 0o700n) ||
      !sameIdentity(path, this.#directory) ||
      !sameIdentity(opened, this.#directory) ||
      this.#fs.realpathSync(this.#parent) !== this.#parent
    )
      fail();
    if (!sameIdentity(emptyLockNamespace(this.#fs, this.#file + '.lock')!, this.#lock)) fail();
  }
  #read(path: string): Snapshot | undefined {
    this.#assertDirectory();
    const before = this.#fileStat(path, true);
    if (!before) return undefined;
    const fd = this.#fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = this.#fs.fstatSync(fd, { bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        !owned(opened, 0o600n) ||
        !sameIdentity(before, opened) ||
        before.size !== opened.size
      )
        fail();
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const count = this.#fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) fail();
        offset += count;
      }
      const after = this.#fs.fstatSync(fd, { bigint: true });
      const current = this.#fileStat(path)!;
      if (
        !sameIdentity(after, before) ||
        !sameIdentity(current, before) ||
        after.size !== before.size ||
        current.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        !owned(after, 0o600n) ||
        after.nlink !== 1n
      )
        fail();
      this.#assertDirectory();
      return { identity: before, bytes, revision: parse(bytes).revision };
    } finally {
      this.#fs.closeSync(fd);
    }
  }
  #assertCurrent() {
    try {
      const actual = this.#read(this.#file),
        before = this.#snapshot;
      if (
        !!actual !== !!before ||
        (actual &&
          before &&
          (!sameIdentity(actual.identity, before.identity) || !actual.bytes.equals(before.bytes)))
      )
        fail();
    } catch {
      this.#invalid = true;
      fail();
    }
  }
  load(): PrivateEndpointValue | undefined {
    try {
      this.#assertCurrent();
      return this.#snapshot ? parse(this.#snapshot.bytes) : undefined;
    } catch {
      return fail();
    }
  }
  save(expectedRevision: number | null, value: unknown): PrivateEndpointValue {
    let temporary: string | undefined, identity: Identity | undefined, fd: number | undefined;
    let renaming = false,
      renamed = false;
    try {
      this.#assertCurrent();
      if (expectedRevision !== (this.#snapshot?.revision ?? null)) fail();
      const revision = (this.#snapshot?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) fail();
      jsonValue(value);
      const bytes = Buffer.from(
        encoder.encode(
          JSON.stringify({ format: PRIVATE_ENDPOINT_FILE_FORMAT, revision, value }) + '\n',
        ),
      );
      if (bytes.length > PRIVATE_ENDPOINT_FILE_MAX_BYTES) fail();
      temporary = join(this.#parent, '.' + basename(this.#file) + '.' + randomUUID() + '.tmp');
      fd = this.#fs.openSync(
        temporary,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      identity = this.#fs.fstatSync(fd, { bigint: true });
      let offset = 0;
      while (offset < bytes.length) {
        const count = this.#fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) fail();
        offset += count;
      }
      this.#fs.fsyncSync(fd);
      this.#fs.closeSync(fd);
      fd = undefined;
      const candidate = this.#read(temporary);
      if (
        !candidate ||
        !sameIdentity(candidate.identity, identity) ||
        !candidate.bytes.equals(bytes)
      )
        fail();
      this.#assertCurrent();
      renaming = true;
      this.#fs.renameSync(temporary, this.#file);
      renamed = true;
      this.#fs.fsyncSync(this.#directoryFd);
      this.#assertDirectory();
      const saved = this.#read(this.#file);
      if (!saved || !sameIdentity(saved.identity, identity) || !saved.bytes.equals(bytes)) fail();
      this.#snapshot = saved;
      return parse(saved.bytes);
    } catch {
      let unknown = renamed;
      if (renaming && !renamed) {
        try {
          this.#assertCurrent();
        } catch {
          unknown = true;
        }
      }
      if (unknown) this.#invalid = true;
      throw new PrivateEndpointFileError(unknown ? 'unknown' : 'unchanged');
    } finally {
      try {
        if (fd !== undefined) this.#fs.closeSync(fd);
      } catch {}
      if (temporary && identity) {
        try {
          const current = this.#fs.lstatSync(temporary, { bigint: true });
          if (sameIdentity(current, identity)) this.#fs.unlinkSync(temporary);
        } catch {}
      }
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#fs.closeSync(this.#directoryFd);
    } catch {}
    try {
      this.#release();
    } catch {}
  }
}
