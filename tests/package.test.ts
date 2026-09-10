import test from 'node:test';
import strict from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { archiveRelay } from '../scripts/relay-package.mjs';

test('repackaging includes program files and preserves operator data without distributing it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moor-package-')),
    relay = join(directory, 'relay'),
    archive = join(directory, 'relay.tar.gz'),
    extracted = join(directory, 'extracted');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const program = {
    'server.mjs': 'console.log("synthetic program")',
    'package.json': '{"name":"synthetic-relay"}',
    'public/index.html': '<title>Synthetic app</title>',
    'public/icon-192.png': 'synthetic icon',
    'node_modules/ws/package.json': '{"name":"ws"}',
    'node_modules/ws/lib/websocket.js': '// synthetic runtime',
    'licenses/Moor-LICENSE': 'synthetic notice',
    'README.txt': 'synthetic instructions',
    Dockerfile: 'FROM scratch',
    '.dockerignore': '**',
  };
  const operatorFiles = [
    '.env',
    '.data/accounts.sqlite',
    'data/accounts.sqlite',
    'accounts.sqlite-wal',
    'setup-token',
    'host.log',
    'node_modules/unrelated/local-config',
  ];
  for (const [file, contents] of Object.entries(program)) {
    await mkdir(dirname(join(relay, file)), { recursive: true });
    await writeFile(join(relay, file), contents);
  }
  for (const file of operatorFiles) {
    await mkdir(dirname(join(relay, file)), { recursive: true });
    await writeFile(join(relay, file), 'synthetic operator data');
  }
  archiveRelay(relay, archive);
  await mkdir(extracted);
  const result = spawnSync('tar', ['-xzf', archive, '-C', extracted]);
  strict.equal(result.status, 0, result.stderr?.toString());
  for (const [file, contents] of Object.entries(program))
    strict.equal(await readFile(join(extracted, 'relay', file), 'utf8'), contents);
  for (const file of operatorFiles) {
    strict.equal(await readFile(join(relay, file), 'utf8'), 'synthetic operator data');
    await strict.rejects(readFile(join(extracted, 'relay', file)), { code: 'ENOENT' });
  }
});
