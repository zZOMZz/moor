import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, resolve } from 'node:path';
import { projectFilePathSchema } from '../content-protocol';
import { AppError, assert } from '../protocol';
import { isPrivateEndpointEnvelope } from '../security/private-content';
import {
  SKILLS_LIMITS,
  skillSourceSchema,
  skillSummarySchema,
  type SkillIssue,
  type SkillSource,
  type SkillSummary,
} from '../skills-protocol';
import { isHostPrivateProjectPath } from './project-files';

export type SkillDiscoveryCheckpoint =
  | 'source-checked'
  | 'directory-opened'
  | 'entry-read'
  | 'file-opened'
  | 'before-file-read'
  | 'after-file-read';
export type SkillDiscoveryOptions = {
  assertCurrent?: () => void;
  checkpoint?: (
    stage: SkillDiscoveryCheckpoint,
    entry: { sourceId: string; path?: string },
  ) => void | Promise<void>;
};
export type DiscoveredSkills = {
  sources: SkillSource[];
  skills: SkillSummary[];
  issues: SkillIssue[];
  truncated: boolean;
  documents: Map<string, { skill: SkillSummary; text: string }>;
};
type Directory = { path: string; identity: BigIntStats; observed: boolean };
const changed = () => new AppError(409, 'Skills 文件或目录已变化，请重新读取');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const identityMatches = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const fileMatches = (a: BigIntStats, b: BigIntStats) =>
  identityMatches(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

// This is deliberately a small, non-evaluating metadata reader, not a YAML runtime.
// Unsupported forms remain readable as Markdown and receive a directory-name label.
function metadata(
  text: string,
  path: string,
): Pick<SkillSummary, 'name' | 'description' | 'metadata'> {
  const fallback = {
    name: basename(path.slice(0, -'/SKILL.md'.length)).slice(0, 200) || 'Skill',
    description: '',
    metadata: 'unparsed' as const,
  };
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') return fallback;
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end < 1 || end > 128 || Buffer.byteLength(lines.slice(0, end).join('\n')) > 8192)
    return fallback;
  const fields = new Map<string, string>();
  for (let index = 1; index < end; index++) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line);
    if (!match) return fallback;
    const key = match[1]!,
      value = match[2]?.trim() ?? '';
    if (fields.has(key)) return fallback;
    let decoded: string;
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (index + 1 < end && (/^[ \t]/.test(lines[index + 1]!) || !lines[index + 1]))
        block.push(lines[++index]!);
      const nonempty = block.filter((part) => part.trim());
      if (nonempty.some((part) => part.startsWith('\t'))) return fallback;
      const indent = Math.min(...nonempty.map((part) => /^ */.exec(part)![0].length));
      const content = block.map((part) => part.slice(Number.isFinite(indent) ? indent : 0));
      decoded = value.startsWith('>') ? content.join(' ').trim() : content.join('\n').trimEnd();
    } else if (value.startsWith('"')) {
      try {
        decoded = JSON.parse(value) as string;
        if (typeof decoded !== 'string') return fallback;
      } catch {
        return fallback;
      }
    } else if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value)) return fallback;
      decoded = value.slice(1, -1).replace(/''/g, "'");
    } else {
      if (/^[!&*[{]|:\s/.test(value)) return fallback;
      decoded = value.replace(/\s+#.*$/, '').trim();
    }
    fields.set(key, decoded);
  }
  const name = fields.get('name') || fallback.name;
  if (name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) return fallback;
  return {
    name,
    description: (fields.get('description') ?? '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .slice(0, 2000),
    metadata: 'parsed',
  };
}

/**
 * Reads only bounded SKILL.md entries below host-selected roots. Directory identities
 * are checked around every traversal and read; leaves use O_NOFOLLOW/O_NONBLOCK.
 * Portable Node has no openat2/RESOLVE_BENEATH: observable replacement is rejected,
 * but a malicious local process swapping ancestors away and back between syscalls
 * cannot be excluded by these checks. This is not an OS filesystem sandbox.
 */
async function discover(
  inputs: Array<{ source: SkillSource; rootPath: string }>,
  options: SkillDiscoveryOptions = {},
): Promise<DiscoveredSkills> {
  options.assertCurrent?.();
  assert(inputs.length <= SKILLS_LIMITS.globalSources + 3, 400, 'Skills 来源数量超过限制');
  assert(
    new Set(inputs.map(({ source }) => source.id)).size === inputs.length,
    400,
    'Skills 来源重复',
  );
  const result: DiscoveredSkills = {
    sources: [],
    skills: [],
    issues: [],
    truncated: false,
    documents: new Map(),
  };
  const observedDirectories: Directory[] = [];
  const observedFiles: Array<{ path: string; identity: BigIntStats }> = [];
  let entries = 0;
  const checked = async <T>(promise: Promise<T>): Promise<T> => {
    try {
      return await promise;
    } finally {
      options.assertCurrent?.();
    }
  };
  const acquire = async <T extends { close(): Promise<void> }>(promise: Promise<T>): Promise<T> => {
    let handle: T;
    try {
      handle = await promise;
    } catch (error) {
      options.assertCurrent?.();
      throw error;
    }
    try {
      options.assertCurrent?.();
      return handle;
    } catch (error) {
      await handle.close();
      options.assertCurrent?.();
      throw error;
    }
  };
  const checkpoint = async (stage: SkillDiscoveryCheckpoint, sourceId: string, path?: string) => {
    await checked(
      Promise.resolve(options.checkpoint?.(stage, { sourceId, ...(path ? { path } : {}) })),
    );
  };
  const issue = (sourceId: string, reason: SkillIssue['reason'], path?: string) => {
    if (result.issues.length >= SKILLS_LIMITS.issues) {
      result.truncated = true;
      return;
    }
    result.issues.push({
      sourceId,
      reason,
      ...(path && projectFilePathSchema.safeParse(path).success ? { path } : {}),
    });
  };
  const verify = async (directories: Directory[]) => {
    for (const directory of directories) {
      let current: BigIntStats;
      try {
        current = await checked(lstat(directory.path, { bigint: true }));
      } catch (error) {
        options.assertCurrent?.();
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(codeOf(error) ?? '')) throw changed();
        throw error;
      }
      if (
        !current.isDirectory() ||
        !identityMatches(directory.identity, current) ||
        (directory.observed &&
          (directory.identity.mtimeNs !== current.mtimeNs ||
            directory.identity.ctimeNs !== current.ctimeNs))
      )
        throw changed();
    }
  };
  for (const input of inputs) {
    const source = skillSourceSchema.parse({ ...input.source, status: 'available' });
    result.sources.push(source);
    assert(
      isAbsolute(input.rootPath) && resolve(input.rootPath) === input.rootPath,
      400,
      'Skills 来源目录不可用',
    );
    if (isHostPrivateProjectPath(input.rootPath)) {
      source.status = 'unavailable';
      issue(source.id, 'unreadable');
      continue;
    }
    const directories: Directory[] = [];
    const anchor = parse(input.rootPath).root;
    let path = anchor;
    try {
      for (const part of ['', ...input.rootPath.slice(anchor.length).split('/').filter(Boolean)]) {
        if (part) path = join(path, part);
        const identity = await checked(lstat(path, { bigint: true }));
        if (!identity.isDirectory()) {
          source.status = 'unavailable';
          break;
        }
        directories.push({ path, identity, observed: path === input.rootPath });
      }
    } catch (error) {
      options.assertCurrent?.();
      if (['ENOENT', 'ENOTDIR'].includes(codeOf(error) ?? '')) source.status = 'missing';
      else if (['EACCES', 'EPERM', 'ELOOP'].includes(codeOf(error) ?? ''))
        source.status = 'unavailable';
      else throw error;
    }
    if (source.status !== 'available') {
      if (source.status === 'unavailable') issue(source.id, 'unreadable');
      continue;
    }
    await checkpoint('source-checked', source.id);
    await verify(directories);
    observedDirectories.push(...directories);
    const read = async (relative: string, leaf: BigIntStats, parents: Directory[]) => {
      if (leaf.size > BigInt(SKILLS_LIMITS.fileBytes)) {
        issue(source.id, 'too-large', relative);
        return;
      }
      const full = join(input.rootPath, relative);
      let file;
      try {
        file = await acquire(
          open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
        );
      } catch (error) {
        options.assertCurrent?.();
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(codeOf(error) ?? '')) throw changed();
        if (['EACCES', 'EPERM'].includes(codeOf(error) ?? '')) {
          issue(source.id, 'unreadable', relative);
          return;
        }
        throw error;
      }
      try {
        const before = await checked(file.stat({ bigint: true }));
        if (!before.isFile() || !fileMatches(leaf, before)) throw changed();
        await checkpoint('file-opened', source.id, relative);
        await verify(parents);
        if (!fileMatches(before, await checked(lstat(full, { bigint: true })))) throw changed();
        await checkpoint('before-file-read', source.id, relative);
        const bytes = Buffer.alloc(SKILLS_LIMITS.fileBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await checked(
            file.read(bytes, length, bytes.length - length, length),
          );
          if (!bytesRead) break;
          length += bytesRead;
        }
        await checkpoint('after-file-read', source.id, relative);
        const after = await checked(file.stat({ bigint: true }));
        if (!fileMatches(before, after) || after.size !== BigInt(length)) throw changed();
        await verify(parents);
        if (!fileMatches(after, await checked(lstat(full, { bigint: true })))) throw changed();
        if (length > SKILLS_LIMITS.fileBytes) {
          issue(source.id, 'too-large', relative);
          return;
        }
        const body = bytes.subarray(0, length);
        if (isPrivateEndpointEnvelope(body)) {
          issue(source.id, 'unreadable', relative);
          return;
        }
        let text: string;
        try {
          if (body.includes(0)) throw new Error();
          // Preserve BOM bytes in text so the public digest and byteLength agree.
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
        } catch {
          issue(source.id, 'invalid-text', relative);
          return;
        }
        const skill = skillSummarySchema.parse({
          id: 'skill:' + digest(source.id + '\0' + relative),
          sourceId: source.id,
          path: relative,
          ...metadata(text, relative),
          version: 'sha256:' + digest(body),
          byteLength: length,
        });
        result.skills.push(skill);
        result.documents.set(skill.id, { skill, text });
        observedFiles.push({ path: full, identity: after });
      } catch (error) {
        options.assertCurrent?.();
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(codeOf(error) ?? '')) throw changed();
        throw error;
      } finally {
        await checked(file.close());
      }
    };
    const visit = async (relative: string, parents: Directory[], depth: number): Promise<void> => {
      await verify(parents);
      let directory;
      try {
        directory = await acquire(opendir(join(input.rootPath, relative), { bufferSize: 1 }));
      } catch (error) {
        options.assertCurrent?.();
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(codeOf(error) ?? '')) throw changed();
        if (['EACCES', 'EPERM'].includes(codeOf(error) ?? '')) {
          if (!relative) source.status = 'unavailable';
          issue(source.id, 'unreadable', relative);
          return;
        }
        throw error;
      }
      try {
        await checkpoint('directory-opened', source.id, relative);
        await verify(parents);
        while (true) {
          if (entries >= SKILLS_LIMITS.entries || result.skills.length >= SKILLS_LIMITS.items) {
            result.truncated = true;
            issue(source.id, 'limit', relative);
            break;
          }
          const entry = await checked(directory.read());
          if (!entry) break;
          entries++;
          const child = relative ? relative + '/' + entry.name : entry.name;
          await checkpoint('entry-read', source.id, child);
          await verify(parents);
          if (!projectFilePathSchema.safeParse(child).success || isHostPrivateProjectPath(child)) {
            issue(source.id, 'unsupported-entry');
            continue;
          }
          let leaf: BigIntStats;
          try {
            leaf = await checked(lstat(join(input.rootPath, child), { bigint: true }));
          } catch (error) {
            options.assertCurrent?.();
            if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(codeOf(error) ?? '')) throw changed();
            if (['EACCES', 'EPERM'].includes(codeOf(error) ?? '')) {
              issue(source.id, 'unreadable', child);
              continue;
            }
            throw error;
          }
          if (leaf.isDirectory()) {
            if (depth >= SKILLS_LIMITS.depth) {
              result.truncated = true;
              issue(source.id, 'limit', child);
            } else {
              const childDirectory = {
                path: join(input.rootPath, child),
                identity: leaf,
                observed: true,
              };
              observedDirectories.push(childDirectory);
              await visit(child, [...parents, childDirectory], depth + 1);
            }
          } else if (!leaf.isFile()) issue(source.id, 'unsupported-entry', child);
          else if (entry.name === 'SKILL.md' && depth > 0) await read(child, leaf, parents);
        }
        await verify(parents);
      } finally {
        await checked(directory.close());
      }
    };
    await visit('', directories, 0);
    await verify(directories);
  }
  await verify(observedDirectories);
  for (const file of observedFiles) {
    let current: BigIntStats;
    try {
      current = await checked(lstat(file.path, { bigint: true }));
    } catch (error) {
      options.assertCurrent?.();
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(codeOf(error) ?? '')) throw changed();
      throw error;
    }
    if (!current.isFile() || !fileMatches(file.identity, current)) throw changed();
  }
  options.assertCurrent?.();
  result.skills.sort((a, b) =>
    a.sourceId < b.sourceId
      ? -1
      : a.sourceId > b.sourceId
        ? 1
        : a.path < b.path
          ? -1
          : a.path > b.path
            ? 1
            : 0,
  );
  return result;
}

export async function discoverSkills(
  inputs: Array<{ source: SkillSource; rootPath: string }>,
  options: SkillDiscoveryOptions = {},
): Promise<DiscoveredSkills> {
  try {
    return await discover(inputs, options);
  } catch (error) {
    options.assertCurrent?.();
    if (error instanceof AppError) throw error;
    // Native filesystem errors may contain absolute paths; never expose them.
    if (typeof codeOf(error) === 'string') throw new AppError(500, '读取 Skills 目录失败');
    throw error;
  }
}
