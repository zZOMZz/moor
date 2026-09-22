import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserNotices } from './browser-notices.mjs';
import { repository, workspaceSources } from './workspace-sources.mjs';
import { recordEsbuildGraph } from '../validation/production-graph.mjs';

// Production, desktop packaging and the development watcher share these entries
// and options. A relay build never needs an Electron or Host entry.
export const runtimeGroups = Object.freeze({
  relay: { server: 'apps/relay/src/main.ts' },
  host: {
    bridge: 'apps/host/src/main.ts',
    cli: 'apps/cli/src/main.ts',
  },
  client: {
    'workspace-client': 'apps/desktop/src/main/workspace-client-entry.ts',
  },
});

export async function removeRetiredRuntimeFiles(outdir) {
  for (const name of ['security', 'desktop-client'])
    for (const suffix of ['.mjs', '.mjs.map'])
      await rm(join(outdir, name + suffix), { force: true });
  await rm(join(outdir, 'preview-renderer.cjs'), { force: true });
}

export const runtimeBuildOptions = {
  absWorkingDir: repository,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  metafile: true,
  outExtension: { '.js': '.mjs' },
  logOverride: { 'import-is-undefined': 'error' },
  external: ['ws', 'loro-crdt'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  plugins: [workspaceSources],
};

export async function buildRuntime(groups, outdir = join(repository, 'dist')) {
  await mkdir(outdir, { recursive: true });
  await removeRetiredRuntimeFiles(outdir);
  for (const group of groups) {
    if (!Object.hasOwn(runtimeGroups, group)) throw Error(`Unknown runtime group: ${group}`);
    const result = await build({
      ...runtimeBuildOptions,
      entryPoints: runtimeGroups[group],
      outdir,
    });
    await recordEsbuildGraph(group, result.metafile);
    await writeFile(
      join(outdir, group + '-NOTICES.txt'),
      await browserNotices(result.metafile.inputs, group),
    );
  }
}
