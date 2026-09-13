import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CliClient } from '../src/cli/client';
import { EncryptedCliClient } from '../src/cli/encrypted-client';
import { parseCliArgs } from '../src/cli/args';
import { CliState } from '../src/cli/state';
import { DeviceManager } from '../src/security/device-manager';
import { generateRecoveryKey } from '../src/security/e2ee-recovery';
import { EncryptedBridgeClient } from '../src/security/encrypted-bridge-client';
import { encryptedCatalogSchema } from '../src/security/encrypted-bridge-protocol';
import { secureCatalogOriginal } from '../src/cli/secure-operation';
import type {
  EncryptedProductAction,
  EncryptedProductAuthority,
  EncryptedProductTarget,
} from '../src/security/encrypted-product-catalog';
import type { HostCommand } from '../src/bridge/host-command';

const authority: EncryptedProductAuthority = {
  serverOrigin: 'http://127.0.0.1:1',
  accountId: 'owner',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  hostDeviceId: 'host',
};
const catalogInput = (operationId = 'catalog-original') => ({
  operationId,
  target: { ...authority, clientDeviceId: 'client' },
  body:
    JSON.stringify(
      {
        version: 1,
        operationId,
        expectedRevision: 1,
        action: 'create-workspace',
        id: 'new-space',
        name: 'Private synthetic space',
      },
      null,
      2,
    ) + '\n',
});
const product: EncryptedProductTarget = {
  catalogWorkspaceId: 'space',
  projectId: 'product',
  replicaId: 'replica',
  revision: 1,
};
function sessionInput(operationId = 'session-original', mapped = true) {
  const target = {
    origin: authority.serverOrigin,
    owner: authority.accountId,
    rootKeyId: authority.rootKeyId,
    clientDeviceId: 'client',
    hostDeviceId: authority.hostDeviceId,
    workspaceId: 'runtime',
    localProjectId: 'local-project',
    userId: 'local-owner',
    machineId: 'machine',
    sessionId: 'session',
    ...(mapped ? { product: structuredClone(product) } : {}),
  };
  return {
    operationId,
    kind: 'create' as const,
    target,
    body: JSON.stringify({
      method: 'session-control',
      workspaceId: 'runtime',
      localProjectId: 'local-project',
      params: {
        controlVersion: 1,
        operationId,
        workspaceId: 'runtime',
        localProjectId: 'local-project',
        userId: 'local-owner',
        machineId: 'machine',
        sessionId: 'session',
        action: 'create',
        agentId: 'agent',
      },
    }),
  };
}
const receipt = (request: EncryptedProductAction, value = authority, status = 'accepted') => ({
  version: 1,
  authority: value,
  confirmed: true,
  operationId: request.operationId,
  request,
  status,
  revision: request.expectedRevision + 1,
});
function stateFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-product-cli-'))),
    state = new CliState(join(root, 'state'));
  t.after(() => {
    state.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, state };
}

test('catalog outbox durably isolates original bytes, identity and conditional transitions from session tables', (t) => {
  const f = stateFixture(t),
    original = catalogInput(),
    staged = f.state.secureCatalogStage(original);
  const second = new CliState(f.state.directory);
  try {
    assert.deepEqual(second.secureCatalogOperation(staged.operationId), staged);
    assert.equal(second.secureCatalogOperation(staged.operationId)?.body, original.body);
    assert.deepEqual(second.secureCatalogStage(original), staged);
    assert.equal(second.secureOperation(staged.operationId), undefined);
    assert.equal(second.operation(staged.operationId), undefined);
    for (const changed of [
      { ...original, body: original.body.replace('Private synthetic space', 'Changed') },
      { ...original, target: { ...original.target, accountId: 'replacement' } },
      { ...original, target: { ...original.target, hostDeviceId: 'replacement' } },
      {
        ...original,
        target: { ...original.target, rootKeyId: Buffer.alloc(32, 2).toString('base64url') },
      },
    ])
      assert.throws(() => second.secureCatalogStage(changed), /原操作编号/);
    assert.throws(
      () => second.secureCatalogStage(catalogInput('competing')),
      (error: any) => error.code === 'pending',
    );
    second.secureCatalogTransition(staged.operationId, ['pending'], 'ending');
    assert.throws(() =>
      f.state.secureCatalogTransition(staged.operationId, ['pending'], 'accepted'),
    );
    assert.throws(
      () => f.state.secureCatalogStage(catalogInput('competing')),
      (error: any) => error.code === 'pending',
    );
    second.secureCatalogTransition(staged.operationId, ['ending'], 'abandoned');
    assert.equal(f.state.secureCatalogStage(catalogInput('next')).state, 'pending');
  } finally {
    second.close();
  }
});

