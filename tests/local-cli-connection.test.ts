import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  chmodSync,
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
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../src/protocol';
import {
  assertLocalCliConnectionPath,
  localCliConnectionSchema,
  publishLocalCliConnection,
  readLocalCliConnection,
  type LocalCliConnection,
  localCliChallenge,
  localCliProof,
  verifyLocalCliProof,
} from '../src/bridge/local-cli-connection';

const connection = (instanceId = 'instance-a'): LocalCliConnection => ({
  version: 1,
  instanceId,
  origin: 'http://127.0.0.1:43210',
  secret: 'synthetic-secret-abcdefghijklmnopqrstuvwxyz',
  ownerId: 'owner',
  deviceId: 'device',
  runtimeWorkspaceId: 'runtime',
  machineId: 'machine',
  userId: 'runtime-user',
});
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-cli-connection-'))),
    privateRoot = join(root, 'private'),
    project = join(root, 'project'),
    distribution = join(root, 'program');
  for (const path of [privateRoot, project, distribution]) mkdirSync(path, { mode: 0o700 });
  t.after(() => {
    chmodSync(privateRoot, 0o700);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    privateRoot,
    project,
    distribution,
    file: join(privateRoot, 'bridge.json.cli.json'),
    options: { projectRoots: () => [project], distributionRoots: [distribution] },
  };
}
const safe = (error: unknown) =>
  error instanceof AppError && !error.message.includes(connection().secret);

test('CLI connection is a private strict file lease and cannot remain current after replacement', (t) => {
  const f = fixture(t),
    publication = publishLocalCliConnection(f.file, connection(), f.options),
    lease = readLocalCliConnection(f.file);
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(lease.connection, connection());
  lease.assertCurrent();
  lease.connection.secret = 'only-mutates-this-copy';
  assert.deepEqual(readLocalCliConnection(f.file).connection, connection());
  const replacement = f.file + '.replacement';
  writeFileSync(replacement, readFileSync(f.file), { mode: 0o600 });
  renameSync(replacement, f.file);
  assert.throws(() => lease.assertCurrent(), safe);
  publication.remove();
  assert.equal(existsSync(f.file), true);
});

test('CLI descriptor accepts only a canonical fixed IPv4 loopback HTTP origin and known bounded identity fields', () => {
  for (const origin of [
    'https://127.0.0.1:43210',
    'http://localhost:43210',
    'http://[::1]:43210',
    'http://127.0.0.2:43210',
    'http://127.0.0.1:43210/',
    'http://127.0.0.1:43210/path',
    'http://127.0.0.1:43210#fragment',
    'http://user@127.0.0.1:43210',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
  ])
    assert.equal(
      localCliConnectionSchema.safeParse({ ...connection(), origin }).success,
      false,
      origin,
    );
  assert.equal(
    localCliConnectionSchema.safeParse({ ...connection(), token: 'other' }).success,
    false,
  );
  assert.equal(
    localCliConnectionSchema.safeParse({ ...connection(), secret: 'short' }).success,
    false,
  );
});

test('CLI reader rejects unsafe file modes, symlinks, hardlinks, writable parents and oversized or malformed records', (t) => {
  const f = fixture(t);
  publishLocalCliConnection(f.file, connection(), f.options);
  chmodSync(f.file, 0o644);
  assert.throws(() => readLocalCliConnection(f.file), safe);
  chmodSync(f.file, 0o600);
  const linked = join(f.privateRoot, 'hard.cli.json');
  linkSync(f.file, linked);
  assert.throws(() => readLocalCliConnection(f.file), safe);
  rmSync(linked);
  const symbolic = join(f.privateRoot, 'link.cli.json');
  symlinkSync(f.file, symbolic);
  assert.throws(() => readLocalCliConnection(symbolic), safe);
  const parentAlias = join(f.root, 'alias');
  symlinkSync(f.privateRoot, parentAlias);
  const aliasLease = readLocalCliConnection(join(parentAlias, 'bridge.json.cli.json'));
  aliasLease.assertCurrent();
  rmSync(parentAlias);
  symlinkSync(f.project, parentAlias);
  assert.throws(() => aliasLease.assertCurrent(), safe);
  chmodSync(f.privateRoot, 0o777);
  assert.throws(() => readLocalCliConnection(f.file), safe);
  chmodSync(f.privateRoot, 0o700);
  writeFileSync(f.file, 'x'.repeat(4097));
  assert.throws(() => readLocalCliConnection(f.file), safe);
  writeFileSync(f.file, JSON.stringify({ ...connection(), command: '/not-allowed' }));
  assert.throws(() => readLocalCliConnection(f.file), safe);
});

