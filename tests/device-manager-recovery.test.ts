import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64url } from 'jose';
import { DeviceManager, type DevicePublicTrust } from '../src/security/device-manager';
import {
  devicePublicKey,
  E2EE_CRYPTO_FAILED,
  open as openMessage,
  seal,
} from '../src/security/e2ee-crypto';
import {
  decryptRecovery,
  generateRecoveryKey,
  importRootPrivateJwk,
} from '../src/security/e2ee-recovery';
import {
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
  type TrustedDevice,
  type TrustManifest,
} from '../src/security/e2ee-trust';

const now = 1_800_000_000_000;
const copy = <T>(value: T): T => structuredClone(value);
const digest = (value: number) => Buffer.alloc(32, value).toString('base64url');
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, E2EE_CRYPTO_FAILED);
  assert.equal(error.cause, undefined);
  assert.equal(String(error.stack).includes('synthetic-secret'), false);
  return true;
};
const identity = {
  accountId: 'synthetic-owner',
  serverOrigin: 'https://relay.example.test',
  deviceId: 'synthetic-surviving-mac',
  roles: ['host', 'client'] as TrustedDevice['roles'],
};
function state(manager: DeviceManager) {
  const status = manager.status();
  assert.ok('trust' in status && status.trust && status.revision !== null);
  return { ...status, trust: status.trust, revision: status.revision };
}
function pending(manager: DeviceManager) {
  const status = manager.status();
  assert.ok('pending' in status && status.pending && status.revision !== null);
  return { ...status, pending: status.pending, revision: status.revision };
}
function fixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'moor-device-recovery-')));
  fs.chmodSync(directory, 0o700);
  const managers: DeviceManager[] = [];
  const path = (name: string) => join(directory, `${name}.json`);
  const open = async (name: string) => {
    const manager = await DeviceManager.open(path(name), { now: () => now });
    managers.push(manager);
    return manager;
  };
  t.after(() => {
    managers.forEach((manager) => manager.close());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, path, open };
}
async function established(t: TestContext) {
  const f = fixture(t);
  const owner = await f.open('owner');
  const recoveryKey = generateRecoveryKey();
  await owner.initialize(copy(identity), recoveryKey);
  const original = state(owner);
  const capsule = await owner.recoveryCapsule(recoveryKey);
  const lost = await f.open('lost');
  const pairing = await lost.beginPairing({
    pin: original.pin,
    deviceId: 'synthetic-lost-mac',
    roles: ['client'],
  });
  const receipt = await owner.approvePairing({
    expectedRevision: state(owner).revision,
    request: pending(lost).pending.request,
    expectedFingerprint: pairing.fingerprint,
    expectedDeviceKeyId: null,
    recoveryKey,
  });
  await lost.acceptPairing({
    expectedRevision: pending(lost).revision,
    approval: receipt.approval,
    rootPublicKey: receipt.trust.rootPublicKey,
    signedManifest: receipt.trust.signedManifest,
  });
  const baseTrust = state(owner).trust;
  const latestCapsule = await owner.recoveryCapsule(recoveryKey);
  const options = () => ({
    capsule,
    recoveryKey,
    expectedPin: copy(original.pin),
    baseTrust: copy(baseTrust),
    deviceId: 'synthetic-recovered-mac',
    roles: ['host', 'client'] as TrustedDevice['roles'],
    revokeDevices: [{ deviceId: state(lost).device.deviceId, keyId: state(lost).device.keyId }],
  });
  return { ...f, owner, lost, recoveryKey, original, capsule, latestCapsule, baseTrust, options };
}
function assertEmpty(manager: DeviceManager, path: string) {
  assert.deepEqual(manager.status(), { revision: null, phase: 'empty' });
  assert.equal(manager.current(), undefined);
  assert.equal(fs.existsSync(path), false);
}
async function independentlySignedBase(
  f: Awaited<ReturnType<typeof established>>,
  manifest: TrustManifest,
): Promise<DevicePublicTrust> {
  const root = await decryptRecovery({ capsule: f.capsule, recoveryKey: f.recoveryKey });
  const signedManifest = await signTrustManifest({
    manifest,
    rootPublicKey: root.rootPublicKey,
    rootPrivateKey: await importRootPrivateJwk(root.rootPrivateKey),
  });
  const trusted = await VerifiedTrust.verify({
    signed: signedManifest,
    rootPublicKey: root.rootPublicKey,
    pin: root.pin,
    previous: manifest.epoch === 1 ? undefined : f.original.trust.checkpoint,
  });
  return {
    pin: copy(root.pin),
    rootPublicKey: copy(root.rootPublicKey),
    checkpoint: copy(trusted.checkpoint),
    signedManifest,
  };
}

