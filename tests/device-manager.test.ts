import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64url } from 'jose';
import { devicePublicKey, E2EE_CRYPTO_FAILED } from '../src/security/e2ee-crypto';
import { E2eeChannel } from '../src/security/e2ee-channel';
import {
  E2EE_PAIRING_LIMITS,
  fingerprintRequest,
  type PairingRequest,
} from '../src/security/e2ee-pairing';
import {
  decryptRecovery,
  generateRecoveryKey,
  importRootPrivateJwk,
} from '../src/security/e2ee-recovery';
import { signTrustManifest, VerifiedTrust } from '../src/security/e2ee-trust';
import { DeviceManager, type DevicePairingReceipt } from '../src/security/device-manager';

const NOW = 1_900_000_000_000;
const identity = {
  accountId: 'synthetic-owner',
  serverOrigin: 'https://relay.example.test',
  deviceId: 'synthetic-mbp',
  roles: ['host', 'client'] as ('host' | 'client')[],
};
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, E2EE_CRYPTO_FAILED);
  assert.equal(error.cause, undefined);
  assert.ok(!String(error.stack).includes('synthetic-secret'));
  return true;
};
function configured(manager: DeviceManager) {
  const status = manager.status();
  assert.ok('device' in status);
  assert.ok(status.revision !== null);
  return { ...status, revision: status.revision };
}
function active(manager: DeviceManager) {
  const status = configured(manager);
  assert.equal(status.phase, 'active');
  assert.ok(status.trust);
  return { ...status, trust: status.trust };
}
function pending(manager: DeviceManager) {
  const status = configured(manager);
  assert.ok(status.pending);
  return { ...status, pending: status.pending };
}
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-device-manager-')));
  const managers: DeviceManager[] = [];
  const paths = new Map<DeviceManager, string>();
  const state = { now: NOW };
  const code = generateRecoveryKey();
  t.after(() => {
    for (const manager of managers) manager.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const open = async (name: string) => {
    const privateDirectory = join(directory, name);
    mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    const path = join(privateDirectory, 'device.json');
    const manager = await DeviceManager.open(path, { now: () => state.now });
    managers.push(manager);
    paths.set(manager, path);
    return manager;
  };
  const owner = async () => {
    const manager = await open('owner');
    await manager.initialize(identity, code);
    return manager;
  };
  const begin = async (
    root: DeviceManager,
    name = 'air',
    roles: ('host' | 'client')[] = ['client'],
  ) => {
    const manager = await open(name);
    const result = await manager.beginPairing({
      pin: active(root).pin,
      deviceId: `synthetic-${name}`,
      roles,
    });
    return { manager, fingerprint: result.fingerprint, request: pending(manager).pending.request };
  };
  const approve = (
    root: DeviceManager,
    request: PairingRequest,
    fingerprint: string,
    previousKey: string | null = null,
  ) =>
    root.approvePairing({
      expectedRevision: configured(root).revision,
      request,
      expectedFingerprint: fingerprint,
      expectedDeviceKeyId: previousKey,
      recoveryKey: code,
    });
  const accept = (manager: DeviceManager, receipt: DevicePairingReceipt) =>
    manager.acceptPairing({
      expectedRevision: configured(manager).revision,
      approval: receipt.approval,
      rootPublicKey: receipt.trust.rootPublicKey,
      signedManifest: receipt.trust.signedManifest,
    });
  const pair = async (
    root: DeviceManager,
    name = 'air',
    roles: ('host' | 'client')[] = ['client'],
  ) => {
    const entry = await begin(root, name, roles);
    const receipt = await approve(root, entry.request, entry.fingerprint);
    await accept(entry.manager, receipt);
    return { ...entry, receipt };
  };
  const vault = (manager: DeviceManager) =>
    JSON.parse(readFileSync(paths.get(manager)!, 'utf8')).value;
  return { directory, paths, state, code, open, owner, begin, approve, accept, pair, vault };
}

test('explicit initialization persists the device private key and only an encrypted root capsule', async (t) => {
  const f = fixture(t);
  const manager = await f.open('owner');
  assert.deepEqual(manager.status(), { revision: null, phase: 'empty' });
  assert.equal(manager.current(), undefined);
  await assert.rejects(manager.encryptionKey(), safeFailure);
  await manager.initialize(identity, f.code);
  const status = active(manager);
  assert.equal(status.revision, 1);
  assert.equal(status.canUnlockRoot, true);
  assert.equal(status.trust.checkpoint.epoch, 1);
  assert.equal(await devicePublicKey(await manager.encryptionKey()), status.device.publicKey);
  const vault = f.vault(manager);
  const capsule = await manager.recoveryCapsule(f.code);
  const recovery = await decryptRecovery({ capsule, recoveryKey: f.code });
  assert.equal(vault.privateKey.kty, 'EC');
  assert.equal(vault.privateKey.d.length, 43);
  assert.ok(vault.recoveryCapsule.includes('.'));
  assert.ok(!JSON.stringify(vault).includes(recovery.rootPrivateKey.d));
  assert.ok(!JSON.stringify(vault).includes(f.code));
  assert.ok(!JSON.stringify(status).includes(vault.privateKey.d));
  assert.ok(!JSON.stringify(status).includes(vault.recoveryCapsule));
  assert.equal(statSync(f.paths.get(manager)!).mode & 0o777, 0o600);
  manager.close();
  const restored = await f.open('owner');
  assert.deepEqual(active(restored), status);
  assert.equal(await devicePublicKey(await restored.encryptionKey()), status.device.publicKey);
  await assert.rejects(restored.initialize(identity, f.code), safeFailure);
});

test('a pending device needs a fingerprint-approved receipt before it can encrypt or become active', async (t) => {
  const f = fixture(t),
    root = await f.owner();
  const entry = await f.begin(root);
  assert.equal(pending(entry.manager).phase, 'pending');
  assert.equal(entry.manager.current(), undefined);
  await assert.rejects(entry.manager.encryptionKey(), safeFailure);
  assert.equal(await fingerprintRequest(entry.request), entry.fingerprint);
  assert.equal(pending(entry.manager).canUnlockRoot, false);
  const receipt = await f.approve(root, entry.request, entry.fingerprint);
  assert.equal(active(root).trust.checkpoint.epoch, 2);
  assert.equal(entry.manager.current(), undefined);
  await f.accept(entry.manager, receipt);
  const status = active(entry.manager);
  assert.equal(status.pending, null);
  assert.equal(status.trust.checkpoint.epoch, 2);
  assert.equal(status.device.publicKey, entry.request.device.publicKey);
  assert.equal(
    await devicePublicKey(await entry.manager.encryptionKey()),
    entry.request.device.publicKey,
  );
  assert.equal(status.canUnlockRoot, false);
  assert.equal(f.vault(entry.manager).recoveryCapsule, null);
  await assert.rejects(f.accept(entry.manager, receipt), safeFailure);
  entry.manager.close();
  assert.deepEqual(active(await f.open('air')), status);
});

test('an approved request retry returns its original durable receipt across reopening without adding an epoch', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    entry = await f.begin(root);
  const expected = active(root).revision;
  const request = {
    expectedRevision: expected,
    request: entry.request,
    expectedFingerprint: entry.fingerprint,
    expectedDeviceKeyId: null,
    recoveryKey: f.code,
  };
  const receipt = await root.approvePairing(request);
  const status = active(root);
  assert.deepEqual(await root.approvePairing(request), receipt);
  assert.deepEqual(active(root), status);
  root.close();
  const reopened = await f.open('owner');
  assert.deepEqual(await reopened.approvePairing(request), receipt);
  assert.deepEqual(active(reopened), status);
});

