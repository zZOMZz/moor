import { base64url, compactDecrypt, CompactEncrypt } from 'jose';
import { z } from 'zod';
import { E2EE_CRYPTO_FAILED } from './e2ee-crypto';
import {
  e2eeDigestSchema,
  E2EE_TRUST_LIMITS,
  rootPublicJwkSchema,
  trustCheckpointSchema,
  trustPinSchema,
  VerifiedTrust,
  type RootPublicJwk,
  type TrustCheckpoint,
  type TrustPin,
} from './e2ee-trust';

export const E2EE_RECOVERY_VERSION = 1;
export const E2EE_RECOVERY_MAX_BYTES = 128 * 1024;
export type RootPrivateJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string };
/** Root-only recovery state. Endpoint encryption keys, login credentials and history are excluded. */
export type RecoveryPayload = {
  version: 1;
  pin: TrustPin;
  rootPublicKey: RootPublicJwk;
  rootPrivateKey: RootPrivateJwk;
  checkpoint: TrustCheckpoint;
  signedManifest: string;
};

const header = Object.freeze({ alg: 'dir', enc: 'A256GCM', typ: 'moor-e2ee-recovery+jwe' });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const protectedHeader = base64url.encode(encoder.encode(JSON.stringify(header)));
const keyCheck = encoder.encode('moor/e2ee-recovery/v1/root-private-key-check');
const privateSchema = rootPublicJwkSchema.extend({ d: e2eeDigestSchema }).strict();
const payloadSchema = z
  .object({
    version: z.literal(E2EE_RECOVERY_VERSION),
    pin: trustPinSchema,
    rootPublicKey: rootPublicJwkSchema,
    rootPrivateKey: privateSchema,
    checkpoint: trustCheckpointSchema,
    signedManifest: z.string().min(1).max(E2EE_TRUST_LIMITS.signedCharacters),
  })
  .strict();

function fail(): never {
  throw new Error(E2EE_CRYPTO_FAILED);
}

function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  const fields = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    fields.length !== names.length ||
    fields.some((field) => typeof field !== 'string' || !names.includes(field))
  )
    fail();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !('value' in descriptor)) fail();
    if (typeof descriptor.value === 'string' && descriptor.value.length > E2EE_RECOVERY_MAX_BYTES)
      fail();
    result[name] = descriptor.value;
  }
  return result;
}

function parsePrivate(value: unknown): RootPrivateJwk {
  const jwk = record(value, ['kty', 'crv', 'x', 'y', 'd']);
  for (const field of ['x', 'y', 'd']) parseKey(jwk[field]).fill(0);
  return privateSchema.parse(jwk);
}

function privateKey(key: CryptoKey): CryptoKey {
  if (
    !key ||
    key.type !== 'private' ||
    key.algorithm.name !== 'ECDSA' ||
    (key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' ||
    !key.extractable ||
    key.usages.length !== 1 ||
    key.usages[0] !== 'sign'
  )
    fail();
  return key;
}

async function assertCoordinates(key: CryptoKey, jwk: RootPrivateJwk): Promise<void> {
  const { kty, crv, x, y } = jwk;
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty, crv, x, y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey(key),
    keyCheck,
  );
  if (
    !(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signature,
      keyCheck,
    ))
  )
    fail();
}

/** Explicit private endpoint persistence only. Never project this JWK into shared state. */
export async function exportRootPrivateJwk(key: CryptoKey): Promise<RootPrivateJwk> {
  try {
    const exported = await crypto.subtle.exportKey('jwk', privateKey(key));
    const jwk = parsePrivate({
      kty: exported.kty,
      crv: exported.crv,
      x: exported.x,
      y: exported.y,
      d: exported.d,
    });
    await assertCoordinates(key, jwk);
    return Object.freeze(jwk);
  } catch {
    return fail();
  }
}

export async function importRootPrivateJwk(value: unknown): Promise<CryptoKey> {
  try {
    const jwk = parsePrivate(value);
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign'],
    );
    await assertCoordinates(key, jwk);
    return privateKey(key);
  } catch {
    return fail();
  }
}

