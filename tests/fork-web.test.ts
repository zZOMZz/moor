import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionForkController, sessionForkKey, type ForkTarget } from '../src/web/session-fork';
import { ApiError } from '../src/web/api';
import type { ForkOptionsResult, SessionFork } from '../src/fork-protocol';
const target: ForkTarget = {
  owner: 'owner',
  deviceId: 'device',
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'source',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
};
const version = 'sha256:' + 'a'.repeat(64),
  oid = 'b'.repeat(40);
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function fixture() {
  const cache = new Map<string, any>(),
    calls: { path: string; body: any }[] = [];
  let counter = 0;
  const controls = {
    phase: 'accepted' as 'accepted' | 'unknown' | 'rejected',
    lost: false,
    rejected: false,
    wrong: false,
    failWrite: false,
    waitAction: undefined as undefined | (() => Promise<void>),
  };
  const options: ForkOptionsResult = {
    forkVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    confirmed: true,
    sourceVersion: version,
    execution: { mode: 'shared', status: 'ready', revision: 0 },
    agent: { id: 'agent', name: 'Synthetic Agent', agentType: 'synthetic' },
    capabilities: { sameDirectory: true, worktree: true, turnCutoff: true },
    currentAvailable: true,
    turns: [
      { turnId: 'finished', ordinal: 1, timestamp: '2026-09-12T00:00:00Z', available: true },
      {
        turnId: 'old',
        ordinal: 2,
        timestamp: '2026-09-12T00:00:01Z',
        available: false,
        reason: 'No native anchor',
      },
    ],
    partial: false,
    repository: {
      kind: 'git',
      branch: 'main',
      headOid: oid,
      branches: [{ name: 'main', oid }],
      changes: [],
      dirty: false,
      partial: false,
      outsideProjectChanges: false,
      version,
      issues: [],
      writeSupported: true,
    },
  };
  const create = (t = target, current = () => true) =>
    new SessionForkController(t, {
      read: async (key) => structuredClone(cache.get(key)),
      compareWrite: async (key, revision, value, guard) => {
        if (!guard()) throw new Error('scope changed');
        if (controls.failWrite) throw new Error('storage failed');
        if ((cache.get(key)?.cacheRevision ?? 0) !== revision) return false;
        cache.set(key, structuredClone(value));
        return true;
      },
      current,
      changed() {},
      uuid: () => `id-${++counter}`,
      request: async (path, body) => {
        calls.push({ path, body: structuredClone(body) });
        if (path.endsWith('/options')) return structuredClone(options);
        const request = body as SessionFork;
        assert.deepEqual(cache.get(sessionForkKey(t)).operation.request, request);
        if (controls.rejected) throw new ApiError('explicit rejection', 409, true);
        const directory = request.directory;
        const receipt = {
          forkVersion: 1,
          workspaceId: target.workspaceId,
          localProjectId: target.localProjectId,
          sessionId: target.sessionId,
          operationId: request.operationId,
          childSessionId: request.childSessionId,
          phase: controls.phase,
          confirmed: controls.phase === 'accepted',
          origin: {
            version: 1,
            sourceSessionId: controls.wrong ? 'other-source' : target.sessionId,
            sourceVersion: request.expectedSourceVersion,
            sourceTitle: '<img src=x>',
            cutoff: request.cutoff,
            directory: directory.kind,
            ...(directory.kind === 'worktree'
              ? { branch: directory.newBranch, baseOid: directory.expectedOid }
              : {}),
            createdAt: '2026-09-12T00:00:00Z',
          },
          execution:
            directory.kind === 'same-directory'
              ? options.execution
              : {
                  mode: 'worktree',
                  status: 'ready',
                  revision: 1,
                  executionId: 'child-execution',
                  branch: directory.newBranch,
                  baseOid: directory.expectedOid,
                },
        };
        await controls.waitAction?.();
        if (controls.lost) throw new Error('lost receipt');
        return structuredClone(receipt);
      },
    });
  return { create, cache, calls, controls, options };
}
test('Fork persists independent child identity and exact native cutoff before sending; reload and regrouping only resend on explicit retry', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  assert.equal(f.calls.length, 0);
  await c.refresh('finished');
  f.controls.lost = true;
  await assert.rejects(
    c.create(
      { kind: 'turn', turnId: 'finished' },
      { kind: 'worktree', baseBranch: 'main', expectedOid: oid, newBranch: 'feature/fork' },
    ),
    /lost/,
  );
  const original = structuredClone(c.pending!.request);
  assert.notEqual(original.childSessionId, target.sessionId);
  const moved = f.create({ ...target, catalogWorkspaceId: 'moved', replicaId: 'new-route' }),
    count = f.calls.length;
  await moved.load();
  assert.equal(f.calls.length, count);
  assert.equal(moved.blocked, true);
  await moved.refresh();
  assert.deepEqual(moved.pending!.request, original);
  f.controls.lost = false;
  const receipt = await moved.retry();
  assert.equal(receipt.phase, 'accepted');
  assert.equal(moved.pending, undefined);
  const action = f.calls.filter((call) => call.path.endsWith('/action'));
  assert.equal(action.length, 2);
  assert.deepEqual(action[1].body, original);
  assert.match(action[1].path, /moved\/replicas\/new-route/);
});
test('unavailable anchors, changed source versions, bad receipts and durable failures never silently choose a different Fork', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  await assert.rejects(
    c.create({ kind: 'turn', turnId: 'old' }, { kind: 'same-directory' }),
    /截止点/,
  );
  assert.equal(f.calls.filter((call) => call.path.endsWith('/action')).length, 0);
  f.options.sourceVersion = 'sha256:' + 'c'.repeat(64);
  await assert.rejects(c.create({ kind: 'current' }, { kind: 'same-directory' }), /源会话已经改变/);
  f.controls.wrong = true;
  await assert.rejects(c.create({ kind: 'current' }, { kind: 'same-directory' }), /来源/);
  assert.ok(c.pending);
  f.controls.wrong = false;
  f.controls.rejected = true;
  await assert.rejects(c.retry(), /explicit rejection/);
  assert.ok(c.pending);
  const reloaded = f.create();
  await reloaded.load();
  assert.deepEqual(reloaded.pending, c.pending);
  const fresh = fixture(),
    blocked = fresh.create();
  await blocked.load();
  await blocked.refresh();
  fresh.controls.failWrite = true;
  await assert.rejects(blocked.create({ kind: 'current' }, { kind: 'same-directory' }), /storage/);
  assert.equal(fresh.calls.filter((call) => call.path.endsWith('/action')).length, 0);
  assert.equal(blocked.blocked, true);
});
test('only a first explicit rejection clears a new Fork outbox; native unknown remains recoverable', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  f.controls.rejected = true;
  await assert.rejects(
    c.create({ kind: 'current' }, { kind: 'same-directory' }),
    /explicit rejection/,
  );
  assert.equal(c.pending, undefined);
  f.controls.rejected = false;
  f.controls.phase = 'unknown';
  await assert.rejects(c.create({ kind: 'current' }, { kind: 'same-directory' }), /结果未知/);
  assert.ok(c.pending);
  const restored = f.create();
  await restored.load();
  assert.equal(restored.blocked, true);
  assert.deepEqual(restored.pending, c.pending);
});
test('a late response and a concurrent page cannot replace newer Fork confirmation or execute an additional action', async () => {
  const f = fixture(),
    entered = signal(),
    release = signal();
  let current = true;
  const old = f.create(target, () => current);
  await old.load();
  await old.refresh();
  f.controls.waitAction = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = assert.rejects(
    old.create({ kind: 'current' }, { kind: 'same-directory' }),
    /执行目标已改变/,
  );
  await entered.promise;
  current = false;
  f.controls.waitAction = undefined;
  const newer = f.create();
  await newer.load();
  await newer.retry();
  const saved = structuredClone(f.cache.get(sessionForkKey(target)));
  release.resolve();
  await pending;
  assert.deepEqual(f.cache.get(sessionForkKey(target)), saved);
  const first = f.create(),
    second = f.create();
  await first.load();
  await second.load();
  await first.refresh();
  const before = f.calls.filter((call) => call.path.endsWith('/action')).length;
  await assert.rejects(second.create({ kind: 'current' }, { kind: 'same-directory' }), /其他页面/);
  assert.equal(second.blocked, true);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/action')).length, before);
});

