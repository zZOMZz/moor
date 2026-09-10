import { build } from 'esbuild';
import postcss from 'postcss';
import { browserNotices } from './browser-notices.mjs';
import tailwind from '@tailwindcss/postcss';
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
const browserBuild = await build({
  metafile: true,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['safari17', 'chrome120'],
  sourcemap: true,
  alias: { 'loro-crdt': 'loro-crdt/base64' },
  minify: true,
  entryPoints: ['src/web/app.ts'],
  outfile: 'dist/public/app.js',
});
await cp('src/web/public', 'dist/public', { recursive: true });
await writeFile(
  'dist/public/THIRD_PARTY_NOTICES.txt',
  await browserNotices(browserBuild.metafile.inputs),
);
const utilities = await postcss([tailwind()]).process(
  await readFile('src/web/utilities.css', 'utf8'),
  { from: 'src/web/utilities.css' },
);
await writeFile(
  'dist/public/style.css',
  utilities.css + '\n' + (await readFile('src/web/public/style.css', 'utf8')),
);

const { createHash } = await import('node:crypto');
const hash = createHash('sha256');
for (const file of [
  'app.js',
  'startup.js',
  'index.html',
  'style.css',
  'THIRD_PARTY_NOTICES.txt',
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
