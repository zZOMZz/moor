import { context } from 'esbuild';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { repository, workspaceSources } from './workspace-sources.mjs';

export const desktopRuntimeGroups = Object.freeze({
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

// A failed rebuild publishes nothing. Revisions signal successful builds only.
export async function publishRuntime(result, revisionFile) {
  if (result.errors.length) return false;
  const hash = createHash('sha256');
  for (const file of result.outputFiles) hash.update(file.path).update(file.contents);
  const revision = hash.digest('hex');
  try {
    if ((await readFile(revisionFile, 'utf8')) === revision) {
      await Promise.all(result.outputFiles.map((file) => access(file.path)));
      return false;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const file of result.outputFiles) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path + '.next', file.contents);
    await rename(file.path + '.next', file.path);
  }
  await writeFile(revisionFile + '.next', revision);
  await rename(revisionFile + '.next', revisionFile);
  return true;
}

export async function buildDesktopRuntime({ appRoot, watch = false }) {
  const contexts = [];
  try {
    for (const [group, entryPoints] of Object.entries(desktopRuntimeGroups)) {
      const buildContext = await context({
        absWorkingDir: repository,
        entryPoints,
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'esm',
        sourcemap: true,
        outdir: join(appRoot, 'runtime'),
        outExtension: { '.js': '.mjs' },
        external: ['ws', 'loro-crdt'],
        write: false,
        banner: {
          js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        },
        plugins: [
          workspaceSources,
          {
            name: 'moor-runtime-revision',
            setup(build) {
              build.onEnd(async (result) => {
                if (await publishRuntime(result, join(appRoot, group + '-revision.txt')))
                  console.log(`[desktop] ${group} runtime built`);
              });
            },
          },
        ],
      });
      contexts.push(buildContext);
      await buildContext.rebuild();
      if (watch) await buildContext.watch();
    }
    return { dispose: () => Promise.all(contexts.map((item) => item.dispose())) };
  } catch (error) {
    await Promise.all(contexts.map((item) => item.dispose()));
    throw error;
  }
}
