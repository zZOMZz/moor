import test from 'node:test';
import assert from 'node:assert/strict';
import { readSecureGitExecutionBlock } from '../../apps/web/src/features/git/secure-git';
import { gitWorkspaceKey } from '../../apps/web/src/features/git/git-workspace';
import { secureGitTarget } from '../../apps/web/src/platform/secure-scoped-storage';
import { fixture, target, oid, version, signal } from '../fixtures/secure-git-fixture';

const current = () => {};
const key = (input = target) => gitWorkspaceKey(secureGitTarget(input));
const actions = (f: ReturnType<typeof fixture>) =>
  f.calls.filter((call) => call.method === 'git-action');
async function opened(f = fixture(), newSession = true) {
  await f.controller.open(f.state.context.target!, { newSession });
  return f;
}
async function prepare(f: ReturnType<typeof fixture>, name = 'feature/synthetic') {
  return f.controller.prepare(f.controller.state!.review, 'main', oid, name);
}
async function pending(f = fixture(), unseen = false) {
  await opened(f);
  f.state.lost = true;
  f.state.unseen = unseen;
  await assert.rejects(prepare(f), /Synthetic/);
  return f;
}
function changeMapping(f: ReturnType<typeof fixture>) {
  f.controller.close();
  f.state.context.target!.product = {
    ...target.product!,
    projectId: 'new-product',
    replicaId: 'new-replica',
    revision: 2,
  };
  f.state.context.generation++;
}

test('trusted Git prepares from the exact baseline and cleans a confirmed worktree with persisted scope and no prompt', async () => {
  const f = await opened();
  assert.equal(f.controller.state!.git.execution!.mode, 'shared');
  assert.equal(actions(f).length, 0);
  await prepare(f);
  const first = actions(f)[0];
  assert.deepEqual(first.target, target);
  assert.deepEqual(first.params, {
    gitVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    operationId: 'git-operation-1',
    expectedRevision: 0,
    action: 'prepare',
    baseBranch: 'main',
    expectedOid: oid,
    newBranch: 'feature/synthetic',
  });
  assert.equal(f.state.prepared.length, 1);
  assert.equal(f.controller.state!.git.pending, undefined);
  await f.controller.remove(f.controller.state!.review);
  assert.equal(actions(f)[1].params.expectedStateVersion, version);
  assert.equal(f.controller.state!.git.execution!.status, 'removed');
  assert.match((await readSecureGitExecutionBlock(f.storage, target, current))!, /不可用/);
  assert.deepEqual(f.state.navigations, []);
  assert(
    f.state.callbackLocks.every((count) => count === 0),
    'Post-action callbacks run outside the execution lock',
  );
});

test('existing session cannot prepare; shared worktree detach preserves the other binding', async () => {
  const f = await opened(undefined, false);
  await assert.rejects(prepare(f), /空会话/);
  const host = f.hostState();
  host.execution = {
    mode: 'worktree',
    status: 'ready',
    revision: 4,
    executionId: 'shared-execution',
    branch: 'feature/shared',
    baseOid: oid,
  };
  host.canPrepare = false;
  host.canRemove = false;
  host.canDetach = true;
  host.boundSessions = 2;
  await f.controller.refresh(f.controller.state!.review);
  await f.controller.detach(f.controller.state!.review);
  assert.equal(actions(f).length, 1);
  assert.equal(actions(f)[0].params.action, 'detach');
  assert.equal(actions(f)[0].params.executionId, 'shared-execution');
  assert.equal(f.controller.state!.git.execution!.disposition, 'detached');
});

for (const change of [
  'branch',
  'dirty',
  'execution',
  'bindings',
  'canPrepare',
  'writeSupported',
] as const)
  test(`complete displayed Git review rejects unshown ${change} change before any stage`, async () => {
    const f = await opened(),
      host = f.hostState();
    if (change === 'branch') host.repository.branches[0].oid = 'c'.repeat(40);
    if (change === 'dirty') host.repository.dirty = true;
    if (change === 'execution') host.execution.revision++;
    if (change === 'bindings') host.boundSessions = 2;
    if (change === 'canPrepare') host.canPrepare = false;
    if (change === 'writeSupported') host.repository.writeSupported = false;
    await assert.rejects(prepare(f), /已改变/);
    assert.equal(actions(f).length, 0);
    assert.equal(((await f.storage.read(target, key(), current)) as any).pending, undefined);
  });

