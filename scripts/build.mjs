import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
// Public workspace packages ship TS source. Bundle them; keep only the native ws runtime external.
const nodeOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['ws', 'loro-crdt'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
  },
};
await build({ ...nodeOptions, entryPoints: ['src/relay/main.ts'], outfile: 'dist/server.mjs' });
await build({
  ...nodeOptions,
  entryPoints: ['src/bridge/host-main.ts'],
  outfile: 'dist/bridge.mjs',
});
await build({
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['safari17', 'chrome120'],
  sourcemap: true,
  alias: { 'loro-crdt': 'loro-crdt/base64' },
  entryPoints: ['src/web/app.ts'],
  outfile: 'dist/public/app.js',
});
await cp('src/web/public', 'dist/public', { recursive: true });

const { createHash } = await import('node:crypto');
const hash = createHash('sha256');
for (const file of [
  'app.js',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'favicon.ico',
])
  hash.update(await readFile('dist/public/' + file));
await writeFile(
  'dist/public/sw.js',
  (await readFile('dist/public/sw.js', 'utf8')).replace(
    '__BUILD__',
    hash.digest('hex').slice(0, 12),
  ),
);
