import test from 'node:test';
import assert from 'node:assert/strict';
import { SecureScopedStorage, secureGitTarget } from '../src/web/secure-scoped-storage';
import { SecureStore, type SecureStorageBackend } from '../src/web/secure-store';
import { gitWorkspaceKey } from '../src/web/git-workspace';
import type { SecureCliTarget } from '../src/cli/secure-operation';
import { SecureRunOptionsStore } from '../src/web/secure-run-options';

const target: SecureCliTarget = {
  origin: 'https://synthetic.invalid',
  owner: 'owner',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'runtime',
  localProjectId: 'project',
  userId: 'user',
  machineId: 'machine',
  sessionId: 'session',
  product: {
    catalogWorkspaceId: 'catalog',
    projectId: 'logical-project',
    replicaId: 'replica',
    revision: 1,
  },
};
const key = (t = target) =>
  gitWorkspaceKey(secureGitTarget(t)).replace('git-workspace-v1/', 'github-write-v1/');
const row = (t = target, cacheRevision = 1) => ({
  version: 1,
  cacheRevision,
  target: secureGitTarget(t),
  drafts: {},
});
const current = () => {};
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Memory implements SecureStorageBackend {
  values = new Map<string, unknown>();
  locks = new Map<string, Promise<void>>();
  reads = 0;
  async read(key: string) {
    this.reads++;
    return structuredClone(this.values.get(key) ?? null);
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    current();
    assert.deepEqual(this.values.get(key) ?? null, expected);
    this.values.set(key, structuredClone(value));
  }
  async exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve(),
      done = signal();
    this.locks.set(key, done.promise);
    try {
      await previous;
      current();
      return await task();
    } finally {
      done.resolve();
      if (this.locks.get(key) === done.promise) this.locks.delete(key);
    }
  }
}
function fixture() {
  const memory = new Memory(),
    store = new SecureScopedStorage(new SecureStore(memory));
  return { memory, store };
}

test('model drafts isolate full identity, preserve obsolete choices and reject stale writes', async () => {
  const { store } = fixture(),
    options = new SecureRunOptionsStore(store);
  const initial = await options.read(target, 'turn', { modelId: 'old-model' }, current);
  assert.equal(initial.inherited, true);
  const saved = await options.save(
    target,
    initial,
    { modelId: 'obsolete-model', reasoningEffort: 'legacy' },
    current,
  );
  assert.equal(saved.inherited, false);
  assert.deepEqual((await options.read(target, 'turn', {}, current)).selection, saved.selection);
  await assert.rejects(options.save(target, initial, {}, current), /另一页面/);
  for (const changed of [
    { ...target, hostDeviceId: 'other-host' },
    { ...target, sessionId: 'other-session' },
    { ...target, localProjectId: 'other-project' },
    { ...target, owner: 'other-account' },
  ]) {
    assert.deepEqual((await options.read(changed, 'turn', {}, current)).selection, {});
  }
  const nextTurn = await options.read(target, 'next-turn', { modelId: 'from-history' }, current);
  assert.equal(nextTurn.inherited, true);
  assert.deepEqual(nextTurn.selection, { modelId: 'from-history' });
});

test('extension records are isolated from legacy cache and all complete target dimensions', async () => {
  const { memory, store } = fixture();
  memory.values.set(key(), row());
  assert.equal(await store.read(target, key(), current), undefined);
  await store.compareWrite(target, key(), 0, row(), current);
  const variations: SecureCliTarget[] = [
    ...[
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
    ].map((field) => ({
      ...target,
      [field]:
        field === 'origin'
          ? 'https://other.invalid'
          : field === 'rootKeyId'
            ? Buffer.alloc(32, 2).toString('base64url')
            : 'other',
    })),
    ...['catalogWorkspaceId', 'projectId', 'replicaId', 'revision'].map((field) => ({
      ...target,
      product: { ...target.product!, [field]: field === 'revision' ? 2 : 'other' },
    })),
  ];
  for (const other of variations)
    assert.equal(await store.read(other, key(other), current), undefined);
  assert.deepEqual(await store.read(target, key(), current), row());
  const next = { ...target, product: { ...target.product!, revision: 2 } };
  await store.compareWrite(next, key(next), 0, row(next), current);
  assert.equal(
    (await store.list(next, current)).length,
    2,
    'manual recovery can find original mappings without migrating rows',
  );
  assert.equal((await store.list({ ...target, sessionId: 'foreign' }, current)).length, 0);
});