test('fresh dirty worktree cannot be removed and stale removal cannot adopt another execution', async () => {
  const f = await opened();
  await prepare(f);
  const stale = f.controller.state!.review,
    host = f.hostState();
  host.repository.dirty = true;
  host.canRemove = false;
  await assert.rejects(f.controller.remove(stale), /已改变/);
  await f.controller.refresh(f.controller.state!.review);
  await assert.rejects(f.controller.remove(f.controller.state!.review), /不能清理/);
  assert.equal(actions(f).length, 1);
  host.repository.dirty = false;
  host.canRemove = true;
  await f.controller.refresh(f.controller.state!.review);
  host.execution.executionId = 'other-execution';
  await assert.rejects(f.controller.remove(f.controller.state!.review), /已改变/);
  assert.equal(actions(f).length, 1);
});

test('lost receipt survives restart; only manual inspect reads accepted original result', async () => {
  const f = await pending(),
    original = structuredClone(actions(f)[0]);
  assert.match((await readSecureGitExecutionBlock(f.storage, target, current))!, /待确认/);
  f.controller.close();
  const controller = f.create();
  await controller.open(target, { newSession: true });
  assert.equal(actions(f).length, 1);
  assert.deepEqual(controller.state!.git.pending!.request, original.params);
  await controller.recover(controller.state!.review, 'inspect');
  assert.equal(actions(f).length, 1);
  assert.deepEqual(f.calls.find((call) => call.method === 'git-operations')!.params, {
    action: 'inspect',
    request: original.params,
  });
  assert.equal(controller.state!.git.pending, undefined);
  assert.equal(controller.state!.git.receipt!.phase, 'accepted');
  assert.equal(await readSecureGitExecutionBlock(f.storage, target, current), null);
});

test('inspect of an unseen original does not stage on Host; explicit abandon seals and clears only original pending', async () => {
  const f = await pending(undefined, true);
  const original = structuredClone(f.controller.state!.git.pending);
  await f.controller.recover(f.controller.state!.review, 'inspect');
  assert.deepEqual(f.controller.state!.git.pending, original);
  assert.match(f.controller.state!.error, /尚未记录/);
  assert.equal(f.receipts.size, 0);
  await f.controller.recover(f.controller.state!.review, 'abandon');
  assert.equal(f.controller.state!.git.receipt!.phase, 'abandoned');
  assert.equal(f.controller.state!.git.pending, undefined);
  assert.equal(actions(f).length, 1);
});

test('dispatched unknown operation remains pending after abandon; mismatched recovery hash cannot save', async () => {
  const f = await opened();
  f.state.unknown = true;
  await assert.rejects(prepare(f), /Synthetic/);
  const original = structuredClone(f.controller.state!.git.pending);
  await f.controller.recover(f.controller.state!.review, 'abandon');
  assert.deepEqual(f.controller.state!.git.pending, original);
  assert.equal(f.controller.state!.git.receipt!.phase, 'unknown');
  f.state.wrong = true;
  await assert.rejects(f.controller.recover(f.controller.state!.review, 'inspect'), /不匹配/);
  assert.deepEqual(f.controller.state!.git.pending, original);
  assert.equal(actions(f).length, 1);
});

