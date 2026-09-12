import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/web/api';
import { GitWorkspaceController, gitWorkspaceKey, type GitTarget } from '../src/web/git-workspace';
import type { GitAction, GitStateResult, SessionExecution } from '../src/git-protocol';
const target: GitTarget = {
  owner: 'owner',
  deviceId: 'device',
  userId: 'host-user',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'draft',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
};
const oid = 'a'.repeat(40),
  version = 'sha256:' + 'a'.repeat(64);
function fixture() {
  const cache = new Map<string, unknown>(),
    calls: { path: string; body: any }[] = [];
  let execution: SessionExecution = { mode: 'shared', status: 'ready', revision: 0 },
    canRemove = true,
    canDetach = false,
    phase: 'accepted' | 'unknown' | 'rejected' = 'accepted',
    wrongReceipt = false,
    wrongExecution = false,
    writeFails = false,
    transportFails = false,
    explicitRejection = false;
  const state = (): GitStateResult => ({
    gitVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    confirmed: true,
    execution,
    canPrepare: execution.mode === 'shared',
    canRemove:
      execution.mode === 'worktree' && execution.status === 'ready' && canRemove && !canDetach,
    canDetach,
    boundSessions: canDetach ? 2 : 1,
    repository: {
      kind: 'git',
      branch: 'main',
      headOid: oid,
      branches: [{ name: 'main', oid }],
      changes: [],
      dirty: !canRemove,
      partial: false,
      outsideProjectChanges: false,
      version,
      issues: [],
      writeSupported: true,
    },
  });
  const create = (
    t = target,
    options: {
      current?: () => boolean;
      beforeWrite?: (value: any) => Promise<void>;
      waitState?: () => Promise<void>;
      waitAction?: () => Promise<void>;
      uuid?: string;
    } = {},
  ) =>
    new GitWorkspaceController(t, {
      read: async (key) => structuredClone(cache.get(key)),
      compareWrite: async (key, expectedRevision, value, current) => {
        await options.beforeWrite?.(value);
        if (!current()) throw new Error('执行目标已改变');
        if (writeFails) throw new Error('storage unavailable');
        if (((cache.get(key) as any)?.cacheRevision ?? 0) !== expectedRevision) return false;
        assert.equal(value.cacheRevision, expectedRevision + 1);
        cache.set(key, structuredClone(value));
        return true;
      },
      current: options.current ?? (() => true),
      changed() {},
      uuid: () => options.uuid ?? 'operation',
      request: async (path, body) => {
        calls.push({ path, body: structuredClone(body) });
        if (path.endsWith('/state')) {
          const result = structuredClone(state());
          await options.waitState?.();
          return result;
        }
        const action = body as GitAction;
        assert.deepEqual((cache.get(gitWorkspaceKey(t)) as any).pending.request, action);
        if (explicitRejection) throw new ApiError('Synthetic pre-dispatch rejection', 409, true);
        if (phase === 'accepted')
          execution =
            action.action === 'prepare'
              ? {
                  mode: 'worktree',
                  status: 'ready',
                  revision: 1,
                  executionId: 'execution',
                  branch: action.newBranch,
                  baseOid: action.expectedOid,
                }
              : {
                  ...execution,
                  status: 'removed',
                  revision: 2,
                  disposition: action.action === 'detach' ? 'detached' : 'removed',
                };
        if (transportFails) throw new Error('response lost');
        const result = {
          gitVersion: 1,
          workspaceId: target.workspaceId,
          localProjectId: target.localProjectId,
          sessionId: target.sessionId,
          operationId: wrongReceipt ? 'other' : action.operationId,
          phase,
          confirmed: phase === 'accepted',
          execution: wrongExecution ? { ...execution, branch: 'unrelated' } : execution,
        };
        await options.waitAction?.();
        return result;
      },
    });
  return {
    create,
    cache,
    calls,
    get state() {
      return state();
    },
    set execution(value: SessionExecution) {
      execution = value;
    },
    set phase(v: typeof phase) {
      phase = v;
    },
    set wrongExecution(v: boolean) {
      wrongExecution = v;
    },
    set wrongReceipt(v: boolean) {
      wrongReceipt = v;
    },
    set writeFails(v: boolean) {
      writeFails = v;
    },
    set explicitRejection(v: boolean) {
      explicitRejection = v;
    },
    set transportFails(v: boolean) {
      transportFails = v;
    },
    set canRemove(v: boolean) {
      canRemove = v;
    },
    set canDetach(v: boolean) {
      canDetach = v;
    },
  };
}
test('Git prepare is durable before transmission; reload and moved catalog retry retain the exact operation and execution target', async () => {
  const f = fixture(),
    controller = f.create();
  await controller.load();
  assert.equal(f.calls.length, 0);
  f.transportFails = true;
  await assert.rejects(controller.prepare('main', oid, 'feature/test'), /response lost/);
  const original = structuredClone(controller.pending!.request);
  const moved = f.create({ ...target, catalogWorkspaceId: 'moved', replicaId: 'moved-replica' });
  const before = f.calls.length;
  await moved.load();
  assert.equal(f.calls.length, before);
  assert.equal(moved.blocked, true);
  await moved.refresh();
  assert.deepEqual(moved.pending?.request, original);
  assert.equal(moved.execution?.status, 'ready');
  assert.equal(moved.blocked, true);
  f.transportFails = false;
  await moved.retry();
  assert.deepEqual(f.calls.findLast((call) => call.path.endsWith('/action'))?.body, original);
  assert.match(
    f.calls.findLast((call) => call.path.endsWith('/action'))!.path,
    /moved\/replicas\/moved-replica/,
  );
  assert.equal(moved.pending, undefined);
  assert.equal(moved.blocked, false);
  assert.notEqual(gitWorkspaceKey({ ...target, deviceId: 'other' }), gitWorkspaceKey(target));
});
test('unknown and malformed receipts retain original requests; only an explicit matching terminal receipt clears them', async () => {
  const f = fixture(),
    controller = f.create();
  await controller.load();
  f.phase = 'unknown';
  await assert.rejects(controller.prepare('main', oid, 'feature/test'), /未知/);
  const original = controller.pending!.request;
  f.phase = 'accepted';
  f.wrongReceipt = true;
  await assert.rejects(controller.retry(), /匹配/);
  assert.deepEqual(controller.pending?.request, original);
  f.wrongReceipt = false;
  f.wrongExecution = true;
  await assert.rejects(controller.retry(), /工作目录与原 Git 操作不匹配/);
  assert.deepEqual(controller.pending?.request, original);
  f.wrongExecution = false;
  f.phase = 'rejected';
  await assert.rejects(controller.retry(), /拒绝/);
  assert.equal(controller.pending, undefined);
});
test('failed durable writes never send actions and dirty cleanup is rechecked before transmission', async () => {
  const f = fixture(),
    controller = f.create();
  await controller.load();
  f.writeFails = true;
  await assert.rejects(controller.prepare('main', oid, 'feature/test'), /storage/);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/action')).length, 0);
  assert.ok(controller.loadError);
  assert.equal(controller.blocked, true);
  f.writeFails = false;
  await controller.load();
  await controller.prepare('main', oid, 'feature/test');
  f.canRemove = false;
  await assert.rejects(controller.remove(), /不能清理/);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/action')).length, 1);
  f.canRemove = true;
  await controller.remove();
  const request = f.calls.findLast((call) => call.path.endsWith('/action'))!.body;
  assert.equal(request.expectedStateVersion, version);
  assert.equal(request.executionId, 'execution');
  assert.equal(controller.execution?.status, 'removed');
  assert.equal(controller.blocked, true);
});
test('a changed selected baseline fails before Git side effects and corrupt scoped caches block recovery', async () => {
  const f = fixture(),
    controller = f.create();
  await controller.load();
  await assert.rejects(controller.prepare('main', 'b'.repeat(40), 'feature/test'), /基线已经改变/);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/action')).length, 0);
  f.cache.set(gitWorkspaceKey(target), {
    version: 1,
    target: { ...target, userId: 'foreign' },
    state: f.state,
  });
  const broken = f.create();
  await assert.rejects(broken.load());
  assert.ok(broken.loadError);
  assert.equal(broken.blocked, true);
});

