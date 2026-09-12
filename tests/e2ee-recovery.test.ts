import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64url,
  compactDecrypt,
  CompactEncrypt,
  compactVerify,
  CompactSign,
  exportJWK,
  generateKeyPair,
  importJWK,
} from 'jose';
import { E2EE_CRYPTO_FAILED, generateDeviceEncryptionKey } from '../src/security/e2ee-crypto';
import {
  encryptionKeyId,
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
  type TrustManifest,
} from '../src/security/e2ee-trust';
import {
  decryptRecovery,
  E2EE_RECOVERY_MAX_BYTES,
  E2EE_RECOVERY_VERSION,
  encryptRecovery,
  exportRootPrivateJwk,
  generateRecoveryKey,
  importRootPrivateJwk,
  type RecoveryPayload,
} from '../src/security/e2ee-recovery';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const root = await generateTrustRoot();
const otherRoot = await generateTrustRoot();
const device = await generateDeviceEncryptionKey();
const pin = {
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
      deviceId: 'synthetic-host',
      keyId: await encryptionKeyId(device.publicKey),
      publicKey: device.publicKey,
      roles: ['host'],
    },
  ],
};
const signedManifest = await signTrustManifest({
  manifest,
  rootPublicKey: root.publicKey,
  rootPrivateKey: root.privateKey,
});
const trust = await VerifiedTrust.verify({
  signed: signedManifest,
  rootPublicKey: root.publicKey,
  pin,
});
const payload: RecoveryPayload = {
  version: 1,
  pin,
  rootPublicKey: root.publicKey,
  rootPrivateKey: await exportRootPrivateJwk(root.privateKey),
  checkpoint: { ...trust.checkpoint },
  signedManifest,
};
const recoveryKey = generateRecoveryKey();
const capsule = await encryptRecovery({ payload, recoveryKey });
const header = { alg: 'dir', enc: 'A256GCM', typ: 'moor-e2ee-recovery+jwe' };
const bytes = (value: string) => new Uint8Array(base64url.decode(value));
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, E2EE_CRYPTO_FAILED);
  assert.equal(error.cause, undefined);
  for (const secret of ['synthetic-secret', recoveryKey, payload.rootPrivateKey.d])
    assert.ok(!String(error.stack).includes(secret));
  return true;
};
const copy = <T>(value: T): T => structuredClone(value);
// Independent JOSE contexts validate the public wire format rather than only Moor round trips.
// https://github.com/panva/jose/blob/main/docs/jwe/compact/encrypt/classes/CompactEncrypt.md
const independentEncrypt = (
  value: string | Uint8Array,
  protectedHeader = header,
  key = recoveryKey,
) =>
  new CompactEncrypt(typeof value === 'string' ? encoder.encode(value) : value)
    .setProtectedHeader(protectedHeader)
    .encrypt(bytes(key));
const encrypt = (value: RecoveryPayload) => encryptRecovery({ payload: value, recoveryKey });
const decrypt = (value: string) => decryptRecovery({ capsule: value, recoveryKey });

test('recovery uses a fixed compact JWE wire shape with fresh random 256-bit keys', async () => {
  assert.equal(E2EE_RECOVERY_VERSION, 1);
  assert.equal(E2EE_RECOVERY_MAX_BYTES, 128 * 1024);
  const keys = Array.from({ length: 8 }, () => generateRecoveryKey());
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) {
    assert.equal(key.length, 43);
    assert.equal(bytes(key).length, 32);
    assert.equal(base64url.encode(bytes(key)), key);
  }
  const parts = capsule.split('.');
  assert.equal(parts.length, 5);
  assert.equal(parts[0], base64url.encode(JSON.stringify(header)));
  assert.equal(parts[1], '');
  assert.equal(bytes(parts[2]).length, 12);
  assert.equal(bytes(parts[4]).length, 16);
  assert.ok(Buffer.byteLength(capsule) <= E2EE_RECOVERY_MAX_BYTES);
});

test('independent jose decrypts Moor capsules with exactly the root-only payload', async () => {
  const result = await compactDecrypt(capsule, bytes(recoveryKey), {
    keyManagementAlgorithms: ['dir'],
    contentEncryptionAlgorithms: ['A256GCM'],
  });
  assert.deepEqual(result.protectedHeader, header);
  assert.equal(decoder.decode(result.plaintext), JSON.stringify(payload));
  assert.deepEqual(JSON.parse(decoder.decode(result.plaintext)), payload);
});

