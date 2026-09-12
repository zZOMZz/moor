import test from 'node:test';
import assert from 'node:assert/strict';
import { base64url, CompactSign, compactVerify, exportJWK, generateKeyPair, importJWK } from 'jose';
import { E2EE_CRYPTO_FAILED, generateDeviceEncryptionKey } from '../src/security/e2ee-crypto';
import {
  encryptionKeyId,
  E2EE_TRUST_LIMITS,
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
  type RootPublicJwk,
  type TrustManifest,
  type TrustPin,
} from '../src/security/e2ee-trust';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const root = await generateTrustRoot();
const otherRoot = await generateTrustRoot();
const client = await generateDeviceEncryptionKey();
const host = await generateDeviceEncryptionKey();
const pin: TrustPin = {
  accountId: 'synthetic-owner',
  serverOrigin: 'https://relay.example.test',
  rootKeyId: root.keyId,
};
const first: TrustManifest = {
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
      roles: ['host', 'client'],
    },
  ],
};
const copy = <T>(value: T): T => structuredClone(value);
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, E2EE_CRYPTO_FAILED);
  assert.equal(error.cause, undefined);
  assert.ok(!String(error.stack).includes('synthetic-secret'));
  return true;
};
const sign = (manifest: TrustManifest) =>
  signTrustManifest({ manifest, rootPublicKey: root.publicKey, rootPrivateKey: root.privateKey });
const verify = (signed: string, previous?: VerifiedTrust['checkpoint']) =>
  VerifiedTrust.verify({ signed, rootPublicKey: root.publicKey, pin, previous });
const independentSign = (json: string, header = { alg: 'ES256', typ: 'moor-e2ee-trust+jws' }) =>
  new CompactSign(encoder.encode(json)).setProtectedHeader(header).sign(root.privateKey);
const signedFirst = await sign(first);
const trustedFirst = await verify(signedFirst);
const second: TrustManifest = {
  ...copy(first),
  epoch: 2,
  previous: trustedFirst.checkpoint.digest,
  devices: [copy(first.devices[1])],
};
const signedSecond = await sign(second);
const trustedSecond = await verify(signedSecond, trustedFirst.checkpoint);

test('trust root and device key IDs match independent standard hashes and valid ES256 verification', async () => {
  assert.deepEqual(Object.keys(root.publicKey).sort(), ['crv', 'kty', 'x', 'y']);
  assert.equal(root.publicKey.kty, 'EC');
  assert.equal(root.publicKey.crv, 'P-256');
  const canonicalJwk = JSON.stringify({
    crv: 'P-256',
    kty: 'EC',
    x: root.publicKey.x,
    y: root.publicKey.y,
  });
  assert.equal(
    root.keyId,
    base64url.encode(
      new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalJwk))),
    ),
  );
  assert.equal(
    first.devices[0].keyId,
    base64url.encode(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(base64url.decode(client.publicKey))),
      ),
    ),
  );
  const verified = await compactVerify(signedFirst, await importJWK(root.publicKey, 'ES256'), {
    algorithms: ['ES256'],
  });
  assert.deepEqual(verified.protectedHeader, { alg: 'ES256', typ: 'moor-e2ee-trust+jws' });
  assert.deepEqual(JSON.parse(decoder.decode(verified.payload)), first);
});

test('independently signed canonical manifests verify and expose only exact authorized roles', async () => {
  const trusted = await verify(await independentSign(JSON.stringify(first)));
  assert.deepEqual(trusted.manifest, first);
  assert.deepEqual(trusted.device('synthetic-client', 'client'), first.devices[0]);
  assert.deepEqual(trusted.device('synthetic-host', 'host'), first.devices[1]);
  assert.deepEqual(trusted.device('synthetic-host', 'client'), first.devices[1]);
  assert.throws(() => trusted.device('synthetic-client', 'host'), safeFailure);
  assert.throws(() => trusted.device('unknown-device', 'client'), safeFailure);
  assert.throws(() => trusted.device('synthetic-host', 'admin' as 'client'), safeFailure);
});

