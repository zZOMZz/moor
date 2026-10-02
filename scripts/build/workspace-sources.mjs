import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Package manifests own their public source paths. Discover every package so
// development cannot silently combine new source with an omitted package's dist.
export function workspaceSourceAliases(root = repository) {
  return readdirSync(resolve(root, 'packages'), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(resolve(root, 'packages', entry.name, 'package.json')),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const directory = resolve(root, 'packages', entry.name);
      const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
      if (!manifest.name?.startsWith('@moor/')) throw Error('Expected a Moor workspace package');
      return Object.entries(manifest.exports).map(([path, conditions]) => {
        const source = conditions.types;
        const subpath = path === '.' ? '' : path.slice(1);
        if (
          !source?.startsWith('./src/') ||
          (path !== '.' && !/^\.\/[A-Za-z0-9_./-]+$/.test(path)) ||
          path.includes('..') ||
          subpath.includes('*') ||
          source.includes('*')
        )
          throw Error(`Unsupported source export ${manifest.name}${path}`);
        const pattern = escapePattern(manifest.name + subpath);
        return {
          find: new RegExp(`^${pattern}$`),
          replacement: resolve(directory, source),
        };
      });
    });
}

export const workspaceAliases = workspaceSourceAliases();

export const workspaceSources = {
  name: 'moor-workspace-sources',
  setup(build) {
    build.onResolve({ filter: /^@moor\// }, ({ path }) => {
      for (const alias of workspaceAliases)
        if (alias.find.test(path)) return { path: path.replace(alias.find, alias.replacement) };
    });
  },
};
