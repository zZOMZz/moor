import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert } from '@moor/protocol/protocol';
import type { SkillSource } from '@moor/protocol/skills-protocol';
import type { ExecutionLease } from '../../features/git/execution-model';
const hash = (value: unknown) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
function directoryIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 409, 'Skills 来源目录不可用');
  return [stat.dev.toString(), stat.ino.toString(), stat.mode.toString()];
}
export function projectSkillSources(lease: ExecutionLease) {
  const rootIdentity = directoryIdentity(resolve(lease.rootPath));
  const canonicalRoot = realpathSync(lease.rootPath);
  return (['agents', 'claude', 'codex'] as const).map((convention) => {
    const rootPath = join(canonicalRoot, '.' + convention, 'skills');
    let status: SkillSource['status'] = 'available';
    let identity: unknown;
    try {
      const parent = directoryIdentity(join(canonicalRoot, '.' + convention));
      identity = [parent, directoryIdentity(rootPath)];
    } catch (error) {
      status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable';
      identity = status;
    }
    return {
      rootPath,
      source: {
        id: 'project-' + convention,
        label: '.' + convention + '/skills',
        scope: 'project' as const,
        convention,
        status,
        version: hash([lease, canonicalRoot, rootIdentity, rootPath, identity]),
      },
    };
  });
}
