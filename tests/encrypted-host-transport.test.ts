import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  E2eeChannel,
  newChannelChallenge,
  type EncryptedResource,
} from '../src/security/e2ee-channel';
import { generateDeviceEncryptionKey } from '../src/security/e2ee-crypto';
import {
  encryptionKeyId,
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
} from '../src/security/e2ee-trust';
import {
  encryptedBridgeHostRecordSchema,
  encryptedBridgeHelloSchema,
} from '../src/security/encrypted-bridge-protocol';
import { HostCommandDispatcher, type HostCommandWorkspace } from '../src/bridge/host-command';
import {
  ENCRYPTED_HOST_LIMITS,
  EncryptedHostTransport,
  openSecureHostEndpoint,
  type SecureHostEndpoint,
} from '../src/bridge/encrypted-host';
import { DeviceManager } from '../src/security/device-manager';
import { generateRecoveryKey } from '../src/security/e2ee-recovery';
import { PrivateEndpointFile } from '../src/security/private-endpoint-file';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const catalogResource: EncryptedResource = {
  kind: 'catalog',
  workspaceId: null,
  projectId: null,
  sessionId: null,
  catalogWorkspaceId: null,
  replicaId: null,
};
const projectResource: EncryptedResource = {
  ...catalogResource,
  kind: 'project',
  workspaceId: 'workspace',
  projectId: 'project',
};
const catalog = {
  catalogVersion: 1 as const,
  machineId: 'machine',
  workspaces: [
    {
      id: 'workspace',
      name: 'SYNTHETIC_PRIVATE_WORKSPACE',
      userId: 'local-user',
      machineId: 'machine',
      projects: [
        {
          id: 'project',
          name: 'SYNTHETIC_PRIVATE_PROJECT',
          rootPath: '/synthetic/private/project',
        },
      ],
      agents: [],
    },
  ],
};
const material = Promise.all([
  generateTrustRoot(),
  generateDeviceEncryptionKey(),
  generateDeviceEncryptionKey(),
]);

