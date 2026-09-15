import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readSecureForkChild,
  readSecureForkExecutionBlock,
  readSecureForkResource,
  readSecureForkOperation,
} from '../../apps/web/src/features/fork/secure-fork';
import { sessionForkKey } from '../../apps/web/src/features/fork/session-fork';
import { secureGitTarget } from '../../apps/web/src/platform/secure-scoped-storage';
import { secureForkFixture, forkOid, forkSignal } from '../fixtures/secure-fork-fixture';

const view = { sourceTitle: 'Synthetic source', turnId: 'finished' };
const worktree = {
  kind: 'worktree' as const,
  baseBranch: 'main',
  expectedOid: forkOid,
  newBranch: 'feature/reviewed-fork',
};
test('trusted native Fork reviews current or completed cutoff and full baseline before one durable action; options never persist', async () => {
  const f = secureForkFixture(),
    c = f.create();
  await c.open(f.target, view);
  assert.equal(c.state!.controller.source, 'host');
  await c.prepare(c.state!.review, { kind: 'turn', turnId: 'finished' }, worktree);
  assert.equal(f.calls.filter((call) => call.method === 'fork-action').length, 0);
  await c.confirm(c.state!.review);
  const action = f.calls.find((call) => call.method === 'fork-action')!;
  assert.deepEqual(action.params.cutoff, { kind: 'turn', turnId: 'finished' });
  assert.deepEqual(action.params.directory, worktree);
  assert.notEqual(action.params.childSessionId, f.target.sessionId);
  assert.equal(f.children.length, 0, 'receipt does not navigate until an explicit action');
  await c.openChild(c.state!.review);
  assert.equal(f.children.length, 1);
  assert.equal(
    (await readSecureForkChild(f.storage, f.target, action.params.childSessionId, () => {})).receipt
      .phase,
    'accepted',
  );
  assert.equal(
    JSON.stringify([...f.memory.values.values()]).includes('Synthetic <img src=x> Agent'),
    false,
  );
  const raw = (await f.storage.read(
    f.target,
    sessionForkKey(secureGitTarget(f.target)),
    () => {},
  )) as any;
  assert.equal(raw.options, undefined);
  await c.prepare(c.state!.review, { kind: 'current' }, { kind: 'same-directory' });
  await c.confirm(c.state!.review);
  assert.equal(f.calls.at(-1)!.params.cutoff.kind, 'current');
  assert.equal(f.calls.at(-1)!.params.directory.kind, 'same-directory');
});

test('changing a full reviewed option with unchanged source version rejects final Fork before dispatch', async () => {
  const f = secureForkFixture(),
    c = f.create();
  await c.open(f.target, view);
  await c.prepare(c.state!.review, { kind: 'current' }, { kind: 'same-directory' });
  f.options.agent.name = 'Different reviewed agent label';
  await assert.rejects(c.confirm(c.state!.review), /完整 Fork 选项已改变/);
  assert.equal(f.controls.nativeCalls, 0);
  assert.equal(c.state!.controller.operation, undefined);
});

test('unknown Fork blocks both source and reserved child across mappings; read-only inspect never sends fork-action', async () => {
  const f = secureForkFixture(),
    c = f.create();
  await c.open(f.target, view);
  await c.prepare(c.state!.review, { kind: 'turn', turnId: 'finished' }, worktree);
  f.controls.loseAction = true;
  await assert.rejects(c.confirm(c.state!.review), /lost/);
  const original = c.state!.controller.pending!.request,
    originalCalls = f.calls.length;
  assert.match((await readSecureForkExecutionBlock(f.storage, f.target, () => {}))!, /待确认/);
  const child = {
    ...f.target,
    sessionId: original.childSessionId,
    product: { ...f.target.product!, revision: 2 },
  };
  assert.match((await readSecureForkExecutionBlock(f.storage, child, () => {}))!, /待确认/);
  c.close();
  await c.open(f.target, view);
  assert.equal(f.calls.length, originalCalls, 'reopen only reads durable original records');
  await c.recover(c.state!.review, 'inspect');
  assert.equal(f.calls.at(-1)!.method, 'fork-operations');
  assert.equal(f.calls.filter((call) => call.method === 'fork-action').length, 1);
  assert.equal(f.controls.nativeCalls, 1);
  assert.equal(c.state!.controller.receipt!.phase, 'accepted');
  assert.equal(await readSecureForkExecutionBlock(f.storage, child, () => {}), null);
});

