import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Store } from './accounts';
import { newChannelChallenge, type EncryptedRecordHeader } from '../security/e2ee-channel';
import {
  encryptedBridgeHelloSchema,
  encryptedBridgeClientRecordSchema,
  encryptedBridgeHostRecordSchema,
  ENCRYPTED_BRIDGE_LIMITS,
  ENCRYPTED_BRIDGE_PATHS,
  type EncryptedBridgeHello,
  type EncryptedBridgeHostDescriptor,
} from '../security/encrypted-bridge-protocol';

export type EncryptedBridgeTimers = {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
};
const defaultTimers: EncryptedBridgeTimers = {
  set(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

type Connection = {
  socket: WebSocket;
  id: string;
  owner: string;
  secret: string;
  origin: string;
  generation: number;
  side: 'host' | 'client';
  hello?: EncryptedBridgeHello;
  handshakeTimer?: unknown;
  alive: boolean;
};
type Pending = {
  client: Connection;
  host: Connection;
  header: EncryptedRecordHeader;
  bytes: number;
  timer: unknown;
};
const sameTrust = (left: EncryptedBridgeHello, right: EncryptedBridgeHello) =>
  left.rootKeyId === right.rootKeyId &&
  left.trustEpoch === right.trustEpoch &&
  left.trustDigest === right.trustDigest;
const hostKey = (owner: string, deviceId: string) => JSON.stringify([owner, deviceId]);
const pendingKey = (clientId: string, requestId: string) => JSON.stringify([clientId, requestId]);
const descriptor = (hello: EncryptedBridgeHello): EncryptedBridgeHostDescriptor => {
  if (hello.side !== 'host') throw new Error('unavailable');
  return {
    deviceId: hello.deviceId,
    keyId: hello.keyId,
    rootKeyId: hello.rootKeyId,
    trustEpoch: hello.trustEpoch,
    trustDigest: hello.trustDigest,
    hostChallenge: hello.hostChallenge,
  };
};

/** A finite, memory-only router. Public routing fields confer no endpoint trust. */
export class EncryptedBridgeRelay {
  readonly #options: {
    store: Pick<Store, 'owner'>;
    origin(): string;
    current?(): boolean;
    localOnly?: boolean;
  };
  readonly #timers: EncryptedBridgeTimers;
  readonly #wss = new WebSocketServer({
    noServer: true,
    maxPayload: ENCRYPTED_BRIDGE_LIMITS.wireBytes,
    perMessageDeflate: false,
  });
  readonly #connections = new Map<WebSocket, Connection>();
  readonly #clients = new Map<string, Connection>();
  readonly #hosts = new Map<string, Connection>();
  readonly #pending = new Map<string, Pending>();
  #pendingBytes = 0;
  #generation = 0;
  #closed = false;
  #heartbeat: unknown;

  constructor(options: {
    store: Pick<Store, 'owner'>;
    origin(): string;
    current?(): boolean;
    localOnly?: boolean;
    timers?: EncryptedBridgeTimers;
  }) {
    this.#options = options;
    this.#timers = options.timers ?? defaultTimers;
    this.#scheduleHeartbeat();
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    // Consume the entire v4 namespace so malformed paths cannot fall through to v3.
    if (!request.url?.startsWith('/bridge/v4')) return false;
    try {
      const side =
        request.url === ENCRYPTED_BRIDGE_PATHS.host
          ? 'host'
          : request.url === ENCRYPTED_BRIDGE_PATHS.client
            ? 'client'
            : undefined;
      if (
        !side ||
        this.#closed ||
        this.#options.localOnly ||
        this.#options.current?.() === false ||
        request.method !== 'GET' ||
        request.headers.origin !== this.#options.origin() ||
        request.headers['sec-websocket-protocol'] !== undefined ||
        this.#connections.size >= ENCRYPTED_BRIDGE_LIMITS.sockets
      )
        throw new Error('unavailable');
      const personal = (request.headers.cookie ?? '')
        .split(';')
        .map((value) => value.trim())
        .filter((value) => value.startsWith('personal='));
      if (personal.length !== 1 || !/^personal=[A-Za-z0-9_-]{43}$/.test(personal[0]))
        throw new Error('unavailable');
      const secret = personal[0].slice(9),
        owner = this.#options.store.owner(secret),
        origin = this.#options.origin(),
        generation = this.#generation;
      if (
        [...this.#connections.values()].filter((item) => item.owner === owner && item.side === side)
          .length >=
        (side === 'host' ? ENCRYPTED_BRIDGE_LIMITS.hosts : ENCRYPTED_BRIDGE_LIMITS.clients)
      )
        throw new Error('unavailable');
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        const connection: Connection = {
          socket: ws,
          id: newChannelChallenge(),
          owner,
          secret,
          origin,
          generation,
          side,
          alive: true,
        };
        this.#connections.set(ws, connection);
        ws.on('error', () => this.#drop(connection));
        ws.on('close', () => this.#drop(connection));
        ws.on('pong', () => {
          if (this.#current(connection)) connection.alive = true;
        });
        ws.on('message', (raw, binary) => this.#message(connection, raw, binary));
        connection.handshakeTimer = this.#timers.set(() => {
          if (!connection.hello) this.#drop(connection);
        }, ENCRYPTED_BRIDGE_LIMITS.handshakeMs);
        if (!this.#current(connection)) this.#drop(connection);
      });
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
    }
    return true;
  }

  invalidateLogin(secret: string): void {
    for (const connection of this.#connections.values())
      if (connection.secret === secret) this.#drop(connection);
  }

  invalidateOrigin(): void {
    this.#generation++;
    for (const connection of this.#connections.values()) this.#drop(connection);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#timers.clear(this.#heartbeat);
    for (const connection of this.#connections.values()) this.#drop(connection);
    this.#wss.close();
  }

  #current(connection: Connection): boolean {
    try {
      return (
        !this.#closed &&
        this.#options.current?.() !== false &&
        connection.generation === this.#generation &&
        connection.origin === this.#options.origin() &&
        this.#connections.get(connection.socket) === connection &&
        connection.socket.readyState === WebSocket.OPEN &&
        this.#options.store.owner(connection.secret) === connection.owner &&
        (!connection.hello ||
          (connection.side === 'host'
            ? this.#hosts.get(hostKey(connection.owner, connection.hello.deviceId)) === connection
            : this.#clients.get(connection.id) === connection))
      );
    } catch {
      return false;
    }
  }

  #message(connection: Connection, raw: RawData, binary: boolean): void {
    try {
      if (!this.#current(connection) || binary) throw new Error('unavailable');
      const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      if (
        bytes.byteLength >
        (connection.hello
          ? ENCRYPTED_BRIDGE_LIMITS.wireBytes
          : ENCRYPTED_BRIDGE_LIMITS.handshakeBytes)
      )
        throw new Error('unavailable');
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
      );
      if (!connection.hello) {
        this.#hello(connection, value);
        return;
      }
      if (connection.side === 'client') this.#request(connection, value, bytes.byteLength);
      else this.#response(connection, value);
    } catch {
      this.#drop(connection);
    }
  }

  #hello(connection: Connection, value: unknown): void {
    const hello = encryptedBridgeHelloSchema.parse(value);
    if (hello.side !== connection.side) throw new Error('unavailable');
    if (hello.side === 'host') {
      const key = hostKey(connection.owner, hello.deviceId);
      const previous = this.#hosts.get(key);
      if (previous) this.#drop(previous);
      this.#hosts.set(key, connection);
    } else this.#clients.set(connection.id, connection);
    connection.hello = hello;
    this.#timers.clear(connection.handshakeTimer);
    connection.handshakeTimer = undefined;
    if (hello.side === 'host')
      this.#send(
        connection,
        { protocol: 4, type: 'ready', side: 'host', host: descriptor(hello) },
        ENCRYPTED_BRIDGE_LIMITS.readyBytes,
      );
    else {
      const hosts: EncryptedBridgeHostDescriptor[] = [];
      for (const host of this.#hosts.values()) {
        if (!this.#current(host)) {
          this.#drop(host);
          continue;
        }
        if (host.owner === connection.owner && sameTrust(hello, host.hello!))
          hosts.push(descriptor(host.hello!));
      }
      this.#send(
        connection,
        {
          protocol: 4,
          type: 'ready',
          side: 'client',
          clientConnectionId: connection.id,
          hosts,
        },
        ENCRYPTED_BRIDGE_LIMITS.readyBytes,
      );
    }
  }

  #binding(connection: Connection, host: Connection, header: EncryptedRecordHeader): boolean {
    const clientHello = connection.hello!,
      hostHello = host.hello,
      binding = header.binding;
    return Boolean(
      hostHello?.side === 'host' &&
      host.owner === connection.owner &&
      sameTrust(clientHello, hostHello) &&
      binding.accountId === connection.owner &&
      binding.serverOrigin === connection.origin &&
      binding.rootKeyId === clientHello.rootKeyId &&
      binding.trustEpoch === clientHello.trustEpoch &&
      binding.trustDigest === clientHello.trustDigest &&
      binding.clientDeviceId === clientHello.deviceId &&
      binding.clientKeyId === clientHello.keyId &&
      binding.hostDeviceId === hostHello.deviceId &&
      binding.hostKeyId === hostHello.keyId &&
      binding.hostChallenge === hostHello.hostChallenge,
    );
  }

  #request(client: Connection, value: unknown, bytes: number): void {
    const message = encryptedBridgeClientRecordSchema.parse(value),
      header = message.record.header,
      requestId = header.requestId,
      host = this.#hosts.get(hostKey(client.owner, header.binding.hostDeviceId));
    if (
      header.direction !== 'client-to-host' ||
      header.kind !== 'request' ||
      this.#pending.has(pendingKey(client.id, requestId))
    )
      throw new Error('unavailable');
    if (
      !host ||
      !this.#current(host) ||
      !this.#binding(client, host, header) ||
      this.#pending.size >= ENCRYPTED_BRIDGE_LIMITS.pending ||
      this.#pendingBytes + bytes > ENCRYPTED_BRIDGE_LIMITS.pendingBytes
    ) {
      if (host && !this.#current(host)) this.#drop(host);
      this.#unavailable(client, requestId);
      return;
    }
    const key = pendingKey(client.id, requestId);
    const pending: Pending = {
      client,
      host,
      header,
      bytes,
      timer: this.#timers.set(() => {
        if (this.#pending.get(key) !== pending) return;
        this.#removePending(key, pending);
        this.#unavailable(client, requestId);
      }, ENCRYPTED_BRIDGE_LIMITS.requestMs),
    };
    this.#pending.set(key, pending);
    this.#pendingBytes += bytes;
    // Retain only the public header while awaiting a response; never retain a session body.
    if (
      !this.#current(client) ||
      !this.#send(host, { ...message, clientConnectionId: client.id })
    ) {
      this.#removePending(key, pending);
      this.#unavailable(client, requestId);
    }
  }

  #response(host: Connection, value: unknown): void {
    const message = encryptedBridgeHostRecordSchema.parse(value),
      header = message.record.header,
      key = pendingKey(message.clientConnectionId, header.requestId),
      pending = this.#pending.get(key);
    // A reply may arrive after timeout or client closure. It carries no live delivery claim.
    if (!pending) return;
    if (
      header.direction !== 'host-to-client' ||
      header.kind !== 'response' ||
      pending.host !== host ||
      !isDeepStrictEqual(header.binding, pending.header.binding) ||
      !isDeepStrictEqual(header.resource, pending.header.resource) ||
      !this.#binding(pending.client, host, header)
    )
      throw new Error('unavailable');
    if (!this.#current(pending.client)) {
      this.#drop(pending.client);
      return;
    }
    if (!this.#current(host)) {
      this.#drop(host);
      return;
    }
    this.#removePending(key, pending);
    this.#send(pending.client, { protocol: 4, type: 'record', record: message.record });
  }

  #removePending(key: string, pending: Pending): void {
    if (this.#pending.get(key) !== pending) return;
    this.#pending.delete(key);
    this.#pendingBytes -= pending.bytes;
    this.#timers.clear(pending.timer);
  }

  #unavailable(connection: Connection, requestId?: string): void {
    this.#send(connection, {
      protocol: 4,
      type: 'unavailable',
      ...(requestId ? { requestId } : {}),
      code: 'unavailable',
    });
  }

  #send(
    connection: Connection,
    value: unknown,
    limit: number = ENCRYPTED_BRIDGE_LIMITS.wireBytes,
  ): boolean {
    if (!this.#current(connection)) {
      this.#drop(connection);
      return false;
    }
    const text = JSON.stringify(value),
      bytes = Buffer.byteLength(text);
    if (
      bytes > limit ||
      connection.socket.bufferedAmount + bytes > ENCRYPTED_BRIDGE_LIMITS.wireBytes ||
      [...this.#connections.keys()].reduce((size, ws) => size + ws.bufferedAmount, bytes) >
        ENCRYPTED_BRIDGE_LIMITS.pendingBytes
    ) {
      this.#drop(connection);
      return false;
    }
    try {
      connection.socket.send(text, (error) => {
        if (error) this.#drop(connection);
      });
      return true;
    } catch {
      this.#drop(connection);
      return false;
    }
  }

  #drop(connection: Connection): void {
    if (this.#connections.get(connection.socket) !== connection) return;
    this.#connections.delete(connection.socket);
    this.#timers.clear(connection.handshakeTimer);
    this.#clients.delete(connection.id);
    if (connection.hello?.side === 'host') {
      const key = hostKey(connection.owner, connection.hello.deviceId);
      if (this.#hosts.get(key) === connection) this.#hosts.delete(key);
    }
    for (const [key, pending] of this.#pending) {
      if (pending.client !== connection && pending.host !== connection) continue;
      this.#removePending(key, pending);
      if (pending.host === connection) this.#unavailable(pending.client, pending.header.requestId);
    }
    if (connection.side === 'client' && connection.hello)
      for (const host of this.#hosts.values())
        if (host.owner === connection.owner && sameTrust(host.hello!, connection.hello))
          this.#send(host, {
            protocol: 4,
            type: 'client-closed',
            clientConnectionId: connection.id,
          });
    connection.socket.terminate();
  }

  #scheduleHeartbeat(): void {
    this.#heartbeat = this.#timers.set(() => {
      if (this.#closed) return;
      for (const connection of this.#connections.values()) {
        if (!this.#current(connection) || !connection.alive) {
          this.#drop(connection);
          continue;
        }
        connection.alive = false;
        connection.socket.ping();
      }
      this.#scheduleHeartbeat();
    }, ENCRYPTED_BRIDGE_LIMITS.heartbeatMs);
  }
}