async function fixture(
  t: TestContext,
  options: {
    list?: () => unknown;
    catalog?: () => typeof catalog | Promise<typeof catalog>;
    ready?: boolean;
    deadline?: (ms: number) => AbortSignal;
    guard?: () => void;
  } = {},
) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = 'http://127.0.0.1:' + address.port;
  const [root, hostKey, clientKey] = await material;
  const pin = { accountId: 'synthetic-account', serverOrigin: origin, rootKeyId: root.keyId };
  const signed = await signTrustManifest({
    rootPrivateKey: root.privateKey,
    rootPublicKey: root.publicKey,
    manifest: {
      ...pin,
      version: 1,
      epoch: 1,
      previous: null,
      devices: [
        {
          deviceId: 'host',
          keyId: await encryptionKeyId(hostKey.publicKey),
          publicKey: hostKey.publicKey,
          roles: ['host'],
        },
        {
          deviceId: 'client',
          keyId: await encryptionKeyId(clientKey.publicKey),
          publicKey: clientKey.publicKey,
          roles: ['client'],
        },
      ],
    },
  });
  const trust = await VerifiedTrust.verify({ signed, rootPublicKey: root.publicKey, pin });
  let alive = true,
    calls = 0;
  const endpoint: SecureHostEndpoint = {
    connection: {
      kind: 'moor-trust-connection',
      origin,
      owner: pin.accountId,
      cookie: 'personal=SYNTHETIC_COOKIE_123456789',
    },
    deviceId: 'host',
    privateKey: hostKey.privateKey,
    current() {
      assert(alive);
      options.guard?.();
      return trust;
    },
    close() {
      alive = false;
    },
  };
  const workspace = {
    closed: false,
    list(projectId: string) {
      assert.equal(projectId, 'project');
      calls++;
      return options.list?.() ?? [{ id: 'SYNTHETIC_PRIVATE_SESSION' }];
    },
  } as unknown as HostCommandWorkspace;
  const dispatcher = new HostCommandDispatcher({
    ready: () => true,
    workspace: (id) => (id === 'workspace' ? workspace : undefined),
    hasOperation: () => false,
  });
  const connected = once(server, 'connection');
  const transport = new EncryptedHostTransport({
    endpoint,
    dispatcher,
    catalog: options.catalog ?? (() => catalog),
    deadline: options.deadline,
  });
  const [relay, request] = (await connected) as [
    WebSocket,
    { url: string; headers: Record<string, string> },
  ];
  const transcript: string[] = [];
  relay.on('message', (raw) => transcript.push(raw.toString()));
  const [raw] = await once(relay, 'message');
  const hello = encryptedBridgeHelloSchema.parse(JSON.parse(raw.toString()));
  assert.equal(hello.side, 'host');
  if (hello.side !== 'host') throw Error('host');
  assert.equal(request.url, '/bridge/v4/host');
  assert.equal(request.headers.origin, origin);
  assert.equal(request.headers.cookie, endpoint.connection.cookie);
  assert.equal(request.headers.authorization, undefined);
  const { protocol: _protocol, type: _type, side: _side, ...descriptor } = hello;
  if (options.ready !== false)
    relay.send(JSON.stringify({ protocol: 4, type: 'ready', side: 'host', host: descriptor }));
  const makeClient = (clientChallenge = newChannelChallenge()) =>
    E2eeChannel.create({
      side: 'client',
      trust,
      privateKey: clientKey.privateKey,
      hostDeviceId: 'host',
      clientDeviceId: 'client',
      hostChallenge: hello.hostChallenge,
      clientChallenge,
      current: () => trust,
    });
  const client = await makeClient();
  const connectionId = newChannelChallenge();
  const record = (value: unknown, resource = catalogResource, channel = client) =>
    channel.send({
      kind: 'request',
      requestId: newChannelChallenge(),
      resource,
      plaintext: encode(value),
    });
  const send = (value: unknown, owner = connectionId) =>
    relay.send(
      JSON.stringify({ protocol: 4, type: 'record', clientConnectionId: owner, record: value }),
    );
  const response = async (
    value: unknown,
    resource = catalogResource,
    channel = client,
    owner = connectionId,
  ) => {
    const received = once(relay, 'message');
    send(await record(value, resource, channel), owner);
    const [raw] = await received;
    const reply = encryptedBridgeHostRecordSchema.parse(JSON.parse(raw.toString()));
    assert.equal(reply.clientConnectionId, owner);
    const opened = await channel.receive(reply.record);
    return JSON.parse(new TextDecoder().decode(opened.plaintext));
  };
  t.after(async () => {
    transport.close();
    endpoint.close();
    client.close();
    relay.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    transport,
    relay,
    endpoint,
    hello,
    descriptor,
    transcript,
    client,
    makeClient,
    record,
    send,
    response,
    connectionId,
    calls: () => calls,
  };
}

test('v4 Host encrypts catalogue and commands over an actual WebSocket without plaintext catalogue fields', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.response({ method: 'catalog', params: {} }), {
    ok: true,
    result: catalog,
  });
  assert.deepEqual(
    await f.response(
      { method: 'sessions', workspaceId: 'workspace', localProjectId: 'project', params: {} },
      projectResource,
    ),
    { ok: true, result: [{ id: 'SYNTHETIC_PRIVATE_SESSION' }] },
  );
  assert.equal(f.calls(), 1);
  assert(f.transport.ready);
  const transcript = f.transcript.join('\n');
  for (const secret of [
    'SYNTHETIC_PRIVATE_',
    '/synthetic/private/project',
    'catalogVersion',
    'params',
    f.endpoint.connection.cookie,
  ])
    assert(!transcript.includes(secret));
});