test('wrong code, pin, fingerprint, role or revision cannot create a pairing approval', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    entry = await f.begin(root);
  const before = active(root);
  const input = {
    expectedRevision: before.revision,
    request: entry.request,
    expectedFingerprint: entry.fingerprint,
    expectedDeviceKeyId: null,
    recoveryKey: f.code,
  };
  const invalid = [
    { ...input, recoveryKey: generateRecoveryKey() },
    { ...input, expectedFingerprint: generateRecoveryKey() },
    { ...input, expectedRevision: before.revision + 1 },
    { ...input, expectedDeviceKeyId: generateRecoveryKey() },
    { ...input, request: { ...entry.request, accountId: 'another-owner' } },
    { ...input, request: { ...entry.request, rootKeyId: generateRecoveryKey() } },
    {
      ...input,
      request: {
        ...entry.request,
        device: { ...entry.request.device, roles: ['host'] as ['host'] },
      },
    },
  ];
  for (const value of invalid) await assert.rejects(root.approvePairing(value), safeFailure);
  assert.deepEqual(active(root), before);
  await assert.rejects(root.recoveryCapsule(generateRecoveryKey()), safeFailure);
});

test('a receipt cannot be substituted for another pending device or accepted with the wrong root', async (t) => {
  const f = fixture(t),
    root = await f.owner();
  const first = await f.begin(root, 'air'),
    second = await f.begin(root, 'mini');
  const receipt = await f.approve(root, first.request, first.fingerprint);
  await assert.rejects(f.accept(second.manager, receipt), safeFailure);
  const before = pending(first.manager);
  await assert.rejects(
    first.manager.acceptPairing({
      expectedRevision: before.revision + 1,
      approval: receipt.approval,
      rootPublicKey: receipt.trust.rootPublicKey,
      signedManifest: receipt.trust.signedManifest,
    }),
    safeFailure,
  );
  await assert.rejects(
    first.manager.acceptPairing({
      expectedRevision: before.revision,
      approval: receipt.approval,
      rootPublicKey: { ...receipt.trust.rootPublicKey, x: generateRecoveryKey() },
      signedManifest: receipt.trust.signedManifest,
    }),
    safeFailure,
  );
  assert.deepEqual(pending(first.manager), before);
});