test('Moor decrypts an independent jose capsule and deeply freezes the validated result', async () => {
  const restored = await decrypt(await independentEncrypt(JSON.stringify(payload)));
  assert.deepEqual(restored, payload);
  for (const object of [
    restored,
    restored.pin,
    restored.rootPublicKey,
    restored.rootPrivateKey,
    restored.checkpoint,
  ])
    assert.ok(Object.isFrozen(object));
  assert.throws(() => Object.assign(restored.pin, { accountId: 'another-owner' }), TypeError);
  assert.throws(() => Object.assign(restored.rootPrivateKey, { d: 'synthetic-secret' }), TypeError);
});

test('each encryption uses a fresh IV even for the same recovery key and payload', async () => {
  const outputs = await Promise.all(Array.from({ length: 8 }, () => encrypt(payload)));
  assert.equal(new Set(outputs).size, outputs.length);
  assert.equal(new Set(outputs.map((value) => value.split('.')[2])).size, outputs.length);
  for (const output of outputs) assert.deepEqual(await decrypt(output), payload);
});

test('capsule text exposes no private root, recovery key, account identity or signed manifest', () => {
  for (const value of [
    payload.rootPrivateKey.d,
    recoveryKey,
    pin.accountId,
    pin.serverOrigin,
    signedManifest,
    JSON.stringify(payload.rootPrivateKey),
  ])
    assert.ok(!capsule.includes(value));
  assert.deepEqual(Object.keys(payload).sort(), [
    'checkpoint',
    'pin',
    'rootPrivateKey',
    'rootPublicKey',
    'signedManifest',
    'version',
  ]);
});

test('root JWK import/export preserves an actual ES256 signing key', async () => {
  const jwk = await exportRootPrivateJwk(root.privateKey);
  assert.ok(Object.isFrozen(jwk));
  assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'd', 'kty', 'x', 'y']);
  const imported = await importRootPrivateJwk(copy(jwk));
  assert.equal(imported.algorithm.name, 'ECDSA');
  assert.equal((imported.algorithm as EcKeyAlgorithm).namedCurve, 'P-256');
  assert.deepEqual(imported.usages, ['sign']);
  assert.equal(imported.extractable, true);
  const signed = await new CompactSign(encoder.encode('synthetic independent ES256 proof'))
    .setProtectedHeader({ alg: 'ES256' })
    .sign(imported);
  const verified = await compactVerify(signed, await importJWK(root.publicKey, 'ES256'), {
    algorithms: ['ES256'],
  });
  assert.equal(decoder.decode(verified.payload), 'synthetic independent ES256 proof');
  assert.deepEqual(await exportRootPrivateJwk(imported), jwk);
});

test('restored root can authorize a new trust epoch without recovering device private keys', async () => {
  const restored = await decrypt(capsule);
  const privateKey = await importRootPrivateJwk(restored.rootPrivateKey);
  const next = { ...manifest, epoch: 2, previous: restored.checkpoint.digest, devices: [] };
  const signed = await signTrustManifest({
    manifest: next,
    rootPublicKey: restored.rootPublicKey,
    rootPrivateKey: privateKey,
  });
  const verified = await VerifiedTrust.verify({
    signed,
    rootPublicKey: restored.rootPublicKey,
    pin: restored.pin,
    previous: restored.checkpoint,
  });
  assert.equal(verified.checkpoint.epoch, 2);
  assert.equal(verified.manifest.devices.length, 0);
});

test('an existing later-epoch checkpoint is preserved exactly', async () => {
  const next = { ...manifest, epoch: 2, previous: trust.checkpoint.digest, devices: [] };
  const signed = await signTrustManifest({
    manifest: next,
    rootPublicKey: root.publicKey,
    rootPrivateKey: root.privateKey,
  });
  const verified = await VerifiedTrust.verify({
    signed,
    rootPublicKey: root.publicKey,
    pin,
    previous: trust.checkpoint,
  });
  const later: RecoveryPayload = {
    ...copy(payload),
    checkpoint: { ...verified.checkpoint },
    signedManifest: signed,
  };
  assert.deepEqual(await decrypt(await encrypt(later)), later);
});

test('encryption snapshots payload and recovery key before asynchronous verification', async () => {
  const options = { payload: copy(payload), recoveryKey };
  const pending = encryptRecovery(options);
  options.recoveryKey = generateRecoveryKey();
  options.payload.pin.accountId = 'another-owner';
  options.payload.rootPublicKey.x = otherRoot.publicKey.x;
  options.payload.rootPrivateKey.d = 'synthetic-secret';
  options.payload.checkpoint.epoch = 5;
  options.payload.signedManifest = 'synthetic-secret';
  assert.deepEqual(await decrypt(await pending), payload);
});

