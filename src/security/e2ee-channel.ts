import { z } from 'zod';
import { base64url } from 'jose';
import {
  devicePublicKey,
  E2EE_CRYPTO_FAILED,
  E2EE_CRYPTO_LIMITS,
  E2EE_CRYPTO_SUITE,
  E2EE_CRYPTO_VERSION,
  open,
  seal,
} from './e2ee-crypto';
import {
  e2eeDigestSchema,
  e2eeIdSchema,
  e2eeOriginSchema,
  e2eePublicKeySchema,
  VerifiedTrust,
} from './e2ee-trust';

const encoder = new TextEncoder();
const ciphertextCharacters = Math.ceil(
  ((E2EE_CRYPTO_LIMITS.plaintextBytes + E2EE_CRYPTO_LIMITS.tagBytes) * 4) / 3,
);
export const E2EE_RECORD_LIMITS = Object.freeze({
  replayWindow: 256,
  pending: 64,
  ciphertextCharacters,
  // Base64 expands the existing 48 MiB plaintext allowance. Transports must use this limit.
  wireBytes: ciphertextCharacters + 32 * 1024,
});

export const channelBindingSchema = z
  .object({
    accountId: e2eeIdSchema,
    serverOrigin: e2eeOriginSchema,
    rootKeyId: e2eeDigestSchema,
    trustEpoch: z.number().int().positive().safe(),
    trustDigest: e2eeDigestSchema,
    clientDeviceId: e2eeIdSchema,
    clientKeyId: e2eeDigestSchema,
    hostDeviceId: e2eeIdSchema,
    hostKeyId: e2eeDigestSchema,
    hostChallenge: e2eeDigestSchema,
    clientChallenge: e2eeDigestSchema,
  })
  .strict();
export type ChannelBinding = z.infer<typeof channelBindingSchema>;

const catalogBinding = {
  catalogWorkspaceId: e2eeIdSchema.nullable(),
  replicaId: e2eeIdSchema.nullable(),
};
export const encryptedResourceSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('catalog'),
        workspaceId: z.null(),
        projectId: z.null(),
        sessionId: z.null(),
        catalogWorkspaceId: z.null(),
        replicaId: z.null(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('project'),
        workspaceId: e2eeIdSchema,
        projectId: e2eeIdSchema,
        sessionId: z.null(),
        ...catalogBinding,
      })
      .strict(),
    z
      .object({
        kind: z.literal('session'),
        workspaceId: e2eeIdSchema,
        projectId: e2eeIdSchema,
        sessionId: e2eeIdSchema,
        ...catalogBinding,
      })
      .strict(),
  ])
  .refine((scope) => (scope.catalogWorkspaceId === null) === (scope.replicaId === null));
export type EncryptedResource = z.infer<typeof encryptedResourceSchema>;

export const encryptedRecordHeaderSchema = z
  .object({
    version: z.literal(E2EE_CRYPTO_VERSION),
    suite: z.literal(E2EE_CRYPTO_SUITE),
    binding: channelBindingSchema,
    direction: z.enum(['client-to-host', 'host-to-client']),
    kind: z.enum(['request', 'response', 'event']),
    sequence: z.number().int().positive().safe(),
    requestId: e2eeDigestSchema,
    resource: encryptedResourceSchema,
  })
  .strict()
  .refine((header) =>
    header.direction === 'client-to-host' ? header.kind === 'request' : header.kind !== 'request',
  );
export type EncryptedRecordHeader = z.infer<typeof encryptedRecordHeaderSchema>;
export const encryptedRecordSchema = z
  .object({
    header: encryptedRecordHeaderSchema,
    enc: e2eePublicKeySchema,
    ciphertext: z
      .string()
      .refine(
        (value) =>
          value.length >= 22 &&
          value.length <= E2EE_RECORD_LIMITS.ciphertextCharacters &&
          /^[A-Za-z0-9_-]+$/.test(value),
      ),
  })
  .strict();
