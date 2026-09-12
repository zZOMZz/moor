import { z } from 'zod';
import { base64url, calculateJwkThumbprint, compactVerify, CompactSign, importJWK } from 'jose';
import { E2EE_CRYPTO_FAILED } from './e2ee-crypto';
import {
  e2eeDigestSchema,
  e2eeIdSchema,
  e2eeOriginSchema,
  encryptionKeyId,
  rootPublicJwkSchema,
  trustedDeviceSchema,
  trustCheckpointSchema,
  trustPinSchema,
  VerifiedTrust,
  type RootPublicJwk,
  type TrustedDevice,
  type TrustPin,
} from './e2ee-trust';

export const E2EE_PAIRING_VERSION = 1;
export const E2EE_PAIRING_TYPE = 'moor-e2ee-pairing+jws';
export const E2EE_PAIRING_FINGERPRINT_DOMAIN = 'moor/e2ee/pairing-request/v1';
export const E2EE_PAIRING_LIMITS = Object.freeze({
  lifetimeMs: 10 * 60 * 1000,
  approvalCharacters: 16 * 1024,
});

const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
const header = Object.freeze({ alg: 'ES256', typ: E2EE_PAIRING_TYPE });
const protectedHeader = base64url.encode(encoder.encode(JSON.stringify(header)));
const nowSchema = z.number().int().nonnegative().safe();

export const pairingRequestSchema = z
  .object({
    version: z.literal(E2EE_PAIRING_VERSION),
    pairingId: e2eeDigestSchema,
    accountId: e2eeIdSchema,
    serverOrigin: e2eeOriginSchema,
    rootKeyId: e2eeDigestSchema,
    device: trustedDeviceSchema,
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export type PairingRequest = z.infer<typeof pairingRequestSchema>;
const approvalPayloadSchema = z
  .object({
    request: pairingRequestSchema,
    requestFingerprint: e2eeDigestSchema,
    acceptedCheckpoint: trustCheckpointSchema,
  })
  .strict();

function fail(): never {
  throw new Error(E2EE_CRYPTO_FAILED);
}
function validTime(request: PairingRequest, now: number): void {
  nowSchema.parse(now);
  if (request.expiresAt <= now || request.expiresAt - now > E2EE_PAIRING_LIMITS.lifetimeMs) fail();
}
function samePin(left: TrustPin, right: TrustPin): boolean {
  return (
    left.accountId === right.accountId &&
    left.serverOrigin === right.serverOrigin &&
    left.rootKeyId === right.rootKeyId
  );
}
function sameDevice(left: TrustedDevice, right: TrustedDevice): boolean {
  return (
    left.deviceId === right.deviceId &&
    left.keyId === right.keyId &&
    left.publicKey === right.publicKey &&
    left.roles.length === right.roles.length &&
    left.roles.every((role) => right.roles.includes(role))
  );
}
function installedDevice(trust: VerifiedTrust, request: PairingRequest): void {
  if (!(trust instanceof VerifiedTrust) || !samePin(request, trust.checkpoint)) fail();
  const device = trust.device(request.device.deviceId, request.device.roles[0]);
  if (!sameDevice(device, request.device)) fail();
}
function freezeRequest(request: PairingRequest): PairingRequest {
  Object.freeze(request.device.roles);
  Object.freeze(request.device);
  return Object.freeze(request);
}
async function checkDevice(request: PairingRequest): Promise<void> {
  if ((await encryptionKeyId(request.device.publicKey)) !== request.device.keyId) fail();
}
async function fingerprint(request: PairingRequest): Promise<string> {
  return base64url.encode(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(E2EE_PAIRING_FINGERPRINT_DOMAIN + '\n' + JSON.stringify(request)),
      ),
    ),
  );
}

/** A fresh portable request only; the caller durably saves its id and pending operation. */
export async function createPairingRequest(options: {
  pin: TrustPin;
  device: TrustedDevice;
  now: number;
}): Promise<PairingRequest> {
  try {
    const pin = trustPinSchema.parse(options.pin),
      device = trustedDeviceSchema.parse(options.device),
      now = nowSchema.parse(options.now);
    const request = pairingRequestSchema.parse({
      version: E2EE_PAIRING_VERSION,
      pairingId: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
      ...pin,
      device,
      expiresAt: now + E2EE_PAIRING_LIMITS.lifetimeMs,
    });
    validTime(request, now);
    await checkDevice(request);
    return freezeRequest(request);
  } catch {
    return fail();
  }
}

/** Snapshot and validate a decoded portable request at the caller's explicit clock reading. */
export async function parsePairingRequest(value: unknown, now: number): Promise<PairingRequest> {
  try {
    const request = pairingRequestSchema.parse(value);
    validTime(request, now);
    await checkDevice(request);
    return freezeRequest(request);
  } catch {
    return fail();
  }
}

