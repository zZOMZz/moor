import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeviceManager,
  DEVICE_MANAGER_LIMITS,
  type DevicePublicTrust,
} from '../src/security/device-manager';
import { E2EE_CRYPTO_FAILED } from '../src/security/e2ee-crypto';
import { type PairingRequest } from '../src/security/e2ee-pairing';
import {
  decryptRecovery,
  generateRecoveryKey,
  importRootPrivateJwk,
} from '../src/security/e2ee-recovery';
import {
  signTrustManifest,
  VerifiedTrust,
  type TrustedDevice,
  type TrustManifest,
} from '../src/security/e2ee-trust';

const NOW = 1_900_000_000_000;
const copy = <T>(value: T): T => structuredClone(value);
const digest = (byte: number) => Buffer.alloc(32, byte).toString('base64url');
const identity = {
  accountId: 'synthetic-owner',
  serverOrigin: 'https://relay.example.test',
  deviceId: 'synthetic-mbp',
  roles: ['host', 'client'] as TrustedDevice['roles'],
};
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, E2EE_CRYPTO_FAILED);
  assert.equal(error.cause, undefined);
  return true;
};
function state(manager: DeviceManager) {
  const value = manager.status();
  assert.ok('trust' in value && value.trust && value.revision !== null);
  return { ...value, trust: value.trust, revision: value.revision };
}
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-device-publications-')));
  chmodSync(directory, 0o700);
  const managers: DeviceManager[] = [];
  const clock = { now: NOW };
  const recoveryKey = generateRecoveryKey();
  const path = (name: string) => join(directory, `${name}.json`);
  const bytes = (name: string) => readFileSync(path(name));
  const value = (name: string) => JSON.parse(bytes(name).toString('utf8')).value;
  const open = async (name: string) => {
    const manager = await DeviceManager.open(path(name), { now: () => clock.now });
    managers.push(manager);
    return manager;
  };
  const owner = async () => {
    const manager = await open('owner');
    await manager.initialize(copy(identity), recoveryKey);
    return manager;
  };
  const begin = async (root: DeviceManager, name: string) => {
    const manager = await open(name);
    const started = await manager.beginPairing({
      pin: state(root).pin,
      deviceId: `synthetic-${name}`,
      roles: ['client'],
    });
    const status = manager.status();
    assert.ok('pending' in status && status.pending);
    return { manager, request: status.pending.request, fingerprint: started.fingerprint };
  };
  const approve = (root: DeviceManager, request: PairingRequest, fingerprint: string) =>
    root.approvePairing({
      expectedRevision: state(root).revision,
      request,
      expectedFingerprint: fingerprint,
      expectedDeviceKeyId: null,
      recoveryKey,
    });
  const revoke = (root: DeviceManager, device: TrustedDevice) =>
    root.revokeDevice({
      expectedRevision: state(root).revision,
      deviceId: device.deviceId,
      expectedKeyId: device.keyId,
      recoveryKey,
    });
  t.after(() => {
    for (const manager of managers) manager.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, path, bytes, value, open, owner, begin, approve, revoke, recoveryKey, clock };
}
async function signer(root: DeviceManager, recoveryKey: string) {
  const recovery = await decryptRecovery({
    capsule: await root.recoveryCapsule(recoveryKey),
    recoveryKey,
  });
  const rootPrivateKey = await importRootPrivateJwk(recovery.rootPrivateKey);
  const sign = async (manifest: TrustManifest): Promise<DevicePublicTrust> => {
    const pin = {
      accountId: manifest.accountId,
      serverOrigin: manifest.serverOrigin,
      rootKeyId: manifest.rootKeyId,
    };
    const signedManifest = await signTrustManifest({
      manifest,
      rootPublicKey: recovery.rootPublicKey,
      rootPrivateKey,
    });
    // Verify against the real preceding digest. Each fixture is independently signed,
    // including deliberately foreign scope or forks, rather than a malformed JSON stub.
    const trust = await VerifiedTrust.verify({
      signed: signedManifest,
      rootPublicKey: recovery.rootPublicKey,
      pin,
      ...(manifest.previous
        ? {
            previous: { ...pin, epoch: manifest.epoch - 1, digest: manifest.previous },
          }
        : {}),
    });
    return {
      pin,
      rootPublicKey: recovery.rootPublicKey,
      checkpoint: trust.checkpoint,
      signedManifest,
    };
  };
  const chain = async (length: number) => {
    const entries: DevicePublicTrust[] = [];
    let manifest = copy(root.current()!.manifest);
    let previous = root.current()!.checkpoint;
    for (let i = 0; i < length; i++) {
      manifest = { ...manifest, epoch: previous.epoch + 1, previous: previous.digest };
      const entry = await sign(manifest);
      entries.push(entry);
      previous = entry.checkpoint;
    }
    return entries;
  };
  return { sign, chain, recovery };
}
const checkpoints = (manager: DeviceManager) =>
  manager.publications().entries.map((entry) => entry.checkpoint);

