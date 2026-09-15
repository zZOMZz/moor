import { z } from 'zod';
import {
  base64url,
  calculateJwkThumbprint,
  compactVerify,
  CompactSign,
  exportJWK,
  generateKeyPair,
  importJWK,
} from 'jose';
import { E2EE_CRYPTO_FAILED } from './e2ee-crypto';

export const E2EE_TRUST_VERSION = 1;
export const E2EE_TRUST_LIMITS = Object.freeze({ devices: 64, signedCharacters: 64 * 1024 });
const TRUST_TYPE = 'moor-e2ee-trust+jws';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const protectedHeader = base64url.encode(
  encoder.encode(JSON.stringify({ alg: 'ES256', typ: TRUST_TYPE })),
);

export const e2eeIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_:-]+$/);
function base64Bytes(bytes: number) {
  return z
    .string()
    .length(Math.ceil((bytes * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => {
      const decoded = base64url.decode(value);
      return decoded.length === bytes && base64url.encode(decoded) === value;
    });
}
export const e2eeDigestSchema = base64Bytes(32);
export const e2eePublicKeySchema = base64Bytes(65).refine(
  (value) => base64url.decode(value)[0] === 4,
);
export const e2eeOriginSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.origin === value &&
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });
export const rootPublicJwkSchema = z
  .object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: base64Bytes(32), y: base64Bytes(32) })
  .strict();
export type RootPublicJwk = z.infer<typeof rootPublicJwkSchema>;

export const trustedDeviceSchema = z
  .object({
    deviceId: e2eeIdSchema,
    keyId: e2eeDigestSchema,
    publicKey: e2eePublicKeySchema,
    roles: z
      .array(z.enum(['client', 'host']))
      .min(1)
      .max(2),
  })
  .strict()
  .refine((value) => new Set(value.roles).size === value.roles.length);
export type TrustedDevice = z.infer<typeof trustedDeviceSchema>;
export const trustPinSchema = z
  .object({ accountId: e2eeIdSchema, serverOrigin: e2eeOriginSchema, rootKeyId: e2eeDigestSchema })
  .strict();
export type TrustPin = z.infer<typeof trustPinSchema>;
export const trustManifestSchema = trustPinSchema
  .extend({
    version: z.literal(E2EE_TRUST_VERSION),
    epoch: z.number().int().positive().safe(),
    previous: e2eeDigestSchema.nullable(),
    devices: z.array(trustedDeviceSchema).max(E2EE_TRUST_LIMITS.devices),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.epoch === 1) !== (value.previous === null))
      context.addIssue({ code: 'custom', message: 'Invalid trust history' });
    for (const field of ['deviceId', 'keyId', 'publicKey'] as const) {
      if (new Set(value.devices.map((device) => device[field])).size !== value.devices.length)
        context.addIssue({ code: 'custom', message: 'Duplicate device identity' });
    }
  });
export type TrustManifest = z.infer<typeof trustManifestSchema>;
export const trustCheckpointSchema = trustPinSchema
  .extend({ epoch: z.number().int().positive().safe(), digest: e2eeDigestSchema })
  .strict();
export type TrustCheckpoint = z.infer<typeof trustCheckpointSchema>;

function fail(): never {
  throw new Error(E2EE_CRYPTO_FAILED);
}
function samePin(left: TrustPin, right: TrustPin): boolean {
  return (
    left.accountId === right.accountId &&
    left.serverOrigin === right.serverOrigin &&
    left.rootKeyId === right.rootKeyId
  );
}
function freezeManifest(manifest: TrustManifest): TrustManifest {
  for (const device of manifest.devices) {
    Object.freeze(device.roles);
    Object.freeze(device);
  }
  Object.freeze(manifest.devices);
  return Object.freeze(manifest);
}
async function publicRoot(value: unknown) {
  const jwk = rootPublicJwkSchema.parse(value);
  const key = await importJWK(jwk, 'ES256');
  const keyId = await calculateJwkThumbprint(jwk, 'sha256');
  return { jwk, key, keyId };
}

