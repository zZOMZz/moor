import { build } from 'esbuild';
import { browserNotices } from './browser-notices.mjs';
import { browserWasm } from './browser-wasm.mjs';
import { workspaceSources } from './workspace-sources.mjs';
import { buildWebStyles } from '../../apps/web/scripts/build-styles.mjs';
import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { recordEsbuildGraph } from '../validation/production-graph.mjs';

await mkdir('dist/public', { recursive: true });
await rm('dist/public/assets', { recursive: true, force: true });
for (const file of ['app.js', 'app.js.map']) await rm('dist/public/' + file, { force: true });
const browserBuild = await build({
  metafile: true,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['safari17', 'chrome120'],
  sourcemap: true,
  alias: { 'loro-crdt': 'loro-crdt/bundler' },
  plugins: [workspaceSources, browserWasm()],
  loader: { '.wasm': 'file' },
  assetNames: 'assets/[name]-[hash]',
  publicPath: '/',
  minify: true,
  splitting: true,
  logOverride: { 'import-is-undefined': 'error' },
  entryPoints: ['apps/web/src/app/entry.ts'],
  entryNames: 'assets/[name]-[hash]',
  chunkNames: 'assets/[name]-[hash]',
  outdir: 'dist/public',
});
await cp('apps/web/public', 'dist/public', { recursive: true });
const notificationWorkerBuild = await build({
  plugins: [workspaceSources],
  entryPoints: ['apps/web/src/features/notifications/notification-worker.ts'],
  outfile: 'dist/public/notification-worker.js',
  platform: 'browser',
  format: 'iife',
  target: ['safari17', 'chrome120'],
  bundle: true,
  minify: true,
  metafile: true,
});
const scripts = Object.keys(browserBuild.metafile.outputs).filter((file) =>
  /\.(js|wasm)$/.test(file),
);
await recordEsbuildGraph('web', browserBuild.metafile);
await recordEsbuildGraph('web-worker', notificationWorkerBuild.metafile);
const entry = Object.entries(browserBuild.metafile.outputs)
  .find(([, output]) => output.entryPoint === 'apps/web/src/app/entry.ts')[0]
  .replace('dist/public', '');
// The UI is always needed. Discover its static imports so slow connections can
// fetch them directly from HTML without a module-discovery waterfall. Exclude
// the dynamically imported session runtime and its embedded WASM.
const preload = new Set();
function preloadImports(file) {
  if (preload.has(file)) return;
  preload.add(file);
  for (const dependency of browserBuild.metafile.outputs[file].imports)
    if (!dependency.external && dependency.kind === 'import-statement')
      preloadImports(dependency.path);
}
for (const [file, output] of Object.entries(browserBuild.metafile.outputs))
  if (['apps/web/src/app/entry.ts', 'apps/web/src/components/ui.tsx'].includes(output.entryPoint))
    preloadImports(file);
for (const file of ['index.html', 'startup.js'])
  await writeFile(
    'dist/public/' + file,
    (await readFile('dist/public/' + file, 'utf8'))
      .replaceAll('__ENTRY__', entry)
      .replace(
        '<!-- __PRELOADS__ -->',
        [...preload]
          .map((path) => `<link rel="modulepreload" href="${path.replace('dist/public', '')}" />`)
          .join('\n'),
      ),
  );
await writeFile(
  'dist/public/THIRD_PARTY_NOTICES.txt',
  await browserNotices({
    ...browserBuild.metafile.inputs,
    ...notificationWorkerBuild.metafile.inputs,
  }),
);
await buildWebStyles('dist/public/style.css');

const { createHash } = await import('node:crypto');
const assets = [
  ...scripts.map((file) => file.replace('dist/public/', '')),
  'notification-worker.js',
  'startup.js',
  'index.html',
  'style.css',
  'THIRD_PARTY_NOTICES.txt',
  'manifest.webmanifest',
  'moor-logo.png',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'favicon.ico',
];
const hash = createHash('sha256');
for (const file of assets) {
  const bytes = await readFile('dist/public/' + file);
  hash.update(file).update(bytes);
  if (/\.(js|css|html|wasm)$/.test(file))
    await writeFile('dist/public/' + file + '.gz', gzipSync(bytes, { level: 9 }));
}
await writeFile(
  'dist/public/sw.js',
  (await readFile('dist/public/sw.js', 'utf8'))
    .replace('__BUILD__', hash.digest('hex').slice(0, 12))
    .replace(
      /\[\s*\/\* __ASSETS__ \*\/\s*\]/,
      JSON.stringify(assets.map((file) => (file === 'index.html' ? '/' : '/' + file))),
    ),
);