export type EncryptedRecord = z.infer<typeof encryptedRecordSchema>;

function fail(): never {
  throw new Error(E2EE_CRYPTO_FAILED);
}
export function newChannelChallenge(): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
}
export function parseEncryptedRecord(text: string): EncryptedRecord {
  try {
    if (
      typeof text !== 'string' ||
      text.length > E2EE_RECORD_LIMITS.wireBytes ||
      encoder.encode(text).byteLength > E2EE_RECORD_LIMITS.wireBytes
    )
      fail();
    return encryptedRecordSchema.parse(JSON.parse(text));
  } catch {
    return fail();
  }
}
export function serializeEncryptedRecord(value: EncryptedRecord): string {
  try {
    const text = JSON.stringify(encryptedRecordSchema.parse(value));
    if (encoder.encode(text).byteLength > E2EE_RECORD_LIMITS.wireBytes) fail();
    return text;
  } catch {
    return fail();
  }
}

type ChannelOptions = {
  side: 'client' | 'host';
  trust: VerifiedTrust;
  clientDeviceId: string;
  hostDeviceId: string;
  /** Host generates a fresh challenge for every underlying connection. */
  hostChallenge: string;
  /** Client generates a fresh challenge for each channel; never reuse it after reconnect. */
  clientChallenge: string;
  privateKey: CryptoKey;
  /** Return the durably installed trust state only while the original connection is current. */
  current(): VerifiedTrust | undefined;
};

/**
 * Authenticated records, not an execution queue. Closing/reconnecting never resends anything.
 * The consumer validates the decrypted command/response and holds assertCurrent as its lease.
 * Long-lived HPKE recipient keys do not provide forward secrecy after endpoint key compromise.
 */
export class E2eeChannel {
  readonly binding: Readonly<ChannelBinding>;
  readonly #side: 'client' | 'host';
  readonly #privateKey: CryptoKey;
  readonly #peerPublicKey: string;
  readonly #current: ChannelOptions['current'];
  readonly #bindingJson: string;
  #closed = false;
  #sendSequence = 0;
  #sendPending = 0;
  #receiveMaximum = 0;
  readonly #received = new Set<number>();
  readonly #receiving = new Set<number>();

  private constructor(options: ChannelOptions, binding: ChannelBinding, peerPublicKey: string) {
    this.binding = Object.freeze(binding);
    this.#bindingJson = JSON.stringify(binding);
    this.#side = options.side;
    this.#privateKey = options.privateKey;
    this.#current = options.current;
    this.#peerPublicKey = peerPublicKey;
    Object.freeze(this);
  }

  static async create(input: ChannelOptions): Promise<E2eeChannel> {
    try {
      const options = { ...input };
      if (!(options.trust instanceof VerifiedTrust) || !['client', 'host'].includes(options.side))
        fail();
      const client = options.trust.device(options.clientDeviceId, 'client');
      const host = options.trust.device(options.hostDeviceId, 'host');
      const checkpoint = options.trust.checkpoint;
      const binding = channelBindingSchema.parse({
        accountId: checkpoint.accountId,
        serverOrigin: checkpoint.serverOrigin,
        rootKeyId: checkpoint.rootKeyId,
        trustEpoch: checkpoint.epoch,
        trustDigest: checkpoint.digest,
        clientDeviceId: client.deviceId,
        clientKeyId: client.keyId,
        hostDeviceId: host.deviceId,
        hostKeyId: host.keyId,
        hostChallenge: options.hostChallenge,
        clientChallenge: options.clientChallenge,
      });
      const own = options.side === 'client' ? client : host;
      const peer = options.side === 'client' ? host : client;
      const channel = new E2eeChannel(options, binding, peer.publicKey);
      channel.assertCurrent();
      if ((await devicePublicKey(options.privateKey)) !== own.publicKey) fail();
      channel.assertCurrent();
      return channel;
    } catch {
      return fail();
    }
  }