test('old product mapping remains blocked and recovery-only with exact original body and target', async () => {
  const f = await pending(undefined, true),
    original = structuredClone(actions(f)[0]);
  changeMapping(f);
  await f.controller.open(f.state.context.target!, { newSession: true });
  assert.match(
    (await readSecureGitExecutionBlock(f.storage, f.state.context.target!, current))!,
    /待确认/,
  );
  assert.equal(f.controller.state!.git.pending, undefined);
  assert.equal(f.controller.state!.recoveries.length, 1);
  await f.controller.show(f.controller.state!.review, 'recovery');
  await f.controller.recover(
    f.controller.state!.review,
    'abandon',
    f.controller.state!.recoveries[0].id,
  );
  const call = f.calls.at(-1)!;
  assert.equal(call.method, 'git-operations');
  assert.deepEqual(call.target, target);
  assert.deepEqual(call.params, { action: 'abandon', request: original.params });
  assert.equal(f.controller.state!.recoveries[0].receipt!.phase, 'abandoned');
  assert.equal(
    await readSecureGitExecutionBlock(f.storage, f.state.context.target!, current),
    null,
  );
  assert.equal(actions(f).length, 1);
});

test('offline reopen exposes cached state without remote request and connection ABA hides it synchronously', async () => {
  const f = await pending();
  f.controller.close();
  f.state.context.online = false;
  f.state.context.generation++;
  const before = f.calls.length;
  await f.controller.open(target, { newSession: true });
  assert.equal(f.calls.length, before);
  await assert.rejects(f.controller.recover(f.controller.state!.review, 'inspect'), /离线/);
  const old = f.controller.state!.review;
  f.state.context.online = true;
  f.state.context.generation++;
  assert.equal(f.controller.state, null);
  f.state.context.online = false;
  f.state.context.generation++;
  assert.equal(f.controller.state, null);
  await assert.rejects(f.controller.recover(old, 'inspect'), /已改变/);
  assert.equal(f.calls.length, before);
});

for (const event of ['close', 'target', 'generation'] as const)
  test(`late Git preparation after ${event} cannot save or dispatch`, async () => {
    const f = await opened(),
      entered = signal(),
      release = signal();
    f.state.beforeWrite = async () => {
      entered.resolve();
      await release.promise;
    };
    const operation = prepare(f);
    await entered.promise;
    if (event === 'close') f.controller.close();
    if (event === 'target') f.state.context.target!.hostDeviceId = 'other-host';
    if (event === 'generation') f.state.context.generation += 2;
    release.resolve();
    await assert.rejects(operation, /已改变/);
    assert.equal(actions(f).length, 0);
  });

test('closing during receipt response preserves original pending and discards late Host result', async () => {
  const f = await opened(),
    entered = signal(),
    release = signal();
  f.state.beforeResponse = async (method) => {
    if (method === 'git-action') {
      entered.resolve();
      await release.promise;
    }
  };
  const operation = prepare(f);
  await entered.promise;
  const saved = (await f.storage.read(target, key(), current)) as any;
  assert(saved.pending);
  f.controller.close();
  release.resolve();
  await assert.rejects(operation, /已改变/);
  assert.deepEqual(await f.storage.read(target, key(), current), saved);
  assert.equal(f.state.prepared.length, 0);
});

test('closing at the durable stage checkpoint prevents the pending save and any Git dispatch', async () => {
  const f = await opened(),
    entered = signal(),
    release = signal();
  const compare = f.memory.compareAndSet.bind(f.memory);
  f.memory.compareAndSet = async (key, expected, value, stillCurrent) => {
    if ((value as any)?.records?.some((row: any) => row.value.pending)) {
      entered.resolve();
      await release.promise;
    }
    return compare(key, expected, value, stillCurrent);
  };
  const preparing = prepare(f);
  await entered.promise;
  f.controller.close();
  release.resolve();
  await assert.rejects(preparing, /已改变/);
  assert.equal(((await f.storage.read(target, key(), current)) as any).pending, undefined);
  assert.equal(actions(f).length, 0);
});

test('durable stage failure fails closed and a reopen only reads cache/state without replaying', async () => {
  const f = await opened(),
    compare = f.memory.compareAndSet.bind(f.memory);
  f.memory.compareAndSet = async (key, expected, value, stillCurrent) => {
    if ((value as any)?.records?.some((row: any) => row.value.pending))
      throw Error('Synthetic disk full');
    return compare(key, expected, value, stillCurrent);
  };
  await assert.rejects(prepare(f), /disk full/);
  assert.match(f.controller.state!.git.loadError, /未确认保存/);
  assert.equal(actions(f).length, 0);
  f.controller.close();
  f.memory.compareAndSet = compare;
  await f.controller.open(target, { newSession: true });
  assert.equal(f.controller.state!.git.pending, undefined);
  assert.equal(actions(f).length, 0);
});

