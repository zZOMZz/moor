import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { WebSocket, type ClientOptions } from 'ws';
import { z } from 'zod';
import { actorSchema } from '../attention';
import { id } from '../protocol';
import { snapshotSecureInput } from '../desktop/secure-input.cjs';
import { DeviceManager } from './device-manager';
import {
  EncryptedBridgeClient,
  EncryptedHostError,
  type EncryptedClientSocket,
} from './encrypted-bridge-client';
import { ENCRYPTED_BRIDGE_LIMITS, ENCRYPTED_BRIDGE_PATHS } from './encrypted-bridge-protocol';
import { e2eeIdSchema, e2eeOriginSchema, type VerifiedTrust } from './e2ee-trust';
import { assertPrivatePathsOutsideProjects } from './private-project-path';
import {
  DESKTOP_SECURE_FAILED,
  DESKTOP_SECURE_INVALID,
  DESKTOP_SECURE_LIMITS,
  desktopSecureRequestSchema,
  desktopSecureStatusSchema,
  type DesktopSecureResult,
  type DesktopSecureStatus,
} from './desktop-client-protocol';

export type DesktopAccount = {
  origin: string;
  owner: string;
  cookie: string;
  current(): void;
};
export type DesktopSecureOptions = {
  endpointPath: string;
  authenticate(): Promise<DesktopAccount>;
  socket?(url: URL, options: ClientOptions): EncryptedClientSocket;
  deadline?(ms: number): AbortSignal;
};
const accountSchema = z
  .object({
    origin: e2eeOriginSchema,
    owner: e2eeIdSchema,
    cookie: z.string().regex(/^personal=[A-Za-z0-9_-]{20,200}$/),
  })
  .strict();
const identitySchema = z
  .object({
    owner: e2eeIdSchema,
    actor: actorSchema.optional(),
    attentionFeatures: z.array(id).max(64).optional(),
    needsSetup: z.literal(false),
    localOnly: z.literal(false).optional(),
    google: z
      .object({
        enabled: z.boolean(),
        linked: z
          .object({ email: z.string().max(320) })
          .strict()
          .nullable()
          .optional(),
        hasPassword: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.actor || (value.actor.kind === 'relay' && value.actor.accountId === value.owner),
  );
function fail(): never {
  throw new Error(DESKTOP_SECURE_FAILED);
}
function failure(code: 'invalid-request' | 'unavailable' = 'unavailable'): DesktopSecureResult {
  return {
    ok: false,
    error: {
      code,
      message: code === 'invalid-request' ? DESKTOP_SECURE_INVALID : DESKTOP_SECURE_FAILED,
      status: null,
      // A local failure is never a Host receipt, including a close after a write was sent.
      rejected: false,
    },
  };
}
async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return fail();
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error(DESKTOP_SECURE_FAILED));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Main-process helper: the account comes only from the bounded, fixed identity response. */
export async function authenticateDesktopAccount(
  input: { origin: string; cookie: string; current(): void },
  options: { request?: typeof fetch; deadline?: (ms: number) => AbortSignal } = {},
): Promise<DesktopAccount> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  try {
    const origin = e2eeOriginSchema.parse(input.origin),
      cookie = accountSchema.shape.cookie.parse(input.cookie),
      current = input.current,
      signal = (options.deadline ?? AbortSignal.timeout)(DESKTOP_SECURE_LIMITS.deadlineMs);
    const assertCurrent = () => {
      if (signal.aborted) fail();
      current();
    };
    assertCurrent();
    const url = origin + '/api/me';
    const fetching = (options.request ?? fetch)(url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal,
      headers: { Accept: 'application/json', Origin: origin, Cookie: cookie },
    }).then((value) => {
      try {
        assertCurrent();
        return value;
      } catch {
        void value.body?.cancel().catch(() => {});
        return fail();
      }
    });
    response = await bounded(fetching, signal);
    assertCurrent();
    const length = response.headers.get('content-length');
    if (
      !response.ok ||
      response.redirected ||
      (response.url && response.url !== url) ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
      (length !== null &&
        (!/^\d+$/.test(length) || Number(length) > DESKTOP_SECURE_LIMITS.identityBytes))
    )
      fail();
    reader = response.body?.getReader();
    if (!reader) fail();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await bounded(reader.read(), signal);
      assertCurrent();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (
        size > DESKTOP_SECURE_LIMITS.identityBytes ||
        chunks.length >= DESKTOP_SECURE_LIMITS.identityChunks
      )
        fail();
      // Own only the admitted bytes, not an arbitrarily large backing buffer.
      chunks.push(Uint8Array.from(chunk.value));
    }
    const identity = identitySchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
      ),
    );
    assertCurrent();
    return Object.freeze({ origin, owner: identity.owner, cookie, current });
  } catch {
    if (reader) void reader.cancel().catch(() => {});
    else void response?.body?.cancel().catch(() => {});
    return fail();
  } finally {
    reader?.releaseLock();
  }
}