  assertCurrent(): void {
    try {
      const current = this.#current();
      if (
        this.#closed ||
        !(current instanceof VerifiedTrust) ||
        current.checkpoint.digest !== this.binding.trustDigest ||
        current.checkpoint.rootKeyId !== this.binding.rootKeyId ||
        current.checkpoint.epoch !== this.binding.trustEpoch ||
        current.checkpoint.accountId !== this.binding.accountId ||
        current.checkpoint.serverOrigin !== this.binding.serverOrigin
      )
        fail();
    } catch {
      return fail();
    }
  }

  close(): void {
    this.#closed = true;
    this.#received.clear();
  }

  async send(input: {
    kind: EncryptedRecordHeader['kind'];
    requestId: string;
    resource: EncryptedResource;
    plaintext: Uint8Array;
  }): Promise<EncryptedRecord> {
    let reserved = false;
    try {
      this.assertCurrent();
      if (
        this.#sendPending >= E2EE_RECORD_LIMITS.pending ||
        this.#sendSequence >= Number.MAX_SAFE_INTEGER
      )
        fail();
      const header = encryptedRecordHeaderSchema.parse({
        version: E2EE_CRYPTO_VERSION,
        suite: E2EE_CRYPTO_SUITE,
        binding: this.binding,
        direction: this.#side === 'client' ? 'client-to-host' : 'host-to-client',
        kind: input.kind,
        sequence: ++this.#sendSequence,
        requestId: input.requestId,
        resource: input.resource,
      });
      this.#sendPending++;
      reserved = true;
      const sealed = await seal({
        senderPrivateKey: this.#privateKey,
        recipientPublicKey: this.#peerPublicKey,
        plaintext: input.plaintext,
        aad: encoder.encode(JSON.stringify(header)),
      });
      this.assertCurrent();
      return { header, ...sealed };
    } catch {
      return fail();
    } finally {
      if (reserved) this.#sendPending--;
    }
  }

  async receive(value: unknown): Promise<{ header: EncryptedRecordHeader; plaintext: Uint8Array }> {
    let sequence: number | undefined;
    try {
      this.assertCurrent();
      const record = encryptedRecordSchema.parse(value);
      const incoming = this.#side === 'client' ? 'host-to-client' : 'client-to-host';
      const candidate = record.header.sequence;
      if (
        record.header.direction !== incoming ||
        JSON.stringify(record.header.binding) !== this.#bindingJson ||
        candidate <= this.#receiveMaximum - E2EE_RECORD_LIMITS.replayWindow ||
        this.#received.has(candidate) ||
        this.#receiving.has(candidate) ||
        this.#receiving.size >= E2EE_RECORD_LIMITS.pending
      )
        fail();
      // Reserve before the first await: simultaneous copies cannot both reach a dispatcher.
      sequence = candidate;
      this.#receiving.add(sequence);
      const plaintext = await open({
        senderPublicKey: this.#peerPublicKey,
        recipientPrivateKey: this.#privateKey,
        enc: record.enc,
        ciphertext: record.ciphertext,
        aad: encoder.encode(JSON.stringify(record.header)),
      });
      this.assertCurrent();
      if (sequence <= this.#receiveMaximum - E2EE_RECORD_LIMITS.replayWindow) fail();
      // Only an authenticated message can advance the replay window.
      this.#receiveMaximum = Math.max(this.#receiveMaximum, sequence);
      this.#received.add(sequence);
      for (const seen of this.#received) {
        if (seen <= this.#receiveMaximum - E2EE_RECORD_LIMITS.replayWindow)
          this.#received.delete(seen);
      }
      return { header: record.header, plaintext };
    } catch {
      return fail();
    } finally {
      if (sequence !== undefined) this.#receiving.delete(sequence);
    }
  }
}
