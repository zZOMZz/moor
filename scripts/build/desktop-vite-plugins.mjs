import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizePath } from 'vite';
import { browserNotices } from './browser-notices.mjs';
import { repository } from './workspace-sources.mjs';

const publicRoot = join(repository, 'apps/web/public');
export const desktopPublicFiles = Object.freeze([
  'manifest.webmanifest',
  'moor-logo.png',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'favicon.ico',
]);

export function desktopShellAssets({ appRoot, development }) {
  const assets = {
    'entry.cjs': 'apps/desktop/src/entry.cjs',
    'settings/settings.html': 'apps/desktop/src/settings/settings.html',
    'settings/settings.css': 'apps/desktop/src/settings/settings.css',
    'settings/settings.js': 'apps/desktop/src/settings/settings.js',
    'runtime/preview-renderer.cjs': 'apps/desktop/src/main/preview-renderer.cjs',
  };
  return {
    name: 'moor-desktop-shell-assets',
    buildStart() {
      for (const source of Object.values(assets)) this.addWatchFile(resolve(repository, source));
      if (development) this.addWatchFile(join(appRoot, 'client-revision.txt'));
    },
    async generateBundle() {
      for (const [fileName, source] of Object.entries(assets))
        this.emitFile({
          type: 'asset',
          fileName,
          source: await readFile(resolve(repository, source)),
        });
      const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
      this.emitFile({
        type: 'asset',
        fileName: 'package.json',
        source:
          JSON.stringify({
            name: 'moor-desktop',
            version: manifest.version,
            private: true,
            main: 'entry.cjs',
          }) + '\n',
      });
    },
  };
}

export function desktopRendererAssets({ token }) {
  return {
    name: 'moor-desktop-renderer-assets',
    enforce: 'pre',
    transform(code, id) {
      if (normalizePath(id.split('?')[0]) === normalizePath(join(publicRoot, 'startup.js')))
        return { code: code.replace("'__ENTRY__'", "'@moor-desktop-entry'"), map: null };
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (pathname === '/__moor_dev__/identity') {
          res.setHeader('Content-Type', 'text/plain');
          res.setHeader('Cache-Control', 'no-store');
          res.end(token);
          return;
        }
        const name = pathname.slice(1);
        if (!desktopPublicFiles.includes(name)) return next();
        try {
          res.setHeader(
            'Content-Type',
            name.endsWith('.png')
              ? 'image/png'
              : name.endsWith('.ico')
                ? 'image/x-icon'
                : 'application/manifest+json',
          );
          res.end(await readFile(join(publicRoot, name)));
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      for (const fileName of desktopPublicFiles)
        this.emitFile({
          type: 'asset',
          fileName,
          source: await readFile(join(publicRoot, fileName)),
        });
      const inputs = Object.fromEntries(
        [...this.getModuleIds()]
          .filter((id) => !id.startsWith('\0'))
          .map((id) => [id.split('?')[0], {}]),
      );
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.txt',
        source: await browserNotices(inputs),
      });
    },
  };
}

export function desktopBrowserWasm() {
  return {
    name: 'moor-desktop-browser-wasm',
    enforce: 'pre',
    async transform(code, id) {
      id = normalizePath(id.split('?')[0]);
      if (/\/loro-crdt\/bundler\/loro_wasm\.js$/.test(id))
        return {
          code: code
            .replace(
              'import * as rawWasm from "./loro_wasm_bg.wasm";',
              'import wasmUrl from "./loro_wasm_bg.wasm?url"; const rawWasm = { default: wasmUrl };',
            )
            .replace('import("./loro_wasm_bg.wasm")', 'import("./loro_wasm_bg.wasm?url")'),
          map: null,
        };
      if (/\/flock-wasm\/web\/wasm\.js$/.test(id))
        return {
          code:
            "import wasmUrl from './flock_wasm_bg.wasm?url';\n" +
            code.replace('await init();', 'await init({ module_or_path: wasmUrl });'),
          map: null,
        };
    },
  };
}
