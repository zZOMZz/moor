import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HostCommand } from '../src/bridge/host-command';
import { CliClient } from '../src/cli/client';
import { EncryptedCliClient } from '../src/cli/encrypted-client';
import { parseCliArgs, type CliArgs } from '../src/cli/args';
import { CliState } from '../src/cli/state';
import {
  secureOriginal,
  type SecureCliOperation,
  type SecureCliTarget,
} from '../src/cli/secure-operation';
import { EncryptedBridgeClient, EncryptedHostError } from '../src/security/encrypted-bridge-client';
import type { EncryptedCatalog } from '../src/security/encrypted-bridge-protocol';
import { DeviceManager } from '../src/security/device-manager';
import { generateRecoveryKey } from '../src/security/e2ee-recovery';

const digest = (byte: number) => Buffer.alloc(32, byte).toString('base64url');
const target: SecureCliTarget = {
  origin: 'http://127.0.0.1:1',
  owner: 'owner',
  rootKeyId: digest(1),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'runtime',
  localProjectId: 'project',
  userId: 'local-owner',
  machineId: 'machine',
  sessionId: 'session',
};
const scope = {
  controlVersion: 1,
  workspaceId: target.workspaceId,
  localProjectId: target.localProjectId,
  userId: target.userId,
  machineId: target.machineId,
  sessionId: target.sessionId,
};
function input(operationId = 'operation') {
  return {
    operationId,
    kind: 'create' as const,
    target: structuredClone(target),
    body:
      JSON.stringify(
        {
          method: 'session-control',
          workspaceId: target.workspaceId,
          localProjectId: target.localProjectId,
          params: {
            ...scope,
            operationId,
            action: 'create',
            agentId: 'agent',
            title: 'private synthetic title',
          },
        },
        null,
        2,
      ) + '\n',
  };
}
const receipt = (operationId = 'operation', status = 'accepted') => ({
  ...scope,
  operationId,
  confirmed: true,
  kind: 'create',
  status,
});
function inspection(action: 'inspect' | 'abandon', found: boolean, status = 'accepted') {
  return {
    ...scope,
    action,
    operationId: 'operation',
    confirmed: true,
    found,
    ...(found ? { receipt: receipt('operation', status) } : {}),
  };
}
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-secure-boundary-'))),
    state = new CliState(join(root, 'state'));
  t.after(() => {
    state.close();
    rmSync(root, { recursive: true, force: true });
  });
  const empty = async function* () {};
  const client = new EncryptedCliClient({ state, stdin: empty() });
  // Exercise workflow decisions independently of the cryptographic transport, covered by
  // real HPKE/WS tests. These stubs never create an Agent or connect to an external account.
  const workflow = client as unknown as {
    deliver(
      client: unknown,
      op: SecureCliOperation,
      first: boolean,
      current: () => void,
    ): Promise<any>;
    recover(
      client: unknown,
      op: SecureCliOperation,
      action: 'inspect' | 'abandon',
      current: () => void,
    ): Promise<any>;
    matchTarget(
      target: SecureCliTarget,
      catalog: EncryptedCatalog,
      expected: Pick<
        SecureCliTarget,
        'origin' | 'owner' | 'rootKeyId' | 'clientDeviceId' | 'hostDeviceId'
      >,
    ): void;
  };
  const calls: { hostId: string; command: HostCommand }[] = [];
  let execute: (command: HostCommand) => Promise<unknown> = async () => receipt();
  const transport = {
    execute: async (hostId: string, command: HostCommand) => {
      calls.push({ hostId, command: structuredClone(command) });
      return execute(command);
    },
  };
  const revision = state.settingsRevision();
  const current = () => {
    if (state.settingsRevision() !== revision) throw Error('Synthetic auth lease changed');
  };
  return {
    root,
    state,
    client,
    workflow,
    calls,
    transport,
    current,
    execute: (value: typeof execute) => {
      execute = value;
    },
  };
}
const unknown = (error: any) => error?.code === 'unknown' && error?.operationId === 'operation';

