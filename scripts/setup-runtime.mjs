import { readFileSync, existsSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(readFileSync(resolve(root, 'runtime.json'), 'utf8'));
const { values } = parseArgs({
  options: { source: { type: 'string' }, build: { type: 'boolean' } },
});
const target = resolve(root, pin.directory);
const run = (command, args, cwd = target) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env });
const git = (args, cwd = target) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
if (values.source) {
  const source = realpathSync(resolve(values.source));
  if (git(['rev-parse', 'HEAD'], source) !== pin.revision)
    throw new Error(
      'The supplied Lody checkout does not match runtime.json. Keep the pinned protocol/runtime version.',
    );
  if (existsSync(target) && realpathSync(target) !== source)
    throw new Error('A different runtime checkout already exists. It will not be replaced.');
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target, 'junction');
  }
} else if (!existsSync(target)) {
  mkdirSync(target, { recursive: true });
  run('git', ['init']);
  run('git', ['remote', 'add', 'origin', pin.repository]);
  run('git', ['fetch', '--depth', '1', 'origin', pin.revision]);
  run('git', ['checkout', '--detach', 'FETCH_HEAD']);
}
if (git(['rev-parse', 'HEAD']) !== pin.revision)
  throw new Error('Runtime revision mismatch. The existing checkout has not been changed.');
if (git(['status', '--porcelain', '--untracked-files=no']))
  throw new Error(
    'Runtime has local changes; preserve them in a separate checkout before packaging.',
  );
if (!values.source) {
  run('git', [
    'submodule',
    'update',
    '--init',
    '--depth',
    '1',
    ...['core', 'claude', 'codex', 'grok', 'dsh'].map((n) => 'packages/acp-extension-' + n),
  ]);
  run('corepack', ['pnpm', 'install', '--frozen-lockfile']);
  run('corepack', ['pnpm', '--dir', 'apps/cli', 'run', 'prepare:acp-adapters']);
}
if (values.build) {
  run('corepack', ['pnpm', '--dir', 'apps/cli', 'run', 'build']);
  run('corepack', ['pnpm', '--dir', 'apps/electron', 'run', 'sync:cli']);
  // Electron's download may have been disabled by the caller during dependency installation.
  if (
    process.platform === 'darwin' &&
    !existsSync(resolve(target, 'apps/electron/node_modules/electron/dist/Electron.app'))
  )
    run(process.execPath, ['node_modules/electron/install.js'], resolve(target, 'apps/electron'));
}
console.log(
  'Lody runtime ready at ' +
    target +
    ' (' +
    pin.revision.slice(0, 12) +
    '). Install Moor dependencies with corepack pnpm install --frozen-lockfile.',
);