export async function encryptionKeyId(value: string): Promise<string> {
  try {
    const key = new Uint8Array(base64url.decode(e2eePublicKeySchema.parse(value)));
    // Reject off-curve points even in manifests that are otherwise correctly signed.
    await crypto.subtle.importKey('raw', key, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', key)));
  } catch {
    return fail();
  }
}
async function checkDeviceKeys(manifest: TrustManifest) {
  const keyIds = await Promise.all(
    manifest.devices.map((device) => encryptionKeyId(device.publicKey)),
  );
  if (keyIds.some((keyId, index) => keyId !== manifest.devices[index].keyId)) fail();
}

/** Generate only at an endpoint. The caller must keep the root private key out of relay state. */
export async function generateTrustRoot() {
  try {
    const pair = await generateKeyPair('ES256', { extractable: true });
    const exported = await exportJWK(pair.publicKey);
    const { jwk, keyId } = await publicRoot({
      kty: exported.kty,
      crv: exported.crv,
      x: exported.x,
      y: exported.y,
    });
    return { publicKey: jwk, privateKey: pair.privateKey, keyId };
  } catch {
    return fail();
  }
}

/** Explicit trust changes only; Google authentication is not authorization to call this function. */
export async function signTrustManifest(options: {
  manifest: TrustManifest;
  rootPublicKey: RootPublicJwk;
  rootPrivateKey: CryptoKey;
}): Promise<string> {
  try {
    const manifest = trustManifestSchema.parse(options.manifest);
    const root = rootPublicJwkSchema.parse(options.rootPublicKey);
    const privateKey = options.rootPrivateKey;
    const { key, keyId } = await publicRoot(root);
    if (manifest.rootKeyId !== keyId) fail();
    await checkDeviceKeys(manifest);
    const signed = await new CompactSign(encoder.encode(JSON.stringify(manifest)))
      .setProtectedHeader({ alg: 'ES256', typ: TRUST_TYPE })
      .sign(privateKey);
    if (signed.length > E2EE_TRUST_LIMITS.signedCharacters) fail();
    // A mismatched private key must not produce an apparently usable manifest.
    await compactVerify(signed, key, { algorithms: ['ES256'] });
    return signed;
  } catch {
    return fail();
  }
}

/**
 * Verified, immutable device list. The pin comes from explicit device/recovery verification,
 * and the previous checkpoint comes from private endpoint storage, never from the relay.
 * Missing history must be fetched and verified one epoch at a time; it cannot reset the pin.
 */
export class VerifiedTrust {
  readonly #manifest: TrustManifest;
  readonly #checkpoint: TrustCheckpoint;

  private constructor(manifest: TrustManifest, checkpoint: TrustCheckpoint) {
    this.#manifest = freezeManifest(manifest);
    this.#checkpoint = Object.freeze(checkpoint);
    Object.freeze(this);
  }

  static async verify(options: {
    signed: string;
    rootPublicKey: RootPublicJwk;
    pin: TrustPin;
    previous?: TrustCheckpoint;
  }): Promise<VerifiedTrust> {
    try {
      const signed = z
        .string()
        .min(1)
        .max(E2EE_TRUST_LIMITS.signedCharacters)
        .parse(options.signed);
      const root = rootPublicJwkSchema.parse(options.rootPublicKey);
      const pin = trustPinSchema.parse(options.pin);
      const previous = options.previous ? trustCheckpointSchema.parse(options.previous) : undefined;
      if (signed.split('.')[0] !== protectedHeader) fail();
      const { key, keyId } = await publicRoot(root);
      if (keyId !== pin.rootKeyId || (previous && !samePin(pin, previous))) fail();
      const verified = await compactVerify(signed, key, { algorithms: ['ES256'] });
      const header = verified.protectedHeader;
      if (header.alg !== 'ES256' || header.typ !== TRUST_TYPE || Object.keys(header).length !== 2)
        fail();
      const json = decoder.decode(verified.payload);
      const manifest = trustManifestSchema.parse(JSON.parse(json));
      // One encoding also rejects duplicate JSON keys, noncanonical numbers and hidden fields.
      if (JSON.stringify(manifest) !== json || !samePin(manifest, pin)) fail();
      await checkDeviceKeys(manifest);
      const digest = base64url.encode(
        new Uint8Array(
          await crypto.subtle.digest('SHA-256', encoder.encode(`${TRUST_TYPE}\n${json}`)),
        ),
      );
      if (!previous) {
        if (manifest.epoch !== 1 || manifest.previous !== null) fail();
      } else if (manifest.epoch === previous.epoch) {
        if (digest !== previous.digest) fail();
      } else if (manifest.epoch !== previous.epoch + 1 || manifest.previous !== previous.digest) {
        fail();
      }
      return new VerifiedTrust(manifest, { ...pin, epoch: manifest.epoch, digest });
    } catch {
      return fail();
    }
  }

  get manifest(): Readonly<TrustManifest> {
    return this.#manifest;
  }
  get checkpoint(): Readonly<TrustCheckpoint> {
    return this.#checkpoint;
  }
  device(deviceId: string, role: 'client' | 'host'): Readonly<TrustedDevice> {
    const device = this.#manifest.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device || !device.roles.includes(role)) fail();
    return device;
  }
}
