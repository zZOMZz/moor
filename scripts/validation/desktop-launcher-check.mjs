import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repository } from '../build/workspace-sources.mjs';

// Exercise the actual launcher with an empty private host, not a real Agent.
export async function checkDesktopLauncher(directory) {
  const profile = join(directory, 'launcher');
  await mkdir(profile, { mode: 0o700 });
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({ name: 'Synthetic desktop', agents: [], projects: [], server: '' }),
    { mode: 0o600 },
  );
  const appRoot = join(repository, '.runtime/desktop/app');
  const revisions = new Map();
  async function signal(group) {
    const file = join(appRoot, group + '-revision.txt');
    revisions.set(file, await readFile(file));
    await writeFile(file, randomBytes(32).toString('hex'));
  }
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/build/dev-desktop.mjs'], {
        cwd: repository,
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, MOOR_DESKTOP_DATA_DIR: profile },
      });
      let pending = '',
        stage = 'initial',
        documents = 0,
        hosts = 0,
        failure;
      function stop(error) {
        failure ??= error;
        child.kill('SIGTERM');
      }
      const timeout = setTimeout(
        () => stop(new Error('Desktop launcher validation timed out at ' + stage)),
        60000,
      );
      child.stdout.on('data', (chunk) => {
        process.stdout.write(chunk);
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          if (line.includes('[desktop] Renderer document ready')) documents++;
          if (line.includes('[desktop] Execution host ready')) hosts++;
        }
        try {
          if (stage === 'initial' && documents === 1 && hosts === 1) {
            stage = 'host-reload';
            void signal('host').catch(stop);
          } else if (stage === 'host-reload' && hosts === 2) {
            assert.equal(documents, 1, 'host rebuild must not reload the renderer');
            stage = 'main-restart';
            void signal('client').catch(stop);
          } else if (stage === 'main-restart' && documents >= 2 && hosts >= 3) {
            stage = 'closing';
            child.kill('SIGTERM');
          }
        } catch (error) {
          stop(error);
        }
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (failure) reject(failure);
        else if (code !== 0 || stage !== 'closing')
          reject(new Error(`Desktop launcher exited at ${stage}: ${code}`));
        else resolve();
      });
    });
    console.log('PASS: actual development launcher, host-only reload, main restart and shutdown.');
  } finally {
    for (const [file, value] of revisions) await writeFile(file, value);
  }
}
