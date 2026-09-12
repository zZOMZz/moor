import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { AppError, assert } from '../protocol';
import { projectFilePathSchema } from '../content-protocol';
import {
  GIT_LIMITS,
  gitBranchSchema,
  gitOidSchema,
  gitRepositoryStateSchema,
  type GitRepositoryState,
} from '../git-protocol';

export type DirectoryIdentity = { path: string; dev: string; ino: string };
export type GitPointerIdentity = { identity: DirectoryIdentity; hash: string };
export type GitConfigIdentity = { path: string; identity?: DirectoryIdentity; hash?: string };
export type GitRepository = {
  version: 1;
  id: string;
  projectRoot: string;
  rootPath: string;
  commonDir: string;
  gitDir: string;
  projectRelativePath: string;
  projectIdentity: DirectoryIdentity;
  rootIdentity: DirectoryIdentity;
  commonIdentity: DirectoryIdentity;
  gitDirIdentity: DirectoryIdentity;
  pointers: GitPointerIdentity[];
  configs: GitConfigIdentity[];
};
export type WorktreePlan = {
  targetPath: string;
  baseBranch: string;
  expectedOid: string;
  newBranch: string;
};
export type ManagedWorktree = {
  version: 1;
  repositoryId: string;
  plan: WorktreePlan;
  cwd: string;
  rootIdentity: DirectoryIdentity;
  cwdIdentity: DirectoryIdentity;
  gitDirIdentity: DirectoryIdentity;
  parentIdentity: DirectoryIdentity;
  gitFileIdentity: DirectoryIdentity;
  gitFileHash: string;
  pointers: GitPointerIdentity[];
  configs: GitConfigIdentity[];
};
export type WorktreeInspection =
  | { status: 'ready'; managed: ManagedWorktree; state: GitRepositoryState }
  | { status: 'missing' | 'unknown'; reason: string };
export const PROJECT_GIT_LIMITS = {
  outputBytes: 2 * 1024 * 1024,
  records: 20000,
  readTimeout: 10000,
  writeTimeout: 30000,
  operationTimeout: 45000,
  commands: 128,
  totalBytes: 16 * 1024 * 1024,
  attributeFiles: 32,
} as const;
export type ProjectGitOptions = {
  // Host-injected deterministic checkpoints; never supplied by a remote caller.
  checkpoint?: (
    stage: 'before-prepare' | 'after-prepare' | 'before-remove',
  ) => void | Promise<void>;
  outputBytes?: number;
};
type CommandResult = { output: string; code: number };
const budgetKey = Symbol('project-git-budget');
type BudgetOptions = ProjectGitOptions & {
  [budgetKey]?: { until: number; commands: number; bytes: number };
};
function budget(options: ProjectGitOptions): BudgetOptions {
  return (options as BudgetOptions)[budgetKey]
    ? options
    : {
        ...options,
        [budgetKey]: {
          until: Date.now() + PROJECT_GIT_LIMITS.operationTimeout,
          commands: 0,
          bytes: 0,
        },
      };
}
type WorktreeRow = {
  path: string;
  head?: string;
  branch?: string;
  locked?: boolean;
  prunable?: boolean;
  bare?: boolean;
};
const digest = (value: string | Buffer) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const safePath = (value: string) =>
  typeof value === 'string' &&
  isAbsolute(value) &&
  resolve(value) === value &&
  !/[\x00-\x1f\x7f]/u.test(value);
const pathWithin = (parent: string, child: string) =>
  child === parent || child.startsWith(parent + sep);
