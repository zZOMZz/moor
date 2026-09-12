import test from 'node:test';
import assert from 'node:assert/strict';
import { Aes128Gcm, Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import {
  devicePublicKey,
  E2EE_CRYPTO_FAILED,
  E2EE_CRYPTO_INFO,
  E2EE_CRYPTO_LIMITS,
  E2EE_CRYPTO_SUITE,
  E2EE_CRYPTO_VERSION,
  exportDevicePrivateJwk,
  generateDeviceEncryptionKey,
  importDevicePrivateJwk,
  open,
  seal,
  type OpenOptions,
  type SealOptions,
} from '../src/security/e2ee-crypto';

const encoder = new TextEncoder();
const aad = encoder.encode(
  JSON.stringify({
    version: 1,
    owner: 'synthetic-owner',
    client: 'synthetic-client',
    host: 'synthetic-host',
    workspace: 'synthetic-workspace',
    project: 'synthetic-project',
    session: 'synthetic-session',
    operation: 'synthetic-operation',
    epoch: 1,
    direction: 'request',
    sequence: 1,
  }),
);
const plaintext = encoder.encode('synthetic private message\u0000二进制附件');
const sender = await generateDeviceEncryptionKey();
const recipient = await generateDeviceEncryptionKey();
const stranger = await generateDeviceEncryptionKey();
const defaultSeal: SealOptions = {
  senderPrivateKey: sender.privateKey,
  recipientPublicKey: recipient.publicKey,
  plaintext,
  aad,
};
const message = await seal(defaultSeal);
const defaultOpen: OpenOptions = {
  senderPublicKey: sender.publicKey,
  recipientPrivateKey: recipient.privateKey,
  ...message,
  aad,
};
const binary = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));
const base64 = (value: ArrayBuffer | Uint8Array) =>
  Buffer.from(new Uint8Array(value)).toString('base64url');
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, E2EE_CRYPTO_FAILED);
  assert.equal(error.cause, undefined);
  assert.ok(!String(error.stack).includes('synthetic-secret'));
  return true;
};

// Independent library contexts, with its documented public API and explicit Auth arguments:
// https://github.com/dajiaji/hpke-js/tree/main/packages/core
// https://www.rfc-editor.org/rfc/rfc9180.html#section-5.1.3
// These deliberately do not call the Moor seal/open counterpart or reuse its suite instance.
const official = () =>
  new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
const wireInfo = encoder.encode('moor/e2ee/v1/HPKE-Auth-P256-HKDFSHA256-AES256GCM');

test('E2EE suite, version and private key export have a fixed wire shape', async () => {
  assert.equal(E2EE_CRYPTO_VERSION, 1);
  assert.equal(E2EE_CRYPTO_SUITE, 'HPKE-Auth-P256-HKDFSHA256-AES256GCM');
  assert.equal(E2EE_CRYPTO_INFO, new TextDecoder().decode(wireInfo));
  assert.equal(sender.publicKey.length, 87);
  assert.equal(binary(sender.publicKey).length, 65);
  assert.equal(binary(sender.publicKey)[0], 4);
  assert.equal(message.enc.length, 87);
  assert.equal(binary(message.ciphertext).length, plaintext.length + 16);
  assert.notEqual(sender.publicKey, recipient.publicKey);
  const jwk = await exportDevicePrivateJwk(sender.privateKey);
  assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'd', 'kty', 'x', 'y']);
  assert.equal(jwk.kty, 'EC');
  assert.equal(jwk.crv, 'P-256');
  for (const value of [jwk.x, jwk.y, jwk.d]) {
    assert.equal(value.length, 43);
    assert.equal(binary(value).length, 32);
    assert.equal(base64(binary(value)), value);
  }
  assert.equal(sender.privateKey.type, 'private');
  assert.equal(sender.privateKey.extractable, true);
  assert.deepEqual(sender.privateKey.usages, ['deriveBits']);
});

