import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { RuntimeStore } from '@moor/host/persistence/store';
import { HostCommandDispatcher } from '@moor/host/commands/host-command';
import {
  RETIRED_RECORDS_FEATURE,
  RETIRED_SESSION_FEATURE,
} from '@moor/protocol/connection-authority';
import { DesktopWorkspaceClient } from '@moor/client/node/workspace-client';
import { desktopWorkspaceCatalogSchema } from '@moor/client/workspace-protocol';
import { roleActionSchema } from '@moor/protocol/role-protocol';
import { previewOpenSchema } from '@moor/protocol/preview-protocol';
import { taskActionSchema } from '@moor/protocol/task-protocol';
import { buildSessionTurn } from '@moor/session/session-operations';
import { syntheticCapabilities } from '../fixtures/agent-capabilities';
import { syntheticTaskPlan } from '../fixtures/task-plan';
import { syntheticRelay } from '../fixtures/synthetic-relay';
import { PROTOCOL } from '@moor/protocol/protocol';
import { SESSION_CONTROL_FEATURE } from '@moor/protocol/session-control-protocol';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-retired-session-')));
  const file = join(root, 'host.sqlite');
  const store = new RuntimeStore(file);
  const project = store.registerProject(root);
  store.machine.set(['agentConfig', 'agent'], {
    id: 'agent',
    name: 'Synthetic',
    machineId: store.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/never-run', args: [] },
    runConfig: syntheticCapabilities,
  });
  store.saveMachine();
  let opened = 0;
  const host = new HostWorkspace(
    store,
    {
      async open() {
        opened++;
        throw Error('Retired features must never start an Agent');
      },
    },
    () => {},
    () => {},
  );
  const scope = {
    workspaceId: store.workspace.id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
    localProjectId: project,
    sessionId: 'parent',
  };
  await host.controlManager.control(
    {
      ...scope,
      controlVersion: 1,
      action: 'create',
      operationId: 'create-parent',
      agentId: 'agent',
    },
    project,
  );
  t.after(() => {
    host.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const dispatcher = new HostCommandDispatcher({
    ready: () => !host.closed,
    workspace: (id) => (id === scope.workspaceId ? host : undefined),
    hasOperation: (id) => store.journal.has(id),
  });
  const content = {
    workspaceId: scope.workspaceId,
    localProjectId: project,
    sessionId: scope.sessionId,
  };
  const key = JSON.stringify([
    scope.workspaceId,
    scope.userId,
    scope.machineId,
    project,
    scope.sessionId,
  ]);
  return {
    root,
    file,
    store,
    host,
    scope,
    content,
    project,
    dispatcher,
    key,
    opened: () => opened,
  };
}

test('fresh ordinary hosts do not create retired catalogs or task tables and reject new instructions before acceptance', async (t) => {
  const f = await fixture(t);
  assert(f.host.workspace.features?.includes(RETIRED_RECORDS_FEATURE));
  for (const feature of ['roles-v1', 'preview-v1', 'session-tasks-v1', 'session-mcp-v1'])
    assert(!f.host.workspace.features?.includes(feature));
  for (const table of [
    'project_role_catalog',
    'task_grant',
    'task_slot',
    'task_operation',
    'task_revocation',
  ])
    assert.equal(
      f.store.journal.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table),
      undefined,
    );
  const read = await f.host.read('parent');
  for (const extra of [
    { mcpServerIds: ['mcpv_' + '1'.repeat(32)] },
    { taskPlan: syntheticTaskPlan() },
  ]) {
    const operation = buildSessionTurn({
      scope: f.scope,
      read,
      agent: read.agent!,
      prompt: 'Explicit but retired feature',
      operationId: 'retired-turn',
      turnId: 'retired-user',
      peerId: '41',
      now: '2026-09-22T00:00:00Z',
      ...extra,
    });
    await assert.rejects(f.host.mutate(operation, f.project), (error: any) => error.status === 410);
    assert.equal(f.store.journal.has(operation.operationId), false);
  }
  assert.equal(f.opened(), 0);
});

