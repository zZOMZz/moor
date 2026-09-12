import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { CONTENT_LIMITS, projectFilePathSchema } from '../content-protocol';
import { AppError, assert } from '../protocol';
import { readProjectFileBytes } from './project-files';

export const PROJECT_SNAPSHOT_LIMITS = {
  entries: 5000,
  bytes: 16 * 1024 * 1024,
  changes: CONTENT_LIMITS.diffFiles,
  depth: 64,
  issues: 100,
  gitOutput: 2 * 1024 * 1024,
} as const;
export const PROJECT_SNAPSHOT_EXCLUDES = [
  '.git',
  '.data',
  '.moor',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  'target',
  '.DS_Store',
  '.ssh',
  '.aws',
  '.azure',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.env',
  '.env.*',
] as const;
export type ProjectSnapshotIssue = {
  reason:
    | 'policy-excluded'
    | 'git-unavailable'
    | 'git-failed'
    | 'directory-ignore-unavailable'
    | 'invalid-path'
    | 'symlink'
    | 'nonregular'
    | 'unavailable'
    | 'changed'
    | 'entry-limit'
    | 'depth-limit'
    | 'oversize'
    | 'read-budget'
    | 'change-limit'
    | 'incomplete-baseline'
    | 'enumeration-changed'
    | 'issue-limit';
  path?: string;
  count?: number;
};
export type ProjectTreeEntry = { path: string; type: 'file' | 'directory'; size: number };
export type ProjectFileTree = {
  entries: ProjectTreeEntry[];
  source: 'git' | 'directory';
  partial: boolean;
  enumerationComplete: boolean;
  issues: ProjectSnapshotIssue[];
};
export type ProjectSnapshotFile = {
  path: string;
  size: number;
  state: 'text' | 'binary' | 'oversize' | 'unavailable';
  // Metadata fingerprints can detect some changes to unread files, but never
  // assert equality of their contents. Only version is a content digest.
  metadataVersion: string;
  version?: string;
  mediaType?: 'text/plain' | 'application/octet-stream';
  text?: string;
};
export type ProjectSnapshot = Omit<ProjectFileTree, 'entries'> & {
  version: 1;
  files: ProjectSnapshotFile[];
  bytesRead: number;
};
export type ProjectSnapshotChange = {
  path: string;
  previousPath?: string;
  kind: 'added' | 'deleted' | 'modified' | 'renamed';
  before: ProjectSnapshotFile | null;
  after: ProjectSnapshotFile | null;
};
export type ProjectSnapshotDiff = {
  version: 1;
  basis: 'project-snapshot';
  changes: ProjectSnapshotChange[];
  partial: boolean;
  issues: ProjectSnapshotIssue[];
};
type Checkpoint =
  | 'root-checked'
  | 'directory-opened'
  | 'directory-read'
  | 'before-file'
  | 'after-file';
export type ProjectSnapshotOptions = {
  // These controls are host-injected only, never accepted from remote requests.
  limits?: Partial<Record<'entries' | 'bytes' | 'changes' | 'depth', number>>;
  checkpoint?: (stage: Checkpoint, path?: string) => void | Promise<void>;
  git?: (rootPath: string) => Promise<string>;
  fileReader?: typeof readProjectFileBytes;
};
type DirectoryIdentity = { path: string; stat: BigIntStats };
const hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const sameIdentity = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const metadataVersion = (stat: BigIntStats) =>
  hash(
    [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':'),
  );
