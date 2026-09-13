import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { base64url } from 'jose';
import { DatabaseSync } from 'node:sqlite';
import { HostProductCatalog } from '../src/bridge/host-product-catalog';
import {
  encryptedCatalogSchema,
  type EncryptedCatalog,
} from '../src/security/encrypted-bridge-protocol';
import {
  validateEncryptedProductReceipt,
  validateEncryptedProductInspection,
  type EncryptedProductAction,
  type EncryptedProductTarget,
} from '../src/security/encrypted-product-catalog';
import {
  E2eeChannel,
  newChannelChallenge,
  type EncryptedRecord,
  type EncryptedResource,
} from '../src/security/e2ee-channel';
import { E2EE_CRYPTO_FAILED, generateDeviceEncryptionKey } from '../src/security/e2ee-crypto';
import {
  encryptionKeyId,
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
} from '../src/security/e2ee-trust';
import {
  ENCRYPTED_HOST_COMMAND_REJECTED,
  ENCRYPTED_HOST_COMMAND_LIMIT,
  EncryptedHostCommands,
} from '../src/bridge/encrypted-host-command';
import { HostCommandDispatcher, type HostCommandWorkspace } from '../src/bridge/host-command';
import { AppError } from '../src/protocol';
import { taskAuthoritySchema, type TaskAuthorityLease } from '../src/task-protocol';

