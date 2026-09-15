import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { prepareDesktopDevApp } from './desktop-dev-app.mjs';
import { buildDesktopRuntime } from './desktop-runtime.mjs';
import { repository } from './workspace-sources.mjs';

const require = createRequire(import.meta.url);
const { appRoot, dataRoot } = await prepareDesktopDevApp({ repository });
const runtime = await buildDesktopRuntime({ appRoot, watch: true });
const { ELECTRON_RUN_AS_NODE: _, ELECTRON_RENDERER_URL: _url, ...environment } = process.env;
const child = spawn(
  process.execPath,
  [
    join(require.resolve('electron-vite/package.json'), '../bin/electron-vite.js'),
    'dev',
    '--watch',
    '--config',
    'electron.vite.config.mjs',
    '--entry',
    appRoot,
  ],
  {
    cwd: repository,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
    env: {
      ...environment,
      MOOR_DESKTOP_DEV_TOKEN: randomBytes(32).toString('hex'),
      MOOR_DESKTOP_DATA_DIR: environment.MOOR_DESKTOP_DATA_DIR ?? dataRoot,
    },
  },
);
let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  if (child.pid) {
    try {
      if (process.platform === 'win32')
        spawn('taskkill', ['/PID', String(child.pid), '/T'], { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(error.message);
    }
  }
  await runtime.dispose();
  process.exitCode = code;
}
child.once('error', (error) => {
  console.error(error.message);
  void shutdown(1);
});
child.once('exit', (code) => void shutdown(code ?? 1));
process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));
