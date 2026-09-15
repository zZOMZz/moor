import { build } from 'esbuild';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@moor/'))
  throw new Error('Package build must run from a Moor workspace package');

async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sources(path)));
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts'))
      result.push(path);
  }
  return result;
}

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: await sources('src'),
  outbase: 'src',
  outdir: 'dist',
  bundle: true,
  splitting: true,
  packages: 'external',
  platform: 'neutral',
  format: 'esm',
  target: 'es2023',
  chunkNames: 'chunks/[name]-[hash]',
  logOverride: { 'import-is-undefined': 'error' },
  sourcemap: true,
});