const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const scope = {
  workspaceId: 'synthetic-workspace',
  localProjectId: 'synthetic-project',
  sessionId: 'synthetic-session',
};
const resource: EncryptedResource = {
  kind: 'session',
  workspaceId: scope.workspaceId,
  projectId: scope.localProjectId,
  sessionId: scope.sessionId,
  catalogWorkspaceId: null,
  replicaId: null,
};
const projectResource: EncryptedResource = { ...resource, kind: 'project', sessionId: null };
const catalogResource: EncryptedResource = {
  kind: 'catalog',
  workspaceId: null,
  projectId: null,
  sessionId: null,
  catalogWorkspaceId: null,
  replicaId: null,
};
const mutation = {
  workspaceId: scope.workspaceId,
  sessionId: scope.sessionId,
  operationId: 'synthetic-original-operation',
  kind: 'turn',
  expectedTurnId: null,
  update: 'SYNTHETIC_PRIVATE_DOCUMENT_BYTES',
};
const command = (method = 'mutate', params: unknown = mutation) => ({
  method,
  workspaceId: scope.workspaceId,
  localProjectId: scope.localProjectId,
  params,
});
const keys = (async () => {
  const [root, client, host] = await Promise.all([
    generateTrustRoot(),
    generateDeviceEncryptionKey(),
    generateDeviceEncryptionKey(),
  ]);
  const pin = {
    accountId: 'synthetic-account',
    serverOrigin: 'https://relay.synthetic.invalid',
    rootKeyId: root.keyId,
  };
  const manifest = {
    ...pin,
    version: 1 as const,
    epoch: 1,
    previous: null,
    devices: [
      {
        deviceId: 'synthetic-client',
        keyId: await encryptionKeyId(client.publicKey),
        publicKey: client.publicKey,
        roles: ['client' as const],
      },
      {
        deviceId: 'synthetic-host',
        keyId: await encryptionKeyId(host.publicKey),
        publicKey: host.publicKey,
        roles: ['host' as const],
      },
    ],
  };
  const signed = await signTrustManifest({
    manifest,
    rootPublicKey: root.publicKey,
    rootPrivateKey: root.privateKey,
  });
  const trust = await VerifiedTrust.verify({ signed, rootPublicKey: root.publicKey, pin });
  return { client, host, trust };
})();
type Call = { method: string; args: unknown[] };
async function fixture(t: TestContext, handle?: (call: Call) => unknown) {
  const identity = await keys;
  let current: VerifiedTrust | undefined = identity.trust;
  const common = {
    trust: identity.trust,
    clientDeviceId: 'synthetic-client',
    hostDeviceId: 'synthetic-host',
    hostChallenge: newChannelChallenge(),
    clientChallenge: newChannelChallenge(),
  };
  const [client, host] = await Promise.all([
    E2eeChannel.create({
      ...common,
      side: 'client',
      privateKey: identity.client.privateKey,
      current: () => identity.trust,
    }),
    E2eeChannel.create({
      ...common,
      side: 'host',
      privateKey: identity.host.privateKey,
      current: () => current,
    }),
  ]);
  t.after(() => {
    client.close();
    host.close();
  });
  const calls: Call[] = [];
  const known = new Set<string>();
  const receiver = (prefix = ''): object =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'closed') return false;
          if (property === 'controlManager' || property === 'taskManager')
            return receiver(String(property) + '.');
          return (...args: unknown[]) => {
            const call = { method: prefix + String(property), args };
            calls.push(call);
            if (handle) return handle(call);
            return call.method === 'mutate'
              ? { accepted: true, delivered: true, operationId: mutation.operationId }
              : { marker: 'SYNTHETIC_PRIVATE_RESULT' };
          };
        },
      },
    );
  const workspace = receiver() as HostCommandWorkspace;
  let journalClosed = false;
  const dispatcher = new HostCommandDispatcher({
    ready: () => true,
    workspace: (id) => (id === scope.workspaceId ? workspace : undefined),
    hasOperation: (id) => {
      if (journalClosed) throw new Error('SYNTHETIC_PRIVATE_CLOSED_DATABASE');
      return known.has(id);
    },
  });
  const adapter = new EncryptedHostCommands({ channel: host, dispatcher });
  const send = (value: unknown = command(), selected: EncryptedResource = resource) =>
    client.send({
      kind: 'request',
      requestId: newChannelChallenge(),
      resource: selected,
      plaintext: encoder.encode(JSON.stringify(value)),
    });
  const read = async (record: EncryptedRecord) => {
    const result = await client.receive(record);
    return { header: result.header, value: JSON.parse(decoder.decode(result.plaintext)) };
  };
  return {
    client,
    host,
    calls,
    known,
    adapter,
    dispatcher,
    send,
    read,
    closeJournal() {
      journalClosed = true;
    },
    revoke() {
      current = undefined;
    },
  };
}
function safeFailure(error: unknown) {
  assert.ok(error instanceof Error);
  assert.equal(error.message, E2EE_CRYPTO_FAILED);
  assert.equal(error.cause, undefined);
  return true;
}
const invalid = {
  ok: false,
  error: { status: 400, message: ENCRYPTED_HOST_COMMAND_REJECTED, rejected: true },
};
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('real authenticated encryption dispatches the original operation and derives the entire authority from the channel', async (t) => {
  const f = await fixture(t);
  const request = await f.send(
    command('mutate', {
      ...mutation,
      authorityOwner: 'attacker',
      secureChannel: { clientDeviceId: 'attacker' },
    }),
  );
  const response = await f.adapter.execute(request);
  assert.equal(JSON.stringify(request).includes(mutation.update), false);
  assert.equal(JSON.stringify(response).includes(mutation.operationId), false);
  assert.equal(JSON.stringify(response).includes('accepted'), false);
  const received = await f.read(response);
  assert.equal(received.header.requestId, request.header.requestId);
  assert.deepEqual(received.header.resource, resource);
  assert.equal(received.header.direction, 'host-to-client');
  assert.equal(received.header.kind, 'response');
  assert.deepEqual(received.value, {
    ok: true,
    result: {
      accepted: true,
      delivered: true,
      operationId: mutation.operationId,
    },
  });
  assert.equal(f.calls.length, 1);
  const [input, project, lease] = f.calls[0]!.args;
  assert.deepEqual(input, mutation);
  assert.equal(project, scope.localProjectId);
  const authority = lease as TaskAuthorityLease;
  const { current, ...stored } = authority;
  const binding = f.host.binding;
  assert.deepEqual(stored, {
    serverOrigin: binding.serverOrigin,
    ownerId: binding.accountId,
    deviceId: binding.hostDeviceId,
    secureChannel: {
      version: 1,
      clientDeviceId: binding.clientDeviceId,
      clientKeyId: binding.clientKeyId,
      rootKeyId: binding.rootKeyId,
      trustEpoch: binding.trustEpoch,
      trustDigest: binding.trustDigest,
      hostChallenge: binding.hostChallenge,
      clientChallenge: binding.clientChallenge,
    },
  });
  assert.deepEqual(taskAuthoritySchema.parse(stored), stored);
  current();
  f.revoke();
  assert.throws(current, safeFailure);
});

test('only project-level sessions and agent-options may omit the session; session options require an exact session header', async (t) => {
  const f = await fixture(t);
  for (const value of [command('sessions', {}), command('agent-options', { agentId: 'agent' })]) {
    const response = await f.adapter.execute(await f.send(value, projectResource));
    assert.equal((await f.read(response)).value.ok, true);
  }
  const options = command('agent-options', { agentId: 'agent', sessionId: scope.sessionId });
  assert.equal((await f.read(await f.adapter.execute(await f.send(options)))).value.ok, true);
  for (const [value, selected] of [
    [command('sessions', {}), resource],
    [command('agent-options', { agentId: 'agent' }), resource],
    [options, projectResource],
    [command(), projectResource],
    [command(), catalogResource],
  ] as const) {
    assert.deepEqual(
      (await f.read(await f.adapter.execute(await f.send(value, selected)))).value,
      invalid,
    );
  }
  assert.equal(f.calls.length, 3);
});

