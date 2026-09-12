import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import {
  EncryptedBridgeClient,
  EncryptedHostError,
  encryptedCommandResource,
  type EncryptedClientOptions,
} from '../src/security/encrypted-bridge-client';
import {
  E2eeChannel,
  newChannelChallenge,
  type EncryptedRecord,
  type EncryptedResource,
} from '../src/security/e2ee-channel';
import { generateDeviceEncryptionKey, seal } from '../src/security/e2ee-crypto';
import {
  generateTrustRoot,
  encryptionKeyId,
  signTrustManifest,
  VerifiedTrust,
} from '../src/security/e2ee-trust';
import {
  ENCRYPTED_BRIDGE_FAILED,
  ENCRYPTED_BRIDGE_LIMITS,
  encryptedBridgeClientRecordSchema,
  encryptedBridgeHelloSchema,
  encryptedCatalogSchema,
  encryptedHostRequestSchema,
  parseEncryptedBridgeMessage,
  type EncryptedCatalog,
} from '../src/security/encrypted-bridge-protocol';
import { hostCommandSchema } from '../src/bridge/host-command';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (value: Uint8Array) =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
const scope = { workspaceId: 'runtime', localProjectId: 'project', sessionId: 'session' };
const agent = {
  id: 'agent',
  name: 'SYNTHETIC_PRIVATE_AGENT',
  cliType: 'fixture-cli',
  agentType: 'fixture-agent',
};
const catalog: EncryptedCatalog = {
  catalogVersion: 1,
  machineId: 'machine',
  workspaces: [
    {
      id: 'runtime',
      name: 'SYNTHETIC_PRIVATE_WORKSPACE',
      userId: 'local-owner',
      machineId: 'machine',
      projects: [
        {
          id: 'project',
          name: 'SYNTHETIC_PRIVATE_PROJECT',
          rootPath: '/synthetic/private/project',
        },
      ],
      agents: [agent],
      features: ['file-content-v1'],
    },
  ],
};
const meta = {
  id: 'session',
  userId: 'local-owner',
  machineId: 'machine',
  project: { kind: 'local', localProjectId: 'project' },
  agentConfigId: agent.id,
  cliType: agent.cliType,
  agentType: agent.agentType,
  title: 'SYNTHETIC_PRIVATE_SESSION',
};
const sessions = hostCommandSchema.parse({
  method: 'sessions',
  workspaceId: 'runtime',
  localProjectId: 'project',
  params: {},
});
const mutation = hostCommandSchema.parse({
  method: 'mutate',
  workspaceId: 'runtime',
  localProjectId: 'project',
  params: {
    operationId: 'original-operation',
    workspaceId: 'runtime',
    sessionId: 'session',
    kind: 'turn',
    expectedTurnId: null,
    update: 'SYNTHETIC_PRIVATE_UPDATE',
  },
});
const receipt = { accepted: true, delivered: true, operationId: 'original-operation' };
const material = (async () => {
  const [root, hostKey, clientKey] = await Promise.all([
    generateTrustRoot(),
    generateDeviceEncryptionKey(),
    generateDeviceEncryptionKey(),
  ]);
  const pin = {
    accountId: 'synthetic-account',
    serverOrigin: 'https://relay.synthetic.invalid',
    rootKeyId: root.keyId,
  };
  const devices = [
    {
      deviceId: 'host',
      keyId: await encryptionKeyId(hostKey.publicKey),
      publicKey: hostKey.publicKey,
      roles: ['host'] as ['host'],
    },
    {
      deviceId: 'client',
      keyId: await encryptionKeyId(clientKey.publicKey),
      publicKey: clientKey.publicKey,
      roles: ['client'] as ['client'],
    },
  ];
  const signed = await signTrustManifest({
    rootPrivateKey: root.privateKey,
    rootPublicKey: root.publicKey,
    manifest: { ...pin, version: 1, epoch: 1, previous: null, devices },
  });
  const trust = await VerifiedTrust.verify({ signed, rootPublicKey: root.publicKey, pin });
  return { root, hostKey, clientKey, pin, devices, trust };
})();
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
class Queue<T> {
  values: T[] = [];
  waiting: Array<(value: T) => void> = [];
  push(value: T) {
    const next = this.waiting.shift();
    if (next) next(value);
    else this.values.push(value);
  }
  next() {
    const value = this.values.shift();
    return value === undefined
      ? new Promise<T>((resolve) => this.waiting.push(resolve))
      : Promise.resolve(value);
  }
}
class Timers {
  entries = new Map<object, { callback: () => void; ms: number }>();
  set = (callback: () => void, ms: number) => {
    const handle = {};
    this.entries.set(handle, { callback, ms });
    return handle;
  };
  clear = (handle: unknown) => {
    this.entries.delete(handle as object);
  };
  fire(ms: number) {
    const entry = [...this.entries].find(([, entry]) => entry.ms === ms);
    assert(entry, 'Expected a registered deterministic timer');
    this.entries.delete(entry[0]);
    entry[1].callback();
  }
}
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  records = new Queue<EncryptedRecord>();
  ended = deferred<void>();
  readyMessage: unknown;
  onHello?: () => void;
  errorOnSend = false;
  send(value: string, callback?: (error?: Error) => void) {
    this.sent.push(value);
    const parsed = JSON.parse(value);
    if (parsed.type === 'hello') {
      this.onHello?.();
      if (this.readyMessage) this.deliver(this.readyMessage);
    } else this.records.push(encryptedBridgeClientRecordSchema.parse(parsed).record);
    callback?.(this.errorOnSend ? new Error('SYNTHETIC_PRIVATE_SOCKET_ERROR') : undefined);
  }
  deliver(value: unknown, binary = false) {
    this.emit(
      'message',
      typeof value === 'string' || ArrayBuffer.isView(value) ? value : JSON.stringify(value),
      binary,
    );
  }
  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.ended.resolve();
    this.emit('close');
  }
  close() {
    this.terminate();
  }
}
type Request = {
  record: EncryptedRecord;
  channel: E2eeChannel;
  body: ReturnType<typeof encryptedHostRequestSchema.parse>;
};
async function fixture(
  t: TestContext,
  options: {
    ready?: boolean;
    signal?: AbortSignal;
    current?: () => VerifiedTrust | undefined;
    trust?: VerifiedTrust;
    clientDeviceId?: string;
    privateKey?: CryptoKey;
  } = {},
) {
  const keys = await material,
    trust = options.trust ?? keys.trust,
    socket = new Socket(),
    timers = new Timers();
  const cp = trust.checkpoint,
    host = trust.device('host', 'host');
  const descriptor = {
    deviceId: host.deviceId,
    keyId: host.keyId,
    rootKeyId: cp.rootKeyId,
    trustEpoch: cp.epoch,
    trustDigest: cp.digest,
    hostChallenge: newChannelChallenge(),
  };
  const ready = {
    protocol: 4,
    type: 'ready',
    side: 'client',
    clientConnectionId: newChannelChallenge(),
    hosts: [descriptor],
  };
  if (options.ready !== false) socket.readyMessage = ready;
  const channels = new Map<string, Promise<E2eeChannel>>();
  const makeHost = (record: EncryptedRecord) => {
    const challenge = record.header.binding.clientChallenge;
    let promise = channels.get(challenge);
    if (!promise) {
      promise = E2eeChannel.create({
        side: 'host',
        trust,
        hostDeviceId: 'host',
        clientDeviceId: 'client',
        hostChallenge: record.header.binding.hostChallenge,
        clientChallenge: challenge,
        privateKey: keys.hostKey.privateKey,
        current: () => trust,
      });
      channels.set(challenge, promise);
    }
    return promise;
  };
  const connecting = EncryptedBridgeClient.connect({
    socket,
    trust,
    clientDeviceId: options.clientDeviceId ?? 'client',
    privateKey: options.privateKey ?? keys.clientKey.privateKey,
    current: options.current ?? (() => trust),
    signal: options.signal,
    timers,
  });
  void connecting.catch(() => {});
  let client: EncryptedBridgeClient | undefined;
  if (options.ready !== false) client = await connecting;
  t.after(async () => {
    client?.close();
    socket.terminate();
    for (const channel of channels.values()) (await channel).close();
  });
  const next = async (): Promise<Request> => {
    const record = await socket.records.next(),
      channel = await makeHost(record),
      opened = await channel.receive(record);
    return { record, channel, body: encryptedHostRequestSchema.parse(decode(opened.plaintext)) };
  };
  const response = async (
    request: Request,
    value: unknown,
    patch: { resource?: EncryptedResource; requestId?: string; kind?: 'response' | 'event' } = {},
  ) =>
    request.channel.send({
      kind: patch.kind ?? 'response',
      requestId: patch.requestId ?? request.record.header.requestId,
      resource: patch.resource ?? request.record.header.resource,
      plaintext: encode(value),
    });
  const answer = async (
    request: Request,
    value: unknown,
    patch: Parameters<typeof response>[2] = {},
  ) => {
    const record = await response(request, value, patch);
    socket.deliver({ protocol: 4, type: 'record', record });
    return record;
  };
  const readCatalog = async (value: unknown = catalog) => {
    assert(client);
    const result = client.catalog('host'),
      request = await next();
    assert.equal(request.body.method, 'catalog');
    await answer(request, { ok: true, result: value });
    return result;
  };
  return {
    keys,
    trust,
    socket,
    timers,
    descriptor,
    ready,
    connecting,
    client: client!,
    next,
    response,
    answer,
    readCatalog,
  };
}
function unknown(error: unknown) {
  return (
    error instanceof Error &&
    !(error instanceof EncryptedHostError) &&
    error.message === ENCRYPTED_BRIDGE_FAILED &&
    !('rejected' in error)
  );
}

