import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
const packages = ['protocol', 'client', 'session', 'e2ee', 'host', 'gateway'];

// Development follows source imports, not stale workspace dist/ files.
export const workspaceAliases = packages.flatMap((name) => [
  {
    find: new RegExp(`^@moor/${name}$`),
    replacement: resolve(repository, 'packages', name, 'src/index.ts'),
  },
  {
    find: new RegExp(`^@moor/${name}/(.+)$`),
    replacement: resolve(repository, 'packages', name, 'src/$1.ts'),
  },
]);

export const workspaceSources = {
  name: 'moor-workspace-sources',
  setup(build) {
    build.onResolve({ filter: /^@moor\// }, ({ path }) => {
      for (const alias of workspaceAliases)
        if (alias.find.test(path)) return { path: path.replace(alias.find, alias.replacement) };
    });
  },
};
