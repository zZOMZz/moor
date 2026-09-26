import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Flock, LoroDoc, delta, mirror, putMeta, vv } from '@moor/session/model';
import { ClientSessionReplica } from '@moor/client/session-client';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import {
  WorkspaceStore,
  type WorkspaceScope,
} from '../../apps/web/src/features/workspace/workspace-store';
import type { StorageBackend, StorageChange } from '../../apps/web/src/platform/indexed-storage';

const scope: WorkspaceScope = {
  source: 'local',
  target: {
    serverKey: 'local:machine',
    owner: 'synthetic-owner',
    deviceId: 'device',
    userId: 'user',
    machineId: 'machine',
    workspaceId: 'workspace',
    localProjectId: 'project',
    catalogWorkspaceId: 'catalog',
    catalogProjectId: 'catalog-project',
    replicaId: 'replica',
  },
};
const sessionId = 'synthetic-session',
  current = () => {},
  bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value)),
  cacheKey = (...parts: unknown[]) =>
    canonical(['moor-workspace-session-cache-v2', scope, sessionId, ...parts]),
  checkpointKey = cacheKey('checkpoint');

/** Stages every write before publishing, including a failure after a staged deletion. */
class Memory implements StorageBackend {
  values = new Map<string, unknown>();
  batches: StorageChange[][] = [];
  failAfter?: number;
  locks = new Map<string, Promise<void>>();
  async read(key: string) {
    return structuredClone(this.values.get(key) ?? null);
  }
  async exclusive<T>(key: string, check: () => void, task: () => Promise<T>) {
    const previous = this.locks.get(key);
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(key, done);
    await previous;
    try {
      check();
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === done) this.locks.delete(key);
    }
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, check: () => void) {
    return this.compareAndSetMany([{ key, expected, value }], check);
  }
  async compareAndSetMany(changes: StorageChange[], check: () => void) {
    check();
    assert.equal(new Set(changes.map((change) => change.key)).size, changes.length);
    for (const change of changes)
      assert.deepEqual(this.values.get(change.key) ?? null, change.expected, 'CAS conflict');
    const staged = new Map(this.values);
    for (const [index, change] of changes.entries()) {
      if (change.delete) staged.delete(change.key);
      else staged.set(change.key, structuredClone(change.value));
      if (this.failAfter === index + 1) throw Error('Synthetic atomic transaction failure');
    }
    check();
    this.values = staged;
    this.batches.push(structuredClone(changes));
  }
}

function fixture(t: TestContext, settledTurns = 120) {
  const doc = new LoroDoc(),
    view = mirror(doc, sessionId),
    flock = new Flock(),
    memory = new Memory(),
    store = new WorkspaceStore(memory),
    replica = new ClientSessionReplica({ ...scope.target, sessionId });
  const meta = {
    id: sessionId,
    userId: scope.target.userId,
    machineId: scope.target.machineId,
    project: { kind: 'local' as const, localProjectId: scope.target.localProjectId },
    agentConfigId: 'agent',
    cliType: 'custom',
    agentType: 'synthetic',
    status: { type: 'working' },
  };
  view.setState((state) => {
    state.session.id = sessionId;
    for (let index = 0; index <= settledTurns; index++)
      state.history.push({
        id: 'turn-' + index,
        role: 'assistant',
        timestamp: '2026-09-26T00:00:00.000Z',
        finished: index < settledTurns,
        items: [{ type: 'text', text: `Synthetic history ${index}: ${noise(1024, index + 1)}` }],
        userId: undefined,
        userTurnId: undefined,
        status: undefined,
        read: undefined,
        inputConfig: undefined,
        fileDiff: null,
      });
  });
  doc.commit();
  putMeta(flock, 'session-' + sessionId, meta);
  const envelope = (update = delta(doc), persisted = true) => ({
    meta,
    metaBundle: flock.exportJson(),
    update,
    synced: true as const,
    online: true as const,
    persisted,
  });
  replica.read(envelope());
  let sequence = 0,
    checkpoints = 0;
  const advance = (text = 'Synthetic chunk ' + sequence, persisted = true) => {
    const before = vv(doc);
    sequence++;
    view.setState((state) => {
      state.history[settledTurns]!.items = [{ type: 'text', text }];
    });
    doc.commit();
    const response = envelope(delta(doc, before), persisted);
    replica.read(response);
    return response;
  };
  const cache = () =>
    store.cacheSessionDelta(scope, sessionId, replica.lastRead!, current, () => {
      checkpoints++;
      return replica.exportSnapshot();
    });
  const restored = async () => {
    const saved = await store.loadSessionCache(scope, sessionId, current);
    assert.ok(saved);
    const next = new ClientSessionReplica({ ...scope.target, sessionId });
    try {
      next.read(saved.checkpoint);
      for (const update of saved.deltas) next.read(update);
      return next.view!;
    } finally {
      next.dispose();
    }
  };
  t.after(() => {
    replica.dispose();
    view.dispose();
    doc.free();
  });
  return {
    doc,
    memory,
    store,
    replica,
    envelope,
    advance,
    cache,
    restored,
    checkpoints: () => checkpoints,
  };
}