test('roles and previews expose only original scoped receipts and never create or seal missing records', async (t) => {
  const f = await fixture(t),
    db = f.store.journal.db;
  db.exec('CREATE TABLE project_role_catalog(scope TEXT PRIMARY KEY,revision INTEGER,roles TEXT)');
  const role = roleActionSchema.parse({
    ...f.content,
    rolesVersion: 1,
    operationId: 'old-role',
    expectedRevision: 0,
    action: 'save',
    id: 'role',
    name: 'Old role',
    agentId: 'agent',
    selection: {},
    instructions: 'Historical instructions',
  });
  assert(role.action === 'save');
  const receipt = {
    ...f.content,
    rolesVersion: 1,
    operationId: role.operationId,
    action: role.action,
    confirmed: true,
    accepted: true,
    catalogRevision: 1,
    roleId: 'role',
  };
  db.prepare('INSERT INTO operation(id,fingerprint,phase,result) VALUES(?,?,?,?)').run(
    role.operationId,
    hash([f.key, role]),
    'role-accepted',
    JSON.stringify(receipt),
  );
  db.prepare('INSERT INTO project_role_catalog VALUES(?,?,?)').run(
    JSON.stringify([f.scope.workspaceId, f.scope.userId, f.scope.machineId, f.project]),
    1,
    JSON.stringify([
      {
        id: 'role',
        revision: 1,
        name: role.name,
        agentId: role.agentId,
        selection: role.selection,
        instructions: role.instructions,
      },
    ]),
  );
  const preview = previewOpenSchema.parse({
    ...f.content,
    previewVersion: 1,
    action: 'open',
    operationId: 'old-preview',
    confirmed: true,
    clientId: 'old-client',
    serviceId: 'service',
    serviceVersion: 'sha256:' + 'a'.repeat(64),
    executionRevision: 0,
    viewport: { width: 800, height: 600 },
  });
  db.prepare('INSERT INTO operation(id,fingerprint,phase,approval) VALUES(?,?,?,?)').run(
    preview.operationId,
    f.store.journal.fingerprint(f.key, preview),
    'preview-dispatched',
    JSON.stringify({ previewId: 'old-preview-instance' }),
  );
  const acceptedPreview = { ...preview, operationId: 'accepted-preview' };
  const previewReceipt = {
    ...f.content,
    previewVersion: 1,
    clientId: acceptedPreview.clientId,
    operationId: acceptedPreview.operationId,
    action: acceptedPreview.action,
    requestVersion: 'sha256:' + hash(acceptedPreview),
    phase: 'accepted',
    previewId: 'old-preview-instance',
    closed: false,
    message: 'Historical confirmation',
    checkedAt: '2026-01-02T03:04:05.000Z',
  };
  db.prepare('INSERT INTO operation(id,fingerprint,phase,result) VALUES(?,?,?,?)').run(
    acceptedPreview.operationId,
    f.store.journal.fingerprint(f.key, acceptedPreview),
    'preview-accepted',
    JSON.stringify(previewReceipt),
  );
  const before = db.prepare('SELECT * FROM operation ORDER BY id').all();
  const changes = db.prepare('SELECT total_changes() AS count').get()!.count;
  assert.deepEqual(
    (f.host.roleAction({ action: 'inspect', request: role }, f.project) as any).receipt,
    receipt,
  );
  const roles = f.host.readRoles({ ...f.content, rolesVersion: 1 }, f.project);
  assert.equal(roles.roles[0]!.instructions, role.instructions);
  assert.equal(roles.roles[0]!.available, false);
  assert.equal(f.host.inspectPreview({ request: preview }, f.project).phase, 'unknown');
  assert.deepEqual(f.host.inspectPreview({ request: acceptedPreview }, f.project), {
    ...previewReceipt,
    closed: true,
  });
  assert.equal(
    f.host.inspectPreview({ request: { ...preview, operationId: 'missing' } }, f.project).phase,
    'unknown',
  );
  assert.throws(
    () => f.host.roleAction(role, f.project),
    (error: any) => error.status === 410,
  );
  assert.throws(
    () => f.host.roleAction({ action: 'abandon', request: role }, f.project),
    (error: any) => error.status === 410,
  );
  assert.throws(() =>
    f.host.roleAction(
      { action: 'inspect', request: { ...role, instructions: 'different' } },
      f.project,
    ),
  );
  assert.throws(() =>
    f.host.inspectPreview({ request: { ...preview, clientId: 'different' } }, f.project),
  );
  for (const method of ['preview-action', 'preview-close', 'preview-read']) {
    const params =
      method === 'preview-action'
        ? preview
        : method === 'preview-close'
          ? { request: preview }
          : { ...f.content, previewVersion: 1, view: 'options' };
    await assert.rejects(
      f.dispatcher.execute({
        method,
        workspaceId: f.scope.workspaceId,
        localProjectId: f.project,
        params,
      }),
      (error: any) => error.status === 410,
    );
  }
  assert.deepEqual(db.prepare('SELECT * FROM operation ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT total_changes() AS count').get()!.count, changes);
  assert.equal(f.opened(), 0);
});