test('trust verification rejects wrong root, account, origin and root pin', async () => {
  await assert.rejects(
    VerifiedTrust.verify({ signed: signedFirst, rootPublicKey: otherRoot.publicKey, pin }),
    safeFailure,
  );
  for (const changed of [
    { ...pin, accountId: 'other-owner' },
    { ...pin, serverOrigin: 'https://another.example.test' },
    { ...pin, rootKeyId: otherRoot.keyId },
  ])
    await assert.rejects(
      VerifiedTrust.verify({ signed: signedFirst, rootPublicKey: root.publicKey, pin: changed }),
      safeFailure,
    );
  const wrongSigner = await new CompactSign(encoder.encode(JSON.stringify(first)))
    .setProtectedHeader({ alg: 'ES256', typ: 'moor-e2ee-trust+jws' })
    .sign(otherRoot.privateKey);
  await assert.rejects(verify(wrongSigner), safeFailure);
  await assert.rejects(
    signTrustManifest({
      manifest: first,
      rootPublicKey: root.publicKey,
      rootPrivateKey: otherRoot.privateKey,
    }),
    safeFailure,
  );
});

test('signed payload and signature tampering cannot authorize a device', async () => {
  const parts = signedFirst.split('.');
  const changedManifest = copy(first);
  changedManifest.devices[0].roles.push('host');
  await assert.rejects(
    verify([parts[0], base64url.encode(JSON.stringify(changedManifest)), parts[2]].join('.')),
    safeFailure,
  );
  const signature = base64url.decode(parts[2]);
  signature[0] ^= 1;
  await assert.rejects(
    verify([parts[0], parts[1], base64url.encode(signature)].join('.')),
    safeFailure,
  );
});

test('a verified next epoch revokes devices and pins the new checkpoint', async () => {
  assert.equal(trustedSecond.checkpoint.epoch, 2);
  assert.equal(trustedSecond.manifest.previous, trustedFirst.checkpoint.digest);
  assert.notEqual(trustedSecond.checkpoint.digest, trustedFirst.checkpoint.digest);
  assert.throws(() => trustedSecond.device('synthetic-client', 'client'), safeFailure);
  assert.deepEqual(trustedSecond.device('synthetic-host', 'host'), first.devices[1]);
  const third = {
    ...copy(second),
    epoch: 3,
    previous: trustedSecond.checkpoint.digest,
    devices: [],
  };
  const empty = await verify(await sign(third), trustedSecond.checkpoint);
  assert.equal(empty.manifest.devices.length, 0);
  assert.throws(() => empty.device('synthetic-host', 'host'), safeFailure);
});

test('rollback, skipped epochs, wrong predecessor and history-free epoch reset are rejected', async () => {
  await assert.rejects(verify(signedFirst, trustedSecond.checkpoint), safeFailure);
  await assert.rejects(verify(signedSecond), safeFailure);
  await assert.rejects(
    verify(await sign({ ...copy(second), epoch: 3 }), trustedFirst.checkpoint),
    safeFailure,
  );
  await assert.rejects(
    verify(await sign({ ...copy(second), previous: otherRoot.keyId }), trustedFirst.checkpoint),
    safeFailure,
  );
  for (const change of [
    { accountId: 'other-owner' },
    { serverOrigin: 'https://other.example.test' },
    { rootKeyId: otherRoot.keyId },
  ])
    await assert.rejects(
      verify(signedSecond, { ...trustedFirst.checkpoint, ...change }),
      safeFailure,
    );
});

test('same-epoch refresh accepts a fresh signature of identical state but rejects a fork', async () => {
  const refreshed = await verify(
    await independentSign(JSON.stringify(first)),
    trustedFirst.checkpoint,
  );
  assert.deepEqual(refreshed.checkpoint, trustedFirst.checkpoint);
  const fork = { ...copy(first), devices: [copy(first.devices[1])] };
  await assert.rejects(
    verify(await independentSign(JSON.stringify(fork)), trustedFirst.checkpoint),
    safeFailure,
  );
  const nextFork = { ...copy(second), devices: [] };
  await assert.rejects(verify(await sign(nextFork), trustedSecond.checkpoint), safeFailure);
});

