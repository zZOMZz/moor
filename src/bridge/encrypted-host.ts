import { isAbsolute, resolve } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import { DeviceManager } from '../security/device-manager';
import { PrivateEndpointFile } from '../security/private-endpoint-file';
import { assertPrivatePathsOutsideProjects } from '../security/private-project-path';
import { trustConnectionSchema, type TrustConnection } from '../security/trust-client';
import { type VerifiedTrust } from '../security/e2ee-trust';
import {
  E2eeChannel,
  E2EE_RECORD_LIMITS,
  newChannelChallenge,
  type EncryptedRecord,
} from '../security/e2ee-channel';
import { E2EE_CRYPTO_FAILED } from '../security/e2ee-crypto';
import {
  ENCRYPTED_BRIDGE_LIMITS,
  ENCRYPTED_BRIDGE_PATHS,
  encryptedBridgeHostRecordSchema as incomingRecordSchema,
  encryptedBridgeClientClosedSchema as clientClosedSchema,
  encryptedBridgeHostReadySchema,
  type EncryptedBridgeHostDescriptor,
} from '../security/encrypted-bridge-protocol';
import { HostCommandDispatcher } from './host-command';
import { EncryptedHostCommands, type EncryptedHostCatalog } from './encrypted-host-command';

export const ENCRYPTED_HOST_LIMITS = Object.freeze({
  activeChannels: ENCRYPTED_BRIDGE_LIMITS.channels,
  lifetimeChannels: ENCRYPTED_BRIDGE_LIMITS.channelHistory,
});
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function fail(): never {
  throw new Error(E2EE_CRYPTO_FAILED);
}
export type SecureHostEndpoint = {
  readonly connection: TrustConnection;
  readonly deviceId: string;
  readonly privateKey: CryptoKey;
  current(): VerifiedTrust;
  close(): void;
};

/** Retain both private file ownership leases for the whole Host lifetime. */
export async function openSecureHostEndpoint(options: {
  endpointFile: string;
  connectionFile: string;
  server?: string;
  /** Include registered projects and current or planned session worktree roots. */
  projectRoots?: () => readonly string[];
}): Promise<SecureHostEndpoint> {
  let manager: DeviceManager | undefined, file: PrivateEndpointFile | undefined;
  try {
    const paths = [options.endpointFile, options.connectionFile];
    if (paths.some((path) => !isAbsolute(path) || path !== resolve(path))) fail();
    if (paths[0] === paths[1]) fail();
    for (const path of paths)
      for (const suffix of ['.lock', '.lock-journal', '.lock-wal', '.lock-shm'])
        if (paths.includes(path + suffix)) fail();
    assertPrivatePathsOutsideProjects(paths, options.projectRoots?.() ?? []);
    manager = await DeviceManager.open(options.endpointFile);
    file = PrivateEndpointFile.open(options.connectionFile);
    const snapshot = file.load();
    if (!snapshot) fail();
    const connection = Object.freeze(trustConnectionSchema.parse(snapshot.value));
    if (options.server !== undefined && options.server !== connection.origin) fail();
    const status = manager.status();
    if (status.phase !== 'active' || !('device' in status)) fail();
    const deviceId = status.device.deviceId;
    const current = () => {
      if (!manager || !file || !same(file.load(), snapshot)) fail();
      assertPrivatePathsOutsideProjects(paths, options.projectRoots?.() ?? []);
      const trust = manager.current();
      if (
        !trust ||
        trust.checkpoint.accountId !== connection.owner ||
        trust.checkpoint.serverOrigin !== connection.origin ||
        trust.device(deviceId, 'host').keyId !== status.device.keyId
      )
        fail();
      return trust;
    };
    current();
    const privateKey = await manager.encryptionKey();
    current();
    return {
      connection,
      deviceId,
      privateKey,
      current,
      close() {
        manager?.close();
        file?.close();
        manager = undefined;
        file = undefined;
      },
    };
  } catch {
    manager?.close();
    file?.close();
    return fail();
  }
}

type Channel = {
  connectionId: string;
  active: boolean;
  receiver: Promise<EncryptedHostCommands>;
  channel?: E2eeChannel;
};