test('manual same-mapping retry preserves the original body, while old mapping records expose only original inspect and abandon', async () => {
  const f = secureForkFixture(),
    c = f.create();
  await c.open(f.target, view);
  await c.prepare(c.state!.review, { kind: 'current' }, worktree);
  f.controls.loseAction = true;
  await assert.rejects(c.confirm(c.state!.review));
  const original = c.state!.controller.pending!.request;
  f.controls.loseAction = false;
  await c.retry(c.state!.review);
  assert.deepEqual(
    f.calls.filter((call) => call.method === 'fork-action').map((call) => call.params),
    [original, original],
  );
  assert.equal(f.controls.nativeCalls, 1);
  await c.prepare(c.state!.review, { kind: 'current' }, worktree);
  f.controls.loseAction = true;
  await assert.rejects(c.confirm(c.state!.review));
  const pending = c.state!.controller.pending!.request;
  const moved = { ...f.target, product: { ...f.target.product!, revision: 2 } };
  f.setContext({ target: moved, online: true, generation: 2 });
  c.sync();
  await c.open(moved, view);
  assert.equal(c.state!.recoveries.length, 1);
  await c.recover(c.state!.review, 'inspect', c.state!.recoveries[0].id);
  assert.deepEqual(f.calls.at(-1)!.target, f.target);
  assert.deepEqual(f.calls.at(-1)!.params.request, pending);
  assert.equal(f.calls.at(-1)!.method, 'fork-operations');
});

test('abandon intent is durable before IPC, failed receipts cannot clear it, and abandoned worktrees remain available for explicit cleanup', async () => {
  const f = secureForkFixture(),
    c = f.create();
  await c.open(f.target, view);
  await c.prepare(c.state!.review, { kind: 'current' }, worktree);
  f.controls.phase = 'unknown';
  await assert.rejects(c.confirm(c.state!.review));
  const original = c.state!.controller.pending!.request;
  const entered = forkSignal(),
    finish = forkSignal();
  f.controls.beforeRecovery = async () => {
    entered.resolve();
    await finish.promise;
  };
  const abandoning = c.recover(c.state!.review, 'abandon');
  await entered.promise;
  assert.equal(
    ((await f.storage.read(f.target, sessionForkKey(secureGitTarget(f.target)), () => {})) as any)
      .ending,
    true,
  );
  assert.equal(c.state!.working, true);
  f.controls.corruptRecovery = true;
  finish.resolve();
  await assert.rejects(abandoning, /核查不匹配/);
  await assert.rejects(c.retry(c.state!.review), /封存/);
  f.controls.beforeRecovery = undefined;
  f.controls.corruptRecovery = false;
  await c.recover(c.state!.review, 'abandon');
  const resource = await readSecureForkResource(
    f.storage,
    f.target,
    original.childSessionId,
    () => {},
  );
  assert.equal(resource.receipt.phase, 'abandoned');
  await c.openWorkspace(c.state!.review, original.childSessionId);
  assert.equal(f.directories.length, 1);
  await assert.rejects(
    readSecureForkChild(f.storage, f.target, original.childSessionId, () => {}),
    /尚未确认/,
  );
  await c.prepare(c.state!.review, { kind: 'current' }, { kind: 'same-directory' });
  f.controls.phase = 'accepted';
  await c.confirm(c.state!.review);
  assert.equal(c.state!.controller.resources[0].receipt.phase, 'abandoned');
  const execution = resource.receipt.execution!;
  await c.confirmResourceCleanup(
    f.target,
    original.childSessionId,
    {
      gitVersion: 1,
      workspaceId: f.target.workspaceId,
      localProjectId: f.target.localProjectId,
      sessionId: original.childSessionId,
      confirmed: true,
      execution: { ...execution, status: 'removed', revision: execution.revision + 1 },
      repository: f.options.repository!,
      canPrepare: false,
      canRemove: false,
    },
    () => {},
  );
  await assert.rejects(
    readSecureForkResource(f.storage, f.target, original.childSessionId, () => {}),
    /尚未确认/,
  );
});