test('Moor ciphertext is opened by an independently created official Auth recipient', async () => {
  const suite = official();
  const context = await suite.createRecipientContext({
    recipientKey: recipient.privateKey,
    senderPublicKey: await suite.kem.deserializePublicKey(binary(sender.publicKey)),
    enc: binary(message.enc),
    info: wireInfo,
  });
  assert.deepEqual(new Uint8Array(await context.open(binary(message.ciphertext), aad)), plaintext);
});

test('Moor opens an independently created official Auth sender including binary content', async () => {
  const suite = official();
  const context = await suite.createSenderContext({
    senderKey: sender.privateKey,
    recipientPublicKey: await suite.kem.deserializePublicKey(binary(recipient.publicKey)),
    info: wireInfo,
  });
  const bytes = new Uint8Array([0, 255, 1, 128, 0, 10]);
  const ciphertext = await context.seal(bytes, aad);
  assert.deepEqual(
    await open({ ...defaultOpen, enc: base64(context.enc), ciphertext: base64(ciphertext) }),
    bytes,
  );
});

test('private endpoint JWK persistence preserves sender and recipient identities', async () => {
  const restoredSender = await importDevicePrivateJwk(
    JSON.parse(JSON.stringify(await exportDevicePrivateJwk(sender.privateKey))),
  );
  const restoredRecipient = await importDevicePrivateJwk(
    await exportDevicePrivateJwk(recipient.privateKey),
  );
  assert.equal(await devicePublicKey(restoredSender), sender.publicKey);
  assert.equal(await devicePublicKey(restoredRecipient), recipient.publicKey);
  const sealed = await seal({ ...defaultSeal, senderPrivateKey: restoredSender });
  assert.deepEqual(
    await open({ ...defaultOpen, ...sealed, recipientPrivateKey: restoredRecipient }),
    plaintext,
  );
});

test('reversing endpoints supports independent replies with the sender authenticated', async () => {
  const reply = await seal({
    ...defaultSeal,
    senderPrivateKey: recipient.privateKey,
    recipientPublicKey: sender.publicKey,
  });
  assert.deepEqual(
    await open({
      ...defaultOpen,
      ...reply,
      senderPublicKey: recipient.publicKey,
      recipientPrivateKey: sender.privateKey,
    }),
    plaintext,
  );
});

test('each concurrent message receives its own fresh encapsulation and context', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => seal(defaultSeal)));
  assert.equal(new Set(results.map((item) => item.enc)).size, 8);
  assert.equal(new Set(results.map((item) => item.ciphertext)).size, 8);
  for (const result of results)
    assert.deepEqual(await open({ ...defaultOpen, ...result }), plaintext);
});

test('authentication rejects a substituted sender or recipient', async () => {
  await assert.rejects(open({ ...defaultOpen, senderPublicKey: stranger.publicKey }), safeFailure);
  await assert.rejects(
    open({ ...defaultOpen, recipientPrivateKey: stranger.privateKey }),
    safeFailure,
  );
});

test('every byte of the external envelope is authenticated without normalizing it', async () => {
  for (const [key, value] of Object.entries(JSON.parse(new TextDecoder().decode(aad)))) {
    const replaced = {
      ...JSON.parse(new TextDecoder().decode(aad)),
      [key]: `${value}-substituted`,
    };
    await assert.rejects(
      open({ ...defaultOpen, aad: encoder.encode(JSON.stringify(replaced)) }),
      safeFailure,
    );
  }
  await assert.rejects(
    open({ ...defaultOpen, aad: encoder.encode(`${new TextDecoder().decode(aad)} `) }),
    safeFailure,
  );
});

test('modified encapsulation, ciphertext or authentication tag cannot produce plaintext', async () => {
  for (const [field, position] of [
    ['enc', 20],
    ['ciphertext', 0],
    ['ciphertext', -1],
  ] as const) {
    const changed = binary(message[field]);
    const offset = position < 0 ? changed.length - 1 : position;
    changed[offset] ^= 1;
    await assert.rejects(open({ ...defaultOpen, [field]: base64(changed) }), safeFailure);
  }
});