test('decryption and root import snapshot caller-owned arguments across awaits', async () => {
  const options = { capsule, recoveryKey };
  const pending = decryptRecovery(options);
  options.capsule = 'synthetic-secret';
  options.recoveryKey = generateRecoveryKey();
  assert.deepEqual(await pending, payload);
  const jwk = copy(payload.rootPrivateKey);
  const importing = importRootPrivateJwk(jwk);
  jwk.x = otherRoot.publicKey.x;
  jwk.d = 'synthetic-secret';
  assert.deepEqual(await exportRootPrivateJwk(await importing), payload.rootPrivateKey);
});

test('wrong recovery keys and any ciphertext, IV or tag tampering fail safely', async () => {
  await assert.rejects(
    decryptRecovery({ capsule, recoveryKey: generateRecoveryKey() }),
    safeFailure,
  );
  for (const index of [2, 3, 4]) {
    const parts = capsule.split('.');
    const changed = bytes(parts[index]);
    changed[0] ^= 1;
    parts[index] = base64url.encode(changed);
    await assert.rejects(decrypt(parts.join('.')), safeFailure);
  }
});

test('keys reject padding, nonzero pad bits, wrong lengths and nonstring values before use', async () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const noncanonical =
    recoveryKey.slice(0, -1) + alphabet[alphabet.indexOf(recoveryKey.at(-1)!) | 1];
  for (const key of [
    '',
    recoveryKey + '=',
    recoveryKey + '\n',
    noncanonical,
    recoveryKey.slice(1),
    'A'.repeat(44),
    'A'.repeat(E2EE_RECOVERY_MAX_BYTES + 1),
    null,
  ]) {
    await assert.rejects(encryptRecovery({ payload, recoveryKey: key as string }), safeFailure);
    await assert.rejects(decryptRecovery({ capsule, recoveryKey: key as string }), safeFailure);
  }
});

test('private JWK rejects a mismatched public point, scalar, algorithm or extra field', async () => {
  const other = await exportRootPrivateJwk(otherRoot.privateKey);
  const jwk = payload.rootPrivateKey;
  for (const value of [
    { ...jwk, x: other.x, y: other.y },
    { ...jwk, d: other.d },
    { ...jwk, d: base64url.encode(new Uint8Array(32)) },
    { ...jwk, x: base64url.encode(new Uint8Array(32)), y: base64url.encode(new Uint8Array(32)) },
    { ...jwk, kty: 'RSA' },
    { ...jwk, crv: 'P-384' },
    { ...jwk, d: undefined },
    { ...jwk, x: jwk.x + '=' },
    { ...jwk, d: 'A'.repeat(E2EE_RECOVERY_MAX_BYTES + 1) },
    { ...jwk, key_ops: ['sign'] },
    { ...jwk, ext: true },
    { ...jwk, alg: 'ES256' },
    { ...jwk, cookie: 'synthetic-secret' },
    { ...jwk, [Symbol('secret')]: true },
    Object.assign(Object.create({ inherited: true }), jwk),
    null,
    [],
  ])
    await assert.rejects(importRootPrivateJwk(value), safeFailure);
});

test('ECDH, public, nonextractable and wrong-curve keys cannot be exported as recovery roots', async () => {
  const publicKey = await importJWK(root.publicKey, 'ES256');
  const wrongCurve = await generateKeyPair('ES384', { extractable: true });
  const nonextractable = await generateKeyPair('ES256');
  for (const key of [
    device.privateKey,
    publicKey,
    wrongCurve.privateKey,
    nonextractable.privateKey,
    {},
  ]) {
    await assert.rejects(exportRootPrivateJwk(key as CryptoKey), safeFailure);
  }
});