/** Seeded varied text prevents compression from disguising checkpoint write amplification. */
function noise(length: number, seed: number) {
  let value = seed | 0;
  return Array.from({ length }, () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return String.fromCharCode(33 + ((value >>> 0) % 90));
  }).join('');
}

test('verified streaming deltas write two small records and replay without rewriting settled history', async (t) => {
  const f = fixture(t);
  await f.cache();
  const checkpoint = structuredClone(f.memory.values.get(checkpointKey)),
    checkpointBytes = bytes(checkpoint);
  assert.ok(checkpointBytes > 50000, 'the fixture contains a meaningful historical checkpoint');
  for (let index = 0; index < 30; index++) {
    f.advance('Synthetic incremental result ' + index);
    await f.cache();
    const batch = f.memory.batches.at(-1)!;
    assert.equal(batch.length, 2, 'only the head and new delta are written');
    assert.equal(
      batch.some((change) => change.key === checkpointKey),
      false,
    );
    assert.ok(bytes(batch.map((change) => change.value)) < checkpointBytes / 10);
  }
  assert.equal(f.checkpoints(), 1, 'normal streaming never requests a full CRDT export');
  assert.deepEqual(f.memory.values.get(checkpointKey), checkpoint);
  const saved = await f.store.loadSessionCache(scope, sessionId, current);
  assert.equal(saved?.deltas.length, 30);
  assert.deepEqual((await f.restored()).history, f.replica.view!.history);
  assert.equal((await f.restored()).version, f.replica.view!.version);
  assert.deepEqual(
    (await f.store.cachedSession(scope, sessionId, current))?.history,
    f.replica.view!.history,
  );
});

test('cache keys isolate every workspace target and reject raw, forged and wrong-scope deltas', async (t) => {
  const f = fixture(t, 1);
  await f.cache();
  for (const key of Object.keys(scope.target) as (keyof WorkspaceScope['target'])[]) {
    const other = { ...scope, target: { ...scope.target, [key]: scope.target[key] + '-other' } };
    assert.equal(await f.store.loadSessionCache(other, sessionId, current), null, key);
  }
  assert.equal(await f.store.loadSessionCache(scope, 'different-session', current), null);
  for (const invalid of [
    f.replica.lastRead!.response,
    { ...f.replica.lastRead! },
    structuredClone(f.replica.lastRead!),
  ])
    await assert.rejects(
      f.store.cacheSessionDelta(scope, sessionId, invalid as never, current, () =>
        f.replica.exportSnapshot(),
      ),
      /验证/,
    );
  for (const key of ['userId', 'machineId', 'workspaceId', 'localProjectId'] as const) {
    const other = { ...scope, target: { ...scope.target, [key]: scope.target[key] + '-other' } };
    await assert.rejects(
      f.store.cacheSessionDelta(other, sessionId, f.replica.lastRead!, current, () =>
        f.replica.exportSnapshot(),
      ),
      /范围|匹配|验证/,
    );
  }
  assert.equal(f.memory.batches.length, 1, 'rejected imports never mutate storage');
});