test('recovery advances an explicitly selected newer base, generates a fresh device key and persists only private endpoint state', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  const originalBytes = fs.readFileSync(f.path('owner'));
  const oldLostKey = await f.lost.encryptionKey();
  await recovered.recover(f.options());
  const restored = state(recovered);
  assert.equal(restored.phase, 'active');
  assert.equal(restored.revision, 1);
  assert.equal(restored.device.deviceId, 'synthetic-recovered-mac');
  assert.deepEqual(restored.device.roles, ['host', 'client']);
  assert.notEqual(restored.device.keyId, state(f.lost).device.keyId);
  assert.notEqual(restored.device.keyId, f.original.device.keyId);
  assert.notEqual(restored.device.publicKey, state(f.lost).device.publicKey);
  assert.equal(await devicePublicKey(await recovered.encryptionKey()), restored.device.publicKey);
  assert.deepEqual(restored.pin, f.original.pin);
  assert.deepEqual(restored.trust.rootPublicKey, f.baseTrust.rootPublicKey);
  assert.equal(restored.trust.checkpoint.epoch, f.baseTrust.checkpoint.epoch + 1);
  assert.equal(recovered.current()!.manifest.previous, f.baseTrust.checkpoint.digest);
  assert.deepEqual(fs.readFileSync(f.path('owner')), originalBytes);
  assert.deepEqual(
    recovered.current()!.manifest.devices.map((device) => device.deviceId),
    [f.original.device.deviceId, restored.device.deviceId],
  );
  const aad = new TextEncoder().encode('synthetic recovery scope'),
    plaintext = new TextEncoder().encode('synthetic recovered endpoint message');
  const message = await seal({
    senderPrivateKey: await f.owner.encryptionKey(),
    recipientPublicKey: restored.device.publicKey,
    plaintext,
    aad,
  });
  assert.deepEqual(
    await openMessage({
      ...message,
      senderPublicKey: f.original.device.publicKey,
      recipientPrivateKey: await recovered.encryptionKey(),
      aad,
    }),
    plaintext,
  );
  await assert.rejects(
    openMessage({
      ...message,
      senderPublicKey: f.original.device.publicKey,
      recipientPrivateKey: oldLostKey,
      aad,
    }),
    safeFailure,
  );
  const exported = await recovered.recoveryCapsule(f.recoveryKey);
  const root = await decryptRecovery({ capsule: exported, recoveryKey: f.recoveryKey });
  assert.deepEqual(root.checkpoint, restored.trust.checkpoint);
  assert.equal(root.signedManifest, restored.trust.signedManifest);
  const onDisk = fs.readFileSync(f.path('recovered'), 'utf8');
  assert.equal(fs.statSync(f.path('recovered')).mode & 0o777, 0o600);
  assert.equal(onDisk.includes(f.recoveryKey), false);
  assert.equal(onDisk.includes(root.rootPrivateKey.d), false);
  for (const privateField of ['privateKey', 'rootPrivateKey', 'recoveryKey', 'recoveryCapsule'])
    assert.equal(JSON.stringify(restored).includes(`"${privateField}"`), false);
  recovered.close();
  const reopened = await f.open('recovered');
  assert.deepEqual(state(reopened), restored);
  assert.equal(await devicePublicKey(await reopened.encryptionKey()), restored.device.publicKey);
});

test('surviving and lost managers accept the recovered next manifest and only the explicitly revoked device loses use', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  await recovered.recover(f.options());
  const restored = state(recovered);
  await f.owner.installTrust({
    expectedRevision: state(f.owner).revision,
    signedManifest: restored.trust.signedManifest,
  });
  await f.lost.installTrust({
    expectedRevision: state(f.lost).revision,
    signedManifest: restored.trust.signedManifest,
  });
  assert.deepEqual(f.owner.current()!.checkpoint, restored.trust.checkpoint);
  assert.equal(state(f.owner).phase, 'active');
  assert.equal(state(f.lost).phase, 'revoked');
  assert.equal(f.lost.current(), undefined);
  await assert.rejects(f.lost.encryptionKey(), safeFailure);
  assert.equal(await devicePublicKey(await f.owner.encryptionKey()), f.original.device.publicKey);
});