test('genesis publication is durable with initialization and reads expose only detached public material', async (t) => {
  const f = fixture(t),
    root = await f.owner();
  const before = f.bytes('owner');
  const status = state(root);
  const queued = root.publications();
  assert.equal(queued.revision, 1);
  assert.equal(status.pendingPublications, 1);
  assert.deepEqual(queued.entries, [status.trust]);
  assert.deepEqual(f.value('owner').publications, queued.entries);
  const { recovery } = await signer(root, f.recoveryKey);
  for (const secret of [
    f.recoveryKey,
    f.value('owner').privateKey.d,
    recovery.rootPrivateKey.d!,
    f.value('owner').recoveryCapsule,
  ])
    assert.equal(JSON.stringify(queued).includes(secret), false);
  queued.entries[0].checkpoint.epoch = 99;
  queued.entries[0].pin.accountId = 'changed-copy';
  queued.entries.splice(0);
  assert.deepEqual(root.publications().entries, [status.trust]);
  assert.deepEqual(f.bytes('owner'), before);
  root.close();
  const reopened = await f.open('owner');
  assert.deepEqual(reopened.publications().entries, [status.trust]);
  assert.deepEqual(f.bytes('owner'), before);
});

test('approval and revocation append public versions in the same CAS as trust, receipt and recovery capsule', async (t) => {
  const f = fixture(t),
    root = await f.owner();
  const genesis = state(root).trust;
  const joining = await f.begin(root, 'air');
  const initialRevision = state(root).revision;
  const receipt = await f.approve(root, joining.request, joining.fingerprint);
  assert.equal(state(root).revision, initialRevision + 1);
  assert.deepEqual(root.publications().entries, [genesis, receipt.trust]);
  assert.deepEqual(f.value('owner').approvals, [receipt]);
  const approvedRecovery = await decryptRecovery({
    capsule: f.value('owner').recoveryCapsule,
    recoveryKey: f.recoveryKey,
  });
  assert.deepEqual(approvedRecovery.checkpoint, receipt.trust.checkpoint);
  assert.equal(approvedRecovery.signedManifest, receipt.trust.signedManifest);
  const approvedBytes = f.bytes('owner');
  assert.deepEqual(await f.approve(root, joining.request, joining.fingerprint), receipt);
  assert.deepEqual(f.bytes('owner'), approvedBytes);
  await f.revoke(root, joining.request.device);
  assert.equal(state(root).revision, initialRevision + 2);
  assert.deepEqual(root.publications().entries, [genesis, receipt.trust, state(root).trust]);
  const revokedRecovery = await decryptRecovery({
    capsule: f.value('owner').recoveryCapsule,
    recoveryKey: f.recoveryKey,
  });
  assert.deepEqual(revokedRecovery.checkpoint, state(root).trust.checkpoint);
  const final = root.publications();
  root.close();
  assert.deepEqual((await f.open('owner')).publications(), final);
});

test('a newly paired endpoint does not pretend to own or publish its approving device history', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    joining = await f.begin(root, 'air');
  assert.throws(() => joining.manager.publications(), safeFailure);
  const receipt = await f.approve(root, joining.request, joining.fingerprint);
  const pending = joining.manager.status();
  assert.ok(pending.revision !== null);
  await joining.manager.acceptPairing({
    expectedRevision: pending.revision,
    approval: receipt.approval,
    rootPublicKey: receipt.trust.rootPublicKey,
    signedManifest: receipt.trust.signedManifest,
  });
  assert.deepEqual(joining.manager.publications().entries, []);
  assert.equal(state(joining.manager).pendingPublications, 0);
  assert.deepEqual(f.value('air').publications, []);
});

