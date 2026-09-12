import test from 'node:test';
import assert from 'node:assert/strict';
import { McpController, mcpKey } from '../src/web/mcp';
import { TasksController } from '../src/web/tasks';
import type { GitTarget } from '../src/web/git-workspace';
import type { Mutation } from '../src/protocol';
import { syntheticTaskPlan } from './support/task-plan';
const target: GitTarget = {
  owner: 'owner',
  deviceId: 'device',
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'runtime',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
  localProjectId: 'project',
  sessionId: 'session',
};
const server = {
  id: 'version-a',
  name: 'Synthetic tools',
  description: 'Read synthetic data',
  transport: 'stdio' as const,
};
const mutation: Mutation = {
  operationId: 'original',
  workspaceId: 'runtime',
  sessionId: 'session',
  kind: 'turn',
  expectedTurnId: null,
  update: 'YQ==',
  metaBundle: {},
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture() {
  const rows = new Map<string, any>(),
    calls: any[] = [];
  let current = true,
    online = true,
    count = 0,
    response: any,
    waitRead: undefined | (() => Promise<void>),
    waitWrite: undefined | (() => Promise<void>),
    fail = false;
  const deps = {
    read: async (key: string) => structuredClone(rows.get(key)),
    current: () => current,
    online: () => online,
    changed() {},
    uuid: () => `review-${++count}`,
    compareWrite: async (key: string, expected: number, value: any, alive: () => boolean) => {
      await waitWrite?.();
      if (!alive()) throw Error('changed target');
      if (fail) throw Error('storage failed');
      if ((rows.get(key)?.cacheRevision ?? 0) !== expected) return false;
      rows.set(key, structuredClone(value));
      return true;
    },
    compareSubmission: async (
      entries: readonly { key: string; expected: unknown; value: unknown }[],
      alive: () => boolean,
    ) => {
      await waitWrite?.();
      if (!alive()) throw Error('changed target');
      if (fail) throw Error('storage failed');
      if (
        entries.some(
          (entry) => JSON.stringify(rows.get(entry.key)) !== JSON.stringify(entry.expected),
        )
      )
        return false;
      for (const entry of entries) rows.set(entry.key, structuredClone(entry.value));
      return true;
    },
    request: async (path: string, body: any) => {
      calls.push({ path, body });
      await waitRead?.();
      return response ?? { ...body, confirmed: true, catalogRevision: 1, servers: [server] };
    },
  };
  return {
    rows,
    calls,
    deps,
    create: (scope = target) => new McpController(scope, deps),
    set current(value: boolean) {
      current = value;
    },
    set online(value: boolean) {
      online = value;
    },
    set response(value: any) {
      response = value;
    },
    set waitRead(value: typeof waitRead) {
      waitRead = value;
    },
    set waitWrite(value: typeof waitWrite) {
      waitWrite = value;
    },
    set fail(value: boolean) {
      fail = value;
    },
  };
}
test('MCP metadata is explicitly read, selected immutable versions remain scoped offline drafts, and invalidation never upgrades them', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  assert.equal(f.calls.length, 0);
  await c.refresh();
  await c.apply([server]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, '/api/workspaces/catalog/replicas/replica/mcp/read');
  const restored = f.create();
  await restored.load();
  assert.deepEqual(restored.selected, [server]);
  assert.equal(restored.list, undefined);
  f.online = false;
  await restored.apply([]);
  assert.equal(f.calls.length, 1);
  await assert.rejects(restored.refresh(), /离线/);
  f.online = true;
  await c.prepareSend();
  assert.equal(f.calls.length, 2);
  c.invalidate();
  assert.equal(c.list, undefined);
  assert.deepEqual(c.selected, [server]);
  f.response = {
    mcpVersion: 1,
    workspaceId: 'runtime',
    localProjectId: 'project',
    sessionId: 'session',
    confirmed: true,
    catalogRevision: 2,
    servers: [{ ...server, id: 'version-b' }],
  };
  await assert.rejects(c.prepareSend(), /不可用/);
  assert.deepEqual(c.selected, [server]);
  for (const key of Object.keys(target) as (keyof GitTarget)[])
    assert.notEqual(mcpKey({ ...target, [key]: 'different' }), mcpKey(target));
  const fork = f.create({ ...target, sessionId: 'fork' });
  await fork.load();
  assert.deepEqual(fork.selected, []);
});
test('MCP selection rejects foreign metadata, extra launch secrets, duplicate and excessive versions, and delayed catalog results', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await assert.rejects(c.apply([server]), /当前已读取/);
  await c.refresh();
  await assert.rejects(c.apply([server, server]));
  await assert.rejects(
    c.apply(Array.from({ length: 9 }, (_, i) => ({ ...server, id: `version-${i}` }))),
  );
  await assert.rejects(c.apply([{ ...server, command: '/private/program' } as any]));
  const entered = gate(),
    release = gate();
  f.waitRead = async () => {
    entered.release();
    await release.promise;
  };
  const reading = c.refresh();
  await entered.promise;
  c.invalidate();
  release.release();
  await assert.rejects(reading, /目录已改变/);
  assert.equal(c.list, undefined);
  f.waitRead = undefined;
  for (const extra of [
    { sessionId: 'elsewhere' },
    { servers: [{ ...server, url: 'https://secret.invalid' }] },
    { servers: [server, server] },
  ]) {
    f.response = {
      mcpVersion: 1,
      workspaceId: 'runtime',
      localProjectId: 'project',
      sessionId: 'session',
      confirmed: true,
      catalogRevision: 1,
      servers: [server],
      ...extra,
    };
    await assert.rejects(c.refresh());
    assert.equal(c.list, undefined);
  }
});
test('MCP review and original mutation are atomically staged; unknown retry keeps its original review and late confirmation preserves new choices', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  await c.apply([server]);
  const review = (await c.prepareSend())!;
  await c.stageSubmission(mutation, review, 'pending', mutation);
  assert.deepEqual(f.rows.get('pending'), mutation);
  assert.equal(f.rows.get(mcpKey(target)).delivery.operationId, 'original');
  const restored = f.create();
  await restored.load();
  f.online = false;
  await assert.rejects(restored.verifySubmission(mutation), /离线/);
  f.online = true;
  assert.equal(await restored.verifySubmission(mutation), true);
  assert.equal(f.calls.length, 2, 'retry validation performs no new MCP read');
  await assert.rejects(restored.verifySubmission({ ...mutation, update: 'Yg==' }), /不匹配/);
  await restored.apply([]);
  const nextReview = restored.review?.reviewId;
  await restored.confirmSubmission('different');
  assert.ok(restored.delivery);
  await restored.confirmSubmission('original');
  assert.equal(restored.delivery, undefined);
  assert.equal(restored.review?.reviewId, nextReview);
});
test('MCP and task authorization share the original pending transaction and storage races cannot leave half a grant', async () => {
  const f = fixture(),
    c = f.create(),
    tasks = new TasksController(target, f.deps);
  await c.load();
  await c.refresh();
  await c.apply([server]);
  await tasks.load();
  const plan = syntheticTaskPlan();
  await tasks.edit(plan);
  await tasks.enable(plan, 'agent');
  const review = (await c.prepareSend())!;
  await c.stageSubmission(mutation, review, 'pending', mutation, (entry, current) =>
    tasks.stageSubmission(mutation, 'pending', mutation, [entry], current),
  );
  assert.ok(c.delivery);
  assert.ok(tasks.delivery);
  assert.deepEqual(f.rows.get('pending'), mutation);
  const next = fixture(),
    nc = next.create();
  await nc.load();
  await nc.refresh();
  await nc.apply([server]);
  const nr = (await nc.prepareSend())!;
  next.rows.set('pending', { operationId: 'other' });
  await assert.rejects(nc.stageSubmission(mutation, nr, 'pending', mutation), /其他页面/);
  assert.equal(next.rows.get(mcpKey(target)).delivery, undefined);
  assert.equal(next.rows.get('pending').operationId, 'other');
});
test('MCP draft scope changes and failed CAS preserve the prior durable selection', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  await c.apply([server]);
  const entered = gate(),
    release = gate();
  f.waitWrite = async () => {
    entered.release();
    await release.promise;
  };
  const saving = c.apply([]);
  await entered.promise;
  f.current = false;
  release.release();
  await assert.rejects(saving, /changed target/);
  assert.deepEqual(f.rows.get(mcpKey(target)).review.servers, [server]);
  f.current = true;
  f.waitWrite = undefined;
  const restored = f.create();
  await restored.load();
  f.fail = true;
  await assert.rejects(restored.apply([]), /storage failed/);
  assert.deepEqual(restored.selected, [server]);
});