test('expired pending requests survive reopening and renew only on an explicit action', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    entry = await f.begin(root);
  const privateBefore = f.vault(entry.manager).privateKey;
  f.state.now = entry.request.expiresAt;
  assert.equal(pending(entry.manager).pending.expired, true);
  await assert.rejects(f.approve(root, entry.request, entry.fingerprint), safeFailure);
  entry.manager.close();
  const reopened = await f.open('air');
  assert.equal(pending(reopened).pending.expired, true);
  assert.equal(reopened.current(), undefined);
  const result = await reopened.renewPairing(pending(reopened).revision);
  const renewed = pending(reopened).pending.request;
  assert.notEqual(renewed.pairingId, entry.request.pairingId);
  assert.equal(renewed.device.publicKey, entry.request.device.publicKey);
  assert.equal(renewed.expiresAt, f.state.now + E2EE_PAIRING_LIMITS.lifetimeMs);
  assert.deepEqual(f.vault(reopened).privateKey, privateBefore);
  assert.equal(pending(reopened).pending.expired, false);
  await f.accept(reopened, await f.approve(root, renewed, result.fingerprint));
  assert.equal(active(reopened).phase, 'active');
});

test('expiry during asynchronous approval or accept prevents a late mutation', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    first = await f.begin(root);
  const before = active(root);
  const approving = f.approve(root, first.request, first.fingerprint);
  f.state.now = first.request.expiresAt;
  await assert.rejects(approving, safeFailure);
  assert.deepEqual(active(root), before);
  const renew = await first.manager.renewPairing(pending(first.manager).revision);
  const request = pending(first.manager).pending.request;
  const receipt = await f.approve(root, request, renew.fingerprint);
  const beforeAccept = pending(first.manager);
  const accepting = f.accept(first.manager, receipt);
  f.state.now = request.expiresAt;
  await assert.rejects(accepting, safeFailure);
  assert.equal(pending(first.manager).revision, beforeAccept.revision);
  assert.equal(first.manager.current(), undefined);
});