const pathOrder = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
function limits(options: ProjectSnapshotOptions) {
  const result: { -readonly [Key in keyof typeof PROJECT_SNAPSHOT_LIMITS]: number } = {
    ...PROJECT_SNAPSHOT_LIMITS,
  };
  for (const key of ['entries', 'bytes', 'changes', 'depth'] as const) {
    const value = options.limits?.[key];
    if (value !== undefined) {
      assert(
        Number.isSafeInteger(value) && value >= 0 && value <= result[key],
        400,
        '文件快照限制无效',
      );
      result[key] = value;
    }
  }
  return result;
}
function issues(initial: ProjectSnapshotIssue[] = []) {
  const values: ProjectSnapshotIssue[] = [];
  const seen = new Map<string, ProjectSnapshotIssue>();
  function add(reason: ProjectSnapshotIssue['reason'], path?: string, count = 1) {
    const key = reason + '/' + (path ?? '');
    const found = seen.get(key);
    if (found) {
      found.count = (found.count ?? 1) + count;
      return;
    }
    if (values.length >= PROJECT_SNAPSHOT_LIMITS.issues - 1) {
      const tail = values.at(-1)!;
      if (tail.reason === 'issue-limit') tail.count = (tail.count ?? 1) + count;
      else values.push({ reason: 'issue-limit', count });
      return;
    }
    const value = { reason, ...(path ? { path } : {}), ...(count > 1 ? { count } : {}) };
    values.push(value);
    seen.set(key, value);
  }
  for (const issue of initial) add(issue.reason, issue.path, issue.count);
  return { values, add };
}
function excluded(path: string) {
  return path
    .split('/')
    .some(
      (part) =>
        PROJECT_SNAPSHOT_EXCLUDES.includes(part as never) ||
        (part.startsWith('.env.') &&
          !['.env.example', '.env.sample', '.env.template'].includes(part)),
    );
}
async function checkedRoot(rootPath: string) {
  assert(isAbsolute(rootPath) && resolve(rootPath) === rootPath, 403, '项目目录不可用');
  const anchor = parse(rootPath).root,
    directories: DirectoryIdentity[] = [];
  let path = anchor;
  for (const part of ['', ...rootPath.slice(anchor.length).split('/').filter(Boolean)]) {
    if (part) path = join(path, part);
    const stat = await lstat(path, { bigint: true });
    assert(stat.isDirectory(), 403, '项目目录不能包含符号链接或非目录');
    directories.push({ path, stat });
  }
  return directories;
}
async function recheck(directories: DirectoryIdentity[]) {
  for (const previous of directories) {
    const current = await lstat(previous.path, { bigint: true });
    assert(
      current.isDirectory() && sameIdentity(previous.stat, current),
      409,
      '项目目录已变化，请重新读取',
    );
  }
}
async function safeStat(rootPath: string, path: string) {
  projectFilePathSchema.parse(path);
  const parents = await checkedRoot(rootPath);
  const pieces = path.split('/');
  let current = rootPath;
  for (const piece of pieces.slice(0, -1)) {
    current = join(current, piece);
    const stat = await lstat(current, { bigint: true });
    assert(stat.isDirectory(), 403, '项目路径不可读取');
    parents.push({ path: current, stat });
  }
  const stat = await lstat(join(rootPath, path), { bigint: true });
  await recheck(parents);
  return stat;
}
function reason(error: unknown): ProjectSnapshotIssue['reason'] {
  return error instanceof AppError && error.status === 409 ? 'changed' : 'unavailable';
}

// No shell, hooks, fsmonitor executable, inherited GIT_DIR, or optional index
// writes. Git decides only candidate paths; every file still uses our reader.
export function gitProjectPaths(rootPath: string): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return new Promise((resolveOutput, reject) => {
    execFile(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        '-C',
        rootPath,
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        '.',
      ],
      {
        env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
        encoding: 'utf8',
        maxBuffer: PROJECT_SNAPSHOT_LIMITS.gitOutput,
        timeout: 10000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = new Error('项目 Git 文件枚举不可用') as Error & {
            code?: string;
            nonRepository?: boolean;
          };
          failure.code = String(error.code ?? '');
          failure.nonRepository = /not a git repository/.test(stderr);
          reject(failure);
        } else resolveOutput(stdout);
      },
    );
  });
}

/**
 * Enumerates a bounded, filtered project view, never an absolute-path listing.
 * Directory/file checks detect observable replacements but cannot provide an OS
 * sandbox against a malicious local process swapping ancestors between checks.
 * Plain directories do not implement .gitignore; exclusions are listed above.
 */
