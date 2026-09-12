import { createHash, randomUUID } from 'node:crypto';
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
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppError, assert, id } from '../protocol';

const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const label = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\x00-\x1f\x7f]+$/u);
const rootPath = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\x00-\x1f\x7f]+$/u)
  .refine(isAbsolute);
const identitySchema = z
  .object({ workspaceId: id, userId: z.string().min(1).max(200), machineId: id })
  .strict();
export type SkillsConfigIdentity = z.infer<typeof identitySchema>;
export const skillsConfigActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({
      action: z.literal('source-save'),
      expectedRevision: revision,
      id: id.optional(),
      label,
      rootPath,
      enabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('source-enabled'),
      expectedRevision: revision,
      id,
      enabled: z.boolean(),
    })
    .strict(),
  z.object({ action: z.literal('source-remove'), expectedRevision: revision, id }).strict(),
]);
export type SkillsConfigAction = z.infer<typeof skillsConfigActionSchema>;
const sourceSchema = z
  .object({
    id,
    label,
    rootPath,
    enabled: z.boolean(),
    generation: revision,
    rootIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    identity: identitySchema,
    revision,
    sources: z.array(sourceSchema).max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.sources.map((s) => s.id)).size !== value.sources.length ||
      new Set(value.sources.map((s) => s.rootPath)).size !== value.sources.length ||
      value.sources.some((s) => s.generation > value.revision)
    )
      ctx.addIssue({ code: 'custom', message: 'Skills 配置引用无效' });
  });
type Config = z.infer<typeof configSchema>;
type Source = z.infer<typeof sourceSchema>;
// Host-only bindings: rootPath is never a public protocol field.
export type SkillsSourceBinding = Pick<Source, 'id' | 'label' | 'rootPath' | 'rootIdentity'> & {
  version: string;
};
export type SkillsConfigReadLease = {
  sources: SkillsSourceBinding[];
  assertCurrent(): void;
};
export type SkillsConfigState = {
  revision: number;
  sources: (Pick<Source, 'id' | 'label' | 'rootPath' | 'enabled'> & { current: boolean })[];
};
const hash = (value: unknown) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contains = (parent: string, path: string) => {
  const rest = relative(parent, path);
  return rest === '' || (rest !== '..' && !rest.startsWith('../') && !isAbsolute(rest));
};
function nearestRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(nearestRealPath(parent), basename(path));
  }
}

