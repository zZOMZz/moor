import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Store } from '../src/relay/accounts';
import { createApp } from '../src/relay/http';
import { EncryptedBridgeRelay, type EncryptedBridgeTimers } from '../src/relay/encrypted-bridge';
import {
  ENCRYPTED_BRIDGE_LIMITS,
  ENCRYPTED_BRIDGE_PATHS,
  encryptedBridgeClientReadySchema,
  encryptedBridgeHostReadySchema,
  type EncryptedBridgeHello,
} from '../src/security/encrypted-bridge-protocol';
import { E2eeChannel, type EncryptedRecord } from '../src/security/e2ee-channel';
import { E2EE_CRYPTO_SUITE, generateDeviceEncryptionKey } from '../src/security/e2ee-crypto';
import {
  encryptionKeyId,
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
} from '../src/security/e2ee-trust';

const digest = (byte: number) => Buffer.alloc(32, byte).toString('base64url');
const copy = <T>(value: T): T => structuredClone(value);
const owner = 'synthetic-owner';
const hostHello: Extract<EncryptedBridgeHello, { side: 'host' }> = {
  protocol: 4,
  type: 'hello',
  side: 'host',
  deviceId: 'synthetic-host',
  keyId: digest(1),
  rootKeyId: digest(2),
  trustEpoch: 1,
  trustDigest: digest(3),
  hostChallenge: digest(4),
};
const clientHello: EncryptedBridgeHello = {
  protocol: 4,
  type: 'hello',
  side: 'client',
  deviceId: 'synthetic-client',
  keyId: digest(5),
  rootKeyId: hostHello.rootKeyId,
  trustEpoch: hostHello.trustEpoch,
  trustDigest: hostHello.trustDigest,
};
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
    for (const [handle, value] of [...this.entries])
      if (value.milliseconds === milliseconds && this.entries.delete(handle)) value.callback();
  }
}
function peer(socket: WebSocket) {
  const messages: any[] = [];
  const queued: any[] = [];
  const waiting: ((value: any) => void)[] = [];
  socket.on('error', () => {});
  socket.on('message', (raw) => {
    const value = JSON.parse(raw.toString());
    messages.push(value);
    const next = waiting.shift();
    if (next) next(value);
    else queued.push(value);
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  return {
    socket,
    messages,
    closed,
    next: () =>
      queued.length
        ? Promise.resolve(queued.shift())
        : new Promise<any>((resolve) => waiting.push(resolve)),
    send: (value: unknown) => socket.send(JSON.stringify(value)),
    barrier: async () => {
      const pong = once(socket, 'pong');
      socket.ping();
      await pong;
    },
  };
}
async function fixture(
  t: TestContext,
  options: { integrated?: boolean; localOnly?: boolean } = {},
) {
  let now = 1_800_000_000_000;
  const store = new Store(':memory:', () => now);
  // Synthetic Google-only account; no password derivation or external identity provider needed.
  store.db
    .prepare('INSERT INTO account(id,email,salt,password) VALUES(?,?,NULL,NULL)')
    .run(owner, 'owner@synthetic.invalid');
  store.db
    .prepare('INSERT INTO account(id,email,salt,password) VALUES(?,?,NULL,NULL)')
    .run('other-owner', 'other@synthetic.invalid');
  const secret = store.createLogin(owner),
    otherSecret = store.createLogin('other-owner');
  let origin = 'http://127.0.0.1:0',
    current = true;
  const timers = new Timers();
  const relay = options.integrated
    ? undefined
    : new EncryptedBridgeRelay({
        store,
        origin: () => origin,
        current: () => current,
        localOnly: options.localOnly,
        timers,
      });
  const app = options.integrated
    ? createApp(store, { origin, setupToken: 'synthetic', localOnly: options.localOnly })
    : undefined;
  const server = app?.server ?? createServer();
  if (relay)
    server.on('upgrade', (request, socket, head) => {
      if (!relay.handleUpgrade(request, socket, head)) socket.destroy();
    });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app?.setOrigin(origin);
  const sockets: WebSocket[] = [];
  let close: Promise<void> | undefined;
  const stop = () =>
    (close ??= (async () => {
      if (app) await app.close();
      else {
        relay!.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    })());
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await stop();
    store.close();
  });
  async function connect(
    side: 'host' | 'client',
    options: {
      hello?: unknown;
      noHello?: boolean;
      secret?: string;
      headers?: Record<string, string | undefined>;
      path?: string;
    } = {},
  ) {
    const headers = Object.fromEntries(
      Object.entries({
        Origin: origin,
        Cookie: `personal=${options.secret ?? secret}`,
        ...options.headers,
      }).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    const socket = new WebSocket(
      origin.replace('http:', 'ws:') + (options.path ?? ENCRYPTED_BRIDGE_PATHS[side]),
      { headers, perMessageDeflate: false },
    );
    sockets.push(socket);
    const result = peer(socket);
    await once(socket, 'open');
    if (!options.noHello) result.send(options.hello ?? (side === 'host' ? hostHello : clientHello));
    return result;
  }
  function record(overrides: Partial<EncryptedRecord['header']> = {}): EncryptedRecord {
    return {
      header: {
        version: 1,
        suite: E2EE_CRYPTO_SUITE,
        direction: 'client-to-host',
        kind: 'request',
        requestId: digest(6),
        sequence: 1,
        binding: {
          accountId: owner,
          serverOrigin: origin,
          rootKeyId: hostHello.rootKeyId,
          trustEpoch: hostHello.trustEpoch,
          trustDigest: hostHello.trustDigest,
          clientDeviceId: clientHello.deviceId,
          clientKeyId: clientHello.keyId,
          hostDeviceId: hostHello.deviceId,
          hostKeyId: hostHello.keyId,
          hostChallenge: hostHello.hostChallenge,
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
        ...overrides,
      },
      enc: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'),
      ciphertext: Buffer.alloc(16, 2).toString('base64url'),
    };
  }
  const envelope = (value = record()) => ({ protocol: 4, type: 'record', record: value });
  return {
    connect,
    store,
    secret,
    otherSecret,
    timers,
    app,
    relay,
    origin,
    record,
    envelope,
    stop,
    expire: () => (now += 31 * 86400000),
    invalidate: () => (current = false),
    changeOrigin: (value: string) => {
      origin = value;
      app?.setOrigin(value);
    },
  };
}
const response = (message: any, overrides: Partial<EncryptedRecord['header']> = {}) => ({
  ...copy(message),
  record: {
    ...copy(message.record),
    header: {
      ...copy(message.record.header),
      direction: 'host-to-client',
      kind: 'response',
      ...overrides,
    },
  },
});
const unavailable = (requestId: string) => ({
  protocol: 4,
  type: 'unavailable',
  requestId,
  code: 'unavailable',
});

for (const integrated of [false, true])
  test(`v4 ${integrated ? 'actual HTTP hook' : 'standalone relay'} routes only opaque records and public descriptors`, async (t) => {
    const f = await fixture(t, { integrated });
    const before = f.store.db.prepare('SELECT * FROM device').all();
    const host = await f.connect('host');
    const ready = encryptedBridgeHostReadySchema.parse(await host.next());
    assert.deepEqual(ready.host, Object.fromEntries(Object.entries(hostHello).slice(3)));
    const client = await f.connect('client');
    const clientReady = encryptedBridgeClientReadySchema.parse(await client.next());
    assert.deepEqual(clientReady.hosts, [ready.host]);
    const request = f.envelope();
    client.send(request);
    const forwarded = await host.next();
    assert.deepEqual(forwarded, { ...request, clientConnectionId: clientReady.clientConnectionId });
    const reply = response(forwarded);
    host.send(reply);
    assert.deepEqual(await client.next(), f.envelope(reply.record));
    assert.deepEqual(f.store.db.prepare('SELECT * FROM device').all(), before);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM host_binding').get()?.n, 0);
    client.socket.close();
    assert.deepEqual(await host.next(), {
      protocol: 4,
      type: 'client-closed',
      clientConnectionId: clientReady.clientConnectionId,
    });
  });

test('actual relay preserves an authenticated encrypted request/response byte for byte', async (t) => {
  const f = await fixture(t, { integrated: true });
  const [root, hostKey, clientKey] = await Promise.all([
    generateTrustRoot(),
    generateDeviceEncryptionKey(),
    generateDeviceEncryptionKey(),
  ]);
  const pin = { accountId: owner, serverOrigin: f.origin, rootKeyId: root.keyId };
  const devices = [
    {
      deviceId: hostHello.deviceId,
      keyId: await encryptionKeyId(hostKey.publicKey),
      publicKey: hostKey.publicKey,
      roles: ['host'] as ('host' | 'client')[],
    },
    {
      deviceId: clientHello.deviceId,
      keyId: await encryptionKeyId(clientKey.publicKey),
      publicKey: clientKey.publicKey,
      roles: ['client'] as ('host' | 'client')[],
    },
  ];
  const signed = await signTrustManifest({
    manifest: { ...pin, version: 1, epoch: 1, previous: null, devices },
    rootPublicKey: root.publicKey,
    rootPrivateKey: root.privateKey,
  });
  const trust = await VerifiedTrust.verify({ signed, rootPublicKey: root.publicKey, pin });
  const shared = { rootKeyId: root.keyId, trustEpoch: 1, trustDigest: trust.checkpoint.digest };
  const host = await f.connect('host', {
    hello: { ...hostHello, ...shared, keyId: devices[0].keyId },
  });
  await host.next();
  const client = await f.connect('client', {
    hello: { ...clientHello, ...shared, keyId: devices[1].keyId },
  });
  await client.next();
  const context = {
    trust,
    clientDeviceId: devices[1].deviceId,
    hostDeviceId: devices[0].deviceId,
    hostChallenge: hostHello.hostChallenge,
    clientChallenge: digest(20),
    current: () => trust,
  };
  const clientChannel = await E2eeChannel.create({
    ...context,
    side: 'client',
    privateKey: clientKey.privateKey,
  });
  const hostChannel = await E2eeChannel.create({
    ...context,
    side: 'host',
    privateKey: hostKey.privateKey,
  });
  const plaintext = new TextEncoder().encode('synthetic private project name and session body');
  const request = await clientChannel.send({
    kind: 'request',
    requestId: digest(21),
    resource: f.record().header.resource,
    plaintext,
  });
  client.send(f.envelope(request));
  const forwarded = await host.next();
  assert.deepEqual(forwarded.record, request);
  assert.equal(JSON.stringify(forwarded).includes(new TextDecoder().decode(plaintext)), false);
  assert.deepEqual((await hostChannel.receive(forwarded.record)).plaintext, plaintext);
  const reply = await hostChannel.send({
    kind: 'response',
    requestId: request.header.requestId,
    resource: request.header.resource,
    plaintext: new TextEncoder().encode('{"accepted":true,"operationId":"synthetic-original-id"}'),
  });
  host.send({ ...f.envelope(reply), clientConnectionId: forwarded.clientConnectionId });
  const delivered = await client.next();
  assert.deepEqual(delivered.record, reply);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode((await clientChannel.receive(reply)).plaintext)),
    {
      accepted: true,
      operationId: 'synthetic-original-id',
    },
  );
  clientChannel.close();
  hostChannel.close();
});

for (const integrated of [false, true])
  test(`v4 ${integrated ? 'HTTP' : 'standalone'} upgrade requires exact cookie, Origin and path without bearer bypass`, async (t) => {
    const f = await fixture(t, { integrated });
    for (const options of [
      { headers: { Cookie: undefined } },
      { headers: { Origin: undefined } },
      {
        headers: { Origin: 'https://attacker.synthetic.invalid', Authorization: 'Bearer anything' },
      },
      { headers: { Cookie: '', Authorization: `Bearer ${f.secret}` } },
      { headers: { Cookie: `personal=${f.secret}; personal=${f.secret}` } },
      { headers: { Cookie: 'personal=not-a-login' } },
      { headers: { 'Sec-WebSocket-Protocol': 'arbitrary-proxy' } },
      { path: '/bridge/v4/client?cookie=secret' },
      { path: '/bridge/v4/host/' },
      { path: '/bridge/v4/anything' },
    ])
      await assert.rejects(f.connect('client', options), /401/);
  });

for (const integrated of [false, true])
  test(`v4 ${integrated ? 'HTTP' : 'standalone'} is unavailable in local-only mode`, async (t) => {
    const f = await fixture(t, { integrated, localOnly: true });
    await assert.rejects(f.connect('host'), /401/);
    await assert.rejects(f.connect('client'), /401/);
  });

test('host discovery is restricted to the same account, root, epoch and digest', async (t) => {
  const f = await fixture(t);
  const host = await f.connect('host');
  await host.next();
  for (const options of [
    { secret: f.otherSecret },
    { hello: { ...clientHello, rootKeyId: digest(31) } },
    { hello: { ...clientHello, trustEpoch: 2 } },
    { hello: { ...clientHello, trustDigest: digest(32) } },
  ]) {
    const client = await f.connect('client', options);
    assert.deepEqual((await client.next()).hosts, []);
    client.send(f.envelope());
    assert.deepEqual(await client.next(), unavailable(f.record().header.requestId));
    await host.barrier();
    assert.equal(host.messages.filter((message) => message.type === 'record').length, 0);
    client.socket.close();
    await client.closed;
  }
});

for (const [field, value] of Object.entries({
  accountId: 'wrong-owner',
  serverOrigin: 'https://other.synthetic.invalid',
  rootKeyId: digest(40),
  trustEpoch: 2,
  trustDigest: digest(41),
  clientDeviceId: 'wrong-client',
  clientKeyId: digest(42),
  hostDeviceId: 'missing-host',
  hostKeyId: digest(43),
  hostChallenge: digest(44),
}))
  test(`request ${field} mismatch cannot be routed`, async (t) => {
    const f = await fixture(t);
    const host = await f.connect('host');
    await host.next();
    const client = await f.connect('client');
    await client.next();
    const record = f.record();
    Object.assign(record.header.binding, { [field]: value });
    client.send(f.envelope(record));
    assert.deepEqual(await client.next(), unavailable(record.header.requestId));
    await host.barrier();
    assert.equal(host.messages.length, 1);
  });

for (const mutate of [
  (record: EncryptedRecord) => (record.header.binding.clientChallenge = digest(51)),
  (record: EncryptedRecord) => (record.header.binding.clientDeviceId = 'wrong-client'),
  (record: EncryptedRecord) => (record.header.resource.sessionId = 'wrong-session'),
  (record: EncryptedRecord) => (record.header.resource.projectId = 'wrong-project'),
  (record: EncryptedRecord) => (record.header.kind = 'event'),
])
  test('host response must match the exact pending binding, resource and response kind', async (t) => {
    const f = await fixture(t);
    const host = await f.connect('host');
    await host.next();
    const client = await f.connect('client');
    await client.next();
    client.send(f.envelope());
    const request = await host.next();
    const reply = response(request);
    mutate(reply.record);
    host.send(reply);
    assert.deepEqual(await client.next(), unavailable(request.record.header.requestId));
    await host.closed;
    assert.equal(
      client.messages.some((message) => message.type === 'record'),
      false,
    );
  });

test('identical request IDs on distinct client connections remain isolated', async (t) => {
  const f = await fixture(t);
  const host = await f.connect('host');
  await host.next();
  const clients = [await f.connect('client'), await f.connect('client')];
  const ready = await Promise.all(clients.map((client) => client.next()));
  assert.notEqual(ready[0].clientConnectionId, ready[1].clientConnectionId);
  for (const client of clients) client.send(f.envelope());
  const messages = [await host.next(), await host.next()];
  for (const message of messages.toReversed()) host.send(response(message));
  for (const client of clients)
    assert.deepEqual((await client.next()).record, response(messages[0]).record);
  assert.equal(host.socket.readyState, WebSocket.OPEN);
});

test('a host cannot send a different connected host’s response', async (t) => {
  const f = await fixture(t);
  const host = await f.connect('host');
  await host.next();
  const stranger = await f.connect('host', { hello: { ...hostHello, deviceId: 'stranger-host' } });
  await stranger.next();
  const client = await f.connect('client');
  await client.next();
  client.send(f.envelope());
  const request = await host.next();
  stranger.send(response(request));
  await stranger.closed;
  host.send(response(request));
  assert.deepEqual((await client.next()).record, response(request).record);
});

test('duplicate pending request IDs close the originating client and release host channel state', async (t) => {
  const f = await fixture(t);
  const host = await f.connect('host');
  await host.next();
  const client = await f.connect('client');
  const ready = await client.next();
  client.send(f.envelope());
  const request = await host.next();
  client.send(f.envelope());
  await client.closed;
  assert.deepEqual(await host.next(), {
    protocol: 4,
    type: 'client-closed',
    clientConnectionId: ready.clientConnectionId,
  });
  host.send(response(request));
  await host.barrier();
  assert.equal(host.socket.readyState, WebSocket.OPEN);
});

test('host replacement invalidates pending requests and requires a fresh challenge', async (t) => {
  const f = await fixture(t);
  const host = await f.connect('host');
  await host.next();
  const client = await f.connect('client');
  await client.next();
  client.send(f.envelope());
  await host.next();
  const replacement = await f.connect('host', {
    hello: { ...hostHello, hostChallenge: digest(60) },
  });
  await replacement.next();
  await host.closed;
  assert.deepEqual(await client.next(), unavailable(f.record().header.requestId));
  const stale = f.record({ requestId: digest(61) });
  client.send(f.envelope(stale));
  assert.deepEqual(await client.next(), unavailable(stale.header.requestId));
  const fresh = f.record({ requestId: digest(62) });
  fresh.header.binding.hostChallenge = digest(60);
  client.send(f.envelope(fresh));
  const forwarded = await replacement.next();
  replacement.send(response(forwarded));
  assert.deepEqual((await client.next()).record, response(forwarded).record);
});

test('timeouts report only unknown availability and never replay a request', async (t) => {
  const f = await fixture(t);
  const host = await f.connect('host');
  await host.next();
  const client = await f.connect('client');
  await client.next();
  client.send(f.envelope());
  const request = await host.next();
  f.timers.fire(ENCRYPTED_BRIDGE_LIMITS.requestMs);
  assert.deepEqual(await client.next(), unavailable(request.record.header.requestId));
  host.send(response(request));
  await host.barrier();
  await client.barrier();
  assert.equal(client.messages.length, 2);
  assert.equal(host.messages.filter((message) => message.type === 'record').length, 1);
  assert.equal(
    [...f.timers.entries.values()].some(
      (item) => item.milliseconds === ENCRYPTED_BRIDGE_LIMITS.requestMs,
    ),
    false,
  );
});

test('global pending admission is bounded and released after responses', async (t) => {
  const f = await fixture(t);
  const host = await f.connect('host');
  await host.next();
  const client = await f.connect('client');
  await client.next();
  const requests: any[] = [];
  for (let index = 0; index < ENCRYPTED_BRIDGE_LIMITS.pending; index++) {
    client.send(f.envelope(f.record({ requestId: digest(index), sequence: index + 1 })));
    requests.push(await host.next());
  }
  const excess = f.record({ requestId: digest(100), sequence: 101 });
  client.send(f.envelope(excess));
  assert.deepEqual(await client.next(), unavailable(excess.header.requestId));
  host.send(response(requests[0]));
  await client.next();
  client.send(f.envelope(excess));
  const admitted = await host.next();
  assert.deepEqual(admitted.record, excess);
});

for (const side of ['host', 'client'] as const)
  test(`${side} admission counts uncompleted handshakes and frees expired slots`, async (t) => {
    const f = await fixture(t);
    const sockets = [];
    for (let i = 0; i < ENCRYPTED_BRIDGE_LIMITS[side === 'host' ? 'hosts' : 'clients']; i++)
      sockets.push(await f.connect(side, { noHello: true }));
    await assert.rejects(f.connect(side), /401/);
    f.timers.fire(ENCRYPTED_BRIDGE_LIMITS.handshakeMs);
    await Promise.all(sockets.map((socket) => socket.closed));
    const current = await f.connect(side);
    assert.equal((await current.next()).type, 'ready');
  });

for (const mutation of ['logout', 'expiry', 'origin', 'lease', 'stop'] as const)
  test(`${mutation} invalidates all affected routing before another forward`, async (t) => {
    const f = await fixture(t);
    const host = await f.connect('host');
    await host.next();
    const client = await f.connect('client');
    await client.next();
    client.send(f.envelope());
    const request = await host.next();
    if (mutation === 'logout') f.store.logout(f.secret);
    if (mutation === 'expiry') f.expire();
    if (mutation === 'origin') f.changeOrigin('https://changed.synthetic.invalid');
    if (mutation === 'lease') f.invalidate();
    if (mutation === 'stop') await f.stop();
    else {
      host.send(response(request));
      f.timers.fire(ENCRYPTED_BRIDGE_LIMITS.heartbeatMs);
    }
    await Promise.all([host.closed, client.closed]);
    assert.equal(
      client.messages.some((message) => message.type === 'record'),
      false,
    );
  });

test('actual logout and setOrigin hooks synchronously invalidate v4 sockets', async (t) => {
  const f = await fixture(t, { integrated: true });
  const host = await f.connect('host');
  await host.next();
  const client = await f.connect('client');
  await client.next();
  const result = await fetch(f.origin + '/api/logout', {
    method: 'POST',
    headers: { Cookie: `personal=${f.secret}`, Origin: f.origin },
  });
  assert.equal(result.status, 200);
  await Promise.all([host.closed, client.closed]);
  const second = await f.connect('host', { secret: f.otherSecret });
  await second.next();
  f.app!.setOrigin('https://changed.synthetic.invalid');
  await second.closed;
});

for (const payload of [
  { ...hostHello, side: 'client' },
  { ...hostHello, name: 'must-never-be-stored' },
  { ...hostHello, protocol: 3 },
  { type: 'request', method: 'arbitrary-socket-proxy' },
])
  test('invalid, extra-field and cross-side handshakes fail closed', async (t) => {
    const f = await fixture(t);
    const host = await f.connect('host', { hello: payload });
    await host.closed;
    assert.deepEqual(host.messages, []);
  });

for (const payload of ['binary', 'invalid-utf8', 'oversized', 'invalid-json'] as const)
  test(`${payload} handshake is rejected without interpretation`, async (t) => {
    const f = await fixture(t);
    const client = await f.connect('client', { noHello: true });
    if (payload === 'binary') client.socket.send(Buffer.from(JSON.stringify(clientHello)));
    if (payload === 'invalid-utf8') client.socket.send(Buffer.from([0xff]), { binary: false });
    if (payload === 'oversized')
      client.socket.send(' '.repeat(ENCRYPTED_BRIDGE_LIMITS.handshakeBytes + 1));
    if (payload === 'invalid-json') client.socket.send('{');
    await client.closed;
    assert.deepEqual(client.messages, []);
  });

test('heartbeat uses deterministic signals to release disconnected and expired peers', async (t) => {
  const f = await fixture(t);
  const client = await f.connect('client');
  await client.next();
  f.timers.fire(ENCRYPTED_BRIDGE_LIMITS.heartbeatMs);
  // Auto-pong is observed through a peer ping barrier, without a wall-clock sleep.
  await client.barrier();
  f.timers.fire(ENCRYPTED_BRIDGE_LIMITS.heartbeatMs);
  await client.barrier();
  assert.equal(client.socket.readyState, WebSocket.OPEN);
  f.expire();
  f.timers.fire(ENCRYPTED_BRIDGE_LIMITS.heartbeatMs);
  await client.closed;
});

test('v4 public discovery returns all 64 connected hosts without catalog names or paths', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < ENCRYPTED_BRIDGE_LIMITS.hosts; index++) {
    const host = await f.connect('host', {
      hello: { ...hostHello, deviceId: `host-${index}-${'x'.repeat(120)}` },
    });
    await host.next();
  }
  const client = await f.connect('client');
  const ready = encryptedBridgeClientReadySchema.parse(await client.next());
  assert.equal(ready.hosts.length, ENCRYPTED_BRIDGE_LIMITS.hosts);
  assert.ok(Buffer.byteLength(JSON.stringify(ready)) > ENCRYPTED_BRIDGE_LIMITS.handshakeBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(ready)) <= ENCRYPTED_BRIDGE_LIMITS.readyBytes);
  for (const host of ready.hosts) {
    assert.deepEqual(Object.keys(host).sort(), [
      'deviceId',
      'hostChallenge',
      'keyId',
      'rootKeyId',
      'trustDigest',
      'trustEpoch',
    ]);
  }
});