test('verified state, devices, role arrays and checkpoints are deeply immutable', async () => {
  const trusted = await verify(signedFirst);
  assert.ok(Object.isFrozen(trusted));
  assert.ok(Object.isFrozen(trusted.manifest));
  assert.ok(Object.isFrozen(trusted.manifest.devices));
  assert.ok(Object.isFrozen(trusted.manifest.devices[0]));
  assert.ok(Object.isFrozen(trusted.manifest.devices[0].roles));
  assert.ok(Object.isFrozen(trusted.checkpoint));
  assert.throws(() => (trusted.manifest as TrustManifest).devices.splice(0, 1), TypeError);
  assert.throws(() => trusted.manifest.devices[0].roles.push('host'), TypeError);
  assert.throws(() => Object.assign(trusted.checkpoint, { epoch: 5 }), TypeError);
  assert.deepEqual(trusted.device('synthetic-client', 'client'), first.devices[0]);
});

test('signing snapshots all mutable input fields before its first await', async () => {
  const options = {
    manifest: copy(first),
    rootPublicKey: copy(root.publicKey),
    rootPrivateKey: root.privateKey,
  };
  const pending = signTrustManifest(options);
  options.manifest.accountId = 'substituted-owner';
  options.manifest.devices[0].roles.push('host');
  options.manifest.devices.length = 0;
  options.rootPublicKey.x = otherRoot.publicKey.x;
  options.rootPrivateKey = otherRoot.privateKey;
  assert.deepEqual((await verify(await pending)).manifest, first);
});

test('verification snapshots pin, root, signed bytes and previous checkpoint before its first await', async () => {
  const options = {
    signed: signedSecond,
    rootPublicKey: copy(root.publicKey),
    pin: copy(pin),
    previous: copy(trustedFirst.checkpoint),
  };
  const pending = VerifiedTrust.verify(options);
  options.signed = signedFirst;
  options.rootPublicKey.x = otherRoot.publicKey.x;
  options.pin.accountId = 'other-owner';
  Object.assign(options.previous, { digest: otherRoot.keyId });
  assert.deepEqual((await pending).manifest, second);
});

test('signed device key IDs, point validity and exact role sets are enforced', async () => {
  const offcurve = base64url.encode(new Uint8Array([4, ...new Uint8Array(64)]));
  const values: unknown[] = [
    { ...first.devices[0], keyId: first.devices[1].keyId },
    { ...first.devices[0], publicKey: offcurve },
    { ...first.devices[0], publicKey: base64url.encode(new Uint8Array(65)) },
    { ...first.devices[0], publicKey: `${client.publicKey}=` },
    { ...first.devices[0], roles: [] },
    { ...first.devices[0], roles: ['client', 'client'] },
    { ...first.devices[0], roles: ['admin'] },
    { ...first.devices[0], roles: ['host', 'client', 'host'] },
    { ...first.devices[0], deviceId: 'unsafe/device' },
    { ...first.devices[0], deviceId: 'd'.repeat(161) },
    { ...first.devices[0], privateKey: 'synthetic-secret' },
  ];
  for (const device of values) {
    const manifest = { ...copy(first), devices: [device] };
    await assert.rejects(verify(await independentSign(JSON.stringify(manifest))), safeFailure);
    await assert.rejects(sign(manifest as TrustManifest), safeFailure);
  }
  await assert.rejects(encryptionKeyId(offcurve), safeFailure);
  await assert.rejects(encryptionKeyId('synthetic-secret'), safeFailure);
});