const gitRelative = (parent: string, child: string) => relative(parent, child).split(sep).join('/');
function boundedFile(path: string, limit: number, expected?: DirectoryIdentity) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    assert(
      before.isFile() &&
        before.size <= BigInt(limit) &&
        (!expected || (String(before.dev) === expected.dev && String(before.ino) === expected.ino)),
      409,
      'Git 元数据文件不可安全读取',
    );
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    assert(
      offset <= limit &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
      409,
      'Git 元数据文件读取期间已变化',
    );
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
function maximum(options: ProjectGitOptions) {
  const value = options.outputBytes ?? PROJECT_GIT_LIMITS.outputBytes;
  assert(
    Number.isSafeInteger(value) && value > 0 && value <= PROJECT_GIT_LIMITS.outputBytes,
    400,
    'Git 读取限制无效',
  );
  return value;
}
function run(
  root: string,
  args: string[],
  options: ProjectGitOptions,
  write = false,
  writing?: () => void,
): Promise<CommandResult> {
  const remaining = (options as BudgetOptions)[budgetKey];
  assert(
    remaining &&
      ++remaining.commands <= PROJECT_GIT_LIMITS.commands &&
      remaining.until > Date.now(),
    409,
    'Git 检查超出操作限制',
  );
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  const maxBuffer = maximum(options);
  return new Promise((done, reject) => {
    writing?.();
    execFile(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'core.trustctime=true',
        '-c',
        'core.checkStat=default',
        '-c',
        'core.ignoreStat=false',
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        '-c',
        'protocol.allow=never',
        '-c',
        'color.ui=false',
        '-C',
        root,
        ...args,
      ],
      {
        env: {
          ...environment,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_NO_LAZY_FETCH: '1',
          LC_ALL: 'C',
        },
        encoding: 'utf8',
        maxBuffer,
        timeout: Math.max(
          1,
          Math.min(
            remaining.until - Date.now(),
            write ? PROJECT_GIT_LIMITS.writeTimeout : PROJECT_GIT_LIMITS.readTimeout,
          ),
        ),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        remaining.bytes += Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
        if (remaining.bytes > PROJECT_GIT_LIMITS.totalBytes) {
          reject(new AppError(409, 'Git 检查超出总读取限制'));
          return;
        }
        if (error && (typeof error.code !== 'number' || error.killed)) {
          reject(
            new AppError(
              502,
              write ? 'Git 操作结果尚未确认，请查询原操作' : 'Git 读取失败或超出限制',
            ),
          );
        } else done({ output: stdout, code: error ? Number(error.code) : 0 });
      },
    );
  });
}
async function command(
  root: string,
  args: string[],
  options: ProjectGitOptions,
  write = false,
  writing?: () => void,
) {
  const result = await run(root, args, options, write, writing);
  assert(
    result.code === 0,
    write ? 502 : 409,
    write ? 'Git 操作结果尚未确认，请查询原操作' : 'Git 状态不可确认，请重新读取',
  );
  return result.output;
}
async function identity(path: string, file = false): Promise<DirectoryIdentity> {
  assert(safePath(path), 409, 'Git 目录位置无效');
  assert((await realpath(path)) === path, 409, 'Git 目录包含符号链接或已移动');
  const stat = await lstat(path, { bigint: true });
  assert(file ? stat.isFile() : stat.isDirectory(), 409, 'Git 目录类型已变化');
  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}
