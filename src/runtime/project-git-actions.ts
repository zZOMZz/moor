import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AppError, assert } from '../protocol';
import { isCanonicalBase64, projectFilePathSchema } from '../content-protocol';
import { gitBranchSchema, gitOidSchema } from '../git-protocol';
import { githubOwnerSchema, githubRepoNameSchema } from '../github-protocol';
import { readProjectFileBytes, isHostPrivateProjectPath } from './project-files';
import { readProjectGit, validateProjectGitRepository, type GitRepository } from './project-git';

export const GIT_ACTION_LIMITS = {
  files: 50,
  fileBytes: 1024 * 1024,
  selectedBytes: 8 * 1024 * 1024,
  previewChars: 16000,
  previewBytes: 2 * 1024 * 1024,
  treeEntries: 20000,
  indexBytes: 4 * 1024 * 1024,
  planBytes: 24 * 1024 * 1024,
  commandBytes: 8 * 1024 * 1024,
  packBytes: 32 * 1024 * 1024,
  networkBytes: 2 * 1024 * 1024,
  timeout: 30000,
} as const;
export type GitCommitFile = {
  path: string;
  kind: 'add' | 'modify' | 'delete';
  version: string;
  byteLength: number;
  mode: '100644' | '100755' | null;
  binary: boolean;
  truncated: boolean;
  beforeText?: string;
  afterText?: string;
};
export type GitCommitCandidate = {
  version: string;
  repository: GitRepository;
  branch: string;
  parentOid: string;
  indexVersion: string;
  files: GitCommitFile[];
};
export type GitCommitIdentity = { name: string; email: string };
type GitObject = { oid: string; type: 'blob' | 'tree' | 'commit'; data: string };
export type GitCommitPlan = {
  version: 1;
  candidate: GitCommitCandidate;
  oid: string;
  treeOid: string;
  message: string;
  author: GitCommitIdentity;
  timestamp: number;
  objects: GitObject[];
  indexBefore: string;
  indexAfter: string;
};
export type GitActionOptions = {
  assertCurrent?: () => void;
  // Must persist the original plan before this callback returns. It runs once,
  // immediately before the first mutation; callers never replay a dispatched plan.
  onDispatched?: () => void | Promise<void>;
  checkpoint?: (
    stage:
      | 'before-plan-file'
      | 'after-plan-file'
      | 'before-commit'
      | 'after-objects'
      | 'after-ref'
      | 'before-push'
      | 'after-push',
    path?: string,
  ) => void | Promise<void>;
};
export type GitPushPlan = {
  version: 1;
  repository: GitRepository;
  branch: string;
  headOid: string;
  remote: { owner: string; repo: string; repositoryId: number };
  expectedRemoteOid: string | null;
};
// Only host code can supply a transport. No URL, program or transport fields are
// accepted from a browser. Production always uses fixed GitHub smart HTTPS.
export type GitPushTransport = {
  advertise(): Promise<Buffer>;
  receive(body: Buffer): Promise<Buffer>;
};
export type GitPushOptions = GitActionOptions & {
  token: string;
  transport?: GitPushTransport;
  fetch?: typeof fetch;
};
const digest = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const oidFor = (kind: string, bytes: Buffer, length: number) =>
  createHash(length === 64 ? 'sha256' : 'sha1')
    .update(kind + ' ' + bytes.length + '\0')
    .update(bytes)
    .digest('hex');
