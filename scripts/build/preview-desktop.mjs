import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { repository } from './workspace-sources.mjs';
import { prepareDesktopDevApp } from './desktop-dev-app.mjs';

const require = createRequire(import.meta.url);
const { dataRoot } = await prepareDesktopDevApp({ repository });
const { ELECTRON_RUN_AS_NODE: _, ...environment } = process.env;
const child = spawn(require('electron'), [join(repository, 'dist/desktop')], {
  stdio: 'inherit',
  env: { ...environment, MOOR_DESKTOP_DATA_DIR: environment.MOOR_DESKTOP_DATA_DIR ?? dataRoot },
});
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
