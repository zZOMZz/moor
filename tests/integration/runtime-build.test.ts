import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRuntime } from '../../scripts/build/runtime-build.mjs';

test('relay builds independently and emits only its runtime and complete dependency notices', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-relay-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await buildRuntime(['relay'], directory);
  assert.deepEqual((await readdir(directory)).sort(), [
    'relay-NOTICES.txt',
    'server.mjs',
    'server.mjs.map',
  ]);
  const notices = await readFile(join(directory, 'relay-NOTICES.txt'), 'utf8');
  assert.match(notices, /Moor relay dependency notices/);
  assert.match(notices, /zod@/);
  const syntax = spawnSync(process.execPath, ['--check', join(directory, 'server.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(syntax.status, 0, syntax.stderr);
});