test('an adapter without a product authority rejects nonempty product scope before dispatch', async (t) => {
  const f = await fixture(t);
  const forged: EncryptedResource = {
    ...resource,
    catalogWorkspaceId: 'unconfirmed-workspace',
    replicaId: 'unconfirmed-replica',
  };
  assert.deepEqual(
    (await f.read(await f.adapter.execute(await f.send(command(), forged)))).value,
    invalid,
  );
  assert.equal(f.calls.length, 0);
});

test('authenticated but invalid JSON, UTF-8, outer schema or direct and nested scopes receive only a fixed encrypted 400', async (t) => {
  const f = await fixture(t);
  const version = 'sha256:' + '1'.repeat(64);
  const preview = {
    ...scope,
    previewVersion: 1,
    clientId: 'client',
    operationId: 'preview-op',
    confirmed: true,
    action: 'open',
    serviceId: 'service',
    serviceVersion: version,
    executionRevision: 0,
    viewport: { width: 390, height: 800 },
  };
  const control = {
    ...scope,
    userId: 'user',
    machineId: 'machine',
    controlVersion: 1,
    action: 'create',
    operationId: 'create-op',
    agentId: 'agent',
  };
  const recovery = {
    ...scope,
    userId: 'user',
    machineId: 'machine',
    controlVersion: 1,
    action: 'inspect',
    request: { kind: 'control', value: control },
  };
  const inputs = [
    null,
    {},
    { ...command(), method: 'raw-shell' },
    { ...command(), authorityOwner: 'attacker' },
    { ...command(), workspaceId: 'other-workspace' },
    { ...command(), localProjectId: undefined },
    { ...command(), localProjectId: 'other-project' },
    command('mutate', { ...mutation, workspaceId: 'other-workspace' }),
    command('mutate', { ...mutation, sessionId: 'other-session' }),
    command('mcp-read', { ...scope, mcpVersion: 1, localProjectId: 'other-project' }),
    command('preview-inspect', { request: { ...preview, sessionId: 'other-session' } }),
    command('preview-close', { request: { ...preview, localProjectId: 'other-project' } }),
    command('preview-inspect', { request: { ...preview, workspaceId: 'other-workspace' } }),
    command('session-operations', {
      ...recovery,
      request: { kind: 'control', value: { ...control, sessionId: 'other-session' } },
    }),
  ];
  const plaintexts = inputs.map((value) => encoder.encode(JSON.stringify(value)));
  plaintexts.push(encoder.encode('{SYNTHETIC_PRIVATE_INVALID_JSON'), new Uint8Array([0xff]));
  for (const plaintext of plaintexts) {
    const request = await f.client.send({
      kind: 'request',
      requestId: newChannelChallenge(),
      resource,
      plaintext,
    });
    const response = await f.adapter.execute(request);
    assert.equal(JSON.stringify(response).includes(ENCRYPTED_HOST_COMMAND_REJECTED), false);
    const output = await f.read(response);
    assert.equal(output.header.requestId, request.header.requestId);
    assert.deepEqual(output.value, invalid);
  }
  assert.equal(f.calls.length, 0);
  const nested = await f.adapter.execute(await f.send(command('session-operations', recovery)));
  assert.equal((await f.read(nested)).value.ok, true);
  assert.equal(f.calls[0]!.method, 'controlManager.recover');
});

test('tampered ciphertext, authenticated scope headers and wrong direction fail without execution or plaintext diagnostics', async (t) => {
  const f = await fixture(t),
    request = await f.send();
  const bytes = base64url.decode(request.ciphertext);
  bytes[0] ^= 1;
  const changedScope = structuredClone(request);
  changedScope.header.resource = { ...resource, sessionId: 'other-session' };
  for (const bad of [
    null,
    {},
    { ...request, ciphertext: base64url.encode(bytes) },
    changedScope,
    { ...request, header: { ...request.header, direction: 'host-to-client', kind: 'response' } },
  ])
    await assert.rejects(f.adapter.execute(bad), safeFailure);
  assert.equal(f.calls.length, 0);
  const hostResponse = await f.host.send({
    kind: 'response',
    requestId: newChannelChallenge(),
    resource,
    plaintext: encoder.encode(JSON.stringify(command())),
  });
  const wrongSide = new EncryptedHostCommands({ channel: f.client, dispatcher: f.dispatcher });
  await assert.rejects(wrongSide.execute(hostResponse), safeFailure);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.read(await f.adapter.execute(request))).value.ok, true);
});

