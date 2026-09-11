import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.slice(2);
if (check.some((arg) => arg !== '--check')) throw new Error('Usage: pnpm acceptance [--check]');
async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
  const forward = () => child.kill('SIGTERM');
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        code === 0
          ? resolve()
          : reject(new Error(signal ? `验收进程已停止：${signal}` : `验收进程退出：${code}`)),
      );
    });
  } finally {
    process.removeListener('SIGINT', forward);
    process.removeListener('SIGTERM', forward);
  }
}
await run(process.execPath, ['scripts/build.mjs']);
await build({
  entryPoints: ['src/acceptance/index.ts'],
  outfile: 'dist/acceptance/runtime.mjs',
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['ws', 'loro-crdt'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
  },
});
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
await run(require('electron'), ['src/acceptance/main.cjs', ...check], { env: environment });
