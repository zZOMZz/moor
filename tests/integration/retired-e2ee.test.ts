import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { CliState } from '../../apps/cli/src/state';
import { CliClient } from '../../apps/cli/src/client';
import { parseCliArgs } from '../../apps/cli/src/args';
import { exportRetiredOperation } from '../../apps/cli/src/retired';
import { isPrivateEndpointEnvelope } from '@moor/protocol/private-content';
import { Store } from '@moor/gateway/accounts';
import { createApp } from '@moor/gateway/http';

function directory(t: { after(work: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-retired-e2ee-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function retained(t: { after(work: () => void): void }) {
  const root = directory(t),
    file = join(root, 'moor-cli-v1.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE secure_outbox(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE secure_catalog_outbox(id TEXT PRIMARY KEY,value TEXT NOT NULL)',
  );
  const original =
    ' { "operationId": "original", "state":"pending", "body":"SYNTHETIC_PRIVATE_PROMPT", "target":{"owner":"original-owner","replicaId":"original-replica"} } ';
  const catalog = '{"operationId":"original","state":"ending","body":"SYNTHETIC_PRIVATE_CATALOG"}';
  db.prepare('INSERT INTO secure_outbox VALUES(?,?)').run('original', original);
  db.prepare('INSERT INTO secure_catalog_outbox VALUES(?,?)').run('original', catalog);
  db.close();
  chmodSync(file, 0o600);
  return { root, file, original, catalog };
}

test('retired CLI reads and exports original rows offline without rewriting a byte or changing unknown states', async (t) => {
  const f = retained(t),
    before = readFileSync(f.file);
  const state = new CliState(f.root, { readOnly: true });
  t.after(() => state.close());
  const client = new CliClient({
    state,
    stdin: (async function* () {})(),
    fetch: async () => {
      throw Error('Retired compatibility must never use the network');
    },
  });
  const summary: any = await client.run(parseCliArgs(['retired', 'list']));
  assert.deepEqual(
    summary.tables.map((table: any) => table.operations[0].storedState),
    ['pending', 'ending'],
  );
  assert(!JSON.stringify(summary).includes('SYNTHETIC_PRIVATE'));
  const output = join(f.root, 'original.json');
  const result = await client.run(
    parseCliArgs(['retired', 'export', 'original', '--output', output]),
  );
  assert.deepEqual(result, {
    offline: true,
    outputFile: output,
    operationId: 'original',
    records: 2,
  });
  const bytes = readFileSync(output);
  assert(isPrivateEndpointEnvelope(bytes));
  const archive = JSON.parse(bytes.toString()).value;
  assert.deepEqual(
    archive.records.map((record: any) => record.originalJson),
    [f.original, f.catalog],
  );
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(f.file), before);
  const read = new DatabaseSync(f.file, { readOnly: true });
  assert.equal(read.prepare("SELECT 1 FROM sqlite_master WHERE name='outbox'").get(), undefined);
  read.close();
});

test('ordinary CLI initialization leaves retained rows alone and never creates retired tables in a new state', (t) => {
  const f = retained(t);
  const upgraded = new CliState(f.root);
  assert.deepEqual(
    upgraded.retiredArchive('original').records.map((record) => record.originalJson),
    [f.original, f.catalog],
  );
  assert.equal(
    upgraded.operation('original'),
    undefined,
    'retired originals cannot become ordinary work',
  );
  upgraded.close();
  const fresh = join(f.root, 'fresh');
  const state = new CliState(fresh);
  assert.deepEqual(state.retiredSummaries().tables, []);
  state.close();
  const missing = join(f.root, 'missing');
  assert.throws(() => new CliState(missing, { readOnly: true }));
  assert.equal(existsSync(missing), false);
});

test('retired exports reject overwrite, redirected paths and broad directories while preserving original data', (t) => {
  const f = retained(t),
    state = new CliState(f.root, { readOnly: true });
  t.after(() => state.close());
  const output = join(f.root, 'existing.json');
  writeFileSync(output, 'keep this file', { mode: 0o600 });
  assert.throws(() => exportRetiredOperation(state, 'original', output, () => {}));
  assert.equal(readFileSync(output, 'utf8'), 'keep this file');
  const linked = join(f.root, 'linked.json');
  symlinkSync(output, linked);
  assert.throws(() => exportRetiredOperation(state, 'original', linked, () => {}));
  const broad = join(f.root, 'broad');
  mkdirSync(broad, { mode: 0o755 });
  assert.throws(() => exportRetiredOperation(state, 'original', join(broad, 'new.json'), () => {}));
  assert.equal(existsSync(join(broad, 'new.json')), false);
  assert.equal(state.retiredArchive('original').records[0]!.originalJson, f.original);
});

test('retired execution commands fail before creating CLI state or touching Host credentials and databases', (t) => {
  const root = directory(t),
    state = join(root, 'never-created');
  for (const args of [
    ['secure', 'send', '--endpoint', 'synthetic'],
    ['auth', 'export-trust', '--output', 'synthetic'],
  ]) {
    assert.throws(() => parseCliArgs(args), /已退场/);
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('apps/cli/src/main.ts'), ...args, '--state-dir', state],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /已退场/);
    assert.equal(existsSync(state), false);
  }
  const credential = join(root, 'device.json');
  writeFileSync(credential, 'SYNTHETIC_PRIVATE_UNREADABLE_DEVICE', { mode: 0o600 });
  const config = join(root, 'missing-config.json'),
    runtime = join(root, 'missing-runtime.sqlite');
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('apps/host/src/main.ts'),
      '--secure-endpoint',
      credential,
      '--secure-connection',
      credential,
      '--config',
      config,
      '--runtime-data',
      runtime,
      '--pair',
      'synthetic',
      '--server',
      'http://127.0.0.1:1',
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /加密主机已退场/);
  assert(!result.stderr.includes('SYNTHETIC_PRIVATE'));
  assert.equal(readFileSync(credential, 'utf8'), 'SYNTHETIC_PRIVATE_UNREADABLE_DEVICE');
  assert.equal(existsSync(credential + '.lock'), false);
  assert.equal(existsSync(config), false);
  assert.equal(existsSync(runtime), false);
});