test('duplicate device IDs, encryption key IDs and public keys are rejected', async () => {
  for (const field of ['deviceId', 'keyId', 'publicKey'] as const) {
    const manifest = copy(first);
    manifest.devices[1][field] = manifest.devices[0][field];
    await assert.rejects(verify(await independentSign(JSON.stringify(manifest))), safeFailure);
    await assert.rejects(sign(manifest), safeFailure);
  }
});

test('64 distinct valid devices fit the manifest limit but a 65th is rejected', async () => {
  const devices = await Promise.all(
    Array.from({ length: E2EE_TRUST_LIMITS.devices + 1 }, async (_, index) => {
      const key = await generateDeviceEncryptionKey();
      return {
        deviceId: `synthetic-device-${index}`,
        keyId: await encryptionKeyId(key.publicKey),
        publicKey: key.publicKey,
        roles: ['client'] as const,
      };
    }),
  );
  const valid: TrustManifest = {
    ...copy(first),
    devices: devices
      .slice(0, E2EE_TRUST_LIMITS.devices)
      .map((device) => ({ ...device, roles: [...device.roles] })),
  };
  assert.equal((await verify(await sign(valid))).manifest.devices.length, 64);
  const invalid: TrustManifest = {
    ...copy(first),
    devices: devices.map((device) => ({ ...device, roles: [...device.roles] })),
  };
  await assert.rejects(sign(invalid), safeFailure);
  await assert.rejects(verify(await independentSign(JSON.stringify(invalid))), safeFailure);
});

test('manifest version, epoch consistency, origin and size have strict bounds', async () => {
  const changes: Record<string, unknown>[] = [
    { version: 0 },
    { version: 2 },
    { epoch: 0 },
    { epoch: 1.5 },
    { epoch: Number.MAX_SAFE_INTEGER + 1 },
    { epoch: 1, previous: root.keyId },
    { epoch: 2, previous: null },
    { serverOrigin: 'http://relay.example.test' },
    { serverOrigin: 'https://relay.example.test/' },
    { serverOrigin: 'https://user:synthetic-secret@relay.example.test' },
    { serverOrigin: 'https://relay.example.test?query=1' },
    { devices: Array.from({ length: E2EE_TRUST_LIMITS.devices + 1 }, () => first.devices[0]) },
    { privateKey: 'synthetic-secret' },
  ];
  for (const change of changes) {
    const manifest = { ...copy(first), ...change };
    await assert.rejects(verify(await independentSign(JSON.stringify(manifest))), safeFailure);
    await assert.rejects(sign(manifest as TrustManifest), safeFailure);
  }
  await assert.rejects(verify('A'.repeat(E2EE_TRUST_LIMITS.signedCharacters + 1)), safeFailure);
  await assert.rejects(verify(''), safeFailure);
});

test('valid loopback origins are separately pinned', async () => {
  for (const serverOrigin of ['http://127.0.0.1:8833', 'http://[::1]:8833']) {
    const manifest = { ...copy(first), serverOrigin };
    const trusted = await VerifiedTrust.verify({
      signed: await sign(manifest),
      rootPublicKey: root.publicKey,
      pin: { ...pin, serverOrigin },
    });
    assert.equal(trusted.manifest.serverOrigin, serverOrigin);
    await assert.rejects(verify(await sign(manifest)), safeFailure);
  }
});

test('payload JSON rejects duplicate keys, alternate ordering, escapes and numeric encodings', async () => {
  const json = JSON.stringify(first);
  for (const value of [
    ` ${json}`,
    `${json}\n`,
    json.replace('"version":1', '"version":1.0'),
    json.replace('"epoch":1', '"epoch":1e0'),
    json.replace('"version":1', '"version":0,"version":1'),
    json.replace(
      '"accountId":"synthetic-owner"',
      '"accountId":"other-owner","accountId":"synthetic-owner"',
    ),
    json.replace('synthetic-owner', '\\u0073ynthetic-owner'),
    JSON.stringify(Object.assign({ devices: first.devices }, first)),
    `${json.slice(0, -1)},"unknown":true}`,
    'null',
    '[]',
    '{"synthetic-secret":',
  ])
    await assert.rejects(verify(await independentSign(value)), safeFailure);
});

