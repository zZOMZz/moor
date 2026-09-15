import { build } from 'esbuild';
import { readdir, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(repository);
await rm(resolve(repository, 'dist/tests'), { recursive: true, force: true });
await mkdir('dist/tests', { recursive: true });
async function findTests(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await findTests(path)));
    else if (entry.name.endsWith('.test.ts')) result.push(path);
  }
  return result;
}
const scope = process.argv[2];
const roots = scope
  ? [join(scope, 'tests')]
  : [
      'tests',
      ...(await readdir('packages', { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join('packages', entry.name, 'tests')),
      ...(await readdir('apps', { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join('apps', entry.name, 'tests')),
    ];
const tests = (
  await Promise.all(
    roots.map((root) =>
      findTests(root).catch((error) => (error?.code === 'ENOENT' ? [] : Promise.reject(error))),
    ),
  )
)
  .flat()
  .sort();
// Hosted CI reports nominal CPUs even when subprocess-heavy suites share a
// constrained quota. Serialize files there so deliberate test deadlines keep
// measuring the operation under test rather than unrelated file contention.
const testConcurrency = process.env.CI ? 1 : Math.min(4, availableParallelism());
// Bundle tests like production. One external WASM module owns all CRDT instances.
for (const file of tests)
  await build({
    absWorkingDir: repository,
    entryPoints: [resolve(file)],
    outfile:
      resolve(repository, 'dist/tests') +
      '/' +
      file.replace(/[^A-Za-z0-9_.-]/g, '__').replace(/\.ts$/, '.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // Keep React shared with act(), but initialize bundled React DOM only when
    // each UI test imports its components after installing the synthetic DOM.
    external: ['loro-crdt', 'ws', 'jsdom', 'react'],
    banner: {
      js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
    },
  });
const result = spawnSync(
  process.execPath,
  [
    '--test',
    // Several suites exercise real child processes behind deliberate deadlines.
    // Bound file-level contention instead of weakening those timeout assertions.
    '--test-concurrency=' + String(testConcurrency),
    ...tests.map(
      (file) => 'dist/tests/' + file.replace(/[^A-Za-z0-9_.-]/g, '__').replace(/\.ts$/, '.mjs'),
    ),
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