test('retired Relay routes reject without credentials or body handling and preserve public trust tables', async (t) => {
  const store = new Store(':memory:');
  store.db.exec(
    "CREATE TABLE trust_publication_root(owner TEXT PRIMARY KEY,sentinel TEXT); CREATE TABLE trust_publication_entry(owner TEXT,epoch INTEGER,entry TEXT); INSERT INTO trust_publication_root VALUES('old-owner','retained-root'); INSERT INTO trust_publication_entry VALUES('old-owner',3,'retained-signed-entry')",
  );
  const app = createApp(store, { origin: 'http://127.0.0.1:0', setupToken: 'synthetic' });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    await app.close();
    store.close();
  });
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  app.setOrigin(origin);
  for (const route of ['publish', 'read']) {
    const response = await fetch(`${origin}/api/security/trust/${route}`, {
      method: 'POST',
      body: 'SYNTHETIC_PRIVATE_IGNORED',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(response.status, 410);
    assert(!JSON.stringify(await response.json()).includes('SYNTHETIC_PRIVATE'));
  }
  for (const side of ['host', 'client']) {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/bridge/v4/' + side);
    const rejected = new Promise<number>((resolve) => {
      socket.on('error', () => {});
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode!);
        response.resume();
        socket.terminate();
      });
    });
    assert.equal(await rejected, 410);
  }
  assert.equal(
    store.db.prepare('SELECT sentinel FROM trust_publication_root').get()!.sentinel,
    'retained-root',
  );
  assert.equal(
    store.db.prepare('SELECT entry FROM trust_publication_entry').get()!.entry,
    'retained-signed-entry',
  );
});
