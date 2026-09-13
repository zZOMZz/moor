import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostProductCatalog } from '../src/bridge/host-product-catalog';
import type { HostCommand } from '../src/bridge/host-command';
import { hostCommandSchema } from '../src/bridge/host-command';
import type { EncryptedCatalog } from '../src/security/encrypted-bridge-protocol';
import type {
  EncryptedProductAction,
  EncryptedProductAuthority,
  EncryptedProductCatalog,
  EncryptedProductTarget,
} from '../src/security/encrypted-product-catalog';

const authority: EncryptedProductAuthority = {
  serverOrigin: 'https://relay.example',
  accountId: 'account',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  hostDeviceId: 'host',
};
function runtime(): EncryptedCatalog {
  return {
    catalogVersion: 1,
    machineId: 'machine',
    workspaces: [
      {
        id: 'runtime',
        name: 'Work',
        userId: 'local-user',
        machineId: 'machine',
        projects: [{ id: 'local-project', name: 'Project', rootPath: '/synthetic/project' }],
        agents: [],
      },
    ],
  };
}
function fixture(t: TestContext, path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE IF NOT EXISTS operation(id TEXT PRIMARY KEY,fingerprint TEXT,phase TEXT,result TEXT)',
  );
  let current = runtime();
  const store = new HostProductCatalog({ db, authority, runtime: () => current });
  t.after(() => db.close());
  return {
    db,
    store,
    get current() {
      return current;
    },
    set current(value: EncryptedCatalog) {
      current = value;
    },
  };
}
function target(catalog: EncryptedProductCatalog): EncryptedProductTarget {
  const replica = catalog.replicas[0]!;
  return {
    catalogWorkspaceId: replica.catalogWorkspaceId,
    projectId: replica.projectId,
    replicaId: replica.id,
    revision: replica.revision,
  };
}
const read: HostCommand = {
  method: 'sessions',
  workspaceId: 'runtime',
  localProjectId: 'local-project',
  params: {},
};
const original = {
  method: 'session-action',
  workspaceId: 'runtime',
  localProjectId: 'local-project',
  params: {
    operationId: 'original',
    workspaceId: 'runtime',
    localProjectId: 'local-project',
    sessionId: 'session',
    expectedRevision: 0,
    action: 'rename',
    title: 'Title',
  },
} satisfies HostCommand;
function recover(action: 'inspect' | 'abandon' = 'inspect'): HostCommand {
  return {
    method: 'session-operations',
    workspaceId: 'runtime',
    localProjectId: 'local-project',
    params: {
      action,
      controlVersion: 1,
      workspaceId: 'runtime',
      localProjectId: 'local-project',
      sessionId: 'session',
      machineId: 'machine',
      userId: 'local-user',
      request: { kind: 'metadata', value: original.params },
    },
  };
}
function createWorkspace(
  store: HostProductCatalog,
  operationId = 'create-space',
  spaceId = 'other-space',
): Extract<EncryptedProductAction, { action: 'create-workspace' }> {
  return {
    version: 1,
    operationId,
    expectedRevision: store.read().revision,
    action: 'create-workspace',
    id: spaceId,
    name: 'Other',
  };
}
function move(store: HostProductCatalog) {
  store.action(createWorkspace(store));
  store.action({
    version: 1,
    operationId: 'move',
    expectedRevision: store.read().revision,
    action: 'move-host',
    runtimeWorkspaceId: 'runtime',
    targetWorkspaceId: 'other-space',
  });
}

test('Host product identities derive from complete authority and runtime identity, never names', (t) => {
  const f = fixture(t),
    first = f.store.read();
  assert.equal(first.revision, 1);
  assert.deepEqual(f.store.read(), first);
  for (const change of [
    { hostDeviceId: 'other-host' },
    { rootKeyId: Buffer.alloc(32, 2).toString('base64url') },
    { serverOrigin: 'https://other.example' },
    { accountId: 'other-account' },
  ]) {
    const other = new HostProductCatalog({
      db: f.db,
      authority: { ...authority, ...change },
      runtime: () => f.current,
    }).read();
    assert.notEqual(other.workspaces[0]!.id, first.workspaces[0]!.id);
    assert.notEqual(other.projects[0]!.id, first.projects[0]!.id);
    assert.notEqual(other.replicas[0]!.id, first.replicas[0]!.id);
  }
  f.current.workspaces.push({ ...structuredClone(f.current.workspaces[0]!), id: 'runtime-2' });
  const expanded = f.store.read();
  assert.equal(expanded.workspaces.length, 2);
  assert.equal(new Set(expanded.projects.map((entry) => entry.id)).size, 2);
});

