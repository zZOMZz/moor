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
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppError, assert, id } from '../protocol';
import { previewPathSchema, type PreviewService } from '../preview-protocol';
import type { ExecutionLease } from './session-execution';

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
const identitySchema = z
  .object({ workspaceId: id, machineId: id, userId: z.string().min(1).max(200) })
  .strict();
export type PreviewConfigIdentity = z.infer<typeof identitySchema>;
export type PreviewLocalTarget = {
  localProjectId: string;
  executionId: string;
  label: string;
  rootPath: string;
  projectRoot: string;
};
const serviceFields = {
  localProjectId: id,
  executionId: id,
  label,
  address: z.enum(['127.0.0.1', '::1']),
  port: z.number().int().min(1).max(65535),
  startPath: previewPathSchema,
};
export const previewConfigActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({
      action: z.literal('service-save'),
      expectedRevision: revision,
      id: id.optional(),
      ...serviceFields,
      enabled: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal('service-remove'), expectedRevision: revision, id }).strict(),
  z
    .object({
      action: z.literal('service-enabled'),
      expectedRevision: revision,
      id,
      enabled: z.boolean(),
    })
    .strict(),
]);
export type PreviewConfigAction = z.infer<typeof previewConfigActionSchema>;
const recordSchema = z
  .object({
    id,
    ...serviceFields,
    enabled: z.boolean(),
    generation: revision,
    rootIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    projectRootIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    identity: identitySchema,
    revision,
    services: z.array(recordSchema).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.services.map((s) => s.id)).size !== value.services.length ||
      value.services.some((s) => s.generation > value.revision)
    )
      ctx.addIssue({ code: 'custom', message: '预览配置引用无效' });
    for (let i = 0; i < value.services.length; i++)
      for (let j = i + 1; j < value.services.length; j++) {
        const a = value.services[i]!,
          b = value.services[j]!;
        if (
          origin(a) === origin(b) &&
          (a.localProjectId !== b.localProjectId || a.executionId !== b.executionId)
        )
          ctx.addIssue({ code: 'custom', message: '预览地址重复分配' });
      }
  });
type Config = z.infer<typeof configSchema>;
type ServiceRecord = z.infer<typeof recordSchema>;
export type PreviewServiceBinding = PreviewService & {
  origin: string;
  localProjectId: string;
  executionId: string;
  rootIdentity: string;
  projectRootIdentity: string;
};
export type PreviewConfigState = {
  revision: number;
  targets: PreviewLocalTarget[];
  services: (Pick<
    ServiceRecord,
    'id' | 'localProjectId' | 'executionId' | 'label' | 'address' | 'port' | 'startPath' | 'enabled'
  > & { current: boolean })[];
};
const hash = (value: unknown) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const origin = (value: { address: string; port: number }) =>
  new URL('http://' + (value.address === '::1' ? '[::1]' : value.address) + ':' + value.port)
    .origin;
function rootIdentity(root: string) {
  try {
    const path = realpathSync(root),
      info = lstatSync(path, { bigint: true });
    assert(info.isDirectory(), 409, '预览目录不可用');
    return hash([path, String(info.dev), String(info.ino)]);
  } catch {
    throw new AppError(409, '预览执行目录不可用，请刷新本机设置');
  }
}
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
function writePrivate(file: string, value: Config) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp-' + randomUUID();
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, JSON.stringify(value) + '\n');
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