test('saving/opening are synchronously busy, stale read callbacks and connection ABA cannot stage or replace a new panel review', async () => {
  const f = secureForkFixture(),
    c = f.create(),
    entered = forkSignal(),
    finish = forkSignal();
  f.controls.beforeOptions = async () => {
    entered.resolve();
    await finish.promise;
  };
  const opening = c.open(f.target, view);
  await entered.promise;
  assert.equal(c.state!.opening, true);
  await assert.rejects(c.prepare(c.state!.review, { kind: 'current' }, worktree), /等待/);
  const oldReview = c.state!.review;
  f.setContext({ target: f.target, online: false, generation: 2 });
  c.sync();
  f.setContext({ target: f.target, online: true, generation: 3 });
  c.sync();
  f.controls.beforeOptions = undefined;
  await c.open(f.target, view);
  await c.prepare(c.state!.review, { kind: 'current' }, { kind: 'same-directory' });
  const plan = structuredClone(c.state!.plan);
  finish.resolve();
  await assert.rejects(opening, /身份已改变/);
  assert.deepEqual(c.state!.plan, plan);
  await assert.rejects(c.confirm(oldReview), /身份已改变|已改变/);
  assert.equal(f.controls.nativeCalls, 0);
});

test('a cross-page original operation is not overwritten by a stale final review or stale recovery', async () => {
  const f = secureForkFixture(),
    first = f.create(),
    second = f.create();
  await first.open(f.target, view);
  await first.prepare(first.state!.review, { kind: 'current' }, { kind: 'same-directory' });
  const firstReview = first.state!.review;
  await second.open(f.target, view);
  await second.prepare(second.state!.review, { kind: 'current' }, worktree);
  f.controls.loseAction = true;
  await assert.rejects(second.confirm(second.state!.review));
  await assert.rejects(first.confirm(firstReview), /待确认/);
  assert.equal(f.controls.nativeCalls, 1);
});

test('a never-dispatched original Fork stays pending after read-only not-found and can be explicitly sealed without native calls', async () => {
  const f = secureForkFixture(),
    c = f.create();
  await c.open(f.target, view);
  await c.prepare(c.state!.review, { kind: 'current' }, { kind: 'same-directory' });
  f.controls.beforeAction = async () => {
    throw Error('Synthetic transport failed before Host');
  };
  await assert.rejects(c.confirm(c.state!.review), /before Host/);
  const original = c.state!.controller.pending!.request;
  await c.recover(c.state!.review, 'inspect');
  assert.deepEqual(c.state!.controller.pending!.request, original);
  assert.match(c.state!.notice, /尚无/);
  assert.equal(f.journal.size, 0);
  await c.recover(c.state!.review, 'abandon');
  assert.equal(c.state!.controller.receipt!.phase, 'abandoned');
  assert.equal(f.controls.nativeCalls, 0);
  assert.equal(f.calls.filter((call) => call.method === 'fork-action').length, 1);
});

test('a closed original action cannot clear a replacement panel plan or append its late receipt', async () => {
  const f = secureForkFixture(),
    c = f.create(),
    entered = forkSignal(),
    finish = forkSignal();
  await c.open(f.target, view);
  await c.prepare(c.state!.review, { kind: 'current' }, { kind: 'same-directory' });
  f.controls.beforeAction = async () => {
    entered.resolve();
    await finish.promise;
  };
  const creating = c.confirm(c.state!.review);
  await entered.promise;
  c.close();
  const other = { ...f.target, sessionId: 'another-source' };
  f.setContext({ target: other, online: true, generation: 2 });
  f.controls.beforeAction = undefined;
  await c.open(other, view);
  await c.prepare(c.state!.review, { kind: 'current' }, worktree);
  const expected = structuredClone(c.state!.plan);
  finish.resolve();
  await assert.rejects(creating, /已改变/);
  assert.deepEqual(c.state!.plan, expected);
  assert.equal(c.state!.controller.operation, undefined);
  assert.equal(f.controls.nativeCalls, 0);
});