test('recovery stores exactly its newly signed version with the new endpoint key in the first write', async (t) => {
  const f = fixture(t),
    root = await f.owner();
  const old = state(root);
  const target = await f.open('recovered');
  await target.recover({
    capsule: await root.recoveryCapsule(f.recoveryKey),
    recoveryKey: f.recoveryKey,
    expectedPin: old.pin,
    baseTrust: old.trust,
    deviceId: 'synthetic-recovered',
    roles: ['host'],
    revokeDevices: [{ deviceId: old.device.deviceId, keyId: old.device.keyId }],
  });
  const recovered = state(target);
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.trust.checkpoint.epoch, 2);
  assert.notEqual(recovered.device.keyId, old.device.keyId);
  assert.deepEqual(target.publications().entries, [recovered.trust]);
  const stored = f.value('recovered');
  assert.deepEqual(stored.publications, [stored.trust]);
  const recovery = await decryptRecovery({
    capsule: stored.recoveryCapsule,
    recoveryKey: f.recoveryKey,
  });
  assert.deepEqual(recovery.checkpoint, recovered.trust.checkpoint);
  target.close();
  assert.deepEqual((await f.open('recovered')).publications().entries, [recovered.trust]);
});

test('acknowledgement removes only the exact prefix and preserves the live VerifiedTrust object', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    joining = await f.begin(root, 'air');
  await f.approve(root, joining.request, joining.fingerprint);
  await f.revoke(root, joining.request.device);
  const before = state(root),
    authority = root.current(),
    stored = f.value('owner');
  const queued = root.publications();
  root.ackPublications({
    expectedRevision: before.revision,
    checkpoints: queued.entries.slice(0, 2).map((entry) => entry.checkpoint),
  });
  assert.equal(state(root).revision, before.revision + 1);
  assert.equal(root.current(), authority);
  assert.deepEqual(root.publications().entries, queued.entries.slice(2));
  const after = f.value('owner');
  assert.deepEqual({ ...after, publications: stored.publications }, stored);
  root.ackPublications({ expectedRevision: state(root).revision, checkpoints: checkpoints(root) });
  assert.equal(root.current(), authority);
  assert.equal(state(root).pendingPublications, 0);
  assert.deepEqual(root.publications().entries, []);
  root.close();
  assert.deepEqual((await f.open('owner')).publications().entries, []);
});

test('invalid, stale, reordered or nonprefix acknowledgements never alter the private file', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    joining = await f.begin(root, 'air');
  await f.approve(root, joining.request, joining.fingerprint);
  const before = f.bytes('owner'),
    authority = root.current(),
    revision = state(root).revision;
  const [first, second] = checkpoints(root);
  const invalid = [
    { expectedRevision: revision, checkpoints: [] },
    { expectedRevision: revision + 1, checkpoints: [first] },
    { expectedRevision: revision, checkpoints: [second] },
    { expectedRevision: revision, checkpoints: [second, first] },
    { expectedRevision: revision, checkpoints: [first, first] },
    { expectedRevision: revision, checkpoints: [first, second, second] },
    { expectedRevision: revision, checkpoints: [{ ...first, digest: digest(91) }] },
    { expectedRevision: revision, checkpoints: [{ ...first, accountId: 'foreign-owner' }] },
    {
      expectedRevision: revision,
      checkpoints: [{ ...first, serverOrigin: 'https://foreign.example.test' }],
    },
    { expectedRevision: revision, checkpoints: [{ ...first, rootKeyId: digest(92) }] },
    { expectedRevision: revision, checkpoints: [{ ...first, unexpected: true }] },
    { expectedRevision: revision, checkpoints: Array.from({ length: 17 }, () => first) },
  ];
  for (const input of invalid) {
    assert.throws(() => root.ackPublications(input), safeFailure);
    assert.deepEqual(f.bytes('owner'), before);
    assert.equal(root.current(), authority);
  }
});