test('retired task reads preserve stored states and bind grant, slot, original operation and reserved child identity', async (t) => {
  const f = await fixture(t),
    db = f.store.journal.db;
  db.exec(
    'CREATE TABLE task_grant(id TEXT PRIMARY KEY,scope TEXT,parent_turn_id TEXT,record TEXT); CREATE TABLE task_slot(child_session_id TEXT PRIMARY KEY,grant_id TEXT,task_id TEXT,record TEXT); CREATE TABLE task_operation(id TEXT PRIMARY KEY,grant_id TEXT,task_id TEXT,fingerprint TEXT,record TEXT); CREATE TABLE task_revocation(id TEXT PRIMARY KEY,fingerprint TEXT,grant_id TEXT)',
  );
  const grant = {
    id: 'old-grant',
    scope: f.scope,
    authority: { serverOrigin: 'https://synthetic.invalid', ownerId: 'owner', deviceId: 'device' },
    parentUserTurnId: 'old-user',
    parentAssistantTurnId: 'old-assistant',
    plan: syntheticTaskPlan(),
    createdAt: 1000,
    expiresAt: 60000,
    status: 'active',
  };
  const slot = {
    taskId: 'task-one',
    childSessionId: 'reserved-child',
    branch: 'moor/task-one',
    status: 'unknown',
    turnCount: 0,
    lastOperationId: 'old-operation',
  };
  // Keep the old JSON.stringify property order, including optional fields before action.
  const request = {
    grantId: grant.id,
    taskId: slot.taskId,
    operationId: 'old-operation',
    expectedUserTurnId: null,
    prompt: 'Historical task',
    action: 'send',
  };
  const operation = { request, phase: 'unknown', nested: {} };
  const scopeKey = JSON.stringify(f.scope);
  db.prepare('INSERT INTO task_grant VALUES(?,?,?,?)').run(
    grant.id,
    scopeKey,
    grant.parentAssistantTurnId,
    JSON.stringify(grant),
  );
  db.prepare('INSERT INTO task_slot VALUES(?,?,?,?)').run(
    slot.childSessionId,
    grant.id,
    slot.taskId,
    JSON.stringify(slot),
  );
  db.prepare('INSERT INTO task_operation VALUES(?,?,?,?,?)').run(
    request.operationId,
    grant.id,
    slot.taskId,
    hash([scopeKey, grant.authority, request]),
    JSON.stringify(operation),
  );
  const before = ['task_grant', 'task_slot', 'task_operation'].map((table) =>
    db.prepare('SELECT * FROM ' + table).all(),
  );
  const input = { ...f.content, taskVersion: 1 as const, grantId: grant.id };
  const observed = f.host.readTasks(input, f.project);
  assert.equal(observed.grants[0]!.state, 'active');
  assert.equal(observed.grants[0]!.tasks[0]!.status, 'unknown');
  assert.equal(
    f.host.inspectTask({ ...input, action: 'inspect', operationId: request.operationId }, f.project)
      .operation!.state,
    'unknown',
  );
  assert.throws(
    () =>
      f.host.inspectTask(
        { ...input, action: 'abandon', operationId: request.operationId },
        f.project,
      ),
    (error: any) => error.status === 410,
  );
  assert.equal(f.store.tasks.allows(slot.childSessionId), false);
  await assert.rejects(
    f.host.controlManager.control(
      {
        ...f.scope,
        sessionId: slot.childSessionId,
        controlVersion: 1,
        action: 'create',
        operationId: 'cannot-take-reserved-child',
        agentId: 'agent',
      },
      f.project,
    ),
  );
  assert.throws(() => f.host.readTasks({ ...input, localProjectId: 'foreign' }, f.project));
  assert.deepEqual(
    ['task_grant', 'task_slot', 'task_operation'].map((table) =>
      db.prepare('SELECT * FROM ' + table).all(),
    ),
    before,
  );
  const reopened = new RuntimeStore(f.file);
  assert.deepEqual(
    ['task_grant', 'task_slot', 'task_operation'].map((table) =>
      reopened.journal.db.prepare('SELECT * FROM ' + table).all(),
    ),
    before,
    'startup does not rewrite retired unknown states',
  );
  assert.equal(reopened.tasks.allows(slot.childSessionId), false);
  reopened.close();

  // A canceled grant is not evidence that an arbitrary revocation ID happened.
  db.prepare('UPDATE task_grant SET record=? WHERE id=?').run(
    JSON.stringify({ ...grant, status: 'canceled' }),
    grant.id,
  );
  const revoke = taskActionSchema.parse({
    ...input,
    action: 'revoke',
    operationId: 'original-revocation',
  });
  assert.throws(
    () => f.host.inspectTask({ ...revoke, action: 'inspect' }, f.project),
    (error: any) => error.status === 404,
  );
  db.prepare('INSERT INTO task_revocation VALUES(?,?,?)').run(
    revoke.operationId,
    hash([scopeKey, grant.authority, revoke]),
    grant.id,
  );
  const changes = db.prepare('SELECT total_changes() AS count').get()!.count;
  assert.equal(
    f.host.inspectTask({ ...revoke, action: 'inspect' }, f.project).grant.state,
    'canceled',
  );
  assert.equal(db.prepare('SELECT total_changes() AS count').get()!.count, changes);
});