test('both export and import reject mismatched roots, pins, signed state and checkpoints', async () => {
  const otherPrivate = await exportRootPrivateJwk(otherRoot.privateKey);
  const next = { ...manifest, epoch: 2, previous: trust.checkpoint.digest };
  const signedNext = await signTrustManifest({
    manifest: next,
    rootPublicKey: root.publicKey,
    rootPrivateKey: root.privateKey,
  });
  const cases = [
    { ...copy(payload), rootPrivateKey: otherPrivate },
    { ...copy(payload), rootPublicKey: otherRoot.publicKey },
    { ...copy(payload), rootPublicKey: otherRoot.publicKey, rootPrivateKey: otherPrivate },
    { ...copy(payload), pin: { ...pin, rootKeyId: otherRoot.keyId } },
    { ...copy(payload), pin: { ...pin, accountId: 'another-owner' } },
    { ...copy(payload), pin: { ...pin, serverOrigin: 'https://other.example.test' } },
    { ...copy(payload), checkpoint: { ...payload.checkpoint, epoch: 2 } },
    { ...copy(payload), checkpoint: { ...payload.checkpoint, digest: otherRoot.keyId } },
    { ...copy(payload), checkpoint: { ...payload.checkpoint, rootKeyId: otherRoot.keyId } },
    { ...copy(payload), signedManifest: 'synthetic-secret' },
    // VerifiedTrust.verify alone accepts this next epoch; the capsule must not mislabel it as epoch 1.
    { ...copy(payload), signedManifest: signedNext },
  ];
  for (const value of cases) {
    await assert.rejects(encrypt(value), safeFailure);
    await assert.rejects(decrypt(await independentEncrypt(JSON.stringify(value))), safeFailure);
  }
});

test('extra device secrets, cookies, history and unknown payload fields are rejected in both directions', async () => {
  for (const name of ['devicePrivateKeys', 'cookie', 'history', 'unknown']) {
    const value = { ...copy(payload), [name]: 'synthetic-secret' };
    await assert.rejects(encrypt(value), safeFailure);
    await assert.rejects(decrypt(await independentEncrypt(JSON.stringify(value))), safeFailure);
  }
  for (const value of [
    { ...copy(payload), version: 2 },
    {
      ...copy(payload),
      rootPrivateKey: { ...payload.rootPrivateKey, deviceKey: 'synthetic-secret' },
    },
  ]) {
    await assert.rejects(encrypt(value as RecoveryPayload), safeFailure);
    await assert.rejects(decrypt(await independentEncrypt(JSON.stringify(value))), safeFailure);
  }
});

test('payload JSON rejects duplicate keys, noncanonical representations and invalid UTF-8', async () => {
  const json = JSON.stringify(payload);
  for (const value of [
    ` ${json}`,
    `${json}\n`,
    json.replace('"version":1', '"version":1.0'),
    json.replace('"version":1', '"version":2,"version":1'),
    json.replace('synthetic-owner', '\\u0073ynthetic-owner'),
    JSON.stringify(Object.assign({ signedManifest }, payload)),
    'null',
    '[]',
    '{"synthetic-secret":',
  ])
    await assert.rejects(decrypt(await independentEncrypt(value)), safeFailure);
  await assert.rejects(
    decrypt(await independentEncrypt(new Uint8Array([0xff, 0xfe, 0x00]))),
    safeFailure,
  );
});

test('valid encryption with a different JOSE algorithm, type or extra protected field is rejected', async () => {
  for (const value of [
    { alg: 'dir', enc: 'A256GCM', typ: 'JWT' },
    { alg: 'dir', enc: 'A256GCM' },
    { alg: 'dir', enc: 'A256GCM', typ: header.typ, kid: 'synthetic-secret' },
    { typ: header.typ, enc: 'A256GCM', alg: 'dir' },
  ]) {
    const wrapped = await new CompactEncrypt(encoder.encode(JSON.stringify(payload)))
      .setProtectedHeader(value)
      .encrypt(bytes(recoveryKey));
    assert.equal(
      decoder.decode((await compactDecrypt(wrapped, bytes(recoveryKey))).plaintext),
      JSON.stringify(payload),
    );
    await assert.rejects(decrypt(wrapped), safeFailure);
  }
  const aes128 = await new CompactEncrypt(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ ...header, enc: 'A128GCM' })
    .encrypt(bytes(recoveryKey).subarray(0, 16));
  await assert.rejects(decrypt(aes128), safeFailure);
  const wrappedKey = await new CompactEncrypt(encoder.encode(JSON.stringify(payload)))
    .setProtectedHeader({ ...header, alg: 'A256KW' })
    .encrypt(bytes(recoveryKey));
  await assert.rejects(decrypt(wrappedKey), safeFailure);
});