test('replayed and simultaneous copied records execute at most once and are never queued for reconnect', async (t) => {
  const f = await fixture(t),
    request = await f.send();
  const outcomes = await Promise.allSettled([
    f.adapter.execute(request),
    f.adapter.execute(request),
  ]);
  assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((value) => value.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  safeFailure(rejected.reason);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.adapter.execute(request), safeFailure);
  const fresh = await fixture(t);
  await assert.rejects(fresh.adapter.execute(request), safeFailure);
  assert.equal(fresh.calls.length, 0);
});

test('execution errors stay encrypted and retain the original journal-based rejected versus unknown result', async (t) => {
  const f = await fixture(t, () => {
    throw new Error('SYNTHETIC_PRIVATE_EXECUTION_ERROR');
  });
  const first = await f.adapter.execute(await f.send());
  assert.equal(JSON.stringify(first).includes('SYNTHETIC_PRIVATE_EXECUTION_ERROR'), false);
  assert.deepEqual((await f.read(first)).value, {
    ok: false,
    error: {
      status: 502,
      message: '本地主机处理失败',
      rejected: true,
    },
  });
  f.known.add(mutation.operationId);
  assert.deepEqual((await f.read(await f.adapter.execute(await f.send()))).value, {
    ok: false,
    error: {
      status: 502,
      message: '本地主机处理失败',
      rejected: false,
    },
  });
  const denied = await fixture(t, () => {
    throw new AppError(409, '原授权已变化', true);
  });
  assert.deepEqual((await denied.read(await denied.adapter.execute(await denied.send()))).value, {
    ok: false,
    error: { status: 409, message: '原授权已变化', rejected: true },
  });
});

test('serialization and shutdown failures never escape as plaintext implementation diagnostics', async (t) => {
  const invalidResult = await fixture(t, () => ({ unsupported: 1n }));
  assert.deepEqual(
    (await invalidResult.read(await invalidResult.adapter.execute(await invalidResult.send())))
      .value,
    { ok: false, error: { status: 502, message: '本地主机处理失败', rejected: true } },
  );
  const closed = await fixture(t, () => {
    throw new Error('SYNTHETIC_PRIVATE_EXECUTION_ERROR');
  });
  closed.closeJournal();
  await assert.rejects(closed.adapter.execute(await closed.send()), safeFailure);
  assert.equal(closed.calls.length, 1);
});

test('closure or trust revocation during execution preserves acceptance but suppresses all late responses', async (t) => {
  for (const close of [false, true]) {
    const started = signal(),
      release = signal();
    const f = await fixture(t, async (call) => {
      const authority = call.args[2] as TaskAuthorityLease;
      authority.current();
      started.resolve();
      await release.promise;
      return { accepted: true, delivered: true, operationId: mutation.operationId };
    });
    const pending = f.adapter.execute(await f.send());
    await started.promise;
    if (close) f.host.close();
    else f.revoke();
    release.resolve();
    await assert.rejects(pending, safeFailure);
    assert.equal(f.calls.length, 1);
    const lease = f.calls[0]!.args[2] as TaskAuthorityLease;
    assert.throws(() => lease.current(), safeFailure);
  }
  const stopped = await fixture(t),
    request = await stopped.send();
  stopped.host.close();
  await assert.rejects(stopped.adapter.execute(request), safeFailure);
  assert.equal(stopped.calls.length, 0);
});

test('secure authority is optional for existing local flows and exact for encrypted identities', async (t) => {
  const f = await fixture(t);
  const old = {
    serverOrigin: 'https://relay.synthetic.invalid',
    ownerId: 'owner',
    deviceId: 'host',
  };
  assert.deepEqual(taskAuthoritySchema.parse(old), old);
  await f.adapter.execute(await f.send());
  const { current: _current, ...authority } = f.calls[0]!.args[2] as TaskAuthorityLease;
  assert.deepEqual(taskAuthoritySchema.parse(authority), authority);
  for (const secureChannel of [
    null,
    {},
    { ...authority.secureChannel, version: 2 },
    { ...authority.secureChannel, trustEpoch: 0 },
    { ...authority.secureChannel, clientKeyId: 'A'.repeat(42) + 'B' },
    { ...authority.secureChannel, clientChallenge: 'A'.repeat(42) },
    { ...authority.secureChannel, credential: 'SYNTHETIC_PRIVATE_VALUE' },
  ])
    assert.equal(taskAuthoritySchema.safeParse({ ...old, secureChannel }).success, false);
});

