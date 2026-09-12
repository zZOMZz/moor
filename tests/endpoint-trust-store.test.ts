import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { base64url, exportJWK } from 'jose';
import { E2EE_CRYPTO_FAILED, generateDeviceEncryptionKey } from '../src/security/e2ee-crypto';
import {
  encryptionKeyId,
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
  type TrustManifest,
  type TrustPin,
} from '../src/security/e2ee-trust';
import {
  ENDPOINT_TRUST_STORE_MAX_BYTES,
  EndpointTrustStore,
} from '../src/security/endpoint-trust-store';
import { E2eeChannel } from '../src/security/e2ee-channel';

const root = await generateTrustRoot();
const otherRoot = await generateTrustRoot();
const client = await generateDeviceEncryptionKey();
const host = await generateDeviceEncryptionKey();
const pin: TrustPin = {
  accountId: 'synthetic-owner',
  serverOrigin: 'https://relay.example.test',
  rootKeyId: root.keyId,
};
const manifest: TrustManifest = {
  ...pin,
  version: 1,
  epoch: 1,
  previous: null,
  devices: [
    {
      deviceId: 'synthetic-client',
      keyId: await encryptionKeyId(client.publicKey),
      publicKey: client.publicKey,
      roles: ['client'],
    },
    {
      deviceId: 'synthetic-host',
      keyId: await encryptionKeyId(host.publicKey),
      publicKey: host.publicKey,
      roles: ['host'],
    },
  ],
};
const signedFirst = await signTrustManifest({
  manifest,
  rootPublicKey: root.publicKey,
  rootPrivateKey: root.privateKey,
});
const trustFirst = await VerifiedTrust.verify({
  signed: signedFirst,
  rootPublicKey: root.publicKey,
  pin,
});
const next: TrustManifest = {
  ...manifest,
  epoch: 2,
  previous: trustFirst.checkpoint.digest,
  devices: [manifest.devices[1]],
};
const signedNext = await signTrustManifest({
  manifest: next,
  rootPublicKey: root.publicKey,
  rootPrivateKey: root.privateKey,
});
const fork: TrustManifest = { ...next, devices: [manifest.devices[0]] };
const signedFork = await signTrustManifest({
  manifest: fork,
  rootPublicKey: root.publicKey,
  rootPrivateKey: root.privateKey,
});
const otherPin = { ...pin, rootKeyId: otherRoot.keyId };
const signedOther = await signTrustManifest({
  manifest: { ...manifest, ...otherPin },
  rootPublicKey: otherRoot.publicKey,
  rootPrivateKey: otherRoot.privateKey,
});
const initial = { signed: signedFirst, rootPublicKey: root.publicKey, pin };
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, E2EE_CRYPTO_FAILED);
  assert.equal(error.cause, undefined);
  assert.ok(!String(error.stack).includes('synthetic-secret'));
  return true;
};

function fixture(t: TestContext) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'moor-endpoint-trust-')));
  const directory = join(temporary, 'private');
  mkdirSync(directory, { mode: 0o700 });
  const file = join(directory, 'trust.sqlite');
  const stores: EndpointTrustStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(temporary, { recursive: true, force: true });
  });
  const open = async (path = file) => {
    const store = await EndpointTrustStore.open(path);
    stores.push(store);
    return store;
  };
  const initialized = async () => {
    const store = await open();
    await store.initialize(initial);
    return store;
  };
  return { temporary, directory, file, open, initialized };
}

test('opening creates private files and requires explicit genesis initialization', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  for (const name of [f.file, `${f.file}.lock`]) assert.equal(statSync(name).mode & 0o777, 0o600);
  assert.equal(store.current(), undefined);
  assert.equal(store.snapshot(), undefined);
  await assert.rejects(store.install(signedFirst), safeFailure);
  await assert.rejects(store.initialize({ ...initial, signed: signedNext }), safeFailure);
  assert.equal(store.current(), undefined);
  const trusted = await store.initialize(initial);
  assert.equal(store.current(), trusted);
  assert.deepEqual(trusted.manifest, manifest);
  await assert.rejects(store.initialize(initial), safeFailure);
});