function checkIdentity(expected: DirectoryIdentity, file = false) {
  assert(
    expected && safePath(expected.path) && realpathSync(expected.path) === expected.path,
    409,
    'Git 目录已移动或替换',
  );
  const stat = lstatSync(expected.path, { bigint: true });
  assert(
    (file ? stat.isFile() : stat.isDirectory()) &&
      String(stat.dev) === expected.dev &&
      String(stat.ino) === expected.ino,
    409,
    'Git 目录已移动或替换',
  );
}
function checkRepository(repository: GitRepository) {
  assert(
    repository.version === 1 && repository.id === digest(JSON.stringify(repository.commonIdentity)),
    409,
    'Git 仓库身份无效',
  );
  for (const item of [
    repository.projectIdentity,
    repository.rootIdentity,
    repository.commonIdentity,
    repository.gitDirIdentity,
  ])
    checkIdentity(item);
  for (const pointer of repository.pointers) checkPointer(pointer);
  checkConfigs(repository.configs);
  assert(
    repository.projectRoot === repository.projectIdentity.path &&
      repository.rootPath === repository.rootIdentity.path &&
      repository.commonDir === repository.commonIdentity.path &&
      repository.gitDir === repository.gitDirIdentity.path &&
      pathWithin(repository.rootPath, repository.projectRoot) &&
      gitRelative(repository.rootPath, repository.projectRoot) === repository.projectRelativePath,
    409,
    'Git 项目归属已变化',
  );
}
// Other typed host Git operations reuse the same immutable directory/config lease.
export function validateProjectGitRepository(repository: GitRepository) {
  checkRepository(repository);
}
async function pointer(path: string): Promise<GitPointerIdentity> {
  const item = await identity(path, true);
  assert((await lstat(path)).size <= 4096, 409, 'Git 指针超出检查限制');
  return { identity: item, hash: digest(boundedFile(path, 4096, item)) };
}
function checkPointer(pointer: GitPointerIdentity) {
  checkIdentity(pointer.identity, true);
  assert(
    lstatSync(pointer.identity.path).size <= 4096 &&
      digest(boundedFile(pointer.identity.path, 4096, pointer.identity)) === pointer.hash,
    409,
    'Git 指针归属已变化',
  );
}
function checkConfigs(configs: GitConfigIdentity[]) {
  assert(Array.isArray(configs) && configs.length <= 32, 409, 'Git 配置检查范围无效');
  let size = 0;
  for (const config of configs) {
    assert(safePath(config.path), 409, 'Git 配置路径无效');
    if (!config.identity) {
      let missing = false;
      try {
        lstatSync(config.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
        else throw error;
      }
      assert(missing, 409, 'Git 配置文件存在性已变化');
    } else {
      assert(config.identity.path === config.path, 409, 'Git 配置身份无效');
      checkIdentity(config.identity, true);
      const bytes = boundedFile(config.path, PROJECT_GIT_LIMITS.outputBytes, config.identity);
      size += bytes.length;
      assert(
        size <= PROJECT_GIT_LIMITS.outputBytes && digest(bytes) === config.hash,
        409,
        'Git 配置已变化，请检查执行目录',
      );
    }
  }
}
async function captureConfigs(
  rootPath: string,
  commonDir: string,
  gitDir: string,
  options: ProjectGitOptions,
) {
  const raw = await command(
    rootPath,
    ['config', '--includes', '--null', '--show-origin', '--list'],
    options,
  );
  const records = raw.split('\0'),
    paths = new Set([join(commonDir, 'config'), join(gitDir, 'config.worktree')]);
  for (let index = 0; index < records.length - 1; index += 2) {
    const origin = records[index]!,
      entry = records[index + 1]!;
    if (origin === 'command line:') continue;
    assert(origin.startsWith('file:'), 409, 'Git 配置来源不支持');
    const path = resolve(rootPath, origin.slice(5));
    paths.add(path);
    const separator = entry.indexOf('\n');
    if (
      separator < 0 ||
      !/^include(?:if\..*)?\.path$/u.test(entry.slice(0, separator).toLowerCase())
    )
      continue;
    let included = entry.slice(separator + 1);
    assert(
      included &&
        !included.includes('%(') &&
        (!included.startsWith('~') || included.startsWith('~/')),
      409,
      'Git include 配置路径不支持',
    );
    if (included.startsWith('~/')) included = join(homedir(), included.slice(2));
    paths.add(resolve(dirname(path), included));
  }
  assert(paths.size <= 32, 409, 'Git 配置文件数量超出检查限制');
  const configs: GitConfigIdentity[] = [];
  let size = 0;
  for (const path of [...paths].sort()) {
    if (await absent(path)) {
      configs.push({ path });
      continue;
    }
    const item = await identity(path, true),
      bytes = boundedFile(path, maximum(options), item);
    size += bytes.length;
    assert(size <= maximum(options), 409, 'Git 配置内容超出检查限制');
    configs.push({ path, identity: item, hash: digest(bytes) });
  }
  return configs;
}
async function discover(projectRoot: string, options: ProjectGitOptions): Promise<GitRepository> {
  const projectIdentity = await identity(projectRoot);
  const result = await run(
    projectRoot,
    [
      'rev-parse',
      '--is-inside-work-tree',
      '--show-toplevel',
      '--path-format=absolute',
      '--git-common-dir',
      '--absolute-git-dir',
    ],
    options,
  );
  assert(result.code === 0, 409, '此目录不是可用的 Git 工作目录');
  const [inside, rootPath, commonPath, gitPath, ...extra] = result.output.trimEnd().split('\n');
  assert(
    inside === 'true' && rootPath && commonPath && gitPath && extra.length === 0,
    409,
    'Git 仓库布局不可用',
  );
  const commonDir = await realpath(commonPath),
    gitDir = await realpath(gitPath);
  const rootIdentity = await identity(rootPath),
    commonIdentity = await identity(commonDir),
    gitDirIdentity = await identity(gitDir);
  const pointers: GitPointerIdentity[] = [];
  const marker = join(rootPath, '.git');
  if ((await lstat(marker)).isFile()) pointers.push(await pointer(marker));
  if (gitDir !== commonDir) {
    pointers.push(await pointer(join(gitDir, 'commondir')), await pointer(join(gitDir, 'gitdir')));
  }
  assert(pathWithin(rootPath, projectRoot), 409, '项目不属于 Git 工作目录');
  const repository: GitRepository = {
    version: 1,
    id: digest(JSON.stringify(commonIdentity)),
    projectRoot,
    rootPath,
    commonDir,
    gitDir,
    projectRelativePath: gitRelative(rootPath, projectRoot),
    projectIdentity,
    rootIdentity,
    commonIdentity,
    gitDirIdentity,
    pointers,
    configs: await captureConfigs(rootPath, commonDir, gitDir, options),
  };
  checkRepository(repository);
  return repository;
}
async function currentRepository(repository: GitRepository, options: ProjectGitOptions) {
  checkRepository(repository);
  const current = await discover(repository.projectRoot, options);
  assert(isDeepStrictEqual(current, repository), 409, 'Git 仓库的实际执行归属已变化');
}
function emptyState(issue?: string): GitRepositoryState {
  return {
    kind: 'unavailable',
    branches: [],
    changes: [],
    dirty: false,
    partial: true,
    outsideProjectChanges: false,
    issues: issue ? [issue] : [],
    writeSupported: false,
    version: digest('unavailable'),
  };
}
function addIssue(state: GitRepositoryState, issue: string) {
  if (!state.issues.includes(issue) && state.issues.length < GIT_LIMITS.issues)
    state.issues.push(issue);
}
const truthy = (value: string) => !['false', 'no', 'off', '0', ''].includes(value.toLowerCase());
async function safetyIssues(repository: GitRepository, options: ProjectGitOptions) {
  const reasons = new Set<string>();
  const config = await command(
    repository.projectRoot,
    ['config', '--includes', '--null', '--list'],
    options,
  );
  for (const item of config.split('\0')) {
    const line = item.indexOf('\n');
    if (line < 0) continue;
    const key = item.slice(0, line).toLowerCase(),
      value = item.slice(line + 1);
    if (
      (key === 'core.hookspath' && value !== '/dev/null') ||
      (key === 'core.fsmonitor' && truthy(value)) ||
      (/^filter\..*\.(clean|smudge|process)$/u.test(key) && value) ||
      (key === 'diff.external' && value) ||
      (/^diff\..*\.(command|textconv)$/u.test(key) && value)
    )
      reasons.add('仓库包含可执行 Git 配置，暂不支持此操作');
    if (key === 'core.sparsecheckout' && truthy(value)) reasons.add('暂不支持稀疏检出');
    if (key === 'extensions.partialclone' || (/^remote\..*\.promisor$/u.test(key) && truthy(value)))
      reasons.add('暂不支持需要延迟获取对象的仓库');
  }
  const hooks = join(repository.commonDir, 'hooks');
  try {
    assert((await lstat(hooks)).isDirectory(), 409, 'Git hooks 目录不可确认');
    const directory = await opendir(hooks);
    let count = 0;
    for await (const entry of directory) {
      if (++count > 100) {
        reasons.add('Git hooks 目录超出检查限制');
        break;
      }
      if (entry.name.endsWith('.sample')) continue;
      const stat = await lstat(join(hooks, entry.name));
      if (stat.isSymbolicLink() || (stat.isFile() && stat.mode & 0o111))
        reasons.add('仓库包含可执行 Git hook，暂不支持此操作');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reasons.add('Git hooks 状态不可确认');
  }
  const entries = await command(repository.rootPath, ['ls-files', '--stage', '-v', '-z'], options);
  let count = 0;
  for (const entry of entries.split('\0')) {
    if (!entry) continue;
    if (++count > PROJECT_GIT_LIMITS.records) {
      reasons.add('Git 索引超出检查限制');
      break;
    }
    const match = /^([A-Za-z?]) ([0-9]{6}) [a-f0-9]+ ([0-3])\t(.+)$/su.exec(entry);
    if (!match) {
      reasons.add('Git 索引格式不可确认');
      continue;
    }
    if (match[1] !== match[1]!.toUpperCase()) reasons.add('暂不支持 assume-unchanged 索引标记');
    if (match[1]!.toUpperCase() === 'S') reasons.add('暂不支持 skip-worktree 索引标记');
    if (match[2] === '160000') reasons.add('暂不支持包含子模块的仓库');
    if (match[3] !== '0') reasons.add('Git 合并冲突尚未解决');
  }
  for (const name of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_START',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
  ]) {
    try {
      await lstat(join(repository.gitDir, name));
      reasons.add('Git 合并、变基或其他操作尚未完成');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reasons.add('Git 操作状态不可确认');
    }
  }
  return [...reasons];
}
function parseChanges(raw: string, repository: GitRepository, state: GitRepositoryState) {
  const entries = raw.split('\0');
  if (entries.at(-1) !== '') {
    state.partial = true;
    addIssue(state, 'Git 状态输出不完整');
  }
  let records = 0,
    bytes = 0;
  const withinProject = (path: string) =>
    !repository.projectRelativePath || path.startsWith(repository.projectRelativePath + '/');
  const localPath = (path: string) =>
    repository.projectRelativePath ? path.slice(repository.projectRelativePath.length + 1) : path;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    state.dirty = true;
    if (++records > PROJECT_GIT_LIMITS.records) {
      state.partial = true;
      addIssue(state, 'Git 状态超出检查限制');
      break;
    }
    if (!/^[ MADRCU?!T]{2} /u.test(entry)) {
      state.partial = true;
      addIssue(state, 'Git 状态格式不可确认');
      continue;
    }
    const index = entry[0] as GitRepositoryState['changes'][number]['index'],
      worktree = entry[1] as GitRepositoryState['changes'][number]['worktree'];
    const path = entry.slice(3).replace(/\/$/u, '');
    const previous =
      index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C'
        ? entries[++i]
        : undefined;
    if (!withinProject(path)) {
      state.outsideProjectChanges = true;
      continue;
    }
    if (previous && !withinProject(previous)) state.outsideProjectChanges = true;
    const pathValue = localPath(path),
      previousPath = previous && withinProject(previous) ? localPath(previous) : undefined;
    if (
      !projectFilePathSchema.safeParse(pathValue).success ||
      (previousPath && !projectFilePathSchema.safeParse(previousPath).success)
    ) {
      state.partial = true;
      addIssue(state, '部分 Git 路径无法安全显示');
      continue;
    }
    const change = { path: pathValue, ...(previousPath ? { previousPath } : {}), index, worktree };
    bytes += Buffer.byteLength(JSON.stringify(change));
    if (state.changes.length >= GIT_LIMITS.changes || bytes > 1024 * 1024) {
      state.partial = true;
      addIssue(state, '变更列表超出显示限制');
      continue;
    }
    state.changes.push(change);
  }
}
async function stateFor(
  repository: GitRepository,
  options: ProjectGitOptions,
): Promise<GitRepositoryState> {
  await currentRepository(repository, options);
  const state = emptyState();
  state.kind = 'git';
  state.partial = false;
  const head = await run(
    repository.projectRoot,
    ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
    options,
  );
  if (head.code === 0 && gitOidSchema.safeParse(head.output.trim()).success)
    state.headOid = head.output.trim();
  else addIssue(state, '仓库尚无可用提交');
  const branch = await run(
    repository.projectRoot,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    options,
  );
  if (branch.code === 0 && gitBranchSchema.safeParse(branch.output.trimEnd()).success)
    state.branch = branch.output.trimEnd();
  else if (branch.code !== 1) addIssue(state, '当前分支不可确认');
  const refs = await command(
    repository.projectRoot,
    [
      'for-each-ref',
      '--count=' + (GIT_LIMITS.branches + 1),
      '--format=%(refname:strip=2)%00%(objectname)',
      'refs/heads/',
    ],
    options,
  );
  for (const row of refs.split('\n')) {
    if (!row) continue;
    const [name, oid, ...extra] = row.split('\0');
    if (
      extra.length ||
      !gitBranchSchema.safeParse(name).success ||
      !gitOidSchema.safeParse(oid).success
    ) {
      state.partial = true;
      addIssue(state, '部分分支无法安全显示');
      continue;
    }
    if (state.branches.length === GIT_LIMITS.branches) {
      state.partial = true;
      addIssue(state, '分支列表超出显示限制');
      break;
    }
    state.branches.push({ name: name!, oid: oid! });
  }
  const unsafe = await safetyIssues(repository, options);
  for (const issue of unsafe) addIssue(state, issue);
  if (unsafe.some((issue) => issue.includes('可执行') || issue.includes('延迟获取'))) {
    state.partial = true;
    addIssue(state, '未运行可能调用外部程序的文件状态检查');
  } else {
    const raw = await command(
      repository.projectRoot,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
        '--ignore-submodules=none',
        '--no-renames',
      ],
      options,
    );
    parseChanges(raw, repository, state);
  }
  await currentRepository(repository, options);
  state.writeSupported = Boolean(
    state.headOid && !state.partial && unsafe.length === 0 && state.issues.length === 0,
  );
  state.version = digest(
    JSON.stringify({
      ...state,
      version: undefined,
      repository: repository.id,
      root: repository.rootIdentity,
    }),
  );
  return gitRepositoryStateSchema.parse(state);
}
export async function readProjectGit(
  projectRoot: string,
  options: ProjectGitOptions = {},
): Promise<{ state: GitRepositoryState; repository?: GitRepository }> {
  options = budget(options);
  let repository: GitRepository | undefined;
  try {
    repository = await discover(projectRoot, options);
    return { repository, state: await stateFor(repository, options) };
  } catch {
    return {
      ...(repository ? { repository } : {}),
      state: emptyState('Git 状态不可用、仓库布局不支持或读取超出限制'),
    };
  }
}
async function branchName(repository: GitRepository, name: string, options: ProjectGitOptions) {
  assert(
    gitBranchSchema.safeParse(name).success && !name.startsWith('-') && !name.includes('@{'),
    400,
    '需要明确的本地分支名称',
  );
  const result = await run(repository.rootPath, ['check-ref-format', '--branch', name], options);
  assert(result.code === 0 && result.output.trimEnd() === name, 400, '本地分支名称无效');
}
async function worktrees(repository: GitRepository, options: ProjectGitOptions) {
  await currentRepository(repository, options);
  const raw = await command(
    repository.rootPath,
    ['worktree', 'list', '--porcelain', '-z'],
    options,
  );
  const rows: WorktreeRow[] = [];
  let row: WorktreeRow | undefined;
  for (const value of raw.split('\0')) {
    if (!value) {
      if (row) rows.push(row);
      row = undefined;
      continue;
    }
    if (value.startsWith('worktree ')) {
      assert(!row && rows.length < 1000, 409, 'Git worktree 列表不可确认');
      row = { path: value.slice(9) };
      assert(safePath(row.path), 409, 'Git worktree 路径不可确认');
    } else if (row) {
      if (value.startsWith('HEAD ')) row.head = value.slice(5);
      else if (value.startsWith('branch refs/heads/')) row.branch = value.slice(18);
      else if (value === 'locked' || value.startsWith('locked ')) row.locked = true;
      else if (value === 'prunable' || value.startsWith('prunable ')) row.prunable = true;
      else if (value === 'bare') row.bare = true;
      else assert(value === 'detached', 409, 'Git worktree 格式不可确认');
    } else throw new AppError(409, 'Git worktree 格式不可确认');
  }
  assert(!row, 409, 'Git worktree 列表不完整');
  return rows;
}
async function absent(path: string) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
async function verifyTree(
  repository: GitRepository,
  plan: WorktreePlan,
  options: ProjectGitOptions,
) {
  const tree = await command(
    repository.rootPath,
    ['ls-tree', '-r', '-z', plan.expectedOid],
    options,
  );
  let records = 0,
    attributeFiles = 0,
    attributeBytes = 0;
  for (const entry of tree.split('\0')) {
    if (!entry) continue;
    assert(++records <= PROJECT_GIT_LIMITS.records, 409, '基线文件数量超出检查限制');
    const match = /^([0-9]{6}) (blob|tree|commit) ([a-f0-9]+)\t(.+)$/su.exec(entry);
    assert(match && match[1] !== '160000', 409, '基线包含子模块或不支持的条目');
    assert(projectFilePathSchema.safeParse(match[4]).success, 409, '基线包含无法安全处理的路径');
    if (match[4] === '.gitattributes' || match[4]!.endsWith('/.gitattributes')) {
      assert(
        ++attributeFiles <= PROJECT_GIT_LIMITS.attributeFiles,
        409,
        '基线属性文件数量超出检查限制',
      );
      const attributes = await command(
        repository.rootPath,
        ['cat-file', 'blob', match[3]!],
        options,
      );
      attributeBytes += Buffer.byteLength(attributes);
      assert(attributeBytes <= maximum(options), 409, '基线属性内容超出检查限制');
      assert(
        !/\bfilter(?:\s|=|$)/mu.test(attributes),
        409,
        '基线包含 checkout filter，暂不支持此操作',
      );
    }
  }
  if (repository.projectRelativePath) {
    const type = await command(
      repository.rootPath,
      ['cat-file', '-t', plan.expectedOid + ':' + repository.projectRelativePath],
      options,
    );
    assert(type.trim() === 'tree', 409, '所选基线缺少项目子目录');
  }
  try {
    const path = join(repository.commonDir, 'info', 'attributes');
    const stat = await lstat(path);
    assert(stat.isFile() && stat.size <= maximum(options), 409, '仓库属性不可安全读取');
    const attributes = boundedFile(path, maximum(options)).toString('utf8');
    assert(
      Buffer.byteLength(attributes) <= maximum(options) && !/\bfilter(?:\s|=|$)/mu.test(attributes),
      409,
      '仓库属性包含 checkout filter，暂不支持此操作',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
function planShape(repository: GitRepository, plan: WorktreePlan) {
  assert(
    safePath(plan.targetPath) &&
      !pathWithin(repository.rootPath, plan.targetPath) &&
      !pathWithin(plan.targetPath, repository.rootPath) &&
      !pathWithin(repository.commonDir, plan.targetPath),
    409,
    'worktree 必须位于独立的主机管理目录',
  );
  assert(
    gitOidSchema.safeParse(plan.expectedOid).success &&
      gitBranchSchema.safeParse(plan.baseBranch).success &&
      gitBranchSchema.safeParse(plan.newBranch).success,
    400,
    'worktree 基线无效',
  );
}
async function captureManaged(
  repository: GitRepository,
  plan: WorktreePlan,
  options: ProjectGitOptions,
): Promise<ManagedWorktree> {
  const cwd = repository.projectRelativePath
    ? join(plan.targetPath, ...repository.projectRelativePath.split('/'))
    : plan.targetPath;
  const found = await discover(cwd, options);
  assert(
    found.id === repository.id &&
      found.rootPath === plan.targetPath &&
      found.projectRelativePath === repository.projectRelativePath,
    409,
    'worktree 仓库归属不匹配',
  );
  const gitFileIdentity = await identity(join(plan.targetPath, '.git'), true);
  const stat = await lstat(gitFileIdentity.path);
  assert(stat.size <= 4096, 409, 'worktree Git 指针无效');
  const gitFileHash = digest(boundedFile(gitFileIdentity.path, 4096, gitFileIdentity));
  return {
    version: 1,
    repositoryId: repository.id,
    plan: { ...plan },
    cwd,
    rootIdentity: found.rootIdentity,
    cwdIdentity: found.projectIdentity,
    gitDirIdentity: found.gitDirIdentity,
    parentIdentity: await identity(dirname(plan.targetPath)),
    gitFileIdentity,
    gitFileHash,
    pointers: found.pointers,
    configs: found.configs,
  };
}
/** Synchronous lease check immediately before a prompt is staged or resumed. */
export function validateManagedWorktreeRoot(
  repository: GitRepository,
  managed: ManagedWorktree,
): void {
  try {
    checkRepository(repository);
    planShape(repository, managed.plan);
    assert(
      managed.version === 1 &&
        managed.repositoryId === repository.id &&
        managed.rootIdentity.path === managed.plan.targetPath &&
        managed.cwdIdentity.path === managed.cwd &&
        managed.cwd ===
          (repository.projectRelativePath
            ? join(managed.plan.targetPath, ...repository.projectRelativePath.split('/'))
            : managed.plan.targetPath) &&
        managed.parentIdentity.path === dirname(managed.plan.targetPath) &&
        managed.gitFileIdentity.path === join(managed.plan.targetPath, '.git'),
      409,
      'worktree 执行身份无效',
    );
    for (const item of [
      managed.rootIdentity,
      managed.cwdIdentity,
      managed.gitDirIdentity,
      managed.parentIdentity,
    ])
      checkIdentity(item);
    checkIdentity(managed.gitFileIdentity, true);
    for (const pointer of managed.pointers) checkPointer(pointer);
    checkConfigs(managed.configs);
    const head = boundedFile(join(managed.gitDirIdentity.path, 'HEAD'), 4096).toString('utf8');
    assert(
      head === 'ref: refs/heads/' + managed.plan.newBranch + '\n' ||
        head === 'ref: refs/heads/' + managed.plan.newBranch,
      409,
      'worktree 分支已变化',
    );
    assert(
      lstatSync(managed.gitFileIdentity.path).size <= 4096 &&
        digest(boundedFile(managed.gitFileIdentity.path, 4096, managed.gitFileIdentity)) ===
          managed.gitFileHash,
      409,
      'worktree Git 指针已变化',
    );
  } catch {
    throw new AppError(409, 'worktree 目录或仓库归属已变化');
  }
}
async function prepare(
  repository: GitRepository,
  plan: WorktreePlan,
  options: ProjectGitOptions,
  writing: () => void,
): Promise<ManagedWorktree> {
  await currentRepository(repository, options);
  planShape(repository, plan);
  const parent = await identity(dirname(plan.targetPath));
  await branchName(repository, plan.baseBranch, options);
  await branchName(repository, plan.newBranch, options);
  const state = await stateFor(repository, options);
  assert(state.writeSupported, 409, '当前 Git 状态不支持创建 worktree');
  const base = await command(
    repository.rootPath,
    ['rev-parse', '--verify', '--end-of-options', 'refs/heads/' + plan.baseBranch + '^{commit}'],
    options,
  );
  assert(base.trim() === plan.expectedOid, 409, '基线分支已变化，请重新读取');
  const existing = await run(
    repository.rootPath,
    ['show-ref', '--verify', '--quiet', 'refs/heads/' + plan.newBranch],
    options,
  );
  assert(existing.code === 1, 409, '新分支已存在或无法确认');
  assert(
    (await absent(plan.targetPath)) &&
      !(await worktrees(repository, options)).some((row) => row.path === plan.targetPath),
    409,
    'worktree 目标已存在或仍有登记',
  );
  await verifyTree(repository, plan, options);
  await options.checkpoint?.('before-prepare');
  await currentRepository(repository, options);
  checkIdentity(parent);
  assert(
    (await absent(plan.targetPath)) && (await safetyIssues(repository, options)).length === 0,
    409,
    '创建前的 Git 状态已变化',
  );
  assert(
    (
      await command(
        repository.rootPath,
        [
          'rev-parse',
          '--verify',
          '--end-of-options',
          'refs/heads/' + plan.baseBranch + '^{commit}',
        ],
        options,
      )
    ).trim() === plan.expectedOid,
    409,
    '基线分支已变化，请重新读取',
  );
  await command(
    repository.rootPath,
    [
      '-c',
      'worktree.guessRemote=false',
      'worktree',
      'add',
      '--no-guess-remote',
      '--no-track',
      '-b',
      plan.newBranch,
      '--',
      plan.targetPath,
      plan.expectedOid,
    ],
    options,
    true,
    writing,
  );
  await options.checkpoint?.('after-prepare');
  await currentRepository(repository, options);
  checkIdentity(parent);
  const result = await inspectProjectWorktree(repository, plan, options);
  assert(result.status === 'ready', 502, 'worktree 创建结果尚未确认，请查询原操作');
  return result.managed;
}
export async function inspectProjectWorktree(
  repository: GitRepository,
  value: ManagedWorktree | WorktreePlan,
  options: ProjectGitOptions = {},
): Promise<WorktreeInspection> {
  options = budget(options);
  try {
    await currentRepository(repository, options);
    const managed = 'plan' in value ? value : undefined,
      plan = managed ? managed.plan : (value as WorktreePlan);
    planShape(repository, plan);
    const rows = await worktrees(repository, options),
      row = rows.find((item) => item.path === plan.targetPath);
    if (await absent(plan.targetPath))
      return row
        ? { status: 'unknown', reason: 'worktree 目录缺失但 Git 登记仍在' }
        : { status: 'missing', reason: 'worktree 目录和 Git 登记均不存在' };
    assert(
      row && !row.bare && !row.locked && !row.prunable && row.branch === plan.newBranch,
      409,
      'worktree 登记或分支已变化',
    );
    if (managed) validateManagedWorktreeRoot(repository, managed);
    const captured = await captureManaged(repository, plan, options);
    if (managed) assert(isDeepStrictEqual(captured, managed), 409, 'worktree 目录身份已变化');
    const actual = await readProjectGit(captured.cwd, options);
    assert(
      actual.repository?.id === repository.id &&
        actual.state.kind === 'git' &&
        actual.state.branch === plan.newBranch,
      409,
      'worktree 状态不可确认',
    );
    if (!managed)
      assert(
        actual.state.writeSupported &&
          !actual.state.dirty &&
          !actual.state.partial &&
          actual.state.headOid === plan.expectedOid,
        409,
        '创建结果已有变化，无法自动确认',
      );
    validateManagedWorktreeRoot(repository, captured);
    return { status: 'ready', managed: captured, state: actual.state };
  } catch {
    return { status: 'unknown', reason: 'worktree 目录、Git 状态或执行归属无法确认' };
  }
}
async function remove(
  repository: GitRepository,
  managed: ManagedWorktree,
  input: { expectedStateVersion: string },
  options: ProjectGitOptions,
  writing: () => void,
): Promise<{ removed: true }> {
  const before = await inspectProjectWorktree(repository, managed, options);
  assert(before.status === 'ready', 409, 'worktree 归属不可确认，未执行清理');
  assert(before.state.version === input.expectedStateVersion, 409, 'Git 状态已变化，请重新读取');
  assert(
    before.state.writeSupported && !before.state.dirty && !before.state.partial,
    409,
    'worktree 有未保存、未跟踪、忽略文件或不明状态，未执行清理',
  );
  await options.checkpoint?.('before-remove');
  const latest = await inspectProjectWorktree(repository, managed, options);
  assert(
    latest.status === 'ready' &&
      latest.state.version === input.expectedStateVersion &&
      latest.state.writeSupported &&
      !latest.state.dirty &&
      !latest.state.partial,
    409,
    '清理前 Git 状态已变化，未执行清理',
  );
  validateManagedWorktreeRoot(repository, managed);
  await currentRepository(repository, options);
  await command(
    repository.rootPath,
    ['worktree', 'remove', '--', managed.plan.targetPath],
    options,
    true,
    writing,
  );
  const result = await inspectProjectWorktree(repository, managed, options);
  assert(result.status === 'missing', 502, 'worktree 清理结果尚未确认，请查询原操作');
  return { removed: true };
}
async function operation<T>(work: (writing: () => void) => Promise<T>) {
  let started = false;
  try {
    return await work(() => {
      started = true;
    });
  } catch (error) {
    if (started) throw new AppError(502, 'Git 操作结果尚未确认，请查询原操作', false);
    throw new AppError(
      error instanceof AppError ? error.status : 502,
      error instanceof AppError ? error.message : 'Git 操作检查失败，尚未执行',
      true,
    );
  }
}
export function prepareProjectWorktree(
  repository: GitRepository,
  plan: WorktreePlan,
  options: ProjectGitOptions = {},
): Promise<ManagedWorktree> {
  return operation((writing) => prepare(repository, plan, budget(options), writing));
}
export function removeProjectWorktree(
  repository: GitRepository,
  managed: ManagedWorktree,
  input: { expectedStateVersion: string },
  options: ProjectGitOptions = {},
): Promise<{ removed: true }> {
  return operation((writing) => remove(repository, managed, input, budget(options), writing));
}