test('the finite client exchanges actual WebSocket HPKE records and keeps catalogs and session bodies encrypted', async (t) => {
  const keys = await material,
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const connected = once(server, 'connection'),
    socket = new WebSocket('ws://127.0.0.1:' + address.port + '/bridge/v4/client'),
    timers = new Timers();
  const clientPromise = EncryptedBridgeClient.connect({
    socket,
    trust: keys.trust,
    clientDeviceId: 'client',
    privateKey: keys.clientKey.privateKey,
    current: () => keys.trust,
    timers,
  });
  const [relay] = (await connected) as [WebSocket];
  const inbound = new Queue<EncryptedRecord>(),
    transcript: string[] = [];
  relay.on('message', (raw) => {
    transcript.push(raw.toString());
    const message = JSON.parse(raw.toString());
    if (message.type === 'record')
      inbound.push(encryptedBridgeClientRecordSchema.parse(message).record);
  });
  const [raw] = await once(relay, 'message'),
    hello = encryptedBridgeHelloSchema.parse(JSON.parse(raw.toString()));
  assert.equal(hello.side, 'client');
  const cp = keys.trust.checkpoint,
    device = keys.trust.device('host', 'host'),
    hostChallenge = newChannelChallenge();
  relay.send(
    JSON.stringify({
      protocol: 4,
      type: 'ready',
      side: 'client',
      clientConnectionId: newChannelChallenge(),
      hosts: [
        {
          deviceId: 'host',
          keyId: device.keyId,
          rootKeyId: cp.rootKeyId,
          trustEpoch: cp.epoch,
          trustDigest: cp.digest,
          hostChallenge,
        },
      ],
    }),
  );
  const client = await clientPromise;
  t.after(async () => {
    client.close();
    relay.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const promise = client.catalog('host'),
    request = await inbound.next(),
    host = await E2eeChannel.create({
      side: 'host',
      trust: keys.trust,
      clientDeviceId: 'client',
      hostDeviceId: 'host',
      hostChallenge,
      clientChallenge: request.header.binding.clientChallenge,
      privateKey: keys.hostKey.privateKey,
      current: () => keys.trust,
    });
  t.after(() => host.close());
  assert.deepEqual(decode((await host.receive(request)).plaintext), {
    method: 'catalog',
    params: {},
  });
  const encrypted = await host.send({
    kind: 'response',
    requestId: request.header.requestId,
    resource: request.header.resource,
    plaintext: encode({ ok: true, result: catalog }),
  });
  const reply = JSON.stringify({ protocol: 4, type: 'record', record: encrypted });
  transcript.push(reply);
  relay.send(reply);
  assert.deepEqual(await promise, catalog);
  const listed = client.execute('host', sessions),
    read = await inbound.next();
  assert.deepEqual(decode((await host.receive(read)).plaintext), sessions);
  const listing = JSON.stringify({
    protocol: 4,
    type: 'record',
    record: await host.send({
      kind: 'response',
      requestId: read.header.requestId,
      resource: read.header.resource,
      plaintext: encode({ ok: true, result: [meta] }),
    }),
  });
  transcript.push(listing);
  relay.send(listing);
  assert.deepEqual(await listed, [meta]);
  for (const secret of [
    'SYNTHETIC_PRIVATE_',
    '/synthetic/private/project',
    'catalogVersion',
    'params',
    'local-owner',
  ])
    assert(!transcript.join('\n').includes(secret));
  assert.equal(timers.entries.size, 0);
});

test('readiness is an untrusted discovery hint; valid ciphertext is required before any catalog or command result', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.client.hosts(), [f.descriptor]);
  await assert.rejects(f.client.execute('host', sessions), unknown);
  const promise = f.client.catalog('host');
  void promise.catch(() => {});
  const request = await f.next();
  const valid = await f.response(request, { ok: true, result: catalog });
  const forged = await seal({
    senderPrivateKey: f.keys.clientKey.privateKey,
    recipientPublicKey: f.keys.clientKey.publicKey,
    plaintext: encode({ ok: true, result: catalog }),
    aad: encode(valid.header),
  });
  f.socket.deliver({ protocol: 4, type: 'record', record: { header: valid.header, ...forged } });
  await assert.rejects(promise, unknown);
  await f.socket.ended.promise;
  assert.throws(() => f.client.hosts(), unknown);
});