test('duplicate or noncanonical protected JSON is rejected even with an independently valid GCM tag', async () => {
  // JWE compact AAD is the ASCII protected-header segment (RFC 7516, section 5.1).
  for (const json of [
    '{"alg":"invalid","alg":"dir","enc":"A256GCM","typ":"moor-e2ee-recovery+jwe"}',
    '{ "alg":"dir","enc":"A256GCM","typ":"moor-e2ee-recovery+jwe"}',
  ]) {
    const protectedPart = base64url.encode(json);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey(
      'raw',
      bytes(recoveryKey),
      { name: 'AES-GCM' },
      false,
      ['encrypt'],
    );
    const result = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(protectedPart), tagLength: 128 },
        key,
        encoder.encode(JSON.stringify(payload)),
      ),
    );
    const wrapped = [
      protectedPart,
      '',
      base64url.encode(iv),
      base64url.encode(result.subarray(0, -16)),
      base64url.encode(result.subarray(-16)),
    ].join('.');
    assert.equal(
      decoder.decode((await compactDecrypt(wrapped, bytes(recoveryKey))).plaintext),
      JSON.stringify(payload),
    );
    await assert.rejects(decrypt(wrapped), safeFailure);
  }
});

test('compact segments reject padding, bad lengths, extra segments and noncanonical tag bits', async () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const parts = capsule.split('.');
  const alteredTag = parts[4].slice(0, -1) + alphabet[alphabet.indexOf(parts[4].at(-1)!) | 1];
  const values = [
    capsule + '.',
    capsule + '\n',
    '.' + capsule,
    capsule.replace('..', '.AA.'),
    'synthetic-secret',
  ];
  for (const index of [0, 2, 3, 4]) {
    const padded = [...parts];
    padded[index] += '=';
    values.push(padded.join('.'));
  }
  values.push([parts[0], '', parts[2], parts[3], alteredTag].join('.'));
  values.push([parts[0], '', 'AA', parts[3], parts[4]].join('.'));
  values.push([parts[0], '', parts[2], parts[3], 'AA'].join('.'));
  for (const value of values) await assert.rejects(decrypt(value), safeFailure);
});

test('capsules and manifest fields have hard size bounds without truncation', async () => {
  await assert.rejects(decrypt('A'.repeat(E2EE_RECOVERY_MAX_BYTES + 1)), safeFailure);
  const huge = { ...copy(payload), signedManifest: 'A'.repeat(E2EE_RECOVERY_MAX_BYTES + 1) };
  await assert.rejects(encrypt(huge), safeFailure);
  const tooLarge = await independentEncrypt('A'.repeat(E2EE_RECOVERY_MAX_BYTES));
  assert.ok(tooLarge.length > E2EE_RECOVERY_MAX_BYTES);
  await assert.rejects(decrypt(tooLarge), safeFailure);
  for (const key of ['rootPublicKey', 'rootPrivateKey'] as const) {
    const value = copy(payload);
    value[key].x = 'A'.repeat(E2EE_RECOVERY_MAX_BYTES + 1);
    await assert.rejects(encrypt(value), safeFailure);
  }
});

test('missing fields, exceptional accessors and unsupported object prototypes fail without diagnostics', async () => {
  await assert.rejects(encryptRecovery(null as never), safeFailure);
  await assert.rejects(decryptRecovery(null as never), safeFailure);
  await assert.rejects(encrypt({ ...copy(payload), checkpoint: undefined } as never), safeFailure);
  await assert.rejects(
    importRootPrivateJwk({
      ...payload.rootPrivateKey,
      get d() {
        throw new Error('synthetic-secret');
      },
    }),
    safeFailure,
  );
  await assert.rejects(
    encryptRecovery({
      payload,
      get recoveryKey(): string {
        throw new Error('synthetic-secret');
      },
    }),
    safeFailure,
  );
  await assert.rejects(
    decryptRecovery({
      recoveryKey,
      get capsule(): string {
        throw new Error('synthetic-secret');
      },
    }),
    safeFailure,
  );
  await assert.rejects(
    encrypt(Object.assign(Object.create({ inherited: true }), payload)),
    safeFailure,
  );
});

test('private key helpers accept private JSON storage and produce no extra JWK metadata', async () => {
  const stored = JSON.parse(JSON.stringify(await exportRootPrivateJwk(root.privateKey)));
  const imported = await importRootPrivateJwk(stored);
  const exported = await exportRootPrivateJwk(imported);
  assert.deepEqual(exported, payload.rootPrivateKey);
  assert.equal(Object.hasOwn(exported, 'key_ops'), false);
  assert.equal(Object.hasOwn(exported, 'ext'), false);
  assert.equal(Object.hasOwn(exported, 'alg'), false);
  const publicOnly = await exportJWK(await importJWK(root.publicKey, 'ES256'));
  await assert.rejects(importRootPrivateJwk(publicOnly), safeFailure);
});
