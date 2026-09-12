import { hostCommandSchema, type HostCommand } from '../bridge/host-command';
import { validateHostResponse } from '../host-response';
import { devicePublicKey } from './e2ee-crypto';
import {
  E2eeChannel,
  encryptedResourceSchema,
  newChannelChallenge,
  type EncryptedResource,
} from './e2ee-channel';
import { VerifiedTrust } from './e2ee-trust';
import {
  ENCRYPTED_BRIDGE_FAILED,
  ENCRYPTED_BRIDGE_LIMITS,
  encryptedBridgeClientMessageSchema,
  encryptedBridgeHelloSchema,
  encryptedCatalogSchema,
  encryptedHostResponseSchema,
  parseEncryptedBridgeMessage,
  type EncryptedBridgeHostDescriptor,
  type EncryptedCatalog,
  type EncryptedHostRequest,
} from './encrypted-bridge-protocol';

export interface EncryptedClientSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(value: string, callback?: (error?: Error) => void): void;
  close(code?: number): void;
  terminate?(): void;
}
export interface EncryptedClientOptions {
  socket: EncryptedClientSocket;
  trust: VerifiedTrust;
  clientDeviceId: string;
  privateKey: CryptoKey;
  current(): VerifiedTrust | undefined;
  signal?: AbortSignal;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(): never {
  throw new Error(ENCRYPTED_BRIDGE_FAILED);
}
function snapshot<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) snapshot(item);
    Object.freeze(value);
  }
  return value;
}
function wireText(raw: unknown, binary: unknown, limit: number) {
  if (binary === true) fail();
  if (typeof raw === 'string') {
    if (encoder.encode(raw).byteLength > limit) fail();
    return raw;
  }
  if (raw instanceof ArrayBuffer) raw = new Uint8Array(raw);
  if (!ArrayBuffer.isView(raw) || raw.byteLength > limit) fail();
  return decoder.decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
}
/** A verified Host rejection is distinct from an unverified relay/network failure. */
export class EncryptedHostError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rejected: boolean,
  ) {
    super(message);
  }
}
export function encryptedCommandResource(command: HostCommand): EncryptedResource {
  if (!command.localProjectId) fail();
  const params = command.params as Record<string, unknown>,
    request = params.request as Record<string, unknown> | undefined;
  const sessionId = params.sessionId ?? request?.sessionId;
  if (sessionId !== undefined && typeof sessionId !== 'string') fail();
  if (sessionId === undefined && !['sessions', 'agent-options'].includes(command.method)) fail();
  const scope = {
    workspaceId: command.workspaceId,
    projectId: command.localProjectId,
    catalogWorkspaceId: null,
    replicaId: null,
  };
  return encryptedResourceSchema.parse(
    sessionId === undefined
      ? { kind: 'project', ...scope, sessionId: null }
      : { kind: 'session', ...scope, sessionId },
  );
}
type Pending = {
  channel: E2eeChannel;
  resource: EncryptedResource;
  request: EncryptedHostRequest;
  hostId: string;
  catalog?: EncryptedCatalog;
  bytes: number;
  timer: unknown;
  resolving: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
};

