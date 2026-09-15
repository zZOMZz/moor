// Real Electron + real Vite with synthetic IPC, then an empty isolated host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveConfig } from 'electron-vite';
import { createServer } from 'vite';
import { repository } from '../build/workspace-sources.mjs';
import { checkDesktopLauncher } from './desktop-launcher-check.mjs';

process.chdir(repository);
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'moor-vite-validation-'));
const probe = join(directory, 'RefreshProbe.tsx');
const css = join(directory, 'probe.css');
const mount = join(directory, 'MountProbe.tsx');
const token = randomBytes(32).toString('hex');
process.env.MOOR_DESKTOP_DEV_TOKEN = token;
process.env.MOOR_DESKTOP_DEV_PORT ??= '5197';
const source = (version) =>
  `import { useState } from 'react';\nimport './probe.css';\nexport default function RefreshProbe() { const [count, setCount] = useState(0); return <button id="refresh-probe" onClick={() => setCount(count + 1)}>${version}:{count}</button>; }\n`;
await writeFile(probe, source('before'));
await writeFile(css, '#refresh-probe { color: rgb(1, 2, 3); }');
await writeFile(
  mount,
  "import { createElement } from 'react'; import { createRoot } from 'react-dom/client'; import Probe from './RefreshProbe'; export function mount() { const target = document.createElement('div'); document.body.append(target); createRoot(target).render(createElement(Probe)); }\n",
);
let server;
try {
  const { config } = await resolveConfig(
    { configFile: 'electron.vite.config.mjs' },
    'serve',
    'development',
  );
  config.renderer.server.fs.allow.push(directory);
  await mkdir(join(directory, '.runtime'));
  await writeFile(join(directory, '.runtime/settings.json'), 'synthetic-private');
  server = await createServer(config.renderer);
  await server.listen();
  const url = `http://127.0.0.1:${process.env.MOOR_DESKTOP_DEV_PORT}/`;
  // Vite must not expose operator data even though it serves workspace sources.
  const forbidden = await fetch(url + '@fs' + join(directory, '.runtime/settings.json'));
  assert.equal(forbidden.status, 403);
  for (const mode of ['development', 'production']) {
    const profile = join(directory, mode);
    await mkdir(profile, { mode: 0o700 });
    const { ELECTRON_RUN_AS_NODE: _, ...environment } = process.env;
    await new Promise((resolve, reject) => {
      const child = spawn(
        require('electron'),
        [join(repository, 'tests/fixtures/vite-desktop.cjs')],
        {
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          env: {
            ...environment,
            MOOR_TEST_VITE_MODE: mode,
            MOOR_TEST_VITE_URL: url,
            MOOR_TEST_VITE_TOKEN: token,
            MOOR_TEST_VITE_PROFILE: profile,
            MOOR_TEST_VITE_MOUNT: mount,
          },
        },
      );
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(mode + ' Electron validation timed out'));
      }, 60000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('message', async (message) => {
        try {
          if (message === 'update-component') {
            await writeFile(probe, source('after'));
            server.watcher.emit('change', probe);
          } else if (message === 'update-css') {
            await writeFile(css, '#refresh-probe { color: rgb(4, 5, 6); }');
            server.watcher.emit('change', css);
          }
        } catch (error) {
          child.kill('SIGTERM');
          reject(error);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve() : reject(new Error(mode + ' Electron validation failed: ' + code));
      });
    });
  }
  await server.close();
  server = undefined;
  await checkDesktopLauncher(directory);
} finally {
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