/** Display and compare the entire fingerprint on a separate trusted endpoint. Not an approval. */
export async function fingerprintRequest(value: PairingRequest): Promise<string> {
  try {
    const request = pairingRequestSchema.parse(value);
    await checkDevice(request);
    return await fingerprint(request);
  } catch {
    return fail();
  }
}

/**
 * Prepare only after explicit human fingerprint verification against a verified
 * manifest containing this exact device. The caller must atomically save the
 * approval with its manifest and recovery capsule before releasing any receipt.
 * Signing does not persist or consume pairingId; crash recovery and idempotence
 * belong to the caller's durable operation boundary.
 */
export async function signPairingApproval(options: {
  request: PairingRequest;
  expectedFingerprint: string;
  trust: VerifiedTrust;
  rootPublicKey: RootPublicJwk;
  rootPrivateKey: CryptoKey;
  now: number;
}): Promise<string> {
  try {
    const request = pairingRequestSchema.parse(options.request),
      expectedFingerprint = e2eeDigestSchema.parse(options.expectedFingerprint),
      trust = options.trust,
      root = rootPublicJwkSchema.parse(options.rootPublicKey),
      privateKey = options.rootPrivateKey,
      now = nowSchema.parse(options.now);
    validTime(request, now);
    installedDevice(trust, request);
    const checkpoint = trustCheckpointSchema.parse(trust.checkpoint);
    await checkDevice(request);
    const requestFingerprint = await fingerprint(request);
    if (requestFingerprint !== expectedFingerprint) fail();
    const rootKeyId = await calculateJwkThumbprint(root, 'sha256');
    if (rootKeyId !== request.rootKeyId) fail();
    const publicKey = await importJWK(root, 'ES256');
    const payload = approvalPayloadSchema.parse({
      request,
      requestFingerprint,
      acceptedCheckpoint: checkpoint,
    });
    const signed = await new CompactSign(encoder.encode(JSON.stringify(payload)))
      .setProtectedHeader(header)
      .sign(privateKey);
    if (signed.length > E2EE_PAIRING_LIMITS.approvalCharacters) fail();
    // A mismatched signing key must never return an apparently valid receipt.
    await compactVerify(signed, publicKey, { algorithms: ['ES256'] });
    return signed;
  } catch {
    return fail();
  }
}

/**
 * The root pin and pending request come from private endpoint state, not from the
 * pasted approval. A root-authenticated checkpoint can admit a new endpoint at a
 * non-genesis epoch. This verifies exactly the approved checkpoint; later trust
 * updates, private-key matching, expiry rechecks and single consumption remain
 * the caller's durable operation boundary.
 */
export async function verifyPairingApproval(options: {
  request: PairingRequest;
  expectedRootPin: TrustPin;
  approval: string;
  rootPublicKey: RootPublicJwk;
  signedManifest: string;
  now: number;
}): Promise<VerifiedTrust> {
  try {
    const request = pairingRequestSchema.parse(options.request),
      pin = trustPinSchema.parse(options.expectedRootPin),
      approval = z
        .string()
        .min(1)
        .max(E2EE_PAIRING_LIMITS.approvalCharacters)
        .parse(options.approval),
      root = rootPublicJwkSchema.parse(options.rootPublicKey),
      signedManifest = options.signedManifest,
      now = nowSchema.parse(options.now);
    validTime(request, now);
    if (!samePin(request, pin)) fail();
    const parts = approval.split('.');
    if (
      parts.length !== 3 ||
      parts[0] !== protectedHeader ||
      parts[2].length !== 86 ||
      parts.some(
        (part) =>
          !/^[A-Za-z0-9_-]+$/.test(part) || base64url.encode(base64url.decode(part)) !== part,
      )
    )
      fail();
    const rootKeyId = await calculateJwkThumbprint(root, 'sha256');
    if (rootKeyId !== pin.rootKeyId) fail();
    const verified = await compactVerify(approval, await importJWK(root, 'ES256'), {
      algorithms: ['ES256'],
    });
    const json = decoder.decode(verified.payload),
      payload = approvalPayloadSchema.parse(JSON.parse(json));
    if (
      JSON.stringify(payload) !== json ||
      JSON.stringify(payload.request) !== JSON.stringify(request) ||
      !samePin(payload.acceptedCheckpoint, pin)
    )
      fail();
    await checkDevice(request);
    if (payload.requestFingerprint !== (await fingerprint(request))) fail();
    const trust = await VerifiedTrust.verify({
      signed: signedManifest,
      rootPublicKey: root,
      pin,
      previous: payload.acceptedCheckpoint,
    });
    const checkpoint = trust.checkpoint;
    if (
      !samePin(checkpoint, payload.acceptedCheckpoint) ||
      checkpoint.epoch !== payload.acceptedCheckpoint.epoch ||
      checkpoint.digest !== payload.acceptedCheckpoint.digest
    )
      fail();
    installedDevice(trust, request);
    return trust;
  } catch {
    return fail();
  }
}
