import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { normalizePath } from 'vite';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { repository, workspaceAliases } from './scripts/build/workspace-sources.mjs';
import {
  desktopShellAssets,
  desktopRendererAssets,
  desktopBrowserWasm,
} from './scripts/build/desktop-vite-plugins.mjs';

const webRequire = createRequire(join(repository, 'apps/web/package.json'));
const tailwind = webRequire('@tailwindcss/postcss');
const rootRequire = createRequire(import.meta.url);
const flock = join(dirname(rootRequire.resolve('@loro-dev/flock-wasm')), '../web/index.js');
const desktop = join(repository, 'apps/desktop');

export default defineConfig(({ command }) => {
  const development = command === 'serve';
  const appRoot = join(repository, development ? '.runtime/desktop/app' : 'dist/desktop');
  const token = process.env.MOOR_DESKTOP_DEV_TOKEN;
  if (development && !/^[a-f0-9]{64}$/.test(token ?? ''))
    throw new Error('Start desktop development with pnpm dev:desktop');
  const port = Number((development && process.env.MOOR_DESKTOP_DEV_PORT) || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid desktop development port');
  const origin = 'http://127.0.0.1:' + port;
  const nonce = development ? token : undefined;
  const csp =
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'nonce-" +
    nonce +
    "'; style-src 'self' 'nonce-" +
    nonce +
    "'; connect-src 'self' ws://127.0.0.1:" +
    port +
    "; worker-src 'self'; img-src 'self' data:; media-src data:; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  return {
    main: {
      envDir: false,
      envPrefix: '__MOOR_NO_CLIENT_ENV__',
      define: { __MOOR_DESKTOP_DEVELOPMENT__: JSON.stringify(development) },
      plugins: [desktopShellAssets({ appRoot, development })],
      build: {
        outDir: appRoot,
        emptyOutDir: !development,
        externalizeDeps: false,
        lib: { entry: { 'main/main': join(desktop, 'src/main/main.cjs') }, formats: ['cjs'] },
        commonjsOptions: { include: [/\.cjs$/, /node_modules/] },
        rollupOptions: {
          external: (id, importer) =>
            id === './runtime/preview-renderer.cjs' ||
            (id === './main/main.cjs' && importer?.endsWith('/entry.cjs')),
          output: { entryFileNames: '[name].cjs', chunkFileNames: 'main/chunks/[name]-[hash].cjs' },
        },
      },
    },
    preload: {
      envDir: false,
      envPrefix: '__MOOR_NO_CLIENT_ENV__',
      // Preserve the finite, directly testable CJS sources while compiling ESM
      // imports to standalone CJS. Shared Rollup helpers cannot be required by
      // Electron's sandboxed preload loader.
      plugins: [
        {
          name: 'moor-standalone-preload',
          enforce: 'pre',
          transform(code, id) {
            if (!normalizePath(id).startsWith(normalizePath(join(desktop, 'src/preload')) + '/'))
              return;
            return {
              code: code.replace(
                "const { contextBridge, ipcRenderer } = require('electron');",
                "import { contextBridge, ipcRenderer } from 'electron';",
              ),
              map: null,
            };
          },
        },
      ],
      build: {
        outDir: join(appRoot, 'preload'),
        emptyOutDir: true,
        externalizeDeps: false,
        lib: {
          entry: Object.fromEntries(
            ['preload', 'secure-preload', 'web-preload'].map((name) => [
              name,
              join(desktop, 'src/preload', name + '.cjs'),
            ]),
          ),
          formats: ['cjs'],
        },
        commonjsOptions: { exclude: [/src\/preload\//] },
        rollupOptions: { output: { entryFileNames: '[name].cjs' } },
      },
    },
    renderer: {
      root: join(repository, 'apps/web'),
      publicDir: false,
      base: '/',
      envDir: false,
      envPrefix: '__MOOR_NO_CLIENT_ENV__',
      resolve: {
        dedupe: ['react', 'react-dom'],
        alias: [
          ...workspaceAliases,
          {
            find: '@moor-desktop-entry',
            replacement: join(repository, 'apps/web/src/app/entry.ts'),
          },
          { find: '__ENTRY__', replacement: join(repository, 'apps/web/src/app/entry.ts') },
          { find: /^loro-crdt$/, replacement: 'loro-crdt/bundler' },
          { find: '@loro-dev/flock-wasm/base64', replacement: flock },
        ],
      },
      optimizeDeps: { exclude: ['loro-crdt', '@loro-dev/flock-wasm'] },
      css: { postcss: { plugins: [tailwind()] } },
      html: development ? { cspNonce: nonce } : {},
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true,
        cors: { origin },
        hmr: { host: '127.0.0.1', port, path: '/__moor_dev__/hmr' },
        headers: { 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' },
        fs: {
          strict: true,
          allow: [
            join(repository, 'apps/web'),
            join(repository, 'packages'),
            join(repository, 'node_modules'),
          ],
          deny: [
            '**/.env',
            '**/.env.*',
            '**/*.{pem,crt,key,sqlite,sqlite3,db}',
            '**/.git/**',
            '**/.runtime/**',
            '**/.data/**',
          ],
        },
      },
      plugins: [
        // electron-vite defaults production to file:// relative URLs. Moor's
        // /remote/ document serves program assets from the origin root.
        { name: 'moor-protocol-base', enforce: 'post', config: () => ({ base: '/' }) },
        desktopRendererAssets({ token }),
        desktopBrowserWasm(),
        react(),
      ],
      build: {
        outDir: join(appRoot, 'runtime/public'),
        emptyOutDir: true,
        minify: true,
        sourcemap: true,
        assetsInlineLimit: 0,
        rollupOptions: {
          input: {
            index: join(repository, 'apps/web/index.html'),
            'notification-worker': join(
              repository,
              'apps/web/src/features/notifications/notification-worker.ts',
            ),
          },
          output: {
            entryFileNames: (chunk) =>
              chunk.name === 'index'
                ? 'startup.js'
                : chunk.name === 'notification-worker'
                  ? 'notification-worker.js'
                  : 'assets/[name]-[hash].js',
            chunkFileNames: 'assets/[name]-[hash].js',
            assetFileNames: (asset) =>
              asset.names?.some((name) => name.endsWith('.css'))
                ? 'style.css'
                : 'assets/[name]-[hash][extname]',
          },
        },
      },
    },
  };
});