test('reopening recovers the verified root pin and the latest revocation checkpoint', async (t) => {
  const f = fixture(t);
  const store = await f.initialized();
  const before = store.current()!;
  const installed = await store.install(signedNext);
  assert.notEqual(installed, before);
  assert.equal(store.current(), installed);
  assert.throws(() => installed.device('synthetic-client', 'client'), safeFailure);
  const snapshot = store.snapshot();
  store.close();
  const restored = await f.open();
  assert.deepEqual(restored.snapshot(), snapshot);
  assert.deepEqual(restored.current()!.checkpoint, installed.checkpoint);
  assert.throws(() => restored.current()!.device('synthetic-client', 'client'), safeFailure);
  assert.equal(restored.current()!.device('synthetic-host', 'host').publicKey, host.publicKey);
  await assert.rejects(restored.install(signedFirst), safeFailure);
  await assert.rejects(restored.install(signedFork), safeFailure);
  assert.deepEqual(restored.snapshot(), snapshot);
});

test('same-checkpoint install preserves current identity and refuses replacement roots', async (t) => {
  const f = fixture(t);
  const store = await f.initialized();
  const before = store.current();
  assert.equal(await store.install(signedFirst), before);
  await assert.rejects(store.install(signedOther), safeFailure);
  await assert.rejects(
    store.initialize({ signed: signedOther, rootPublicKey: otherRoot.publicKey, pin: otherPin }),
    safeFailure,
  );
  assert.equal(store.current(), before);
  store.close();
  assert.deepEqual((await f.open()).current()!.checkpoint, before!.checkpoint);
});

test('initialization snapshots its mutable pin and root inputs across awaits', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const input = structuredClone(initial);
  const pending = store.initialize(input);
  input.pin.accountId = 'substituted-owner';
  input.rootPublicKey.x = otherRoot.publicKey.x;
  input.signed = signedOther;
  assert.deepEqual((await pending).manifest, manifest);
});