test('retired MCP reads expose only safe descriptors from the original project and never return connection secrets', async (t) => {
  const f = await fixture(t),
    stat = lstatSync(f.root, { bigint: true });
  const id = 'mcpv_' + 'a'.repeat(32);
  const saved = {
    version: 1,
    identity: {
      workspaceId: f.scope.workspaceId,
      userId: f.scope.userId,
      machineId: f.scope.machineId,
    },
    revision: 1,
    presets: [{ id: 'preset', versionId: id, enabled: true, removed: false, generation: 1 }],
    versions: [
      {
        id,
        presetId: 'preset',
        name: 'Old tools',
        description: 'Historical only',
        projects: [
          { id: f.project, rootPath: f.root, dev: String(stat.dev), ino: String(stat.ino) },
        ],
        connection: {
          transport: 'http',
          url: 'https://synthetic.invalid/mcp',
          headers: { Authorization: 'SYNTHETIC_PRIVATE_SECRET' },
        },
      },
    ],
  };
  f.store.save('mcp-settings-v1', Buffer.from(JSON.stringify(saved)));
  const before = Buffer.from(f.store.load('mcp-settings-v1')!);
  const result = f.host.readMcp({ ...f.content, mcpVersion: 1 }, f.project);
  assert.equal(result.servers[0]!.id, id);
  assert(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_SECRET'));
  assert(!JSON.stringify(result).includes('synthetic.invalid'));
  assert.deepEqual(Buffer.from(f.store.load('mcp-settings-v1')!), before);
  assert.equal(f.opened(), 0);
});

test('Relay rejects retired writes even for old hosts; old hosts retain reads and cancellation but cannot receive new turns', async (t) => {
  const f = await syntheticRelay();
  t.after(f.close);
  const [workspace] = await (await f.api('/api/workspaces')).json();
  const host = f.hosts[0]!;
  const binding = workspace.hosts.find((item: any) => item.deviceId === host.device.id);
  const replica = workspace.replicas.find(
    (item: any) => item.hostId === binding.id && item.localProjectId === 'local-moor',
  );
  const base = `/api/workspaces/${workspace.id}/replicas/${replica.id}`;
  host.runtime.features = host.runtime.features!.filter(
    (feature) => feature !== RETIRED_RECORDS_FEATURE,
  );
  host.runtime.features.push(SESSION_CONTROL_FEATURE);
  host.socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: host.runtime.machineId,
      workspaces: [host.runtime],
    }),
  );
  host.socket.ping();
  await once(host.socket, 'pong');
  const before = host.messages.length;
  const scope = {
    workspaceId: host.runtime.id,
    localProjectId: 'local-moor',
    sessionId: 'same-session-id',
  };
  const response = await f.api(base + '/mutations', {
    operationId: 'new-input',
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    kind: 'turn',
    expectedTurnId: null,
    update: 'AA==',
  });
  assert.equal(response.status, 409);
  assert.equal(host.messages.length, before);
  assert.equal((await f.api(base + '/sessions')).status, 200);
  const recoveryScope = {
    ...scope,
    userId: host.runtime.userId,
    machineId: host.runtime.machineId,
    controlVersion: 1,
  };
  host.responses.set('session-operations', () => ({
    ...recoveryScope,
    confirmed: true,
    action: 'inspect',
    operationId: 'old-create',
    found: false,
  }));
  const inspected = await f.api(base + '/session-operations', {
    ...recoveryScope,
    action: 'inspect',
    request: {
      kind: 'control',
      value: { ...recoveryScope, action: 'create', agentId: 'agent', operationId: 'old-create' },
    },
  });
  assert.equal(inspected.status, 200);
  assert.equal((await inspected.json()).found, false);
  assert.equal(
    (await f.api(base + '/cancel', { sessionId: scope.sessionId, turnId: 'old-turn' })).status,
    200,
  );
  for (const action of ['read', 'action', 'close'])
    assert.equal((await f.api(base + '/preview/' + action, {})).status, 410);
  assert.equal(
    (
      await f.api(base + '/roles/action', {
        ...scope,
        rolesVersion: 1,
        operationId: 'new-role',
        expectedRevision: 0,
        action: 'remove',
        id: 'role',
      })
    ).status,
    410,
  );
  assert.equal(
    (
      await f.api(base + '/tasks-action', {
        ...scope,
        taskVersion: 1,
        grantId: 'grant',
        operationId: 'new-task',
        action: 'revoke',
      })
    ).status,
    410,
  );
});