test('Host admission stays bounded through slow commands and is shared across encrypted channels', async (t) => {
  let started = signal();
  const releases: ReturnType<typeof signal>[] = [];
  const f = await fixture(t, async () => {
    const release = signal();
    releases.push(release);
    started.resolve();
    await release.promise;
    return { marker: 'SYNTHETIC_PRIVATE_RESULT' };
  });
  t.after(() => releases.forEach((release) => release.resolve()));
  const readCommand = command('session', { sessionId: scope.sessionId });
  const pending: Promise<EncryptedRecord>[] = [];
  for (let index = 0; index < ENCRYPTED_HOST_COMMAND_LIMIT; index++) {
    const entered = started;
    pending.push(f.adapter.execute(await f.send(readCommand)));
    await entered.promise;
    started = signal();
  }
  const extra = await f.send(readCommand);
  await assert.rejects(f.adapter.execute(extra), safeFailure);
  const second = await fixture(t);
  const shared = new EncryptedHostCommands({ channel: second.host, dispatcher: f.dispatcher });
  const secondRequest = await second.send(readCommand);
  await assert.rejects(shared.execute(secondRequest), safeFailure);
  assert.equal(f.calls.length, ENCRYPTED_HOST_COMMAND_LIMIT);
  assert.equal(releases.length, ENCRYPTED_HOST_COMMAND_LIMIT);

  releases.forEach((release) => release.resolve());
  const responses = await Promise.all(pending);
  for (const response of responses)
    assert.deepEqual((await f.read(response)).value, {
      ok: true,
      result: { marker: 'SYNTHETIC_PRIVATE_RESULT' },
    });
  // Rejected admission did not consume either record. Only this explicit call retries it.
  const resumed = shared.execute(secondRequest);
  await started.promise;
  releases.at(-1)!.resolve();
  assert.equal((await second.read(await resumed)).value.ok, true);
  assert.equal(f.calls.length, ENCRYPTED_HOST_COMMAND_LIMIT + 1);
});

/** Production adapter + persistent catalog; only the execution workspace is synthetic. */
async function productFixture(t: TestContext, handle?: (call: Call) => unknown) {
  const f = await fixture(t, handle),
    db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE operation(id TEXT PRIMARY KEY, fingerprint TEXT, phase TEXT, result TEXT)');
  let runtime: EncryptedCatalog = {
    catalogVersion: 1,
    machineId: 'synthetic-machine',
    workspaces: [
      {
        id: scope.workspaceId,
        name: 'Synthetic runtime',
        machineId: 'synthetic-machine',
        userId: 'synthetic-user',
        projects: [
          { id: scope.localProjectId, name: 'Synthetic project', rootPath: '/synthetic/project' },
        ],
        agents: [],
      },
    ],
  };
  const { serverOrigin, accountId, rootKeyId, hostDeviceId } = f.host.binding,
    authority = { serverOrigin, accountId, rootKeyId, hostDeviceId },
    products = new HostProductCatalog({ db, authority, runtime: () => runtime });
  const adapter = new EncryptedHostCommands({
    channel: f.host,
    dispatcher: f.dispatcher,
    products,
    catalog: () => ({ ...runtime, catalogVersion: 2, products: products.read() }),
  });
  const target = (): EncryptedProductTarget => {
    const replica = products.read().replicas[0]!;
    return {
      catalogWorkspaceId: replica.catalogWorkspaceId,
      projectId: replica.projectId,
      replicaId: replica.id,
      revision: replica.revision,
    };
  };
  const mapped = (
    value: unknown = command(),
    selected = target(),
    aad: EncryptedResource = resource,
  ) => {
    if (aad.kind === 'catalog')
      throw Error('Synthetic business fixture requires a business resource');
    return f.send(
      { method: 'mapped-command', target: selected, command: value },
      { ...aad, catalogWorkspaceId: selected.catalogWorkspaceId, replicaId: selected.replicaId },
    );
  };
  const action = async (request: EncryptedProductAction) => {
    const response = await f.read(
      await adapter.execute(
        await f.send({ method: 'catalog-action', params: request }, catalogResource),
      ),
    );
    assert.equal(response.value.ok, true);
    return validateEncryptedProductReceipt(response.value.result, authority, request);
  };
  const createSpace = (
    operationId = 'create-space',
    id = 'other-space',
  ): EncryptedProductAction => ({
    version: 1,
    operationId,
    action: 'create-workspace',
    expectedRevision: products.read().revision,
    id,
    name: 'Synthetic private space',
  });
  const move = async () => {
    await action(createSpace());
    await action({
      version: 1,
      operationId: 'move-product',
      expectedRevision: products.read().revision,
      action: 'move-host',
      runtimeWorkspaceId: scope.workspaceId,
      targetWorkspaceId: 'other-space',
    });
  };
  return {
    ...f,
    adapter,
    db,
    products,
    authority,
    target,
    mapped,
    action,
    createSpace,
    move,
    get runtime() {
      return runtime;
    },
    set runtime(value: EncryptedCatalog) {
      runtime = value;
    },
  };
}
function productRecovery(original: unknown = mutation, action: 'inspect' | 'abandon' = 'inspect') {
  return command('session-operations', {
    ...scope,
    userId: 'synthetic-user',
    machineId: 'synthetic-machine',
    controlVersion: 1,
    action,
    request: { kind: 'mutation', value: original },
  });
}