for (const change of [
  (value: any) => {
    value.target.hostDeviceId = 'replacement';
  },
  (value: any) => {
    value.body = value.body.replace('Private synthetic space', 'Changed');
  },
  (value: any) => {
    value.operationId = 'replacement';
  },
])
  test('catalog recovery refuses tampered persisted identity, bytes or original ID', (t) => {
    const f = stateFixture(t),
      op = f.state.secureCatalogStage(catalogInput());
    change(op);
    const db = new DatabaseSync(join(f.state.directory, 'moor-cli-v1.sqlite'));
    try {
      db.prepare('UPDATE secure_catalog_outbox SET value=? WHERE id=?').run(
        JSON.stringify(op),
        'catalog-original',
      );
    } finally {
      db.close();
    }
    assert.throws(() => f.state.secureCatalogOperation('catalog-original'));
  });

test('mapped session records bind the original target revision in their digest', (t) => {
  const f = stateFixture(t),
    op = f.state.secureStage(sessionInput());
  op.target.product!.revision++;
  const db = new DatabaseSync(join(f.state.directory, 'moor-cli-v1.sqlite'));
  try {
    db.prepare('UPDATE secure_outbox SET value=? WHERE id=?').run(
      JSON.stringify(op),
      op.operationId,
    );
  } finally {
    db.close();
  }
  assert.throws(() => f.state.secureOperation(op.operationId));
});

for (const oldMapped of [true, false])
  test('a pending session original blocks a new product revision without remapping the old target', (t) => {
    const f = stateFixture(t),
      op = f.state.secureStage(sessionInput('original', oldMapped)),
      next = sessionInput('next');
    next.target.product!.revision = 2;
    assert.throws(
      () => f.state.secureStage(next),
      (error: any) => error.code === 'pending' && error.operationId === 'original',
    );
    assert.deepEqual(f.state.secureOperation('original'), op);
  });

test('catalog summaries are bounded, private and readable without authentication or transport', async (t) => {
  const f = stateFixture(t);
  for (let index = 0; index < 101; index++) {
    const op = f.state.secureCatalogStage(catalogInput('op-' + index));
    f.state.secureCatalogTransition(op.operationId, ['pending'], 'accepted', {
      private: 'Private synthetic receipt',
    });
  }
  const client = new EncryptedCliClient({ state: f.state, stdin: (async function* () {})() });
  const result = (await client.run(parseCliArgs(['secure', 'catalog-operations']))) as any;
  assert.equal(result.operations.length, 100);
  assert.equal(result.truncated, true);
  assert.equal(JSON.stringify(result).includes('Private synthetic'), false);
  assert.equal(f.state.get('auth'), undefined);
});

for (const argv of [
  ['organize', '--host', 'host'],
  ['organize', '--host', 'host', '--stdin', '--space', 'space'],
  ['catalog-inspect', 'op', '--host', 'replacement'],
  ['catalog-retry', 'op', '--stdin'],
  ['catalog-abandon', 'op', '--replica', 'replacement'],
  ['list', '--host', 'host', '--space', 'space'],
  [
    'list',
    '--host',
    'host',
    '--space',
    'space',
    '--replica',
    'replica',
    '--workspace',
    'runtime',
    '--project',
    'local-project',
  ],
])
  test('catalog parser rejects incomplete selection, replacement recovery scope and implicit actions', () => {
    assert.throws(() => parseCliArgs(['secure', ...argv, '--endpoint', '/private/device.json']));
  });
