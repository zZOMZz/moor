import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRuntime, removeRetiredRuntimeFiles } from '../../scripts/build/runtime-build.mjs';

test('retired runtime cleanup removes only known program outputs and leaves data intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-retired-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of [
    'security.mjs',
    'security.mjs.map',
    'desktop-client.mjs',
    'desktop-client.mjs.map',
    'preview-renderer.cjs',
  ])
    await writeFile(join(directory, file), 'synthetic retired program');
  await mkdir(join(directory, 'data'));
  await writeFile(join(directory, 'data', 'secure-history.sqlite'), 'synthetic retained data');
  await writeFile(join(directory, 'workspace-client.mjs'), 'synthetic active program');
  await removeRetiredRuntimeFiles(directory);
  assert.deepEqual((await readdir(directory)).sort(), ['data', 'workspace-client.mjs']);
  assert.equal(
    await readFile(join(directory, 'data', 'secure-history.sqlite'), 'utf8'),
    'synthetic retained data',
  );
});

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