test('an unverified relay rejection cannot discard a secure original after the first attempt', async (t) => {
  const f = fixture(t),
    op = f.state.secureStage(input());
  f.execute(async () => {
    throw Object.assign(Error('synthetic relay unavailable'), { rejected: true });
  });
  await assert.rejects(f.workflow.deliver(f.transport, op, true, f.current), unknown);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.state.secureOperation('operation'), op);
  assert.deepEqual(f.state.operationSummaries().operations, []);
});

test('only a verified first Host rejection marks an original rejected', async (t) => {
  const f = fixture(t),
    op = f.state.secureStage(input());
  f.execute(async () => {
    throw new EncryptedHostError(409, 'Synthetic exact rejection', true);
  });
  await assert.rejects(
    f.workflow.deliver(f.transport, op, true, f.current),
    (error: any) => error.code === 'rejected',
  );
  assert.equal(f.state.secureOperation('operation')?.state, 'rejected');
  assert.equal(f.state.secureOperation('operation')?.body, op.body);
});

test('a retry rejection preserves an older possibly delivered original for inspection', async (t) => {
  const f = fixture(t),
    op = f.state.secureStage(input());
  f.execute(async () => {
    throw new EncryptedHostError(409, 'Synthetic rejected retry', true);
  });
  await assert.rejects(f.workflow.deliver(f.transport, op, false, f.current), unknown);
  assert.deepEqual(f.state.secureOperation('operation'), op);
  assert.deepEqual(f.calls[0].command, JSON.parse(op.body));
  assert.equal(f.calls[0].hostId, op.target.hostDeviceId);
});

for (const field of [
  'operationId',
  'workspaceId',
  'localProjectId',
  'sessionId',
  'userId',
  'machineId',
] as const)
  test(`a Host success with different ${field} does not mark the original delivered`, async (t) => {
    const f = fixture(t),
      op = f.state.secureStage(input());
    f.execute(async () => ({ ...receipt(), [field]: 'wrong-scope' }));
    await assert.rejects(f.workflow.deliver(f.transport, op, true, f.current), unknown);
    assert.deepEqual(f.state.secureOperation('operation'), op);
  });

test('auth settings changing while Host completion is pending cannot update delivery state', async (t) => {
  const f = fixture(t),
    op = f.state.secureStage(input());
  f.execute(async () => {
    f.state.set('auth', {
      kind: 'remote',
      connection: { origin: target.origin, owner: 'changed', cookie: 'personal=' + digest(4) },
    });
    return receipt();
  });
  await assert.rejects(f.workflow.deliver(f.transport, op, true, f.current), unknown);
  assert.deepEqual(f.state.secureOperation('operation'), op);
});

test('another process requesting abandonment is preserved against a stale pending completion', async (t) => {
  const f = fixture(t),
    op = f.state.secureStage(input()),
    second = new CliState(f.state.directory);
  try {
    f.execute(async () => {
      second.secureTransition('operation', ['pending'], 'ending');
      return receipt();
    });
    await assert.rejects(f.workflow.deliver(f.transport, op, true, f.current), unknown);
    assert.equal(f.state.secureOperation('operation')?.state, 'ending');
  } finally {
    second.close();
  }
});

test('lost abandonment acknowledgement leaves ending durable and an inspection cannot replay it', async (t) => {
  const f = fixture(t),
    op = f.state.secureStage(input());
  f.execute(async () => {
    throw Error('Synthetic connection lost');
  });
  await assert.rejects(f.workflow.recover(f.transport, op, 'abandon', f.current), unknown);
  const ending = f.state.secureOperation('operation')!;
  assert.equal(ending.state, 'ending');
  assert.equal(ending.body, op.body);
  assert.deepEqual((f.calls[0].command.params as any).request, secureOriginal(op));
  f.execute(async () => inspection('inspect', false));
  const result = await f.workflow.recover(f.transport, ending, 'inspect', f.current);
  assert.equal(result.state, 'ending');
  assert.equal(result.inspection.found, false);
  assert.deepEqual(
    f.calls.map((call) => call.command.method),
    ['session-operations', 'session-operations'],
  );
  assert.deepEqual(
    f.calls.map((call) => (call.command.params as any).action),
    ['abandon', 'inspect'],
  );
});

