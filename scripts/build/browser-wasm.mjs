import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Use the package's browser initializer with an emitted URL. Node builds keep
// their existing entry; no vendor files or dependency versions are changed.
export function browserWasm() {
  const flockWeb = join(
    dirname(fileURLToPath(import.meta.resolve('@loro-dev/flock-wasm'))),
    '../web',
  );
  return {
    name: 'moor-browser-wasm',
    setup(build) {
      build.onResolve({ filter: /^@loro-dev\/flock-wasm\/base64$/ }, () => ({
        path: join(flockWeb, 'index.js'),
      }));
      build.onLoad({ filter: /\/flock-wasm\/web\/wasm\.js$/ }, async ({ path }) => ({
        contents:
          `import wasmUrl from './flock_wasm_bg.wasm';\n` +
          (await readFile(path, 'utf8')).replace(
            'await init();',
            'await init({ module_or_path: wasmUrl });',
          ),
        loader: 'js',
        resolveDir: dirname(path),
      }));
    },
  };
}