test('real product catalog actions, inspection and abandonment remain inside authenticated catalog records', async (t) => {
  const f = await productFixture(t),
    request = await f.send({ method: 'catalog', params: {} }, catalogResource),
    response = await f.adapter.execute(request),
    decoded = await f.read(response);
  assert.deepEqual(decoded.header.resource, catalogResource);
  assert.equal(decoded.header.requestId, request.header.requestId);
  assert.equal(JSON.stringify(response).includes('/synthetic/project'), false);
  const catalog = encryptedCatalogSchema.parse(decoded.value.result);
  assert.equal(catalog.catalogVersion, 2);
  if (catalog.catalogVersion !== 2) throw Error();
  assert.deepEqual(catalog.products.authority, f.authority);
  assert.deepEqual(catalog.products, f.products.read());
  const action = f.createSpace();
  const accepted = await f.action(action);
  assert.equal(accepted.status, 'accepted');
  const inspect = await f.read(
    await f.adapter.execute(
      await f.send(
        { method: 'catalog-operation', params: { action: 'inspect', request: action } },
        catalogResource,
      ),
    ),
  );
  const inspection = validateEncryptedProductInspection(inspect.value.result, f.authority, action);
  assert.equal(inspection.found, true);
  if (inspection.found) assert.deepEqual(inspection.receipt, accepted);
  const unseen = f.createSpace('unseen', 'never-created'),
    before = f.products.read();
  const abandon = await f.read(
    await f.adapter.execute(
      await f.send(
        { method: 'catalog-operation', params: { action: 'abandon', request: unseen } },
        catalogResource,
      ),
    ),
  );
  const sealed = validateEncryptedProductReceipt(abandon.value.result, f.authority, unseen);
  assert.equal(sealed.status, 'abandoned');
  assert.deepEqual(await f.action(unseen), sealed);
  assert.deepEqual(f.products.read(), before);
  assert.equal(f.calls.length, 0);
});

test('a product-enabled adapter refuses raw business and mismatched mapped target or AAD before dispatch or claiming an operation', async (t) => {
  const f = await productFixture(t),
    selected = f.target();
  for (const value of [command(), command('sessions', {})]) {
    const aad: EncryptedResource = value.method === 'sessions' ? projectResource : resource;
    assert.deepEqual(
      (await f.read(await f.adapter.execute(await f.send(value, aad)))).value,
      invalid,
    );
  }
  const wrapper = { method: 'mapped-command', target: selected, command: command() };
  for (const [value, aad] of [
    [wrapper, resource],
    [wrapper, { ...resource, catalogWorkspaceId: 'other', replicaId: selected.replicaId }],
    [wrapper, { ...resource, catalogWorkspaceId: selected.catalogWorkspaceId, replicaId: 'other' }],
    [
      wrapper,
      {
        ...resource,
        catalogWorkspaceId: selected.catalogWorkspaceId,
        replicaId: selected.replicaId,
        sessionId: 'other',
      },
    ],
    [wrapper, catalogResource],
  ] as const) {
    const output = (await f.read(await f.adapter.execute(await f.send(value, aad)))).value;
    assert.deepEqual(output, invalid);
  }
  for (const changed of [{ projectId: 'wrong-product' }, { revision: selected.revision + 1 }]) {
    const output = (
      await f.read(await f.adapter.execute(await f.mapped(command(), { ...selected, ...changed })))
    ).value;
    assert.equal(output.ok, false);
    assert.equal(output.error.status, 409);
    assert.equal(output.error.rejected, false);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS count FROM encrypted_product_operation').get()!.count,
    0,
  );
  const valid = await f.adapter.execute(await f.mapped());
  assert.equal((await f.read(valid)).value.ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS count FROM encrypted_product_operation').get()!.count,
    1,
  );
});

test('authenticated product AAD tampering cannot consume a valid mapped request or execute it', async (t) => {
  const f = await productFixture(t),
    original = await f.mapped(),
    changed = structuredClone(original);
  changed.header.resource.replicaId = 'tampered';
  await assert.rejects(f.adapter.execute(changed), safeFailure);
  assert.equal(f.calls.length, 0);
  const response = await f.adapter.execute(original),
    decoded = await f.read(response);
  assert.equal(decoded.value.ok, true);
  assert.deepEqual(decoded.header.resource, original.header.resource);
  assert.equal(f.calls.length, 1);
});

