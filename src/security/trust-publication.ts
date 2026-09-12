import { z } from 'zod';
import { E2EE_CRYPTO_FAILED } from './e2ee-crypto';
import {
  E2EE_TRUST_LIMITS,
  rootPublicJwkSchema,
  trustCheckpointSchema,
  trustPinSchema,
  VerifiedTrust,
  type TrustCheckpoint,
  type TrustPin,
} from './e2ee-trust';

export const TRUST_PUBLICATION_VERSION = 1;
export const TRUST_PUBLICATION_LIMITS = Object.freeze({
  pageEntries: 16,
  wireBytes: 1024 * 1024,
  versions: 4096,
  storedBytes: 128 * 1024 * 1024,
});
const samePin = (left: TrustPin, right: TrustPin) =>
  left.accountId === right.accountId &&
  left.serverOrigin === right.serverOrigin &&
  left.rootKeyId === right.rootKeyId;
const sameCheckpoint = (left: TrustCheckpoint, right: TrustCheckpoint) =>
  samePin(left, right) && left.epoch === right.epoch && left.digest === right.digest;
const withinWireLimit = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= TRUST_PUBLICATION_LIMITS.wireBytes;

export const publicTrustEntrySchema = z
  .object({
    pin: trustPinSchema,
    rootPublicKey: rootPublicJwkSchema,
    checkpoint: trustCheckpointSchema,
    signedManifest: z.string().min(1).max(E2EE_TRUST_LIMITS.signedCharacters),
  })
  .strict()
  .refine((value) => samePin(value.pin, value.checkpoint));
export type PublicTrustEntry = z.infer<typeof publicTrustEntrySchema>;

/** Verifies a signed public snapshot; callers separately establish the pin and history continuity. */
export async function verifyPublicTrustEntry(input: PublicTrustEntry): Promise<VerifiedTrust> {
  try {
    const value = publicTrustEntrySchema.parse(input);
    const verified = await VerifiedTrust.verify({
      signed: value.signedManifest,
      rootPublicKey: value.rootPublicKey,
      pin: value.pin,
      previous: value.checkpoint,
    });
    if (!sameCheckpoint(verified.checkpoint, value.checkpoint)) throw new Error();
    return verified;
  } catch {
    throw new Error(E2EE_CRYPTO_FAILED);
  }
}

export const trustPublishSchema = z
  .object({
    publicationVersion: z.literal(TRUST_PUBLICATION_VERSION),
    entries: z.array(publicTrustEntrySchema).min(1).max(TRUST_PUBLICATION_LIMITS.pageEntries),
  })
  .strict()
  .refine((value) =>
    value.entries.every(
      (entry, index) =>
        !index || entry.checkpoint.epoch > value.entries[index - 1].checkpoint.epoch,
    ),
  )
  .refine(withinWireLimit);
export type TrustPublish = z.infer<typeof trustPublishSchema>;

export const trustPublishReceiptSchema = z
  .object({
    publicationVersion: z.literal(TRUST_PUBLICATION_VERSION),
    pin: trustPinSchema,
    rootPublicKey: rootPublicJwkSchema,
    stored: z.array(trustCheckpointSchema).min(1).max(TRUST_PUBLICATION_LIMITS.pageEntries),
    head: trustCheckpointSchema,
  })
  .strict()
  .refine(
    (value) =>
      samePin(value.pin, value.head) &&
      value.stored.every(
        (checkpoint, index) =>
          samePin(value.pin, checkpoint) &&
          checkpoint.epoch <= value.head.epoch &&
          (!index || checkpoint.epoch > value.stored[index - 1].epoch) &&
          (checkpoint.epoch !== value.head.epoch || sameCheckpoint(checkpoint, value.head)),
      ),
  )
  .refine(withinWireLimit);
export type TrustPublishReceipt = z.infer<typeof trustPublishReceiptSchema>;

export const trustReadSchema = z
  .object({
    publicationVersion: z.literal(TRUST_PUBLICATION_VERSION),
    pin: trustPinSchema,
    after: trustCheckpointSchema.nullable(),
    limit: z.number().int().min(1).max(TRUST_PUBLICATION_LIMITS.pageEntries),
    head: trustCheckpointSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (!value.after || samePin(value.pin, value.after)) &&
      (!value.head || samePin(value.pin, value.head)) &&
      (!value.after ||
        !value.head ||
        value.after.epoch < value.head.epoch ||
        sameCheckpoint(value.after, value.head)),
  )
  .refine(withinWireLimit);
export type TrustRead = z.infer<typeof trustReadSchema>;

export const trustPageSchema = z
  .object({
    publicationVersion: z.literal(TRUST_PUBLICATION_VERSION),
    pin: trustPinSchema,
    rootPublicKey: rootPublicJwkSchema,
    after: trustCheckpointSchema.nullable(),
    head: trustCheckpointSchema,
    entries: z.array(publicTrustEntrySchema).max(TRUST_PUBLICATION_LIMITS.pageEntries),
    complete: z.boolean(),
  })
  .strict()
  .refine((value) => {
    if (!samePin(value.pin, value.head) || (value.after && !samePin(value.pin, value.after)))
      return false;
    if (!value.entries.length)
      return !!value.after && sameCheckpoint(value.after, value.head) && value.complete;
    if (
      !value.entries.every(
        (entry, index) =>
          samePin(entry.pin, value.pin) &&
          JSON.stringify(entry.rootPublicKey) === JSON.stringify(value.rootPublicKey) &&
          entry.checkpoint.epoch === (value.after?.epoch ?? 0) + index + 1 &&
          entry.checkpoint.epoch <= value.head.epoch,
      )
    )
      return false;
    const last = value.entries.at(-1)!.checkpoint;
    return (
      value.complete === sameCheckpoint(last, value.head) &&
      (last.epoch !== value.head.epoch || sameCheckpoint(last, value.head))
    );
  })
  .refine(withinWireLimit);
export type TrustPage = z.infer<typeof trustPageSchema>;