test('the 16-entry bound rejects a whole local trust change and acknowledgement releases capacity', async (t) => {
  const f = fixture(t),
    root = await f.owner();
  let last!: Awaited<ReturnType<typeof f.begin>>;
  // Eight approvals and seven revocations, plus genesis, reach the exact outbox bound.
  // Advance only the injected clock so live receipt limits do not obscure this boundary.
  for (let i = 0; i < 8; i++) {
    f.clock.now += 600_001;
    last = await f.begin(root, `device-${i}`);
    await f.approve(root, last.request, last.fingerprint);
    if (i < 7) await f.revoke(root, last.request.device);
  }
  assert.equal(DEVICE_MANAGER_LIMITS.publications, 16);
  assert.equal(state(root).pendingPublications, 16);
  const before = f.bytes('owner'),
    authority = root.current();
  await assert.rejects(f.revoke(root, last.request.device), safeFailure);
  assert.deepEqual(f.bytes('owner'), before);
  assert.equal(root.current(), authority);
  const extra = await f.begin(root, 'extra');
  await assert.rejects(f.approve(root, extra.request, extra.fingerprint), safeFailure);
  assert.deepEqual(f.bytes('owner'), before);
  const first = checkpoints(root)[0];
  root.ackPublications({ expectedRevision: state(root).revision, checkpoints: [first] });
  await f.revoke(root, last.request.device);
  assert.equal(state(root).pendingPublications, 16);
  assert.equal(state(root).trust.checkpoint.epoch, 17);
  assert.equal(root.publications().entries[0].checkpoint.epoch, 2);
});

test('a valid contiguous trust page installs once without republishing relay history', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    signed = await signer(root, f.recoveryKey);
  const entries = await signed.chain(3),
    before = state(root),
    queued = root.publications().entries;
  const key = f.value('owner').privateKey;
  await root.installTrustBatch({ expectedRevision: before.revision, entries });
  assert.equal(state(root).revision, before.revision + 1);
  assert.deepEqual(state(root).trust, entries.at(-1));
  assert.deepEqual(root.publications().entries, queued);
  assert.deepEqual(f.value('owner').privateKey, key);
  assert.deepEqual(f.value('owner').trust, entries.at(-1));
  root.close();
  const reopened = await f.open('owner');
  assert.deepEqual(state(reopened).trust, entries.at(-1));
  assert.deepEqual(reopened.publications().entries, queued);
});

test('the full 16-version page is accepted in one CAS and competing installs commit only once', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    signed = await signer(root, f.recoveryKey);
  const entries = await signed.chain(16),
    before = state(root);
  const installs = await Promise.allSettled([
    root.installTrustBatch({ expectedRevision: before.revision, entries }),
    root.installTrustBatch({ expectedRevision: before.revision, entries: copy(entries) }),
  ]);
  assert.equal(installs.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = installs.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  safeFailure(rejected.reason);
  assert.equal(state(root).revision, before.revision + 1);
  assert.deepEqual(state(root).trust, entries.at(-1));
  assert.deepEqual(root.publications().entries, [before.trust]);
});

test('an empty page is read-only but still requires current authority and revision', async (t) => {
  const f = fixture(t),
    root = await f.owner();
  const before = f.bytes('owner'),
    authority = root.current(),
    revision = state(root).revision;
  await root.installTrustBatch({ expectedRevision: revision, entries: [] });
  await assert.rejects(
    root.installTrustBatch({ expectedRevision: revision + 1, entries: [] }),
    safeFailure,
  );
  await assert.rejects(
    root.installTrustBatch(
      { expectedRevision: revision, entries: [] },
      {
        current: () => {
          throw new Error('expired');
        },
      },
    ),
    safeFailure,
  );
  assert.deepEqual(f.bytes('owner'), before);
  assert.equal(root.current(), authority);
});

test('bad final signatures, checkpoints and foreign scope cannot partially install earlier valid versions', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    signed = await signer(root, f.recoveryKey);
  const entries = await signed.chain(3),
    before = f.bytes('owner'),
    authority = root.current();
  const revision = state(root).revision;
  const last = entries[2];
  const signature = last.signedManifest.split('.');
  const raw = Buffer.from(signature[2], 'base64url');
  raw[0] ^= 1;
  signature[2] = raw.toString('base64url');
  const foreign = await signed.sign({
    ...root.current()!.manifest,
    epoch: 4,
    previous: entries[1].checkpoint.digest,
    accountId: 'foreign-owner',
  });
  const wrongOrigin = await signed.sign({
    ...root.current()!.manifest,
    epoch: 4,
    previous: entries[1].checkpoint.digest,
    serverOrigin: 'https://foreign.example.test',
  });
  const invalid = [
    [...entries.slice(0, 2), { ...last, signedManifest: signature.join('.') }],
    [...entries.slice(0, 2), { ...last, checkpoint: { ...last.checkpoint, digest: digest(13) } }],
    [...entries.slice(0, 2), foreign],
    [...entries.slice(0, 2), wrongOrigin],
    [...entries.slice(0, 2), { ...last, rootPublicKey: { ...last.rootPublicKey, x: digest(17) } }],
    [...entries.slice(0, 2), { ...last, secret: 'synthetic-private-field' }],
  ];
  for (const page of invalid) {
    await assert.rejects(
      root.installTrustBatch({ expectedRevision: revision, entries: page }),
      safeFailure,
    );
    assert.deepEqual(f.bytes('owner'), before);
    assert.equal(root.current(), authority);
  }
});