test('count compaction atomically replaces the checkpoint and deletes every old segment', async (t) => {
  const f = fixture(t, 2);
  await f.cache();
  for (let index = 1; index <= 64; index++) {
    f.advance('Before compaction ' + index);
    await f.cache();
  }
  assert.equal(f.checkpoints(), 1);
  const before = structuredClone(f.memory.values),
    oldView = await f.restored();
  f.advance('After compaction');
  f.memory.failAfter = 2;
  await assert.rejects(f.cache(), /atomic transaction failure/);
  assert.deepEqual(
    f.memory.values,
    before,
    'failure publishes neither new checkpoint nor deleted deltas',
  );
  assert.equal((await f.restored()).version, oldView.version);
  f.memory.failAfter = undefined;
  const subscribe = t.mock.method(LoroDoc.prototype, 'subscribe'),
    exportDoc = t.mock.method(LoroDoc.prototype, 'export');
  try {
    await f.cache();
    assert.equal(subscribe.mock.callCount(), 0, 'compaction does not materialize a history Mirror');
    assert.equal(exportDoc.mock.callCount(), 1, 'only the checkpoint factory exports CRDT bytes');
  } finally {
    subscribe.mock.restore();
    exportDoc.mock.restore();
  }
  const saved = await f.store.loadSessionCache(scope, sessionId, current);
  assert.equal(saved?.deltas.length, 0);
  assert.equal(f.memory.values.size, 2, 'only the head and compacted checkpoint remain');
  assert.ok(f.memory.batches.at(-1)!.some((change) => change.delete === true));
  assert.deepEqual((await f.restored()).history, f.replica.view!.history);
});

test('checkpoint verification rejects incomplete, corrupt, wrong-scope or mismatched content before cache replacement', async (t) => {
  const f = fixture(t, 2);
  await f.cache();
  for (let index = 0; index < 64; index++) {
    f.advance('Before verified checkpoint ' + index);
    await f.cache();
  }
  const previous = f.replica.exportSnapshot();
  f.advance('Captured confirmed checkpoint');
  const token = f.replica.lastRead!,
    confirmed = f.replica.view!,
    snapshot = f.replica.exportSnapshotAt(token),
    before = structuredClone(f.memory.values),
    batches = f.memory.batches.length;
  const missing = new LoroDoc(),
    wrong = new LoroDoc();
  t.after(() => {
    missing.free();
    wrong.free();
  });
  wrong.getMap('session').set('id', 'different-session');
  const invalid = [
    { ...snapshot, update: Buffer.from('corrupt synthetic checkpoint').toString('base64') },
    { ...snapshot, update: token.response.update },
    { ...snapshot, update: delta(missing) },
    { ...snapshot, update: delta(wrong) },
    previous,
    { ...snapshot, persisted: false },
    { ...snapshot, persistenceError: 'Host did not persist this checkpoint' },
    {
      ...snapshot,
      meta: { ...snapshot.meta, userId: 'different-user' },
      metaBundle: { ...snapshot.metaBundle, entries: {} },
    },
    {
      ...snapshot,
      metaBundle: {
        ...snapshot.metaBundle,
        entries: {
          ...snapshot.metaBundle.entries,
          '["m","session-other","title"]': { c: '1', d: 'outside' },
        },
      },
    },
  ];
  // A delayed checkpoint must still refer to the captured confirmed version,
  // even after the live replica has advanced to unconfirmed content.
  f.advance('Later unconfirmed text', false);
  for (const value of [...invalid, f.replica.exportSnapshot()]) {
    await assert.rejects(f.store.cacheSessionDelta(scope, sessionId, token, current, () => value));
    assert.equal(f.memory.batches.length, batches);
    assert.deepEqual(
      f.memory.values,
      before,
      'rejection leaves the checkpoint and delta chain intact',
    );
  }
  await f.store.cacheSessionDelta(scope, sessionId, token, current, () => snapshot);
  const restored = await f.restored();
  assert.equal(restored.version, token.version);
  assert.deepEqual(restored.history, confirmed.history);
  assert.equal((await f.store.loadSessionCache(scope, sessionId, current))?.deltas.length, 0);
});