// This configuration is edited only through local process control. Registering a
// service is the operator's assertion of its directory, never proof from HTTP.
export class PreviewConfig {
  private readonly file: string;
  constructor(
    file: string,
    private options: {
      identity: PreviewConfigIdentity | (() => PreviewConfigIdentity);
      targets(): PreviewLocalTarget[];
      blockedOrigins(): string[];
      changed?(): void;
      write?(file: string, config: Config): void;
    },
  ) {
    this.file = resolve(file);
    assert(
      basename(this.file).toLowerCase() === 'preview-v1.json',
      409,
      '预览私有配置必须使用 preview-v1.json 文件名',
    );
  }
  private identity() {
    return identitySchema.parse(
      typeof this.options.identity === 'function' ? this.options.identity() : this.options.identity,
    );
  }
  private targets() {
    const values = this.options.targets();
    assert(values.length <= 1000, 409, '可用预览执行目录超过限制');
    const seen = new Map<string, PreviewLocalTarget>();
    for (const target of values) {
      id.parse(target.localProjectId);
      id.parse(target.executionId);
      assert(
        target.label.length > 0 &&
          target.label.length <= 200 &&
          target.rootPath.length <= 4096 &&
          target.projectRoot.length <= 4096,
        409,
        '预览执行目录列表无效',
      );
      const key = JSON.stringify([target.localProjectId, target.executionId]),
        prior = seen.get(key);
      assert(
        !prior || (prior.rootPath === target.rootPath && prior.projectRoot === target.projectRoot),
        409,
        '预览执行目录绑定冲突',
      );
      if (!prior) seen.set(key, { ...target });
    }
    return [...seen.values()];
  }
  private outsideTargets() {
    try {
      const canonical = nearestRealPath(this.file);
      for (const target of this.targets())
        for (const root of [target.rootPath, target.projectRoot]) {
          const roots = [resolve(root)];
          try {
            roots.push(realpathSync(root));
          } catch {
            /* Retain lexical protection for missing targets. */
          }
          for (const path of roots)
            for (const file of [this.file, canonical]) {
              const rest = relative(path, file);
              assert(
                rest !== '' && (rest === '..' || rest.startsWith('../') || isAbsolute(rest)),
                409,
                '预览私有配置必须保存在项目目录外',
              );
            }
        }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(409, '预览私有配置目录不可验证');
    }
  }
  private load(): Config {
    this.outsideTargets();
    let fd: number | undefined;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      assert(
        info.isFile() && info.size <= 512 * 1024 && (info.mode & 0o077) === 0,
        409,
        '预览本机配置权限或格式需要检查',
      );
      const bytes = Buffer.alloc(512 * 1024 + 1);
      let length = 0,
        count: number;
      while (
        length < bytes.length &&
        (count = readSync(fd, bytes, length, bytes.length - length, null)) !== 0
      )
        length += count;
      assert(length <= 512 * 1024 && length === info.size, 409, '预览本机配置已变化，请刷新');
      const value = configSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
      assert(
        isDeepStrictEqual(value.identity, this.identity()),
        409,
        '预览配置不属于当前执行主机账号',
      );
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { version: 1, identity: this.identity(), revision: 0, services: [] };
      if (error instanceof AppError) throw error;
      throw new AppError(409, '预览本机配置无法安全读取');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private target(record: Pick<ServiceRecord, 'localProjectId' | 'executionId'>) {
    return this.targets().find(
      (t) => t.localProjectId === record.localProjectId && t.executionId === record.executionId,
    );
  }
  private allowedOrigin(record: Pick<ServiceRecord, 'address' | 'port'>) {
    // The same loopback port is blocked on both address families: a Moor server
    // may be dual-stack even when its published origin names one family.
    return !this.options.blockedOrigins().some((value) => {
      try {
        const blocked = new URL(value);
        return (
          ['localhost', '127.0.0.1', '[::1]'].includes(blocked.hostname) &&
          Number(blocked.port || (blocked.protocol === 'https:' ? 443 : 80)) === record.port
        );
      } catch {
        return true;
      }
    });
  }
  private current(record: ServiceRecord, target = this.target(record)) {
    try {
      return (
        !!target &&
        this.allowedOrigin(record) &&
        record.rootIdentity === rootIdentity(target.rootPath) &&
        record.projectRootIdentity === rootIdentity(target.projectRoot)
      );
    } catch {
      return false;
    }
  }
  read(): PreviewConfigState {
    const config = this.load();
    return {
      revision: config.revision,
      targets: this.targets(),
      services: config.services.map((record) => ({
        id: record.id,
        localProjectId: record.localProjectId,
        executionId: record.executionId,
        label: record.label,
        address: record.address,
        port: record.port,
        startPath: record.startPath,
        enabled: record.enabled,
        current: this.current(record),
      })),
    };
  }
  getServices(lease: ExecutionLease): PreviewService[] {
    const config = this.load();
    this.checkScope(config, lease);
    return config.services
      .map((record) => this.binding(config, record, lease))
      .filter((value): value is PreviewServiceBinding => !!value)
      .map(({ id, label, version, startPath }) => ({ id, label, version, startPath }));
  }
  private checkScope(config: Config, lease: ExecutionLease) {
    assert(
      config.identity.workspaceId === lease.workspaceId &&
        config.identity.machineId === lease.machineId &&
        config.identity.userId === lease.userId,
      404,
      '预览服务不属于当前执行范围',
    );
  }
  private binding(
    config: Config,
    record: ServiceRecord,
    lease: ExecutionLease,
  ): PreviewServiceBinding | undefined {
    if (
      !record.enabled ||
      record.localProjectId !== lease.localProjectId ||
      record.executionId !== lease.executionId ||
      !this.current(record)
    )
      return;
    if (
      record.rootIdentity !== rootIdentity(lease.rootPath) ||
      record.projectRootIdentity !== rootIdentity(lease.projectRoot)
    )
      return;
    return {
      id: record.id,
      label: record.label,
      startPath: record.startPath,
      version: hash([config.identity, record]),
      origin: origin(record),
      localProjectId: record.localProjectId,
      executionId: record.executionId,
      rootIdentity: record.rootIdentity,
      projectRootIdentity: record.projectRootIdentity,
    };
  }
  getService(lease: ExecutionLease, serviceId: string): PreviewServiceBinding | undefined {
    const config = this.load();
    this.checkScope(config, lease);
    const record = config.services.find((s) => s.id === serviceId);
    return record && this.binding(config, record, lease);
  }
  isCurrent(binding: PreviewServiceBinding, lease: ExecutionLease) {
    try {
      return isDeepStrictEqual(this.getService(lease, binding.id), binding);
    } catch {
      return false;
    }
  }
  handle(input: unknown): PreviewConfigState {
    const parsed = previewConfigActionSchema.safeParse(input);
    assert(parsed.success, 400, '预览本机设置请求无效');
    const action = parsed.data;
    if (action.action === 'read') return this.read();
    const config = this.load();
    assert(config.revision === action.expectedRevision, 409, '预览本机配置已变化，请刷新');
    const prior =
      'id' in action && action.id ? config.services.find((s) => s.id === action.id) : undefined;
    if ('id' in action && action.id) assert(prior, 404, '预览服务登记不存在');
    if (action.action === 'service-save') {
      const target = this.target(action);
      assert(target, 409, '预览执行目录不存在或尚未就绪，请刷新');
      assert(this.allowedOrigin(action), 409, '不能将 Moor 自身的服务登记为项目预览');
      assert(
        config.services.filter(
          (s) =>
            s.localProjectId === action.localProjectId &&
            s.executionId === action.executionId &&
            s.id !== prior?.id,
        ).length < 20,
        409,
        '该执行目录的预览服务超过限制',
      );
      assert(
        !config.services.some(
          (s) =>
            s.id !== prior?.id &&
            origin(s) === origin(action) &&
            (s.localProjectId !== action.localProjectId || s.executionId !== action.executionId),
        ),
        409,
        '该预览地址已登记到其他执行目录，请先删除原登记',
      );
      if (prior)
        assert(
          prior.localProjectId === action.localProjectId &&
            prior.executionId === action.executionId,
          409,
          '修改执行目录前请删除原服务登记',
        );
      const record: ServiceRecord = {
        ...serviceFieldsFrom(action),
        id: prior?.id ?? randomUUID(),
        enabled: action.enabled ?? false,
        generation: config.revision + 1,
        rootIdentity: rootIdentity(target.rootPath),
        projectRootIdentity: rootIdentity(target.projectRoot),
      };
      config.services = config.services.filter((s) => s.id !== record.id).concat(record);
    } else if (action.action === 'service-remove')
      config.services = config.services.filter((s) => s.id !== action.id);
    else {
      assert(prior, 404, '预览服务登记不存在');
      assert(
        !action.enabled || this.current(prior),
        409,
        '预览登记的执行目录或地址已变化，请重新登记',
      );
      prior.enabled = action.enabled;
      prior.generation = config.revision + 1;
    }
    assert(
      this.load().revision === action.expectedRevision &&
        isDeepStrictEqual(config.identity, this.identity()),
      409,
      '预览本机配置已变化，请刷新',
    );
    const next = configSchema.parse({ ...config, revision: config.revision + 1 });
    try {
      (this.options.write ?? writePrivate)(this.file, next);
    } catch {
      throw new AppError(500, '预览本机配置保存失败，请重新读取');
    }
    try {
      this.options.changed?.();
    } catch {
      /* Durable success does not depend on notification delivery. */
    }
    return this.read();
  }
}
function serviceFieldsFrom(
  value: z.infer<typeof previewConfigActionSchema> & { action: 'service-save' },
) {
  return {
    localProjectId: value.localProjectId,
    executionId: value.executionId,
    label: value.label,
    address: value.address,
    port: value.port,
    startPath: value.startPath,
  };
}