test('Base mode and changed suite or info cannot downgrade the fixed Auth suite', async () => {
  for (const variant of ['base', 'aes128', 'info']) {
    const suite =
      variant === 'aes128'
        ? new CipherSuite({
            kem: new DhkemP256HkdfSha256(),
            kdf: new HkdfSha256(),
            aead: new Aes128Gcm(),
          })
        : official();
    const context = await suite.createSenderContext({
      ...(variant === 'base' ? {} : { senderKey: sender.privateKey }),
      recipientPublicKey: await suite.kem.deserializePublicKey(binary(recipient.publicKey)),
      info: variant === 'info' ? encoder.encode('another application or version') : wireInfo,
    });
    await assert.rejects(
      open({
        ...defaultOpen,
        enc: base64(context.enc),
        ciphertext: base64(await context.seal(plaintext, aad)),
      }),
      safeFailure,
    );
  }
});

test('plaintext and AAD are snapshotted before asynchronous seal/open work', async () => {
  const body = new Uint8Array(plaintext);
  const metadata = new Uint8Array(aad);
  const pending = seal({ ...defaultSeal, plaintext: body, aad: metadata });
  body.fill(9);
  metadata.fill(8);
  const sealed = await pending;
  const openingAad = new Uint8Array(aad);
  const opening = open({ ...defaultOpen, ...sealed, aad: openingAad });
  openingAad.fill(7);
  assert.deepEqual(await opening, plaintext);
});

test('Uint8Array subarrays use only their selected range', async () => {
  const body = new Uint8Array([9, 0, 255, 7]);
  const metadata = new Uint8Array([8, 2, 3, 6]);
  const sealed = await seal({
    ...defaultSeal,
    plaintext: body.subarray(1, 3),
    aad: metadata.subarray(1, 3),
  });
  assert.deepEqual(
    await open({ ...defaultOpen, ...sealed, aad: new Uint8Array([2, 3]) }),
    new Uint8Array([0, 255]),
  );
});

test('binary content crossing base64 chunks preserves every byte and canonical padding', async () => {
  for (const length of [65535, 65536, 65537]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i % 256);
    const sealed = await seal({ ...defaultSeal, plaintext: bytes });
    assert.equal(sealed.ciphertext, base64(binary(sealed.ciphertext)));
    assert.deepEqual(await open({ ...defaultOpen, ...sealed }), bytes);
  }
});

test('empty plaintext and the maximum AAD length are supported', async () => {
  const metadata = new Uint8Array(E2EE_CRYPTO_LIMITS.aadBytes).fill(5);
  const sealed = await seal({ ...defaultSeal, plaintext: new Uint8Array(), aad: metadata });
  assert.equal(binary(sealed.ciphertext).length, 16);
  assert.deepEqual(await open({ ...defaultOpen, ...sealed, aad: metadata }), new Uint8Array());
});

test('empty or oversized AAD, oversized plaintext and nonbyte inputs fail safely', async () => {
  for (const metadata of [new Uint8Array(), new Uint8Array(E2EE_CRYPTO_LIMITS.aadBytes + 1)]) {
    await assert.rejects(seal({ ...defaultSeal, aad: metadata }), safeFailure);
    await assert.rejects(open({ ...defaultOpen, aad: metadata }), safeFailure);
  }
  await assert.rejects(
    seal({ ...defaultSeal, plaintext: new Uint8Array(E2EE_CRYPTO_LIMITS.plaintextBytes + 1) }),
    safeFailure,
  );
  await assert.rejects(
    seal({ ...defaultSeal, plaintext: 'synthetic-secret' } as unknown as SealOptions),
    safeFailure,
  );
  await assert.rejects(seal(null as unknown as SealOptions), safeFailure);
  await assert.rejects(open(null as unknown as OpenOptions), safeFailure);
});

