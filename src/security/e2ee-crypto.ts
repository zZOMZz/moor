import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';

export const E2EE_CRYPTO_VERSION = 1;
export const E2EE_CRYPTO_SUITE = 'HPKE-Auth-P256-HKDFSHA256-AES256GCM';
export const E2EE_CRYPTO_INFO = `moor/e2ee/v${E2EE_CRYPTO_VERSION}/${E2EE_CRYPTO_SUITE}`;
export const E2EE_CRYPTO_FAILED = '端到端加密校验失败';
export const E2EE_CRYPTO_LIMITS = Object.freeze({
  plaintextBytes: 48 * 1024 * 1024,
  aadBytes: 16 * 1024,
  encBytes: 65,
  publicKeyBytes: 65,
  tagBytes: 16,
});

export type DeviceEncryptionKey = { publicKey: string; privateKey: CryptoKey };
/** Private endpoint storage only. This value must never enter shared documents or relay state. */
export type DevicePrivateJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string };
export type SealedMessage = { enc: string; ciphertext: string };
export type SealOptions = {
  senderPrivateKey: CryptoKey;
  recipientPublicKey: string;
  plaintext: Uint8Array;
  /** Exact authenticated external envelope bytes, including the caller's routing and replay scope. */
  aad: Uint8Array;
};
export type OpenOptions = SealedMessage & {
  senderPublicKey: string;
  recipientPrivateKey: CryptoKey;
  aad: Uint8Array;
};

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
const info = new TextEncoder().encode(E2EE_CRYPTO_INFO);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function fail(): never {
  throw new Error(E2EE_CRYPTO_FAILED);
}

function encode(bytes: Uint8Array): string {
  // Multiples of three keep padding out of intermediate chunks without spreading a large buffer.
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 3 * 8192) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 3 * 8192))));
  }
  return chunks.join('').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: unknown, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    value.length < Math.ceil((minimum * 4) / 3) ||
    value.length > Math.ceil((maximum * 4) / 3) ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]*$/.test(value)
  )
    fail();
  const remainder = value.length % 4;
  const last = alphabet.indexOf(value.at(-1) ?? '');
  if ((remainder === 2 && (last & 15) !== 0) || (remainder === 3 && (last & 3) !== 0)) fail();
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  if (binary.length < minimum || binary.length > maximum) fail();
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function publicBytes(value: unknown): Uint8Array<ArrayBuffer> {
  const bytes = decode(value, E2EE_CRYPTO_LIMITS.publicKeyBytes, E2EE_CRYPTO_LIMITS.publicKeyBytes);
  if (bytes[0] !== 4) fail();
  return bytes;
}

function privateKey(key: CryptoKey): CryptoKey {
  if (
    !key ||
    key.type !== 'private' ||
    key.algorithm.name !== 'ECDH' ||
    (key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' ||
    !key.extractable ||
    key.usages.length !== 1 ||
    key.usages[0] !== 'deriveBits'
  )
    fail();
  return key;
}

function copyBytes(value: Uint8Array, minimum: number, maximum: number): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum)
    fail();
  // Snapshot before any await; neither caller mutations nor a shared backing buffer change the input.
  return new Uint8Array(value);
}

function parsePrivateJwk(value: unknown): DevicePrivateJwk {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const fields = Reflect.ownKeys(value);
  if (
    fields.length !== 5 ||
    fields.some((key) => !['kty', 'crv', 'x', 'y', 'd'].includes(String(key)))
  )
    fail();
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') fail();
  // Read each field once so an accessor cannot replace a validated coordinate across an await.
  const x = jwk.x;
  const y = jwk.y;
  const d = jwk.d;
  decode(x, 32, 32);
  decode(y, 32, 32);
  decode(d, 32, 32);
  return { kty: 'EC', crv: 'P-256', x: x as string, y: y as string, d: d as string };
}

export async function generateDeviceEncryptionKey(): Promise<DeviceEncryptionKey> {
  try {
    const pair = await suite.kem.generateKeyPair();
    return {
      publicKey: encode(new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey))),
      privateKey: privateKey(pair.privateKey),
    };
  } catch {
    return fail();
  }
}

/** Explicitly exportable for private endpoint persistence and recovery, never for the relay. */
export async function exportDevicePrivateJwk(key: CryptoKey): Promise<DevicePrivateJwk> {
  try {
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', privateKey(key));
    return parsePrivateJwk({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d });
  } catch {
    return fail();
  }
}

export async function importDevicePrivateJwk(value: unknown): Promise<CryptoKey> {
  try {
    return privateKey(await suite.kem.importKey('jwk', parsePrivateJwk(value), false));
  } catch {
    return fail();
  }
}

export async function devicePublicKey(key: CryptoKey): Promise<string> {
  try {
    const { kty, crv, x, y } = await exportDevicePrivateJwk(key);
    const publicKey = await suite.kem.importKey('jwk', { kty, crv, x, y }, true);
    return encode(new Uint8Array(await suite.kem.serializePublicKey(publicKey)));
  } catch {
    return fail();
  }
}

/** One fresh Auth context per message. Trust, replay rejection and operation deduplication belong to the caller. */
export async function seal(options: SealOptions): Promise<SealedMessage> {
  try {
    const sender = privateKey(options.senderPrivateKey);
    const recipient = publicBytes(options.recipientPublicKey);
    const plaintext = copyBytes(options.plaintext, 0, E2EE_CRYPTO_LIMITS.plaintextBytes);
    const aad = copyBytes(options.aad, 1, E2EE_CRYPTO_LIMITS.aadBytes);
    const context = await suite.createSenderContext({
      senderKey: sender,
      recipientPublicKey: await suite.kem.deserializePublicKey(recipient),
      info,
    });
    const ciphertext = await context.seal(plaintext, aad);
    return {
      enc: encode(new Uint8Array(context.enc)),
      ciphertext: encode(new Uint8Array(ciphertext)),
    };
  } catch {
    return fail();
  }
}

export async function open(options: OpenOptions): Promise<Uint8Array> {
  try {
    const recipient = privateKey(options.recipientPrivateKey);
    const sender = publicBytes(options.senderPublicKey);
    const enc = publicBytes(options.enc);
    const ciphertext = decode(
      options.ciphertext,
      E2EE_CRYPTO_LIMITS.tagBytes,
      E2EE_CRYPTO_LIMITS.plaintextBytes + E2EE_CRYPTO_LIMITS.tagBytes,
    );
    const aad = copyBytes(options.aad, 1, E2EE_CRYPTO_LIMITS.aadBytes);
    const context = await suite.createRecipientContext({
      recipientKey: recipient,
      senderPublicKey: await suite.kem.deserializePublicKey(sender),
      enc,
      info,
    });
    return new Uint8Array(await context.open(ciphertext, aad));
  } catch {
    return fail();
  }
}