test('fresh explicit rejection clears the durable outbox, while a rejected retry preserves original unknown delivery across reload', async () => {
  const fresh = fixture(),
    controller = fresh.create();
  await controller.load();
  fresh.explicitRejection = true;
  await assert.rejects(controller.prepare('main', oid, 'feature/test'), /pre-dispatch rejection/);
  assert.equal(controller.pending, undefined);
  assert.equal((fresh.cache.get(gitWorkspaceKey(target)) as any).pending, undefined);
  const restored = fresh.create();
  await restored.load();
  assert.equal(restored.blocked, false);
  const uncertain = fixture(),
    original = uncertain.create();
  await original.load();
  uncertain.transportFails = true;
  await assert.rejects(original.prepare('main', oid, 'feature/test'), /response lost/);
  const request = structuredClone(original.pending!.request);
  uncertain.transportFails = false;
  uncertain.explicitRejection = true;
  await assert.rejects(original.retry(), /pre-dispatch rejection/);
  assert.deepEqual(original.pending?.request, request);
  const reloaded = uncertain.create();
  await reloaded.load();
  assert.deepEqual(reloaded.pending?.request, request);
  assert.equal(reloaded.blocked, true);
});

test('fresh unknown directory state takes precedence over an accepted receipt at the same revision, including after reload', async () => {
  const f = fixture(),
    controller = f.create();
  await controller.load();
  await controller.prepare('main', oid, 'feature/test');
  assert.equal(controller.receipt?.phase, 'accepted');
  assert.equal(controller.execution?.status, 'ready');
  f.execution = {
    ...f.state.execution,
    status: 'unknown',
    reason: 'The managed worktree no longer matches its recorded branch.',
  };
  await controller.refresh();
  assert.equal(controller.receipt?.execution.revision, controller.state?.execution.revision);
  assert.equal(controller.receipt?.execution.status, 'ready');
  assert.equal(controller.execution?.status, 'unknown');
  assert.equal(controller.source, 'host');
  assert.equal(controller.blocked, true);
  const reloaded = f.create();
  await reloaded.load();
  assert.equal(reloaded.execution?.status, 'unknown');
  assert.equal(reloaded.source, 'cache');
  assert.equal(reloaded.blocked, true);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/action')).length, 1);
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('an old read response cannot erase a newer controller durable unknown request', async () => {
  const f = fixture(),
    entered = signal(),
    release = signal();
  let current = true;
  const old = f.create(target, {
    current: () => current,
    waitState: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await old.load();
  const reading = assert.rejects(old.refresh(), /执行目标已改变/);
  await entered.promise;
  current = false;
  const active = f.create();
  await active.load();
  f.transportFails = true;
  await assert.rejects(active.prepare('main', oid, 'feature/current'), /response lost/);
  const saved = structuredClone(f.cache.get(gitWorkspaceKey(target)));
  release.resolve();
  await reading;
  assert.deepEqual(f.cache.get(gitWorkspaceKey(target)), saved);
  const restored = f.create();
  await restored.load();
  assert.deepEqual(restored.pending?.request, active.pending?.request);
  assert.equal(restored.blocked, true);
});

test('an old accepted receipt cannot replace a newer confirmed removed execution', async () => {
  const f = fixture(),
    entered = signal(),
    release = signal();
  let current = true;
  const old = f.create(target, {
    current: () => current,
    waitAction: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await old.load();
  const preparing = assert.rejects(old.prepare('main', oid, 'feature/current'), /执行目标已改变/);
  await entered.promise;
  current = false;
  const active = f.create();
  await active.load();
  await active.retry();
  await active.remove();
  const saved = structuredClone(f.cache.get(gitWorkspaceKey(target)));
  release.resolve();
  await preparing;
  assert.deepEqual(f.cache.get(gitWorkspaceKey(target)), saved);
  const restored = f.create();
  await restored.load();
  assert.equal(restored.pending, undefined);
  assert.equal(restored.execution?.status, 'removed');
  assert.equal(restored.blocked, true);
});

test('two active pages competing to stage preserve the winning original request and block the stale page before dispatch', async () => {
  const f = fixture(),
    entered = signal(),
    release = signal();
  let hold = true;
  const old = f.create(target, {
    uuid: 'losing-operation',
    beforeWrite: async (value) => {
      if (!value.pending || !hold) return;
      hold = false;
      entered.resolve();
      await release.promise;
    },
  });
  await old.load();
  const competing = assert.rejects(old.prepare('main', oid, 'feature/old'), /其他页面更新/);
  await entered.promise;
  const active = f.create(target, { uuid: 'winning-operation' });
  await active.load();
  f.transportFails = true;
  await assert.rejects(active.prepare('main', oid, 'feature/current'), /response lost/);
  const saved = structuredClone(f.cache.get(gitWorkspaceKey(target)));
  release.resolve();
  await competing;
  assert.ok(old.loadError);
  assert.equal(old.blocked, true);
  assert.deepEqual(f.cache.get(gitWorkspaceKey(target)), saved);
  await assert.rejects(old.retry(), /重新打开/);
  assert.deepEqual(
    f.calls.filter((call) => call.path.endsWith('/action')).map((call) => call.body.operationId),
    ['winning-operation'],
  );
  const restored = f.create();
  await restored.load();
  assert.equal(restored.pending?.request.operationId, 'winning-operation');
  assert.equal(restored.blocked, true);
});

test('shared worktrees detach only with host permission and preserve the exact unknown detach action on retry', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.prepare('main', oid, 'feature/shared');
  await assert.rejects(c.detach(), /不能脱离/);
  f.canDetach = true;
  await assert.rejects(c.remove(), /不能清理/);
  f.transportFails = true;
  await assert.rejects(c.detach(), /response lost/);
  const original = structuredClone(c.pending!.request);
  assert.equal(original.action, 'detach');
  assert.equal('expectedStateVersion' in original, false);
  const restored = f.create();
  await restored.load();
  assert.equal(restored.blocked, true);
  f.transportFails = false;
  await restored.retry();
  assert.deepEqual(f.calls.findLast((call) => call.path.endsWith('/action'))!.body, original);
  assert.equal(restored.execution?.disposition, 'detached');
  assert.equal(restored.blocked, true);
});
