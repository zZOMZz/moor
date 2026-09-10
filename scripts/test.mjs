import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('dist/tests', { recursive: true });
const tests = (await readdir('tests')).filter((n) => n.endsWith('.test.ts'));
// Bundle tests like production. One external WASM module owns all CRDT instances.
for (const file of tests)
  await build({
    entryPoints: ['tests/' + file],
    outfile: 'dist/tests/' + file.replace('.ts', '.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['loro-crdt', 'ws', 'jsdom', 'react', 'react-dom', 'react-dom/client'],
    banner: {
      js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
    },
  });
const result = spawnSync(
  process.execPath,
  ['--test', ...tests.map((n) => 'dist/tests/' + n.replace('.ts', '.mjs'))],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
