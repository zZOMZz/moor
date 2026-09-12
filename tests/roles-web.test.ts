import test from 'node:test';
import assert from 'node:assert/strict';
import { RolesController, rolesKey, roleSelection } from '../src/web/roles';
import { ApiError } from '../src/web/api';
import type { GitTarget } from '../src/web/git-workspace';
import type { RoleView } from '../src/role-protocol';
import { syntheticCapabilities } from './support/agent-capabilities';
const target: GitTarget = {
  owner: 'owner',
  deviceId: 'device',
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'session',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
};
const role: RoleView = {
  id: 'role',
  name: 'Synthetic role',
  revision: 1,
  agentId: 'agent',
  selection: { modelId: 'model-a' },
  instructions: 'Synthetic instructions',
  available: true,
};
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function fixture() {
  const cache = new Map<string, any>(),
    calls: any[] = [],
    receipts = new Map<string, any>();
  let sequence = 0;
  const controls = {
    online: true,
    fail: false,
    lost: false,
    rejected: false,
    wrong: false,
    missing: false,
    wait: undefined as undefined | (() => Promise<void>),
    role: structuredClone(role),
  };
  const create = (current = () => true, t = target) =>
    new RolesController(t, {
      current,
      online: () => controls.online,
      changed() {},
      uuid: () => `op-${++sequence}`,
      read: async (key) => structuredClone(cache.get(key)),
      compareWrite: async (key, revision, value, guard) => {
        if (!guard()) throw Error('stale');
        if (controls.fail) throw Error('storage failed');
        if ((cache.get(key)?.cacheRevision ?? 0) !== revision) return false;
        cache.set(key, structuredClone(value));
        return true;
      },
      request: async (path, raw) => {
        const body = structuredClone(raw) as any;
        calls.push({ path, body });
        await controls.wait?.();
        const scope = {
          rolesVersion: 1,
          workspaceId: t.workspaceId,
          localProjectId: t.localProjectId,
          sessionId: t.sessionId,
          confirmed: true,
        };
        if (path.endsWith('/read')) return { ...scope, catalogRevision: 1, roles: [controls.role] };
        if (body.action === 'inspect')
          return {
            ...scope,
            action: 'inspect',
            operationId: body.request.operationId,
            ...(!controls.missing && receipts.has(body.request.operationId)
              ? { found: true, receipt: receipts.get(body.request.operationId) }
              : { found: false }),
          };
        if (body.action === 'abandon') {
          assert.deepEqual(cache.get(rolesKey(t)).pending, body.request);
          assert.equal(cache.get(rolesKey(t)).ending, true);
          if (!receipts.has(body.request.operationId))
            receipts.set(body.request.operationId, {
              ...scope,
              accepted: false,
              abandoned: true,
              operationId: body.request.operationId,
              action: body.request.action,
              catalogRevision: body.request.expectedRevision,
            });
          if (controls.lost) throw Error('lost abandon receipt');
          return receipts.get(body.request.operationId);
        }
        assert.deepEqual(
          cache.get(rolesKey(t)).pending,
          body,
          'the exact request is durable before transmission',
        );
        if (controls.rejected) throw new ApiError('explicit rejection', 409, true);
        if (!controls.missing && !receipts.has(body.operationId))
          receipts.set(body.operationId, {
            ...scope,
            accepted: true,
            operationId: body.operationId,
            action: body.action,
            catalogRevision: body.expectedRevision + 1,
            roleId: body.id ?? 'new-role',
          });
        if (controls.lost) throw Error('lost');
        return {
          ...receipts.get(body.operationId),
          ...(controls.wrong ? { operationId: 'wrong' } : {}),
        };
      },
    });
  return { cache, calls, receipts, controls, create };
}
const edit = {
  name: 'Manual role',
  agentId: 'agent',
  selection: {},
  instructions: 'Manual instructions',
};
test('role reads never write or probe and a changed frozen version prevents application', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  assert.equal(f.calls.length, 0);
  await c.refresh();
  assert.equal(f.cache.size, 0);
  assert.deepEqual(await c.freshRole(role), role);
  f.controls.role.instructions = 'changed';
  await assert.rejects(c.freshRole(role), /版本/);
  f.controls.online = false;
  c.invalidate();
  assert.equal(c.list, undefined);
  await assert.rejects(c.refresh(), /离线/);
  assert.ok(f.calls.every((call) => call.path.endsWith('/roles/read')));
});
test('unknown role saves recover from the exact durable request; inspect never dispatches it and missing is not cancellation', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  f.controls.lost = true;
  await assert.rejects(c.saveRole(edit));
  const original = structuredClone(c.pending);
  const restored = f.create();
  await restored.load();
  assert.deepEqual(restored.pending, original);
  assert.equal(f.calls.filter((call) => call.body.action === 'save').length, 1);
  f.controls.missing = true;
  await restored.inspect();
  assert.deepEqual(restored.pending, original);
  assert.match(restored.error, /不代表操作已取消/);
  f.controls.missing = false;
  await restored.inspect();
  assert.equal(restored.pending, undefined);
  assert.equal(f.receipts.size, 1);
  assert.equal(f.calls.filter((call) => call.body.action === 'save').length, 1);
});
test('first explicit refusal clears only its new stage, while a refused retry keeps the unknown original across reload', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  f.controls.rejected = true;
  await assert.rejects(c.saveRole(edit));
  assert.equal(c.pending, undefined);
  f.controls.rejected = false;
  f.controls.lost = true;
  await assert.rejects(c.saveRole(edit));
  const original = structuredClone(c.pending);
  f.controls.rejected = true;
  await assert.rejects(c.retry());
  const restored = f.create();
  await restored.load();
  assert.deepEqual(restored.pending, original);
  f.controls.rejected = false;
  f.controls.lost = false;
  f.controls.wrong = true;
  await assert.rejects(restored.retry(), /回执/);
  assert.deepEqual(restored.pending, original);
});
test('competing controllers and storage failures cannot dispatch a second role action', async () => {
  const f = fixture(),
    a = f.create(),
    b = f.create();
  await Promise.all([a.load(), b.load()]);
  await Promise.all([a.refresh(), b.refresh()]);
  f.controls.lost = true;
  await assert.rejects(a.saveRole(edit));
  await assert.rejects(b.saveRole(edit));
  assert.equal(f.calls.filter((call) => call.body.action === 'save').length, 1);
  assert.ok(b.loadError);
  const g = fixture(),
    c = g.create();
  await c.load();
  await c.refresh();
  g.controls.fail = true;
  await assert.rejects(c.saveRole(edit));
  assert.equal(g.calls.filter((call) => call.body.action === 'save').length, 0);
});
test('a late role read or receipt cannot cross a changed target or clear its durable unknown request', async () => {
  const f = fixture();
  let current = true;
  const c = f.create(() => current);
  await c.load();
  await c.refresh();
  const entered = signal(),
    release = signal();
  f.controls.wait = async () => {
    entered.resolve();
    await release.promise;
  };
  const operation = c.saveRole(edit),
    rejected = assert.rejects(operation);
  await entered.promise;
  current = false;
  release.resolve();
  await rejected;
  assert.ok(f.cache.get(rolesKey(target)).pending);
  assert.equal(c.receipt, undefined);
  const restored = f.create();
  await restored.load();
  assert.ok(restored.pending);
});
test('empty role fields retain the current choices and unsupported values never silently change permission mode', () => {
  assert.deepEqual(
    roleSelection(
      { ...role, selection: { modeId: undefined } },
      { modelId: 'model-a', modeId: 'read-only', reasoningEffort: 'high' },
      syntheticCapabilities,
    ),
    { modelId: 'model-a', modeId: 'read-only', reasoningEffort: 'high' },
  );
  assert.throws(
    () =>
      roleSelection(
        { ...role, selection: { modeId: 'missing' } },
        { modeId: 'read-only' },
        syntheticCapabilities,
      ),
    /审批/,
  );
  assert.throws(
    () =>
      roleSelection(
        { ...role, available: false, unavailableReason: 'retired' },
        {},
        syntheticCapabilities,
      ),
    /retired/,
  );
});

test('ending an undelivered role operation is durable and retries only the same tombstone after refresh', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  f.controls.missing = f.controls.lost = true;
  await assert.rejects(c.saveRole(edit));
  const request = structuredClone(c.pending);
  await assert.rejects(c.abandon());
  assert.equal(c.ending, true);
  const restored = f.create();
  await restored.load();
  assert.equal(restored.ending, true);
  assert.deepEqual(restored.pending, request);
  f.controls.lost = false;
  await restored.retry();
  assert.equal(restored.pending, undefined);
  assert.equal(restored.receipt?.accepted, false);
  assert.equal(f.calls.filter((call) => call.body.action === 'save').length, 1);
  assert.deepEqual(
    f.calls.filter((call) => call.body.action === 'abandon').map((call) => call.body.request),
    [request, request],
  );
});
test('ending an already completed role operation reports its real accepted result instead of cancellation', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  f.controls.lost = true;
  await assert.rejects(c.saveRole(edit));
  f.controls.lost = false;
  await c.abandon();
  assert.equal(c.receipt?.accepted, true);
  assert.equal(c.pending, undefined);
  assert.doesNotMatch(c.error, /封存/);
});