test('reconciliation preserves renamed organization and its sources across actual database reopen', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-product-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'host.sqlite');
  const db = new DatabaseSync(file);
  const store = new HostProductCatalog({ db, authority, runtime });
  const first = store.read();
  store.action({
    version: 1,
    operationId: 'rename',
    expectedRevision: first.revision,
    action: 'rename-workspace',
    workspaceId: first.workspaces[0]!.id,
    name: 'Organized',
  });
  store.action({
    version: 1,
    operationId: 'project',
    expectedRevision: store.read().revision,
    action: 'create-project',
    workspaceId: first.workspaces[0]!.id,
    id: 'shared-project',
    name: 'Shared',
    source: { kind: 'git', provider: 'github', url: 'https://github.com/example/project' },
  });
  store.action({
    version: 1,
    operationId: 'assign',
    expectedRevision: store.read().revision,
    action: 'assign-replica',
    replicaId: first.replicas[0]!.id,
    projectId: 'shared-project',
    expectedReplicaRevision: 1,
  });
  const organized = store.read();
  db.close();
  const reopened = new DatabaseSync(file);
  t.after(() => reopened.close());
  const current = runtime();
  current.workspaces[0]!.name = 'Host changed label';
  current.workspaces[0]!.projects[0]!.name = 'Host changed project label';
  const restarted = new HostProductCatalog({ db: reopened, authority, runtime: () => current });
  assert.deepEqual(restarted.read(), organized);
  assert.equal(organized.replicas[0]!.projectId, 'shared-project');
  assert.equal(organized.workspaces[0]!.name, 'Organized');
});

test('project removal, readdition, path and runtime principal changes expire the exact replica revision', (t) => {
  const f = fixture(t),
    first = f.store.read(),
    initial = target(first);
  const project = f.current.workspaces[0]!.projects.pop()!;
  assert.equal(f.store.read().replicas[0]!.revision, 2);
  assert.equal(f.store.read().replicas[0]!.available, false);
  assert.throws(() => f.store.acquire(initial, read));
  f.current.workspaces[0]!.projects.push(project);
  assert.equal(f.store.read().replicas[0]!.revision, 3);
  assert.equal(f.store.read().replicas[0]!.id, initial.replicaId);
  project.rootPath = '/synthetic/other';
  assert.equal(f.store.read().replicas[0]!.revision, 4);
  f.current.workspaces[0]!.userId = 'other-user';
  assert.equal(f.store.read().replicas[0]!.revision, 5);
  f.current.machineId = f.current.workspaces[0]!.machineId = 'other-machine';
  assert.equal(f.store.read().replicas[0]!.revision, 6);
  f.current.workspaces = [];
  assert.equal(f.store.read().replicas[0]!.revision, 7);
  assert.equal(f.store.read().replicas[0]!.available, false);
});

test('organization actions CAS, permanent receipts and exact original body survive later revisions', (t) => {
  const f = fixture(t),
    request = createWorkspace(f.store);
  assert.equal(f.store.inspect(request).found, false);
  const receipt = f.store.action(request);
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.revision, request.expectedRevision + 1);
  assert.equal(
    f.db.prepare('SELECT phase FROM operation WHERE id=?').get(request.operationId)!.phase,
    'product-catalog',
  );
  assert.throws(() => f.store.action({ ...request, operationId: 'stale', id: 'another' }));
  f.store.action(createWorkspace(f.store, 'next-space', 'next'));
  assert.deepEqual(f.store.action(request), receipt);
  assert.deepEqual(f.store.abandon(request), receipt);
  assert.deepEqual(f.store.inspect(request), {
    version: 1,
    authority,
    confirmed: true,
    request,
    found: true,
    receipt,
  });
  for (const method of ['action', 'inspect', 'abandon'] as const)
    assert.throws(() => f.store[method]({ ...request, name: 'Different' }));
});

test('abandon seals an absent action before delayed delivery without requiring the old CAS revision', (t) => {
  const f = fixture(t),
    request = createWorkspace(f.store);
  f.store.action(createWorkspace(f.store, 'other-op', 'unrelated'));
  const before = f.store.read();
  const receipt = f.store.abandon(request);
  assert.equal(receipt.status, 'abandoned');
  assert.deepEqual(f.store.action(request), receipt);
  assert.deepEqual(f.store.read(), before);
  assert.equal(f.store.inspect(request).found, true);
});