test('two concurrent genesis authorizations can persist exactly one approved root', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const results = await Promise.allSettled([
    store.initialize(initial),
    store.initialize({ signed: signedOther, rootPublicKey: otherRoot.publicKey, pin: otherPin }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') safeFailure(result.reason);
  const winner = results.find((result) => result.status === 'fulfilled');
  assert.ok(winner?.status === 'fulfilled');
  assert.equal(store.current(), winner.value);
  store.close();
  assert.deepEqual((await f.open()).current()!.checkpoint, winner.value.checkpoint);
});

test('concurrent next-epoch forks use a compare-and-swap and persist one winner', async (t) => {
  const f = fixture(t);
  const store = await f.initialized();
  const results = await Promise.allSettled([store.install(signedNext), store.install(signedFork)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  for (const result of results) if (result.status === 'rejected') safeFailure(result.reason);
  const winner = results.find((result) => result.status === 'fulfilled');
  assert.ok(winner?.status === 'fulfilled');
  assert.equal(store.current(), winner.value);
  store.close();
  assert.deepEqual((await f.open()).current()!.checkpoint, winner.value.checkpoint);
});

test('persistent checkpoint compare-and-swap refuses a write when the SQLite row changes during verification', async (t) => {
  const f = fixture(t);
  const store = await f.initialized();
  const before = store.current();
  const pending = store.install(signedNext);
  const external = new DatabaseSync(f.file);
  const replacement = JSON.stringify({ ...trustFirst.checkpoint, digest: otherRoot.keyId });
  external.prepare('UPDATE endpoint_trust SET checkpoint=? WHERE id=1').run(replacement);
  await assert.rejects(pending, safeFailure);
  assert.equal(store.current(), before);
  assert.equal(
    external.prepare('SELECT checkpoint FROM endpoint_trust').get()!.checkpoint,
    replacement,
  );
  external.close();
});

test('durably installing a revocation invalidates real channels through the store current callback', async (t) => {
  const f = fixture(t);
  const store = await f.initialized();
  const binding = {
    trust: store.current()!,
    clientDeviceId: 'synthetic-client',
    hostDeviceId: 'synthetic-host',
    hostChallenge: base64url.encode(new Uint8Array(32).fill(1)),
    clientChallenge: base64url.encode(new Uint8Array(32).fill(2)),
    current: () => store.current(),
  };
  const clientChannel = await E2eeChannel.create({
    ...binding,
    side: 'client',
    privateKey: client.privateKey,
  });
  const hostChannel = await E2eeChannel.create({
    ...binding,
    side: 'host',
    privateKey: host.privateKey,
  });
  const request = {
    kind: 'request' as const,
    requestId: base64url.encode(new Uint8Array(32).fill(3)),
    resource: {
      kind: 'catalog' as const,
      workspaceId: null,
      projectId: null,
      sessionId: null,
      catalogWorkspaceId: null,
      replicaId: null,
    },
    plaintext: new TextEncoder().encode('synthetic private catalog request'),
  };
  const delivered = await clientChannel.send(request);
  assert.deepEqual((await hostChannel.receive(delivered)).plaintext, request.plaintext);
  const late = await clientChannel.send(request);
  await store.install(signedNext);
  assert.throws(() => clientChannel.assertCurrent(), safeFailure);
  assert.throws(() => hostChannel.assertCurrent(), safeFailure);
  await assert.rejects(clientChannel.send(request), safeFailure);
  await assert.rejects(hostChannel.receive(late), safeFailure);
  store.close();
  const reopened = await f.open();
  assert.equal(reopened.current()!.checkpoint.epoch, 2);
  await assert.rejects(
    E2eeChannel.create({
      ...binding,
      side: 'client',
      privateKey: client.privateKey,
      trust: reopened.current()!,
      current: () => reopened.current(),
    }),
    safeFailure,
  );
});

test('closing during initialization prevents a late database write', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const pending = store.initialize(initial);
  store.close();
  await assert.rejects(pending, safeFailure);
  assert.equal((await f.open()).current(), undefined);
  assert.throws(() => store.current(), safeFailure);
  assert.throws(() => store.snapshot(), safeFailure);
  store.close();
});

test('closing during install retains the last persisted checkpoint', async (t) => {
  const f = fixture(t);
  const store = await f.initialized();
  const pending = store.install(signedNext);
  store.close();
  await assert.rejects(pending, safeFailure);
  assert.deepEqual((await f.open()).current()!.checkpoint, trustFirst.checkpoint);
});

test('the runtime lock rejects duplicate open without releasing the first owner', async (t) => {
  const f = fixture(t);
  const first = await f.initialized();
  await assert.rejects(f.open(), safeFailure);
  assert.equal(first.current()!.checkpoint.epoch, 1);
  await first.install(signedNext);
  await assert.rejects(f.open(), safeFailure);
  first.close();
  assert.equal((await f.open()).current()!.checkpoint.epoch, 2);
});

test('a different process cannot take the live SQLite-backed endpoint lock', async (t) => {
  const f = fixture(t);
  await f.initialized();
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    let blocked = false;
    try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
    catch { blocked = true; }
    db.close();
    process.send({ blocked });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, `${f.file}.lock`], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const message = await new Promise<unknown>((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error('Synthetic lock child failed'));
    });
  });
  assert.deepEqual(message, { blocked: true });
});

test('snapshot and SQLite rows contain public signed state without private key material', async (t) => {
  const f = fixture(t);
  const store = await f.initialized();
  const snapshot = store.snapshot()!;
  assert.ok(Object.isFrozen(snapshot));
  assert.deepEqual(Object.keys(snapshot).sort(), ['checkpoint', 'pin', 'root', 'signed']);
  assert.deepEqual(JSON.parse(snapshot.pin), pin);
  assert.deepEqual(JSON.parse(snapshot.root), root.publicKey);
  const privateRoot = await exportJWK(root.privateKey);
  const privateClient = await crypto.subtle.exportKey('jwk', client.privateKey);
  store.close();
  const db = new DatabaseSync(f.file, { readOnly: true });
  let row;
  try {
    row = db.prepare('SELECT * FROM endpoint_trust').get();
  } finally {
    db.close();
  }
  for (const value of [
    JSON.stringify(snapshot),
    JSON.stringify(row),
    readFileSync(f.file).toString('utf8'),
  ]) {
    assert.ok(!value.includes(privateRoot.d!));
    assert.ok(!value.includes(privateClient.d!));
    assert.ok(!value.includes('privateKey'));
  }
  const payload = JSON.parse(
    Buffer.from(base64url.decode(snapshot.signed.split('.')[1])).toString('utf8'),
  );
  assert.deepEqual(payload, manifest);
});