test('recovery without an explicit revocation preserves all supplied base devices', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  await recovered.recover({ ...f.options(), revokeDevices: [] });
  assert.deepEqual(
    recovered.current()!.manifest.devices.map((device) => device.deviceId),
    [f.original.device.deviceId, state(f.lost).device.deviceId, state(recovered).device.deviceId],
  );
  await f.lost.installTrust({
    expectedRevision: state(f.lost).revision,
    signedManifest: state(recovered).trust.signedManifest,
  });
  assert.equal(state(f.lost).phase, 'active');
});

test('a recovered manager participates in original-root key rotation and then approves an ordinary new pairing', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  await recovered.recover(f.options());
  const beforeRotation = state(recovered);
  await f.owner.installTrust({
    expectedRevision: state(f.owner).revision,
    signedManifest: beforeRotation.trust.signedManifest,
  });
  const rotation = await recovered.requestKeyRotation(beforeRotation.revision);
  assert.equal(state(recovered).device.keyId, beforeRotation.device.keyId);
  const rotated = await f.owner.approvePairing({
    expectedRevision: state(f.owner).revision,
    request: pending(recovered).pending.request,
    expectedFingerprint: rotation.fingerprint,
    expectedDeviceKeyId: beforeRotation.device.keyId,
    recoveryKey: f.recoveryKey,
  });
  await recovered.acceptPairing({
    expectedRevision: pending(recovered).revision,
    approval: rotated.approval,
    rootPublicKey: rotated.trust.rootPublicKey,
    signedManifest: rotated.trust.signedManifest,
  });
  assert.notEqual(state(recovered).device.keyId, beforeRotation.device.keyId);
  assert.deepEqual(recovered.current()!.checkpoint, f.owner.current()!.checkpoint);
  assert.equal(state(recovered).trust.checkpoint.epoch, f.baseTrust.checkpoint.epoch + 2);
  const next = await f.open('next-client');
  const pairing = await next.beginPairing({
    pin: f.original.pin,
    deviceId: 'synthetic-next-client',
    roles: ['client'],
  });
  const receipt = await recovered.approvePairing({
    expectedRevision: state(recovered).revision,
    request: pending(next).pending.request,
    expectedFingerprint: pairing.fingerprint,
    expectedDeviceKeyId: null,
    recoveryKey: f.recoveryKey,
  });
  await next.acceptPairing({
    expectedRevision: pending(next).revision,
    approval: receipt.approval,
    rootPublicKey: receipt.trust.rootPublicKey,
    signedManifest: receipt.trust.signedManifest,
  });
  await f.owner.installTrust({
    expectedRevision: state(f.owner).revision,
    signedManifest: receipt.trust.signedManifest,
  });
  assert.deepEqual(next.current()!.checkpoint, f.owner.current()!.checkpoint);
  assert.deepEqual(next.current()!.checkpoint, recovered.current()!.checkpoint);
  assert.equal(
    next
      .current()!
      .manifest.devices.some((device) => device.deviceId === state(f.lost).device.deviceId),
    false,
  );
});

test('wrong recovery code, malformed capsule or a different expected pin leaves an empty vault untouched', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  const invalid = [
    { ...f.options(), recoveryKey: generateRecoveryKey() },
    { ...f.options(), recoveryKey: 'synthetic-secret' },
    { ...f.options(), capsule: 'synthetic-secret' },
    { ...f.options(), capsule: f.capsule.slice(0, -1) },
    { ...f.options(), expectedPin: { ...f.original.pin, accountId: 'wrong-owner' } },
    {
      ...f.options(),
      expectedPin: { ...f.original.pin, serverOrigin: 'https://wrong.example.test' },
    },
    { ...f.options(), expectedPin: { ...f.original.pin, rootKeyId: digest(4) } },
  ];
  for (const input of invalid) {
    await assert.rejects(recovered.recover(input), safeFailure);
    assertEmpty(recovered, f.path('recovered'));
  }
  await recovered.recover(f.options());
  assert.equal(state(recovered).phase, 'active');
});