test('catalog edits and receipt insertion roll back in the same transaction on persistence failure', (t) => {
  const f = fixture(t),
    request = createWorkspace(f.store),
    before = f.store.read();
  f.db.exec(
    "CREATE TRIGGER fail_product_receipt BEFORE INSERT ON encrypted_product_receipt BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END",
  );
  assert.throws(() => f.store.action(request), /synthetic receipt failure/);
  assert.deepEqual(f.store.read(), before);
  assert.equal(f.store.inspect(request).found, false);
  assert.equal(
    f.db.prepare('SELECT 1 FROM operation WHERE id=?').get(request.operationId),
    undefined,
  );
  f.db.exec('DROP TRIGGER fail_product_receipt');
  assert.equal(f.store.action(request).status, 'accepted');
});

test('leases reject organization across store instances and are invalidated by runtime changes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-product-lease-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, join(dir, 'host.sqlite'));
  const otherDb = new DatabaseSync(join(dir, 'host.sqlite'));
  t.after(() => otherDb.close());
  const other = new HostProductCatalog({ db: otherDb, authority, runtime: () => f.current });
  const selected = target(f.store.read()),
    request = createWorkspace(other);
  const lease = f.store.acquire(selected, read);
  lease.current();
  assert.throws(() => other.action(request));
  f.current.workspaces[0]!.projects[0]!.rootPath = '/synthetic/changed';
  assert.throws(() => lease.current());
  lease.release();
  lease.release();
  assert.throws(() => lease.current());
  assert.equal(
    other.action({ ...request, expectedRevision: other.read().revision }).status,
    'accepted',
  );
});

test('AAD local scope, logical workspace, replica and session must match the selected target', (t) => {
  const f = fixture(t),
    selected = target(f.store.read());
  const resource = {
    kind: 'project' as const,
    workspaceId: 'runtime',
    projectId: 'local-project',
    sessionId: null,
    catalogWorkspaceId: selected.catalogWorkspaceId,
    replicaId: selected.replicaId,
  };
  f.store.acquire(selected, read, resource).release();
  for (const changed of [
    { workspaceId: 'other' },
    { projectId: 'other' },
    { catalogWorkspaceId: 'other' },
    { replicaId: 'other' },
  ])
    assert.throws(() => f.store.acquire(selected, read, { ...resource, ...changed }));
  assert.throws(() => f.store.acquire({ ...selected, projectId: 'other' }, read, resource));
  assert.throws(() =>
    f.store.acquire(selected, original, {
      ...resource,
      kind: 'session',
      sessionId: 'wrong-session',
    }),
  );
});

test('moving a host moves every replica, retains prior project records and invalidates old targets', (t) => {
  const f = fixture(t);
  f.current.workspaces[0]!.projects.push({
    id: 'project-2',
    name: 'Second',
    rootPath: '/synthetic/second',
  });
  const first = f.store.read();
  move(f.store);
  const moved = f.store.read();
  assert.deepEqual(
    new Set(moved.replicas.map((entry) => entry.catalogWorkspaceId)),
    new Set(['other-space']),
  );
  assert.ok(moved.replicas.every((entry) => entry.revision === 2));
  assert.ok(
    first.projects.every((entry) =>
      moved.projects.some(
        (current) => current.id === entry.id && current.workspaceId === entry.workspaceId,
      ),
    ),
  );
  assert.throws(() => f.store.acquire(target(first), read));
  f.store.acquire(target(moved), read).release();
  assert.deepEqual(f.store.read(), moved);
  f.current.workspaces[0]!.projects.push({
    id: 'later',
    name: 'Later',
    rootPath: '/synthetic/later',
  });
  assert.ok(f.store.read().replicas.every((entry) => entry.catalogWorkspaceId === 'other-space'));
});