test('publisher refuses projects, program directories and aliases before publishing credentials', (t) => {
  const f = fixture(t);
  for (const path of [
    join(f.project, 'private/bridge.cli.json'),
    join(f.distribution, 'bridge.cli.json'),
  ]) {
    assert.throws(() => publishLocalCliConnection(path, connection(), f.options), safe);
    assert.equal(existsSync(path), false);
  }
  const alias = join(f.root, 'project-alias');
  symlinkSync(f.project, alias);
  assert.throws(
    () => publishLocalCliConnection(join(alias, 'bridge.cli.json'), connection(), f.options),
    safe,
  );
  const file = join(f.root, 'fresh/deep/bridge.cli.json');
  assert.equal(assertLocalCliConnectionPath(file, f.options), file);
  assert.equal(statSync(join(f.root, 'fresh/deep')).mode & 0o777, 0o700);
});

test('old publisher cleanup cannot delete a later instance and current publisher removes only its own descriptor', (t) => {
  const f = fixture(t),
    old = publishLocalCliConnection(f.file, connection(), f.options),
    next = publishLocalCliConnection(f.file, connection('instance-b'), f.options);
  assert.throws(() => old.assertCurrent(), safe);
  old.remove();
  assert.equal(readLocalCliConnection(f.file).connection.instanceId, 'instance-b');
  next.remove();
  assert.equal(existsSync(f.file), false);
  next.remove();
});

test('CLI connection refuses foreign-owned ancestors even when mode or sticky permissions look safe', (t) => {
  const f = fixture(t);
  publishLocalCliConnection(f.file, connection(), f.options);
  const lease = readLocalCliConnection(f.file),
    original = fs.lstatSync;
  // Inject only the OS ownership result; actual private files and every public
  // reader/publisher check remain in use without requiring privileged chown.
  const mocked = t.mock.method(fs, 'lstatSync', (...args: unknown[]) => {
    const stat = Reflect.apply(original, fs, args);
    if (args[0] === f.root) stat.uid = typeof stat.uid === 'bigint' ? 2147483646n : 2147483646;
    return stat;
  });
  syncBuiltinESMExports();
  try {
    for (const mode of [0o755, 0o1777]) {
      chmodSync(f.root, mode);
      assert.throws(() => readLocalCliConnection(f.file), safe);
      assert.throws(() => lease.assertCurrent(), safe);
      assert.throws(
        () => publishLocalCliConnection(f.file, connection('replacement'), f.options),
        safe,
      );
    }
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    chmodSync(f.root, 0o700);
  }
});

test('CLI listener proof binds a fresh challenge and instance to the private secret without accepting replay or extra response fields', () => {
  const value = connection(),
    challenge = localCliChallenge();
  const response = {
    instanceId: value.instanceId,
    challenge,
    proof: localCliProof(value.instanceId, challenge, value.secret),
  };
  assert.doesNotThrow(() => verifyLocalCliProof(value, challenge, response));
  for (const wrong of [
    { ...response, instanceId: 'other' },
    { ...response, challenge: localCliChallenge() },
    {
      ...response,
      proof: localCliProof(
        value.instanceId,
        challenge,
        'other-synthetic-secret-abcdefghijklmnopqrstuvwxyz',
      ),
    },
    { ...response, secret: value.secret },
    { ...response, proof: '0'.repeat(64) },
  ])
    assert.throws(() => verifyLocalCliProof(value, challenge, wrong), safe);
  assert.throws(() => verifyLocalCliProof(value, localCliChallenge(), response), safe);
  assert.throws(() => localCliProof(value.instanceId, 'not-a-challenge', value.secret), safe);
});
