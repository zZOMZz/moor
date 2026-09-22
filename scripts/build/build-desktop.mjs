import { build } from 'electron-vite';
import { join } from 'node:path';
import { mkdir, cp } from 'node:fs/promises';
import { buildRuntime, runtimeGroups } from './runtime-build.mjs';
import { repository } from './workspace-sources.mjs';

process.chdir(repository);
await build();
await buildRuntime(['host', 'client']);
const destination = join(repository, 'dist/desktop/runtime');
await mkdir(destination, { recursive: true });
for (const group of ['host', 'client']) {
  for (const name of Object.keys(runtimeGroups[group]))
    for (const suffix of ['.mjs', '.mjs.map'])
      await cp(join(repository, 'dist', name + suffix), join(destination, name + suffix));
  await cp(
    join(repository, 'dist', group + '-NOTICES.txt'),
    join(destination, group + '-NOTICES.txt'),
  );
}