for (const status of ['accepted', 'abandoned'] as const)
  test(`manual abandonment records Host-confirmed ${status} without changing the original request`, async (t) => {
    const f = fixture(t),
      op = f.state.secureStage(input());
    f.execute(async () => inspection('abandon', true, status));
    const result = await f.workflow.recover(f.transport, op, 'abandon', f.current);
    assert.equal(result.state, status);
    assert.equal(f.state.secureOperation('operation')?.body, op.body);
    assert.equal(f.calls.length, 1);
  });

test('an invalid not-found abandonment result cannot clear a pending operation', async (t) => {
  const f = fixture(t),
    op = f.state.secureStage(input());
  f.execute(async () => inspection('abandon', false));
  await assert.rejects(f.workflow.recover(f.transport, op, 'abandon', f.current), unknown);
  assert.equal(f.state.secureOperation('operation')?.state, 'ending');
});

for (const argv of [
  [
    'secure',
    'send',
    '--endpoint',
    '/private/key',
    '--host',
    'host',
    '--workspace',
    'runtime',
    '--project',
    'project',
    '--connection',
    '/private/legacy',
  ],
  [
    'secure',
    'retry',
    'operation',
    '--endpoint',
    '/private/key',
    '--server',
    'https://other.synthetic.invalid',
  ],
  ['secure', 'inspect', 'operation', '--endpoint', '/private/key', '--host', 'replacement'],
  ['secure', 'abandon', 'operation', '--endpoint', '/private/key', '--session', 'replacement'],
  [
    'secure',
    'send',
    'session',
    '--endpoint',
    '/private/key',
    '--host',
    'host',
    '--workspace',
    'runtime',
    '--project',
    'project',
    '--wait',
  ],
  ['secure', 'operations', '--endpoint', '/private/key'],
  ['secure', 'catalog', '--endpoint', '/private/key', '--host', 'host', '--stdin'],
  [
    'secure',
    'read',
    'session',
    '--endpoint',
    '/private/key',
    '--host',
    'host',
    '--workspace',
    'runtime',
    '--project',
    'project',
    '--session',
    'other',
  ],
])
  test('secure parser rejects legacy transport flags, implicit replay and replacement operation scope', () => {
    assert.throws(() => parseCliArgs(argv));
  });

async function runFixture(t: TestContext, endpointInsideProject = false) {
  const f = fixture(t),
    project = join(f.root, 'project'),
    privateDirectory = join(endpointInsideProject ? project : f.root, 'private');
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(privateDirectory, { mode: 0o700 });
  const endpoint = join(privateDirectory, 'device.json'),
    manager = await DeviceManager.open(endpoint);
  await manager.initialize(
    {
      accountId: target.owner,
      serverOrigin: target.origin,
      deviceId: target.clientDeviceId,
      roles: ['client'],
    },
    generateRecoveryKey(),
  );
  const status = manager.status();
  assert('pin' in status);
  manager.close();
  const auth = {
    kind: 'remote',
    connection: { origin: target.origin, owner: target.owner, cookie: 'personal=' + digest(7) },
  };
  f.state.set('auth', auth);
  const catalog: EncryptedCatalog = {
    catalogVersion: 1,
    machineId: target.machineId,
    workspaces: [
      {
        id: target.workspaceId,
        name: 'Synthetic workspace',
        userId: target.userId,
        machineId: target.machineId,
        projects: [{ id: target.localProjectId, name: 'Synthetic project', rootPath: project }],
        agents: [
          { id: 'agent', name: 'Synthetic Agent', cliType: 'synthetic', agentType: 'synthetic' },
        ],
      },
    ],
  };
  const http: string[] = [];
  let connectError: Error | undefined,
    onCatalog = () => {};
  const transport = {
    hosts: () => [],
    catalog: async () => {
      onCatalog();
      return structuredClone(catalog);
    },
    execute: async (hostId: string, command: HostCommand) => {
      f.calls.push({ hostId, command });
      return receipt((command.params as any).operationId);
    },
    assertCurrent() {},
    close() {},
  };
  t.mock.method(EncryptedBridgeClient, 'connect', async (options: any) => {
    options.socket.on('error', () => {});
    options.socket.terminate();
    if (connectError) throw connectError;
    return transport;
  });
  const cli = new CliClient({
    state: f.state,
    stdin: (async function* () {})(),
    fetch: async (url) => {
      http.push(String(url));
      return Response.json({ owner: target.owner });
    },
  });
  const run = (command: string, positional?: string) =>
    cli.run(
      parseCliArgs([
        'secure',
        command,
        ...(positional ? [positional] : []),
        '--endpoint',
        endpoint,
        ...(['retry', 'inspect', 'abandon', 'hosts'].includes(command)
          ? []
          : ['--host', target.hostDeviceId]),
      ]),
    );
  return {
    ...f,
    cli,
    catalog,
    endpoint,
    auth,
    http,
    run,
    rootKeyId: status.pin.rootKeyId,
    failConnect: (error: Error) => {
      connectError = error;
    },
    onCatalog: (callback: () => void) => {
      onCatalog = callback;
    },
  };
}