test('base pin, supplied root, signature and checkpoint are all checked before writing new private state', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  const otherRoot = await generateTrustRoot();
  const parts = f.baseTrust.signedManifest.split('.');
  const bytes = base64url.decode(parts[2]);
  bytes[0] ^= 1;
  parts[2] = base64url.encode(bytes);
  const invalid: DevicePublicTrust[] = [
    { ...copy(f.baseTrust), pin: { ...f.original.pin, accountId: 'other-owner' } },
    {
      ...copy(f.baseTrust),
      pin: { ...f.original.pin, serverOrigin: 'https://other.example.test' },
    },
    { ...copy(f.baseTrust), rootPublicKey: otherRoot.publicKey },
    { ...copy(f.baseTrust), signedManifest: parts.join('.') },
    { ...copy(f.baseTrust), signedManifest: 'synthetic-secret' },
    { ...copy(f.baseTrust), checkpoint: { ...f.baseTrust.checkpoint, digest: digest(42) } },
    { ...copy(f.baseTrust), checkpoint: { ...f.baseTrust.checkpoint, epoch: 3 } },
    { ...copy(f.baseTrust), checkpoint: { ...f.baseTrust.checkpoint, accountId: 'other-owner' } },
    // A valid next manifest cannot stand in for the base's claimed previous checkpoint.
    { ...copy(f.baseTrust), checkpoint: copy(f.original.trust.checkpoint) },
  ];
  for (const baseTrust of invalid) {
    await assert.rejects(recovered.recover({ ...f.options(), baseTrust }), safeFailure);
    assertEmpty(recovered, f.path('recovered'));
  }
});

test('the selected base cannot roll back below the recovery backup or fork its same epoch', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  await assert.rejects(
    recovered.recover({
      ...f.options(),
      capsule: f.latestCapsule,
      baseTrust: f.original.trust,
      revokeDevices: [],
    }),
    safeFailure,
  );
  assertEmpty(recovered, f.path('recovered'));
  const fork = await independentlySignedBase(f, {
    ...copy(f.owner.current()!.manifest),
    devices: [copy(f.original.device)],
  });
  await assert.rejects(
    recovered.recover({
      ...f.options(),
      capsule: f.latestCapsule,
      baseTrust: fork,
      revokeDevices: [],
    }),
    safeFailure,
  );
  assertEmpty(recovered, f.path('recovered'));
  await recovered.recover({ ...f.options(), capsule: f.latestCapsule });
  assert.equal(state(recovered).trust.checkpoint.epoch, f.baseTrust.checkpoint.epoch + 1);
});

test('new device identity, requested roles and every revocation entry must be exact and explicit', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  const revoke = f.options().revokeDevices[0];
  const invalid: unknown[] = [
    { ...f.options(), deviceId: f.original.device.deviceId },
    { ...f.options(), deviceId: state(f.lost).device.deviceId },
    { ...f.options(), deviceId: 'unsafe/device' },
    { ...f.options(), roles: [] },
    { ...f.options(), roles: ['host', 'host'] },
    { ...f.options(), roles: ['admin'] },
    { ...f.options(), revokeDevices: undefined },
    { ...f.options(), revokeDevices: [revoke, copy(revoke)] },
    { ...f.options(), revokeDevices: [{ ...revoke, keyId: digest(9) }] },
    { ...f.options(), revokeDevices: [{ ...revoke, deviceId: 'absent-device' }] },
    { ...f.options(), revokeDevices: [{ ...revoke, deviceId: 'synthetic-recovered-mac' }] },
    { ...f.options(), revokeDevices: [{ ...revoke, secret: 'synthetic-secret' }] },
    { ...f.options(), revokeDevices: Array.from({ length: 65 }, () => copy(revoke)) },
  ];
  for (const input of invalid) {
    await assert.rejects(
      recovered.recover(input as Parameters<DeviceManager['recover']>[0]),
      safeFailure,
    );
    assertEmpty(recovered, f.path('recovered'));
  }
});

test('an old device ID known from the backup cannot be reused after it was revoked from the selected base', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  await f.owner.revokeDevice({
    expectedRevision: state(f.owner).revision,
    deviceId: f.original.device.deviceId,
    expectedKeyId: f.original.device.keyId,
    recoveryKey: f.recoveryKey,
  });
  const baseTrust = state(f.owner).trust;
  assert.equal(state(f.owner).phase, 'revoked');
  await assert.rejects(
    recovered.recover({
      ...f.options(),
      baseTrust,
      deviceId: f.original.device.deviceId,
      revokeDevices: [],
    }),
    safeFailure,
  );
  assertEmpty(recovered, f.path('recovered'));
});

test('an initialized, paired or still-pending vault cannot be overwritten by recovery', async (t) => {
  const f = await established(t),
    pendingManager = await f.open('pending');
  await pendingManager.beginPairing({
    pin: f.original.pin,
    deviceId: 'synthetic-pending-mac',
    roles: ['client'],
  });
  for (const [manager, name] of [
    [f.owner, 'owner'],
    [f.lost, 'lost'],
    [pendingManager, 'pending'],
  ] as const) {
    const before = fs.readFileSync(f.path(name));
    const status = manager.status();
    await assert.rejects(manager.recover(f.options()), safeFailure);
    assert.deepEqual(manager.status(), status);
    assert.deepEqual(fs.readFileSync(f.path(name)), before);
  }
});