test('catalogs and command snapshots are immutable and repeated requests share a non-recreated replay receiver', async (t) => {
  const f = await fixture(t),
    received = await f.readCatalog();
  assert.deepEqual(received, catalog);
  assert(Object.isFrozen(received));
  assert(Object.isFrozen(received.workspaces[0]!.projects));
  assert.throws(() => {
    received.workspaces[0]!.projects.length = 0;
  });
  const hints = f.client.hosts();
  Reflect.set(hints[0]!, 'deviceId', 'different');
  assert.equal(f.client.hosts()[0]!.deviceId, 'host');
  const input = structuredClone(sessions),
    first = f.client.execute('host', input);
  input.workspaceId = 'changed-after-dispatch';
  const a = await f.next();
  assert.deepEqual(a.body, sessions);
  await f.answer(a, { ok: true, result: [meta] });
  assert.deepEqual(await first, [meta]);
  const second = f.client.execute('host', sessions),
    b = await f.next();
  assert.equal(a.record.header.binding.clientChallenge, b.record.header.binding.clientChallenge);
  assert.equal(b.record.header.sequence, a.record.header.sequence + 1);
  await f.answer(b, { ok: true, result: [meta] });
  assert.deepEqual(await second, [meta]);
});

test('authenticated malformed success bodies cannot bypass command validation or claim delivery', async (t) => {
  for (const [command, result] of [
    [sessions, [{ ...meta, userId: 'another-owner' }]],
    [mutation, { ...receipt, operationId: 'other-operation' }],
  ] as const) {
    const f = await fixture(t);
    await f.readCatalog();
    const promise = f.client.execute('host', command);
    void promise.catch(() => {});
    const request = await f.next();
    await f.answer(request, { ok: true, result });
    await assert.rejects(promise, unknown);
    await f.socket.ended.promise;
  }
});