test('secure catalog rejects a private endpoint kept inside an authenticated project root', async (t) => {
  const f = await runFixture(t, true);
  await assert.rejects(f.run('catalog'), /项目/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.http, [target.origin + '/api/me']);
});

test('an unavailable v4 connection cannot trigger a legacy HTTP command fallback', async (t) => {
  const f = await runFixture(t);
  f.failConnect(Error('Synthetic v4 unavailable'));
  await assert.rejects(f.run('catalog'), /v4 unavailable/);
  assert.deepEqual(f.http, [target.origin + '/api/me']);
  assert.equal(f.calls.length, 0);
});

test('an auth ABA change during catalog read prevents secure continuation', async (t) => {
  const f = await runFixture(t);
  f.onCatalog(() => {
    f.state.set('auth', undefined);
    f.state.set('auth', f.auth);
  });
  await assert.rejects(f.run('catalog'), (error: any) => error.code === 'authentication');
  assert.equal(f.calls.length, 0);
});

test('secure retry refuses an ending original even after establishing a fresh connection', async (t) => {
  const f = await runFixture(t),
    operation = input();
  operation.target.rootKeyId = f.rootKeyId;
  f.state.secureStage(operation);
  f.state.secureTransition('operation', ['pending'], 'ending');
  await assert.rejects(f.run('retry', 'operation'), (error: any) => error.code === 'ending');
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.secureOperation('operation')?.state, 'ending');
});

for (const field of ['owner', 'rootKeyId', 'clientDeviceId', 'userId', 'machineId'] as const)
  test(`secure retry cannot rebind the original ${field} to a newly selected endpoint or catalog`, async (t) => {
    const f = await runFixture(t),
      operation = input();
    operation.target.rootKeyId = f.rootKeyId;
    if (field === 'rootKeyId') operation.target[field] = digest(40);
    else operation.target[field] = 'different';
    const body = JSON.parse(operation.body);
    if (field === 'userId' || field === 'machineId') body.params[field] = 'different';
    operation.body = JSON.stringify(body);
    f.state.secureStage(operation);
    await assert.rejects(f.run('retry', 'operation'), (error: any) => error.code === 'scope');
    assert.equal(f.calls.length, 0);
    assert.equal(f.state.secureOperation('operation')?.state, 'pending');
  });

test('secure operation listing is available offline without loading authentication or transport', async (t) => {
  const f = fixture(t);
  f.state.secureStage(input());
  const output = await f.client.run(parseCliArgs(['secure', 'operations']));
  assert.equal((output as any).operations[0].operationId, 'operation');
  assert.equal(JSON.stringify(output).includes('private synthetic'), false);
});