test('assigning one replica cannot split a runtime workspace across logical workspaces', (t) => {
  const f = fixture(t),
    first = f.store.read();
  f.store.action(createWorkspace(f.store));
  f.store.action({
    version: 1,
    action: 'create-project',
    operationId: 'remote-project',
    expectedRevision: f.store.read().revision,
    workspaceId: 'other-space',
    id: 'outside',
    name: 'Outside',
    source: { kind: 'local' },
  });
  const before = f.store.read();
  assert.throws(() =>
    f.store.action({
      version: 1,
      action: 'assign-replica',
      operationId: 'split',
      expectedRevision: before.revision,
      replicaId: first.replicas[0]!.id,
      projectId: 'outside',
      expectedReplicaRevision: 1,
    }),
  );
  assert.deepEqual(f.store.read(), before);
});

test('operation claims preserve original identity and only permit proven historical recovery', (t) => {
  const f = fixture(t),
    selected = target(f.store.read());
  f.store.bindOperation(selected, original);
  assert.equal(
    f.db.prepare('SELECT 1 FROM operation WHERE id=?').get('original'),
    undefined,
    'a scope claim is not a delivery receipt',
  );
  assert.throws(() =>
    f.store.bindOperation(selected, {
      ...original,
      params: { ...original.params, title: 'Other' },
    }),
  );
  move(f.store);
  assert.throws(() => f.store.acquire(selected, original));
  assert.throws(() => f.store.bindOperation(target(f.store.read()), original));
  for (const action of ['inspect', 'abandon'] as const) {
    const recovery = recover(action);
    const lease = f.store.acquire(selected, recovery);
    f.store.bindOperation(selected, recovery);
    lease.current();
    lease.release();
  }
  assert.throws(() => f.store.bindOperation(null, recover()));
  f.current.workspaces[0]!.projects[0]!.rootPath = '/synthetic/replaced';
  assert.throws(() => f.store.acquire(selected, recover()));
});

test('unproven historical recovery is rejected and an inspection never invents a claim', (t) => {
  const f = fixture(t),
    selected = target(f.store.read());
  f.store.bindOperation(selected, recover());
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS count FROM encrypted_product_operation').get()!.count,
    0,
  );
  move(f.store);
  assert.throws(() => f.store.acquire(selected, recover()));
  assert.throws(() => f.store.acquire(selected, recover('abandon')));
});

test('legacy original numbers cannot acquire new mapped identity; legacy recovery remains possible', (t) => {
  const f = fixture(t),
    selected = target(f.store.read());
  f.db
    .prepare('INSERT INTO operation VALUES(?,?,?,?)')
    .run('original', 'legacy-fingerprint', 'accepted', '{}');
  assert.throws(() => f.store.bindOperation(selected, original));
  assert.throws(() => f.store.bindOperation(selected, recover()));
  f.store.bindOperation(null, recover());
  f.store.bindOperation(null, recover('abandon'));
  assert.throws(() => f.store.bindOperation(selected, recover('abandon')));
});

test('catalog and execution operation identifiers cannot cross kind or authority', (t) => {
  const f = fixture(t),
    selected = target(f.store.read());
  f.store.bindOperation(selected, original);
  const claimed = { ...createWorkspace(f.store), operationId: 'original' };
  for (const method of ['action', 'inspect', 'abandon'] as const)
    assert.throws(() => f.store[method](claimed));
  const request = createWorkspace(f.store);
  f.store.action(request);
  assert.throws(() =>
    f.store.bindOperation(selected, {
      ...original,
      params: { ...original.params, operationId: request.operationId },
    }),
  );
  const other = new HostProductCatalog({
    db: f.db,
    authority: { ...authority, hostDeviceId: 'other-host' },
    runtime: () => f.current,
  });
  assert.throws(() => other.inspect(request));
  assert.throws(() => other.bindOperation(target(other.read()), original));
});

test('reserved JavaScript property names remain valid independent runtime identities', (t) => {
  const f = fixture(t);
  f.current.workspaces[0]!.id = '__proto__';
  const first = f.store.read();
  assert.equal(first.replicas[0]!.runtimeWorkspaceId, '__proto__');
  assert.deepEqual(f.store.read(), first);
});

test('a removed and readded project cannot revive a historical operation claim even at the same path', (t) => {
  const f = fixture(t),
    selected = target(f.store.read());
  f.store.bindOperation(selected, original);
  const project = f.current.workspaces[0]!.projects.pop()!;
  f.store.synchronize();
  f.current.workspaces[0]!.projects.push(project);
  f.store.synchronize();
  assert.throws(() => f.store.acquire(selected, recover()));
  assert.throws(() => f.store.bindOperation(target(f.store.read()), original));
});