test('resource cleanup under a new reviewed mapping updates only the original Fork ledger and reports the current display target', async () => {
  const f = secureForkFixture(),
    c = f.create();
  await c.open(f.target, view);
  await c.prepare(c.state!.review, { kind: 'current' }, worktree);
  f.controls.phase = 'unknown';
  await assert.rejects(c.confirm(c.state!.review));
  await c.recover(c.state!.review, 'abandon');
  const original = c.state!.controller.operation!,
    receipt = c.state!.controller.receipt!,
    execution = receipt.execution!;
  const moved = { ...f.target, product: { ...f.target.product!, revision: 2 } };
  f.setContext({ target: moved, online: true, generation: 2 });
  c.sync();
  await c.open(moved, view);
  await c.confirmResourceCleanup(
    f.target,
    receipt.childSessionId,
    {
      gitVersion: 1,
      workspaceId: f.target.workspaceId,
      localProjectId: f.target.localProjectId,
      sessionId: receipt.childSessionId,
      confirmed: true,
      execution: { ...execution, status: 'removed', revision: execution.revision + 1 },
      repository: f.options.repository!,
      canPrepare: false,
      canRemove: false,
    },
    () => {},
  );
  const oldRaw = (await f.storage.read(
    f.target,
    sessionForkKey(secureGitTarget(f.target)),
    () => {},
  )) as any;
  const newRaw = (await f.storage.read(
    moved,
    sessionForkKey(secureGitTarget(moved)),
    () => {},
  )) as any;
  assert.deepEqual(oldRaw.operation, original);
  assert.equal(oldRaw.cleanup.status, 'removed');
  assert.equal(newRaw.operation, undefined);
  assert.deepEqual(f.changed.at(-1), moved);
});

test('pending Fork records never cross account, device, execution project or unrelated session identities', async () => {
  const f = secureForkFixture(),
    c = f.create();
  await c.open(f.target, view);
  await c.prepare(c.state!.review, { kind: 'current' }, { kind: 'same-directory' });
  f.controls.loseAction = true;
  await assert.rejects(c.confirm(c.state!.review));
  for (const [key, value] of Object.entries({
    origin: 'https://another.synthetic.invalid',
    owner: 'another-owner',
    rootKeyId: 'B'.repeat(42) + 'A',
    clientDeviceId: 'another-client',
    hostDeviceId: 'another-host',
    workspaceId: 'another-workspace',
    localProjectId: 'another-project',
    userId: 'another-user',
    machineId: 'another-machine',
    sessionId: 'unrelated-session',
  })) {
    assert.equal(
      await readSecureForkExecutionBlock(f.storage, { ...f.target, [key]: value }, () => {}),
      null,
      key,
    );
  }
});

test('accepted child directory cleanup retains its exact navigation proof and readonly parent-operation proof', async () => {
  const f = secureForkFixture(),
    c = f.create();
  await c.open(f.target, view);
  await c.prepare(c.state!.review, { kind: 'current' }, worktree);
  await c.confirm(c.state!.review);
  const original = structuredClone(c.state!.controller.operation!),
    accepted = structuredClone(c.state!.controller.receipt!),
    childId = accepted.childSessionId;
  const proof = await readSecureForkOperation(f.storage, f.target, childId, () => {});
  assert.deepEqual(proof, original);
  proof.request.operationId = 'mutated-return-copy';
  assert.deepEqual(await readSecureForkOperation(f.storage, f.target, childId, () => {}), original);
  await assert.rejects(
    readSecureForkOperation(f.storage, f.target, 'unrelated-child', () => {}),
    /不属于/,
  );
  const calls = f.calls.length;
  await c.confirmResourceCleanup(
    f.target,
    childId,
    {
      gitVersion: 1,
      workspaceId: f.target.workspaceId,
      localProjectId: f.target.localProjectId,
      sessionId: childId,
      confirmed: true,
      repository: f.options.repository!,
      execution: {
        ...accepted.execution!,
        status: 'removed',
        disposition: 'removed',
        revision: accepted.execution!.revision + 1,
      },
      canPrepare: false,
      canRemove: false,
    },
    () => {},
  );
  assert.equal(f.calls.length, calls);
  assert.deepEqual(
    (await readSecureForkChild(f.storage, f.target, childId, () => {})).receipt,
    accepted,
  );
  await assert.rejects(
    readSecureForkResource(f.storage, f.target, childId, () => {}),
    /尚未确认/,
  );
  await c.open(f.target, view);
  assert.equal(c.state!.controller.cleanup!.disposition, 'removed');
  assert.equal(c.state!.controller.receipt!.phase, 'accepted');
});
