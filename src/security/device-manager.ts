import { z } from 'zod';
import {
  devicePublicKey,
  E2EE_CRYPTO_FAILED,
  exportDevicePrivateJwk,
  generateDeviceEncryptionKey,
  importDevicePrivateJwk,
  type DevicePrivateJwk,
} from './e2ee-crypto';
import {
  createPairingRequest,
  fingerprintRequest,
  pairingRequestSchema,
  parsePairingRequest,
  signPairingApproval,
  verifyPairingApproval,
  type PairingRequest,
} from './e2ee-pairing';
import {
  decryptRecovery,
  encryptRecovery,
  exportRootPrivateJwk,
  importRootPrivateJwk,
  type RecoveryPayload,
} from './e2ee-recovery';
import {
  e2eeDigestSchema,
  e2eeIdSchema,
  e2eeOriginSchema,
  encryptionKeyId,
  generateTrustRoot,
  rootPublicJwkSchema,
  signTrustManifest,
  trustedDeviceSchema,
  trustCheckpointSchema,
  trustManifestSchema,
  trustPinSchema,
  VerifiedTrust,
  type RootPublicJwk,
  type TrustedDevice,
  type TrustCheckpoint,
  type TrustPin,
} from './e2ee-trust';
import { PrivateEndpointFile } from './private-endpoint-file';
import {
  publicTrustEntrySchema as publicTrustSchema,
  verifyPublicTrustEntry,
  TRUST_PUBLICATION_LIMITS,
} from './trust-publication';

export const DEVICE_MANAGER_LIMITS = Object.freeze({ approvals: 8, publications: 16 });
const privateKeySchema = rootPublicJwkSchema.extend({ d: e2eeDigestSchema }).strict();
export type DevicePublicTrust = z.infer<typeof publicTrustSchema>;
const pendingSchema = z
  .object({ request: pairingRequestSchema, privateKey: privateKeySchema })
  .strict();
const receiptSchema = z
  .object({
    request: pairingRequestSchema,
    fingerprint: e2eeDigestSchema,
    approval: z
      .string()
      .min(1)
      .max(16 * 1024),
    trust: publicTrustSchema,
  })
  .strict();