/** One underlying connection; no reconnect, queued requests, or plaintext fallback. */
export class EncryptedHostTransport {
  readonly socket: WebSocket;
  readonly #endpoint: SecureHostEndpoint;
  readonly #dispatcher: HostCommandDispatcher;
  readonly #catalog: () => EncryptedHostCatalog | Promise<EncryptedHostCatalog>;
  readonly #closedCallback?: () => void;
  readonly #hello;
  readonly #descriptor: EncryptedBridgeHostDescriptor;
  readonly #channels = new Map<string, Channel>();
  readonly #clients = new Map<string, Channel>();
  readonly #handshake: AbortSignal;
  readonly #handshakeExpired = () => {
    if (!this.#ready) this.close();
  };
  #closed = false;
  #ready = false;
  #pending = 0;
  #pendingBytes = 0;

  constructor(options: {
    endpoint: SecureHostEndpoint;
    dispatcher: HostCommandDispatcher;
    catalog: () => EncryptedHostCatalog | Promise<EncryptedHostCatalog>;
    closed?: () => void;
    /** Injectable deadline signal for deterministic transport tests. */
    deadline?: (ms: number) => AbortSignal;
  }) {
    this.#endpoint = options.endpoint;
    this.#dispatcher = options.dispatcher;
    this.#catalog = options.catalog;
    this.#closedCallback = options.closed;
    this.#handshake = (options.deadline ?? AbortSignal.timeout)(
      ENCRYPTED_BRIDGE_LIMITS.handshakeMs,
    );
    const trust = options.endpoint.current();
    const own = trust.device(options.endpoint.deviceId, 'host');
    this.#descriptor = Object.freeze({
      deviceId: own.deviceId,
      keyId: own.keyId,
      rootKeyId: trust.checkpoint.rootKeyId,
      trustEpoch: trust.checkpoint.epoch,
      trustDigest: trust.checkpoint.digest,
      hostChallenge: newChannelChallenge(),
    });
    this.#hello = {
      protocol: 4 as const,
      type: 'hello' as const,
      side: 'host' as const,
      ...this.#descriptor,
    };
    const url = new URL(ENCRYPTED_BRIDGE_PATHS.host, options.endpoint.connection.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(url, {
      headers: {
        Origin: options.endpoint.connection.origin,
        Cookie: options.endpoint.connection.cookie,
      },
      followRedirects: false,
      maxPayload: ENCRYPTED_BRIDGE_LIMITS.wireBytes,
      perMessageDeflate: false,
      handshakeTimeout: 30000,
    });
    this.socket.on('open', () => {
      try {
        this.#current();
        this.#send(this.#hello);
      } catch {
        this.close();
      }
    });
    this.socket.on('message', (raw, binary) => void this.#message(raw, binary));
    this.socket.on('error', () => this.close());
    this.socket.on('unexpected-response', (request, response) => {
      response.resume();
      request.destroy();
      this.close();
    });
    this.socket.once('close', () => this.close());
    this.#handshake.addEventListener('abort', this.#handshakeExpired, { once: true });
    if (this.#handshake.aborted) this.close();
  }
  get ready() {
    return !this.#closed && this.#ready;
  }
  #current() {
    if (this.#closed || this.socket.readyState !== WebSocket.OPEN) fail();
    const trust = this.#endpoint.current();
    if (
      trust.checkpoint.epoch !== this.#hello.trustEpoch ||
      trust.checkpoint.digest !== this.#hello.trustDigest ||
      trust.checkpoint.rootKeyId !== this.#hello.rootKeyId ||
      trust.device(this.#hello.deviceId, 'host').keyId !== this.#hello.keyId
    )
      fail();
    return trust;
  }
  #send(value: unknown) {
    this.#current();
    const text = JSON.stringify(value);
    if (
      Buffer.byteLength(text) > ENCRYPTED_BRIDGE_LIMITS.wireBytes ||
      this.socket.bufferedAmount + Buffer.byteLength(text) > ENCRYPTED_BRIDGE_LIMITS.wireBytes
    )
      fail();
    this.socket.send(text, (error) => {
      if (error) this.close();
    });
  }
  #retire(entry: Channel) {
    entry.active = false;
    entry.channel?.close();
    if (this.#clients.get(entry.connectionId) === entry) this.#clients.delete(entry.connectionId);
    // #channels deliberately retains the challenge tombstone until this socket closes.
  }
  #receiver(connectionId: string, record: EncryptedRecord): Channel {
    const trust = this.#current();
    const binding = record.header.binding;
    if (
      binding.accountId !== this.#endpoint.connection.owner ||
      binding.serverOrigin !== this.#endpoint.connection.origin ||
      binding.rootKeyId !== this.#hello.rootKeyId ||
      binding.trustEpoch !== this.#hello.trustEpoch ||
      binding.trustDigest !== this.#hello.trustDigest ||
      binding.hostDeviceId !== this.#hello.deviceId ||
      binding.hostKeyId !== this.#hello.keyId ||
      binding.hostChallenge !== this.#hello.hostChallenge ||
      record.header.direction !== 'client-to-host' ||
      record.header.kind !== 'request' ||
      trust.device(binding.clientDeviceId, 'client').keyId !== binding.clientKeyId
    )
      fail();
    const key = JSON.stringify(binding);
    const existing = this.#channels.get(key);
    if (existing) {
      if (!existing.active || existing.connectionId !== connectionId) fail();
      return existing;
    }
    if (
      this.#clients.has(connectionId) ||
      this.#clients.size >= ENCRYPTED_HOST_LIMITS.activeChannels ||
      this.#channels.size >= ENCRYPTED_HOST_LIMITS.lifetimeChannels
    ) {
      this.close();
      return fail();
    }
    const entry: Channel = { connectionId, active: true, receiver: undefined! };
    // Reserve before the first crypto await so parallel records share one receiver.
    this.#channels.set(key, entry);
    this.#clients.set(connectionId, entry);
    entry.receiver = E2eeChannel.create({
      side: 'host',
      trust,
      clientDeviceId: binding.clientDeviceId,
      hostDeviceId: binding.hostDeviceId,
      hostChallenge: binding.hostChallenge,
      clientChallenge: binding.clientChallenge,
      privateKey: this.#endpoint.privateKey,
      current: () => (entry.active ? this.#current() : undefined),
    }).then(
      (channel) => {
        entry.channel = channel;
        channel.assertCurrent();
        return new EncryptedHostCommands({
          channel,
          dispatcher: this.#dispatcher,
          catalog: this.#catalog,
          runtimeScopesOnly: true,
        });
      },
      () => {
        this.#retire(entry);
        return fail();
      },
    );
    return entry;
  }
  async #message(raw: RawData, binary: boolean) {
    let reserved = false;
    const byteLength = Array.isArray(raw)
      ? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
      : raw.byteLength;
    try {
      this.#current();
      if (
        binary ||
        this.#pending >= E2EE_RECORD_LIMITS.pending ||
        byteLength >
          (this.#ready
            ? ENCRYPTED_BRIDGE_LIMITS.wireBytes
            : ENCRYPTED_BRIDGE_LIMITS.handshakeBytes) ||
        this.#pendingBytes + byteLength > ENCRYPTED_BRIDGE_LIMITS.pendingBytes
      )
        fail();
      this.#pending++;
      this.#pendingBytes += byteLength;
      reserved = true;
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      if (bytes.byteLength > ENCRYPTED_BRIDGE_LIMITS.wireBytes) fail();
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      );
      if (!this.#ready) {
        const ready = encryptedBridgeHostReadySchema.parse(value);
        if (!same(ready.host, this.#descriptor)) fail();
        this.#ready = true;
        this.#handshake.removeEventListener('abort', this.#handshakeExpired);
        return;
      }
      const retired = clientClosedSchema.safeParse(value);
      if (retired.success) {
        const entry = this.#clients.get(retired.data.clientConnectionId);
        if (entry) this.#retire(entry);
        return;
      }
      const message = incomingRecordSchema.parse(value);
      const entry = this.#receiver(message.clientConnectionId, message.record);
      const receiver = await entry.receiver;
      const response = await receiver.execute(message.record);
      entry.channel!.assertCurrent();
      if (this.#clients.get(message.clientConnectionId) !== entry) fail();
      this.#send({
        protocol: 4,
        type: 'record',
        clientConnectionId: message.clientConnectionId,
        record: response,
      });
    } catch {
      // Invalid or expired traffic cannot reveal diagnostics. Retiring the whole
      // connection is safe: the host never replays a possibly accepted command.
      this.close();
    } finally {
      if (reserved) {
        this.#pending--;
        this.#pendingBytes -= byteLength;
      }
    }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    this.#handshake.removeEventListener('abort', this.#handshakeExpired);
    for (const entry of this.#channels.values()) this.#retire(entry);
    this.socket.terminate();
    this.#closedCallback?.();
  }
}