test('the total socket admission limit is shared across accounts and both sides', async (t) => {
  const f = await fixture(t);
  for (let account = 0; account < 2; account++) {
    const secret = account === 0 ? f.secret : f.otherSecret;
    for (const side of ['client', 'host'] as const)
      for (let index = 0; index < 64; index++) await f.connect(side, { noHello: true, secret });
  }
  f.store.db
    .prepare('INSERT INTO account(id,email,salt,password) VALUES(?,?,NULL,NULL)')
    .run('third-owner', 'third@synthetic.invalid');
  const thirdSecret = f.store.createLogin('third-owner');
  await assert.rejects(f.connect('client', { secret: thirdSecret }), /401/);
  f.timers.fire(ENCRYPTED_BRIDGE_LIMITS.handshakeMs);
  const client = await f.connect('client', { secret: thirdSecret });
  assert.equal((await client.next()).type, 'ready');
});

test('revoking one login closes its host while a separate valid login receives only unavailable', async (t) => {
  const f = await fixture(t, { integrated: true });
  const host = await f.connect('host');
  await host.next();
  const independentSecret = f.store.createLogin(owner);
  const client = await f.connect('client', { secret: independentSecret });
  await client.next();
  client.send(f.envelope());
  const request = await host.next();
  const result = await fetch(f.origin + '/api/logout', {
    method: 'POST',
    headers: { Cookie: `personal=${f.secret}`, Origin: f.origin },
  });
  assert.equal(result.status, 200);
  await host.closed;
  assert.deepEqual(await client.next(), unavailable(request.record.header.requestId));
  await client.barrier();
  assert.equal(client.socket.readyState, WebSocket.OPEN);
});