type Connection = {
  id: string;
  generation: number;
  abort: AbortController;
  account?: DesktopAccount;
  endpoint?: DeviceManager;
  trust?: VerifiedTrust;
  client?: EncryptedBridgeClient;
  socket?: EncryptedClientSocket;
};

/** One main-owned endpoint and channel. There is no outbox, reconnect, fallback or replay here. */
export class DesktopSecureClient {
  readonly #options: DesktopSecureOptions;
  #manager?: DeviceManager;
  #opening?: Promise<DeviceManager>;
  #connection?: Connection;
  #generation = 0;
  #closed = false;
  #pending = 0;
  #pendingBytes = 0;
  #lifetime = new AbortController();

  constructor(options: DesktopSecureOptions) {
    if (!isAbsolute(options.endpointPath)) fail();
    this.#options = { ...options };
  }
  #assertGeneration(generation: number) {
    if (this.#closed || generation !== this.#generation) fail();
  }
  async #endpoint(generation: number): Promise<DeviceManager> {
    this.#assertGeneration(generation);
    if (this.#manager) return this.#manager;
    if (!this.#opening) {
      const opening = DeviceManager.open(this.#options.endpointPath).then((manager) => {
        if (this.#closed || generation !== this.#generation) {
          manager.close();
          return fail();
        }
        this.#manager = manager;
        return manager;
      });
      this.#opening = opening;
      void opening
        .finally(() => {
          if (this.#opening === opening) this.#opening = undefined;
        })
        .catch(() => {});
    }
    const manager = await this.#opening;
    this.#assertGeneration(generation);
    return manager;
  }
  #assertAttempt(connection: Connection) {
    this.#assertGeneration(connection.generation);
    if (this.#connection !== connection || connection.abort.signal.aborted) fail();
  }
  #assertConnection(connection: Connection, connected = true) {
    this.#assertAttempt(connection);
    const { account, endpoint, trust } = connection;
    if (!account || !endpoint || !trust) fail();
    account.current();
    const current = endpoint.current();
    if (
      !current ||
      JSON.stringify(current.checkpoint) !== JSON.stringify(trust.checkpoint) ||
      current.checkpoint.accountId !== account.owner ||
      current.checkpoint.serverOrigin !== account.origin
    )
      fail();
    if (connected) {
      if (!connection.client) fail();
      connection.client.assertCurrent();
    }
  }
  #dropConnection(connection: Connection) {
    if (this.#connection === connection) this.#connection = undefined;
    connection.abort.abort();
    connection.client?.close();
    if (!connection.client)
      try {
        if (connection.socket?.terminate) connection.socket.terminate();
        else connection.socket?.close(1000);
      } catch {}
  }
  #status(manager: DeviceManager): DesktopSecureStatus {
    const state = manager.status(),
      connection = this.#connection;
    if (connection?.client) this.#assertConnection(connection);
    return desktopSecureStatusSchema.parse({
      device:
        'device' in state
          ? {
              phase: state.phase,
              revision: state.revision,
              pin: state.pin,
              deviceId: state.device.deviceId,
              roles: state.device.roles,
              trustEpoch: state.trust?.checkpoint.epoch ?? null,
            }
          : { phase: 'empty', revision: null },
      connecting: !!connection && !connection.client,
      connection: connection?.client
        ? {
            connectionId: connection.id,
            phase: 'connected',
            hosts: connection.client.hosts(),
            verified: false,
          }
        : null,
    });
  }
  async #connect(connection: Connection): Promise<DesktopSecureStatus> {
    const endpoint = await this.#endpoint(connection.generation);
    this.#assertAttempt(connection);
    connection.endpoint = endpoint;
    const state = endpoint.status(),
      trust = endpoint.current();
    if (state.phase !== 'active' || !('device' in state) || !trust) fail();
    trust.device(state.device.deviceId, 'client');
    const authenticated = await this.#options.authenticate();
    this.#assertAttempt(connection);
    const account = Object.freeze({
      ...accountSchema.parse({
        origin: authenticated.origin,
        owner: authenticated.owner,
        cookie: authenticated.cookie,
      }),
      current: authenticated.current,
    });
    connection.account = account;
    connection.trust = trust;
    this.#assertConnection(connection, false);
    const privateKey = await endpoint.encryptionKey();
    this.#assertConnection(connection, false);
    const url = new URL(ENCRYPTED_BRIDGE_PATHS.client, account.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = (this.#options.socket ?? ((url, options) => new WebSocket(url, options)))(url, {
      headers: { Origin: account.origin, Cookie: account.cookie },
      maxPayload: ENCRYPTED_BRIDGE_LIMITS.wireBytes,
      perMessageDeflate: false,
      followRedirects: false,
    });
    connection.socket = socket;
    this.#assertConnection(connection, false);
    const client = await EncryptedBridgeClient.connect({
      socket,
      trust,
      privateKey,
      clientDeviceId: state.device.deviceId,
      signal: connection.abort.signal,
      current: () => {
        this.#assertConnection(connection, false);
        return endpoint.current();
      },
    });
    // A close during the asynchronous key/hello setup must also release the late client.
    connection.client = client;
    this.#assertConnection(connection);
    socket.on('close', () => this.#dropConnection(connection));
    socket.on('error', () => this.#dropConnection(connection));
    return this.#status(endpoint);
  }
  async request(input: unknown): Promise<DesktopSecureResult> {
    if (this.#closed || this.#pending >= DESKTOP_SECURE_LIMITS.pending) return failure();
    let request: ReturnType<typeof desktopSecureRequestSchema.parse>;
    let bytes: number;
    try {
      const snapshot = snapshotSecureInput(
        input,
        Math.min(
          DESKTOP_SECURE_LIMITS.requestBytes,
          DESKTOP_SECURE_LIMITS.pendingBytes - this.#pendingBytes,
        ),
      );
      bytes = snapshot.bytes;
      request = desktopSecureRequestSchema.parse(snapshot.value);
    } catch {
      return failure('invalid-request');
    }
    if (
      this.#closed ||
      this.#pending >= DESKTOP_SECURE_LIMITS.pending ||
      this.#pendingBytes + bytes > DESKTOP_SECURE_LIMITS.pendingBytes
    )
      return failure();
    const generation = this.#generation;
    let connection: Connection | undefined;
    if (request.action === 'connect') {
      if (this.#connection) return failure();
      connection = {
        id: randomUUID(),
        generation,
        abort: new AbortController(),
      };
      this.#connection = connection;
    } else if ('connectionId' in request) {
      connection = this.#connection;
      if (!connection?.client || connection.id !== request.connectionId) return failure();
    } else connection = this.#connection;
    this.#pending++;
    this.#pendingBytes += bytes;
    let signal: AbortSignal;
    try {
      signal = AbortSignal.any([
        this.#lifetime.signal,
        (this.#options.deadline ?? AbortSignal.timeout)(DESKTOP_SECURE_LIMITS.deadlineMs),
        ...(connection ? [connection.abort.signal] : []),
      ]);
    } catch {
      this.#pending--;
      this.#pendingBytes -= bytes;
      this.invalidate();
      return failure();
    }
    const expired = () => {
      if (generation === this.#generation) this.invalidate();
    };
    signal.addEventListener('abort', expired, { once: true });
    try {
      const run = async () => {
        this.#assertGeneration(generation);
        if (signal.aborted) fail();
        if (request.action === 'connect') return this.#connect(connection!);
        if (request.action === 'status') return this.#status(await this.#endpoint(generation));
        this.#assertConnection(connection!);
        const client = connection!.client!;
        if (request.action === 'disconnect') return { disconnected: true };
        if (request.action === 'catalog') {
          const catalog = await client.catalog(request.hostId);
          this.#assertConnection(connection!);
          assertPrivatePathsOutsideProjects(
            [this.#options.endpointPath],
            catalog.workspaces.flatMap((workspace) => workspace.projects.map((p) => p.rootPath)),
          );
          return catalog;
        }
        if (request.action === 'execute')
          return client.execute(request.hostId, request.command, request.target);
        if (request.action === 'legacy-operation') {
          if (request.command.method !== 'session-operations') fail();
          return client.executeLegacyOperation(request.hostId, request.command);
        }
        if (request.action === 'catalog-action')
          return client.catalogAction(request.hostId, request.request);
        return client.catalogOperation(request.hostId, request.operation);
      };
      const value = await bounded(run(), signal);
      this.#assertGeneration(generation);
      if (signal.aborted) fail();
      if (connection) {
        if (connection.client) this.#assertConnection(connection);
        else this.#assertAttempt(connection);
      } else this.#manager?.current();
      // Disconnect acknowledges only channel closure; it never decides an operation's outcome.
      if (request.action === 'disconnect') {
        signal.removeEventListener('abort', expired);
        this.#dropConnection(connection!);
      }
      return { ok: true, value };
    } catch (error) {
      let current = false;
      try {
        this.#assertGeneration(generation);
        if (signal.aborted) fail();
        if (connection) this.#assertConnection(connection);
        else this.#manager?.current();
        current = true;
      } catch {}
      if (current && error instanceof EncryptedHostError)
        return {
          ok: false,
          error: {
            code: 'host',
            message: error.rejected ? '主机明确拒绝了本次请求。' : DESKTOP_SECURE_FAILED,
            status: error.status,
            rejected: error.rejected,
          },
        };
      if (connection) this.#dropConnection(connection);
      if (!current && generation === this.#generation) this.invalidate();
      return failure();
    } finally {
      signal.removeEventListener('abort', expired);
      this.#pending--;
      this.#pendingBytes -= bytes;
    }
  }
  invalidate() {
    this.#generation++;
    const lifetime = this.#lifetime;
    this.#lifetime = new AbortController();
    const connection = this.#connection;
    if (connection) this.#dropConnection(connection);
    this.#manager?.close();
    this.#manager = undefined;
    lifetime.abort();
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.invalidate();
  }
}
