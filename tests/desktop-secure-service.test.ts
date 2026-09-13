import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopSecureBridge } from '../src/desktop/secure-client.cjs';
import { CLIENT_URL, CLIENT_ORIGIN } from '../src/desktop/client-assets.cjs';
import test, { type TestContext } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { hostCommandSchema } from '../src/bridge/host-command';
import { DeviceManager } from '../src/security/device-manager';
import {
  DesktopSecureClient,
  authenticateDesktopAccount,
  type DesktopSecureOptions,
} from '../src/security/desktop-client';
import {
  DESKTOP_SECURE_FAILED,
  DESKTOP_SECURE_LIMITS,
  desktopSecureRequestSchema,
  desktopSecureResultSchema,
  desktopSecureStatusSchema,
  type DesktopSecureResult,
} from '../src/security/desktop-client-protocol';
import {
  E2eeChannel,
  newChannelChallenge,
  type EncryptedRecord,
} from '../src/security/e2ee-channel';
import { generateRecoveryKey } from '../src/security/e2ee-recovery';
import {
  ENCRYPTED_BRIDGE_LIMITS,
  encryptedBridgeClientRecordSchema,
  encryptedCatalogSchema,
  encryptedHostRequestSchema,
} from '../src/security/encrypted-bridge-protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
class Queue<T> {
  #values: T[] = [];
  #waiting: Array<(value: T) => void> = [];
  push(value: T) {
    const waiting = this.#waiting.shift();
    if (waiting) waiting(value);
    else this.#values.push(value);
  }
  next(): Promise<T> {
    const value = this.#values.shift();
    return value === undefined
      ? new Promise<T>((resolve) => this.#waiting.push(resolve))
      : Promise.resolve(value);
  }
}
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  onSend?: (value: string) => void;
  send(value: string, callback?: (error?: Error) => void) {
    this.onSend?.(value);
    callback?.();
  }
  deliver(value: unknown) {
    this.emit('message', JSON.stringify(value), false);
  }
  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  close() {
    this.terminate();
  }
}
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value));
const command = hostCommandSchema.parse({
  method: 'sessions',
  workspaceId: 'runtime',
  localProjectId: 'local-project',
  params: {},
});
function value(result: DesktopSecureResult) {
  desktopSecureResultSchema.parse(result);
  assert(result.ok, JSON.stringify(result));
  return result.value;
}
function unavailable(result: DesktopSecureResult) {
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'unavailable', message: DESKTOP_SECURE_FAILED, status: null, rejected: false },
  });
}
async function fixture(
  t: TestContext,
  options: {
    realSocket?: boolean;
    ready?: boolean;
    roles?: ('host' | 'client')[];
    authenticate?: DesktopSecureOptions['authenticate'];
  } = {},
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-desktop-secure-'))),
    hostPath = join(directory, 'host', 'endpoint.json'),
    endpointPath = join(directory, 'client', 'endpoint.json'),
    server = options.realSocket ? new WebSocketServer({ host: '127.0.0.1', port: 0 }) : undefined;
  let origin = 'https://synthetic.example.test';
  if (server) {
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
  }
  mkdirSync(join(directory, 'host'), { mode: 0o700 });
  mkdirSync(join(directory, 'client'), { mode: 0o700 });
  const owner = 'synthetic-account',
    cookie = 'personal=' + Buffer.alloc(32, 83).toString('base64url'),
    host = await DeviceManager.open(hostPath),
    clientEndpoint = await DeviceManager.open(endpointPath),
    recoveryKey = generateRecoveryKey();
  await host.initialize(
    { accountId: owner, serverOrigin: origin, deviceId: 'host', roles: ['host'] },
    recoveryKey,
  );
  const hostState = host.status();
  assert('device' in hostState && hostState.revision);
  await clientEndpoint.beginPairing({
    pin: hostState.pin,
    deviceId: 'client',
    roles: options.roles ?? ['client'],
  });
  const pending = clientEndpoint.status();
  assert('device' in pending && pending.pending && pending.revision);
  const fingerprint = (await import('../src/security/e2ee-pairing')).fingerprintRequest;
  const receipt = await host.approvePairing({
    expectedRevision: hostState.revision,
    request: pending.pending.request,
    expectedFingerprint: await fingerprint(pending.pending.request),
    expectedDeviceKeyId: null,
    recoveryKey,
  });
  await clientEndpoint.acceptPairing({
    expectedRevision: pending.revision,
    approval: receipt.approval,
    rootPublicKey: receipt.trust.rootPublicKey,
    signedManifest: receipt.trust.signedManifest,
  });
  clientEndpoint.close();
  const trust = host.current()!,
    privateKey = await host.encryptionKey(),
    cp = trust.checkpoint,
    own = trust.device('host', 'host');
  const descriptor = {
    deviceId: own.deviceId,
    keyId: own.keyId,
    rootKeyId: cp.rootKeyId,
    trustEpoch: cp.epoch,
    trustDigest: cp.digest,
    hostChallenge: newChannelChallenge(),
  };
  const authority = {
    serverOrigin: origin,
    accountId: owner,
    rootKeyId: cp.rootKeyId,
    hostDeviceId: 'host',
  };
  const target = {
    catalogWorkspaceId: 'space',
    projectId: 'product',
    replicaId: 'replica',
    revision: 1,
  };
  const catalog = encryptedCatalogSchema.parse({
    catalogVersion: 2,
    machineId: 'machine',
    workspaces: [
      {
        id: 'runtime',
        name: 'SYNTHETIC_PRIVATE_WORKSPACE',
        machineId: 'machine',
        userId: 'user',
        projects: [
          {
            id: 'local-project',
            name: 'SYNTHETIC_PRIVATE_PROJECT',
            rootPath: '/synthetic/private/project',
          },
        ],
        agents: [],
        features: ['session-control-v1'],
      },
    ],
    products: {
      version: 1,
      authority,
      revision: 1,
      workspaces: [{ id: 'space', name: 'SYNTHETIC_PRIVATE_SPACE' }],
      projects: [
        {
          id: 'product',
          workspaceId: 'space',
          name: 'SYNTHETIC_PRIVATE_PRODUCT',
          source: { kind: 'local' },
        },
      ],
      replicas: [
        {
          id: 'replica',
          catalogWorkspaceId: 'space',
          projectId: 'product',
          revision: 1,
          runtimeWorkspaceId: 'runtime',
          localProjectId: 'local-project',
          machineId: 'machine',
          userId: 'user',
          available: true,
        },
      ],
    },
  });
  const channels = new Map<string, Promise<E2eeChannel>>(),
    records = new Queue<EncryptedRecord>(),
    sockets: Array<Socket | WebSocket> = [],
    calls: Array<{
      url: URL;
      options: Parameters<NonNullable<DesktopSecureOptions['socket']>>[1];
    }> = [],
    wire: string[] = [],
    deadlines: AbortController[] = [],
    hello = deferred<void>();
  let authenticated = true,
    authenticates = 0,
    currentReads = 0;
  let activeSocket: Socket | WebSocket | undefined;
  const deliver = (message: unknown) => {
    assert(activeSocket);
    if (activeSocket instanceof Socket) activeSocket.deliver(message);
    else activeSocket.send(JSON.stringify(message));
  };
  const receive = (text: string) => {
    wire.push(text);
    const message = JSON.parse(text);
    if (message.type === 'hello') {
      hello.resolve();
      if (options.ready !== false)
        deliver({
          protocol: 4,
          type: 'ready',
          side: 'client',
          clientConnectionId: newChannelChallenge(),
          hosts: [descriptor],
        });
    } else records.push(encryptedBridgeClientRecordSchema.parse(message).record);
  };
  const upgrades: unknown[] = [];
  server?.on('connection', (socket, req) => {
    activeSocket = socket;
    upgrades.push({
      url: req.url,
      origin: req.headers.origin,
      cookie: req.headers.cookie,
      extensions: req.headers['sec-websocket-extensions'],
    });
    socket.on('message', (raw) => receive(raw.toString()));
  });
  const service = new DesktopSecureClient({
    endpointPath,
    authenticate:
      options.authenticate ??
      (async () => {
        authenticates++;
        return {
          origin,
          owner,
          cookie,
          current: () => {
            currentReads++;
            if (!authenticated) throw new Error('SYNTHETIC_PRIVATE_AUTH_DETAIL');
          },
        };
      }),
    socket: (url, options) => {
      calls.push({ url, options });
      if (server) {
        const socket = new WebSocket(url, options);
        sockets.push(socket);
        return socket;
      }
      const socket = new Socket();
      socket.onSend = receive;
      activeSocket = socket;
      sockets.push(socket);
      return socket;
    },
    deadline: () => {
      const timer = new AbortController();
      deadlines.push(timer);
      return timer.signal;
    },
  });
  t.after(async () => {
    service.close();
    host.close();
    clientEndpoint.close();
    for (const socket of sockets) socket.terminate();
    for (const channel of channels.values()) (await channel).close();
    if (server) {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const next = async () => {
    const record = await records.next(),
      key = record.header.binding.clientChallenge;
    if (!channels.has(key))
      channels.set(
        key,
        E2eeChannel.create({
          side: 'host',
          trust,
          privateKey,
          hostDeviceId: 'host',
          clientDeviceId: 'client',
          hostChallenge: descriptor.hostChallenge,
          clientChallenge: key,
          current: () => trust,
        }),
      );
    const channel = await channels.get(key)!,
      opened = await channel.receive(record);
    return { record, channel, body: encryptedHostRequestSchema.parse(decode(opened.plaintext)) };
  };
  const response = async (request: Awaited<ReturnType<typeof next>>, body: unknown) =>
    request.channel.send({
      kind: 'response',
      resource: request.record.header.resource,
      requestId: request.record.header.requestId,
      plaintext: encode(body),
    });
  const answer = async (request: Awaited<ReturnType<typeof next>>, body: unknown) =>
    deliver({ protocol: 4, type: 'record', record: await response(request, body) });
  const connect = async () =>
    desktopSecureStatusSchema.parse(value(await service.request({ action: 'connect' }))).connection!
      .connectionId;
  const readCatalog = async (connectionId: string, input: unknown = catalog) => {
    const promise = service.request({ action: 'catalog', connectionId, hostId: 'host' }),
      request = await next();
    assert.equal(request.body.method, 'catalog');
    await answer(request, { ok: true, result: input });
    return promise;
  };
  return {
    service,
    endpointPath,
    host,
    trust,
    catalog,
    authority,
    target,
    origin,
    owner,
    cookie,
    calls,
    wire,
    upgrades,
    sockets,
    deadlines,
    hello,
    next,
    response,
    answer,
    deliver,
    connect,
    readCatalog,
    revoke() {
      authenticated = false;
    },
    counts: () => ({ authenticates, currentReads }),
  };
}

test('desktop secure requests are a strict closed set and execution always includes a product target', () => {
  const connectionId = '8d2e8ac4-04a0-455e-864f-2eb7e7e45297',
    hostId = 'host',
    target = {
      catalogWorkspaceId: 'space',
      projectId: 'project',
      replicaId: 'replica',
      revision: 1,
    };
  assert(
    desktopSecureRequestSchema.safeParse({
      action: 'execute',
      connectionId,
      hostId,
      target,
      command,
    }).success,
  );
  for (const request of [
    { action: 'fetch', url: 'https://example.test' },
    { action: 'connect', cookie: 'secret' },
    { action: 'connect', endpointPath: '/private/file' },
    { action: 'execute', connectionId, hostId, command },
    { action: 'execute', connectionId, hostId, target: { ...target, revision: 0 }, command },
    {
      action: 'execute',
      connectionId,
      hostId,
      target,
      command: { ...command, localProjectId: undefined },
    },
    { action: 'legacy-operation', connectionId, hostId, command },
    { action: 'catalog', connectionId: 'wrong', hostId },
    { action: 'status', extra: undefined },
  ])
    assert.equal(desktopSecureRequestSchema.safeParse(request).success, false);
});

test('status shares a single private endpoint, returns public fields and makes no connection', async (t) => {
  const f = await fixture(t),
    [first, second] = await Promise.all([
      f.service.request({ action: 'status' }),
      f.service.request({ action: 'status' }),
    ]);
  const status = desktopSecureStatusSchema.parse(value(first));
  assert.deepEqual(second, first);
  assert.equal(status.device.phase, 'active');
  assert.equal(status.connection, null);
  assert.equal(status.connecting, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.counts().authenticates, 0);
  assert(!JSON.stringify(first).includes(f.endpointPath));
  for (const secret of ['privateKey', 'recoveryCapsule', 'signedManifest', f.cookie])
    assert(!JSON.stringify(first).includes(secret));
  await assert.rejects(DeviceManager.open(f.endpointPath));
  f.service.close();
  const reopened = await DeviceManager.open(f.endpointPath);
  reopened.close();
});

test('service refuses hidden non-JSON data in business payloads before acquiring an endpoint', async (t) => {
  const f = await fixture(t),
    connectionId = '8d2e8ac4-04a0-455e-864f-2eb7e7e45297';
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      getterCalls++;
      return 'private';
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const metaBundle of [
    new ArrayBuffer(4 * 1024 * 1024),
    new Map([['secret', new Uint8Array(4096)]]),
    new Set(['secret']),
    accessor,
    cycle,
    { nested: undefined },
    new Date(),
  ]) {
    const result = await f.service.request({
      action: 'execute',
      connectionId,
      hostId: 'host',
      target: f.target,
      command: {
        method: 'mutate',
        workspaceId: 'runtime',
        localProjectId: 'local-project',
        params: {
          operationId: 'original',
          workspaceId: 'runtime',
          sessionId: 'session',
          kind: 'turn',
          expectedTurnId: null,
          update: 'SYNTHETIC_PRIVATE_UPDATE',
          metaBundle,
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'invalid-request');
  }
  assert.equal(getterCalls, 0);
  assert.equal(f.calls.length, 0);
  const manager = await DeviceManager.open(f.endpointPath);
  manager.close();
});

test('service request limit is finite and released when the admitted requests complete', async (t) => {
  const f = await fixture(t),
    connectionId = await f.connect();
  const admitted = Array.from({ length: DESKTOP_SECURE_LIMITS.pending }, () =>
    f.service.request({ action: 'status' }),
  );
  unavailable(await f.service.request({ action: 'status' }));
  for (const result of await Promise.all(admitted)) value(result);
  const status = desktopSecureStatusSchema.parse(
    value(await f.service.request({ action: 'status' })),
  );
  assert.equal(status.connection?.connectionId, connectionId);
  // Deadlines of completed requests cannot later close the long-lived connection.
  for (const deadline of f.deadlines) deadline.abort();
  assert.equal(f.sockets[0]!.readyState, 1);
  assert.equal(f.calls.length, 1);
});

test('real WebSocket performs encrypted catalog and mapped command with fixed URL and credentials', async (t) => {
  const f = await fixture(t, { realSocket: true }),
    connectionId = await f.connect();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url.href, f.origin.replace('http:', 'ws:') + '/bridge/v4/client');
  assert.equal(f.calls[0]!.options.followRedirects, false);
  assert.equal(f.calls[0]!.options.perMessageDeflate, false);
  assert.equal(f.calls[0]!.options.maxPayload, ENCRYPTED_BRIDGE_LIMITS.wireBytes);
  assert.deepEqual(f.upgrades, [
    { url: '/bridge/v4/client', origin: f.origin, cookie: f.cookie, extensions: undefined },
  ]);
  assert.deepEqual(value(await f.readCatalog(connectionId)), f.catalog);
  const sending = f.service.request({
      action: 'execute',
      connectionId,
      hostId: 'host',
      target: f.target,
      command,
    }),
    request = await f.next();
  assert.deepEqual(request.body, { method: 'mapped-command', target: f.target, command });
  assert.equal(request.record.header.resource.catalogWorkspaceId, f.target.catalogWorkspaceId);
  assert.equal(request.record.header.resource.replicaId, f.target.replicaId);
  await f.answer(request, { ok: true, result: [] });
  assert.deepEqual(value(await sending), []);
  assert.equal(f.counts().authenticates, 1);
  for (const forbidden of [
    'SYNTHETIC_PRIVATE',
    '/synthetic/private/project',
    f.cookie,
    'mapped-command',
  ])
    assert(f.wire.every((frame) => !frame.includes(forbidden)));
});

test('trusted main IPC reaches the actual Node service and encrypted Host over a real WebSocket', async (t) => {
  const f = await fixture(t, { realSocket: true }),
    cookies = new EventEmitter() as EventEmitter & { get: () => Promise<unknown[]> },
    frame = { url: CLIENT_URL, origin: CLIENT_ORIGIN },
    contents = { mainFrame: frame, isDestroyed: () => false, session: { cookies } },
    window = { webContents: contents, isDestroyed: () => false },
    registered = { window, origin: f.origin, trustedClient: true },
    registry = new Map([[contents, registered]]),
    event = { sender: contents, senderFrame: frame };
  cookies.get = async () => [
    {
      name: 'personal',
      value: f.cookie.slice('personal='.length),
      domain: new URL(f.origin).hostname,
      path: '/',
      httpOnly: true,
      hostOnly: true,
      sameSite: 'strict',
      secure: false,
      session: true,
    },
  ];
  const identityCalls: unknown[] = [];
  const bridge = new DesktopSecureBridge({
    registry,
    remoteWindow: () => window,
    origin: () => f.origin,
    endpointPath: () => f.endpointPath,
    loadRuntime: async () => ({
      DesktopSecureClient,
      authenticateDesktopAccount: (input: Parameters<typeof authenticateDesktopAccount>[0]) =>
        authenticateDesktopAccount(input, {
          request: async (url, init) => {
            identityCalls.push({ url, init });
            return new Response(
              JSON.stringify({
                owner: f.owner,
                actor: { kind: 'relay', authorityId: 'relay', accountId: f.owner },
                needsSetup: false,
                localOnly: false,
              }),
              { headers: { 'content-type': 'application/json' } },
            );
          },
        }),
    }),
  });
  t.after(() => bridge.close());
  const connectionId = desktopSecureStatusSchema.parse(
    value(await bridge.request(event, { action: 'connect' })),
  ).connection!.connectionId;
  assert.equal(identityCalls.length, 1);
  const catalog = bridge.request(event, { action: 'catalog', connectionId, hostId: 'host' }),
    catalogRequest = await f.next();
  await f.answer(catalogRequest, { ok: true, result: f.catalog });
  assert.deepEqual(value(await catalog), f.catalog);
  const executing = bridge.request(event, {
      action: 'execute',
      connectionId,
      hostId: 'host',
      target: f.target,
      command,
    }),
    commandRequest = await f.next();
  assert.deepEqual(commandRequest.body, { method: 'mapped-command', target: f.target, command });
  await f.answer(commandRequest, { ok: true, result: [] });
  assert.deepEqual(value(await executing), []);
  const late = bridge.request(event, {
      action: 'execute',
      connectionId,
      hostId: 'host',
      target: f.target,
      command,
    }),
    pending = await f.next();
  cookies.emit('changed', {}, { name: 'personal', domain: new URL(f.origin).hostname });
  const result = await late;
  assert.equal(result.ok, false);
  assert.equal(result.error.rejected, false);
  // A real main cookie-change callback closes the old service before this Host success can escape.
  const record = await f.response(pending, { ok: true, result: [] });
  assert.equal(record.header.kind, 'response');
  assert.equal(cookies.listenerCount('changed'), 0);
});

test('connection ids are fresh, duplicate connect is rejected, and disconnect never replays', async (t) => {
  const f = await fixture(t),
    first = await f.connect();
  unavailable(await f.service.request({ action: 'connect' }));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(value(await f.service.request({ action: 'disconnect', connectionId: first })), {
    disconnected: true,
  });
  const second = await f.connect();
  assert.notEqual(second, first);
  unavailable(await f.service.request({ action: 'catalog', connectionId: first, hostId: 'host' }));
  assert.equal(f.calls.length, 2);
  assert.equal(f.wire.filter((frame) => JSON.parse(frame).type === 'record').length, 0);
});

test('connecting is single flight and explicit invalidation releases a late endpoint open', async (t) => {
  const f = await fixture(t),
    originalOpen = DeviceManager.open.bind(DeviceManager),
    opened = deferred<DeviceManager>(),
    release = deferred<void>(),
    closed = deferred<void>();
  let opens = 0;
  t.mock.method(DeviceManager, 'open', async (path: string) => {
    opens++;
    const manager = await originalOpen(path),
      originalClose = manager.close.bind(manager);
    t.mock.method(manager, 'close', () => {
      originalClose();
      closed.resolve();
    });
    opened.resolve(manager);
    await release.promise;
    return manager;
  });
  const first = f.service.request({ action: 'connect' });
  await opened.promise;
  const status = f.service.request({ action: 'status' });
  unavailable(await f.service.request({ action: 'connect' }));
  assert.equal(opens, 1);
  f.service.close();
  unavailable(await first);
  unavailable(await status);
  release.resolve();
  await closed.promise;
  const reopened = await originalOpen(f.endpointPath);
  reopened.close();
  assert.equal(f.calls.length, 0);
  unavailable(await f.service.request({ action: 'status' }));
});

test('invalidation during authentication discards the late identity before opening a socket', async (t) => {
  const authentication = deferred<Awaited<ReturnType<DesktopSecureOptions['authenticate']>>>(),
    called = deferred<void>();
  const f = await fixture(t, {
    authenticate: () => {
      called.resolve();
      return authentication.promise;
    },
  });
  const connecting = f.service.request({ action: 'connect' });
  await called.promise;
  f.service.invalidate();
  unavailable(await connecting);
  authentication.resolve({ origin: f.origin, owner: f.owner, cookie: f.cookie, current() {} });
  // The next status waits for the shared endpoint lifecycle; it never initiates network I/O.
  value(await f.service.request({ action: 'status' }));
  assert.equal(f.calls.length, 0);
});

test('connect rejects endpoints without client role and mismatching identity', async (t) => {
  const hostOnly = await fixture(t, { roles: ['host'] });
  unavailable(await hostOnly.service.request({ action: 'connect' }));
  assert.equal(hostOnly.calls.length, 0);
  assert.equal(hostOnly.counts().authenticates, 0);
  const wrong = await fixture(t, {
    authenticate: async () => ({
      origin: 'https://other.example.test',
      owner: 'synthetic-account',
      cookie: 'personal=' + 'a'.repeat(32),
      current() {},
    }),
  });
  unavailable(await wrong.service.request({ action: 'connect' }));
  assert.equal(wrong.calls.length, 0);
});

test('injected handshake deadline closes only the attempted channel and releases its endpoint', async (t) => {
  const f = await fixture(t, { ready: false }),
    connecting = f.service.request({ action: 'connect' });
  await f.hello.promise;
  f.deadlines[0]!.abort();
  unavailable(await connecting);
  assert.equal(f.sockets[0]!.readyState, 3);
  const reopened = await DeviceManager.open(f.endpointPath);
  reopened.close();
  assert.equal(f.calls.length, 1);
});

test('Host errors retain status and rejected only while original endpoint and account remain current', async (t) => {
  const f = await fixture(t),
    connectionId = await f.connect();
  value(await f.readCatalog(connectionId));
  for (const rejected of [true, false]) {
    const pending = f.service.request({
        action: 'execute',
        connectionId,
        hostId: 'host',
        command,
        target: f.target,
      }),
      request = await f.next();
    await f.answer(request, {
      ok: false,
      error: { status: 409, rejected, message: 'SYNTHETIC_PRIVATE_HOST_ERROR' },
    });
    assert.deepEqual(await pending, {
      ok: false,
      error: {
        code: 'host',
        status: 409,
        rejected,
        message: rejected ? '主机明确拒绝了本次请求。' : DESKTOP_SECURE_FAILED,
      },
    });
  }
  const pending = f.service.request({
      action: 'execute',
      connectionId,
      hostId: 'host',
      command,
      target: f.target,
    }),
    request = await f.next();
  f.revoke();
  await f.answer(request, {
    ok: false,
    error: { status: 403, rejected: true, message: 'SYNTHETIC_PRIVATE_LATE_ERROR' },
  });
  unavailable(await pending);
  assert.equal(f.sockets[0]!.readyState, 3);
});

test('close during an in-flight command keeps outcome unknown and discards a late success', async (t) => {
  const f = await fixture(t),
    connectionId = await f.connect();
  value(await f.readCatalog(connectionId));
  const pending = f.service.request({
      action: 'execute',
      connectionId,
      hostId: 'host',
      command,
      target: f.target,
    }),
    request = await f.next(),
    late = await f.response(request, { ok: true, result: [] });
  f.service.invalidate();
  unavailable(await pending);
  f.deliver({ protocol: 4, type: 'record', record: late });
  assert.equal(f.calls.length, 1);
  assert.equal(f.wire.filter((frame) => JSON.parse(frame).type === 'record').length, 2);
  const reopened = await DeviceManager.open(f.endpointPath);
  reopened.close();
});

test('private endpoint file changes invalidate late decrypted successes', async (t) => {
  const f = await fixture(t),
    connectionId = await f.connect();
  value(await f.readCatalog(connectionId));
  const pending = f.service.request({
      action: 'execute',
      connectionId,
      hostId: 'host',
      command,
      target: f.target,
    }),
    request = await f.next();
  const contents = readFileSync(f.endpointPath);
  writeFileSync(f.endpointPath, Buffer.concat([contents, Buffer.from('\n')]));
  await f.answer(request, { ok: true, result: [] });
  unavailable(await pending);
  assert.equal(f.sockets[0]!.readyState, 3);
});

test('catalog cannot expose a project that contains the main-owned endpoint', async (t) => {
  const f = await fixture(t),
    connectionId = await f.connect(),
    unsafe = structuredClone(f.catalog);
  unsafe.workspaces[0]!.projects[0]!.rootPath = join(f.endpointPath, '..');
  unavailable(await f.readCatalog(connectionId, unsafe));
  assert.equal(f.sockets[0]!.readyState, 3);
});

test('a stale target never substitutes the current mapping, and request snapshots resist caller edits', async (t) => {
  const f = await fixture(t),
    connectionId = await f.connect();
  value(await f.readCatalog(connectionId));
  const request = {
      action: 'execute' as const,
      connectionId,
      hostId: 'host',
      command: structuredClone(command),
      target: { ...f.target },
    },
    pending = f.service.request(request);
  request.target.revision = 999;
  request.command.workspaceId = 'different';
  const received = await f.next();
  assert.deepEqual(received.body, { method: 'mapped-command', command, target: f.target });
  await f.answer(received, { ok: true, result: [] });
  value(await pending);
  unavailable(
    await f.service.request({
      action: 'execute',
      connectionId,
      hostId: 'host',
      command,
      target: { ...f.target, revision: 999 },
    }),
  );
  assert.equal(f.wire.filter((frame) => JSON.parse(frame).type === 'record').length, 2);
});

test('catalog actions and original inspection use the exact action and require Host receipts', async (t) => {
  const f = await fixture(t),
    connectionId = await f.connect();
  value(await f.readCatalog(connectionId));
  const action = {
    version: 1 as const,
    action: 'create-workspace' as const,
    operationId: 'original-product-operation',
    expectedRevision: 1,
    id: 'other',
    name: 'SYNTHETIC_PRIVATE_NEW_SPACE',
  };
  const pending = f.service.request({
      action: 'catalog-action',
      connectionId,
      hostId: 'host',
      request: action,
    }),
    request = await f.next();
  assert.deepEqual(request.body, { method: 'catalog-action', params: action });
  const receipt = {
    version: 1,
    authority: f.authority,
    confirmed: true,
    operationId: action.operationId,
    request: action,
    status: 'accepted',
    revision: 2,
  };
  await f.answer(request, { ok: true, result: receipt });
  assert.deepEqual(value(await pending), receipt);
  const inspecting = f.service.request({
      action: 'catalog-operation',
      connectionId,
      hostId: 'host',
      operation: { action: 'inspect', request: action },
    }),
    inspection = await f.next();
  assert.deepEqual(inspection.body, {
    method: 'catalog-operation',
    params: { action: 'inspect', request: action },
  });
  const result = {
    version: 1,
    authority: f.authority,
    confirmed: true,
    request: action,
    found: true,
    receipt,
  };
  await f.answer(inspection, { ok: true, result });
  assert.deepEqual(value(await inspecting), result);
});

test('legacy entry carries only an explicit original operation with null product resource', async (t) => {
  const f = await fixture(t),
    connectionId = await f.connect();
  value(await f.readCatalog(connectionId));
  const scope = {
      controlVersion: 1,
      workspaceId: 'runtime',
      localProjectId: 'local-project',
      userId: 'user',
      machineId: 'machine',
      sessionId: 'session',
    },
    legacy = hostCommandSchema.parse({
      method: 'session-operations',
      workspaceId: 'runtime',
      localProjectId: 'local-project',
      params: {
        ...scope,
        action: 'inspect',
        request: {
          kind: 'control',
          value: { ...scope, action: 'create', operationId: 'legacy-original', agentId: 'agent' },
        },
      },
    });
  const pending = f.service.request({
      action: 'legacy-operation',
      connectionId,
      hostId: 'host',
      command: legacy,
    }),
    request = await f.next();
  assert.deepEqual(request.body, legacy);
  assert.equal(request.record.header.resource.replicaId, null);
  assert.equal(request.record.header.resource.catalogWorkspaceId, null);
  const result = {
    ...scope,
    confirmed: true,
    action: 'inspect',
    operationId: 'legacy-original',
    found: false,
  };
  await f.answer(request, { ok: true, result });
  assert.deepEqual(value(await pending), result);
});
