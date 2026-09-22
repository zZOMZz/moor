import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browserNotices } from './browser-notices.mjs';
import { repository, workspaceSources } from './workspace-sources.mjs';

// Production, desktop packaging and the development watcher share these entries
// and options. A relay build never needs an Electron or Host entry.
export const runtimeGroups = Object.freeze({
  relay: { server: 'apps/relay/src/main.ts' },
  host: {
    bridge: 'apps/host/src/main.ts',
    cli: 'apps/cli/src/main.ts',
    security: 'apps/cli/src/security/main.ts',
  },
  client: {
    'desktop-client': 'apps/desktop/src/main/desktop-client.ts',
    'workspace-client': 'apps/desktop/src/main/workspace-client-entry.ts',
  },
});

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
  for (const group of groups) {
    if (!Object.hasOwn(runtimeGroups, group)) throw Error(`Unknown runtime group: ${group}`);
    const result = await build({
      ...runtimeBuildOptions,
      entryPoints: runtimeGroups[group],
      outdir,
    });
    await writeFile(
      join(outdir, group + '-NOTICES.txt'),
      await browserNotices(result.metafile.inputs, group),
    );
    if (group === 'host')
      await cp(
        join(repository, 'apps/desktop/src/main/preview-renderer.cjs'),
        join(outdir, 'preview-renderer.cjs'),
      );
  }
}