test('relative paths, missing directories and nonprivate parent directories are rejected', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.open('relative.sqlite'), safeFailure);
  await assert.rejects(f.open(join(f.temporary, 'missing', 'trust.sqlite')), safeFailure);
  chmodSync(f.directory, 0o750);
  await assert.rejects(f.open(), safeFailure);
  assert.equal(existsSync(f.file), false);
  chmodSync(f.directory, 0o700);
  const alias = join(f.temporary, 'alias');
  symlinkSync(f.directory, alias);
  await assert.rejects(f.open(join(alias, 'trust.sqlite')), safeFailure);
});

for (const suffix of [
  '',
  '.lock',
  '-journal',
  '-wal',
  '-shm',
  '.lock-journal',
  '.lock-wal',
  '.lock-shm',
]) {
  test(`endpoint file ${suffix || '(main)'} rejects links, broad permissions and oversized sidecars`, async (t) => {
    for (const kind of ['symlink', 'hardlink', 'permissions', 'oversized', 'directory']) {
      await t.test(kind, async (t) => {
        const f = fixture(t);
        const path = f.file + suffix;
        const target = join(f.temporary, 'synthetic-secret-target');
        writeFileSync(target, 'synthetic-secret', { mode: 0o600 });
        const before = readFileSync(target);
        if (kind === 'symlink') symlinkSync(target, path);
        else if (kind === 'hardlink') linkSync(target, path);
        else if (kind === 'directory') mkdirSync(path, { mode: 0o700 });
        else {
          writeFileSync(path, '', { mode: 0o600 });
          if (kind === 'permissions') chmodSync(path, 0o640);
          else truncateSync(path, ENDPOINT_TRUST_STORE_MAX_BYTES + 1);
        }
        await assert.rejects(f.open(), safeFailure);
        assert.deepEqual(readFileSync(target), before);
      });
    }
  });
}

test('changing parent permissions invalidates reads and an install awaiting verification', async (t) => {
  const f = fixture(t);
  const store = await f.initialized();
  const pending = store.install(signedNext);
  chmodSync(f.directory, 0o755);
  assert.throws(() => store.current(), safeFailure);
  assert.throws(() => store.snapshot(), safeFailure);
  await assert.rejects(pending, safeFailure);
  chmodSync(f.directory, 0o700);
  store.close();
  assert.equal((await f.open()).current()!.checkpoint.epoch, 1);
});

test('replacing the endpoint directory invalidates existing authority before install commits', async (t) => {
  const f = fixture(t);
  const store = await f.initialized();
  const pending = store.install(signedNext);
  const moved = `${f.directory}-original`;
  renameSync(f.directory, moved);
  mkdirSync(f.directory, { mode: 0o700 });
  copyFileSync(join(moved, 'trust.sqlite'), f.file);
  chmodSync(f.file, 0o600);
  assert.throws(() => store.current(), safeFailure);
  assert.throws(() => store.snapshot(), safeFailure);
  await assert.rejects(pending, safeFailure);
  store.close();
  assert.equal((await f.open(join(moved, 'trust.sqlite'))).current()!.checkpoint.epoch, 1);
});

test('replacing the database or lock inode invalidates the existing store', async (t) => {
  for (const suffix of ['', '.lock'])
    await t.test(suffix || 'main', async (t) => {
      const f = fixture(t);
      const store = await f.initialized();
      const pending = store.install(signedNext);
      const path = f.file + suffix;
      renameSync(path, `${path}-original`);
      copyFileSync(`${path}-original`, path);
      chmodSync(path, 0o600);
      assert.throws(() => store.current(), safeFailure);
      assert.throws(() => store.snapshot(), safeFailure);
      await assert.rejects(pending, safeFailure);
    });
});