test('catalog parser accepts explicit product selection and isolated offline catalog listing', () => {
  assert.equal(
    parseCliArgs([
      'secure',
      'list',
      '--endpoint',
      '/private/device.json',
      '--host',
      'host',
      '--space',
      'space',
      '--replica',
      'replica',
    ]).flags.space,
    'space',
  );
  assert.equal(parseCliArgs(['secure', 'catalog-operations']).command, 'catalog-operations');
  assert.throws(() =>
    parseCliArgs(['secure', 'catalog-operations', '--endpoint', '/private/device.json']),
  );
});

async function runFixture(t: TestContext) {
  const f = stateFixture(t),
    projectRoot = join(f.root, 'project');
  mkdirSync(projectRoot, { mode: 0o700 });
  const endpoint = join(f.root, 'device.json'),
    manager = await DeviceManager.open(endpoint);
  await manager.initialize(
    {
      accountId: authority.accountId,
      serverOrigin: authority.serverOrigin,
      deviceId: 'client',
      roles: ['client'],
    },
    generateRecoveryKey(),
  );
  const status = manager.status();
  assert('pin' in status);
  const localAuthority = { ...authority, rootKeyId: status.pin.rootKeyId };
  manager.close();
  const auth = {
    kind: 'remote',
    connection: {
      origin: authority.serverOrigin,
      owner: authority.accountId,
      cookie: 'personal=' + Buffer.alloc(32, 5).toString('base64url'),
    },
  };
  f.state.set('auth', auth);
  let catalog = encryptedCatalogSchema.parse({
    catalogVersion: 2,
    machineId: 'machine',
    workspaces: [
      {
        id: 'runtime',
        name: 'Synthetic runtime',
        userId: 'local-owner',
        machineId: 'machine',
        projects: [{ id: 'local-project', name: 'Synthetic project', rootPath: projectRoot }],
        agents: [
          { id: 'agent', name: 'Synthetic agent', cliType: 'synthetic', agentType: 'synthetic' },
        ],
      },
    ],
    products: {
      version: 1,
      authority: localAuthority,
      revision: 1,
      workspaces: [{ id: 'space', name: 'Synthetic space' }],
      projects: [
        {
          id: 'product',
          workspaceId: 'space',
          name: 'Synthetic product',
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
          userId: 'local-owner',
          machineId: 'machine',
          available: true,
        },
      ],
    },
  });
  const calls: {
    method: string;
    hostId: string;
    request: unknown;
    product?: EncryptedProductTarget;
  }[] = [];
  let execute = async (command: HostCommand): Promise<unknown> =>
    command.method === 'sessions'
      ? []
      : {
          controlVersion: 1,
          workspaceId: command.workspaceId,
          localProjectId: command.localProjectId,
          userId: 'local-owner',
          machineId: 'machine',
          sessionId: (command.params as any).sessionId,
          operationId: (command.params as any).operationId,
          confirmed: true,
          kind: 'create',
          status: 'accepted',
        };
  let catalogAction = async (request: EncryptedProductAction): Promise<unknown> =>
    receipt(request, localAuthority);
  let catalogOperation = async (input: {
    action: 'inspect' | 'abandon';
    request: EncryptedProductAction;
  }): Promise<unknown> =>
    input.action === 'inspect'
      ? {
          version: 1,
          authority: localAuthority,
          confirmed: true,
          request: input.request,
          found: false,
        }
      : receipt(input.request, localAuthority, 'abandoned');
  const transport = {
    catalog: async () => structuredClone(catalog),
    assertCurrent() {},
    close() {},
    execute: async (hostId: string, request: HostCommand, target?: EncryptedProductTarget) => {
      calls.push({
        method: 'execute',
        hostId,
        request: structuredClone(request),
        ...(target ? { product: structuredClone(target) } : {}),
      });
      return execute(request);
    },
    executeLegacyOperation: async (hostId: string, request: HostCommand) => {
      calls.push({ method: 'legacy-operation', hostId, request: structuredClone(request) });
      return execute(request);
    },
    catalogAction: async (hostId: string, request: EncryptedProductAction) => {
      calls.push({ method: 'catalog-action', hostId, request: structuredClone(request) });
      return catalogAction(request);
    },
    catalogOperation: async (
      hostId: string,
      request: { action: 'inspect' | 'abandon'; request: EncryptedProductAction },
    ) => {
      calls.push({ method: 'catalog-operation', hostId, request: structuredClone(request) });
      return catalogOperation(request);
    },
  };
  t.mock.method(EncryptedBridgeClient, 'connect', async (options: any) => {
    options.socket.on('error', () => {});
    options.socket.terminate();
    return transport;
  });
  let sequence = 0;
  const run = (argv: string[], input = '') =>
    new CliClient({
      state: f.state,
      uuid: () => 'generated-' + ++sequence,
      stdin: (async function* () {
        yield input;
      })(),
      fetch: async () => Response.json({ owner: authority.accountId }),
    }).run(parseCliArgs(['secure', ...argv, '--endpoint', endpoint]));
  return {
    ...f,
    run,
    auth,
    authority: localAuthority,
    calls,
    catalog: () => catalog,
    setCatalog: (value: unknown) => {
      catalog = encryptedCatalogSchema.parse(value);
    },
    onExecute: (callback: typeof execute) => {
      execute = callback;
    },
    onAction: (callback: typeof catalogAction) => {
      catalogAction = callback;
    },
    onOperation: (callback: typeof catalogOperation) => {
      catalogOperation = callback;
    },
  };
}
const organizeInput = JSON.stringify({
  action: 'create-workspace',
  expectedRevision: 1,
  id: 'created-space',
  name: 'Private newly created space',
});

