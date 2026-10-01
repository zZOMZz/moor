import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** Shared private-path exclusion for ordinary project registration and endpoint files. */
export function assertPrivatePathsOutsideProjects(
  paths: readonly string[],
  projects: readonly string[],
) {
  const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  for (const project of projects) {
    const root = canonical(project);
    for (const path of paths) {
      const part = relative(root, canonical(path));
      if (part === '' || (part !== '..' && !part.startsWith('../') && !isAbsolute(part)))
        throw new Error('设备私有文件必须位于项目和会话工作目录之外。');
    }
  }
}