test('expired durable receipts remain inert after reopening and require an explicitly renewed approval', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    entry = await f.begin(root);
  const oldReceipt = await f.approve(root, entry.request, entry.fingerprint);
  f.state.now = entry.request.expiresAt;
  root.close();
  const reopened = await f.open('owner');
  assert.equal(active(reopened).approvals.length, 1);
  await assert.rejects(f.approve(reopened, entry.request, entry.fingerprint), safeFailure);
  await assert.rejects(f.accept(entry.manager, oldReceipt), safeFailure);
  const renewal = await entry.manager.renewPairing(pending(entry.manager).revision);
  const request = pending(entry.manager).pending.request;
  await assert.rejects(f.approve(reopened, request, renewal.fingerprint), safeFailure);
  const receipt = await f.approve(
    reopened,
    request,
    renewal.fingerprint,
    oldReceipt.request.device.keyId,
  );
  assert.notEqual(receipt.request.pairingId, oldReceipt.request.pairingId);
  assert.equal(active(reopened).approvals.length, 1);
  await f.accept(entry.manager, receipt);
  assert.equal(active(entry.manager).trust.checkpoint.epoch, 3);
});

test('revocation requires the exact current device key and becomes effective after explicit trust sync', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    entry = await f.pair(root);
  const before = active(root),
    device = active(entry.manager).device;
  await assert.rejects(
    root.revokeDevice({
      expectedRevision: before.revision,
      deviceId: device.deviceId,
      expectedKeyId: generateRecoveryKey(),
      recoveryKey: f.code,
    }),
    safeFailure,
  );
  await assert.rejects(
    root.revokeDevice({
      expectedRevision: before.revision - 1,
      deviceId: device.deviceId,
      expectedKeyId: device.keyId,
      recoveryKey: f.code,
    }),
    safeFailure,
  );
  await root.revokeDevice({
    expectedRevision: before.revision,
    deviceId: device.deviceId,
    expectedKeyId: device.keyId,
    recoveryKey: f.code,
  });
  const next = active(root);
  assert.equal(next.trust.checkpoint.epoch, 3);
  assert.equal(active(entry.manager).trust.checkpoint.epoch, 2);
  await entry.manager.installTrust({
    expectedRevision: active(entry.manager).revision,
    signedManifest: next.trust.signedManifest,
  });
  assert.equal(configured(entry.manager).phase, 'revoked');
  assert.equal(entry.manager.current(), undefined);
  await assert.rejects(entry.manager.encryptionKey(), safeFailure);
  entry.manager.close();
  assert.equal(configured(await f.open('air')).phase, 'revoked');
});

test('trust sync is idempotent and rejects rollback, skipped epochs and foreign roots', async (t) => {
  const f = fixture(t),
    root = await f.owner();
  const genesis = active(root).trust.signedManifest;
  const entry = await f.pair(root);
  const before = active(entry.manager);
  await entry.manager.installTrust({
    expectedRevision: before.revision,
    signedManifest: before.trust.signedManifest,
  });
  assert.deepEqual(active(entry.manager), before);
  await assert.rejects(
    entry.manager.installTrust({ expectedRevision: before.revision, signedManifest: genesis }),
    safeFailure,
  );
  await f.pair(root, 'mini');
  await f.pair(root, 'phone');
  await assert.rejects(
    entry.manager.installTrust({
      expectedRevision: before.revision,
      signedManifest: active(root).trust.signedManifest,
    }),
    safeFailure,
  );
  const other = await f.open('other-owner');
  await other.initialize({ ...identity, deviceId: 'different-root' }, generateRecoveryKey());
  await assert.rejects(
    entry.manager.installTrust({
      expectedRevision: before.revision,
      signedManifest: active(other).trust.signedManifest,
    }),
    safeFailure,
  );
  assert.deepEqual(active(entry.manager), before);
});

test('key rotation keeps the old private key usable until the exact pending approval is accepted', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    entry = await f.pair(root);
  const before = active(entry.manager),
    oldPrivate = f.vault(entry.manager).privateKey;
  const rotation = await entry.manager.requestKeyRotation(before.revision);
  const request = pending(entry.manager).pending.request;
  assert.equal(configured(entry.manager).phase, 'active');
  assert.notEqual(request.device.keyId, before.device.keyId);
  assert.equal(request.device.deviceId, before.device.deviceId);
  assert.deepEqual(f.vault(entry.manager).privateKey, oldPrivate);
  assert.notDeepEqual(f.vault(entry.manager).pending.privateKey, oldPrivate);
  assert.equal(await devicePublicKey(await entry.manager.encryptionKey()), before.device.publicKey);
  await assert.rejects(f.approve(root, request, rotation.fingerprint), safeFailure);
  const receipt = await f.approve(root, request, rotation.fingerprint, before.device.keyId);
  assert.equal(await devicePublicKey(await entry.manager.encryptionKey()), before.device.publicKey);
  await f.accept(entry.manager, receipt);
  const after = active(entry.manager);
  assert.equal(after.device.keyId, request.device.keyId);
  assert.equal(after.pending, null);
  assert.notDeepEqual(f.vault(entry.manager).privateKey, oldPrivate);
  assert.equal(
    await devicePublicKey(await entry.manager.encryptionKey()),
    request.device.publicKey,
  );
  entry.manager.close();
  assert.deepEqual(active(await f.open('air')), after);
});