test('organize persists its generated original action before encrypted delivery and never enters session recovery', async (t) => {
  const f = await runFixture(t);
  f.onAction(async (request) => {
    const op = f.state.secureCatalogOperation(request.operationId)!;
    assert.equal(op.state, 'pending');
    assert.deepEqual(secureCatalogOriginal(op), request);
    assert.equal(f.state.secureOperation(request.operationId), undefined);
    return receipt(request, f.authority);
  });
  const result = (await f.run(['organize', '--host', 'host', '--stdin'], organizeInput)) as any;
  assert.equal(result.state, 'accepted');
  assert.equal(result.operationId, 'generated-1');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.state.secureCatalogOperation('generated-1')?.target, {
    ...f.authority,
    clientDeviceId: 'client',
  });
});

for (const extra of [
  { operationId: 'user-supplied' },
  { version: 1 },
  { ignored: true },
  { expectedRevision: -1 },
])
  test('organize rejects extra or invalid input without staging or dispatching', async (t) => {
    const f = await runFixture(t);
    await assert.rejects(
      f.run(
        ['organize', '--host', 'host', '--stdin'],
        JSON.stringify({ ...JSON.parse(organizeInput), ...extra }),
      ),
    );
    assert.deepEqual(f.state.secureCatalogOperationSummaries().operations, []);
    assert.equal(f.calls.length, 0);
  });

test('unknown catalog delivery keeps exact bytes and ID until manual inspection and retry', async (t) => {
  const f = await runFixture(t);
  f.onAction(async () => {
    throw Error('Synthetic response loss');
  });
  await assert.rejects(
    f.run(['organize', '--host', 'host', '--stdin'], organizeInput),
    (error: any) => error.code === 'unknown' && error.operationId === 'generated-1',
  );
  const op = f.state.secureCatalogOperation('generated-1')!;
  assert.equal(f.calls.length, 1);
  const inspected = (await f.run(['catalog-inspect', op.operationId])) as any;
  assert.equal(inspected.inspection.found, false);
  assert.deepEqual(f.state.secureCatalogOperation(op.operationId), op);
  assert.deepEqual((f.calls[1]!.request as any).request, secureCatalogOriginal(op));
  const updatedCatalog = structuredClone(f.catalog());
  assert.equal(updatedCatalog.catalogVersion, 2);
  if (updatedCatalog.catalogVersion === 2) updatedCatalog.products.revision = 20;
  f.setCatalog(updatedCatalog);
  f.onAction(async (request) => receipt(request, f.authority));
  const result = (await f.run(['catalog-retry', op.operationId])) as any;
  assert.equal(result.state, 'accepted');
  assert.deepEqual(f.calls[2]!.request, secureCatalogOriginal(op));
  assert.equal(f.state.secureCatalogOperation(op.operationId)?.body, op.body);
  assert.equal(f.state.secureCatalogOperation(op.operationId)?.requestVersion, op.requestVersion);
  await f.run(['catalog-retry', op.operationId]);
  assert.equal(f.calls.length, 3);
});