test('forks, replay, skipped or reordered epochs and oversized pages fail without writes', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    signed = await signer(root, f.recoveryKey);
  const entries = await signed.chain(3);
  const fork = await signed.sign({
    ...root.current()!.manifest,
    epoch: 2,
    previous: root.current()!.checkpoint.digest,
    devices: [],
  });
  const before = f.bytes('owner'),
    authority = root.current(),
    revision = state(root).revision;
  const invalid = [
    [state(root).trust],
    [entries[1]],
    [entries[0], entries[2]],
    [entries[1], entries[0]],
    [entries[0], entries[0]],
    [fork, entries[1]],
    Array.from({ length: 17 }, () => entries[0]),
  ];
  for (const page of invalid) {
    await assert.rejects(
      root.installTrustBatch({ expectedRevision: revision, entries: page }),
      safeFailure,
    );
    assert.deepEqual(f.bytes('owner'), before);
    assert.equal(root.current(), authority);
  }
});

test('batch inputs are snapshotted before crypto awaits and detached from later caller mutation', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    signed = await signer(root, f.recoveryKey);
  const entries = await signed.chain(2),
    expected = copy(entries.at(-1)!);
  const input = { expectedRevision: state(root).revision, entries };
  const installing = root.installTrustBatch(input);
  input.expectedRevision = 99;
  input.entries[1].signedManifest = 'changed-after-entry';
  input.entries[0].pin.accountId = 'changed-after-entry';
  input.entries.splice(0);
  await installing;
  assert.deepEqual(state(root).trust, expected);
});

test('expiry during crypto verification and final authority checks prevent every batch write', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    signed = await signer(root, f.recoveryKey);
  const entries = await signed.chain(2),
    before = f.bytes('owner'),
    authority = root.current();
  let valid = true;
  const installing = root.installTrustBatch(
    { expectedRevision: state(root).revision, entries },
    {
      current: () => {
        if (!valid) throw new Error('expired');
      },
    },
  );
  valid = false;
  await assert.rejects(installing, safeFailure);
  assert.deepEqual(f.bytes('owner'), before);
  assert.equal(root.current(), authority);
  let checks = 0;
  await assert.rejects(
    root.installTrustBatch(
      { expectedRevision: state(root).revision, entries },
      {
        current: () => {
          if (++checks === 4) throw new Error('expired-before-commit');
        },
      },
    ),
    safeFailure,
  );
  assert.equal(checks, 4);
  assert.deepEqual(f.bytes('owner'), before);
  assert.equal(root.current(), authority);
});

test('concurrent bookkeeping invalidates an in-flight batch without undoing the acknowledgement', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    signed = await signer(root, f.recoveryKey);
  const entries = await signed.chain(2),
    before = state(root),
    authority = root.current();
  const installing = root.installTrustBatch({ expectedRevision: before.revision, entries });
  root.ackPublications({ expectedRevision: before.revision, checkpoints: checkpoints(root) });
  const acknowledged = f.bytes('owner');
  await assert.rejects(installing, safeFailure);
  assert.deepEqual(f.bytes('owner'), acknowledged);
  assert.deepEqual(state(root).trust, before.trust);
  assert.equal(root.current(), authority);
  assert.equal(state(root).pendingPublications, 0);
});

test('close during batch verification leaves the prior persisted trust available on reopen', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    signed = await signer(root, f.recoveryKey);
  const entries = await signed.chain(2),
    before = f.bytes('owner'),
    oldTrust = state(root).trust;
  const installing = root.installTrustBatch({ expectedRevision: state(root).revision, entries });
  root.close();
  await assert.rejects(installing, safeFailure);
  assert.deepEqual(f.bytes('owner'), before);
  assert.deepEqual(state(await f.open('owner')).trust, oldTrust);
});

