import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { base64url, CompactSign, compactVerify, importJWK } from 'jose';
import { E2EE_CRYPTO_FAILED, generateDeviceEncryptionKey } from '../src/security/e2ee-crypto';
import {
  createPairingRequest,
  E2EE_PAIRING_FINGERPRINT_DOMAIN,
  E2EE_PAIRING_LIMITS,
  E2EE_PAIRING_TYPE,
  fingerprintRequest,
  pairingRequestSchema,
  parsePairingRequest,
  signPairingApproval,
  verifyPairingApproval,
  type PairingRequest,
} from '../src/security/e2ee-pairing';
import {
  encryptionKeyId,
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
  type TrustedDevice,
  type TrustManifest,
  type TrustPin,
} from '../src/security/e2ee-trust';

const encoder = new TextEncoder();
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
const [root, otherRoot, hostKey, newKey, otherKey] = await Promise.all([
  generateTrustRoot(),
  generateTrustRoot(),
  generateDeviceEncryptionKey(),
  generateDeviceEncryptionKey(),
  generateDeviceEncryptionKey(),
]);
const pin: TrustPin = {
  accountId: 'synthetic-owner',
  serverOrigin: 'https://relay.example.test',
  rootKeyId: root.keyId,
};
const host: TrustedDevice = {
  deviceId: 'synthetic-existing-mac',
  keyId: await encryptionKeyId(hostKey.publicKey),
  publicKey: hostKey.publicKey,
  roles: ['host', 'client'],
};
const device: TrustedDevice = {
  deviceId: 'synthetic-new-mac',
  keyId: await encryptionKeyId(newKey.publicKey),
  publicKey: newKey.publicKey,
  roles: ['client', 'host'],
};
const otherDevice: TrustedDevice = {
  deviceId: 'synthetic-other-device',
  keyId: await encryptionKeyId(otherKey.publicKey),
  publicKey: otherKey.publicKey,
  roles: ['client'],
};
const signManifest = (manifest: TrustManifest) =>
  signTrustManifest({ manifest, rootPublicKey: root.publicKey, rootPrivateKey: root.privateKey });
const verifyManifest = (signed: string, previous?: VerifiedTrust['checkpoint']) =>
  VerifiedTrust.verify({ signed, rootPublicKey: root.publicKey, pin, previous });
const genesis: TrustManifest = {
  ...pin,
  version: 1,
  epoch: 1,
  previous: null,
  devices: [host],
};
const signedGenesis = await signManifest(genesis);
const trustedGenesis = await verifyManifest(signedGenesis);
const admitted: TrustManifest = {
  ...copy(genesis),
  epoch: 2,
  previous: trustedGenesis.checkpoint.digest,
  devices: [copy(host), copy(device)],
};
const signedAdmitted = await signManifest(admitted);
const trustedAdmitted = await verifyManifest(signedAdmitted, trustedGenesis.checkpoint);
const later: TrustManifest = {
  ...copy(admitted),
  epoch: 3,
  previous: trustedAdmitted.checkpoint.digest,
  devices: [...copy(admitted.devices), copy(otherDevice)],
};
const signedLater = await signManifest(later);
const trustedLater = await verifyManifest(signedLater, trustedAdmitted.checkpoint);
const request = await createPairingRequest({ pin, device, now });
const requestFingerprint = await fingerprintRequest(request);
const signOptions = () => ({
  request: copy(request),
  expectedFingerprint: requestFingerprint,
  trust: trustedAdmitted,
  rootPublicKey: copy(root.publicKey),
  rootPrivateKey: root.privateKey,
  now,
});
const approval = await signPairingApproval(signOptions());
const verifyOptions = () => ({
  request: copy(request),
  expectedRootPin: copy(pin),
  approval,
  rootPublicKey: copy(root.publicKey),
  signedManifest: signedAdmitted,
  now,
});
const payload = () => ({
  request: copy(request),
  requestFingerprint,
  acceptedCheckpoint: copy(trustedAdmitted.checkpoint),
});
const independentSign = (
  json: string,
  header: Record<string, unknown> & { alg: string } = {
    alg: 'ES256',
    typ: E2EE_PAIRING_TYPE,
  },
  key = root.privateKey,
) => new CompactSign(encoder.encode(json)).setProtectedHeader(header).sign(key);

