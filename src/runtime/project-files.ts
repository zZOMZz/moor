import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { CONTENT_LIMITS, projectFilePathSchema } from '../content-protocol';
import { AppError, assert } from '../protocol';

type Checkpoint = 'directories-checked' | 'opened' | 'before-read' | 'after-read';
export type ProjectFileReadOptions = {
  // Test-only synchronization lives in the host process, never in a request.
  checkpoint?: (stage: Checkpoint) => void | Promise<void>;
};
type Directory = { path: string; identity: BigIntStats };

// Reserved host data remains unreadable even if a parent directory is later
// registered as a project. Case folding also protects case-insensitive volumes.
export function isHostPrivateProjectPath(path: string) {
  return path.split('/').some((part) => {
    const name = part.toLowerCase();
    return ['github-v1.json', 'preview-v1.json', 'skills-v1.json'].some(
      (privateName) => name === privateName || name.startsWith(privateName + '.tmp-'),
    );
  });
}

function sameIdentity(a: BigIntStats, b: BigIntStats) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}
function unchangedFile(a: BigIntStats, b: BigIntStats) {
  return (
    sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}
async function checkDirectories(directories: Directory[]) {
  for (const directory of directories) {
    const current = await lstat(directory.path, { bigint: true });
    assert(
      current.isDirectory() && sameIdentity(directory.identity, current),
      409,
      '项目目录已变化，请重新读取',
    );
  }
}

/**
 * Conservative portable Node reader. Directory identities are checked around
 * opening and reading; the leaf descriptor never follows a symlink or blocks on
 * a FIFO. Node has no portable openat2/RESOLVE_BENEATH equivalent: these checks
 * cannot make traversal atomic against a malicious local process repeatedly
 * swapping an ancestor away and back between checks. They detect observable
 * replacements and fail closed, but do not establish an OS sandbox boundary.
 */
export async function readProjectFileBytes(
  rootPath: string,
  relativePath: string,
  options: ProjectFileReadOptions = {},
) {
  projectFilePathSchema.parse(relativePath);
  assert(!isHostPrivateProjectPath(relativePath), 403, '项目文件属于 Moor 主机私有配置，不可读取');
  assert(isAbsolute(rootPath) && resolve(rootPath) === rootPath, 403, '项目目录不可用');
  try {
    const fullPath = join(rootPath, relativePath),
      anchor = parse(fullPath).root,
      parts = fullPath.slice(anchor.length).split('/'),
      directories: Directory[] = [];
    let directoryPath = anchor;
    for (const part of ['', ...parts.slice(0, -1)]) {
      if (part) directoryPath = join(directoryPath, part);
      const identity = await lstat(directoryPath, { bigint: true });
      assert(identity.isDirectory(), 403, '项目文件路径不能包含符号链接或非目录');
      directories.push({ path: directoryPath, identity });
    }
    const leaf = await lstat(fullPath, { bigint: true });
    assert(leaf.isFile(), 403, '只允许读取普通项目文件');
    assert(leaf.size <= BigInt(CONTENT_LIMITS.fileBytes), 413, '项目文件超过 1 MiB 限制');
    await options.checkpoint?.('directories-checked');
    const file = await open(
      fullPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat({ bigint: true });
      assert(before.isFile() && unchangedFile(leaf, before), 409, '项目文件已变化，请重新读取');
      assert(before.size <= BigInt(CONTENT_LIMITS.fileBytes), 413, '项目文件超过 1 MiB 限制');
      await options.checkpoint?.('opened');
      await checkDirectories(directories);
      const currentLeaf = await lstat(fullPath, { bigint: true });
      assert(
        currentLeaf.isFile() && unchangedFile(before, currentLeaf),
        409,
        '项目文件已变化，请重新读取',
      );
      await options.checkpoint?.('before-read');
      const buffer = Buffer.alloc(CONTENT_LIMITS.fileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      assert(length <= CONTENT_LIMITS.fileBytes, 413, '项目文件超过 1 MiB 限制');
      await options.checkpoint?.('after-read');
      const after = await file.stat({ bigint: true });
      assert(
        unchangedFile(before, after) && after.size === BigInt(length),
        409,
        '项目文件在读取时发生变化，请重试',
      );
      await checkDirectories(directories);
      const finalLeaf = await lstat(fullPath, { bigint: true });
      assert(
        finalLeaf.isFile() && unchangedFile(after, finalLeaf),
        409,
        '项目文件已变化，请重新读取',
      );
      const bytes = buffer.subarray(0, length);
      let mediaType: 'text/plain' | 'application/octet-stream' = 'application/octet-stream';
      if (!bytes.includes(0)) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          mediaType = 'text/plain';
        } catch {
          // Preserve invalid UTF-8 as bytes instead of silently replacing it.
        }
      }
      return {
        bytes,
        content: {
          version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
          byteLength: bytes.length,
          mediaType,
        },
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new AppError(404, '项目文件不可用');
    if (code === 'ELOOP' || code === 'EACCES' || code === 'EPERM')
      throw new AppError(403, '项目文件不可读取');
    throw new AppError(500, '读取项目文件失败');
  }
}
