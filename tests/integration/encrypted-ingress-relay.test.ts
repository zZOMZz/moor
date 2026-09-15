import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import * as ws from 'ws';
import type { Writable } from 'node:stream';
import { Store } from '@moor/gateway/accounts';
import { EncryptedBridgeRelay, type EncryptedBridgeTimers } from '@moor/gateway/encrypted-bridge';
import {
  ENCRYPTED_BRIDGE_LIMITS,
  ENCRYPTED_BRIDGE_PATHS,
  encryptedBridgeClientRecordSchema,
  type EncryptedBridgeHello,
} from '@moor/e2ee/encrypted-bridge-protocol';
import { E2EE_CRYPTO_SUITE } from '@moor/e2ee/e2ee-crypto';

// Use the publicly exported protocol receiver, never WebSocket private fields.
const { Receiver } = ws as unknown as {
  Receiver: new (options: {
    isServer: boolean;
    allowSynchronousEvents: boolean;
    maxPayload: number;
  }) => Writable;
};
const digest = (byte: number) => Buffer.alloc(32, byte).toString('base64url');
const maskingKey = Buffer.from([0x11, 0x22, 0x33, 0x44]);
function header(length: number, opcode = 1, final = true) {
  const extension = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const bytes = Buffer.alloc(6 + extension);
  bytes[0] = (final ? 0x80 : 0) | opcode;
  bytes[1] = 0x80 | (extension === 8 ? 127 : extension === 2 ? 126 : length);
  if (extension === 2) bytes.writeUInt16BE(length, 2);
  if (extension === 8) bytes.writeBigUInt64BE(BigInt(length), 2);
  maskingKey.copy(bytes, 2 + extension);
  return bytes;
}
function frame(text: string, opcode = 1, final = true) {
  const payload = Buffer.from(text);
  for (let index = 0; index < payload.length; index++) payload[index] ^= maskingKey[index % 4];
  return Buffer.concat([header(payload.length, opcode, final), payload]);
}
function hello(side: 'host' | 'client', suffix: string): EncryptedBridgeHello {
  const principal = {
    protocol: 4 as const,
    type: 'hello' as const,
    side,
    deviceId: `synthetic-${side}-${suffix}`,
    keyId: digest(side === 'host' ? 1 : 2),
    rootKeyId: digest(3),
    trustEpoch: 1,
    trustDigest: digest(4),
  };
  return side === 'host'
    ? { ...principal, side, hostChallenge: digest(5) }
    : { ...principal, side };
}
class Timers implements EncryptedBridgeTimers {
  readonly entries = new Map<object, { callback: () => void; milliseconds: number }>();
  set(callback: () => void, milliseconds: number) {
    const handle = {};
    this.entries.set(handle, { callback, milliseconds });
    return handle;
  }
  clear(handle: unknown) {
    this.entries.delete(handle as object);
  }
  fire(milliseconds: number) {
    for (const [handle, entry] of [...this.entries])
      if (entry.milliseconds === milliseconds && this.entries.delete(handle)) entry.callback();
  }
}
function queue<T>() {
  const history: T[] = [];
  const available: T[] = [];
  const waiters: { resolve(value: T): void; reject(error: Error): void }[] = [];
  let closed = false;
  return {
    history,
    push(value: T) {
      history.push(value);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value);
      else available.push(value);
    },
    next(): Promise<T> {
      if (available.length) return Promise.resolve(available.shift()!);
      if (closed) return Promise.reject(Error('Synthetic peer closed before the expected event'));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0))
        waiter.reject(Error('Synthetic peer closed before the expected event'));
    },
  };
}
function observeProcessed(socket: Socket, headBytes: number) {
  let bytes = headBytes;
  const waiters: { target: number; resolve(): void; reject(error: Error): void }[] = [];
  // This listener is installed after relay.handleUpgrade has installed ingress.
  // Its promise resumes after ingress has handled this same raw data event.
  socket.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    for (const waiter of [...waiters])
      if (bytes >= waiter.target) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
  });
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));
  socket.on('close', () => {
    for (const waiter of waiters.splice(0))
      waiter.reject(Error('Connection closed before bytes were processed'));
  });
  return {
    socket,
    closed,
    headBytes,
    get bytes() {
      return bytes;
    },
    until(target: number) {
      if (bytes >= target) return Promise.resolve();
      return new Promise<void>((resolve, reject) => waiters.push({ target, resolve, reject }));
    },
  };
}
async function fixture(t: TestContext) {
  const store = new Store(':memory:', () => 1_800_000_000_000);
  const secrets = ['account-a', 'account-b'].map((account) => {
    store.db
      .prepare('INSERT INTO account(id,email,salt,password) VALUES(?,?,NULL,NULL)')
      .run(account, `${account}@synthetic.invalid`);
    return store.createLogin(account);
  });
  const timers = new Timers();
  let origin = 'http://127.0.0.1:0';
  const relay = new EncryptedBridgeRelay({ store, origin: () => origin, timers });
  const server = createServer();
  const clients: Socket[] = [];
  const serverSockets = new Set<Socket>();
  const remotePorts = new WeakMap<Socket, number>();
  const upgraded = new Map<number, ReturnType<typeof observeProcessed>>();
  server.on('connection', (socket) => {
    serverSockets.add(socket);
    remotePorts.set(socket, socket.remotePort!);
    socket.once('close', () => serverSockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    relay.handleUpgrade(request, socket, head);
  });
  server.on('upgrade', (_request, socket, head) => {
    const raw = socket as Socket;
    upgraded.set(remotePorts.get(raw)!, observeProcessed(raw, head.length));
  });
  t.after(async () => {
    for (const socket of clients) socket.destroy();
    relay.close();
    for (const socket of serverSockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;
  async function connect(
    side: 'host' | 'client',
    options: { account?: number; head?: Buffer } = {},
  ) {
    const socket = createConnection({ host: '127.0.0.1', port });
    clients.push(socket);
    const receiver = new Receiver({
      isServer: false,
      allowSynchronousEvents: true,
      maxPayload: ENCRYPTED_BRIDGE_LIMITS.wireBytes,
    });
    const messages = queue<Record<string, unknown>>();
    const pongs = queue<string>();
    const errors: Error[] = [];
    let response = Buffer.alloc(0);
    let resolveOpen!: () => void;
    let rejectOpen!: (error: Error) => void;
    let open = false;
    const opened = new Promise<void>((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    receiver.on('message', (bytes: Buffer, binary: boolean) => {
      assert.equal(binary, false);
      messages.push(JSON.parse(bytes.toString()) as Record<string, unknown>);
    });
    receiver.on('pong', (bytes: Buffer) => pongs.push(bytes.toString()));
    receiver.on('error', (error: Error) => {
      errors.push(error);
      socket.destroy();
    });
    socket.on('error', (error: Error) => errors.push(error));
    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => {
        if (!open) rejectOpen(Error('HTTP Upgrade did not complete'));
        messages.close();
        pongs.close();
        receiver.destroy();
        resolve();
      }),
    );
    socket.on('data', (bytes) => {
      if (open) {
        receiver.write(bytes);
        return;
      }
      response = Buffer.concat([response, bytes]);
      const end = response.indexOf('\r\n\r\n');
      if (end < 0) return;
      assert.match(response.subarray(0, end).toString(), /^HTTP\/1\.1 101 Switching Protocols\r\n/);
      const trailing = response.subarray(end + 4);
      open = true;
      resolveOpen();
      if (trailing.length) receiver.write(trailing);
      response = Buffer.alloc(0);
    });
    await once(socket, 'connect');
    const clientPort = socket.localPort!;
    const request = Buffer.from(
      [
        `GET ${ENCRYPTED_BRIDGE_PATHS[side]} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${Buffer.alloc(16, 7).toString('base64')}`,
        `Origin: ${origin}`,
        `Cookie: personal=${secrets[options.account ?? 0]}`,
        '',
        '',
      ].join('\r\n'),
    );
    socket.write(Buffer.concat([request, options.head ?? Buffer.alloc(0)]));
    await opened;
    const processed = upgraded.get(clientPort);
    assert.ok(
      processed,
      'the public server upgrade observation must exist before its response arrives',
    );
    return {
      socket,
      closed,
      messages,
      pongs,
      errors,
      processed,
      async send(bytes: Buffer) {
        const done = processed.until(processed.bytes + bytes.length);
        socket.write(bytes);
        await done;
      },
    };
  }
  return { connect, timers, origin };
}

test(
  'raw v4 headers reserve one shared ingress budget across accounts and endpoint sides',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.connect('host');
    const second = await f.connect('client', { account: 1 });
    const third = await f.connect('client');
    for (const [peer, identity] of [
      [first, hello('host', 'first')],
      [second, hello('client', 'second')],
      [third, hello('client', 'third')],
    ] as const) {
      await peer.send(frame(JSON.stringify(identity)));
      assert.equal((await peer.messages.next()).type, 'ready');
    }
    const declared = ENCRYPTED_BRIDGE_LIMITS.wireBytes - 256;
    assert.equal(2 * (declared + 256), ENCRYPTED_BRIDGE_LIMITS.ingressBytes);
    await first.send(header(declared));
    await second.send(header(declared));
    assert.equal(first.processed.socket.destroyed, false);
    assert.equal(second.processed.socket.destroyed, false);
    await third.send(header(declared));
    await third.closed;
    assert.equal(
      first.socket.destroyed,
      false,
      'rejecting one account cannot evict another admitted connection',
    );
    assert.equal(second.socket.destroyed, false);
    first.socket.destroy();
    await first.closed;
    await first.processed.closed;
    const recovered = await f.connect('client');
    await recovered.send(frame(JSON.stringify(hello('client', 'recovered'))));
    assert.equal((await recovered.messages.next()).type, 'ready');
    await recovered.send(header(declared));
    assert.equal(
      recovered.processed.socket.destroyed,
      false,
      'closing a held connection releases enough budget for a new declaration',
    );
    assert.equal(
      second.messages.history.some((message) => message.type === 'record'),
      false,
    );
  },
);

test(
  'HTTP Upgrade head bytes pass through hello and declared-size admission',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const identity = hello('host', 'head');
    const helloFrame = frame(JSON.stringify(identity));
    const accepted = await f.connect('host', { head: helloFrame });
    assert.equal(accepted.processed.headBytes, helloFrame.length);
    const ready = await accepted.messages.next();
    assert.equal(ready.type, 'ready');
    assert.equal((ready.host as { deviceId: string }).deviceId, identity.deviceId);
    const excessive = header(ENCRYPTED_BRIDGE_LIMITS.handshakeBytes + 1);
    const rejected = await f.connect('client', { account: 1, head: excessive });
    assert.equal(rejected.processed.headBytes, excessive.length);
    await rejected.closed;
    assert.deepEqual(rejected.messages.history, []);
    assert.equal(accepted.socket.destroyed, false);
  },
);

test(
  'raw fragmented messages allow control replies but unfinished records expire without delivery',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const host = await f.connect('host');
    const hostIdentity = hello('host', 'fragments');
    await host.send(frame(JSON.stringify(hostIdentity)));
    assert.equal((await host.messages.next()).type, 'ready');
    const client = await f.connect('client');
    const clientIdentity = hello('client', 'fragments');
    const text = JSON.stringify(clientIdentity);
    await client.send(frame(text.slice(0, 35), 1, false));
    await client.send(frame('between-fragments', 9));
    assert.equal(await client.pongs.next(), 'between-fragments');
    assert.deepEqual(client.messages.history, []);
    await client.send(frame(text.slice(35), 0));
    assert.equal((await client.messages.next()).type, 'ready');
    const unfinishedRecord = JSON.stringify({
      protocol: 4,
      type: 'record',
      record: {
        header: {
          version: 1,
          suite: E2EE_CRYPTO_SUITE,
          direction: 'client-to-host',
          kind: 'request',
          requestId: digest(6),
          sequence: 1,
          binding: {
            accountId: 'account-a',
            serverOrigin: f.origin,
            rootKeyId: hostIdentity.rootKeyId,
            trustEpoch: 1,
            trustDigest: hostIdentity.trustDigest,
            clientDeviceId: clientIdentity.deviceId,
            clientKeyId: clientIdentity.keyId,
            hostDeviceId: hostIdentity.deviceId,
            hostKeyId: hostIdentity.keyId,
            hostChallenge: digest(5),
            clientChallenge: digest(7),
          },
          resource: {
            kind: 'session',
            workspaceId: 'synthetic-workspace',
            projectId: 'synthetic-project',
            sessionId: 'synthetic-session',
            catalogWorkspaceId: null,
            replicaId: null,
          },
        },
        enc: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
        ciphertext: Buffer.alloc(16, 2).toString('base64url'),
      },
    });
    encryptedBridgeClientRecordSchema.parse(JSON.parse(unfinishedRecord));
    await client.send(frame(unfinishedRecord, 1, false));
    const deadlines = [...f.timers.entries].filter(
      ([, entry]) => entry.milliseconds === ENCRYPTED_BRIDGE_LIMITS.ingressMessageMs,
    );
    assert.equal(deadlines.length, 1);
    await client.send(frame('deadline-does-not-move', 9));
    assert.equal(await client.pongs.next(), 'deadline-does-not-move');
    assert.equal(f.timers.entries.get(deadlines[0][0]), deadlines[0][1]);
    assert.equal(
      host.messages.history.some((message) => message.type === 'record'),
      false,
    );
    f.timers.fire(ENCRYPTED_BRIDGE_LIMITS.ingressMessageMs);
    await client.closed;
    assert.equal((await host.messages.next()).type, 'client-closed');
    assert.equal(
      host.messages.history.some((message) => message.type === 'record'),
      false,
    );
    assert.equal(f.timers.entries.has(deadlines[0][0]), false);
    assert.equal(host.socket.destroyed, false);
  },
);