test('late old recovery response after a new panel opens cannot alter the original row or the new panel', async () => {
  const f = await pending(undefined, true),
    entered = signal(),
    release = signal();
  f.state.beforeResponse = async (method) => {
    if (method === 'git-operations') {
      entered.resolve();
      await release.promise;
    }
  };
  const recovering = f.controller.recover(f.controller.state!.review, 'abandon');
  await entered.promise;
  const original = await f.storage.read(target, key(), current);
  f.controller.close();
  f.state.context.target!.sessionId = 'other-session';
  f.state.context.generation++;
  await f.controller.open(f.state.context.target!, { newSession: true });
  const newReview = f.controller.state!.review;
  release.resolve();
  await assert.rejects(recovering, /已改变/);
  assert.deepEqual(await f.storage.read(target, key(), current), original);
  assert.deepEqual(f.controller.state!.review, newReview);
  assert.equal(f.controller.state!.git.pending, undefined);
});

test('opening protects actions and navigation until the final callback barrier has settled', async () => {
  const f = fixture(),
    entered = signal(),
    release = signal();
  f.state.beforeRefresh = async () => {
    entered.resolve();
    await release.promise;
  };
  const opening = f.controller.open(target, { newSession: true });
  await entered.promise;
  assert.equal(f.controller.state!.git.loaded, true);
  assert.equal(f.controller.state!.opening, true);
  assert.equal(f.controller.state!.git.busy, true);
  await assert.rejects(prepare(f), /正在恢复/);
  await assert.rejects(f.controller.show(f.controller.state!.review, 'recovery'), /正在恢复/);
  await assert.rejects(f.controller.navigate(f.controller.state!.review, 'write'), /正在恢复/);
  release.resolve();
  await opening;
  assert.equal(f.controller.state!.working, false);
  await f.controller.navigate(f.controller.state!.review, 'write');
  assert.deepEqual(f.state.navigations, ['write']);
});

test('two pages share execution lock and CAS; a competing old review cannot stage a second action', async () => {
  const f = await opened(),
    other = f.create();
  await other.open(target, { newSession: true });
  // Reopen first so its durable revision is current before taking the execution lock.
  f.controller.close();
  await f.controller.open(target, { newSession: true });
  const entered = signal(),
    release = signal();
  f.state.beforeWrite = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = prepare(f);
  await entered.promise;
  const second = assert.rejects(
    other.prepare(other.state!.review, 'main', oid, 'feature/other'),
    /已改变|其他页面|保存/,
  );
  release.resolve();
  await first;
  await second;
  assert.equal(actions(f).length, 1);
});

test('manual recovery bypasses new-write blocker and CAS conflict never overwrites another record', async () => {
  const f = await pending(undefined, true),
    entered = signal(),
    release = signal();
  f.state.beforeWrite = async () => {
    throw Error('New execution is blocked');
  };
  f.state.beforeResponse = async (method) => {
    if (method === 'git-operations') {
      entered.resolve();
      await release.promise;
    }
  };
  const inspection = f.controller.recover(f.controller.state!.review, 'abandon');
  await entered.promise;
  const raw = (await f.storage.read(target, key(), current)) as any;
  const next = { ...raw, cacheRevision: raw.cacheRevision + 1 };
  assert(await f.storage.compareWrite(target, key(), raw.cacheRevision, next, current));
  release.resolve();
  await assert.rejects(inspection, /其他页面/);
  assert.deepEqual(await f.storage.read(target, key(), current), next);
  assert.equal(f.state.writes, 1);
});