test('v4 Host returns encrypted rejection for invalid commands and unconfirmed logical mappings', async (t) => {
  const f = await fixture(t);
  for (const [input, resource] of [
    [{ method: 'catalog', params: { extra: true } }, catalogResource],
    [{ method: 'catalog', params: {} }, projectResource],
    [
      { method: 'sessions', workspaceId: 'other', localProjectId: 'project', params: {} },
      projectResource,
    ],
    [
      { method: 'sessions', workspaceId: 'workspace', localProjectId: 'project', params: {} },
      { ...projectResource, catalogWorkspaceId: 'unconfirmed', replicaId: 'unconfirmed' },
    ],
  ] as const) {
    const result = await f.response(input, resource);
    assert.equal(result.ok, false);
    assert.equal(result.error.status, 400);
    assert.equal(result.error.rejected, true);
  }
  assert.equal(f.calls(), 0);
});

test('duplicate records share a receiver and cannot execute twice', async (t) => {
  const f = await fixture(t);
  const encrypted = await f.record(
    { method: 'sessions', workspaceId: 'workspace', localProjectId: 'project', params: {} },
    projectResource,
  );
  const first = once(f.relay, 'message');
  f.send(encrypted);
  await first;
  const closed = once(f.relay, 'close');
  f.send(encrypted);
  await closed;
  assert.equal(f.calls(), 1);
  assert.equal(f.transport.ready, false);
});

test('a retired client route cannot reopen the same challenge and replay execution', async (t) => {
  const f = await fixture(t);
  const encrypted = await f.record(
    { method: 'sessions', workspaceId: 'workspace', localProjectId: 'project', params: {} },
    projectResource,
  );
  const first = once(f.relay, 'message');
  f.send(encrypted);
  await first;
  f.relay.send(
    JSON.stringify({ protocol: 4, type: 'client-closed', clientConnectionId: f.connectionId }),
  );
  const closed = once(f.relay, 'close');
  f.send(encrypted, newChannelChallenge());
  await closed;
  assert.equal(f.calls(), 1);
});

test('a client connection cannot replace its authenticated channel binding', async (t) => {
  const f = await fixture(t);
  await f.response({ method: 'catalog', params: {} });
  const changed = await f.makeClient();
  t.after(() => changed.close());
  const closed = once(f.relay, 'close');
  f.send(await f.record({ method: 'catalog', params: {} }, catalogResource, changed));
  await closed;
  assert.equal(f.calls(), 0);
});

test('Host handshake must echo the exact connection challenge before records are admitted', async (t) => {
  const f = await fixture(t, { ready: false });
  const closed = once(f.relay, 'close');
  f.relay.send(
    JSON.stringify({
      protocol: 4,
      type: 'ready',
      side: 'host',
      host: { ...f.descriptor, hostChallenge: newChannelChallenge() },
    }),
  );
  await closed;
  assert.equal(f.calls(), 0);
});

test('an injected handshake expiry closes an unconfirmed Host without reconnecting', async (t) => {
  const deadline = new AbortController();
  const f = await fixture(t, { ready: false, deadline: () => deadline.signal });
  const closed = once(f.relay, 'close');
  deadline.abort();
  await closed;
  assert.equal(f.transport.ready, false);
  assert.equal(f.calls(), 0);
});

test('an unrelated client close cannot retire the live authenticated route', async (t) => {
  const f = await fixture(t);
  await f.response({ method: 'catalog', params: {} });
  f.relay.send(
    JSON.stringify({
      protocol: 4,
      type: 'client-closed',
      clientConnectionId: newChannelChallenge(),
    }),
  );
  assert.equal((await f.response({ method: 'catalog', params: {} })).ok, true);
});

test('Host bounds concurrently active authenticated channels', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < ENCRYPTED_HOST_LIMITS.activeChannels; index++) {
    const client = await f.makeClient();
    await f.response(
      { method: 'catalog', params: {} },
      catalogResource,
      client,
      newChannelChallenge(),
    );
    client.close();
  }
  const closed = once(f.relay, 'close');
  f.send(await f.record({ method: 'catalog', params: {} }));
  await closed;
  assert.equal(f.calls(), 0);
});