export async function enumerateProjectFiles(
  rootPath: string,
  options: ProjectSnapshotOptions = {},
): Promise<ProjectFileTree> {
  try {
    const root = await checkedRoot(rootPath),
      bound = limits(options),
      report = issues();
    await options.checkpoint?.('root-checked');
    await recheck(root);
    let source: 'git' | 'directory' = 'git',
      enumerationComplete = true,
      paths: string[] = [];
    try {
      paths = (await (options.git ?? gitProjectPaths)(rootPath)).split('\0').filter(Boolean);
    } catch (error) {
      source = 'directory';
      const failure = error as { code?: string; nonRepository?: boolean };
      if (!failure.nonRepository)
        report.add(failure.code === 'ENOENT' ? 'git-unavailable' : 'git-failed');
      report.add('directory-ignore-unavailable');
    }
    await recheck(root);
    const entries = new Map<string, ProjectTreeEntry>();
    function add(path: string, type: ProjectTreeEntry['type'], size: number) {
      if (entries.has(path)) return true;
      if (entries.size >= bound.entries) {
        enumerationComplete = false;
        report.add('entry-limit');
        return false;
      }
      entries.set(path, { path, type, size });
      return true;
    }
    const rejectPath = (path: string) => {
      if (!projectFilePathSchema.safeParse(path).success) {
        report.add('invalid-path');
        enumerationComplete = false;
        return true;
      }
      if (excluded(path)) {
        report.add('policy-excluded', path);
        return true;
      }
      if (path.split('/').length > bound.depth) {
        report.add('depth-limit', path);
        enumerationComplete = false;
        return true;
      }
      return false;
    };
    if (source === 'git') {
      // The Git view deliberately excludes standard ignored/untracked files and
      // repository internals; make that filtered scope visible even if no
      // additional dependency/credential exclusion was encountered.
      report.add('policy-excluded');
      for (const path of [...new Set(paths)].sort()) {
        if (rejectPath(path)) continue;
        try {
          const stat = await safeStat(rootPath, path);
          if (!stat.isFile()) {
            report.add(stat.isSymbolicLink() ? 'symlink' : 'nonregular', path);
            continue;
          }
          const pieces = path.split('/');
          let complete = true;
          for (let count = 1; count < pieces.length; count++)
            if (!add(pieces.slice(0, count).join('/'), 'directory', 0)) {
              complete = false;
              break;
            }
          if (!complete || !add(path, 'file', Number(stat.size))) break;
        } catch (error) {
          // A tracked deletion is absent from this worktree baseline. It remains
          // visible as a deletion when compared with the earlier frozen snapshot.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            report.add(reason(error), path);
            enumerationComplete = false;
          }
        }
      }
    } else {
      const pending = [''];
      while (pending.length) {
        const path = pending.shift()!;
        try {
          const before = path ? await safeStat(rootPath, path) : root.at(-1)!.stat;
          assert(before.isDirectory(), 403, '项目目录不可读取');
          const directory = await opendir(join(rootPath, path));
          const names: string[] = [];
          try {
            await options.checkpoint?.('directory-opened', path || undefined);
            await recheck(root);
            const opened = path
              ? await safeStat(rootPath, path)
              : (await checkedRoot(rootPath)).at(-1)!.stat;
            assert(sameIdentity(before, opened), 409, '项目目录已变化');
            for await (const entry of directory) {
              names.push(entry.name);
              if (names.length > bound.entries) {
                report.add('entry-limit', path || undefined);
                enumerationComplete = false;
                break;
              }
            }
            await options.checkpoint?.('directory-read', path || undefined);
            const after = path
              ? await safeStat(rootPath, path)
              : (await checkedRoot(rootPath)).at(-1)!.stat;
            assert(sameIdentity(before, after), 409, '项目目录已变化');
          } finally {
            await directory.close().catch(() => {});
          }
          for (const name of names.sort()) {
            const child = path ? path + '/' + name : name;
            if (rejectPath(child)) continue;
            try {
              const stat = await safeStat(rootPath, child);
              if (stat.isSymbolicLink()) {
                report.add('symlink', child);
                continue;
              }
              if (!stat.isFile() && !stat.isDirectory()) {
                report.add('nonregular', child);
                continue;
              }
              if (
                !add(
                  child,
                  stat.isDirectory() ? 'directory' : 'file',
                  stat.isFile() ? Number(stat.size) : 0,
                )
              )
                break;
              if (stat.isDirectory()) pending.push(child);
            } catch (error) {
              report.add(reason(error), child);
              enumerationComplete = false;
            }
          }
        } catch (error) {
          report.add(reason(error), path || undefined);
          enumerationComplete = false;
        }
        if (entries.size >= bound.entries && pending.length) {
          report.add('entry-limit');
          enumerationComplete = false;
          break;
        }
      }
    }
    await recheck(root);
    return {
      entries: [...entries.values()].sort(pathOrder),
      source,
      partial: report.values.length > 0,
      enumerationComplete,
      issues: report.values,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(403, '项目文件树不可读取');
  }
}