test('authentic errors are typed only after HPKE verification and retain original unknown or rejection status', async (t) => {
  const f = await fixture(t);
  await f.readCatalog();
  for (const rejected of [false, true]) {
    const result = f.client.execute('host', mutation);
    void result.catch(() => {});
    const request = await f.next();
    await f.answer(request, {
      ok: false,
      error: { status: 409, message: 'Synthetic host outcome', rejected },
    });
    await assert.rejects(
      result,
      (error) =>
        error instanceof EncryptedHostError &&
        error.status === 409 &&
        error.rejected === rejected &&
        error.message === 'Synthetic host outcome',
    );
    assert.equal(f.socket.readyState, 1);
  }
  assert.equal(f.timers.entries.size, 0);
});

test('plaintext, malformed, binary and invalid UTF-8 frames never acquire Host rejection authority', async (t) => {
  for (const frame of [
    JSON.stringify({
      ok: false,
      error: { status: 409, message: 'PRIVATE_RELAY_DIAGNOSTIC', rejected: true },
    }),
    JSON.stringify({
      protocol: 4,
      type: 'unavailable',
      requestId: newChannelChallenge(),
      code: 'unavailable',
    }),
    Buffer.from([0xff]),
    '{bad json',
  ]) {
    const f = await fixture(t);
    const promise = f.client.catalog('host');
    void promise.catch(() => {});
    await f.next();
    f.socket.deliver(frame);
    await assert.rejects(promise, unknown);
    await f.socket.ended.promise;
  }
  const f = await fixture(t),
    promise = f.client.catalog('host');
  void promise.catch(() => {});
  const request = await f.next(),
    record = await f.response(request, { ok: true, result: catalog });
  f.socket.deliver(JSON.stringify({ protocol: 4, type: 'record', record }), true);
  await assert.rejects(promise, unknown);
});

test('response correlation rejects wrong resources, request ids, kinds and channel bindings before delivery', async (t) => {
  for (const variant of ['project', 'request', 'event', 'binding', 'ciphertext'] as const) {
    const f = await fixture(t);
    await f.readCatalog();
    const promise = f.client.execute('host', mutation);
    void promise.catch(() => {});
    const request = await f.next();
    const record = await f.response(
      request,
      { ok: true, result: receipt },
      variant === 'project'
        ? {
            resource: {
              ...request.record.header.resource,
              projectId: 'another-project',
            } as EncryptedResource,
          }
        : variant === 'request'
          ? { requestId: newChannelChallenge() }
          : variant === 'event'
            ? { kind: 'event' }
            : {},
    );
    if (variant === 'binding') record.header.binding.hostChallenge = newChannelChallenge();
    if (variant === 'ciphertext')
      record.ciphertext = (record.ciphertext[0] === 'A' ? 'B' : 'A') + record.ciphertext.slice(1);
    f.socket.deliver({ protocol: 4, type: 'record', record });
    await assert.rejects(promise, unknown);
    await f.socket.ended.promise;
  }
});