const text = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function safeError(error: unknown, started: boolean): never {
  if (started) throw new AppError(502, 'Git 写入结果尚未确认，请核查原操作', false);
  throw new AppError(
    error instanceof AppError ? error.status : 409,
    error instanceof AppError ? error.message : 'Git 写入检查失败，尚未执行',
    true,
  );
}
function boundedFile(path: string, limit: number, missing = false) {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    assert(before.isFile() && before.size <= BigInt(limit), 409, 'Git 私有数据超出安全读取范围');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(fd, { bigint: true });
    assert(
      size <= limit &&
        BigInt(size) === after.size &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
      409,
      'Git 数据读取期间已变化',
    );
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
function absent(path: string) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
function metadata(repository: GitRepository) {
  validateProjectGitRepository(repository);
  const objects = join(repository.commonDir, 'objects');
  assert(
    realpathSync(objects) === objects && lstatSync(objects).isDirectory(),
    409,
    'Git 对象目录不可确认',
  );
  for (const path of [
    join(objects, 'info', 'alternates'),
    join(objects, 'info', 'http-alternates'),
    join(repository.commonDir, 'shallow'),
    join(repository.commonDir, 'info', 'grafts'),
  ])
    assert(absent(path), 409, '暂不支持浅克隆、替代对象目录或重写历史的仓库');
  return objects;
}
type Sandbox = {
  path: string;
  index: string;
  run(args: string[], input?: Buffer, maxBytes?: number): Promise<Buffer>;
};
async function sandbox<T>(
  repository: GitRepository,
  length: number,
  work: (sandbox: Sandbox) => Promise<T>,
) {
  const objects = metadata(repository),
    path = realpathSync(mkdtempSync(join(tmpdir(), 'moor-git-action-'))),
    index = join(path, 'index');
  mkdirSync(join(path, 'objects'));
  mkdirSync(join(path, 'refs'));
  writeFileSync(join(path, 'HEAD'), 'ref: refs/heads/isolated\n');
  writeFileSync(
    join(path, 'config'),
    '[core]\nrepositoryformatversion = ' +
      (length === 64 ? '1' : '0') +
      '\nbare = true\n' +
      (length === 64 ? '[extensions]\nobjectFormat = sha256\n' : ''),
    { mode: 0o600 },
  );
  const until = Date.now() + 60000;
  let commands = 0;
  const run = (args: string[], input?: Buffer, maxBytes = GIT_ACTION_LIMITS.commandBytes) => {
    assert(++commands <= 160 && Date.now() < until, 409, 'Git 操作检查超过限制');
    return command(
      path,
      args,
      input,
      { GIT_OBJECT_DIRECTORY: objects, GIT_INDEX_FILE: index },
      maxBytes,
    );
  };
  try {
    return await work({ path, index, run });
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
function command(
  cwd: string,
  args: string[],
  input?: Buffer,
  extra: Record<string, string> = {},
  maxBytes: number = GIT_ACTION_LIMITS.commandBytes,
): Promise<Buffer> {
  return new Promise((done, reject) => {
    const child = execFile(
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
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        '-c',
        'protocol.allow=never',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.logAllRefUpdates=false',
        '-c',
        'core.fsync=reference',
        '-c',
        'core.fsyncMethod=fsync',
        '-C',
        cwd,
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_NO_LAZY_FETCH: '1',
          LC_ALL: 'C',
          ...extra,
        },
        encoding: 'buffer',
        maxBuffer: maxBytes,
        timeout: GIT_ACTION_LIMITS.timeout,
        windowsHide: true,
      },
      (error, stdout) =>
        error ? reject(new AppError(409, 'Git 检查或写入未能确认')) : done(stdout),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
type TreeEntry = { mode: string; oid: string; path: string };
function parseTree(bytes: Buffer): TreeEntry[] {
  const result: TreeEntry[] = [];
  for (const value of text(bytes).split('\0')) {
    if (!value) continue;
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/su.exec(value);
    assert(
      match &&
        projectFilePathSchema.safeParse(match[3]).success &&
        result.length < GIT_ACTION_LIMITS.treeEntries,
      409,
      'Git 基线文件范围不支持或超出限制',
    );
    result.push({ mode: match[1]!, oid: match[2]!, path: match[3]! });
  }
  return result;
}
function selectedPath(repository: GitRepository, path: string) {
  projectFilePathSchema.parse(path);
  assert(
    !isHostPrivateProjectPath(path) &&
      !path.split('/').some((part) => part.toLowerCase() === '.git'),
    403,
    '不能提交 Git 元数据或 Moor 私有配置',
  );
  return repository.projectRelativePath ? repository.projectRelativePath + '/' + path : path;
}
async function selectedBytes(repository: GitRepository, path: string) {
  const full = join(repository.projectRoot, path);
  // For deletion, every remaining ancestor must still be a real directory.
  let cursor = repository.projectRoot;
  for (const part of path.split('/').slice(0, -1)) {
    cursor = join(cursor, part);
    if (absent(cursor)) break;
    assert(
      lstatSync(cursor).isDirectory() && realpathSync(cursor) === cursor,
      403,
      '选中文件不能经过符号链接',
    );
  }
  if (absent(full)) return null;
  const stat = lstatSync(full);
  assert(stat.isFile() && !stat.isSymbolicLink(), 403, '只允许提交明确选择的普通文件');
  const result = await readProjectFileBytes(repository.projectRoot, path);
  return {
    bytes: result.bytes,
    mode: (stat.mode & 0o111 ? '100755' : '100644') as '100644' | '100755',
  };
}
async function readCurrent(cwd: string, options: GitActionOptions) {
  options.assertCurrent?.();
  const { state, repository } = await readProjectGit(cwd);
  options.assertCurrent?.();
  assert(
    repository && state.writeSupported && state.branch && state.headOid,
    409,
    '当前 Git 状态不支持安全写入，请先解决冲突或配置问题',
  );
  metadata(repository);
  assert(
    gitBranchSchema.safeParse(state.branch).success &&
      !state.branch.startsWith('-') &&
      !state.branch.includes('@{'),
    409,
    '需要明确的本地分支',
  );
  return { repository, branch: state.branch, headOid: state.headOid };
}
export async function inspectCommitCandidate(
  cwd: string,
  paths: string[],
  options: GitActionOptions = {},
): Promise<GitCommitCandidate> {
  try {
    assert(
      paths.length > 0 &&
        paths.length <= GIT_ACTION_LIMITS.files &&
        new Set(paths).size === paths.length,
      400,
      '请选择 1 至 50 个不同文件',
    );
    const current = await readCurrent(cwd, options),
      { repository, branch, headOid: parentOid } = current;
    const indexVersion = digest(
      boundedFile(join(repository.gitDir, 'index'), GIT_ACTION_LIMITS.indexBytes, true),
    );
    return await sandbox(repository, parentOid.length, async ({ run }) => {
      const tree = new Map(
        parseTree(await run(['ls-tree', '-r', '-z', parentOid])).map((item) => [item.path, item]),
      );
      const files: GitCommitFile[] = [];
      let total = 0,
        previewTotal = 0;
      for (const path of [...paths].sort()) {
        const name = selectedPath(repository, path),
          before = tree.get(name),
          after = await selectedBytes(repository, path);
        assert(!before || before.mode !== '120000', 403, '不能提交符号链接变更');
        assert(before || after, 409, '选中文件已不存在于基线和工作目录');
        assert(
          !before ||
            !after ||
            before.oid !== oidFor('blob', after.bytes, parentOid.length) ||
            before.mode !== after.mode,
          409,
          '选中文件没有相对 HEAD 的变化',
        );
        total += after?.bytes.length ?? 0;
        assert(total <= GIT_ACTION_LIMITS.selectedBytes, 413, '选中文件内容超过 8 MiB');
        let beforeBytes: Buffer | undefined;
        if (before) {
          const size = Number(text(await run(['cat-file', '-s', before.oid])).trim());
          assert(
            Number.isSafeInteger(size) && size <= GIT_ACTION_LIMITS.fileBytes,
            413,
            '选中文件基线超过 1 MiB',
          );
          beforeBytes = await run(['cat-file', 'blob', before.oid]);
        }
        const file: GitCommitFile = {
          path,
          kind: !before ? 'add' : !after ? 'delete' : 'modify',
          version: digest(
            JSON.stringify({
              before: before?.oid ?? null,
              mode: after?.mode ?? null,
              bytes: after ? digest(after.bytes) : null,
            }),
          ),
          byteLength: after?.bytes.length ?? 0,
          mode: after?.mode ?? null,
          binary: false,
          truncated: false,
        };
        for (const [key, bytes] of [
          ['beforeText', beforeBytes],
          ['afterText', after?.bytes],
        ] as const) {
          if (!bytes) continue;
          try {
            assert(!bytes.includes(0), 409, 'binary');
            const value = text(bytes),
              part = value.slice(0, GIT_ACTION_LIMITS.previewChars);
            previewTotal += Buffer.byteLength(part);
            assert(previewTotal <= GIT_ACTION_LIMITS.previewBytes, 413, '提交预览超过限制');
            file[key] = part;
            file.truncated ||= value.length > part.length;
          } catch (error) {
            if (error instanceof AppError && error.status === 413) throw error;
            file.binary = true;
          }
        }
        if (file.binary) {
          delete file.beforeText;
          delete file.afterText;
        }
        files.push(file);
      }
      options.assertCurrent?.();
      const again = await readCurrent(cwd, options);
      assert(
        isDeepStrictEqual(again, current) &&
          digest(
            boundedFile(join(repository.gitDir, 'index'), GIT_ACTION_LIMITS.indexBytes, true),
          ) === indexVersion,
        409,
        'Git 状态在预览期间已变化',
      );
      const result = { repository, branch, parentOid, indexVersion, files };
      return { ...result, version: digest(JSON.stringify(result)) };
    });
  } catch (error) {
    safeError(error, false);
  }
}
function object(kind: GitObject['type'], bytes: Buffer, length: number): GitObject {
  return { type: kind, oid: oidFor(kind, bytes, length), data: bytes.toString('base64') };
}
function treeObjects(
  entries: Map<string, TreeEntry>,
  length: number,
): { oid: string; objects: GitObject[] } {
  type Tree = { files: Map<string, TreeEntry>; directories: Map<string, Tree> };
  const root: Tree = { files: new Map(), directories: new Map() };
  let directories = 1;
  for (const entry of entries.values()) {
    const parts = entry.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      assert(!node.files.has(part), 409, '选中文件与基线目录冲突');
      let next = node.directories.get(part);
      if (!next) {
        assert(++directories <= GIT_ACTION_LIMITS.treeEntries, 409, 'Git 目录数量超过限制');
        next = { files: new Map(), directories: new Map() };
        node.directories.set(part, next);
      }
      node = next;
    }
    const leaf = parts.at(-1)!;
    assert(!node.directories.has(leaf), 409, '选中文件与基线目录冲突');
    node.files.set(leaf, entry);
  }
  const objects: GitObject[] = [];
  const visit = (tree: Tree): string => {
    const children = [...tree.files].map(([name, entry]) => ({
      name,
      sort: name,
      mode: entry.mode,
      oid: entry.oid,
    }));
    for (const [name, directory] of tree.directories)
      children.push({ name, sort: name + '/', mode: '40000', oid: visit(directory) });
    children.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
    const bytes = Buffer.concat(
      children.map((entry) =>
        Buffer.concat([
          Buffer.from(entry.mode + ' ' + entry.name + '\0'),
          Buffer.from(entry.oid, 'hex'),
        ]),
      ),
    );
    const result = object('tree', bytes, length);
    objects.push(result);
    return result.oid;
  };
  return { oid: visit(root), objects };
}
export async function planProjectCommit(
  candidate: GitCommitCandidate,
  input: { message: string; author: GitCommitIdentity; timestamp: number },
  options: GitActionOptions = {},
): Promise<GitCommitPlan> {
  try {
    const fresh = await inspectCommitCandidate(
      candidate.repository.projectRoot,
      candidate.files.map((file) => file.path),
      options,
    );
    assert(isDeepStrictEqual(fresh, candidate), 409, '提交预览已变化，请重新选择');
    assert(
      input.message.trim() && input.message.length <= 8000 && !input.message.includes('\0'),
      400,
      '提交说明无效',
    );
    for (const value of [input.author.name, input.author.email])
      assert(
        value.length > 0 && value.length <= 200 && !/[<>\x00-\x1f\x7f]/u.test(value),
        400,
        '提交作者无效',
      );
    assert(
      /^[^\s@]+@[^\s@]+$/u.test(input.author.email) &&
        Number.isSafeInteger(input.timestamp) &&
        input.timestamp >= 0,
      400,
      '提交作者或时间无效',
    );
    const { repository, parentOid } = candidate;
    return await sandbox(repository, parentOid.length, async ({ run, index }) => {
      const tree = new Map(
        parseTree(await run(['ls-tree', '-r', '-z', parentOid])).map((item) => [item.path, item]),
      );
      const indexBefore = boundedFile(
        join(repository.gitDir, 'index'),
        GIT_ACTION_LIMITS.indexBytes,
        true,
      );
      assert(
        indexBefore.length && digest(indexBefore) === candidate.indexVersion,
        409,
        'Git 索引已变化或尚不可用',
      );
      writeFileSync(index, indexBefore, { mode: 0o600 });
      const objects: GitObject[] = [],
        indexRows: string[] = [];
      for (const file of candidate.files) {
        const path = selectedPath(repository, file.path),
          before = tree.get(path);
        await options.checkpoint?.('before-plan-file', file.path);
        const selected = await selectedBytes(repository, file.path);
        await options.checkpoint?.('after-plan-file', file.path);
        // Compare the very bytes going into the object, even if an external
        // editor restores the original file before our final whole-plan check.
        assert(
          digest(
            JSON.stringify({
              before: before?.oid ?? null,
              mode: selected?.mode ?? null,
              bytes: selected ? digest(selected.bytes) : null,
            }),
          ) === file.version,
          409,
          '提交文件与已审阅内容不一致',
        );
        if (!selected) {
          tree.delete(path);
          indexRows.push('0 ' + '0'.repeat(parentOid.length) + '\t' + path + '\0');
        } else {
          const blob = object('blob', selected.bytes, parentOid.length);
          objects.push(blob);
          tree.set(path, { path, oid: blob.oid, mode: selected.mode });
          indexRows.push(selected.mode + ' ' + blob.oid + '\t' + path + '\0');
        }
      }
      const trees = treeObjects(tree, parentOid.length);
      objects.push(...trees.objects);
      const identity =
        input.author.name +
        ' <' +
        input.author.email +
        '> ' +
        Math.floor(input.timestamp / 1000) +
        ' +0000';
      const commit = object(
        'commit',
        Buffer.from(
          'tree ' +
            trees.oid +
            '\nparent ' +
            parentOid +
            '\nauthor ' +
            identity +
            '\ncommitter ' +
            identity +
            '\n\n' +
            input.message +
            (input.message.endsWith('\n') ? '' : '\n'),
        ),
        parentOid.length,
      );
      objects.push(commit);
      await run(['update-index', '-z', '--index-info'], Buffer.from(indexRows.join('')));
      const indexAfter = boundedFile(index, GIT_ACTION_LIMITS.indexBytes);
      const final = await inspectCommitCandidate(
        repository.projectRoot,
        candidate.files.map((file) => file.path),
        options,
      );
      assert(isDeepStrictEqual(final, candidate), 409, '提交内容在准备期间已变化');
      const plan: GitCommitPlan = {
        version: 1,
        candidate,
        oid: commit.oid,
        treeOid: trees.oid,
        ...input,
        objects,
        indexBefore: indexBefore.toString('base64'),
        indexAfter: indexAfter.toString('base64'),
      };
      assert(
        Buffer.byteLength(JSON.stringify(plan)) <= GIT_ACTION_LIMITS.planBytes,
        413,
        '提交计划超过主机限制',
      );
      return plan;
    });
  } catch (error) {
    safeError(error, false);
  }
}
function validatePlan(plan: GitCommitPlan) {
  assert(
    plan.version === 1 &&
      plan.objects.length <= GIT_ACTION_LIMITS.treeEntries + GIT_ACTION_LIMITS.files + 1 &&
      Buffer.byteLength(JSON.stringify(plan)) <= GIT_ACTION_LIMITS.planBytes,
    409,
    '提交计划无效',
  );
  assert(
    gitOidSchema.safeParse(plan.oid).success &&
      isCanonicalBase64(plan.indexBefore) &&
      isCanonicalBase64(plan.indexAfter),
    409,
    '提交计划无效',
  );
  assert(
    digest(Buffer.from(plan.indexBefore, 'base64')) === plan.candidate.indexVersion,
    409,
    '提交索引计划不匹配',
  );
  for (const item of plan.objects)
    assert(
      isCanonicalBase64(item.data) &&
        oidFor(item.type, Buffer.from(item.data, 'base64'), plan.oid.length) === item.oid,
      409,
      '提交对象计划不匹配',
    );
  assert(
    plan.objects.some((item) => item.type === 'commit' && item.oid === plan.oid),
    409,
    '提交对象不存在',
  );
}
function writeObject(objects: string, item: GitObject) {
  const body = Buffer.from(item.data, 'base64'),
    raw = Buffer.concat([Buffer.from(item.type + ' ' + body.length + '\0'), body]);
  const directory = join(objects, item.oid.slice(0, 2));
  try {
    mkdirSync(directory, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assert(
    lstatSync(directory).isDirectory() && realpathSync(directory) === directory,
    409,
    'Git 对象目录已变化',
  );
  const target = join(directory, item.oid.slice(2)),
    temporary = join(directory, 'moor-object-' + randomUUID());
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o444,
    );
    try {
      writeFileSync(fd, deflateSync(raw));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = boundedFile(target, raw.length + 65536);
      assert(
        inflateSync(existing, { maxOutputLength: raw.length + 1 }).equals(raw),
        409,
        'Git 对象内容不匹配',
      );
    }
    syncDirectory(directory);
  } finally {
    if (!absent(temporary)) unlinkSync(temporary);
  }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert(fstatSync(fd).isDirectory(), 409, 'Git 目录已变化');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function commitProject(
  plan: GitCommitPlan,
  options: GitActionOptions = {},
): Promise<{ oid: string }> {
  let started = false,
    fd: number | undefined,
    locked = false,
    lockIdentity: { dev: bigint; ino: bigint } | undefined;
  const repository = plan.candidate.repository,
    lockPath = join(repository.gitDir, 'index.lock');
  const ownedLock = () => {
    if (!lockIdentity) return false;
    try {
      const stat = lstatSync(lockPath, { bigint: true });
      return stat.isFile() && stat.dev === lockIdentity.dev && stat.ino === lockIdentity.ino;
    } catch {
      return false;
    }
  };
  const assertLock = () => {
    assert(
      ownedLock() &&
        boundedFile(lockPath, GIT_ACTION_LIMITS.indexBytes).equals(
          Buffer.from(plan.indexAfter, 'base64'),
        ),
      409,
      'Git 索引锁已被其他进程改变',
    );
  };
  try {
    validatePlan(plan);
    const fresh = await inspectCommitCandidate(
      repository.projectRoot,
      plan.candidate.files.map((file) => file.path),
      options,
    );
    assert(isDeepStrictEqual(fresh, plan.candidate), 409, '提交内容已变化，请重新预览');
    assert(absent(lockPath), 409, 'Git 索引已被其他进程锁定');
    await options.checkpoint?.('before-commit');
    options.assertCurrent?.();
    metadata(repository);
    assert(
      isDeepStrictEqual(
        await inspectCommitCandidate(
          repository.projectRoot,
          plan.candidate.files.map((file) => file.path),
          options,
        ),
        plan.candidate,
      ),
      409,
      '提交内容在执行前已变化',
    );
    assert(absent(lockPath), 409, 'Git 索引已被其他进程锁定');
    await options.onDispatched?.();
    options.assertCurrent?.();
    metadata(repository);
    fd = openSync(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    // The durable dispatch marker precedes this first repository write. A
    // competing lock or lease rejection before successful creation is still
    // provably a live, settled attempt with no original-repository writes.
    started = true;
    locked = true;
    lockIdentity = fstatSync(fd, { bigint: true });
    assert(
      digest(boundedFile(join(repository.gitDir, 'index'), GIT_ACTION_LIMITS.indexBytes)) ===
        plan.candidate.indexVersion,
      409,
      'Git 索引已变化',
    );
    writeFileSync(fd, Buffer.from(plan.indexAfter, 'base64'));
    fsyncSync(fd);
    // Keep the descriptor alive across awaits: an unlinked inode cannot be
    // recycled into a replacement lock while we still own this descriptor.
    const objects = metadata(repository);
    for (const item of plan.objects) writeObject(objects, item);
    syncDirectory(objects);
    await options.checkpoint?.('after-objects');
    options.assertCurrent?.();
    metadata(repository);
    assertLock();
    assert(
      isDeepStrictEqual(
        await inspectCommitCandidate(
          repository.projectRoot,
          plan.candidate.files.map((file) => file.path),
          options,
        ),
        plan.candidate,
      ),
      409,
      '提交内容在写入前已变化',
    );
    const head = boundedFile(join(repository.gitDir, 'HEAD'), 4096).toString('utf8');
    assert(head.trim() === 'ref: refs/heads/' + plan.candidate.branch, 409, '当前执行分支已变化');
    assert(
      digest(boundedFile(join(repository.gitDir, 'index'), GIT_ACTION_LIMITS.indexBytes)) ===
        plan.candidate.indexVersion,
      409,
      'Git 索引已变化',
    );
    await command(repository.projectRoot, [
      'update-ref',
      '--no-deref',
      'refs/heads/' + plan.candidate.branch,
      plan.oid,
      plan.candidate.parentOid,
    ]);
    await options.checkpoint?.('after-ref');
    options.assertCurrent?.();
    metadata(repository);
    assertLock();
    assert(
      digest(boundedFile(join(repository.gitDir, 'index'), GIT_ACTION_LIMITS.indexBytes)) ===
        plan.candidate.indexVersion,
      409,
      'Git 索引在确认期间已变化',
    );
    assert(
      boundedFile(join(repository.gitDir, 'HEAD'), 4096).toString('utf8') === head,
      409,
      '当前执行分支已变化',
    );
    renameSync(lockPath, join(repository.gitDir, 'index'));
    locked = false;
    syncDirectory(repository.gitDir);
    return { oid: plan.oid };
  } catch (error) {
    return safeError(error, started);
  } finally {
    if (locked && ownedLock()) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
    if (fd !== undefined) closeSync(fd);
  }
}
export async function inspectProjectCommit(
  plan: GitCommitPlan,
  options: GitActionOptions = {},
): Promise<{ status: 'accepted' | 'not-applied' | 'unknown'; oid: string; indexReady: boolean }> {
  try {
    validatePlan(plan);
    options.assertCurrent?.();
    metadata(plan.candidate.repository);
    const repository = plan.candidate.repository;
    const assertIdleRefs = () => {
      for (const path of [
        join(repository.gitDir, 'index.lock'),
        join(repository.gitDir, 'HEAD.lock'),
        join(repository.commonDir, 'refs', 'heads', plan.candidate.branch + '.lock'),
        join(repository.commonDir, 'packed-refs.lock'),
      ])
        assert(absent(path), 409, 'Git 索引或引用正在被其他进程修改');
      assert(
        boundedFile(join(repository.gitDir, 'HEAD'), 4096).toString('utf8').trim() ===
          'ref: refs/heads/' + plan.candidate.branch,
        409,
        '当前执行分支已变化',
      );
    };
    assertIdleRefs();
    const oid = text(
      await command(repository.projectRoot, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        'refs/heads/' + plan.candidate.branch,
      ]),
    ).trim();
    const index = boundedFile(join(repository.gitDir, 'index'), GIT_ACTION_LIMITS.indexBytes, true);
    const expectedIndex = Buffer.from(plan.indexAfter, 'base64');
    const indexReady =
      oid === plan.oid &&
      (index.equals(expectedIndex) ||
        (await sandbox(repository, plan.oid.length, async (isolated) => {
          const projection = async (bytes: Buffer) => {
            writeFileSync(isolated.index, bytes, { mode: 0o600 });
            const stages = await isolated.run(['ls-files', '--stage', '-v', '-z']);
            // The cached diff also distinguishes intent-to-add from a staged empty
            // blob. No worktree read, external diff, text conversion or index write.
            const changes = await isolated.run([
              'diff',
              '--cached',
              '--raw',
              '-z',
              '--no-abbrev',
              '--no-renames',
              '--no-ext-diff',
              '--no-textconv',
              plan.oid,
              '--',
            ]);
            return JSON.stringify([stages.toString('base64'), changes.toString('base64')]);
          };
          return (await projection(expectedIndex)) === (await projection(index));
        })));
    const confirmedOid = text(
      await command(repository.projectRoot, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        'refs/heads/' + plan.candidate.branch,
      ]),
    ).trim();
    options.assertCurrent?.();
    metadata(repository);
    assertIdleRefs();
    assert(confirmedOid === oid, 409, 'Git 引用在核查期间已变化');
    assert(
      index.equals(
        boundedFile(join(repository.gitDir, 'index'), GIT_ACTION_LIMITS.indexBytes, true),
      ),
      409,
      'Git 索引在核查期间已变化',
    );
    return {
      status:
        oid === plan.oid && indexReady
          ? 'accepted'
          : oid === plan.candidate.parentOid &&
              index.equals(Buffer.from(plan.indexBefore, 'base64'))
            ? 'not-applied'
            : 'unknown',
      oid: plan.oid,
      indexReady,
    };
  } catch {
    return { status: 'unknown', oid: plan.oid, indexReady: false };
  }
}

function pkt(bytes: string | Buffer) {
  const body = Buffer.from(bytes);
  assert(body.length + 4 <= 65520, 409, 'Git 协议记录超出限制');
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}
function packets(bytes: Buffer): (Buffer | null)[] {
  assert(bytes.length <= GIT_ACTION_LIMITS.networkBytes, 413, 'Git 远端响应超过限制');
  const result: (Buffer | null)[] = [];
  let at = 0;
  while (at < bytes.length) {
    const prefix = bytes.subarray(at, at + 4).toString('ascii');
    assert(/^[a-f0-9]{4}$/u.test(prefix), 409, 'Git 远端协议无效');
    const size = Number.parseInt(prefix, 16);
    at += 4;
    if (size === 0) {
      result.push(null);
      continue;
    }
    assert(size >= 4 && size <= 65520 && at + size - 4 <= bytes.length, 409, 'Git 远端响应不完整');
    result.push(bytes.subarray(at, at + size - 4));
    at += size - 4;
  }
  assert(result.at(-1) === null, 409, 'Git 远端响应未结束');
  return result;
}
function advertisement(bytes: Buffer, plan: GitPushPlan) {
  const rows = packets(bytes);
  assert(
    rows[0]?.toString().trim() === '# service=git-receive-pack' && rows[1] === null,
    409,
    'Git 推送服务不可确认',
  );
  let oid: string | null = null,
    capabilities: string[] = [];
  const refs = new Set<string>();
  for (const [index, row] of rows.slice(2).entries()) {
    if (!row) {
      assert(index === rows.length - 3, 409, 'Git 引用列表不完整');
      continue;
    }
    const line = text(row).replace(/\n$/u, ''),
      [reference, capability] = line.split('\0');
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) ([^\s\0]+)$/u.exec(reference!);
    assert(
      match && match[1]!.length === plan.headOid.length && !refs.has(match[2]!),
      409,
      'Git 引用列表无效',
    );
    refs.add(match[2]!);
    if (index === 0) {
      assert(capability, 409, 'Git 推送能力缺失');
      capabilities = capability.split(' ');
    } else assert(capability === undefined, 409, 'Git 推送能力格式无效');
    if (match[2] === 'refs/heads/' + plan.branch) oid = match[1]!;
  }
  assert(capabilities.includes('report-status'), 409, 'Git 远端不支持推送结果确认');
  assert(
    plan.headOid.length === 40 || capabilities.includes('object-format=sha256'),
    409,
    'Git 远端对象格式不匹配',
  );
  return { oid, capabilities };
}
function validatePush(plan: GitPushPlan) {
  assert(
    plan.version === 1 &&
      gitOidSchema.safeParse(plan.headOid).success &&
      (plan.expectedRemoteOid === null ||
        (gitOidSchema.safeParse(plan.expectedRemoteOid).success &&
          plan.expectedRemoteOid.length === plan.headOid.length)),
    400,
    '推送提交范围无效',
  );
  assert(
    gitBranchSchema.safeParse(plan.branch).success &&
      !plan.branch.startsWith('-') &&
      !plan.branch.includes('@{'),
    400,
    '推送分支无效',
  );
  githubOwnerSchema.parse(plan.remote.owner);
  githubRepoNameSchema.parse(plan.remote.repo);
  assert(
    Number.isSafeInteger(plan.remote.repositoryId) && plan.remote.repositoryId > 0,
    400,
    '推送仓库身份无效',
  );
}
function transportFor(plan: GitPushPlan, options: GitPushOptions): GitPushTransport {
  if (options.transport) return options.transport;
  assert(
    options.token.length > 0 &&
      options.token.length <= 4096 &&
      /^[\x21-\x7e]+$/u.test(options.token),
    400,
    'GitHub 凭据不可用',
  );
  const root = 'https://github.com/' + plan.remote.owner + '/' + plan.remote.repo + '.git';
  const request = async (url: string, body?: Buffer) => {
    options.assertCurrent?.();
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), GIT_ACTION_LIMITS.timeout);
    try {
      const response = await (options.fetch ?? fetch)(url, {
        method: body ? 'POST' : 'GET',
        redirect: 'manual',
        cache: 'no-store',
        signal: abort.signal,
        headers: {
          Authorization:
            'Basic ' + Buffer.from('x-access-token:' + options.token).toString('base64'),
          Accept: body
            ? 'application/x-git-receive-pack-result'
            : 'application/x-git-receive-pack-advertisement',
          ...(body ? { 'Content-Type': 'application/x-git-receive-pack-request' } : {}),
        },
        ...(body ? { body: new Uint8Array(body) } : {}),
      });
      options.assertCurrent?.();
      assert(
        response.status === 200 && !response.redirected && (!response.url || response.url === url),
        409,
        'GitHub 推送连接或授权不可用',
      );
      assert(
        response.headers.get('content-type')?.split(';')[0] ===
          (body
            ? 'application/x-git-receive-pack-result'
            : 'application/x-git-receive-pack-advertisement'),
        409,
        'GitHub 推送响应类型无效',
      );
      assert(
        Number(response.headers.get('content-length') ?? 0) <= GIT_ACTION_LIMITS.networkBytes &&
          response.body,
        413,
        'GitHub 推送响应超过限制',
      );
      const reader = response.body.getReader(),
        chunks: Buffer[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          assert(size <= GIT_ACTION_LIMITS.networkBytes, 413, 'GitHub 推送响应超过限制');
          chunks.push(Buffer.from(item.value));
          options.assertCurrent?.();
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      options.assertCurrent?.();
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  };
  return {
    advertise: () => request(root + '/info/refs?service=git-receive-pack'),
    receive: (body) => request(root + '/git-receive-pack', body),
  };
}
export async function inspectProjectPush(
  plan: GitPushPlan,
  options: GitPushOptions,
): Promise<{ status: 'accepted' | 'not-applied' | 'unknown'; remoteOid: string | null }> {
  try {
    validatePush(plan);
    options.assertCurrent?.();
    const result = advertisement(await transportFor(plan, options).advertise(), plan);
    options.assertCurrent?.();
    return {
      status:
        result.oid === plan.headOid
          ? 'accepted'
          : result.oid === plan.expectedRemoteOid
            ? 'not-applied'
            : 'unknown',
      remoteOid: result.oid,
    };
  } catch {
    return { status: 'unknown', remoteOid: null };
  }
}
export async function pushProject(
  plan: GitPushPlan,
  options: GitPushOptions,
): Promise<{ oid: string }> {
  let started = false;
  try {
    validatePush(plan);
    const local = await readCurrent(plan.repository.projectRoot, options);
    assert(
      isDeepStrictEqual(local.repository, plan.repository) &&
        local.branch === plan.branch &&
        local.headOid === plan.headOid,
      409,
      '本地分支或提交已变化',
    );
    const transport = transportFor(plan, options),
      remote = advertisement(await transport.advertise(), plan);
    assert(remote.oid === plan.expectedRemoteOid, 409, '远端分支已变化，请重新读取');
    assert(remote.oid !== plan.headOid, 409, '远端已经包含此提交');
    const pack = await sandbox(plan.repository, plan.headOid.length, async ({ run }) => {
      await run(['check-ref-format', 'refs/heads/' + plan.branch]);
      if (plan.expectedRemoteOid)
        await run(['merge-base', '--is-ancestor', plan.expectedRemoteOid, plan.headOid]);
      return run(
        ['pack-objects', '--stdout', '--revs', '--no-reuse-delta', '--no-reuse-object'],
        Buffer.from(
          plan.headOid + '\n' + (plan.expectedRemoteOid ? '^' + plan.expectedRemoteOid + '\n' : ''),
        ),
        GIT_ACTION_LIMITS.packBytes,
      );
    });
    await options.checkpoint?.('before-push');
    options.assertCurrent?.();
    const latest = await readCurrent(plan.repository.projectRoot, options);
    assert(isDeepStrictEqual(latest, local), 409, '本地分支或提交已变化');
    const capability =
      'report-status' + (plan.headOid.length === 64 ? ' object-format=sha256' : '');
    const body = Buffer.concat([
      pkt(
        (plan.expectedRemoteOid ?? '0'.repeat(plan.headOid.length)) +
          ' ' +
          plan.headOid +
          ' refs/heads/' +
          plan.branch +
          '\0' +
          capability +
          '\n',
      ),
      Buffer.from('0000'),
      pack,
    ]);
    await options.onDispatched?.();
    options.assertCurrent?.();
    started = true;
    const result = await transport.receive(body);
    await options.checkpoint?.('after-push');
    options.assertCurrent?.();
    const rows = packets(result)
      .filter((row) => row !== null)
      .map((row) => text(row));
    assert(
      rows.length === 2 &&
        rows[0] === 'unpack ok\n' &&
        rows[1] === 'ok refs/heads/' + plan.branch + '\n',
      409,
      'GitHub 未确认原推送，请核查原操作',
    );
    return { oid: plan.headOid };
  } catch (error) {
    safeError(error, started);
  }
}