test('an active command lease rejects a catalog change until dispatch and response finish, without discarding the original action', async (t) => {
  const entered = signal(),
    release = signal();
  t.after(() => release.resolve());
  const f = await productFixture(t, async () => {
    entered.resolve();
    await release.promise;
    return { marker: 'done' };
  });
  const before = f.products.read(),
    action = f.createSpace(),
    pending = f.adapter.execute(await f.mapped());
  await entered.promise;
  const blocked = await f.read(
    await f.adapter.execute(
      await f.send({ method: 'catalog-action', params: action }, catalogResource),
    ),
  );
  assert.equal(blocked.value.ok, false);
  assert.equal(blocked.value.error.status, 409);
  assert.equal(blocked.value.error.rejected, false);
  assert.deepEqual(f.products.read(), before);
  assert.equal(f.products.inspect(action).found, false);
  release.resolve();
  assert.equal((await f.read(await pending)).value.ok, true);
  assert.equal((await f.action(action)).status, 'accepted');
  assert.equal(f.calls.length, 1);
});

for (const failure of [false, true])
  test(`runtime invalidation suppresses a late ${failure ? 'error' : 'success'} and releases the original command lease`, async (t) => {
    const entered = signal(),
      release = signal();
    t.after(() => release.resolve());
    const f = await productFixture(t, async (call) => {
      const lease = call.args[2] as TaskAuthorityLease;
      lease.current();
      entered.resolve();
      await release.promise;
      if (failure) throw Error('SYNTHETIC_PRIVATE_LATE_ERROR');
      return { marker: 'SYNTHETIC_PRIVATE_LATE_SUCCESS' };
    });
    const originalTarget = f.target(),
      pending = f.adapter.execute(await f.mapped());
    await entered.promise;
    f.runtime.workspaces[0]!.projects[0]!.rootPath = '/synthetic/replaced';
    release.resolve();
    await assert.rejects(pending, safeFailure);
    assert.equal(f.calls.length, 1);
    assert.throws(() => (f.calls[0]!.args[2] as TaskAuthorityLease).current());
    assert.ok(f.target().revision > originalTarget.revision);
    assert.equal((await f.action(f.createSpace())).status, 'accepted');
  });

test('historical mapped recovery uses a durable claim after organization moves and cannot migrate its original body or runtime', async (t) => {
  const f = await productFixture(t),
    originalTarget = f.target();
  assert.equal((await f.read(await f.adapter.execute(await f.mapped()))).value.ok, true);
  await f.move();
  const currentTarget = f.target();
  assert.notEqual(currentTarget.catalogWorkspaceId, originalTarget.catalogWorkspaceId);
  for (const selected of [originalTarget, currentTarget]) {
    const response = await f.read(await f.adapter.execute(await f.mapped(command(), selected)));
    assert.equal(response.value.ok, false);
  }
  assert.equal(f.calls.length, 1);
  for (const action of ['inspect', 'abandon'] as const) {
    const result = await f.read(
      await f.adapter.execute(await f.mapped(productRecovery(mutation, action), originalTarget)),
    );
    assert.equal(result.value.ok, true);
  }
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1]!.method, 'controlManager.recover');
  assert.equal(f.calls[2]!.method, 'controlManager.recover');
  const changed = productRecovery({ ...mutation, update: 'CHANGED_ORIGINAL_BYTES' });
  assert.equal(
    (await f.read(await f.adapter.execute(await f.mapped(changed, originalTarget)))).value.ok,
    false,
  );
  assert.equal(
    (await f.read(await f.adapter.execute(await f.send(productRecovery())))).value.ok,
    false,
  );
  f.runtime.workspaces[0]!.projects[0]!.rootPath = '/synthetic/replacement';
  assert.equal(
    (await f.read(await f.adapter.execute(await f.mapped(productRecovery(), originalTarget)))).value
      .ok,
    false,
  );
  assert.equal(f.calls.length, 3);
});

test('an unknown inspection never creates a historical mapping claim; stale inspect and abandon remain rejected', async (t) => {
  const f = await productFixture(t),
    selected = f.target();
  assert.equal(
    (await f.read(await f.adapter.execute(await f.mapped(productRecovery())))).value.ok,
    true,
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS count FROM encrypted_product_operation').get()!.count,
    0,
  );
  await f.move();
  for (const action of ['inspect', 'abandon'] as const) {
    const response = await f.read(
      await f.adapter.execute(await f.mapped(productRecovery(mutation, action), selected)),
    );
    assert.equal(response.value.ok, false);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS count FROM encrypted_product_operation').get()!.count,
    0,
  );
});