test('a replayed response cannot settle a later request even if a relay replaces the clear request id', async (t) => {
  for (const replace of [false, true]) {
    const f = await fixture(t);
    await f.readCatalog();
    const first = f.client.execute('host', mutation),
      a = await f.next(),
      record = await f.answer(a, { ok: true, result: receipt });
    assert.deepEqual(await first, receipt);
    const second = f.client.execute('host', mutation);
    void second.catch(() => {});
    const b = await f.next();
    if (replace) record.header.requestId = b.record.header.requestId;
    f.socket.deliver({ protocol: 4, type: 'record', record });
    await assert.rejects(second, unknown);
    await f.socket.ended.promise;
  }
});

test('a replay received while its first decrypt is pending invalidates both delivery and receiver', async (t) => {
  const f = await fixture(t);
  await f.readCatalog();
  const promise = f.client.execute('host', mutation);
  void promise.catch(() => {});
  const request = await f.next(),
    record = await f.response(request, { ok: true, result: receipt });
  f.socket.deliver({ protocol: 4, type: 'record', record });
  f.socket.deliver({ protocol: 4, type: 'record', record });
  await assert.rejects(promise, unknown);
  await f.socket.ended.promise;
});

test('64 requests reserve admission before async key work and only original records are sent', async (t) => {
  const f = await fixture(t);
  await f.readCatalog();
  const operations = Array.from({ length: ENCRYPTED_BRIDGE_LIMITS.pending }, () =>
    f.client.execute('host', sessions),
  );
  for (const result of operations) void result.catch(() => {});
  await assert.rejects(f.client.execute('host', sessions), unknown);
  const requests: Request[] = [];
  for (let index = 0; index < operations.length; index++) requests.push(await f.next());
  assert.equal(f.socket.records.values.length, 0);
  assert.equal(
    new Set(requests.map((request) => request.record.header.requestId)).size,
    operations.length,
  );
  for (const request of requests) await f.answer(request, { ok: true, result: [meta] });
  for (const result of await Promise.all(operations)) assert.deepEqual(result, [meta]);
  assert.equal(f.timers.entries.size, 0);
  assert.equal(f.socket.readyState, 1);
});

test('injected expiry closes all outstanding work without retry, reconnect or a delivered receipt', async (t) => {
  const f = await fixture(t);
  await f.readCatalog();
  const one = f.client.execute('host', mutation),
    two = f.client.execute('host', sessions);
  void one.catch(() => {});
  void two.catch(() => {});
  const first = await f.next();
  await f.next();
  const sent = f.socket.sent.length;
  f.timers.fire(ENCRYPTED_BRIDGE_LIMITS.requestMs);
  await assert.rejects(one, unknown);
  await assert.rejects(two, unknown);
  assert.equal(f.socket.readyState, 3);
  assert.equal(f.timers.entries.size, 0);
  await f.answer(first, { ok: true, result: receipt });
  assert.equal(f.socket.sent.length, sent);
  await assert.rejects(f.client.execute('host', mutation), unknown);
});

test('abort and trust retirement while decryption is pending prevent late delivery', async (t) => {
  for (const mode of ['abort', 'trust'] as const) {
    const abort = new AbortController();
    let alive = true;
    const keys = await material;
    const f = await fixture(t, {
      signal: abort.signal,
      current: () => (alive ? keys.trust : undefined),
    });
    await f.readCatalog();
    const promise = f.client.execute('host', mutation);
    void promise.catch(() => {});
    const request = await f.next(),
      record = await f.response(request, { ok: true, result: receipt });
    f.socket.deliver({ protocol: 4, type: 'record', record });
    if (mode === 'abort') abort.abort();
    else alive = false;
    await assert.rejects(promise, unknown);
    await f.socket.ended.promise;
    assert.equal(f.timers.entries.size, 0);
  }
});

test('a replaced authenticated catalog invalidates pending command validation', async (t) => {
  const f = await fixture(t);
  await f.readCatalog();
  const promise = f.client.execute('host', mutation);
  void promise.catch(() => {});
  const request = await f.next();
  await f.readCatalog({ ...catalog, workspaces: [{ ...catalog.workspaces[0]!, projects: [] }] });
  await f.answer(request, { ok: true, result: receipt });
  await assert.rejects(promise, unknown);
  await f.socket.ended.promise;
});