test('canceling a rotation discards only its pending replacement key', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    entry = await f.pair(root);
  const before = active(entry.manager),
    oldPrivate = f.vault(entry.manager).privateKey;
  await entry.manager.requestKeyRotation(before.revision);
  await assert.rejects(
    entry.manager.requestKeyRotation(pending(entry.manager).revision),
    safeFailure,
  );
  const result = entry.manager.cancelRotation(pending(entry.manager).revision);
  assert.ok('pending' in result);
  assert.equal(result.pending, null);
  assert.deepEqual(active(entry.manager).device, before.device);
  assert.deepEqual(f.vault(entry.manager).privateKey, oldPrivate);
  assert.throws(() => entry.manager.cancelRotation(active(entry.manager).revision), safeFailure);
});

test('real E2EE channels use manager current state and lose authority after trust changes', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    entry = await f.pair(root);
  const common = {
    clientDeviceId: active(entry.manager).device.deviceId,
    hostDeviceId: active(root).device.deviceId,
    hostChallenge: generateRecoveryKey(),
    clientChallenge: generateRecoveryKey(),
  };
  const clientChannel = await E2eeChannel.create({
    ...common,
    side: 'client',
    trust: entry.manager.current()!,
    privateKey: await entry.manager.encryptionKey(),
    current: () => entry.manager.current(),
  });
  const hostChannel = await E2eeChannel.create({
    ...common,
    side: 'host',
    trust: root.current()!,
    privateKey: await root.encryptionKey(),
    current: () => root.current(),
  });
  const request = {
    kind: 'request' as const,
    requestId: base64url.encode(new Uint8Array(32).fill(4)),
    resource: {
      kind: 'catalog' as const,
      workspaceId: null,
      projectId: null,
      sessionId: null,
      catalogWorkspaceId: null,
      replicaId: null,
    },
    plaintext: new TextEncoder().encode('synthetic private request'),
  };
  const record = await clientChannel.send(request);
  assert.deepEqual((await hostChannel.receive(record)).plaintext, request.plaintext);
  const late = await clientChannel.send(request);
  await root.revokeDevice({
    expectedRevision: active(root).revision,
    deviceId: active(entry.manager).device.deviceId,
    expectedKeyId: active(entry.manager).device.keyId,
    recoveryKey: f.code,
  });
  assert.throws(() => hostChannel.assertCurrent(), safeFailure);
  await assert.rejects(hostChannel.receive(late), safeFailure);
  await entry.manager.installTrust({
    expectedRevision: active(entry.manager).revision,
    signedManifest: active(root).trust.signedManifest,
  });
  assert.throws(() => clientChannel.assertCurrent(), safeFailure);
  await assert.rejects(clientChannel.send(request), safeFailure);
});

test('initialization and pairing inputs are snapshotted before asynchronous key generation', async (t) => {
  const f = fixture(t),
    root = await f.open('owner');
  const input = structuredClone(identity);
  const initializing = root.initialize(input, f.code);
  input.deviceId = 'substituted-device';
  input.roles.length = 0;
  await initializing;
  assert.deepEqual(active(root).device.roles, identity.roles);
  assert.equal(active(root).device.deviceId, identity.deviceId);
  const client = await f.open('air');
  const pairing = {
    pin: active(root).pin,
    deviceId: 'synthetic-air',
    roles: ['client'] as ('host' | 'client')[],
  };
  const creating = client.beginPairing(pairing);
  pairing.pin.accountId = 'another-owner';
  pairing.roles.length = 0;
  pairing.deviceId = 'substituted-device';
  await creating;
  assert.equal(pending(client).device.deviceId, 'synthetic-air');
  assert.deepEqual(pending(client).device.roles, ['client']);
});

