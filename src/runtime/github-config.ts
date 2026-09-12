import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve, relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppError, assert, id } from '../protocol';
import { createGitHubClient } from './github-client';

// This is a local process control contract, never a relay/session document schema.
export const GITHUB_API_VERSION = '2026-03-10';
const ownerSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
const repoSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/)
  .refine((value) => value !== '.' && value !== '..');
const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const tokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const edit = z.object({ expectedRevision: revision });
export const githubConfigActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  edit
    .extend({
      action: z.literal('credential-save'),
      credentialId: id.optional(),
      label: labelSchema,
      token: tokenSchema,
    })
    .strict(),
  edit.extend({ action: z.literal('credential-remove'), credentialId: id }).strict(),
  edit.extend({ action: z.literal('credential-check'), credentialId: id }).strict(),
  edit
    .extend({
      action: z.literal('project-bind'),
      localProjectId: id,
      credentialId: id,
      owner: ownerSchema,
      repo: repoSchema,
    })
    .strict(),
  edit.extend({ action: z.literal('project-unbind'), localProjectId: id }).strict(),
  edit.extend({ action: z.literal('project-check'), localProjectId: id }).strict(),
  edit
    .extend({ action: z.literal('project-writes'), localProjectId: id, enabled: z.boolean() })
    .strict(),
]);
export type GitHubConfigAction = z.infer<typeof githubConfigActionSchema>;
const identitySchema = z
  .object({ workspaceId: id, machineId: id, userId: z.string().min(1).max(200) })
  .strict();
export type GitHubConfigIdentity = z.infer<typeof identitySchema>;
export type GitHubLocalProject = { id: string; name: string; rootPath: string };
const statusSchema = z
  .object({
    state: z.enum(['unchecked', 'connected', 'denied', 'unavailable']),
    checkedAt: z.number().int().nonnegative().optional(),
    login: ownerSchema.optional(),
  })
  .strict();
type Status = z.infer<typeof statusSchema>;
const credentialSchema = z
  .object({ id, label: labelSchema, token: tokenSchema, generation: id, status: statusSchema })
  .strict();
const bindingSchema = z
  .object({
    localProjectId: id,
    credentialId: id,
    owner: ownerSchema,
    repo: repoSchema,
    rootIdentity: z.string(),
    repositoryId: z.number().int().positive().safe().optional(),
    status: statusSchema,
    writesEnabled: z.boolean().default(false),
    writeGeneration: revision.default(0),
  })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    identity: identitySchema,
    revision,
    credentials: z.array(credentialSchema).max(20),
    projects: z.array(bindingSchema).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.credentials.map((c) => c.id)).size !== value.credentials.length ||
      new Set(value.projects.map((p) => p.localProjectId)).size !== value.projects.length ||
      value.projects.some((p) => !value.credentials.some((c) => c.id === p.credentialId))
    )
      ctx.addIssue({ code: 'custom', message: 'GitHub 本机配置引用无效' });
  });