test('public keys and encapsulations reject noncanonical base64url and invalid points', async () => {
  const canonical = sender.publicKey;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const nonzeroPadding = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1)!) | 1];
  const invalid = [
    '',
    `${canonical}=`,
    `${canonical}\n`,
    canonical.slice(1),
    `${canonical}A`,
    nonzeroPadding,
    canonical.replace(/./, '+'),
    'synthetic-secret',
    base64(new Uint8Array(65)),
    base64(new Uint8Array([4, ...new Uint8Array(64)])),
  ];
  for (const value of invalid) {
    await assert.rejects(seal({ ...defaultSeal, recipientPublicKey: value }), safeFailure);
    await assert.rejects(open({ ...defaultOpen, senderPublicKey: value }), safeFailure);
    await assert.rejects(open({ ...defaultOpen, enc: value }), safeFailure);
  }
});

test('ciphertexts reject truncated, oversized and noncanonical strings before delivery', async () => {
  const maxEncoded = Math.ceil(
    ((E2EE_CRYPTO_LIMITS.plaintextBytes + E2EE_CRYPTO_LIMITS.tagBytes) * 4) / 3,
  );
  for (const ciphertext of [
    '',
    'AA',
    'A'.repeat(21),
    `${message.ciphertext}=`,
    `${message.ciphertext}\n`,
    'A'.repeat(maxEncoded + 1),
  ]) {
    await assert.rejects(open({ ...defaultOpen, ciphertext }), safeFailure);
  }
});

test('private JWK rejects extra fields, wrong algorithms and malformed coordinates', async () => {
  const jwk = await exportDevicePrivateJwk(sender.privateKey);
  const other = await exportDevicePrivateJwk(stranger.privateKey);
  const badPadding =
    jwk.d.slice(0, -1) +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(jwk.d.at(-1)!) | 1
    ];
  const values: unknown[] = [
    null,
    [],
    'synthetic-secret',
    { ...jwk, kty: 'RSA' },
    { ...jwk, crv: 'P-384' },
    { ...jwk, alg: 'ECDH-ES' },
    { ...jwk, ext: true },
    { ...jwk, key_ops: ['deriveBits'] },
    { ...jwk, d: undefined },
    { ...jwk, x: `${jwk.x}=` },
    { ...jwk, y: 'AA' },
    { ...jwk, d: badPadding },
    { ...jwk, d: base64(new Uint8Array(32)) },
    { ...jwk, x: other.x, y: other.y },
    Object.assign(Object.create({ hidden: true }), jwk),
    {
      ...jwk,
      get d() {
        throw new Error('synthetic-secret');
      },
    },
  ];
  for (const value of values) await assert.rejects(importDevicePrivateJwk(value), safeFailure);
});

test('public, nonextractable or incompatible CryptoKeys cannot act as device private keys', async () => {
  const publicKey = await official().kem.deserializePublicKey(binary(sender.publicKey));
  const p384 = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-384' }, true, [
    'deriveBits',
  ]);
  const ecdsa = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const unexportable = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  for (const key of [
    publicKey,
    p384.privateKey,
    ecdsa.privateKey,
    unexportable.privateKey,
    {} as CryptoKey,
  ]) {
    await assert.rejects(exportDevicePrivateJwk(key), safeFailure);
    await assert.rejects(devicePublicKey(key), safeFailure);
    await assert.rejects(seal({ ...defaultSeal, senderPrivateKey: key }), safeFailure);
    await assert.rejects(open({ ...defaultOpen, recipientPrivateKey: key }), safeFailure);
  }
});

test('single-shot crypto intentionally leaves replay rejection to the authenticated envelope layer', async () => {
  assert.deepEqual(await open(defaultOpen), plaintext);
  assert.deepEqual(await open(defaultOpen), plaintext);
});