test('approval and acceptance inputs are snapshotted across asynchronous cryptography', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    entry = await f.begin(root);
  const input = {
    expectedRevision: active(root).revision,
    request: structuredClone(entry.request),
    expectedFingerprint: entry.fingerprint,
    expectedDeviceKeyId: null,
    recoveryKey: f.code,
  };
  const approving = root.approvePairing(input);
  input.request.device.roles.push('host');
  input.request.pairingId = generateRecoveryKey();
  input.expectedFingerprint = generateRecoveryKey();
  input.recoveryKey = generateRecoveryKey();
  const receipt = await approving;
  assert.deepEqual(receipt.request, entry.request);
  const acceptingInput = {
    expectedRevision: pending(entry.manager).revision,
    approval: receipt.approval,
    rootPublicKey: structuredClone(receipt.trust.rootPublicKey),
    signedManifest: receipt.trust.signedManifest,
  };
  const accepting = entry.manager.acceptPairing(acceptingInput);
  acceptingInput.rootPublicKey.x = generateRecoveryKey();
  acceptingInput.approval = 'synthetic-secret';
  acceptingInput.signedManifest = 'synthetic-secret';
  await accepting;
  assert.deepEqual(active(entry.manager).device, entry.request.device);
});

test('concurrent initialization and concurrent approval commit at most one revision', async (t) => {
  const f = fixture(t),
    root = await f.open('owner');
  const initialization = await Promise.allSettled([
    root.initialize(identity, f.code),
    root.initialize({ ...identity, deviceId: 'other-mbp' }, f.code),
  ]);
  assert.equal(initialization.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(active(root).revision, 1);
  const first = await f.begin(root, 'air'),
    second = await f.begin(root, 'mini');
  const results = await Promise.allSettled([
    f.approve(root, first.request, first.fingerprint),
    f.approve(root, second.request, second.fingerprint),
  ]);
  assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
  for (const value of [...initialization, ...results])
    if (value.status === 'rejected') safeFailure(value.reason);
  assert.equal(active(root).revision, 2);
  assert.equal(active(root).trust.checkpoint.epoch, 2);
});

test('concurrent acceptance consumes a pending request only once', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    entry = await f.begin(root);
  const receipt = await f.approve(root, entry.request, entry.fingerprint);
  const results = await Promise.allSettled([
    f.accept(entry.manager, receipt),
    f.accept(entry.manager, receipt),
  ]);
  assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
  for (const value of results) if (value.status === 'rejected') safeFailure(value.reason);
  assert.equal(active(entry.manager).revision, 2);
});

test('closing during initialize, approval and acceptance prevents late writes', async (t) => {
  const f = fixture(t),
    empty = await f.open('empty');
  const creating = empty.initialize(identity, f.code);
  empty.close();
  await assert.rejects(creating, safeFailure);
  assert.deepEqual((await f.open('empty')).status(), { revision: null, phase: 'empty' });
  const root = await f.owner(),
    entry = await f.begin(root);
  const before = active(root);
  const approving = f.approve(root, entry.request, entry.fingerprint);
  root.close();
  await assert.rejects(approving, safeFailure);
  const reopened = await f.open('owner');
  assert.deepEqual(active(reopened), before);
  const receipt = await f.approve(reopened, entry.request, entry.fingerprint);
  const accepting = f.accept(entry.manager, receipt);
  entry.manager.close();
  await assert.rejects(accepting, safeFailure);
  assert.equal(pending(await f.open('air')).phase, 'pending');
});

test('status mutations cannot change persisted trust, roles or pending requests', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    entry = await f.begin(root);
  const ownerStatus = active(root),
    pendingStatus = pending(entry.manager);
  ownerStatus.device.roles.length = 0;
  ownerStatus.pin.accountId = 'other-owner';
  ownerStatus.trust.checkpoint.epoch = 100;
  pendingStatus.pending.request.device.roles.push('host');
  assert.deepEqual(active(root).device.roles, identity.roles);
  assert.equal(active(root).trust.checkpoint.epoch, 1);
  assert.deepEqual(pending(entry.manager).pending.request.device.roles, ['client']);
});