function parseKey(value: unknown): Uint8Array<ArrayBuffer> {
  // Zod refinements can run after a failed length check; bound before any base64 decoding.
  if (typeof value !== 'string' || value.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  return new Uint8Array(base64url.decode(e2eeDigestSchema.parse(value)));
}

/** The caller stores this random 256-bit key separately from its capsule; it is not a password. */
export function generateRecoveryKey(): string {
  let bytes: Uint8Array | undefined;
  try {
    bytes = crypto.getRandomValues(new Uint8Array(32));
    return base64url.encode(bytes);
  } catch {
    return fail();
  } finally {
    bytes?.fill(0);
  }
}

function parsePayload(value: unknown): RecoveryPayload {
  const payload = record(value, [
    'version',
    'pin',
    'rootPublicKey',
    'rootPrivateKey',
    'checkpoint',
    'signedManifest',
  ]);
  const pin = record(payload.pin, ['accountId', 'serverOrigin', 'rootKeyId']);
  const root = record(payload.rootPublicKey, ['kty', 'crv', 'x', 'y']);
  const checkpoint = record(payload.checkpoint, [
    'accountId',
    'serverOrigin',
    'rootKeyId',
    'epoch',
    'digest',
  ]);
  for (const scalar of [pin.rootKeyId, root.x, root.y, checkpoint.rootKeyId, checkpoint.digest])
    parseKey(scalar).fill(0);
  return payloadSchema.parse({
    ...payload,
    pin,
    rootPublicKey: root,
    rootPrivateKey: parsePrivate(payload.rootPrivateKey),
    checkpoint,
  });
}

async function validatePayload(payload: RecoveryPayload): Promise<RecoveryPayload> {
  const key = await importRootPrivateJwk(payload.rootPrivateKey);
  const exported = await exportRootPrivateJwk(key);
  if (exported.x !== payload.rootPublicKey.x || exported.y !== payload.rootPublicKey.y) fail();
  const trust = await VerifiedTrust.verify({
    signed: payload.signedManifest,
    rootPublicKey: payload.rootPublicKey,
    pin: payload.pin,
    previous: payload.checkpoint,
  });
  // verify also permits a next epoch; recovery must contain exactly the checkpoint it claims.
  if (JSON.stringify(trust.checkpoint) !== JSON.stringify(payload.checkpoint)) fail();
  for (const object of [
    payload.pin,
    payload.rootPublicKey,
    payload.rootPrivateKey,
    payload.checkpoint,
  ])
    Object.freeze(object);
  return Object.freeze(payload);
}

function parseCapsule(value: unknown): string {
  if (typeof value !== 'string' || value.length > E2EE_RECOVERY_MAX_BYTES) fail();
  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== protectedHeader || parts[1] !== '') fail();
  for (const [index, size] of [
    [2, 12],
    [3, undefined],
    [4, 16],
  ] as const) {
    const part = parts[index];
    if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) fail();
    const bytes = base64url.decode(part);
    if ((size !== undefined && bytes.length !== size) || base64url.encode(bytes) !== part) fail();
  }
  return value;
}

export async function encryptRecovery(options: {
  payload: RecoveryPayload;
  recoveryKey: string;
}): Promise<string> {
  let key: Uint8Array<ArrayBuffer> | undefined;
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    // Both snapshots precede the first await; subsequent caller mutations cannot replace this approval.
    const payload = parsePayload(options.payload);
    key = parseKey(options.recoveryKey);
    await validatePayload(payload);
    plaintext = encoder.encode(JSON.stringify(payload));
    if (plaintext.byteLength > E2EE_RECOVERY_MAX_BYTES) fail();
    const capsule = await new CompactEncrypt(plaintext).setProtectedHeader(header).encrypt(key);
    return parseCapsule(capsule);
  } catch {
    return fail();
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
  }
}

/** Decryption verifies the root and checkpoint; explicit enrollment and rollback policy stay with the caller. */
export async function decryptRecovery(options: {
  capsule: string;
  recoveryKey: string;
}): Promise<RecoveryPayload> {
  let key: Uint8Array<ArrayBuffer> | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    const capsule = parseCapsule(options.capsule);
    key = parseKey(options.recoveryKey);
    const result = await compactDecrypt(capsule, key, {
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    plaintext = result.plaintext;
    if (plaintext.byteLength > E2EE_RECOVERY_MAX_BYTES) fail();
    const json = decoder.decode(plaintext);
    const payload = parsePayload(JSON.parse(json));
    if (JSON.stringify(payload) !== json) fail();
    return await validatePayload(payload);
  } catch {
    return fail();
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
  }
}
