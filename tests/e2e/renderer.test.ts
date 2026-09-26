import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
for (const scenario of ['browser-workspace', 'workspace-layout', 'performance-panel']) {
  test(`Chromium: ${scenario}`, { timeout: 60000 }, async (t) => {
    assert(
      process.platform !== 'linux' || process.env.DISPLAY,
      'Electron E2E requires a display; on Linux run xvfb-run --auto-servernum pnpm test:e2e',
    );
    const directory = await mkdtemp(join(tmpdir(), 'moor-e2e-'));
    const { ELECTRON_RUN_AS_NODE: _, ...environment } = process.env;
    const child = spawn(require('electron'), [resolve(`tests/e2e/${scenario}.cjs`)], {
      env: { ...environment, MOOR_E2E_DIRECTORY: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += chunk;
      });
    }
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed.catch(() => {});
      await rm(directory, { recursive: true, force: true });
    });
    const [code, signal] = await closed;
    assert.equal(code, 0, `${scenario} failed (${signal ?? code}):\n${output}`);
    t.diagnostic(output.trim());
  });
}