test('recovery uses the explicitly verified latest base, revokes selected keys and generates a new device identity', async (t) => {
  const f = fixture(t),
    root = await f.owner();
  const oldCapsule = await root.recoveryCapsule(f.code);
  const oldDevice = active(root).device,
    oldPrivate = f.vault(root).privateKey;
  const client = await f.pair(root);
  const base = active(root).trust;
  const recovered = await f.open('recovered');
  await recovered.recover({
    capsule: oldCapsule,
    recoveryKey: f.code,
    expectedPin: base.pin,
    baseTrust: base,
    deviceId: 'synthetic-recovered',
    roles: ['host', 'client'],
    revokeDevices: [{ deviceId: oldDevice.deviceId, keyId: oldDevice.keyId }],
  });
  const status = active(recovered);
  assert.equal(status.trust.checkpoint.epoch, 3);
  assert.equal(status.device.deviceId, 'synthetic-recovered');
  assert.notEqual(status.device.keyId, oldDevice.keyId);
  assert.notEqual(status.device.publicKey, oldDevice.publicKey);
  assert.notEqual(f.vault(recovered).privateKey.d, oldPrivate.d);
  assert.equal(status.pending, null);
  assert.deepEqual(status.approvals, []);
  assert.equal(status.canUnlockRoot, true);
  assert.throws(() => recovered.current()!.device(oldDevice.deviceId, 'host'), safeFailure);
  assert.equal(
    recovered.current()!.device(active(client.manager).device.deviceId, 'client').keyId,
    active(client.manager).device.keyId,
  );
  const newCapsule = await recovered.recoveryCapsule(f.code);
  const opened = await decryptRecovery({ capsule: newCapsule, recoveryKey: f.code });
  assert.deepEqual(opened.checkpoint, status.trust.checkpoint);
  assert.ok(!readFileSync(f.paths.get(recovered)!, 'utf8').includes(opened.rootPrivateKey.d));
  assert.ok(!readFileSync(f.paths.get(recovered)!, 'utf8').includes(f.code));
  await root.installTrust({
    expectedRevision: active(root).revision,
    signedManifest: status.trust.signedManifest,
  });
  assert.equal(configured(root).phase, 'revoked');
  assert.equal(root.current(), undefined);
  recovered.close();
  assert.deepEqual(active(await f.open('recovered')), status);
});