test('all exact-original recovery wrappers share the original claim without accepting another body', (t) => {
  const f = fixture(t),
    selected = target(f.store.read());
  const scope = { workspaceId: 'runtime', localProjectId: 'local-project', sessionId: 'session' };
  const version = `sha256:${'1'.repeat(64)}`;
  const cases = [
    {
      method: 'preview-action',
      params: {
        ...scope,
        previewVersion: 1,
        clientId: 'client',
        operationId: 'preview',
        confirmed: true,
        action: 'open',
        serviceId: 'service',
        serviceVersion: version,
        executionRevision: 0,
        viewport: { width: 800, height: 600 },
      },
      wrappers: ['preview-inspect', 'preview-close'],
    },
    {
      method: 'github-write-action',
      params: {
        ...scope,
        githubWriteVersion: 1,
        operationId: 'write',
        confirmed: true,
        action: 'issue-comment',
        repositoryId: 1,
        configVersion: version,
        expectedBindingRevision: 0,
        subject: 'issue',
        number: 1,
        expectedVersion: version,
        body: 'Synthetic comment',
      },
      wrappers: ['github-write-inspect', 'github-write-abandon'],
    },
    {
      method: 'github-action',
      params: {
        ...scope,
        githubVersion: 1,
        operationId: 'github',
        expectedRevision: 0,
        action: 'unbind',
      },
      wrappers: ['github-abandon'],
    },
    {
      method: 'roles-action',
      params: {
        ...scope,
        rolesVersion: 1,
        operationId: 'role',
        expectedRevision: 0,
        action: 'remove',
        id: 'role-id',
      },
      wrappers: ['roles-inspect', 'roles-abandon'],
    },
  ];
  for (const entry of cases)
    f.store.bindOperation(
      selected,
      hostCommandSchema.parse({
        workspaceId: scope.workspaceId,
        localProjectId: scope.localProjectId,
        method: entry.method,
        params: entry.params,
      }),
    );
  move(f.store);
  for (const entry of cases) {
    for (const wrapper of entry.wrappers) {
      const method = wrapper.startsWith('roles-') ? 'roles-action' : wrapper;
      const params =
        wrapper === 'github-abandon'
          ? entry.params
          : {
              request: entry.params,
              ...(wrapper === 'github-write-inspect' ? { page: 1 } : {}),
              ...(wrapper.startsWith('roles-')
                ? { action: wrapper.endsWith('inspect') ? 'inspect' : 'abandon' }
                : {}),
            };
      const command = hostCommandSchema.parse({
        workspaceId: scope.workspaceId,
        localProjectId: scope.localProjectId,
        method,
        params,
      });
      f.store.acquire(selected, command).release();
      f.store.bindOperation(selected, command);
      const changed = structuredClone(command) as unknown as { params: Record<string, unknown> };
      if (wrapper !== 'github-abandon')
        (changed.params.request as Record<string, unknown>).sessionId = 'other-session';
      else changed.params.sessionId = 'other-session';
      assert.throws(() => f.store.acquire(selected, hostCommandSchema.parse(changed)));
    }
  }
});

test('Task operation reference recovery uses a current lease and retains the original task row', (t) => {
  const f = fixture(t),
    selected = target(f.store.read());
  f.db.exec('CREATE TABLE task_operation(id TEXT PRIMARY KEY,record TEXT NOT NULL)');
  f.db
    .prepare('INSERT INTO task_operation VALUES(?,?)')
    .run('tool-operation', '{"synthetic":true}');
  const commands: HostCommand[] = ['inspect', 'abandon'].map((action) =>
    hostCommandSchema.parse({
      method: 'tasks-action',
      workspaceId: 'runtime',
      localProjectId: 'local-project',
      params: {
        workspaceId: 'runtime',
        localProjectId: 'local-project',
        sessionId: 'session',
        taskVersion: 1,
        grantId: 'grant',
        operationId: 'tool-operation',
        action,
      },
    }),
  );
  for (const command of commands) {
    f.store.acquire(selected, command).release();
    f.store.bindOperation(selected, command);
  }
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS count FROM encrypted_product_operation').get()!.count,
    0,
  );
  assert.equal(
    f.db.prepare('SELECT record FROM task_operation WHERE id=?').get('tool-operation')!.record,
    '{"synthetic":true}',
  );
  move(f.store);
  for (const command of commands) assert.throws(() => f.store.acquire(selected, command));
});