test('retired channel history remains bounded and requires a new Host connection at its limit', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < ENCRYPTED_HOST_LIMITS.lifetimeChannels; index++) {
    const client = await f.makeClient(),
      connectionId = newChannelChallenge();
    await f.response({ method: 'catalog', params: {} }, catalogResource, client, connectionId);
    f.relay.send(
      JSON.stringify({ protocol: 4, type: 'client-closed', clientConnectionId: connectionId }),
    );
    client.close();
  }
  const closed = once(f.relay, 'close');
  f.send(await f.record({ method: 'catalog', params: {} }));
  await closed;
  assert.equal(f.calls(), 0);
});

test('closing a private endpoint lease invalidates later traffic', async (t) => {
  const f = await fixture(t);
  await f.response({ method: 'catalog', params: {} });
  f.endpoint.close();
  const closed = once(f.relay, 'close');
  f.send(
    await f.record(
      { method: 'sessions', workspaceId: 'workspace', localProjectId: 'project', params: {} },
      projectResource,
    ),
  );
  await closed;
  assert.equal(f.calls(), 0);
});

test('a newly registered private directory closes the live Host before another command executes', async (t) => {
  let privateDirectoryRegistered = false;
  const f = await fixture(t, { guard: () => assert(!privateDirectoryRegistered) });
  await f.response({ method: 'catalog', params: {} });
  privateDirectoryRegistered = true;
  const closed = once(f.relay, 'close');
  f.send(
    await f.record(
      { method: 'sessions', workspaceId: 'workspace', localProjectId: 'project', params: {} },
      projectResource,
    ),
  );
  await closed;
  assert.equal(f.calls(), 0);
});

test('client closure while catalogue work is pending suppresses the encrypted response', async (t) => {
  let release!: (value: typeof catalog) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<typeof catalog>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    catalog: () => {
      entered();
      return pending;
    },
  });
  f.send(await f.record({ method: 'catalog', params: {} }));
  await started;
  f.relay.send(
    JSON.stringify({ protocol: 4, type: 'client-closed', clientConnectionId: f.connectionId }),
  );
  // A second catalogue on a separate route acknowledges that the close frame has
  // been processed, without timing assumptions or sleeps.
  const channel = await f.makeClient();
  t.after(() => channel.close());
  const encrypted = await f.record(
    { method: 'sessions', workspaceId: 'workspace', localProjectId: 'project', params: {} },
    projectResource,
    channel,
  );
  const delivered = once(f.relay, 'message');
  f.send(encrypted, newChannelChallenge());
  await delivered;
  const before = f.transcript.length,
    closed = once(f.relay, 'close');
  release(catalog);
  await closed;
  assert.equal(f.transcript.length, before);
});

test('binary and malformed relay frames cannot dispatch Host work', async (t) => {
  for (const input of [
    Buffer.from('{"type":"request"}'),
    '{"protocol":4,"type":"request","method":"sessions"}',
  ]) {
    const f = await fixture(t);
    const closed = once(f.relay, 'close');
    f.relay.send(input);
    await closed;
    assert.equal(f.calls(), 0);
  }
});