test('closing during recovery discards the awaited result and a fresh open still sees an empty vault', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  const operation = recovered.recover(f.options());
  recovered.close();
  await assert.rejects(operation, safeFailure);
  assert.equal(fs.existsSync(f.path('recovered')), false);
  const reopened = await f.open('recovered');
  assertEmpty(reopened, f.path('recovered'));
  await reopened.recover(f.options());
  assert.equal(state(reopened).phase, 'active');
});

test('concurrent recoveries have exactly one durable winner and never silently replace the winning device', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  const results = await Promise.allSettled([
    recovered.recover(f.options()),
    recovered.recover({ ...f.options(), deviceId: 'synthetic-concurrent-mac' }),
  ]);
  const successes = results.filter((result) => result.status === 'fulfilled');
  const failures = results.filter((result) => result.status === 'rejected');
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  safeFailure(failures[0].reason);
  const saved = state(recovered);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved, successes[0].value);
  recovered.close();
  const reopened = await f.open('recovered');
  assert.deepEqual(state(reopened), saved);
  const before = fs.readFileSync(f.path('recovered'));
  await assert.rejects(reopened.recover(f.options()), safeFailure);
  assert.deepEqual(fs.readFileSync(f.path('recovered')), before);
});

test('a competing fresh initialization and recovery cannot both commit into one empty vault', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  const results = await Promise.allSettled([
    recovered.recover(f.options()),
    recovered.initialize(
      { ...copy(identity), deviceId: 'synthetic-independent-mac' },
      generateRecoveryKey(),
    ),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') safeFailure(result.reason);
  assert.equal(state(recovered).revision, 1);
  assert.equal(
    recovered
      .current()!
      .manifest.devices.filter((device) => device.deviceId === state(recovered).device.deviceId)
      .length,
    1,
  );
});

test('recovery snapshots the capsule, pin, base checkpoint, new identity and revocation choice before awaiting', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  const input = f.options();
  const operation = recovered.recover(input);
  input.capsule = 'synthetic-secret';
  input.recoveryKey = generateRecoveryKey();
  input.expectedPin.accountId = 'changed-owner';
  input.baseTrust.pin.accountId = 'changed-owner';
  input.baseTrust.checkpoint.digest = digest(7);
  input.baseTrust.rootPublicKey.x = digest(8);
  input.baseTrust.signedManifest = 'synthetic-secret';
  input.deviceId = 'substituted-mac';
  input.roles.length = 0;
  input.revokeDevices[0].keyId = digest(9);
  input.revokeDevices.length = 0;
  await operation;
  const restored = state(recovered);
  assert.equal(restored.device.deviceId, 'synthetic-recovered-mac');
  assert.deepEqual(restored.device.roles, ['host', 'client']);
  assert.deepEqual(restored.pin, f.original.pin);
  assert.equal(recovered.current()!.manifest.previous, f.baseTrust.checkpoint.digest);
  assert.equal(
    recovered
      .current()!
      .manifest.devices.some((device) => device.deviceId === state(f.lost).device.deviceId),
    false,
  );
});

test('an explicitly selected stale base is not represented as the globally latest trust state', async (t) => {
  const f = await established(t),
    recovered = await f.open('recovered');
  // The surviving endpoint advances independently; recovery receives only the caller-selected old base.
  await f.owner.revokeDevice({
    expectedRevision: state(f.owner).revision,
    deviceId: state(f.lost).device.deviceId,
    expectedKeyId: state(f.lost).device.keyId,
    recoveryKey: f.recoveryKey,
  });
  const latest = state(f.owner);
  await recovered.recover(f.options());
  const restored = state(recovered);
  assert.equal(restored.trust.checkpoint.epoch, latest.trust.checkpoint.epoch);
  assert.notEqual(restored.trust.checkpoint.digest, latest.trust.checkpoint.digest);
  const before = fs.readFileSync(f.path('owner'));
  await assert.rejects(
    f.owner.installTrust({
      expectedRevision: latest.revision,
      signedManifest: restored.trust.signedManifest,
    }),
    safeFailure,
  );
  assert.deepEqual(fs.readFileSync(f.path('owner')), before);
  assert.deepEqual(state(f.owner), latest);
});