test('recovery rejects stale or forked bases, wrong pins, old identities and incorrect revocation keys', async (t) => {
  const f = fixture(t),
    root = await f.owner();
  const genesis = active(root).trust;
  await f.pair(root);
  const latest = active(root),
    capsule = await root.recoveryCapsule(f.code);
  const decoded = await decryptRecovery({ capsule, recoveryKey: f.code });
  const latestManifest = JSON.parse(
    Buffer.from(latest.trust.signedManifest.split('.')[1], 'base64url').toString('utf8'),
  );
  const forkSigned = await signTrustManifest({
    manifest: { ...latestManifest, devices: [latest.device] },
    rootPublicKey: decoded.rootPublicKey,
    rootPrivateKey: await importRootPrivateJwk(decoded.rootPrivateKey),
  });
  const forkTrust = await VerifiedTrust.verify({
    signed: forkSigned,
    rootPublicKey: decoded.rootPublicKey,
    pin: decoded.pin,
    previous: genesis.checkpoint,
  });
  const target = await f.open('recover-invalid');
  const input: Parameters<DeviceManager['recover']>[0] = {
    capsule,
    recoveryKey: f.code,
    expectedPin: latest.pin,
    baseTrust: latest.trust,
    deviceId: 'synthetic-recovered',
    roles: ['host'],
    revokeDevices: [],
  };
  const invalid: Parameters<DeviceManager['recover']>[0][] = [
    { ...input, recoveryKey: generateRecoveryKey() },
    { ...input, expectedPin: { ...input.expectedPin, accountId: 'different-owner' } },
    { ...input, expectedPin: { ...input.expectedPin, rootKeyId: generateRecoveryKey() } },
    { ...input, baseTrust: genesis },
    {
      ...input,
      baseTrust: {
        ...latest.trust,
        checkpoint: { ...forkTrust.checkpoint },
        signedManifest: forkSigned,
      },
    },
    {
      ...input,
      baseTrust: { ...latest.trust, checkpoint: { ...latest.trust.checkpoint, epoch: 10 } },
    },
    { ...input, deviceId: latest.device.deviceId },
    { ...input, roles: ['admin' as 'host'] },
    {
      ...input,
      revokeDevices: [{ deviceId: latest.device.deviceId, keyId: generateRecoveryKey() }],
    },
    { ...input, revokeDevices: [{ deviceId: 'nonexistent', keyId: latest.device.keyId }] },
    {
      ...input,
      revokeDevices: [
        { deviceId: latest.device.deviceId, keyId: latest.device.keyId },
        { deviceId: latest.device.deviceId, keyId: latest.device.keyId },
      ],
    },
  ];
  for (const value of invalid) {
    await assert.rejects(target.recover(value), safeFailure);
    assert.deepEqual(target.status(), { revision: null, phase: 'empty' });
  }
  const missingBase = { ...input } as Partial<typeof input>;
  delete missingBase.baseTrust;
  await assert.rejects(target.recover(missingBase as typeof input), safeFailure);
  const missingRevocations = { ...input } as Partial<typeof input>;
  delete missingRevocations.revokeDevices;
  await assert.rejects(target.recover(missingRevocations as typeof input), safeFailure);
  await target.recover(input);
  assert.equal(active(target).trust.checkpoint.epoch, latest.trust.checkpoint.epoch + 1);
  await assert.rejects(target.recover(input), safeFailure);
});

test('recovery snapshots the approved base, revocation list, pin and new-device roles across awaits', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    target = await f.open('recovered');
  const before = active(root);
  const input: Parameters<DeviceManager['recover']>[0] = {
    capsule: await root.recoveryCapsule(f.code),
    recoveryKey: f.code,
    expectedPin: structuredClone(before.pin),
    baseTrust: structuredClone(before.trust),
    deviceId: 'synthetic-recovered',
    roles: ['host'],
    revokeDevices: [{ deviceId: before.device.deviceId, keyId: before.device.keyId }],
  };
  const recovering = target.recover(input);
  input.baseTrust.rootPublicKey.x = generateRecoveryKey();
  input.expectedPin.accountId = 'different-owner';
  input.revokeDevices.length = 0;
  input.roles.length = 0;
  input.deviceId = 'different-device';
  input.recoveryKey = generateRecoveryKey();
  await recovering;
  assert.equal(active(target).device.deviceId, 'synthetic-recovered');
  assert.deepEqual(active(target).device.roles, ['host']);
  assert.throws(() => target.current()!.device(before.device.deviceId, 'host'), safeFailure);
});

test('closing or concurrent recovery cannot persist multiple new identities', async (t) => {
  const f = fixture(t),
    root = await f.owner();
  const before = active(root);
  const input: Parameters<DeviceManager['recover']>[0] = {
    capsule: await root.recoveryCapsule(f.code),
    recoveryKey: f.code,
    expectedPin: before.pin,
    baseTrust: before.trust,
    deviceId: 'synthetic-recovered',
    roles: ['host'],
    revokeDevices: [],
  };
  const closing = await f.open('closing');
  const recovering = closing.recover(input);
  closing.close();
  await assert.rejects(recovering, safeFailure);
  assert.deepEqual((await f.open('closing')).status(), { revision: null, phase: 'empty' });
  const target = await f.open('concurrent');
  const results = await Promise.allSettled([
    target.recover(input),
    target.recover({ ...input, deviceId: 'other-recovered' }),
  ]);
  assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
  for (const value of results) if (value.status === 'rejected') safeFailure(value.reason);
  assert.equal(active(target).revision, 1);
  assert.equal(target.current()!.manifest.devices.length, 2);
  assert.deepEqual(active(root), before);
});
