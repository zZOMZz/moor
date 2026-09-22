import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { repository } from '../build/workspace-sources.mjs';

// Knip's `paths` fallback runs after OXC has already resolved package exports to
// dist. Pass a real tsconfig to OXC so built and clean checkouts analyze the same
// sources. Keep this isolated from application TypeScript resolution.
const expected = {};
for (const group of ['apps', 'packages'])
  for (const directory of await readdir(join(repository, group))) {
    const manifest = await readFile(join(repository, group, directory, 'package.json'), 'utf8')
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === 'ENOENT') return;
        throw error;
      });
    if (!manifest) continue;
    for (const [subpath, conditions] of Object.entries(manifest.exports ?? {})) {
      if (!conditions.types) throw Error(`Missing source export: ${manifest.name}${subpath}`);
      expected[manifest.name + (subpath === '.' ? '' : subpath.slice(1))] = [
        './' + join(group, directory, conditions.types),
      ];
    }
  }
const config = JSON.parse(await readFile(join(repository, 'tsconfig.knip.json'), 'utf8'));
if (!isDeepStrictEqual(config.compilerOptions.paths, expected))
  throw Error('tsconfig.knip.json must map every workspace export to its manifest types source');

const result = spawnSync(
  process.execPath,
  [
    join(repository, 'node_modules/knip/bin/knip.js'),
    '--config',
    'knip.jsonc',
    '--tsConfig',
    'tsconfig.knip.json',
    ...process.argv.slice(2),
  ],
  { cwd: repository, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
