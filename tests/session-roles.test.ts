import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { putMeta } from '../src/model';
import { AppError } from '../src/protocol';
import {
  ROLE_FEATURE,
  ROLE_LIMITS,
  roleActionSchema,
  type RoleAction,
  type RoleAcceptedReceipt,
  type RolesRead,
} from '../src/role-protocol';

const instructions =
  'SYNTHETIC_ROLE_BODY\n用户说明：中文 <script>not code</script> `never execute`';
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'moor-roles-')),
    file = join(root, 'host.sqlite'),
    projectRoot = join(root, 'project'),
    otherRoot = join(root, 'other');
  mkdirSync(projectRoot);
  mkdirSync(otherRoot);
  let store = new RuntimeStore(file),
    opens = 0;
  const project = store.registerProject(projectRoot),
    other = store.registerProject(otherRoot);
  const agent = store.registerAgent('synthetic', {
    id: 'synthetic-agent',
    name: 'Synthetic Agent',
    machineId: store.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/PRIVATE_AGENT_PATH', args: ['PRIVATE_AGENT_CREDENTIAL'] },
  });
  const changed: unknown[] = [];
  const makeHost = () =>
    new HostWorkspace(
      store,
      {
        async open() {
          opens++;
          throw new Error('Never open an Agent for roles');
        },
      },
      () => {},
      (id) => changed.push(id),
    );
  let host = makeHost();
  const scope: RolesRead = {
    rolesVersion: 1,
    workspaceId: store.workspace.id,
    localProjectId: project,
    sessionId: 'draft-session',
  };
  t.after(() => {
    host.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const action = (expectedRevision = 0): Extract<RoleAction, { action: 'save' }> => ({
    ...scope,
    action: 'save',
    operationId: randomUUID(),
    expectedRevision,
    name: '合成角色',
    agentId: agent.id,
    selection: {},
    instructions,
  });
  return {
    get store() {
      return store;
    },
    get host() {
      return host;
    },
    get opens() {
      return opens;
    },
    scope,
    project,
    other,
    projectRoot,
    agent,
    changed,
    action,
    read: (input = scope) => host.readRoles(input, input.localProjectId),
    save: (input = action()) =>
      host.roleAction(input, input.localProjectId) as Promise<RoleAcceptedReceipt>,
    reopen() {
      host.close();
      store.close();
      store = new RuntimeStore(file);
      host = makeHost();
    },
    fullScope(sessionId = scope.sessionId) {
      return {
        workspaceId: scope.workspaceId,
        userId: store.workspace.userId,
        machineId: store.workspace.machineId,
        localProjectId: project,
        sessionId,
      };
    },
  };
}

test('roles are project templates shared across draft sessions, never Agent launches or session edits', async (t) => {
  const f = fixture(t);
  assert.ok(f.host.workspace.features?.includes(ROLE_FEATURE));
  const request = f.action(),
    receipt = await f.save(request);
  assert.equal(receipt.catalogRevision, 1);
  assert.equal('instructions' in receipt, false);
  const result = await f.read({ ...f.scope, sessionId: 'another-draft' });
  assert.equal(result.catalogRevision, 1);
  assert.deepEqual(result.roles, [
    {
      id: receipt.roleId,
      revision: 1,
      name: request.name,
      agentId: f.agent.id,
      selection: {},
      instructions,
      available: true,
    },
  ]);
  assert.deepEqual(
    (await f.read({ ...f.scope, localProjectId: f.other, sessionId: 'other-project-draft' })).roles,
    [],
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_AGENT|customAcp|command|machineId|rootPath/);
  assert.equal(f.opens, 0);
  assert.deepEqual(f.host.list(), []);
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM session').get()?.n, 0);
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM agent_session').get()?.n, 0);
  assert.equal(
    f.store.journal.db.prepare('SELECT count(*) AS n FROM session_agent_binding').get()?.n,
    0,
  );
  assert.doesNotMatch(
    JSON.stringify(f.store.journal.db.prepare('SELECT * FROM operation').all()),
    /SYNTHETIC_ROLE_BODY|PRIVATE_AGENT/,
  );
  assert.deepEqual(f.changed, [undefined]);
});

test('save, copy and remove use the project catalog CAS and immutable original operation receipts', async (t) => {
  const f = fixture(t),
    original = f.action(),
    first = await f.save(original);
  const updated = await f.save({ ...f.action(1), id: first.roleId, name: 'Renamed' });
  assert.equal(updated.roleId, first.roleId);
  const copied = await f.save(f.action(2));
  assert.notEqual(copied.roleId, first.roleId);
  assert.deepEqual(
    (await f.read()).roles.map((role) => role.revision),
    [2, 3],
  );
  await assert.rejects(
    f.save(f.action(1)),
    (error: AppError) => error.status === 409 && error.rejected,
  );
  const removed: RoleAction = {
    ...f.scope,
    action: 'remove',
    operationId: randomUUID(),
    expectedRevision: 3,
    id: first.roleId,
  };
  const deletion = await f.host.roleAction(removed);
  assert.deepEqual(await f.host.roleAction(removed), deletion);
  assert.deepEqual(
    await f.save(original),
    first,
    'old receipt confirms history without restoring role',
  );
  assert.deepEqual(
    (await f.read()).roles.map((role) => role.id),
    [copied.roleId],
  );
  await assert.rejects(f.save({ ...original, name: 'Different payload' }), /重复编号/);
  assert.equal((await f.read()).catalogRevision, 4);
});

test('manual inspect reports only the exact original receipt; missing does not cancel a later delivery', async (t) => {
  const f = fixture(t),
    request = f.action();
  const missing = await f.host.roleAction({ action: 'inspect', request });
  assert.deepEqual(missing, {
    ...f.scope,
    confirmed: true,
    action: 'inspect',
    operationId: request.operationId,
    found: false,
  });
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.equal(
    f.store.journal.db.prepare('SELECT count(*) AS n FROM attachment_scope').get()?.n,
    0,
  );
  assert.deepEqual(f.changed, []);
  const receipt = await f.save(request);
  assert.equal(
    f.store.journal.db.prepare('SELECT count(*) AS n FROM attachment_scope').get()?.n,
    1,
  );
  const found = await f.host.roleAction({ action: 'inspect', request });
  assert.deepEqual(found, { ...missing, found: true, receipt });
  await assert.rejects(
    f.host.roleAction({ action: 'inspect', request: { ...request, instructions: 'changed' } }),
    (error: AppError) => error.status === 409 && !error.rejected,
  );
  assert.equal((await f.read()).catalogRevision, 1);
});

test('concurrent saves serialize across sessions and only one catalog CAS succeeds', async (t) => {
  const f = fixture(t),
    first = f.action(),
    second = { ...f.action(), sessionId: 'second-draft' };
  const results = await Promise.allSettled([f.save(first), f.save(second)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await f.read()).catalogRevision, 1);
  assert.equal((await f.read()).roles.length, 1);
  assert.equal(f.opens, 0);
});

test('catalog and receipt transaction failures roll back together, with original ID retry after restart', async (t) => {
  const f = fixture(t),
    request = f.action();
  f.store.journal.db.exec(
    "CREATE TRIGGER synthetic_role_failure BEFORE INSERT ON operation WHEN NEW.phase='role-accepted' BEGIN SELECT RAISE(ABORT,'PRIVATE_AGENT_CREDENTIAL disk failure'); END",
  );
  await assert.rejects(
    f.save(request),
    (error: AppError) => error.rejected && !error.message.includes('PRIVATE_AGENT'),
  );
  assert.equal((await f.read()).catalogRevision, 0);
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.equal(
    f.store.journal.db.prepare('SELECT count(*) AS n FROM attachment_scope').get()?.n,
    0,
  );
  f.store.journal.db.exec('DROP TRIGGER synthetic_role_failure');
  const receipt = await f.save(request);
  f.reopen();
  assert.deepEqual(await f.save(request), receipt);
  assert.equal((await f.read()).roles[0].instructions, instructions);
  assert.equal(f.opens, 0);
});

test('retiring Agent versions never retargets a role and a bound old session can still apply it', async (t) => {
  const f = fixture(t),
    request = f.action();
  await f.save(request);
  const next = f.store.registerAgent('synthetic', { ...f.agent, name: 'New version' });
  f.host.updateCatalogue();
  const old = (await f.read()).roles[0];
  assert.equal(old.agentId, f.agent.id);
  assert.equal(old.available, false);
  assert.ok(old.unavailableReason);
  await assert.rejects(f.save(f.action(1)), /当前可用的 Agent/);
  const scope = f.fullScope('existing');
  putMeta(f.store.meta, 'session-existing', {
    id: 'existing',
    userId: scope.userId,
    machineId: scope.machineId,
    project: { kind: 'local', localProjectId: f.project },
    agentConfigId: f.agent.id,
    cliType: f.agent.cliType,
    agentType: f.agent.agentType,
  });
  f.store.agents.bind(scope, f.agent);
  assert.equal((await f.read({ ...f.scope, sessionId: 'existing' })).roles[0].available, true);
  const fresh = await f.save({ ...f.action(1), agentId: next.id });
  assert.equal((await f.read()).roles.find((role) => role.id === fresh.roleId)?.available, true);
  assert.equal(f.opens, 0);
});

test('roles preserve syntactically valid model choices without probing or substituting capability caches', async (t) => {
  const f = fixture(t),
    request = {
      ...f.action(),
      selection: {
        modelId: 'future-model',
        reasoningEffort: 'future-effort',
        modeId: 'future-mode',
      },
    };
  await f.save(request);
  assert.deepEqual((await f.read()).roles[0].selection, request.selection);
  assert.equal(f.opens, 0);
  assert.equal(f.store.machine.get(['capabilities', f.agent.id]), undefined);
  assert.equal(
    roleActionSchema.safeParse({ ...request, selection: { reasoningEffort: 'orphan' } }).success,
    false,
  );
  for (const field of ['command', 'customAcp', 'systemPrompt', 'tools', 'env'])
    assert.equal(roleActionSchema.safeParse({ ...request, [field]: 'private' }).success, false);
});

test('role requests bind workspace, local project, session ownership, runtime user and machine', async (t) => {
  const f = fixture(t),
    request = f.action();
  await f.save(request);
  putMeta(f.store.meta, 'session-other', {
    id: 'other',
    userId: f.store.workspace.userId,
    machineId: f.store.workspace.machineId,
    project: { kind: 'local', localProjectId: f.other },
  });
  for (const input of [
    { ...f.scope, workspaceId: 'foreign' },
    { ...f.scope, localProjectId: 'missing' },
    { ...f.scope, sessionId: 'other' },
  ]) {
    await assert.rejects(f.host.readRoles(input));
    await assert.rejects(f.host.roleAction({ ...request, ...input }));
  }
  await assert.rejects(f.host.readRoles(f.scope, f.other));
  await assert.rejects(f.host.roleAction(request, f.other));
  f.store.workspace.userId = 'local:other-user';
  assert.deepEqual((await f.read({ ...f.scope, sessionId: 'other-account-draft' })).roles, []);
  await assert.rejects(f.host.roleAction({ action: 'inspect', request }));
  f.store.workspace.machineId = 'other-machine';
  assert.deepEqual((await f.read({ ...f.scope, sessionId: 'other-machine-draft' })).roles, []);
});

test('queued role actions revalidate scope before storage and late committed results never claim unsent', async (t) => {
  for (const phase of ['before', 'after'] as const)
    await t.test(phase, async (t) => {
      const f = fixture(t),
        entered = signal(),
        release = signal(),
        request = f.action();
      t.after(release.resolve);
      const serial = f.host.serial.bind(f.host);
      f.host.serial = async (id, work) =>
        serial(id, async () => {
          if (phase === 'before') {
            entered.resolve();
            await release.promise;
          }
          const result = await work();
          if (phase === 'after') {
            entered.resolve();
            await release.promise;
          }
          return result;
        });
      const pending = f.save(request);
      const rejected = assert.rejects(
        pending,
        (error: AppError) =>
          [404, 409].includes(error.status) && error.rejected === (phase === 'before'),
      );
      await entered.promise;
      f.store.workspace.userId = 'local:changed';
      release.resolve();
      await rejected;
      assert.equal(f.store.journal.has(request.operationId), phase === 'after');
      assert.equal(f.opens, 0);
    });
});

test('roles reject pending Fork child scopes', async (t) => {
  const f = fixture(t);
  f.host.forkManager.busy.add(f.scope.sessionId);
  await assert.rejects(f.read(), /Fork/);
  await assert.rejects(f.save(), /Fork/);
  f.host.forkManager.busy.clear();
  f.store.journal.db
    .prepare('INSERT INTO session_fork VALUES(?,?,?,?)')
    .run('pending-fork', f.scope.sessionId, 'synthetic', JSON.stringify({ phase: 'dispatched' }));
  await assert.rejects(f.read(), /Fork/);
  assert.equal(f.opens, 0);
});

test('known role receipts remain recoverable after the worktree is removed, without any new writes', async (t) => {
  const f = fixture(t),
    request = f.action(),
    receipt = await f.save(request),
    scope = f.fullScope();
  f.store.journal.db.prepare('INSERT INTO session_execution VALUES(?,?,?,?,?,?)').run(
    scope.workspaceId,
    scope.userId,
    scope.machineId,
    scope.localProjectId,
    scope.sessionId,
    JSON.stringify({
      scope,
      execution: {
        mode: 'worktree',
        status: 'removed',
        revision: 2,
        executionId: 'removed-worktree',
      },
    }),
  );
  const before = f.store.journal.db.prepare('SELECT total_changes() AS n').get()?.n;
  const inspected = await f.host.roleAction({ action: 'inspect', request });
  assert.equal('found' in inspected && inspected.found, true);
  assert.deepEqual(await f.save(request), receipt);
  assert.equal(f.store.journal.db.prepare('SELECT total_changes() AS n').get()?.n, before);
  assert.doesNotMatch(JSON.stringify(inspected), /SYNTHETIC_ROLE_BODY|PRIVATE_AGENT/);
  const fresh = f.action(1);
  const absent = await f.host.roleAction({ action: 'inspect', request: fresh });
  assert.equal('found' in absent && absent.found, false);
  await assert.rejects(f.save(fresh), /工作目录已清理/);
  await assert.rejects(
    f.host.roleAction({
      ...f.scope,
      action: 'remove',
      operationId: randomUUID(),
      expectedRevision: 1,
      id: receipt.roleId,
    }),
    /工作目录已清理/,
  );
  await assert.rejects(f.read(), /工作目录已清理/);
  assert.equal(f.store.journal.db.prepare('SELECT total_changes() AS n').get()?.n, before);
  assert.equal(f.opens, 0);
});

test('role acceptance reserves the originating draft scope and prevents cross-project session ID claims', async (t) => {
  const f = fixture(t),
    request = f.action(),
    receipt = await f.save(request);
  const foreign = { ...request, localProjectId: f.other };
  await assert.rejects(f.host.roleAction({ action: 'inspect', request: foreign }));
  await assert.rejects(f.save({ ...foreign, operationId: randomUUID() }));
  assert.equal(
    f.store.attachmentScopeMatches({ ...f.fullScope(), localProjectId: f.other }),
    false,
  );
  assert.deepEqual(await f.save(request), receipt);
});

test('manual role abandonment seals the original ID without persisting its template or running a late save', async (t) => {
  const f = fixture(t),
    request = f.action();
  const result = await f.host.roleAction({ action: 'abandon', request });
  assert.deepEqual(result, {
    ...f.scope,
    confirmed: true,
    accepted: false,
    abandoned: true,
    action: 'save',
    operationId: request.operationId,
    catalogRevision: 0,
  });
  const before = f.store.journal.db.prepare('SELECT total_changes() AS n').get()?.n;
  assert.deepEqual(await f.host.roleAction({ action: 'abandon', request }), result);
  assert.deepEqual(await f.host.roleAction(request), result);
  const inspected = await f.host.roleAction({ action: 'inspect', request });
  assert.deepEqual(inspected, {
    ...f.scope,
    confirmed: true,
    action: 'inspect',
    operationId: request.operationId,
    found: true,
    receipt: result,
  });
  assert.equal(f.store.journal.db.prepare('SELECT total_changes() AS n').get()?.n, before);
  assert.equal((await f.read()).catalogRevision, 0);
  assert.equal(
    f.store.journal.db.prepare('SELECT count(*) AS n FROM project_role_catalog').get()?.n,
    0,
  );
  assert.doesNotMatch(
    JSON.stringify(f.store.journal.db.prepare('SELECT * FROM operation').all()),
    /SYNTHETIC_ROLE_BODY|PRIVATE_AGENT/,
  );
  f.reopen();
  assert.deepEqual(await f.host.roleAction(request), result);
  assert.equal((await f.read()).roles.length, 0);
  assert.equal(f.opens, 0);
});

test('role abandonment returns prior success and preserves a different current catalog', async (t) => {
  const f = fixture(t),
    request = f.action(),
    receipt = await f.save(request);
  const removal: RoleAction = {
    ...f.scope,
    action: 'remove',
    operationId: randomUUID(),
    expectedRevision: 1,
    id: receipt.roleId,
  };
  await f.host.roleAction(removal);
  assert.deepEqual(await f.host.roleAction({ action: 'abandon', request }), receipt);
  assert.equal((await f.read()).catalogRevision, 2);
  assert.equal((await f.read()).roles.length, 0);
  const neverArrived = f.action(0);
  const abandoned = await f.host.roleAction({ action: 'abandon', request: neverArrived });
  assert.equal('accepted' in abandoned && abandoned.accepted, false);
  assert.equal(
    'catalogRevision' in abandoned && abandoned.catalogRevision,
    0,
    'original expected revision is not current catalog state',
  );
  assert.deepEqual(await f.host.roleAction(neverArrived), abandoned);
  assert.equal((await f.read()).catalogRevision, 2);
});

test('sealing an unknown remove preserves the existing role and rejects any changed fingerprint', async (t) => {
  const f = fixture(t),
    receipt = await f.save();
  const request: RoleAction = {
    ...f.scope,
    action: 'remove',
    operationId: randomUUID(),
    expectedRevision: 1,
    id: receipt.roleId,
  };
  const sealed = await f.host.roleAction({ action: 'abandon', request });
  assert.deepEqual(await f.host.roleAction(request), sealed);
  assert.equal((await f.read()).roles[0].id, receipt.roleId);
  await assert.rejects(
    f.host.roleAction({ action: 'abandon', request: { ...request, id: 'changed' } }),
    (error: AppError) => !error.rejected && /重复编号/.test(error.message),
  );
  assert.equal((await f.read()).catalogRevision, 1);
});

test('role save and abandonment race in the same project queue; first committed outcome wins', async (t) => {
  for (const first of ['save', 'abandon'] as const)
    await t.test(first, async (t) => {
      const f = fixture(t),
        request = f.action(),
        entered = signal(),
        release = signal();
      t.after(release.resolve);
      const serial = f.host.serial.bind(f.host);
      let held = false;
      f.host.serial = async (id, work) =>
        serial(id, async () => {
          if (!held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return work();
        });
      const initial = f.host.roleAction(
        first === 'save' ? request : { action: 'abandon', request },
      );
      await entered.promise;
      const later = f.host.roleAction(first === 'save' ? { action: 'abandon', request } : request);
      release.resolve();
      const [a, b] = await Promise.all([initial, later]);
      assert.deepEqual(a, b);
      assert.equal('accepted' in a && a.accepted, first === 'save');
      assert.equal((await f.read()).roles.length, first === 'save' ? 1 : 0);
      assert.equal(f.opens, 0);
    });
});

test('role abandonment works after worktree removal and rolls scope reservation back on failed sealing', async (t) => {
  const f = fixture(t),
    request = f.action(),
    scope = f.fullScope();
  f.store.journal.db.prepare('INSERT INTO session_execution VALUES(?,?,?,?,?,?)').run(
    scope.workspaceId,
    scope.userId,
    scope.machineId,
    scope.localProjectId,
    scope.sessionId,
    JSON.stringify({
      scope,
      execution: {
        mode: 'worktree',
        status: 'removed',
        revision: 2,
        executionId: 'removed-worktree',
      },
    }),
  );
  f.store.journal.db.exec(
    "CREATE TRIGGER synthetic_abandon_failure BEFORE INSERT ON operation WHEN NEW.phase='role-abandoned' BEGIN SELECT RAISE(ABORT,'private body'); END",
  );
  await assert.rejects(
    f.host.roleAction({ action: 'abandon', request }),
    (error: AppError) => !error.rejected && !error.message.includes('private body'),
  );
  assert.equal(
    f.store.journal.db.prepare('SELECT count(*) AS n FROM attachment_scope').get()?.n,
    0,
  );
  assert.equal(f.store.journal.has(request.operationId), false);
  f.store.journal.db.exec('DROP TRIGGER synthetic_abandon_failure');
  const sealed = await f.host.roleAction({ action: 'abandon', request });
  assert.deepEqual(await f.host.roleAction(request), sealed);
  assert.equal(
    f.store.journal.db.prepare('SELECT count(*) AS n FROM project_role_catalog').get()?.n,
    0,
  );
  const other = { ...request, localProjectId: f.other };
  await assert.rejects(f.host.roleAction({ action: 'abandon', request: other }));
});

test('role instructions use UTF-8 byte limits and the catalog has bounded item count', async (t) => {
  const f = fixture(t);
  assert.equal(
    roleActionSchema.safeParse({
      ...f.action(),
      instructions: '界'.repeat(Math.floor(ROLE_LIMITS.instructionBytes / 3)),
    }).success,
    true,
  );
  assert.equal(
    roleActionSchema.safeParse({
      ...f.action(),
      instructions: '界'.repeat(Math.floor(ROLE_LIMITS.instructionBytes / 3) + 1),
    }).success,
    false,
  );
  for (let index = 0; index < ROLE_LIMITS.items; index++) await f.save(f.action(index));
  await assert.rejects(
    f.save(f.action(ROLE_LIMITS.items)),
    (error: AppError) => error.status === 413 && error.rejected,
  );
  assert.equal((await f.read()).roles.length, ROLE_LIMITS.items);
  assert.equal(f.opens, 0);
});