test('pairing requests use fresh 256-bit IDs, ten-minute expiry and immutable input snapshots', async () => {
  const options = { pin: copy(pin), device: copy(device), now };
  const pending = createPairingRequest(options);
  options.pin.accountId = 'substituted-owner';
  options.device.publicKey = otherDevice.publicKey;
  options.device.roles.splice(0, 2, 'client');
  options.now = 0;
  const created = await pending;
  assert.equal(created.pairingId.length, 43);
  assert.equal(base64url.decode(created.pairingId).length, 32);
  assert.notEqual(created.pairingId, request.pairingId);
  assert.equal(created.expiresAt, now + 600_000);
  assert.equal(created.accountId, pin.accountId);
  assert.deepEqual(created.device, device);
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(created.device));
  assert.ok(Object.isFrozen(created.device.roles));
  assert.throws(() => created.device.roles.push('client'), TypeError);
});

test('expiry parsing is strict while the exported shape and fingerprint support expired pending state', async () => {
  assert.deepEqual(await parsePairingRequest(request, now), request);
  assert.deepEqual(await parsePairingRequest(request, request.expiresAt - 1), request);
  for (const time of [
    now - 1,
    request.expiresAt,
    request.expiresAt + 1,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    await assert.rejects(parsePairingRequest(request, time), safeFailure);
  const expired = { ...copy(request), expiresAt: now - 1 };
  assert.deepEqual(pairingRequestSchema.parse(expired), expired);
  assert.equal((await fingerprintRequest(expired)).length, 43);
  await assert.rejects(parsePairingRequest(expired, now), safeFailure);
  for (const expiresAt of [0, -1, now + 0.5, now + 600_001, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(parsePairingRequest({ ...request, expiresAt }, now), safeFailure);
  await assert.rejects(
    createPairingRequest({ pin, device, now: Number.MAX_SAFE_INTEGER }),
    safeFailure,
  );
});

test('decoded request parsing rejects extra fields, unsafe identities, noncanonical IDs and origins', async () => {
  const noncanonical = digest(0).slice(0, -1) + 'B';
  const invalid: unknown[] = [
    null,
    [],
    JSON.stringify(request),
    { ...request, version: 2 },
    { ...request, pairingId: digest(0) + '=' },
    { ...request, pairingId: noncanonical },
    { ...request, pairingId: digest(0).slice(1) },
    { ...request, accountId: '' },
    { ...request, accountId: 'a'.repeat(161) },
    { ...request, accountId: 'owner\nsynthetic-secret' },
    { ...request, rootKeyId: 'synthetic-secret' },
    { ...request, rootPrivateKey: 'synthetic-secret' },
  ];
  for (const serverOrigin of [
    'http://relay.example.test',
    'https://synthetic-secret@relay.example.test',
    'https://relay.example.test/',
    'https://relay.example.test?token=synthetic-secret',
    'https://relay.example.test#token',
    'https://relay.example.test/path',
    'file:///private/tmp',
  ])
    invalid.push({ ...request, serverOrigin });
  for (const value of invalid) await assert.rejects(parsePairingRequest(value, now), safeFailure);
  for (const serverOrigin of ['http://127.0.0.1:4242', 'http://[::1]:4242'])
    assert.equal(
      (await parsePairingRequest({ ...request, serverOrigin }, now)).serverOrigin,
      serverOrigin,
    );
});

test('P-256 point, key ID and unique one-or-two role sets are checked before a request is usable', async () => {
  const offcurve = base64url.encode(new Uint8Array([4, ...new Uint8Array(64)]));
  const invalid: unknown[] = [
    { ...device, publicKey: offcurve },
    { ...device, publicKey: otherDevice.publicKey },
    { ...device, publicKey: device.publicKey + '=' },
    { ...device, keyId: otherDevice.keyId },
    { ...device, roles: [] },
    { ...device, roles: ['client', 'client'] },
    { ...device, roles: ['host', 'client', 'host'] },
    { ...device, roles: ['admin'] },
    { ...device, deviceId: 'unsafe/device' },
    { ...device, privateKey: 'synthetic-secret' },
  ];
  for (const changed of invalid) {
    await assert.rejects(parsePairingRequest({ ...request, device: changed }, now), safeFailure);
    await assert.rejects(
      createPairingRequest({ pin, device: changed as TrustedDevice, now }),
      safeFailure,
    );
    await assert.rejects(
      fingerprintRequest({ ...request, device: changed as TrustedDevice }),
      safeFailure,
    );
  }
  for (const roles of [['client'], ['host'], ['client', 'host'], ['host', 'client']] as const)
    assert.deepEqual(
      (await parsePairingRequest({ ...request, device: { ...device, roles } }, now)).device.roles,
      roles,
    );
});

test('fingerprinting uses the full canonical request and an independently checked SHA-256 domain', async () => {
  assert.equal(E2EE_PAIRING_FINGERPRINT_DOMAIN, 'moor/e2ee/pairing-request/v1');
  assert.equal(
    requestFingerprint,
    createHash('sha256')
      .update('moor/e2ee/pairing-request/v1\n' + JSON.stringify(request))
      .digest('base64url'),
  );
  assert.notEqual(
    requestFingerprint,
    createHash('sha256').update(JSON.stringify(request)).digest('base64url'),
  );
  const reordered = Object.fromEntries(Object.entries(request).reverse()) as PairingRequest;
  reordered.device = Object.fromEntries(Object.entries(device).reverse()) as TrustedDevice;
  assert.equal(await fingerprintRequest(reordered), requestFingerprint);
  const variants: PairingRequest[] = [
    { ...request, pairingId: digest(19) },
    { ...request, accountId: 'another-owner' },
    { ...request, serverOrigin: 'https://other.example.test' },
    { ...request, rootKeyId: otherRoot.keyId },
    { ...request, expiresAt: request.expiresAt - 1 },
    { ...request, device: { ...device, deviceId: 'another-mac' } },
    { ...request, device: { ...otherDevice, deviceId: device.deviceId } },
    { ...request, device: { ...device, roles: ['client'] } },
    { ...request, device: { ...device, roles: ['host', 'client'] } },
  ];
  for (const variant of variants)
    assert.notEqual(await fingerprintRequest(variant), requestFingerprint);
});

test('parse and fingerprint snapshot mutable decoded input before awaiting cryptography', async () => {
  const parsedInput = copy(request),
    fingerprintInput = copy(request);
  const parsed = parsePairingRequest(parsedInput, now);
  const fingerprinted = fingerprintRequest(fingerprintInput);
  parsedInput.pairingId = digest(34);
  parsedInput.device.roles.length = 0;
  fingerprintInput.accountId = 'changed-owner';
  fingerprintInput.device.publicKey = otherDevice.publicKey;
  assert.deepEqual(await parsed, request);
  assert.equal(await fingerprinted, requestFingerprint);
});

test('approval requires an explicit matching full fingerprint, valid time and the real signing key', async () => {
  for (const expectedFingerprint of ['', requestFingerprint.slice(0, 12), digest(20), undefined])
    await assert.rejects(
      signPairingApproval({ ...signOptions(), expectedFingerprint: expectedFingerprint as string }),
      safeFailure,
    );
  await assert.rejects(
    signPairingApproval({ ...signOptions(), rootPublicKey: otherRoot.publicKey }),
    safeFailure,
  );
  await assert.rejects(
    signPairingApproval({ ...signOptions(), rootPrivateKey: otherRoot.privateKey }),
    safeFailure,
  );
  for (const time of [now - 1, request.expiresAt, now + 0.5])
    await assert.rejects(signPairingApproval({ ...signOptions(), now: time }), safeFailure);
});

test('approval signing requires an installed exact account, origin, root and device capability set', async () => {
  await assert.rejects(
    signPairingApproval({ ...signOptions(), trust: trustedGenesis }),
    safeFailure,
  );
  await assert.rejects(
    signPairingApproval({
      ...signOptions(),
      trust: { checkpoint: trustedAdmitted.checkpoint } as VerifiedTrust,
    }),
    safeFailure,
  );
  const variants: PairingRequest[] = [
    { ...request, accountId: 'another-owner' },
    { ...request, serverOrigin: 'https://another.example.test' },
    { ...request, rootKeyId: otherRoot.keyId },
    { ...request, device: { ...device, deviceId: 'absent-device' } },
    { ...request, device: { ...otherDevice, deviceId: device.deviceId } },
    { ...request, device: { ...device, roles: ['client'] } },
  ];
  for (const changed of variants)
    await assert.rejects(
      signPairingApproval({
        ...signOptions(),
        request: changed,
        expectedFingerprint: await fingerprintRequest(changed),
      }),
      safeFailure,
    );
  const changed = {
    ...copy(request),
    device: { ...copy(device), roles: ['host', 'client'] as ('host' | 'client')[] },
  };
  const signed = await signPairingApproval({
    ...signOptions(),
    request: changed,
    expectedFingerprint: await fingerprintRequest(changed),
  });
  assert.deepEqual(
    (await verifyPairingApproval({ ...verifyOptions(), request: changed, approval: signed }))
      .checkpoint,
    trustedAdmitted.checkpoint,
  );
});

test('approval is an independently verifiable ES256 receipt without a private key or embedded root authority', async () => {
  const verified = await compactVerify(approval, await importJWK(root.publicKey, 'ES256'), {
    algorithms: ['ES256'],
  });
  assert.deepEqual(verified.protectedHeader, { alg: 'ES256', typ: 'moor-e2ee-pairing+jws' });
  assert.equal(new TextDecoder().decode(verified.payload), JSON.stringify(payload()));
  assert.ok(approval.length < E2EE_PAIRING_LIMITS.approvalCharacters);
  assert.deepEqual(Object.keys(JSON.parse(new TextDecoder().decode(verified.payload))), [
    'request',
    'requestFingerprint',
    'acceptedCheckpoint',
  ]);
});

test('root-approved exact checkpoints admit a new endpoint at a non-genesis epoch', async () => {
  await assert.rejects(verifyManifest(signedAdmitted), safeFailure);
  const installed = await verifyPairingApproval(verifyOptions());
  assert.deepEqual(installed.checkpoint, trustedAdmitted.checkpoint);
  assert.deepEqual(installed.device(device.deviceId, 'client'), device);
  assert.deepEqual(installed.device(device.deviceId, 'host'), device);
  const laterApproval = await signPairingApproval({ ...signOptions(), trust: trustedLater });
  assert.deepEqual(
    (
      await verifyPairingApproval({
        ...verifyOptions(),
        approval: laterApproval,
        signedManifest: signedLater,
      })
    ).checkpoint,
    trustedLater.checkpoint,
  );
  assert.ok(Object.isFrozen(installed));
  assert.ok(Object.isFrozen(installed.checkpoint));
});

test('an approval cannot be applied to another pending request or a broader requested capability', async () => {
  const variants: PairingRequest[] = [
    { ...request, pairingId: digest(21) },
    { ...request, accountId: 'another-owner' },
    { ...request, serverOrigin: 'https://another.example.test' },
    { ...request, rootKeyId: otherRoot.keyId },
    { ...request, expiresAt: request.expiresAt - 1 },
    { ...request, device: { ...device, deviceId: 'another-mac' } },
    { ...request, device: { ...otherDevice, deviceId: device.deviceId } },
    { ...request, device: { ...device, roles: ['client'] } },
    { ...request, device: { ...device, roles: ['host', 'client'] } },
  ];
  for (const changed of variants)
    await assert.rejects(
      verifyPairingApproval({ ...verifyOptions(), request: changed }),
      safeFailure,
    );
});

test('approval verification binds the externally pinned account, server and root rather than receipt claims', async () => {
  for (const changed of [
    { ...pin, accountId: 'other-owner' },
    { ...pin, serverOrigin: 'https://another.example.test' },
    { ...pin, rootKeyId: otherRoot.keyId },
  ])
    await assert.rejects(
      verifyPairingApproval({ ...verifyOptions(), expectedRootPin: changed }),
      safeFailure,
    );
  await assert.rejects(
    verifyPairingApproval({ ...verifyOptions(), rootPublicKey: otherRoot.publicKey }),
    safeFailure,
  );
  await assert.rejects(
    verifyPairingApproval({
      ...verifyOptions(),
      approval: await independentSign(JSON.stringify(payload()), undefined, otherRoot.privateKey),
    }),
    safeFailure,
  );
  await assert.rejects(
    verifyPairingApproval({
      ...verifyOptions(),
      rootPublicKey: { ...root.publicKey, d: 'synthetic-secret' } as typeof root.publicKey,
    }),
    safeFailure,
  );
});

test('even valid trust history cannot replace the exact checkpoint authenticated by the approval', async () => {
  assert.deepEqual(
    (await verifyManifest(signedLater, trustedAdmitted.checkpoint)).checkpoint,
    trustedLater.checkpoint,
  );
  const fork = await signManifest({ ...copy(admitted), devices: [copy(device)] });
  for (const signedManifest of [signedGenesis, fork, signedLater])
    await assert.rejects(
      verifyPairingApproval({ ...verifyOptions(), signedManifest }),
      safeFailure,
    );
  const refreshed = await signManifest(copy(admitted));
  assert.deepEqual(
    (await verifyPairingApproval({ ...verifyOptions(), signedManifest: refreshed })).checkpoint,
    trustedAdmitted.checkpoint,
  );
});

test('root-signed checkpoint substitutions and malformed request fingerprints are rejected', async () => {
  for (const change of [
    { accountId: 'another-owner' },
    { serverOrigin: 'https://another.example.test' },
    { rootKeyId: otherRoot.keyId },
    { epoch: 1 },
    { epoch: 3 },
    { digest: digest(33) },
    { digest: trustedGenesis.checkpoint.digest, epoch: 1 },
  ]) {
    const changed = payload();
    Object.assign(changed.acceptedCheckpoint, change);
    await assert.rejects(
      verifyPairingApproval({
        ...verifyOptions(),
        approval: await independentSign(JSON.stringify(changed)),
      }),
      safeFailure,
    );
  }
  await assert.rejects(
    verifyPairingApproval({
      ...verifyOptions(),
      approval: await independentSign(
        JSON.stringify({ ...payload(), requestFingerprint: digest(44) }),
      ),
    }),
    safeFailure,
  );
});

test('a valid root signature cannot approve a checkpoint missing the exact device or requested roles', async () => {
  for (const devices of [
    [copy(host)],
    [copy(host), { ...copy(otherDevice), deviceId: device.deviceId }],
    [copy(host), { ...copy(device), roles: ['client'] as ('client' | 'host')[] }],
  ]) {
    const signedManifest = await signManifest({ ...copy(admitted), devices });
    const trust = await verifyManifest(signedManifest, trustedGenesis.checkpoint);
    await assert.rejects(signPairingApproval({ ...signOptions(), trust }), safeFailure);
    const forged = { ...payload(), acceptedCheckpoint: copy(trust.checkpoint) };
    await assert.rejects(
      verifyPairingApproval({
        ...verifyOptions(),
        signedManifest,
        approval: await independentSign(JSON.stringify(forged)),
      }),
      safeFailure,
    );
  }
});

test('pairing uses only its exact canonical JWS protected header with no algorithm or key-routing flexibility', async () => {
  for (const header of [
    { alg: 'ES256', typ: 'moor-e2ee-trust+jws' },
    { typ: E2EE_PAIRING_TYPE, alg: 'ES256' },
    { alg: 'ES256', typ: E2EE_PAIRING_TYPE, kid: 'synthetic-secret' },
    { alg: 'ES256', typ: E2EE_PAIRING_TYPE, jwk: otherRoot.publicKey },
    { alg: 'ES256', typ: E2EE_PAIRING_TYPE, b64: true },
  ])
    await assert.rejects(
      verifyPairingApproval({
        ...verifyOptions(),
        approval: await independentSign(JSON.stringify(payload()), header),
      }),
      safeFailure,
    );
  const parts = approval.split('.');
  parts[0] = base64url.encode(JSON.stringify({ alg: 'none', typ: E2EE_PAIRING_TYPE }));
  await assert.rejects(
    verifyPairingApproval({ ...verifyOptions(), approval: parts.join('.') }),
    safeFailure,
  );
});

test('canonical signed payload validation rejects duplicate keys, unknown fields, alternate encodings and invalid UTF-8', async () => {
  const canonical = JSON.stringify(payload());
  const alternate: string[] = [
    ` ${canonical}`,
    JSON.stringify(payload(), null, 2),
    canonical.replace('"request":', '"request":null,"request":'),
    canonical.replace('"version":1,', '"version":1e0,'),
    canonical.replace('synthetic-owner', 'synthetic-\\u006fwner'),
    JSON.stringify({
      requestFingerprint,
      request: copy(request),
      acceptedCheckpoint: copy(trustedAdmitted.checkpoint),
    }),
    JSON.stringify({ ...payload(), rootPublicKey: root.publicKey }),
    JSON.stringify({ ...payload(), request: { ...request, password: 'synthetic-secret' } }),
    JSON.stringify({
      ...payload(),
      acceptedCheckpoint: { ...trustedAdmitted.checkpoint, secret: 'synthetic-secret' },
    }),
    '[]',
    'null',
  ];
  for (const json of alternate)
    await assert.rejects(
      verifyPairingApproval({ ...verifyOptions(), approval: await independentSign(json) }),
      safeFailure,
    );
  const invalidUtf8 = await new CompactSign(new Uint8Array([0xc0, 0xaf]))
    .setProtectedHeader({ alg: 'ES256', typ: E2EE_PAIRING_TYPE })
    .sign(root.privateKey);
  await assert.rejects(
    verifyPairingApproval({ ...verifyOptions(), approval: invalidUtf8 }),
    safeFailure,
  );
});

test('receipt truncation, signature or payload changes, padded base64 and oversized input fail closed', async () => {
  const parts = approval.split('.');
  const signature = base64url.decode(parts[2]);
  signature[0] ^= 1;
  const invalid = [
    '',
    'synthetic-secret',
    approval + '.',
    approval.slice(0, -1),
    'a'.repeat(E2EE_PAIRING_LIMITS.approvalCharacters + 1),
    [parts[0], parts[1], base64url.encode(signature)].join('.'),
    [
      parts[0],
      base64url.encode(JSON.stringify({ ...payload(), requestFingerprint: digest(88) })),
      parts[2],
    ].join('.'),
  ];
  for (let index = 0; index < 3; index++) {
    const padded = [...parts];
    padded[index] += '=';
    invalid.push(padded.join('.'));
  }
  for (const value of invalid)
    await assert.rejects(
      verifyPairingApproval({ ...verifyOptions(), approval: value }),
      safeFailure,
    );
});

test('approval verification enforces pending expiry and rejects an extended lifetime', async () => {
  for (const time of [now - 1, request.expiresAt, request.expiresAt + 1, now + 0.5, NaN])
    await assert.rejects(verifyPairingApproval({ ...verifyOptions(), now: time }), safeFailure);
  assert.deepEqual(
    (await verifyPairingApproval({ ...verifyOptions(), now: request.expiresAt - 1 })).checkpoint,
    trustedAdmitted.checkpoint,
  );
});

test('signing snapshots pending request, human fingerprint and root parameters before its first await', async () => {
  const options = signOptions();
  const pending = signPairingApproval(options);
  options.request.pairingId = digest(77);
  options.request.device.roles.length = 0;
  options.expectedFingerprint = digest(88);
  options.trust = trustedGenesis;
  options.rootPublicKey.x = otherRoot.publicKey.x;
  options.rootPrivateKey = otherRoot.privateKey;
  options.now = 0;
  assert.deepEqual(
    (await verifyPairingApproval({ ...verifyOptions(), approval: await pending })).checkpoint,
    trustedAdmitted.checkpoint,
  );
});

test('verification snapshots the complete pending request, pin, receipt and manifest before its first await', async () => {
  const options = verifyOptions();
  const pending = verifyPairingApproval(options);
  options.request.accountId = 'changed-owner';
  options.request.device.publicKey = otherDevice.publicKey;
  options.request.device.roles.length = 0;
  options.expectedRootPin.accountId = 'changed-owner';
  options.rootPublicKey.x = otherRoot.publicKey.x;
  options.approval = 'synthetic-secret';
  options.signedManifest = signedGenesis;
  options.now = 0;
  assert.deepEqual((await pending).checkpoint, trustedAdmitted.checkpoint);
});

test('portable verification is stateless; durable pending consumption remains the endpoint operation boundary', async () => {
  const [first, repeated] = await Promise.all([
    verifyPairingApproval(verifyOptions()),
    verifyPairingApproval(verifyOptions()),
  ]);
  assert.deepEqual(first.checkpoint, repeated.checkpoint);
  assert.deepEqual(first.checkpoint, trustedAdmitted.checkpoint);
});