test('handshake timeout and explicit socket failures are finite and clear every timer', async (t) => {
  const f = await fixture(t, { ready: false });
  f.timers.fire(ENCRYPTED_BRIDGE_LIMITS.handshakeMs);
  await assert.rejects(f.connecting, unknown);
  assert.equal(f.socket.readyState, 3);
  assert.equal(f.timers.entries.size, 0);
  const g = await fixture(t);
  const promise = g.client.catalog('host');
  void promise.catch(() => {});
  await g.next();
  g.socket.emit('error', new Error('PRIVATE_SOCKET_DIAGNOSTIC'));
  await assert.rejects(promise, unknown);
  assert.equal(g.timers.entries.size, 0);
});

test('private-key and role mismatches cannot create a connected client', async (t) => {
  const keys = await material;
  for (const overrides of [{ privateKey: keys.hostKey.privateKey }, { clientDeviceId: 'host' }]) {
    const socket = new Socket(),
      timers = new Timers();
    t.after(() => socket.terminate());
    await assert.rejects(
      EncryptedBridgeClient.connect({
        socket,
        trust: keys.trust,
        clientDeviceId: 'client',
        privateKey: keys.clientKey.privateKey,
        current: () => keys.trust,
        timers,
        ...overrides,
      }),
      unknown,
    );
    assert.equal(socket.sent.length, 0);
    assert.equal(timers.entries.size, 0);
  }
});

test('ready claims must match signed host role, key, checkpoint and account root', async (t) => {
  const keys = await material;
  for (const patch of [
    { deviceId: 'client' },
    { keyId: newChannelChallenge() },
    { rootKeyId: newChannelChallenge() },
    { trustEpoch: 2 },
    { trustDigest: newChannelChallenge() },
  ]) {
    const f = await fixture(t, { ready: false });
    // Observe the hello instead of depending on crypto completion timing.
    if (!f.socket.sent.length)
      await new Promise<void>((resolve) => {
        f.socket.onHello = resolve;
      });
    f.socket.deliver({ ...f.ready, hosts: [{ ...f.descriptor, ...patch }] });
    await assert.rejects(f.connecting, unknown);
    assert.equal(f.socket.readyState, 3);
  }
  assert.equal(keys.trust.device('client', 'client').deviceId, 'client');
});

test('unknown hosts and projects never send a command and socket backpressure fails closed', async (t) => {
  const f = await fixture(t);
  await f.readCatalog();
  const before = f.socket.sent.length;
  await assert.rejects(
    f.client.execute('host', { ...sessions, localProjectId: 'other-project' }),
    unknown,
  );
  assert.equal(f.socket.sent.length, before);
  f.socket.bufferedAmount = ENCRYPTED_BRIDGE_LIMITS.pendingBytes;
  const result = f.client.execute('host', sessions);
  void result.catch(() => {});
  await assert.rejects(result, unknown);
  assert.equal(f.socket.sent.length, before);
  assert.equal(f.socket.readyState, 3);
});

test('strict shared catalogs, request wrappers and wire bounds reject alternate shapes', () => {
  assert.deepEqual(encryptedCatalogSchema.parse(catalog), catalog);
  for (const value of [
    { ...catalog, extra: 'secret' },
    { ...catalog, machineId: 'other' },
    { ...catalog, workspaces: [catalog.workspaces[0], catalog.workspaces[0]] },
    {
      ...catalog,
      workspaces: [
        {
          ...catalog.workspaces[0],
          projects: [catalog.workspaces[0]!.projects[0], catalog.workspaces[0]!.projects[0]],
        },
      ],
    },
    {
      ...catalog,
      workspaces: [
        { ...catalog.workspaces[0], agents: [{ ...agent, launchOptions: { secret: 'private' } }] },
      ],
    },
  ])
    assert.throws(() => encryptedCatalogSchema.parse(value));
  assert.throws(() =>
    encryptedHostRequestSchema.parse({ method: 'catalog', params: { execute: true } }),
  );
  assert.throws(() =>
    parseEncryptedBridgeMessage('x'.repeat(ENCRYPTED_BRIDGE_LIMITS.handshakeBytes + 1), true),
  );
  assert.throws(() => parseEncryptedBridgeMessage('{bad json}'));
  assert.deepEqual(encryptedCommandResource(mutation), {
    kind: 'session',
    workspaceId: 'runtime',
    projectId: 'project',
    sessionId: 'session',
    catalogWorkspaceId: null,
    replicaId: null,
  });
  assert.throws(
    () => encryptedCommandResource({ ...sessions, localProjectId: undefined }),
    unknown,
  );
});