test('wrong JWS algorithms, types and extra protected fields fail safely', async () => {
  for (const header of [
    { alg: 'ES256', typ: 'JWT' },
    { alg: 'ES256' },
    { alg: 'ES256', typ: 'moor-e2ee-trust+jws', kid: root.keyId },
    { alg: 'ES256', typ: 'moor-e2ee-trust+jws', jwk: root.publicKey },
  ])
    await assert.rejects(
      verify(
        await new CompactSign(encoder.encode(JSON.stringify(first)))
          .setProtectedHeader(header)
          .sign(root.privateKey),
      ),
      safeFailure,
    );
  const wrongAlgorithm = await generateKeyPair('ES384');
  await assert.rejects(
    verify(
      await new CompactSign(encoder.encode(JSON.stringify(first)))
        .setProtectedHeader({ alg: 'ES384', typ: 'moor-e2ee-trust+jws' })
        .sign(wrongAlgorithm.privateKey),
    ),
    safeFailure,
  );
  await assert.rejects(
    verify(
      `${base64url.encode('{"alg":"none","typ":"moor-e2ee-trust+jws"}')}.${base64url.encode(JSON.stringify(first))}.`,
    ),
    safeFailure,
  );
});

test('protected JSON rejects duplicate keys and noncanonical encodings despite a valid signature', async () => {
  for (const header of [
    '{"alg":"none","alg":"ES256","typ":"moor-e2ee-trust+jws"}',
    '{"alg":"ES256","typ":"other","typ":"moor-e2ee-trust+jws"}',
    '{ "alg":"ES256","typ":"moor-e2ee-trust+jws"}',
    '{"typ":"moor-e2ee-trust+jws","alg":"ES256"}',
  ]) {
    const input = `${base64url.encode(header)}.${base64url.encode(JSON.stringify(first))}`;
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      root.privateKey,
      encoder.encode(input),
    );
    const signed = `${input}.${base64url.encode(new Uint8Array(signature))}`;
    await compactVerify(signed, await importJWK(root.publicKey, 'ES256'));
    await assert.rejects(verify(signed), safeFailure);
  }
});

test('private root key material is never included in signed manifests or public roots', async () => {
  const privateJwk = await exportJWK(root.privateKey);
  const payload = decoder.decode(base64url.decode(signedFirst.split('.')[1]));
  const header = decoder.decode(base64url.decode(signedFirst.split('.')[0]));
  for (const value of [
    payload,
    header,
    JSON.stringify(root.publicKey),
    JSON.stringify(trustedFirst.checkpoint),
  ]) {
    assert.ok(!value.includes(privateJwk.d!));
    assert.ok(!value.includes('privateKey'));
  }
  await assert.rejects(
    VerifiedTrust.verify({ signed: signedFirst, rootPublicKey: privateJwk as RootPublicJwk, pin }),
    safeFailure,
  );
  await assert.rejects(
    VerifiedTrust.verify({
      signed: signedFirst,
      rootPublicKey: {
        ...root.publicKey,
        x: base64url.encode(new Uint8Array(32)),
        y: base64url.encode(new Uint8Array(32)),
      },
      pin,
    }),
    safeFailure,
  );
});

test('malformed inputs and exceptional accessors never leak diagnostics', async () => {
  await assert.rejects(VerifiedTrust.verify(null as never), safeFailure);
  await assert.rejects(signTrustManifest(null as never), safeFailure);
  await assert.rejects(
    VerifiedTrust.verify({
      signed: signedFirst,
      rootPublicKey: root.publicKey,
      get pin(): TrustPin {
        throw new Error('synthetic-secret');
      },
    }),
    safeFailure,
  );
  await assert.rejects(
    signTrustManifest({
      manifest: first,
      rootPublicKey: root.publicKey,
      get rootPrivateKey(): CryptoKey {
        throw new Error('synthetic-secret');
      },
    }),
    safeFailure,
  );
});