function configurationSnapshot(file: string) {
  try {
    const canonical = nearestRealPath(file);
    const entries = new Map<string, unknown>();
    // Pin both spelling and resolved ancestry, including any permitted parent alias.
    // A missing ancestor is pinned too: creating the first config invalidates the lease.
    for (const target of new Set([file, canonical])) {
      const anchor = parse(target).root;
      let path = anchor;
      for (const part of ['', ...target.slice(anchor.length).split('/').filter(Boolean)]) {
        if (part) path = join(path, part);
        if (entries.has(path)) continue;
        try {
          const stat = lstatSync(path, { bigint: true });
          const entry = {
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode,
            uid: stat.uid,
            gid: stat.gid,
          };
          entries.set(
            path,
            stat.isDirectory()
              ? entry
              : { ...entry, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs },
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          entries.set(path, 'missing');
          break;
        }
      }
    }
    return { canonical, entries };
  } catch {
    throw new AppError(409, 'Skills 配置文件或目录已变化，请重新读取');
  }
}
function directory(root: string) {
  try {
    const input = resolve(root),
      before = lstatSync(input, { bigint: true });
    assert(
      before.isDirectory() && !before.isSymbolicLink(),
      409,
      'Skills 目录必须是存在的真实目录，不能是符号链接',
    );
    const path = realpathSync(input),
      after = lstatSync(path, { bigint: true });
    assert(
      after.isDirectory() && before.dev === after.dev && before.ino === after.ino,
      409,
      'Skills 目录已变化，请重新登记',
    );
    return { rootPath: path, rootIdentity: hash([path, String(after.dev), String(after.ino)]) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(409, 'Skills 目录不可用，请重新登记');
  }
}
function writePrivate(file: string, config: Config) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp-' + randomUUID();
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, JSON.stringify(config) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export class SkillsConfig {
  private readonly file: string;
  constructor(
    file: string,
    private options: {
      identity: SkillsConfigIdentity | (() => SkillsConfigIdentity);
      projectRoots(): string[];
      privateRoots: string[];
      changed?(): void;
      write?(file: string, config: Config): void;
    },
  ) {
    this.file = resolve(file);
    assert(
      basename(this.file).toLowerCase() === 'skills-v1.json',
      409,
      'Skills 私有配置必须使用 skills-v1.json 文件名',
    );
  }
  private identity() {
    return identitySchema.parse(
      typeof this.options.identity === 'function' ? this.options.identity() : this.options.identity,
    );
  }
  private outsideProjects() {
    try {
      const canonical = nearestRealPath(this.file);
      for (const root of this.options.projectRoots()) {
        assert(isAbsolute(root), 409, 'Skills 私有配置目录不可验证');
        const paths = [resolve(root), nearestRealPath(root)];
        for (const path of paths)
          assert(
            !contains(path, this.file) && !contains(path, canonical),
            409,
            'Skills 私有配置必须保存在项目目录外',
          );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(409, 'Skills 私有配置目录不可验证');
    }
  }
  private safeSource(root: string) {
    const actual = directory(root);
    try {
      for (const privateRoot of [dirname(this.file), ...this.options.privateRoots]) {
        assert(isAbsolute(privateRoot), 409, 'Skills 私有目录范围不可验证');
        for (const protectedPath of [resolve(privateRoot), nearestRealPath(privateRoot)])
          for (const sourcePath of [resolve(root), actual.rootPath])
            assert(
              !contains(sourcePath, protectedPath) && !contains(protectedPath, sourcePath),
              409,
              'Skills 目录不能包含或位于 Moor 私有数据目录',
            );
      }
      return actual;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(409, 'Skills 私有目录范围不可验证');
    }
  }
  private load(): Config {
    this.outsideProjects();
    let fd: number | undefined;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      assert(
        info.isFile() &&
          info.size <= 128 * 1024 &&
          (info.mode & 0o077) === 0 &&
          (typeof process.getuid !== 'function' || info.uid === process.getuid()),
        409,
        'Skills 本机配置权限或格式需要检查',
      );
      const bytes = Buffer.alloc(128 * 1024 + 1);
      let length = 0,
        count: number;
      while (
        length < bytes.length &&
        (count = readSync(fd, bytes, length, bytes.length - length, null)) !== 0
      )
        length += count;
      assert(length <= 128 * 1024 && length === info.size, 409, 'Skills 本机配置已变化，请刷新');
      const value = configSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
      assert(
        isDeepStrictEqual(value.identity, this.identity()),
        409,
        'Skills 配置不属于当前执行主机账号',
      );
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, identity: this.identity(), revision: 0, sources: [] };
      if (error instanceof AppError) throw error;
      throw new AppError(409, 'Skills 本机配置无法安全读取');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private current(source: Source) {
    try {
      return isDeepStrictEqual(this.safeSource(source.rootPath), {
        rootPath: source.rootPath,
        rootIdentity: source.rootIdentity,
      });
    } catch {
      return false;
    }
  }
  read(): SkillsConfigState {
    const config = this.load();
    return {
      revision: config.revision,
      sources: config.sources.map((s) => ({
        id: s.id,
        label: s.label,
        rootPath: s.rootPath,
        enabled: s.enabled,
        current: this.current(s),
      })),
    };
  }
  getSources(scope: SkillsConfigIdentity): SkillsSourceBinding[] {
    const config = this.load();
    assert(
      config.identity.workspaceId === scope.workspaceId &&
        config.identity.userId === scope.userId &&
        config.identity.machineId === scope.machineId,
      404,
      'Skills 目录不属于当前执行范围',
    );
    return config.sources
      .filter((s) => s.enabled && this.current(s))
      .map((s) => ({
        id: s.id,
        label: s.label,
        rootPath: s.rootPath,
        rootIdentity: s.rootIdentity,
        version: hash([config.identity, s]),
      }));
  }
  /**
   * Full authorization is checked once before returning this process-local lease.
   * The filesystem reader pins source roots itself; callers must also compare fresh
   * getSources() before returning content. These checks do not cache authorization
   * for a time interval and never rebind a modified configuration automatically.
   */
  createReadLease(scope: SkillsConfigIdentity): SkillsConfigReadLease {
    const identity = this.identity();
    assert(
      identity.workspaceId === scope.workspaceId &&
        identity.userId === scope.userId &&
        identity.machineId === scope.machineId,
      404,
      'Skills 目录不属于当前执行范围',
    );
    const snapshot = configurationSnapshot(this.file);
    const assertCurrent = () => {
      assert(
        isDeepStrictEqual(this.identity(), identity) &&
          isDeepStrictEqual(configurationSnapshot(this.file), snapshot),
        409,
        'Skills 配置文件或执行账号已变化，请重新读取',
      );
    };
    const sources = this.getSources(scope);
    // Do not combine the old parsed authorization with a newer filesystem snapshot.
    assertCurrent();
    return { sources, assertCurrent };
  }
  isCurrent(binding: SkillsSourceBinding, scope: SkillsConfigIdentity): boolean {
    try {
      return isDeepStrictEqual(
        this.getSources(scope).find((s) => s.id === binding.id),
        binding,
      );
    } catch {
      return false;
    }
  }
  handle(input: unknown): SkillsConfigState {
    const parsed = skillsConfigActionSchema.safeParse(input);
    assert(parsed.success, 400, 'Skills 本机设置请求无效');
    const action = parsed.data;
    if (action.action === 'read') return this.read();
    const config = this.load();
    assert(config.revision === action.expectedRevision, 409, 'Skills 本机配置已变化，请刷新');
    const prior =
      'id' in action && action.id ? config.sources.find((s) => s.id === action.id) : undefined;
    if ('id' in action && action.id) assert(prior, 404, 'Skills 目录登记不存在');
    if (action.action === 'source-save') {
      const actual = this.safeSource(action.rootPath);
      assert(
        !config.sources.some((s) => s.id !== prior?.id && s.rootPath === actual.rootPath),
        409,
        'Skills 目录已经登记',
      );
      assert(prior || config.sources.length < 20, 409, 'Skills 目录数量超过限制');
      const source: Source = {
        id: prior?.id ?? randomUUID(),
        label: action.label,
        ...actual,
        enabled: action.enabled ?? false,
        generation: config.revision + 1,
      };
      config.sources = config.sources.filter((s) => s.id !== source.id).concat(source);
    } else if (action.action === 'source-remove')
      config.sources = config.sources.filter((s) => s.id !== action.id);
    else {
      assert(prior, 404, 'Skills 目录登记不存在');
      assert(!action.enabled || this.current(prior), 409, 'Skills 目录已变化，请重新登记');
      prior.enabled = action.enabled;
      prior.generation = config.revision + 1;
    }
    assert(
      this.load().revision === action.expectedRevision &&
        isDeepStrictEqual(config.identity, this.identity()),
      409,
      'Skills 本机配置已变化，请刷新',
    );
    const next = configSchema.parse({ ...config, revision: config.revision + 1 });
    try {
      (this.options.write ?? writePrivate)(this.file, next);
    } catch {
      throw new AppError(500, 'Skills 本机配置保存失败，请重新读取');
    }
    try {
      this.options.changed?.();
    } catch {
      /* Durable success is independent of notices. */
    }
    return this.read();
  }
}