test('socket open during key verification cannot announce a client and key work cannot outlive a fired handshake deadline', async (t) => {
  const keys = await material,
    socket = new Socket(),
    timers = new Timers(),
    entered = deferred<void>(),
    release = deferred<void>(),
    exported = deferred<void>();
  socket.readyState = 0;
  const original = crypto.subtle.exportKey.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'exportKey', async (format: KeyFormat, key: CryptoKey) => {
    if (key === keys.clientKey.privateKey) {
      entered.resolve();
      await release.promise;
    }
    try {
      return await Reflect.apply(original, crypto.subtle, [format, key]);
    } finally {
      if (key === keys.clientKey.privateKey) exported.resolve();
    }
  });
  const connecting = EncryptedBridgeClient.connect({
    socket,
    trust: keys.trust,
    clientDeviceId: 'client',
    privateKey: keys.clientKey.privateKey,
    current: () => keys.trust,
    timers,
  });
  void connecting.catch(() => {});
  t.after(() => {
    release.resolve();
    socket.terminate();
  });
  await entered.promise;
  socket.readyState = 1;
  socket.emit('open');
  assert.equal(socket.sent.length, 0);
  timers.fire(ENCRYPTED_BRIDGE_LIMITS.handshakeMs);
  await assert.rejects(connecting, unknown);
  assert.equal(socket.readyState, 3);
  assert.equal(timers.entries.size, 0);
  release.resolve();
  await exported.promise;
  assert.equal(socket.sent.length, 0);
});

test('a client accepts the full signed device roster above the hello bound while keeping ready bounded', async (t) => {
  const keys = await material;
  const additional = await Promise.all(
    Array.from({ length: 62 }, async (_, index) => {
      const key = await generateDeviceEncryptionKey();
      return {
        deviceId: 'host_' + index + '_' + 'x'.repeat(140),
        keyId: await encryptionKeyId(key.publicKey),
        publicKey: key.publicKey,
        roles: ['host'] as ['host'],
      };
    }),
  );
  const signed = await signTrustManifest({
    rootPrivateKey: keys.root.privateKey,
    rootPublicKey: keys.root.publicKey,
    manifest: {
      ...keys.pin,
      version: 1,
      epoch: 2,
      previous: keys.trust.checkpoint.digest,
      devices: [...keys.devices, ...additional],
    },
  });
  const trust = await VerifiedTrust.verify({
    signed,
    rootPublicKey: keys.root.publicKey,
    pin: keys.pin,
    previous: keys.trust.checkpoint,
  });
  const hosts = [keys.devices[0]!, ...additional].map((device) => ({
    deviceId: device.deviceId,
    keyId: device.keyId,
    rootKeyId: trust.checkpoint.rootKeyId,
    trustEpoch: trust.checkpoint.epoch,
    trustDigest: trust.checkpoint.digest,
    hostChallenge: newChannelChallenge(),
  }));
  const ready = {
    protocol: 4,
    type: 'ready',
    side: 'client',
    clientConnectionId: newChannelChallenge(),
    hosts,
  };
  assert(Buffer.byteLength(JSON.stringify(ready)) > ENCRYPTED_BRIDGE_LIMITS.handshakeBytes);
  assert(Buffer.byteLength(JSON.stringify(ready)) < ENCRYPTED_BRIDGE_LIMITS.readyBytes);
  const socket = new Socket(),
    timers = new Timers();
  socket.readyMessage = ready;
  const options: EncryptedClientOptions = {
    socket,
    timers,
    trust,
    clientDeviceId: 'client',
    privateKey: keys.clientKey.privateKey,
    current: () => trust,
  };
  const client = await EncryptedBridgeClient.connect(options);
  t.after(() => client.close());
  assert.equal(client.hosts().length, 63);
  const oversized = new Socket(),
    otherTimers = new Timers();
  oversized.readyMessage = JSON.stringify(ready) + ' '.repeat(ENCRYPTED_BRIDGE_LIMITS.readyBytes);
  t.after(() => oversized.terminate());
  await assert.rejects(
    EncryptedBridgeClient.connect({ ...options, socket: oversized, timers: otherTimers }),
    unknown,
  );
  assert.equal(otherTimers.entries.size, 0);
});

test('opaque operation metadata is snapshotted without freezing caller-owned session state', async (t) => {
  const f = await fixture(t);
  await f.readCatalog();
  assert.equal(mutation.method, 'mutate');
  if (mutation.method !== 'mutate') throw Error('fixture');
  const metaBundle = { version: 1, entries: { fixture: { c: 'clock', d: 'before' } } };
  const input = { ...mutation, params: { ...mutation.params, metaBundle } };
  const result = f.client.execute('host', input);
  void result.catch(() => {});
  assert.equal(Object.isFrozen(metaBundle), false);
  assert.equal(Object.isFrozen(metaBundle.entries.fixture), false);
  metaBundle.entries.fixture.d = 'after';
  const request = await f.next();
  assert.equal(request.body.method, 'mutate');
  if (request.body.method !== 'mutate') throw Error('fixture');
  assert.deepEqual(request.body.params.metaBundle, {
    version: 1,
    entries: { fixture: { c: 'clock', d: 'before' } },
  });
  await f.answer(request, { ok: true, result: receipt });
  assert.deepEqual(await result, receipt);
});