type Config = z.infer<typeof configSchema>;
type Binding = z.infer<typeof bindingSchema>;
const hash = (value: unknown) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
function rootIdentity(root: string) {
  try {
    const path = realpathSync(root),
      info = lstatSync(path, { bigint: true });
    assert(info.isDirectory(), 409, '项目目录不可用');
    return hash([path, String(info.dev), String(info.ino)]);
  } catch {
    throw new AppError(409, '项目目录不可用，请重新登记项目');
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
export type GitHubConfigVerifier = {
  getUser(token: string, assertCurrent?: () => void): Promise<{ login: string }>;
  getRepository(
    token: string,
    owner: string,
    repo: string,
    assertCurrent?: () => void,
  ): Promise<{ id: number; owner: string; repo: string }>;
};
// The shared HTTP client enforces authority, redirect, size and time limits.
export function githubConfigVerifier(fetcher: typeof fetch = fetch): GitHubConfigVerifier {
  return {
    getUser: (token, assertCurrent) =>
      createGitHubClient({ token, fetch: fetcher, assertCurrent }).getUser(),
    async getRepository(token, owner, repo, assertCurrent) {
      const result = await createGitHubClient({
        token,
        fetch: fetcher,
        assertCurrent,
      }).getRepository({
        owner,
        repo,
      });
      return { id: result.id, owner: result.owner, repo: result.name };
    },
  };
}
export type GitHubProjectConfig = {
  localProjectId: string;
  owner: string;
  repo: string;
  token: string;
  credentialId: string;
  repositoryId: number;
  version: string;
  writesEnabled?: boolean;
};
export class GitHubConfig {
  private readonly file: string;
  private readonly verifier: GitHubConfigVerifier;
  constructor(
    file: string,
    private options: {
      identity: GitHubConfigIdentity | (() => GitHubConfigIdentity);
      projects: () => GitHubLocalProject[];
      verifier?: GitHubConfigVerifier;
      now?: () => number;
      changed?: () => void;
      write?: (file: string, config: Config) => void;
    },
  ) {
    this.file = resolve(file);
    assert(
      basename(this.file).toLowerCase() === 'github-v1.json',
      409,
      'GitHub 私有配置必须使用 github-v1.json 文件名',
    );
    this.verifier = options.verifier ?? githubConfigVerifier();
  }
  private identity() {
    return identitySchema.parse(
      typeof this.options.identity === 'function' ? this.options.identity() : this.options.identity,
    );
  }
  private outsideProjects() {
    try {
      const canonical = nearestRealPath(this.file);
      for (const project of this.options.projects()) {
        const paths = [resolve(project.rootPath)];
        try {
          paths.push(realpathSync(project.rootPath));
        } catch {
          /* Keep lexical protection for unavailable projects. */
        }
        for (const root of paths)
          for (const file of [this.file, canonical]) {
            const rest = relative(root, file);
            assert(
              rest !== '' && (rest === '..' || rest.startsWith('../') || isAbsolute(rest)),
              409,
              'GitHub 私有数据目录不能位于已登记项目内，请将运行数据迁移到代码目录外',
            );
          }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(409, 'GitHub 私有数据目录不可验证');
    }
  }
  private load(): Config {
    this.outsideProjects();
    let fd: number | undefined;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      assert(
        info.isFile() && info.size <= 512 * 1024 && (info.mode & 0o077) === 0,
        409,
        'GitHub 本机配置权限或格式需要检查',
      );
      const result = configSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
      assert(
        isDeepStrictEqual(result.identity, this.identity()),
        409,
        'GitHub 配置不属于当前执行主机账号',
      );
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          version: 1,
          identity: this.identity(),
          revision: 0,
          credentials: [],
          projects: [],
        };
      if (error instanceof AppError) throw error;
      throw new AppError(409, 'GitHub 本机配置无法安全读取');
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private commit(config: Config, expectedRevision: number) {
    assert(
      this.load().revision === expectedRevision &&
        isDeepStrictEqual(config.identity, this.identity()),
      409,
      'GitHub 本机配置已变化，请刷新',
    );
    const next = configSchema.parse({ ...config, revision: expectedRevision + 1 });
    try {
      (this.options.write ?? writePrivate)(this.file, next);
    } catch {
      throw new AppError(500, 'GitHub 本机配置保存失败，请重新读取状态');
    }
    try {
      this.options.changed?.();
    } catch {
      /* Publication does not change durable success. */
    }
    return next;
  }
  private project(id: string) {
    const project = this.options.projects().find((p) => p.id === id);
    assert(project, 404, '项目尚未登记在此执行主机');
    return project;
  }
  read() {
    const config = this.load();
    return {
      revision: config.revision,
      credentials: config.credentials.map(({ id, label, status }) => ({ id, label, status })),
      projects: this.options.projects().map((project) => {
        const binding = config.projects.find((p) => p.localProjectId === project.id);
        let current = false;
        try {
          current = !!binding && binding.rootIdentity === rootIdentity(project.rootPath);
        } catch {}
        return {
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
          ...(binding
            ? {
                binding: {
                  credentialId: binding.credentialId,
                  owner: binding.owner,
                  repo: binding.repo,
                  repositoryId: binding.repositoryId,
                  status: current ? binding.status : { state: 'unavailable' as const },
                  current,
                  writesEnabled: binding.writesEnabled,
                },
              }
            : {}),
        };
      }),
    };
  }
  getProject(localProjectId: string): GitHubProjectConfig {
    const config = this.load(),
      binding = config.projects.find((p) => p.localProjectId === localProjectId),
      project = this.project(localProjectId);
    assert(
      binding?.status.state === 'connected' &&
        binding.repositoryId &&
        binding.rootIdentity === rootIdentity(project.rootPath),
      409,
      '项目尚未验证 GitHub 仓库，请在执行电脑设置中登记',
    );
    const credential = config.credentials.find((c) => c.id === binding.credentialId);
    assert(credential, 409, '项目 GitHub 凭据不可用');
    return {
      localProjectId,
      owner: binding.owner,
      repo: binding.repo,
      token: credential.token,
      credentialId: credential.id,
      repositoryId: binding.repositoryId,
      writesEnabled: binding.writesEnabled,
      version: hash([
        config.identity,
        binding.localProjectId,
        binding.owner,
        binding.repo,
        binding.repositoryId,
        binding.rootIdentity,
        credential.id,
        credential.generation,
        binding.writesEnabled,
        binding.writeGeneration,
      ]),
    };
  }
  isCurrent(value: GitHubProjectConfig) {
    try {
      return isDeepStrictEqual(this.getProject(value.localProjectId), value);
    } catch {
      return false;
    }
  }
  async handle(input: unknown) {
    const parsed = githubConfigActionSchema.safeParse(input);
    assert(parsed.success, 400, 'GitHub 本机配置请求无效');
    const action = parsed.data;
    if (action.action === 'read') return this.read();
    let config = this.load();
    assert(config.revision === action.expectedRevision, 409, 'GitHub 本机配置已变化，请刷新');
    if (action.action === 'credential-save') {
      const existing = action.credentialId
        ? config.credentials.find((c) => c.id === action.credentialId)
        : undefined;
      assert(!action.credentialId || existing, 404, 'GitHub 凭据不存在');
      const credentialId = existing?.id ?? 'github_' + randomUUID();
      config.credentials = config.credentials.filter((c) => c.id !== credentialId);
      config.credentials.push({
        id: credentialId,
        label: action.label,
        token: action.token,
        generation: randomUUID(),
        status: { state: 'unchecked' },
      });
      config.projects = config.projects.map((p) =>
        p.credentialId === credentialId ? { ...p, status: { state: 'unchecked' } } : p,
      );
      this.commit(config, action.expectedRevision);
    } else if (action.action === 'credential-remove') {
      assert(
        config.credentials.some((c) => c.id === action.credentialId),
        404,
        'GitHub 凭据不存在',
      );
      config.credentials = config.credentials.filter((c) => c.id !== action.credentialId);
      config.projects = config.projects.filter((p) => p.credentialId !== action.credentialId);
      this.commit(config, action.expectedRevision);
    } else if (action.action === 'project-unbind') {
      this.project(action.localProjectId);
      config.projects = config.projects.filter((p) => p.localProjectId !== action.localProjectId);
      this.commit(config, action.expectedRevision);
    } else if (action.action === 'project-writes') {
      const project = this.project(action.localProjectId);
      const binding = config.projects.find((p) => p.localProjectId === project.id);
      assert(binding, 404, '项目 GitHub 登记不存在');
      if (action.enabled)
        assert(
          binding.status.state === 'connected' &&
            binding.repositoryId &&
            binding.rootIdentity === rootIdentity(project.rootPath),
          409,
          '启用外部写入前请先验证项目仓库',
        );
      binding.writesEnabled = action.enabled;
      binding.writeGeneration = config.revision + 1;
      this.commit(config, action.expectedRevision);
    } else if (action.action === 'credential-check') {
      const credential = config.credentials.find((c) => c.id === action.credentialId);
      assert(credential, 404, 'GitHub 凭据不存在');
      let status: Status;
      try {
        const result = await this.verifier.getUser(credential.token, () => {
          assert(
            this.load().revision === action.expectedRevision,
            409,
            'GitHub 本机配置已变化，请刷新',
          );
        });
        const login = ownerSchema.safeParse(result.login);
        assert(login.success, 502, 'GitHub 账号身份不可验证');
        status = {
          state: 'connected',
          login: login.data,
          checkedAt: (this.options.now ?? Date.now)(),
        };
      } catch (error) {
        status = this.failure(error);
      }
      credential.status = status;
      if (status.state !== 'connected')
        config.projects = config.projects.map((binding) =>
          binding.credentialId === credential.id
            ? { ...binding, status: { state: 'unchecked' } }
            : binding,
        );
      this.commit(config, action.expectedRevision);
    } else {
      const project = this.project(action.localProjectId);
      if (action.action === 'project-bind') {
        assert(
          config.credentials.some((c) => c.id === action.credentialId),
          404,
          'GitHub 凭据不存在',
        );
        config.projects = config.projects.filter((p) => p.localProjectId !== action.localProjectId);
        config.projects.push({
          localProjectId: project.id,
          credentialId: action.credentialId,
          owner: action.owner,
          repo: action.repo,
          rootIdentity: rootIdentity(project.rootPath),
          status: { state: 'unchecked' },
          writesEnabled: false,
          writeGeneration: config.revision + 1,
        });
        config = this.commit(config, action.expectedRevision);
      }
      const binding = config.projects.find((p) => p.localProjectId === project.id);
      assert(
        binding && binding.rootIdentity === rootIdentity(project.rootPath),
        409,
        '项目 GitHub 登记已变化，请重新登记',
      );
      await this.verifyProject(config, binding);
    }
    return this.read();
  }
  private failure(error: unknown): Status {
    return {
      state:
        error instanceof AppError && [401, 403, 404].includes(error.status)
          ? 'denied'
          : 'unavailable',
      checkedAt: (this.options.now ?? Date.now)(),
    };
  }
  private async verifyProject(config: Config, binding: Binding) {
    const credential = config.credentials.find((c) => c.id === binding.credentialId)!;
    try {
      const result = await this.verifier.getRepository(
        credential.token,
        binding.owner,
        binding.repo,
        () => {
          assert(
            this.load().revision === config.revision &&
              binding.rootIdentity === rootIdentity(this.project(binding.localProjectId).rootPath),
            409,
            'GitHub 本机配置已变化，请刷新',
          );
        },
      );
      assert(
        Number.isSafeInteger(result.id) &&
          result.id > 0 &&
          result.owner.toLowerCase() === binding.owner.toLowerCase() &&
          result.repo.toLowerCase() === binding.repo.toLowerCase() &&
          (!binding.repositoryId || result.id === binding.repositoryId),
        403,
        'GitHub 仓库身份已变化，请重新登记',
      );
      binding.repositoryId = result.id;
      binding.status = { state: 'connected', checkedAt: (this.options.now ?? Date.now)() };
    } catch (error) {
      binding.status = this.failure(error);
    }
    assert(
      binding.rootIdentity === rootIdentity(this.project(binding.localProjectId).rootPath),
      409,
      '项目目录已变化，请重新登记',
    );
    this.commit(config, config.revision);
  }
}
export type GitHubConfigState = ReturnType<GitHubConfig['read']>;