test('replacing the database during asynchronous reopen verification cannot return trusted state', async (t) => {
  const f = fixture(t);
  (await f.initialized()).close();
  const pending = f.open();
  renameSync(f.file, `${f.file}-original`);
  copyFileSync(`${f.file}-original`, f.file);
  chmodSync(f.file, 0o600);
  await assert.rejects(pending, safeFailure);
  assert.equal((await f.open()).current()!.checkpoint.epoch, 1);
});

test('a newly introduced unsafe sidecar is detected before reads and pending writes', async (t) => {
  const f = fixture(t);
  const store = await f.initialized();
  const pending = store.install(signedNext);
  const target = join(f.temporary, 'synthetic-secret-target');
  writeFileSync(target, 'synthetic-secret', { mode: 0o600 });
  symlinkSync(target, `${f.file}-journal`);
  assert.throws(() => store.current(), safeFailure);
  await assert.rejects(pending, safeFailure);
  assert.equal(readFileSync(target, 'utf8'), 'synthetic-secret');
});

test('corrupt files fail safely and do not remain locked after failed open', async (t) => {
  const f = fixture(t);
  writeFileSync(f.file, 'synthetic-secret-corrupt-database', { mode: 0o600 });
  const before = readFileSync(f.file);
  await assert.rejects(f.open(), safeFailure);
  assert.deepEqual(readFileSync(f.file), before);
  rmSync(f.file);
  const recovered = await f.open();
  assert.equal(recovered.current(), undefined);
});

test('foreign SQLite databases are rejected without creating Moor tables or rewriting operator data', async (t) => {
  const f = fixture(t);
  writeFileSync(f.file, '', { mode: 0o600 });
  const db = new DatabaseSync(f.file);
  db.exec(
    "PRAGMA application_id=12345; CREATE TABLE operator_data(body TEXT); INSERT INTO operator_data VALUES('synthetic-secret-operator-data')",
  );
  db.close();
  const before = readFileSync(f.file);
  await assert.rejects(f.open(), safeFailure);
  assert.deepEqual(readFileSync(f.file), before);
  const check = new DatabaseSync(f.file, { readOnly: true });
  try {
    assert.deepEqual(
      check
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
      ['operator_data'],
    );
  } finally {
    check.close();
  }
});

test('an unmarked SQLite database with existing tables cannot be adopted as an empty store', async (t) => {
  const f = fixture(t);
  writeFileSync(f.file, '', { mode: 0o600 });
  const db = new DatabaseSync(f.file);
  db.exec('CREATE TABLE unrelated(id INTEGER)');
  db.close();
  const before = readFileSync(f.file);
  await assert.rejects(f.open(), safeFailure);
  assert.deepEqual(readFileSync(f.file), before);
});

test('tampered rows, signatures and checkpoints cannot silently reset enrollment', async (t) => {
  const f = fixture(t);
  const store = await f.initialized();
  const snapshot = store.snapshot()!;
  store.close();
  const original = readFileSync(f.file);
  for (const [column, value] of [
    ['pin', JSON.stringify({ ...pin, accountId: 'another-owner' })],
    ['root', JSON.stringify(otherRoot.publicKey)],
    ['signed', 'synthetic-secret-invalid-signature'],
    ['checkpoint', JSON.stringify({ ...trustFirst.checkpoint, epoch: 2 })],
    ['checkpoint', JSON.stringify({ ...trustFirst.checkpoint, digest: otherRoot.keyId })],
    ['pin', '{"synthetic-secret":'],
  ]) {
    writeFileSync(f.file, original);
    const db = new DatabaseSync(f.file);
    db.prepare(`UPDATE endpoint_trust SET ${column}=? WHERE id=1`).run(value);
    db.close();
    await assert.rejects(f.open(), safeFailure);
  }
  writeFileSync(f.file, original);
  assert.deepEqual((await f.open()).snapshot(), snapshot);
});