test('failed Fork worktrees remain reachable across later operations and only a matching cleanup removes the resource', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  f.controls.phase = 'rejected';
  await assert.rejects(
    c.create(
      { kind: 'current' },
      { kind: 'worktree', baseBranch: 'main', expectedOid: oid, newBranch: 'feature/failed' },
    ),
    /拒绝/,
  );
  const failed = structuredClone(c.receipt!);
  f.controls.phase = 'accepted';
  await c.create({ kind: 'current' }, { kind: 'same-directory' });
  assert.equal(c.resources.length, 1);
  assert.deepEqual(c.resources[0].receipt, failed);
  const restored = f.create();
  await restored.load();
  assert.deepEqual(restored.resources, c.resources);
  const result = {
    gitVersion: 1 as const,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: failed.childSessionId,
    confirmed: true as const,
    repository: f.options.repository!,
    execution: {
      ...failed.execution!,
      status: 'removed' as const,
      disposition: 'removed' as const,
      revision: 2,
    },
    canRemove: false,
    canPrepare: false,
  };
  await assert.rejects(restored.confirmResourceCleanup('wrong-child', result), /匹配的清理/);
  assert.equal(restored.resources.length, 1);
  await restored.confirmResourceCleanup(failed.childSessionId, result);
  assert.equal(restored.resources.length, 0);
  const last = f.create();
  await last.load();
  assert.equal(last.resources.length, 0);
  assert.equal(last.receipt?.phase, 'accepted');
});