async function captureSnapshot(
  rootPath: string,
  options: ProjectSnapshotOptions = {},
): Promise<ProjectSnapshot> {
  const root = await checkedRoot(rootPath),
    tree = await enumerateProjectFiles(rootPath, options),
    bound = limits(options),
    report = issues(tree.issues);
  const files: ProjectSnapshotFile[] = [];
  let bytesRead = 0;
  for (const entry of tree.entries) {
    if (entry.type !== 'file') continue;
    let file: ProjectSnapshotFile = {
      path: entry.path,
      size: entry.size,
      state: 'unavailable',
      metadataVersion: '',
    };
    try {
      await options.checkpoint?.('before-file', entry.path);
      const stat = await safeStat(rootPath, entry.path);
      assert(stat.isFile(), 403, '项目文件不可读取');
      file = { ...file, size: Number(stat.size), metadataVersion: metadataVersion(stat) };
      if (stat.size > BigInt(CONTENT_LIMITS.fileBytes)) {
        file.state = 'oversize';
        report.add('oversize', entry.path);
      } else if (bytesRead + Number(stat.size) > bound.bytes) report.add('read-budget', entry.path);
      else {
        const { bytes, content } = await (options.fileReader ?? readProjectFileBytes)(
          rootPath,
          entry.path,
        );
        bytesRead += bytes.length;
        assert(bytesRead <= bound.bytes, 413, '文件快照读取超出总量限制');
        await options.checkpoint?.('after-file', entry.path);
        const after = await safeStat(rootPath, entry.path);
        assert(
          after.isFile() && metadataVersion(stat) === metadataVersion(after),
          409,
          '项目文件已变化',
        );
        file = {
          ...file,
          size: content.byteLength,
          version: content.version,
          mediaType: content.mediaType,
          state: content.mediaType === 'text/plain' ? 'text' : 'binary',
          ...(content.mediaType === 'text/plain'
            ? { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
            : {}),
        };
      }
    } catch (error) {
      report.add(reason(error), entry.path);
    }
    files.push(file);
  }
  await recheck(root);
  return {
    version: 1,
    files,
    bytesRead,
    source: tree.source,
    partial: report.values.length > 0,
    enumerationComplete: tree.enumerationComplete,
    issues: report.values,
  };
}

export async function captureProjectSnapshot(
  rootPath: string,
  options: ProjectSnapshotOptions = {},
): Promise<ProjectSnapshot> {
  try {
    return await captureSnapshot(rootPath, options);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(403, '项目文件快照不可读取');
  }
}

/**
 * Pure comparison of frozen data: subsequent files or Agent turns cannot alter
 * this result. It describes observed project changes, including external edits;
 * it never attributes those changes exclusively to one Agent.
 */
export function compareProjectSnapshots(
  before: ProjectSnapshot,
  after: ProjectSnapshot,
  options: ProjectSnapshotOptions = {},
): ProjectSnapshotDiff {
  const bound = limits(options),
    report = issues([...before.issues, ...after.issues]);
  const oldFiles = new Map(before.files.map((file) => [file.path, file])),
    newFiles = new Map(after.files.map((file) => [file.path, file]));
  const changes: ProjectSnapshotChange[] = [],
    deleted: ProjectSnapshotFile[] = [],
    added: ProjectSnapshotFile[] = [];
  const sourceChanged = before.source !== after.source;
  if (sourceChanged) report.add('enumeration-changed');
  for (const file of before.files) {
    const next = newFiles.get(file.path);
    if (!next) {
      if (after.enumerationComplete && !sourceChanged) deleted.push(file);
      else report.add('incomplete-baseline', file.path);
    } else if (!file.metadataVersion || !next.metadataVersion) {
      report.add('incomplete-baseline', file.path);
    } else if (
      file.version && next.version
        ? file.version !== next.version
        : file.metadataVersion !== next.metadataVersion
    ) {
      changes.push({ path: file.path, kind: 'modified', before: file, after: next });
    }
  }
  for (const file of after.files)
    if (!oldFiles.has(file.path)) {
      if (before.enumerationComplete && !sourceChanged) added.push(file);
      else report.add('incomplete-baseline', file.path);
    }
  // Pair exact content only; ambiguous duplicate contents are paired in stable
  // path order. Modified renames remain an addition plus a deletion.
  const byVersion = new Map<string, ProjectSnapshotFile[]>();
  for (const file of [...deleted].sort(pathOrder))
    if (file.version) {
      const matches = byVersion.get(file.version) ?? [];
      matches.push(file);
      byVersion.set(file.version, matches);
    }
  const renamed = new Set<string>();
  for (const file of [...added].sort(pathOrder)) {
    const previous = file.version ? byVersion.get(file.version)?.shift() : undefined;
    if (previous) {
      renamed.add(previous.path);
      changes.push({
        path: file.path,
        previousPath: previous.path,
        kind: 'renamed',
        before: previous,
        after: file,
      });
    } else changes.push({ path: file.path, kind: 'added', before: null, after: file });
  }
  for (const file of deleted)
    if (!renamed.has(file.path))
      changes.push({ path: file.path, kind: 'deleted', before: file, after: null });
  changes.sort(pathOrder);
  if (changes.length > bound.changes)
    report.add('change-limit', undefined, changes.length - bound.changes);
  return structuredClone({
    version: 1,
    basis: 'project-snapshot',
    changes: changes.slice(0, bound.changes),
    partial: before.partial || after.partial || report.values.length > 0,
    issues: report.values,
  });
}