export type DevicePairingReceipt = z.infer<typeof receiptSchema>;
const stateSchema = z
  .object({
    version: z.literal(1),
    pin: trustPinSchema,
    device: trustedDeviceSchema,
    privateKey: privateKeySchema,
    trust: publicTrustSchema.nullable(),
    pending: pendingSchema.nullable(),
    // The recovery code is never persisted here, and the root private key is only inside this JWE.
    recoveryCapsule: z
      .string()
      .min(1)
      .max(128 * 1024)
      .nullable(),
    approvals: z.array(receiptSchema).max(DEVICE_MANAGER_LIMITS.approvals),
    // Missing only in the previous preview format. Its current signed version
    // remains pending until explicitly confirmed; unavailable history is never invented.
    publications: z.array(publicTrustSchema).max(DEVICE_MANAGER_LIMITS.publications).optional(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.approvals.map((item) => item.request.pairingId)).size ===
      value.approvals.length,
  );
type State = z.infer<typeof stateSchema>;
type Roles = TrustedDevice['roles'];
const identitySchema = z
  .object({
    accountId: e2eeIdSchema,
    serverOrigin: e2eeOriginSchema,
    deviceId: e2eeIdSchema,
    roles: z
      .array(z.enum(['client', 'host']))
      .min(1)
      .max(2)
      .refine((roles) => new Set(roles).size === roles.length),
  })
  .strict();
type InitialIdentity = z.infer<typeof identitySchema>;
export { publicTrustSchema as devicePublicTrustSchema, identitySchema as deviceIdentitySchema };

function fail(): never {
  throw new Error(E2EE_CRYPTO_FAILED);
}
function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sameDevice(left: TrustedDevice | undefined, right: TrustedDevice) {
  return (
    !!left &&
    left.deviceId === right.deviceId &&
    left.keyId === right.keyId &&
    left.publicKey === right.publicKey &&
    left.roles.length === right.roles.length &&
    left.roles.every((role) => right.roles.includes(role))
  );
}
function pinOf(value: TrustPin): TrustPin {
  return trustPinSchema.parse({
    accountId: value.accountId,
    serverOrigin: value.serverOrigin,
    rootKeyId: value.rootKeyId,
  });
}
function assertPin(left: TrustPin, right: TrustPin) {
  if (!same(pinOf(left), pinOf(right))) fail();
}
function publicTrust(
  trust: VerifiedTrust,
  root: RootPublicJwk,
  signedManifest: string,
): DevicePublicTrust {
  return publicTrustSchema.parse({
    pin: pinOf(trust.checkpoint),
    rootPublicKey: root,
    checkpoint: trust.checkpoint,
    signedManifest,
  });
}
async function readTrust(value: DevicePublicTrust): Promise<VerifiedTrust> {
  return verifyPublicTrustEntry(value);
}
async function newDevice(deviceId: string, roles: Roles) {
  const key = await generateDeviceEncryptionKey();
  const device = trustedDeviceSchema.parse({
    deviceId,
    roles,
    publicKey: key.publicKey,
    keyId: await encryptionKeyId(key.publicKey),
  });
  return { device, privateKey: await exportDevicePrivateJwk(key.privateKey) };
}
async function validatePrivate(device: TrustedDevice, key: DevicePrivateJwk) {
  if (
    (await devicePublicKey(await importDevicePrivateJwk(key))) !== device.publicKey ||
    (await encryptionKeyId(device.publicKey)) !== device.keyId
  )
    fail();
}

/**
 * Local endpoint enrollment and administration. Every mutation is explicit and uses a private
 * file revision. No requests are sent to a relay or agent here. Root authorization is unlocked
 * with an externally held recovery code for each action; it is never saved as a live root key.
 */
export class DeviceManager {
  readonly #file: PrivateEndpointFile;
  readonly #now: () => number;
  #revision: number | null = null;
  #state: State | undefined;
  #trust: VerifiedTrust | undefined;
  #closed = false;

  private constructor(file: PrivateEndpointFile, now: () => number) {
    this.#file = file;
    this.#now = now;
  }
  static async open(path: string, options: { now?: () => number } = {}): Promise<DeviceManager> {
    let manager: DeviceManager | undefined;
    try {
      manager = new DeviceManager(PrivateEndpointFile.open(path), options.now ?? Date.now);
      const snapshot = manager.#file.load();
      if (snapshot) {
        const state = stateSchema.parse(snapshot.value);
        await validatePrivate(state.device, state.privateKey);
        if (state.pending) {
          assertPin(state.pin, state.pending.request);
          if (state.pending.request.device.deviceId !== state.device.deviceId) fail();
          await validatePrivate(state.pending.request.device, state.pending.privateKey);
        }
        if (!state.trust && (!state.pending || state.recoveryCapsule || state.approvals.length))
          fail();
        if (state.trust) {
          assertPin(state.pin, state.trust.pin);
          manager.#trust = await readTrust(state.trust);
        }
        let previousPublication: VerifiedTrust | undefined;
        for (const entry of state.publications ?? []) {
          if (!state.trust) fail();
          assertPin(state.pin, entry.pin);
          if (!same(entry.rootPublicKey, state.trust.rootPublicKey)) fail();
          const verified = await readTrust(entry);
          if (
            verified.checkpoint.epoch > state.trust.checkpoint.epoch ||
            (verified.checkpoint.epoch === state.trust.checkpoint.epoch &&
              !same(verified.checkpoint, state.trust.checkpoint)) ||
            (previousPublication &&
              (verified.checkpoint.epoch <= previousPublication.checkpoint.epoch ||
                (verified.checkpoint.epoch === previousPublication.checkpoint.epoch + 1 &&
                  verified.manifest.previous !== previousPublication.checkpoint.digest)))
          )
            fail();
          previousPublication = verified;
        }
        for (const receipt of state.approvals) {
          assertPin(state.pin, receipt.request);
          if ((await fingerprintRequest(receipt.request)) !== receipt.fingerprint) fail();
          // Saved expired receipts are inert and can be inspected; they cannot enroll a device.
          const approved = await verifyPairingApproval({
            request: receipt.request,
            expectedRootPin: state.pin,
            approval: receipt.approval,
            rootPublicKey: receipt.trust.rootPublicKey,
            signedManifest: receipt.trust.signedManifest,
            now: receipt.request.expiresAt - 1,
          });
          assertPin(state.pin, receipt.trust.pin);
          if (!same(approved.checkpoint, receipt.trust.checkpoint)) fail();
        }
        if (manager.#file.load()?.revision !== snapshot.revision) fail();
        manager.#state = state;
        manager.#revision = snapshot.revision;
      }
      return manager;
    } catch {
      manager?.close();
      return fail();
    }
  }
  #assert(revision = this.#revision) {
    if (
      this.#closed ||
      revision !== this.#revision ||
      (this.#file.load()?.revision ?? null) !== this.#revision
    )
      fail();
  }
  #write(expected: number | null, state: State, trust?: VerifiedTrust) {
    this.#assert(expected);
    const value = stateSchema.parse(state);
    const saved = this.#file.save(expected, value);
    this.#revision = saved.revision;
    this.#state = value;
    this.#trust = trust;
  }
  #active() {
    this.#assert();
    if (!this.#state?.trust || !this.#trust) fail();
    return { state: this.#state, trust: this.#trust, revision: this.#revision! };
  }
  #receipts(state: State) {
    return state.approvals.filter((item) => item.request.expiresAt > this.#now());
  }
  #publicationEntries(state: State): DevicePublicTrust[] {
    return state.publications ?? (state.trust ? [state.trust] : []);
  }
  #appendPublication(state: State, entry: DevicePublicTrust) {
    const before = this.#publicationEntries(state);
    if (
      before.length >= DEVICE_MANAGER_LIMITS.publications ||
      (before.length && before.at(-1)!.checkpoint.epoch >= entry.checkpoint.epoch)
    )
      fail();
    return [...before, entry];
  }
  #isDeviceCurrent() {
    if (!this.#trust || !this.#state) return false;
    const device = this.#trust.manifest.devices.find(
      (item) => item.deviceId === this.#state!.device.deviceId,
    );
    return sameDevice(device, this.#state.device);
  }
  current(): VerifiedTrust | undefined {
    this.#assert();
    return this.#isDeviceCurrent() ? this.#trust : undefined;
  }
  status() {
    this.#assert();
    const state = this.#state;
    return state
      ? structuredClone({
          revision: this.#revision,
          phase: state.trust ? (this.#isDeviceCurrent() ? 'active' : 'revoked') : 'pending',
          pin: state.pin,
          device: state.device,
          trust: state.trust,
          canUnlockRoot: !!state.recoveryCapsule,
          pendingPublications: this.#publicationEntries(state).length,
          pending: state.pending
            ? {
                request: state.pending.request,
                expired: state.pending.request.expiresAt <= this.#now(),
              }
            : null,
          approvals: state.approvals.map((item) => ({
            pairingId: item.request.pairingId,
            deviceId: item.request.device.deviceId,
            expiresAt: item.request.expiresAt,
            fingerprint: item.fingerprint,
          })),
        })
      : { revision: null, phase: 'empty' as const };
  }
  async encryptionKey(): Promise<CryptoKey> {
    this.#assert();
    const revision = this.#revision;
    if (!this.current() || !this.#state) fail();
    const key = await importDevicePrivateJwk(this.#state.privateKey);
    this.#assert(revision);
    return key;
  }
  /** Public metadata only. Reading never publishes, acknowledges or advances trust. */
  publications() {
    const { state, revision } = this.#active();
    return structuredClone({
      revision,
      pin: state.pin,
      rootPublicKey: state.trust!.rootPublicKey,
      entries: this.#publicationEntries(state),
    });
  }
  /** A matching relay storage receipt changes bookkeeping only, never cryptographic authority. */
  ackPublications(input: { expectedRevision: number; checkpoints: TrustCheckpoint[] }) {
    try {
      const expected = z.number().int().positive().safe().parse(input.expectedRevision),
        checkpoints = z
          .array(trustCheckpointSchema)
          .min(1)
          .max(DEVICE_MANAGER_LIMITS.publications)
          .parse(input.checkpoints);
      const { state, trust } = this.#active();
      this.#assert(expected);
      const entries = this.#publicationEntries(state);
      if (
        checkpoints.length > entries.length ||
        checkpoints.some((checkpoint, index) => !same(checkpoint, entries[index]!.checkpoint))
      )
        fail();
      this.#write(expected, { ...state, publications: entries.slice(checkpoints.length) }, trust);
      return this.status();
    } catch {
      return fail();
    }
  }
  /** Verify a whole contiguous page before one durable update; failures cannot partially install it. */
  async installTrustBatch(
    input: { expectedRevision: number; entries: DevicePublicTrust[] },
    options: { current?: () => void } = {},
  ) {
    try {
      options.current?.();
      const expected = z.number().int().positive().safe().parse(input.expectedRevision),
        entries = z
          .array(publicTrustSchema)
          .max(TRUST_PUBLICATION_LIMITS.pageEntries)
          .parse(input.entries);
      const { state, trust } = this.#active();
      this.#assert(expected);
      let next = trust;
      let latest = state.trust!;
      for (const entry of entries) {
        assertPin(entry.pin, state.pin);
        if (!same(entry.rootPublicKey, state.trust!.rootPublicKey)) fail();
        if (entry.checkpoint.epoch !== next.checkpoint.epoch + 1) fail();
        next = await VerifiedTrust.verify({
          signed: entry.signedManifest,
          rootPublicKey: entry.rootPublicKey,
          pin: state.pin,
          previous: next.checkpoint,
        });
        options.current?.();
        if (!same(next.checkpoint, entry.checkpoint)) fail();
        latest = entry;
      }
      this.#assert(expected);
      options.current?.();
      if (!entries.length) return this.status();
      this.#write(
        expected,
        { ...state, trust: latest, publications: this.#publicationEntries(state) },
        next,
      );
      return this.status();
    } catch {
      return fail();
    }
  }
  async initialize(identity: InitialIdentity, recoveryKey: string) {
    try {
      const input = identitySchema.parse(identity),
        code = e2eeDigestSchema.parse(recoveryKey);
      this.#assert(null);
      const [root, own] = await Promise.all([
        generateTrustRoot(),
        newDevice(input.deviceId, input.roles),
      ]);
      const pin = pinOf({ ...input, rootKeyId: root.keyId });
      const signedManifest = await signTrustManifest({
        manifest: { ...pin, version: 1, epoch: 1, previous: null, devices: [own.device] },
        rootPublicKey: root.publicKey,
        rootPrivateKey: root.privateKey,
      });
      const trust = await VerifiedTrust.verify({
        signed: signedManifest,
        rootPublicKey: root.publicKey,
        pin,
      });
      const recoveryCapsule = await encryptRecovery({
        recoveryKey: code,
        payload: {
          version: 1,
          pin,
          rootPublicKey: root.publicKey,
          rootPrivateKey: await exportRootPrivateJwk(root.privateKey),
          checkpoint: trust.checkpoint,
          signedManifest,
        },
      });
      this.#write(
        null,
        {
          version: 1,
          pin,
          ...own,
          trust: publicTrust(trust, root.publicKey, signedManifest),
          pending: null,
          recoveryCapsule,
          approvals: [],
          publications: [publicTrust(trust, root.publicKey, signedManifest)],
        },
        trust,
      );
      return this.status();
    } catch {
      return fail();
    }
  }
  async beginPairing(input: { pin: TrustPin; deviceId: string; roles: Roles }) {
    try {
      const pin = trustPinSchema.parse(input.pin),
        identity = identitySchema.parse({
          accountId: pin.accountId,
          serverOrigin: pin.serverOrigin,
          deviceId: input.deviceId,
          roles: input.roles,
        });
      this.#assert(null);
      const own = await newDevice(identity.deviceId, identity.roles);
      const request = await createPairingRequest({ pin, device: own.device, now: this.#now() });
      const fingerprint = await fingerprintRequest(request);
      this.#write(null, {
        version: 1,
        pin,
        ...own,
        trust: null,
        pending: { request, privateKey: own.privateKey },
        recoveryCapsule: null,
        approvals: [],
        publications: [],
      });
      return { ...this.status(), fingerprint };
    } catch {
      return fail();
    }
  }
  async requestKeyRotation(expectedRevision: number) {
    try {
      const { state, trust } = this.#active();
      this.#assert(expectedRevision);
      if (!this.#isDeviceCurrent() || state.pending) fail();
      const own = await newDevice(state.device.deviceId, state.device.roles);
      const request = await createPairingRequest({
        pin: state.pin,
        device: own.device,
        now: this.#now(),
      });
      const fingerprint = await fingerprintRequest(request);
      this.#write(
        expectedRevision,
        { ...state, pending: { request, privateKey: own.privateKey } },
        trust,
      );
      return { ...this.status(), fingerprint };
    } catch {
      return fail();
    }
  }
  async renewPairing(expectedRevision: number) {
    try {
      this.#assert(expectedRevision);
      const state = this.#state;
      if (!state?.pending) fail();
      const request = await createPairingRequest({
        pin: state.pin,
        device: state.pending.request.device,
        now: this.#now(),
      });
      const fingerprint = await fingerprintRequest(request);
      this.#write(
        expectedRevision,
        { ...state, pending: { ...state.pending, request } },
        this.#trust,
      );
      return { ...this.status(), fingerprint };
    } catch {
      return fail();
    }
  }
  cancelRotation(expectedRevision: number) {
    try {
      const { state, trust } = this.#active();
      this.#assert(expectedRevision);
      if (!state.pending) fail();
      this.#write(expectedRevision, { ...state, pending: null }, trust);
      return this.status();
    } catch {
      return fail();
    }
  }
  async acceptPairing(input: {
    expectedRevision: number;
    approval: string;
    rootPublicKey: RootPublicJwk;
    signedManifest: string;
  }) {
    try {
      const expected = input.expectedRevision,
        approval = input.approval,
        root = rootPublicJwkSchema.parse(input.rootPublicKey),
        signed = input.signedManifest;
      this.#assert(expected);
      const state = this.#state;
      if (!state?.pending) fail();
      const pending = state.pending;
      const trust = await verifyPairingApproval({
        request: pending.request,
        expectedRootPin: state.pin,
        approval,
        rootPublicKey: root,
        signedManifest: signed,
        now: this.#now(),
      });
      if (
        this.#trust &&
        (trust.checkpoint.epoch < this.#trust.checkpoint.epoch ||
          (trust.checkpoint.epoch === this.#trust.checkpoint.epoch &&
            trust.checkpoint.digest !== this.#trust.checkpoint.digest))
      )
        fail();
      if (pending.request.expiresAt <= this.#now()) fail();
      this.#write(
        expected,
        {
          ...state,
          device: pending.request.device,
          privateKey: pending.privateKey,
          pending: null,
          trust: publicTrust(trust, root, signed),
          publications: this.#publicationEntries(state),
        },
        trust,
      );
      return this.status();
    } catch {
      return fail();
    }
  }
  async #unlock(state: State, recoveryKey: string): Promise<RecoveryPayload> {
    if (!state.recoveryCapsule) fail();
    const recovered = await decryptRecovery({ capsule: state.recoveryCapsule, recoveryKey });
    assertPin(recovered.pin, state.pin);
    if (
      !state.trust ||
      !same(recovered.rootPublicKey, state.trust.rootPublicKey) ||
      recovered.checkpoint.epoch > state.trust.checkpoint.epoch ||
      (recovered.checkpoint.epoch === state.trust.checkpoint.epoch &&
        recovered.checkpoint.digest !== state.trust.checkpoint.digest)
    )
      fail();
    return recovered;
  }
  async #nextTrust(
    state: State,
    trust: VerifiedTrust,
    root: RecoveryPayload,
    devices: TrustedDevice[],
    code: string,
  ) {
    const rootKey = await importRootPrivateJwk(root.rootPrivateKey);
    const manifest = trustManifestSchema.parse({
      ...trust.manifest,
      epoch: trust.checkpoint.epoch + 1,
      previous: trust.checkpoint.digest,
      devices,
    });
    const signed = await signTrustManifest({
      manifest,
      rootPrivateKey: rootKey,
      rootPublicKey: root.rootPublicKey,
    });
    const next = await VerifiedTrust.verify({
      signed,
      rootPublicKey: root.rootPublicKey,
      pin: state.pin,
      previous: trust.checkpoint,
    });
    const capsule = await encryptRecovery({
      recoveryKey: code,
      payload: { ...root, checkpoint: next.checkpoint, signedManifest: signed },
    });
    return { rootKey, trust: next, public: publicTrust(next, root.rootPublicKey, signed), capsule };
  }
  async approvePairing(input: {
    expectedRevision: number;
    request: PairingRequest;
    expectedFingerprint: string;
    expectedDeviceKeyId: string | null;
    recoveryKey: string;
  }): Promise<DevicePairingReceipt> {
    try {
      const expected = input.expectedRevision,
        code = e2eeDigestSchema.parse(input.recoveryKey),
        fingerprint = e2eeDigestSchema.parse(input.expectedFingerprint),
        previousKey = e2eeDigestSchema.nullable().parse(input.expectedDeviceKeyId),
        raw = pairingRequestSchema.parse(input.request);
      const { state, trust, revision } = this.#active();
      const request = await parsePairingRequest(raw, this.#now());
      assertPin(state.pin, request);
      if ((await fingerprintRequest(request)) !== fingerprint) fail();
      const root = await this.#unlock(state, code);
      const receipts = this.#receipts(state);
      const original = receipts.find((item) => item.request.pairingId === request.pairingId);
      if (original) {
        this.#assert(revision);
        const current = trust.manifest.devices.find(
          (item) => item.deviceId === request.device.deviceId,
        );
        if (
          !same(original.request, request) ||
          original.fingerprint !== fingerprint ||
          !sameDevice(current, request.device)
        )
          fail();
        return structuredClone(original);
      }
      this.#assert(expected);
      if (receipts.length >= DEVICE_MANAGER_LIMITS.approvals) fail();
      const existing = trust.manifest.devices.find(
        (item) => item.deviceId === request.device.deviceId,
      );
      if ((existing?.keyId ?? null) !== previousKey) fail();
      const devices = [
        ...trust.manifest.devices.filter((item) => item.deviceId !== request.device.deviceId),
        request.device,
      ];
      const next = await this.#nextTrust(state, trust, root, devices, code);
      const approval = await signPairingApproval({
        request,
        expectedFingerprint: fingerprint,
        trust: next.trust,
        rootPublicKey: root.rootPublicKey,
        rootPrivateKey: next.rootKey,
        now: this.#now(),
      });
      const receipt = receiptSchema.parse({ request, fingerprint, approval, trust: next.public });
      if (request.expiresAt <= this.#now()) fail();
      // Approval and its signed manifest become durable together before either is returned.
      this.#write(
        expected,
        {
          ...state,
          trust: next.public,
          recoveryCapsule: next.capsule,
          approvals: [...receipts, receipt],
          publications: this.#appendPublication(state, next.public),
        },
        next.trust,
      );
      return structuredClone(receipt);
    } catch {
      return fail();
    }
  }
  async revokeDevice(input: {
    expectedRevision: number;
    deviceId: string;
    expectedKeyId: string;
    recoveryKey: string;
  }) {
    try {
      const expected = input.expectedRevision,
        id = e2eeIdSchema.parse(input.deviceId),
        keyId = e2eeDigestSchema.parse(input.expectedKeyId),
        code = e2eeDigestSchema.parse(input.recoveryKey);
      const { state, trust } = this.#active();
      this.#assert(expected);
      if (trust.manifest.devices.find((item) => item.deviceId === id)?.keyId !== keyId) fail();
      const root = await this.#unlock(state, code);
      const next = await this.#nextTrust(
        state,
        trust,
        root,
        trust.manifest.devices.filter((item) => item.deviceId !== id),
        code,
      );
      this.#write(
        expected,
        {
          ...state,
          trust: next.public,
          recoveryCapsule: next.capsule,
          approvals: this.#receipts(state),
          publications: this.#appendPublication(state, next.public),
        },
        next.trust,
      );
      return this.status();
    } catch {
      return fail();
    }
  }
  async installTrust(input: { expectedRevision: number; signedManifest: string }) {
    try {
      const expected = input.expectedRevision,
        signed = z
          .string()
          .max(64 * 1024)
          .parse(input.signedManifest);
      const { state, trust } = this.#active();
      this.#assert(expected);
      const next = await VerifiedTrust.verify({
        signed,
        rootPublicKey: state.trust!.rootPublicKey,
        pin: state.pin,
        previous: trust.checkpoint,
      });
      if (same(next.checkpoint, trust.checkpoint)) {
        this.#assert(expected);
        return this.status();
      }
      this.#write(
        expected,
        {
          ...state,
          trust: publicTrust(next, state.trust!.rootPublicKey, signed),
          publications: this.#publicationEntries(state),
        },
        next,
      );
      return this.status();
    } catch {
      return fail();
    }
  }
  async recoveryCapsule(recoveryKey: string): Promise<string> {
    try {
      const code = e2eeDigestSchema.parse(recoveryKey),
        { state, trust, revision } = this.#active();
      const root = await this.#unlock(state, code);
      const capsule = await encryptRecovery({
        recoveryKey: code,
        payload: {
          ...root,
          checkpoint: trust.checkpoint,
          signedManifest: state.trust!.signedManifest,
        },
      });
      this.#assert(revision);
      return capsule;
    } catch {
      return fail();
    }
  }
  /** Recover root authority into a new endpoint identity. Existing device private keys are never imported. */
  async recover(input: {
    capsule: string;
    recoveryKey: string;
    expectedPin: TrustPin;
    baseTrust: DevicePublicTrust;
    deviceId: string;
    roles: Roles;
    revokeDevices: { deviceId: string; keyId: string }[];
  }) {
    try {
      const capsule = z
          .string()
          .max(128 * 1024)
          .parse(input.capsule),
        code = e2eeDigestSchema.parse(input.recoveryKey),
        pin = trustPinSchema.parse(input.expectedPin),
        base = publicTrustSchema.parse(input.baseTrust),
        revoked = z
          .array(z.object({ deviceId: e2eeIdSchema, keyId: e2eeDigestSchema }).strict())
          .max(64)
          .parse(input.revokeDevices),
        identity = identitySchema.parse({
          accountId: pin.accountId,
          serverOrigin: pin.serverOrigin,
          deviceId: input.deviceId,
          roles: input.roles,
        });
      this.#assert(null);
      const root = await decryptRecovery({ capsule, recoveryKey: code });
      assertPin(root.pin, pin);
      assertPin(base.pin, pin);
      if (!same(base.rootPublicKey, root.rootPublicKey)) fail();
      const trust = await readTrust(base);
      if (
        trust.checkpoint.epoch < root.checkpoint.epoch ||
        (trust.checkpoint.epoch === root.checkpoint.epoch &&
          trust.checkpoint.digest !== root.checkpoint.digest)
      )
        fail();
      const backupTrust = await readTrust({
        pin: root.pin,
        rootPublicKey: root.rootPublicKey,
        checkpoint: root.checkpoint,
        signedManifest: root.signedManifest,
      });
      if (
        [...trust.manifest.devices, ...backupTrust.manifest.devices].some(
          (item) => item.deviceId === identity.deviceId,
        )
      )
        fail();
      if (
        new Set(revoked.map((item) => item.deviceId)).size !== revoked.length ||
        revoked.some(
          (item) =>
            trust.manifest.devices.find((device) => device.deviceId === item.deviceId)?.keyId !==
            item.keyId,
        )
      )
        fail();
      const own = await newDevice(identity.deviceId, identity.roles);
      const temporary: State = {
        version: 1,
        pin,
        ...own,
        trust: base,
        pending: null,
        recoveryCapsule: capsule,
        approvals: [],
        publications: [],
      };
      const next = await this.#nextTrust(
        temporary,
        trust,
        root,
        [
          ...trust.manifest.devices.filter(
            (device) => !revoked.some((item) => item.deviceId === device.deviceId),
          ),
          own.device,
        ],
        code,
      );
      this.#write(
        null,
        {
          ...temporary,
          trust: next.public,
          recoveryCapsule: next.capsule,
          publications: [next.public],
        },
        next.trust,
      );
      return this.status();
    } catch {
      return fail();
    }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#state = undefined;
    this.#trust = undefined;
    this.#file.close();
  }
}