test('legacy recovery can inspect or seal the original without claiming a product target for execution', async (t) => {
  const f = await productFixture(t),
    selected = f.target();
  f.db
    .prepare('INSERT INTO operation VALUES(?,?,?,?)')
    .run(mutation.operationId, 'legacy', 'accepted', '{}');
  for (const action of ['inspect', 'abandon'] as const) {
    const request = productRecovery(mutation, action);
    assert.equal((await f.read(await f.adapter.execute(await f.send(request)))).value.ok, true);
    assert.equal(
      (await f.read(await f.adapter.execute(await f.mapped(request, selected)))).value.ok,
      false,
    );
  }
  assert.equal((await f.read(await f.adapter.execute(await f.mapped()))).value.ok, false);
  assert.equal(f.calls.length, 2);
});

for (const invalidate of [false, true])
  test(`product authority stays leased until response encryption finishes${invalidate ? ' and suppresses an already sealed obsolete response' : ''}`, async (t) => {
    const f = await productFixture(t),
      sealed = signal(),
      release = signal(),
      request = await f.mapped(),
      originalSend = E2eeChannel.prototype.send;
    t.after(() => release.resolve());
    t.mock.method(
      E2eeChannel.prototype,
      'send',
      async function (this: E2eeChannel, input: Parameters<typeof originalSend>[0]) {
        const response = await originalSend.call(this, input);
        if (this === f.host && input.requestId === request.header.requestId) {
          sealed.resolve();
          await release.promise;
        }
        return response;
      },
    );
    const pending = f.adapter.execute(request);
    await sealed.promise;
    const action = f.createSpace();
    assert.throws(() => f.products.action(action));
    assert.equal(f.products.inspect(action).found, false);
    if (invalidate)
      f.runtime.workspaces[0]!.projects[0]!.rootPath = '/synthetic/replaced-after-sealing';
    release.resolve();
    if (invalidate) await assert.rejects(pending, safeFailure);
    else assert.equal((await f.read(await pending)).value.ok, true);
    const next = { ...action, expectedRevision: f.products.read().revision };
    assert.equal(f.products.action(next).status, 'accepted');
    assert.equal(f.calls.length, 1);
  });

test('encrypted permission execution and recovery reject missing review bindings before dispatch or product registration', async (t) => {
  const permission = {
    ...mutation,
    kind: 'permission',
    expectedTurnId: 'synthetic-user-turn',
    requestId: 'synthetic-permission-request',
  };
  const commands = [
    command('mutate', permission),
    productRecovery(permission, 'inspect'),
    productRecovery(permission, 'abandon'),
  ];
  const legacy = await fixture(t);
  for (const original of commands) {
    const result = await legacy.read(await legacy.adapter.execute(await legacy.send(original)));
    assert.deepEqual(result.value, invalid);
    assert.equal(legacy.calls.length, 0);
  }
  const mapped = await productFixture(t);
  let bindings = 0;
  const bind = mapped.products.bindOperation.bind(mapped.products);
  mapped.products.bindOperation = (...args) => {
    bindings++;
    return bind(...args);
  };
  for (const original of commands) {
    const result = await mapped.read(await mapped.adapter.execute(await mapped.mapped(original)));
    assert.deepEqual(result.value, invalid);
    assert.equal(mapped.calls.length, 0);
    assert.equal(bindings, 0);
  }
  for (const original of commands.slice(1)) {
    const result = await mapped.read(await mapped.adapter.execute(await mapped.send(original)));
    assert.deepEqual(result.value, invalid);
    assert.equal(mapped.calls.length, 0);
    assert.equal(bindings, 0);
  }
});

test('encrypted permission review bindings survive direct and mapped execution and original recovery unchanged', async (t) => {
  const permission = {
    ...mutation,
    kind: 'permission',
    expectedTurnId: 'synthetic-user-turn',
    requestId: 'synthetic-permission-request',
    permissionReview: {
      version: 1,
      assistantTurnId: 'synthetic-assistant-turn',
      itemJson: '{"title":"SYNTHETIC_PRIVATE_ORIGINAL_REVIEW"}',
    },
  };
  const commands = [
    command('mutate', permission),
    productRecovery(permission, 'inspect'),
    productRecovery(permission, 'abandon'),
  ];
  const direct = await fixture(t),
    mapped = await productFixture(t);
  for (const { f, send } of [
    { f: direct, send: direct.send },
    { f: mapped, send: mapped.mapped },
  ]) {
    for (const original of commands) {
      const before = JSON.stringify(original),
        request = await send(original),
        result = await f.read(await f.adapter.execute(request));
      assert.equal(result.value.ok, true);
      assert.deepEqual(f.calls.at(-1)!.args[0], original.params);
      assert.equal(JSON.stringify(original), before);
      assert(!JSON.stringify(result.header).includes('SYNTHETIC_PRIVATE_ORIGINAL_REVIEW'));
    }
  }
});