test('cross-page extension CAS never overwrites a later draft and compares whole storage envelope', async () => {
  const { memory, store } = fixture(),
    other = new SecureScopedStorage(new SecureStore(memory));
  const results = await Promise.all([
    store.compareWrite(target, key(), 0, row(), current),
    other.compareWrite(target, key(), 0, row(), current),
  ]);
  assert.deepEqual(results.sort(), [false, true]);
  const adapter = store.forTarget(target, current);
  await assert.rejects(
    adapter.compareWrite(key(), 1, row(target, 2), () => false),
    /范围已改变/,
  );
  assert.deepEqual(await store.read(target, key(), current), row());
  await assert.rejects(store.compareWrite(target, key(), 1, row(target, 3), current), /版本不连续/);
});

test('extension storage rejects foreign keys, copied identities and conflicting pending targets before write', async () => {
  const { memory, store } = fixture();
  await assert.rejects(store.read(target, 'github-write-v1/foreign', current), /记录键/);
  assert.equal(memory.reads, 0);
  await assert.rejects(
    store.compareWrite(
      target,
      key(),
      0,
      { ...row(), target: secureGitTarget({ ...target, userId: 'foreign' }) },
      current,
    ),
    /内外执行身份/,
  );
  await assert.rejects(
    store.compareWrite(
      target,
      key(),
      0,
      { ...row(), pending: { target: secureGitTarget({ ...target, userId: 'foreign' }) } },
      current,
    ),
    /原执行身份/,
  );
  assert.equal(memory.values.size, 0);
  await store.compareWrite(target, key(), 0, row(), current);
  const [address, raw] = [...memory.values][0];
  const corrupt = structuredClone(raw) as any;
  corrupt.records[0].target.rootKeyId = Buffer.alloc(32, 3).toString('base64url');
  memory.values.set(address, corrupt);
  await assert.rejects(store.list(target, current), /身份或唯一性/);
});

test('runtime execution locks cover old mappings and cancel a queued scope without doing work', async () => {
  const { store } = fixture(),
    entered = signal(),
    release = signal();
  const holding = store.exclusive(target, 'execution', current, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let valid = true,
    called = false;
  const next = { ...target, product: { ...target.product!, revision: 2 } };
  const waiting = store.exclusive(
    next,
    'execution',
    () => {
      if (!valid) throw Error('scope changed');
    },
    async () => {
      called = true;
    },
  );
  const rejected = assert.rejects(waiting, /scope changed/);
  valid = false;
  release.resolve();
  await holding;
  await rejected;
  assert.equal(called, false);
});

test('Git and Fork rows retain original source identity while child lookup stays in the exact runtime project', async () => {
  const { store } = fixture();
  const child = { ...target, sessionId: 'child' };
  const mapped = { ...target, product: { ...target.product!, revision: 2 } };
  const address = (value: SecureCliTarget, prefix: string) =>
    gitWorkspaceKey(secureGitTarget(value)).replace('git-workspace-v1/', prefix);
  await store.compareWrite(target, address(target, 'session-fork-v1/'), 0, row(), current);
  await store.compareWrite(child, address(child, 'git-workspace-v1/'), 0, row(child), current);
  await store.compareWrite(mapped, address(mapped, 'session-fork-v1/'), 0, row(mapped), current);
  assert.equal((await store.list(child, current)).length, 1);
  assert.deepEqual(
    (await store.listProject(child, current)).map((record) => record.target),
    [target, child, mapped],
  );
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
  ]) {
    const other = {
      ...child,
      [field]:
        field === 'origin'
          ? 'https://other.invalid'
          : field === 'rootKeyId'
            ? Buffer.alloc(32, 2).toString('base64url')
            : 'foreign',
    };
    assert.equal((await store.listProject(other, current)).length, 0, field);
  }
  const foreign = { target: secureGitTarget(child) };
  for (const extra of [{ operation: foreign }, { resources: [{ operation: foreign }] }])
    await assert.rejects(
      store.compareWrite(
        target,
        address(target, 'session-fork-v1/'),
        1,
        { ...row(target, 2), ...extra },
        current,
      ),
      /原执行身份/,
    );
  assert.deepEqual(await store.read(target, address(target, 'session-fork-v1/'), current), row());
});