test('unchanged reads do not consume cache segments while same-version metadata changes remain durable', async (t) => {
  const f = fixture(t, 1);
  await f.cache();
  const version = f.replica.view!.version;
  for (let index = 0; index < 70; index++) {
    f.replica.read(f.envelope(delta(f.doc, version)));
    assert.equal(await f.cache(), version);
  }
  assert.equal(f.memory.batches.length, 1, 'empty reads never force a checkpoint');
  assert.equal(f.checkpoints(), 1);
  const metadata = f.envelope(delta(f.doc, version));
  f.replica.read({
    ...metadata,
    meta: { ...metadata.meta, title: 'Updated title at the same document version' },
  });
  await f.cache();
  assert.equal(f.memory.batches.length, 2);
  const cached = await f.restored();
  assert.equal(cached.version, version);
  assert.equal(cached.meta.title, 'Updated title at the same document version');
});

test('cumulative envelope bytes compact before the segment count limit', async (t) => {
  const f = fixture(t, 1);
  await f.cache();
  let updates = 0;
  while (f.checkpoints() === 1 && updates < 30) {
    f.advance(noise(100000, ++updates));
    await f.cache();
  }
  assert.ok(
    updates > 1 && updates < 30,
    'byte budget triggers independently of the 64 segment budget',
  );
  assert.equal(f.checkpoints(), 2);
  assert.equal((await f.store.loadSessionCache(scope, sessionId, current))?.deltas.length, 0);
  assert.equal(f.memory.values.size, 2);
  assert.deepEqual((await f.restored()).history, f.replica.view!.history);
});

test('a missing segment cannot be mistaken for a complete cached session', async (t) => {
  const f = fixture(t, 1);
  await f.cache();
  f.advance();
  await f.cache();
  f.memory.values.delete(cacheKey('delta', 1));
  await assert.rejects(f.store.loadSessionCache(scope, sessionId, current));
});

test('a delayed window cannot replace a newer confirmed cache with its older verified read', async (t) => {
  const f = fixture(t, 1);
  await f.cache();
  f.advance('Older window result');
  const older = f.replica.lastRead!;
  await f.cache();
  f.advance('Newer confirmed result');
  await f.cache();
  const before = structuredClone(f.memory.values);
  await f.store.cacheSessionDelta(scope, sessionId, older, current, () => {
    throw Error('A stale window must not request a checkpoint');
  });
  assert.deepEqual(f.memory.values, before);
  assert.deepEqual((await f.restored()).history, f.replica.view!.history);
});

test('unpersisted reads preserve the offline checkpoint and force a full checkpoint across a gap', async (t) => {
  const f = fixture(t, 2);
  await f.cache();
  const before = structuredClone(f.memory.values);
  f.advance('Visible but not durable', false);
  await f.cache();
  assert.deepEqual(f.memory.values, before);
  assert.equal(f.checkpoints(), 1);
  f.advance('Durable again');
  await f.cache();
  assert.equal(
    f.checkpoints(),
    2,
    'a delta after an unpersisted base cannot append to the older cache',
  );
  assert.equal((await f.store.loadSessionCache(scope, sessionId, current))?.deltas.length, 0);
  assert.deepEqual((await f.restored()).history, f.replica.view!.history);
});

test('legacy v1 checkpoints remain readable and public full-cache writes stay compatible', async (t) => {
  const f = fixture(t, 2),
    legacy = canonical(['moor-desktop-session-v1', scope, sessionId]);
  f.memory.values.set(legacy, f.envelope());
  const saved = await f.store.loadSessionCache(scope, sessionId, current);
  assert.equal(saved?.deltas.length, 0);
  assert.deepEqual((await f.restored()).history, f.replica.view!.history);
  assert.equal(f.memory.batches.length, 0, 'legacy reads do not rewrite data');
  f.advance('New durable full snapshot');
  await f.store.cacheSession(scope, sessionId, f.replica.exportSnapshot(), current);
  const cached = await f.store.cachedSession(scope, sessionId, current);
  assert.ok(cached);
  assert.equal(
    'update' in cached,
    false,
    'cache readers receive a view without a full CRDT export',
  );
  assert.ok(Object.isFrozen(cached));
  assert.ok(Object.isFrozen(cached.history));
  assert.deepEqual(cached.history, f.replica.view!.history, 'history survives replica disposal');
  assert.equal(cached.version, f.replica.view!.version);
});