test('corrupt full-scope rows fail closed without consulting legacy storage', async () => {
  const f = await opened();
  const raw = (await f.storage.read(target, key(), current)) as any;
  await f.storage.compareWrite(
    target,
    key(),
    raw.cacheRevision,
    { ...raw, cacheRevision: raw.cacheRevision + 1, state: { ...raw.state, sessionId: 'wrong' } },
    current,
  );
  await assert.rejects(readSecureGitExecutionBlock(f.storage, target, current));
  f.controller.close();
  await assert.rejects(f.controller.open(target, { newSession: true }));
  assert.equal(actions(f).length, 0);
  const fresh = fixture();
  fresh.memory.values.set(key(), raw);
  fresh.state.context.online = false;
  await fresh.controller.open(target, { newSession: true });
  assert.equal(fresh.controller.state!.git.state, undefined);
});

test('resource cleanup uses explicit child target while preserving parent context and original source proof', async () => {
  const f = fixture(),
    child = { ...target, sessionId: 'child' },
    source = { ...target, product: { ...target.product!, projectId: 'original-product' } };
  const host = f.hostState(child);
  host.execution = {
    mode: 'worktree',
    status: 'ready',
    revision: 2,
    executionId: 'fork-execution',
    branch: 'feature/fork',
    baseOid: oid,
  };
  host.canPrepare = false;
  host.canRemove = true;
  await f.controller.open(child, {
    newSession: false,
    resource: { parentTarget: target, childSessionId: child.sessionId, sourceTarget: source },
  });
  assert.equal(f.controller.state!.target.sessionId, 'child');
  assert.equal(f.controller.state!.review.contextTarget.sessionId, target.sessionId);
  await f.controller.remove(f.controller.state!.review);
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.resourceWrites, 1);
  assert.deepEqual(actions(f)[0].target, child);
  assert.deepEqual(actions(f)[0].resource, { parent: target, childId: 'child', source });
  assert.equal(f.state.context.target!.sessionId, target.sessionId);
  assert.equal(f.state.refreshed.at(-1)!.target.sessionId, 'child');
  assert.equal(f.state.refreshed.at(-1)!.state.execution.status, 'removed');
  await assert.rejects(prepare(f), /已确认结束/);
});

test('resource old-mapping recovery retains original child Git target and original Fork source target', async () => {
  const f = fixture(),
    child = { ...target, sessionId: 'child' };
  const host = f.hostState(child);
  host.execution = {
    mode: 'worktree',
    status: 'ready',
    revision: 1,
    executionId: 'fork-execution',
  };
  host.canPrepare = false;
  host.canRemove = true;
  await f.controller.open(child, {
    newSession: false,
    resource: { parentTarget: target, childSessionId: 'child' },
  });
  f.state.unseen = true;
  await assert.rejects(f.controller.remove(f.controller.state!.review));
  const original = structuredClone(actions(f)[0]);
  changeMapping(f);
  const parent = f.state.context.target!;
  await f.controller.open(
    { ...parent, sessionId: 'child' },
    {
      newSession: false,
      resource: { parentTarget: parent, childSessionId: 'child', sourceTarget: target },
    },
  );
  await f.controller.show(f.controller.state!.review, 'recovery');
  await f.controller.recover(
    f.controller.state!.review,
    'abandon',
    f.controller.state!.recoveries[0].id,
  );
  const call = f.calls.at(-1)!;
  assert.deepEqual(call.target, child);
  assert.deepEqual(call.params.request, original.params);
  assert.deepEqual(call.resource!.source, target);
  assert.equal(actions(f).length, 1);
});

for (const field of [
  'origin',
  'owner',
  'rootKeyId',
  'clientDeviceId',
  'hostDeviceId',
  'workspaceId',
  'localProjectId',
  'userId',
  'machineId',
  'sessionId',
] as const)
  test(`durable Git records are isolated by ${field}`, async () => {
    const f = await pending(),
      next = structuredClone(target);
    next[field] =
      field === 'origin'
        ? 'https://other.synthetic.invalid'
        : field === 'rootKeyId'
          ? Buffer.alloc(32, 1).toString('base64url')
          : 'other';
    assert.equal(await readSecureGitExecutionBlock(f.storage, next, current), null);
  });