test('catalog abandonment persists ending before sending exact action and blocks later retry after response loss', async (t) => {
  const f = await runFixture(t),
    raw = catalogInput();
  raw.target.rootKeyId = f.authority.rootKeyId;
  const op = f.state.secureCatalogStage(raw);
  f.onOperation(async ({ request }) => {
    assert.equal(f.state.secureCatalogOperation(request.operationId)?.state, 'ending');
    assert.deepEqual(request, secureCatalogOriginal(op));
    throw Error('Synthetic response loss');
  });
  await assert.rejects(
    f.run(['catalog-abandon', op.operationId]),
    (error: any) => error.code === 'unknown',
  );
  await assert.rejects(
    f.run(['catalog-retry', op.operationId]),
    (error: any) => error.code === 'ending',
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.secureCatalogOperation(op.operationId)?.body, op.body);
  f.onOperation(async ({ request }) => receipt(request, f.authority, 'abandoned'));
  const result = (await f.run(['catalog-abandon', op.operationId])) as any;
  assert.equal(result.state, 'abandoned');
});

for (const mode of ['request', 'authority', 'auth-change'] as const)
  test(`catalog ${mode} mismatch cannot acknowledge or discard the original`, async (t) => {
    const f = await runFixture(t);
    f.onAction(async (request) => {
      if (mode === 'auth-change') {
        f.state.set('auth', undefined);
        f.state.set('auth', f.auth);
      }
      return receipt(
        mode === 'request' ? { ...request, expectedRevision: 9 } : request,
        mode === 'authority' ? { ...f.authority, accountId: 'replacement' } : f.authority,
      );
    });
    await assert.rejects(
      f.run(['organize', '--host', 'host', '--stdin'], organizeInput),
      (error: any) => error.code === 'unknown',
    );
    assert.equal(f.state.secureCatalogOperation('generated-1')?.state, 'pending');
  });

for (const field of ['accountId', 'rootKeyId', 'clientDeviceId'] as const)
  test(`catalog retry refuses a changed ${field} without replacing the saved scope`, async (t) => {
    const f = await runFixture(t),
      raw = catalogInput();
    raw.target.rootKeyId = f.authority.rootKeyId;
    raw.target[field] =
      field === 'rootKeyId' ? Buffer.alloc(32, 2).toString('base64url') : 'replacement';
    const op = f.state.secureCatalogStage(raw);
    await assert.rejects(
      f.run(['catalog-retry', op.operationId]),
      (error: any) => error.code === 'scope',
    );
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.state.secureCatalogOperation(op.operationId), op);
  });

test('v2 product and runtime selectors both freeze the same host-confirmed mapping in business requests', async (t) => {
  const f = await runFixture(t);
  await f.run(['list', '--host', 'host', '--space', 'space', '--replica', 'replica']);
  await f.run(['list', '--host', 'host', '--workspace', 'runtime', '--project', 'local-project']);
  for (const call of f.calls) assert.deepEqual(call.product, product);
  f.onExecute(async (command) => {
    const op = f.state.secureOperation((command.params as any).operationId)!;
    assert.equal(op.state, 'pending');
    assert.deepEqual(op.target.product, product);
    assert.deepEqual(JSON.parse(op.body), command);
    throw Error('Synthetic lost create response');
  });
  await assert.rejects(
    f.run([
      'create',
      '--host',
      'host',
      '--space',
      'space',
      '--replica',
      'replica',
      '--agent',
      'agent',
    ]),
    (error: any) => error.code === 'unknown',
  );
  const op = f.state.secureOperation('generated-2')!;
  assert.deepEqual(op.target.product, product);
});