/** A finite authenticated channel client, with no execution queue and no reconnection or retry. */
export class EncryptedBridgeClient {
  readonly #options: EncryptedClientOptions;
  readonly #timers: NonNullable<EncryptedClientOptions['timers']>;
  readonly #hosts = new Map<string, Readonly<EncryptedBridgeHostDescriptor>>();
  readonly #channels = new Map<string, Promise<E2eeChannel>>();
  readonly #catalogs = new Map<string, EncryptedCatalog>();
  readonly #pending = new Map<string, Pending>();
  #bytes = 0;
  #closed = false;
  #ready = false;
  #hello = false;
  #keyReady = false;
  #receivingBytes = 0;
  #readyResolve!: () => void;
  #readyReject!: (error: Error) => void;
  #closedReject!: (error: Error) => void;
  #handshake: unknown;
  readonly #readyPromise: Promise<void>;
  readonly #closedPromise: Promise<never>;
  readonly #abort = () => this.close();
  private constructor(options: EncryptedClientOptions) {
    this.#options = { ...options };
    this.#timers = options.timers ?? {
      set: (cb, ms) => setTimeout(cb, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.#readyPromise = new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#closedPromise = new Promise<never>((_, reject) => {
      this.#closedReject = reject;
    });
    void this.#closedPromise.catch(() => {});
    // The caller awaits the same rejection; attaching a handler also covers synchronous socket failures.
    void this.#readyPromise.catch(() => {});
    options.socket.on('open', () => this.#opened());
    options.socket.on('message', (raw, binary) => {
      void this.#message(raw, binary).catch(() => this.close());
    });
    options.socket.on('error', () => this.close());
    options.socket.on('close', () => this.close());
    options.signal?.addEventListener('abort', this.#abort, { once: true });
    this.#handshake = this.#timers.set(() => this.close(), ENCRYPTED_BRIDGE_LIMITS.handshakeMs);
  }
  static async connect(options: EncryptedClientOptions) {
    options = { ...options };
    const client = new EncryptedBridgeClient(options);
    try {
      client.assertCurrent();
      const own = options.trust.device(options.clientDeviceId, 'client');
      if (
        (await Promise.race([devicePublicKey(options.privateKey), client.#closedPromise])) !==
        own.publicKey
      )
        fail();
      client.assertCurrent();
      client.#keyReady = true;
      if (options.socket.readyState === 1) client.#opened();
      else if (options.socket.readyState !== 0) fail();
      await client.#readyPromise;
      client.assertCurrent();
      return client;
    } catch {
      client.close();
      return fail();
    }
  }
  assertCurrent() {
    const current = this.#options.current();
    if (
      this.#closed ||
      this.#options.signal?.aborted ||
      !(current instanceof VerifiedTrust) ||
      !same(current.checkpoint, this.#options.trust.checkpoint)
    )
      fail();
    current.device(this.#options.clientDeviceId, 'client');
  }
  #opened() {
    try {
      this.assertCurrent();
      if (this.#hello || !this.#keyReady) return;
      this.#hello = true;
      const own = this.#options.trust.device(this.#options.clientDeviceId, 'client'),
        cp = this.#options.trust.checkpoint;
      const hello = encryptedBridgeHelloSchema.parse({
        protocol: 4,
        type: 'hello',
        side: 'client',
        deviceId: own.deviceId,
        keyId: own.keyId,
        rootKeyId: cp.rootKeyId,
        trustEpoch: cp.epoch,
        trustDigest: cp.digest,
      });
      this.#send(JSON.stringify(hello));
    } catch {
      this.close();
    }
  }
  #send(text: string) {
    this.assertCurrent();
    if (
      this.#options.socket.readyState !== 1 ||
      this.#options.socket.bufferedAmount + encoder.encode(text).byteLength >
        ENCRYPTED_BRIDGE_LIMITS.pendingBytes
    )
      fail();
    this.#options.socket.send(text, (error) => {
      if (error) this.close();
    });
  }
  async #message(raw: unknown, binary: unknown) {
    this.assertCurrent();
    const bytes =
      typeof raw === 'string'
        ? encoder.encode(raw).byteLength
        : raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)
          ? raw.byteLength
          : NaN;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.#receivingBytes + this.#bytes + bytes > ENCRYPTED_BRIDGE_LIMITS.pendingBytes
    )
      fail();
    this.#receivingBytes += bytes;
    try {
      await this.#receive(raw, binary);
    } finally {
      this.#receivingBytes -= bytes;
    }
  }
  async #receive(raw: unknown, binary: unknown) {
    const message = encryptedBridgeClientMessageSchema.parse(
      parseEncryptedBridgeMessage(
        wireText(
          raw,
          binary,
          this.#ready ? ENCRYPTED_BRIDGE_LIMITS.wireBytes : ENCRYPTED_BRIDGE_LIMITS.readyBytes,
        ),
        false,
      ),
    );
    if (message.type === 'unavailable') {
      this.close();
      return;
    }
    if (message.type === 'ready') {
      if (this.#ready || !this.#hello) fail();
      const cp = this.#options.trust.checkpoint;
      for (const descriptor of message.hosts) {
        const host = this.#options.trust.device(descriptor.deviceId, 'host');
        if (
          descriptor.keyId !== host.keyId ||
          descriptor.rootKeyId !== cp.rootKeyId ||
          descriptor.trustEpoch !== cp.epoch ||
          descriptor.trustDigest !== cp.digest
        )
          fail();
        this.#hosts.set(host.deviceId, snapshot(descriptor));
      }
      this.assertCurrent();
      this.#ready = true;
      this.#timers.clear(this.#handshake);
      this.#readyResolve();
      return;
    }
    if (!this.#ready) fail();
    const record = message.record,
      pending = this.#pending.get(record.header.requestId);
    if (!pending || pending.resolving) fail();
    if (
      record.header.kind !== 'response' ||
      record.header.direction !== 'host-to-client' ||
      !same(record.header.binding, pending.channel.binding) ||
      !same(record.header.resource, pending.resource)
    )
      fail();
    pending.resolving = true;
    const current = () => {
      this.assertCurrent();
      pending.channel.assertCurrent();
      if (
        this.#pending.get(record.header.requestId) !== pending ||
        (pending.catalog && this.#catalogs.get(pending.hostId) !== pending.catalog)
      )
        fail();
    };
    current();
    const opened = await pending.channel.receive(record);
    current();
    const response = encryptedHostResponseSchema.parse(
      JSON.parse(decoder.decode(opened.plaintext)),
    );
    if (!response.ok) {
      current();
      this.#finish(record.header.requestId, pending);
      pending.reject(
        new EncryptedHostError(
          response.error.status,
          response.error.message,
          response.error.rejected,
        ),
      );
      return;
    }
    let result: unknown;
    if (pending.request.method === 'catalog') {
      result = snapshot(encryptedCatalogSchema.parse(response.result));
      current();
      this.#catalogs.set(pending.hostId, result as EncryptedCatalog);
    } else {
      const command = pending.request;
      const workspace = pending.catalog?.workspaces.find(
        (workspace) => workspace.id === command.workspaceId,
      );
      if (!workspace) fail();
      result = await validateHostResponse(response.result, {
        command,
        workspace,
        current,
      });
      current();
    }
    this.#finish(record.header.requestId, pending);
    pending.resolve(result);
  }
  #finish(id: string, pending: Pending) {
    this.#pending.delete(id);
    this.#bytes -= pending.bytes;
    this.#timers.clear(pending.timer);
  }
  hosts() {
    this.assertCurrent();
    if (!this.#ready) fail();
    return structuredClone([...this.#hosts.values()]);
  }
  async #channel(hostId: string) {
    this.assertCurrent();
    const host = this.#hosts.get(hostId);
    if (!host) fail();
    let pending = this.#channels.get(hostId);
    if (!pending) {
      if (this.#channels.size >= ENCRYPTED_BRIDGE_LIMITS.channels) fail();
      pending = E2eeChannel.create({
        side: 'client',
        trust: this.#options.trust,
        clientDeviceId: this.#options.clientDeviceId,
        hostDeviceId: hostId,
        hostChallenge: host.hostChallenge,
        clientChallenge: newChannelChallenge(),
        privateKey: this.#options.privateKey,
        current: () => {
          try {
            this.assertCurrent();
            return this.#options.current();
          } catch {
            return undefined;
          }
        },
      });
      this.#channels.set(hostId, pending);
    }
    return pending;
  }
  async #request(
    hostId: string,
    request: EncryptedHostRequest,
    resource: EncryptedResource,
    catalog?: EncryptedCatalog,
  ): Promise<unknown> {
    this.assertCurrent();
    if (!this.#ready || this.#pending.size >= ENCRYPTED_BRIDGE_LIMITS.pending) fail();
    const plaintext = encoder.encode(JSON.stringify(request));
    if (
      this.#bytes + this.#receivingBytes + plaintext.byteLength >
      ENCRYPTED_BRIDGE_LIMITS.pendingBytes
    )
      fail();
    // Reserve before awaiting key checks so concurrent callers cannot evade admission.
    const requestId = newChannelChallenge();
    let entry!: Pending;
    const result = new Promise<unknown>((resolve, reject) => {
      entry = {
        channel: undefined as unknown as E2eeChannel,
        request,
        resource,
        hostId,
        catalog,
        bytes: plaintext.byteLength,
        timer: undefined,
        resolving: false,
        resolve,
        reject,
      };
    });
    void result.catch(() => {});
    this.#pending.set(requestId, entry);
    this.#bytes += entry.bytes;
    entry.timer = this.#timers.set(() => this.close(), ENCRYPTED_BRIDGE_LIMITS.requestMs);
    void (async () => {
      entry.channel = await this.#channel(hostId);
      this.assertCurrent();
      if (this.#pending.get(requestId) !== entry) fail();
      const record = await entry.channel.send({ kind: 'request', requestId, resource, plaintext });
      this.assertCurrent();
      if (this.#pending.get(requestId) !== entry) fail();
      const text = JSON.stringify({ protocol: 4, type: 'record', record });
      if (encoder.encode(text).byteLength > ENCRYPTED_BRIDGE_LIMITS.wireBytes) fail();
      this.#send(text);
    })().catch(() => this.close());
    return result;
  }
  async catalog(hostId: string): Promise<EncryptedCatalog> {
    return (await this.#request(
      hostId,
      { method: 'catalog', params: {} },
      {
        kind: 'catalog',
        workspaceId: null,
        projectId: null,
        sessionId: null,
        catalogWorkspaceId: null,
        replicaId: null,
      },
    )) as EncryptedCatalog;
  }
  async execute(hostId: string, input: HostCommand): Promise<unknown> {
    const command = hostCommandSchema.parse(structuredClone(input)),
      catalog = this.#catalogs.get(hostId);
    if (!catalog) fail();
    const workspace = catalog.workspaces.find((workspace) => workspace.id === command.workspaceId);
    if (!workspace || !workspace.projects.some((project) => project.id === command.localProjectId))
      fail();
    return this.#request(hostId, snapshot(command), encryptedCommandResource(command), catalog);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.signal?.removeEventListener('abort', this.#abort);
    this.#timers.clear(this.#handshake);
    this.#readyReject(new Error(ENCRYPTED_BRIDGE_FAILED));
    this.#closedReject(new Error(ENCRYPTED_BRIDGE_FAILED));
    for (const pending of this.#pending.values()) {
      this.#timers.clear(pending.timer);
      pending.reject(new Error(ENCRYPTED_BRIDGE_FAILED));
    }
    this.#pending.clear();
    this.#bytes = 0;
    this.#catalogs.clear();
    for (const channel of this.#channels.values())
      void channel.then(
        (value) => value.close(),
        () => {},
      );
    try {
      if (this.#options.socket.terminate) this.#options.socket.terminate();
      else this.#options.socket.close(1000);
    } catch {}
  }
}