test('a fresh connection never reuses the old client challenge or emits queued operations', async (t) => {
  const first = await fixture(t),
    pending = first.client.catalog('host');
  void pending.catch(() => {});
  const original = await first.next();
  first.client.close();
  await assert.rejects(pending, unknown);
  const second = await fixture(t);
  assert.equal(second.socket.sent.length, 1);
  const result = second.client.catalog('host'),
    fresh = await second.next();
  assert.notEqual(
    original.record.header.binding.clientChallenge,
    fresh.record.header.binding.clientChallenge,
  );
  assert.notEqual(
    original.record.header.binding.hostChallenge,
    fresh.record.header.binding.hostChallenge,
  );
  assert.notEqual(original.record.header.requestId, fresh.record.header.requestId);
  assert.equal(fresh.record.header.sequence, 1);
  await second.answer(fresh, { ok: true, result: catalog });
  assert.deepEqual(await result, catalog);
});

test('caller abort settles a key-verification wait without waiting for crypto to complete', async (t) => {
  const keys = await material,
    socket = new Socket(),
    timers = new Timers(),
    controller = new AbortController(),
    entered = deferred<void>(),
    release = deferred<void>(),
    exported = deferred<void>();
  const original = crypto.subtle.exportKey.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'exportKey', async (format: KeyFormat, key: CryptoKey) => {
    if (key === keys.clientKey.privateKey) {
      entered.resolve();
      await release.promise;
    }
    try {
      return await Reflect.apply(original, crypto.subtle, [format, key]);
    } finally {
      if (key === keys.clientKey.privateKey) exported.resolve();
    }
  });
  const connecting = EncryptedBridgeClient.connect({
    socket,
    trust: keys.trust,
    clientDeviceId: 'client',
    privateKey: keys.clientKey.privateKey,
    current: () => keys.trust,
    signal: controller.signal,
    timers,
  });
  void connecting.catch(() => {});
  t.after(() => {
    release.resolve();
    socket.terminate();
  });
  await entered.promise;
  controller.abort();
  await assert.rejects(connecting, unknown);
  assert.equal(timers.entries.size, 0);
  assert.equal(socket.sent.length, 0);
  release.resolve();
  await exported.promise;
});

test('connect keeps its original socket, device identity and lease when caller options change during key verification', async (t) => {
  const keys = await material,
    socket = new Socket(),
    replacement = new Socket(),
    timers = new Timers(),
    entered = deferred<void>(),
    release = deferred<void>();
  replacement.readyState = 3;
  const cp = keys.trust.checkpoint,
    host = keys.trust.device('host', 'host');
  socket.readyMessage = {
    protocol: 4,
    type: 'ready',
    side: 'client',
    clientConnectionId: newChannelChallenge(),
    hosts: [
      {
        deviceId: host.deviceId,
        keyId: host.keyId,
        rootKeyId: cp.rootKeyId,
        trustEpoch: cp.epoch,
        trustDigest: cp.digest,
        hostChallenge: newChannelChallenge(),
      },
    ],
  };
  const original = crypto.subtle.exportKey.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'exportKey', async (format: KeyFormat, key: CryptoKey) => {
    if (key === keys.clientKey.privateKey) {
      entered.resolve();
      await release.promise;
    }
    return Reflect.apply(original, crypto.subtle, [format, key]);
  });
  const options: EncryptedClientOptions = {
    socket,
    timers,
    trust: keys.trust,
    clientDeviceId: 'client',
    privateKey: keys.clientKey.privateKey,
    current: () => keys.trust,
  };
  const connecting = EncryptedBridgeClient.connect(options);
  void connecting.catch(() => {});
  t.after(() => {
    release.resolve();
    socket.terminate();
    replacement.terminate();
  });
  await entered.promise;
  options.socket = replacement;
  options.clientDeviceId = 'host';
  options.privateKey = keys.hostKey.privateKey;
  options.current = () => undefined;
  options.signal = AbortSignal.abort();
  options.timers = new Timers();
  release.resolve();
  const client = await connecting;
  t.after(() => client.close());
  assert.equal(client.hosts()[0]!.deviceId, 'host');
  assert.equal(encryptedBridgeHelloSchema.parse(JSON.parse(socket.sent[0]!)).deviceId, 'client');
  assert.equal(socket.sent.length, 1);
  assert.equal(replacement.sent.length, 0);
  assert.equal(timers.entries.size, 0);
});
