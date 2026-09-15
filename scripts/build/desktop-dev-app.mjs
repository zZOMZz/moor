import { mkdir, lstat } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';

// Builds own only app/. Development data is never copied, cleaned or packaged.
export async function prepareDesktopDevApp({ repository, developmentRoot } = {}) {
  const root = resolve(repository);
  developmentRoot = resolve(developmentRoot ?? join(root, '.runtime/desktop'));
  if (!developmentRoot.startsWith(root + sep))
    throw new Error('Desktop development output must stay inside the repository');
  const appRoot = join(developmentRoot, 'app');
  const dataRoot = join(developmentRoot, 'data');
  for (const directory of [developmentRoot, appRoot, dataRoot]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Desktop development directories must not be symlinks');
  }
  return { appRoot, dataRoot };
}