test('secure endpoint opens real private leases and rejects role, identity and server mismatches', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-encrypted-host-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const endpointFile = join(directory, 'endpoint.json'),
    connectionFile = join(directory, 'connection.json');
  const manager = await DeviceManager.open(endpointFile);
  await manager.initialize(
    {
      accountId: 'synthetic-account',
      serverOrigin: 'https://relay.synthetic.invalid',
      deviceId: 'host',
      roles: ['host'],
    },
    generateRecoveryKey(),
  );
  manager.close();
  let connection = PrivateEndpointFile.open(connectionFile);
  connection.save(null, {
    kind: 'moor-trust-connection',
    origin: 'https://relay.synthetic.invalid',
    owner: 'synthetic-account',
    cookie: 'personal=SYNTHETIC_COOKIE_123456789',
  });
  connection.close();
  const endpoint = await openSecureHostEndpoint({ endpointFile, connectionFile });
  assert.equal(endpoint.deviceId, 'host');
  assert.equal(endpoint.current().checkpoint.epoch, 1);
  assert.throws(() => PrivateEndpointFile.open(connectionFile));
  await assert.rejects(DeviceManager.open(endpointFile));
  endpoint.close();
  assert.throws(() => endpoint.current());
  await assert.rejects(
    openSecureHostEndpoint({ endpointFile, connectionFile, projectRoots: () => [directory] }),
  );
  const connectionDirectory = join(directory, 'separate-connection');
  mkdirSync(connectionDirectory, { mode: 0o700 });
  const separateConnectionFile = join(connectionDirectory, 'connection.json');
  const separate = PrivateEndpointFile.open(separateConnectionFile);
  separate.save(null, {
    kind: 'moor-trust-connection',
    origin: 'https://relay.synthetic.invalid',
    owner: 'synthetic-account',
    cookie: 'personal=SYNTHETIC_COOKIE_123456789',
  });
  separate.close();
  await assert.rejects(
    openSecureHostEndpoint({
      endpointFile,
      connectionFile: separateConnectionFile,
      projectRoots: () => [connectionDirectory],
    }),
  );
  const alias = join(directory, 'project-alias');
  symlinkSync(connectionDirectory, alias);
  await assert.rejects(
    openSecureHostEndpoint({
      endpointFile,
      connectionFile: separateConnectionFile,
      projectRoots: () => [alias],
    }),
  );
  const projects: string[] = [];
  const dynamic = await openSecureHostEndpoint({
    endpointFile,
    connectionFile: separateConnectionFile,
    projectRoots: () => projects,
  });
  assert.equal(dynamic.current().checkpoint.epoch, 1);
  projects.push(alias);
  assert.throws(() => dynamic.current());
  dynamic.close();
  await assert.rejects(
    openSecureHostEndpoint({
      endpointFile,
      connectionFile,
      server: 'https://other.synthetic.invalid',
    }),
  );
  await assert.rejects(openSecureHostEndpoint({ endpointFile, connectionFile: endpointFile }));
  await assert.rejects(
    openSecureHostEndpoint({ endpointFile, connectionFile: endpointFile + '.lock' }),
  );
  await assert.rejects(openSecureHostEndpoint({ endpointFile: 'relative.json', connectionFile }));
  connection = PrivateEndpointFile.open(connectionFile);
  const state = connection.load()!;
  connection.save(state.revision, { ...(state.value as object), owner: 'other-owner' });
  connection.close();
  await assert.rejects(openSecureHostEndpoint({ endpointFile, connectionFile }));
  connection = PrivateEndpointFile.open(connectionFile);
  const changed = connection.load()!;
  connection.save(changed.revision, { ...(changed.value as object), owner: 'synthetic-account' });
  connection.close();
  const clientFile = join(directory, 'client.json'),
    client = await DeviceManager.open(clientFile);
  await client.initialize(
    {
      accountId: 'synthetic-account',
      serverOrigin: 'https://relay.synthetic.invalid',
      deviceId: 'client',
      roles: ['client'],
    },
    generateRecoveryKey(),
  );
  client.close();
  await assert.rejects(openSecureHostEndpoint({ endpointFile: clientFile, connectionFile }));
  const reopened = await openSecureHostEndpoint({ endpointFile, connectionFile });
  const original = readFileSync(connectionFile, 'utf8');
  writeFileSync(connectionFile, original.replace('SYNTHETIC_COOKIE', 'CHANGED___COOKIE'));
  assert.throws(() => reopened.current());
  reopened.close();
});
