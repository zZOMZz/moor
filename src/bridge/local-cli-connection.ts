import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppError, assert, id } from '../protocol';

export const localCliConnectionSchema = z
  .object({
    version: z.literal(1),
    instanceId: id,
    origin: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === 'http:' &&
            url.hostname === '127.0.0.1' &&
            url.origin === value &&
            Number(url.port || '80') > 0 &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      }),
    secret: z
      .string()
      .min(32)
      .max(200)
      .regex(/^[A-Za-z0-9_-]+$/),
    ownerId: id,
    deviceId: id,
    runtimeWorkspaceId: id,
    machineId: id,
    userId: z.string().min(1).max(200),
  })
  .strict();
export type LocalCliConnection = z.infer<typeof localCliConnectionSchema>;
export type LocalCliConnectionLease = { connection: LocalCliConnection; assertCurrent(): void };
export type LocalCliConnectionOptions = { projectRoots(): string[]; distributionRoots: string[] };
const challengeSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .refine((value) => Buffer.from(value, 'base64url').toString('base64url') === value);
const proofSchema = z
  .object({ instanceId: id, challenge: challengeSchema, proof: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
/** A fresh challenge proves the listener holds the private CLI credential. */
export function localCliChallenge() {
  return randomBytes(32).toString('base64url');
}
export function localCliProof(instanceId: string, challenge: string, secret: string) {
  assert(
    id.safeParse(instanceId).success &&
      challengeSchema.safeParse(challenge).success &&
      localCliConnectionSchema.shape.secret.safeParse(secret).success,
    400,
    '本机 CLI 实例挑战无效',
  );
  return createHmac('sha256', secret)
    .update(JSON.stringify(['moor-cli-proof-v1', instanceId, challenge]))
    .digest('hex');
}
export function verifyLocalCliProof(
  connection: LocalCliConnection,
  challenge: string,
  response: unknown,
): void {
  const parsed = proofSchema.safeParse(response);
  assert(
    parsed.success &&
      parsed.data.instanceId === connection.instanceId &&
      parsed.data.challenge === challenge,
    409,
    '本机 CLI 执行服务身份未确认，请重新连接',
  );
  const expected = localCliProof(connection.instanceId, challenge, connection.secret);
  assert(
    timingSafeEqual(Buffer.from(parsed.data.proof, 'hex'), Buffer.from(expected, 'hex')),
    409,
    '本机 CLI 执行服务身份未确认，请重新连接',
  );
}
const unavailable = () =>
  new AppError(409, '本机 CLI 连接文件不可安全读取，请确认主机已启动且配置目录私有');
const contains = (root: string, path: string) => {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith('../') && !isAbsolute(part));
};
const identity = (s: BigIntStats) => [s.dev, s.ino, s.mode, s.uid, s.gid];
const fileIdentity = (s: BigIntStats) => [...identity(s), s.size, s.mtimeNs, s.ctimeNs, s.nlink];
const same = (a: BigIntStats, b: BigIntStats) => isDeepStrictEqual(identity(a), identity(b));
function filename(file: string) {
  assert(
    isAbsolute(file) && file.length <= 4096 && basename(file).endsWith('.cli.json'),
    400,
    '请指定绝对路径的 .cli.json 连接文件',
  );
  const absolute = resolve(file);
  try {
    return join(nearestReal(dirname(absolute)), basename(absolute));
  } catch {
    throw unavailable();
  }
}
function ancestors(file: string, requireOwnedLeaf = true) {
  const result: { path: string; stat: BigIntStats }[] = [];
  const base = parse(file).root;
  let path = base;
  for (const part of ['', ...dirname(file).slice(base.length).split('/').filter(Boolean)]) {
    if (part) path = join(path, part);
    const stat = lstatSync(path, { bigint: true });
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 409, '本机 CLI 连接目录不能包含符号链接');
    const uid = BigInt(process.getuid?.() ?? 0);
    assert(stat.uid === 0n || stat.uid === uid, 409, '本机 CLI 连接目录不能由其他用户控制');
    // System sticky directories (/private/tmp) may contain the owned private
    // directory; non-sticky shared writable ancestry permits replacement.
    assert(
      (stat.mode & 0o022n) === 0n || (stat.mode & 0o1000n) !== 0n,
      409,
      '本机 CLI 连接目录可被其他用户修改',
    );
    assert(
      !requireOwnedLeaf ||
        path !== dirname(file) ||
        (stat.uid === uid && (stat.mode & 0o022n) === 0n),
      409,
      '本机 CLI 连接文件需要本用户的安全目录',
    );
    result.push({ path, stat });
  }
  return result;
}
function currentDirectories(dirs: ReturnType<typeof ancestors>) {
  for (const directory of dirs)
    assert(
      same(directory.stat, lstatSync(directory.path, { bigint: true })),
      409,
      '本机 CLI 连接目录已改变',
    );
}
function read(file: string) {
  let fd: number | undefined;
  try {
    const dirs = ancestors(file),
      before = lstatSync(file, { bigint: true });
    assert(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.nlink === 1n &&
        before.uid === BigInt(process.getuid?.() ?? 0) &&
        (before.mode & 0o777n) === 0o600n &&
        before.size <= 4096n,
      409,
      '本机 CLI 连接文件必须为本用户的 0600 普通文件',
    );
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    assert(
      isDeepStrictEqual(fileIdentity(before), fileIdentity(opened)),
      409,
      '本机 CLI 连接文件已改变',
    );
    const bytes = Buffer.alloc(4097),
      size = readSync(fd, bytes, 0, bytes.length, 0);
    assert(
      size <= 4096 &&
        BigInt(size) === opened.size &&
        isDeepStrictEqual(fileIdentity(opened), fileIdentity(fstatSync(fd, { bigint: true }))),
      409,
      '本机 CLI 连接文件已改变',
    );
    currentDirectories(dirs);
    assert(
      isDeepStrictEqual(fileIdentity(opened), fileIdentity(lstatSync(file, { bigint: true }))),
      409,
      '本机 CLI 连接文件已改变',
    );
    return {
      connection: localCliConnectionSchema.parse(
        JSON.parse(bytes.subarray(0, size).toString('utf8')),
      ),
      stat: opened,
      dirs,
    };
  } catch {
    throw unavailable();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
/** No database or network access. Consumers verify a fresh listener proof before sending a cookie. */
export function readLocalCliConnection(input: string): LocalCliConnectionLease {
  const file = filename(input),
    saved = read(file);
  return {
    connection: structuredClone(saved.connection),
    assertCurrent() {
      assert(filename(input) === file, 409, '本机 CLI 连接目录已改变');
      const now = read(file);
      assert(
        isDeepStrictEqual(fileIdentity(saved.stat), fileIdentity(now.stat)) &&
          isDeepStrictEqual(saved.connection, now.connection) &&
          isDeepStrictEqual(
            saved.dirs.map((d) => [d.path, ...identity(d.stat)]),
            now.dirs.map((d) => [d.path, ...identity(d.stat)]),
          ),
        409,
        '本机 CLI 主机实例已改变，请重新读取连接',
      );
    },
  };
}
function nearestReal(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(nearestReal(dirname(path)), basename(path));
  }
}
/** Validate before starting any local relay or creating its login credentials. */
export function assertLocalCliConnectionPath(input: string, options: LocalCliConnectionOptions) {
  const file = filename(input),
    original = resolve(input);
  try {
    const canonical = nearestReal(file),
      directory = dirname(file);
    for (const root of [...options.projectRoots(), ...options.distributionRoots]) {
      assert(isAbsolute(root), 409, '本机 CLI 配置范围不可验证');
      for (const path of [resolve(root), nearestReal(root)])
        assert(
          !contains(path, file) &&
            !contains(path, canonical) &&
            !contains(path, original) &&
            !contains(path, directory),
          409,
          '本机 CLI 配置必须位于项目和程序发行目录外',
        );
    }
    // Existing ancestors must already be safe. Missing descendants are created
    // with owner-only access, then the whole ancestry is checked again.
    let parent = directory;
    while (true) {
      try {
        lstatSync(parent);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        parent = dirname(parent);
      }
    }
    ancestors(join(parent, '.connection-check.cli.json'), parent === directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    ancestors(file);
    try {
      const stat = lstatSync(file, { bigint: true });
      assert(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.nlink === 1n &&
          stat.uid === BigInt(process.getuid?.() ?? 0) &&
          (stat.mode & 0o777n) === 0o600n,
        409,
        '本机 CLI 连接文件不可替换',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return file;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable();
  }
}
/** Runtime ownership lock must already be held by the publisher. */
export function publishLocalCliConnection(
  input: string,
  value: LocalCliConnection,
  options: LocalCliConnectionOptions,
) {
  const parsed = localCliConnectionSchema.safeParse(value);
  assert(parsed.success, 400, '本机 CLI 连接描述无效');
  const file = assertLocalCliConnectionPath(input, options),
    dirs = ancestors(file),
    temporary = file + '.tmp-' + randomUUID();
  let fd: number | undefined, owned: BigIntStats | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    owned = fstatSync(fd, { bigint: true });
    writeFileSync(fd, JSON.stringify(parsed.data) + '\n');
    fsyncSync(fd);
    const written = fstatSync(fd, { bigint: true });
    closeSync(fd);
    fd = undefined;
    currentDirectories(dirs);
    assert(assertLocalCliConnectionPath(input, options) === file, 409, '本机 CLI 连接目录已改变');
    assert(
      isDeepStrictEqual(
        fileIdentity(written),
        fileIdentity(lstatSync(temporary, { bigint: true })),
      ),
      409,
      '本机 CLI 临时连接文件已改变',
    );
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      if (owned && same(owned, lstatSync(temporary, { bigint: true }))) unlinkSync(temporary);
    } catch {
      /* Never remove a replacement. */
    }
  }
  const lease = readLocalCliConnection(input);
  return {
    ...lease,
    remove() {
      try {
        lease.assertCurrent();
        unlinkSync(file);
      } catch {
        /* A new instance owns a replaced descriptor. */
      }
    },
  };
}