test('a current Host definite retirement rejection remains 410 through Relay and the workspace transport', async (t) => {
  const f = await syntheticRelay();
  t.after(f.close);
  const host = f.hosts[0]!;
  host.socket.removeAllListeners('message');
  host.socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'request')
      host.socket.send(
        JSON.stringify({
          type: 'response',
          requestId: message.requestId,
          error: { status: 410, message: RETIRED_SESSION_FEATURE, rejected: true },
        }),
      );
  });
  const client = new DesktopWorkspaceClient({
    source: 'remote',
    origin: f.origin,
    cookie: 'personal=' + f.secret,
    current() {},
  });
  t.after(() => client.close());
  const loaded: any = await client.request({ action: 'catalog', source: 'remote' });
  const catalog = desktopWorkspaceCatalogSchema.parse(loaded.value);
  const selected = catalog.targets.find(
    (entry) =>
      entry.target.deviceId === host.device.id && entry.target.localProjectId === 'local-moor',
  )!;
  const result: any = await client.request({
    action: 'execute',
    source: 'remote',
    connectionId: catalog.connectionId,
    target: { ...selected.target, sessionId: 'same-session-id' },
    command: {
      method: 'mutate',
      workspaceId: selected.target.workspaceId,
      localProjectId: selected.target.localProjectId,
      params: {
        workspaceId: selected.target.workspaceId,
        sessionId: 'same-session-id',
        operationId: 'retired-original',
        kind: 'turn',
        expectedTurnId: null,
        update: 'AA==',
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.status, 410);
  assert.equal(result.error.rejected, true);
  assert.equal(result.error.message, RETIRED_SESSION_FEATURE);
});