test('legacy state reads preserve the file and expose only its known current version', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    joining = await f.begin(root, 'air');
  await f.approve(root, joining.request, joining.fingerprint);
  const latest = state(root).trust,
    revision = state(root).revision;
  root.close();
  const legacy = JSON.parse(f.bytes('owner').toString('utf8'));
  delete legacy.value.publications;
  writeFileSync(f.path('owner'), JSON.stringify(legacy), { mode: 0o600 });
  const before = f.bytes('owner'),
    reopened = await f.open('owner');
  assert.equal(state(reopened).revision, revision);
  assert.equal(state(reopened).pendingPublications, 1);
  assert.deepEqual(reopened.publications().entries, [latest]);
  assert.deepEqual(f.bytes('owner'), before);
  const authority = reopened.current();
  reopened.ackPublications({ expectedRevision: revision, checkpoints: [latest.checkpoint] });
  assert.equal(reopened.current(), authority);
  assert.deepEqual(f.value('owner').publications, []);
  reopened.close();
  assert.deepEqual((await f.open('owner')).publications().entries, []);
});

test('legacy batch installation preserves its one known pending version and never fabricates missing history', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    joining = await f.begin(root, 'air');
  await f.approve(root, joining.request, joining.fingerprint);
  const current = state(root).trust;
  const signed = await signer(root, f.recoveryKey),
    entries = await signed.chain(2);
  root.close();
  const legacy = JSON.parse(f.bytes('owner').toString('utf8'));
  delete legacy.value.publications;
  writeFileSync(f.path('owner'), JSON.stringify(legacy), { mode: 0o600 });
  const reopened = await f.open('owner');
  await reopened.installTrustBatch({ expectedRevision: state(reopened).revision, entries });
  assert.deepEqual(state(reopened).trust, entries.at(-1));
  assert.deepEqual(reopened.publications().entries, [current]);
  assert.deepEqual(f.value('owner').publications, [current]);
});

test('a later local version may follow installed relay epochs without inventing intermediate outbox entries', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    signed = await signer(root, f.recoveryKey);
  const genesis = state(root).trust;
  await root.installTrustBatch({
    expectedRevision: state(root).revision,
    entries: await signed.chain(3),
  });
  const joining = await f.begin(root, 'air');
  const receipt = await f.approve(root, joining.request, joining.fingerprint);
  assert.equal(receipt.trust.checkpoint.epoch, 5);
  assert.deepEqual(root.publications().entries, [genesis, receipt.trust]);
  root.close();
  assert.deepEqual((await f.open('owner')).publications().entries, [genesis, receipt.trust]);
});

test('reopening rejects malformed or inconsistent persisted publications without rewriting the evidence', async (t) => {
  const f = fixture(t),
    root = await f.owner(),
    signed = await signer(root, f.recoveryKey);
  const genesis = state(root).trust,
    entries = await signed.chain(3);
  const fork = await signed.sign({
    ...root.current()!.manifest,
    epoch: 2,
    previous: genesis.checkpoint.digest,
    devices: [],
  });
  const foreign = await signed.sign({
    ...root.current()!.manifest,
    epoch: 2,
    previous: genesis.checkpoint.digest,
    accountId: 'foreign-owner',
  });
  await root.installTrustBatch({
    expectedRevision: state(root).revision,
    entries: entries.slice(0, 2),
  });
  root.close();
  const original = JSON.parse(f.bytes('owner').toString('utf8'));
  const invalid = [
    [entries[1], entries[0]],
    [genesis, entries[0], entries[0]],
    [fork, entries[1]],
    [entries[2]],
    [foreign],
    [{ ...genesis, signedManifest: 'invalid.synthetic.signature' }],
    [{ ...genesis, rootPublicKey: { ...genesis.rootPublicKey, x: digest(99) } }],
    Array.from({ length: 17 }, () => genesis),
  ];
  for (const publications of invalid) {
    const modified = copy(original);
    modified.value.publications = publications;
    writeFileSync(f.path('owner'), JSON.stringify(modified), { mode: 0o600 });
    const before = f.bytes('owner');
    await assert.rejects(f.open('owner'), safeFailure);
    assert.deepEqual(f.bytes('owner'), before);
  }
  writeFileSync(f.path('owner'), JSON.stringify(original), { mode: 0o600 });
  const reopened = await f.open('owner');
  assert.deepEqual(state(reopened).trust, entries[1]);
  assert.deepEqual(reopened.publications().entries, [genesis]);
});