test('v2 retains an unmapped legacy original for explicit inspect and abandon while refusing retry', async (t) => {
  const f = await runFixture(t),
    raw = sessionInput('legacy', false);
  raw.target.rootKeyId = f.authority.rootKeyId;
  const op = f.state.secureStage(raw);
  await assert.rejects(
    f.run(['retry', op.operationId]),
    (error: any) => error.code === 'unmapped-operation',
  );
  assert.equal(f.calls.length, 0);
  f.onExecute(async (command) => ({
    controlVersion: 1,
    workspaceId: 'runtime',
    localProjectId: 'local-project',
    userId: 'local-owner',
    machineId: 'machine',
    sessionId: 'session',
    action: (command.params as any).action,
    operationId: op.operationId,
    confirmed: true,
    found: false,
  }));
  await f.run(['inspect', op.operationId]);
  assert.equal(f.calls[0]!.method, 'legacy-operation');
  assert.equal(f.calls[0]!.product, undefined);
  assert.deepEqual(f.state.secureOperation(op.operationId), op);
});

test('mapped inspection sends the original product target after current replica revision changes', async (t) => {
  const f = await runFixture(t),
    raw = sessionInput();
  raw.target.rootKeyId = f.authority.rootKeyId;
  const op = f.state.secureStage(raw),
    next = structuredClone(f.catalog());
  assert.equal(next.catalogVersion, 2);
  if (next.catalogVersion === 2) {
    next.products.revision++;
    next.products.replicas[0]!.revision++;
  }
  f.setCatalog(next);
  f.onExecute(async (command) => ({
    controlVersion: 1,
    workspaceId: 'runtime',
    localProjectId: 'local-project',
    userId: 'local-owner',
    machineId: 'machine',
    sessionId: 'session',
    action: (command.params as any).action,
    operationId: op.operationId,
    confirmed: true,
    found: false,
  }));
  await f.run(['inspect', op.operationId]);
  assert.deepEqual(f.calls[0]!.product, product);
  assert.deepEqual(f.state.secureOperation(op.operationId), op);
});

for (const input of [
  { action: 'rename-workspace', workspaceId: 'space', name: 'Renamed' },
  {
    action: 'create-project',
    workspaceId: 'space',
    id: 'new-product',
    name: 'New product',
    source: { kind: 'local' },
  },
  {
    action: 'assign-replica',
    replicaId: 'replica',
    projectId: 'new-product',
    expectedReplicaRevision: 1,
  },
  { action: 'move-host', runtimeWorkspaceId: 'runtime', targetWorkspaceId: 'new-space' },
])
  test(`organize preserves the complete ${input.action} action and reviewed revisions`, async (t) => {
    const f = await runFixture(t);
    const result = (await f.run(
      ['organize', '--host', 'host', '--stdin'],
      JSON.stringify({ ...input, expectedRevision: 11 }),
    )) as any;
    const request = secureCatalogOriginal(f.state.secureCatalogOperation(result.operationId)!);
    assert.deepEqual(request, {
      ...input,
      expectedRevision: 11,
      version: 1,
      operationId: result.operationId,
    });
    assert.deepEqual(f.calls[0]!.request, request);
  });

for (const selector of [
  ['--space', 'space', '--replica', 'replica'],
  ['--workspace', 'runtime', '--project', 'local-project'],
])
  test('unavailable product replicas cannot receive new business through either selector', async (t) => {
    const f = await runFixture(t),
      catalog = structuredClone(f.catalog());
    if (catalog.catalogVersion !== 2) throw Error();
    catalog.products.replicas[0]!.available = false;
    catalog.workspaces[0]!.projects = [];
    f.setCatalog(catalog);
    await assert.rejects(f.run(['list', '--host', 'host', ...selector]));
    assert.equal(f.calls.length, 0);
  });

test('a v1 Host remains readable while product selection and organize cannot assume a mapping', async (t) => {
  const f = await runFixture(t),
    current = f.catalog();
  f.setCatalog({ catalogVersion: 1, machineId: current.machineId, workspaces: current.workspaces });
  await f.run(['list', '--host', 'host', '--workspace', 'runtime', '--project', 'local-project']);
  assert.equal(f.calls[0]!.product, undefined);
  await assert.rejects(
    f.run(['list', '--host', 'host', '--space', 'space', '--replica', 'replica']),
  );
  await assert.rejects(
    f.run(['organize', '--host', 'host', '--stdin'], organizeInput),
    (error: any) => error.code === 'catalog',
  );
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.state.secureCatalogOperationSummaries().operations, []);
});
