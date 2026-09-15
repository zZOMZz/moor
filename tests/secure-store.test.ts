import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliState } from '../src/cli/state';
import {
  IndexedSecureStorage,
  SecureStore,
  secureBrowserRequestVersion,
  type SecureStorageBackend,
} from '../src/web/secure-store';
import {
  secureTargetSchema,
  secureOperationSchema,
  secureOriginal,
  type SecureCliTarget,
} from '../src/cli/secure-operation';

class TestOperationLocks {
  queues = new Map<string, Promise<void>>();
  queued?: (key: string) => void;
  async exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(key, tail);
    this.queued?.(key);
    try {
      await prior;
      current();
      return await task();
    } finally {
      release();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }
}
class Memory implements SecureStorageBackend {
  constructor(
    readonly locks: TestOperationLocks = new TestOperationLocks(),
    readonly values = new Map<string, unknown>(),
  ) {}
  exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T> {
    return this.locks.exclusive(key, current, task);
  }
  beforeCommit?: () => Promise<void>;
  async read(key: string) {
    return structuredClone(this.values.get(key) ?? null);
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    await this.beforeCommit?.();
    current();
    assert.deepEqual(this.values.get(key) ?? null, expected, 'CAS conflict');
    this.values.set(key, structuredClone(value));
  }
}
const target: SecureCliTarget = {
  origin: 'https://synthetic.invalid',
  owner: 'owner',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'runtime',
  localProjectId: 'local',
  userId: 'local-owner',
  machineId: 'machine',
  sessionId: 'session',
  product: { catalogWorkspaceId: 'space', projectId: 'project', replicaId: 'replica', revision: 1 },
};
const now = '2026-01-01T00:00:00.000Z';
const current = () => {};
function input(operationId = 'op', kind: 'create' | 'stop' = 'create') {
  return {
    operationId,
    kind,
    target: structuredClone(target),
    body:
      JSON.stringify(
        {
          method: 'session-control',
          workspaceId: target.workspaceId,
          localProjectId: target.localProjectId,
          params: {
            controlVersion: 1,
            operationId,
            workspaceId: target.workspaceId,
            localProjectId: target.localProjectId,
            userId: target.userId,
            machineId: target.machineId,
            sessionId: target.sessionId,
            action: kind,
            ...(kind === 'create' ? { agentId: 'agent' } : { turnId: 'active-turn' }),
          },
        },
        null,
        2,
      ) + '\n',
  };
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('browser ledger preserves exact original bytes and CLI-compatible digest across instances', async () => {
  const memory = new Memory(),
    store = new SecureStore(memory),
    original = input();
  const op = await store.stage(original, now, current);
  assert.equal(op.body, original.body);
  assert.equal(
    op.requestVersion,
    'sha256:' +
      createHash('sha256')
        .update(JSON.stringify(['mapped-command', secureTargetSchema.parse(target), original.body]))
        .digest('hex'),
  );
  assert.deepEqual(await new SecureStore(memory).list(target), [op]);
  original.target.product!.revision = 99;
  original.body = 'mutated';
  assert.deepEqual(await store.list(target), [op]);
  assert.deepEqual(await store.list({ ...target, owner: 'other' }), []);
  assert.deepEqual(await store.list({ ...target, clientDeviceId: 'other' }), []);
});

test('historical MCP and preview reviews stay digest-bound and CLI-compatible after their UI retires', async (t) => {
  const memory = new Memory(),
    store = new SecureStore(memory);
  const snapshot = {
    serviceId: 'service',
    serviceLabel: 'Synthetic preview',
    pagePath: '/',
    frameId: 'frame',
    capturedAt: now,
    viewport: { width: 390, height: 844 },
    element: {
      elementId: 'element',
      tagName: 'button',
      role: 'button',
      name: 'Save',
      text: 'Synthetic',
      bounds: { x: 0, y: 0, width: 100, height: 40 },
    },
    note: 'Original reviewed annotation',
  };
  const originalInput = {
    operationId: 'historical-turn',
    kind: 'turn' as const,
    target,
    userTurnId: 'original-user-turn',
    body: JSON.stringify({
      method: 'mutate',
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      params: {
        kind: 'turn',
        operationId: 'historical-turn',
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        expectedTurnId: null,
        update: 'c3ludGhldGlj',
        metaBundle: {},
      },
    }),
    mcpReview: {
      reviewId: 'original-review',
      servers: [
        {
          id: 'server',
          name: 'Synthetic MCP',
          description: 'Original metadata',
          transport: 'http' as const,
        },
      ],
    },
    previewReview: {
      annotations: [
        {
          id: 'annotation',
          createdAt: now,
          selectionId: 'original-selection',
          snapshot,
          version: 'sha256:' + createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
        },
      ],
    },
  };
  const original = await store.stage(originalInput, now, current);
  assert.deepEqual(await new SecureStore(memory).list(target), [original]);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-retired-review-'))),
    cli = new CliState(root);
  t.after(() => {
    cli.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(cli.secureStage(originalInput, now).requestVersion, original.requestVersion);
  assert.deepEqual(cli.secureOperation(original.operationId), original);
  assert.equal(secureOriginal(original).kind, 'mutation');
  for (const field of ['mcp', 'preview', 'turn'] as const) {
    const changed = structuredClone(originalInput);
    if (field === 'mcp') changed.mcpReview.servers[0]!.description = 'Changed metadata';
    if (field === 'preview')
      changed.previewReview.annotations[0]!.snapshot.note = 'Changed annotation';
    if (field === 'turn') changed.userTurnId = 'other-user-turn';
    assert.notEqual(await secureBrowserRequestVersion(changed), original.requestVersion);
    await assert.rejects(store.stage(changed, now, current));
    assert.throws(() => cli.secureStage(changed, now));
  }
  assert.equal(secureOperationSchema.safeParse({ ...original, kind: 'permission' }).success, false);
  assert.equal(
    secureOperationSchema.safeParse({ ...original, userTurnId: undefined }).success,
    false,
  );
  const entry = [...memory.values.entries()].find(([key]) =>
    key.includes('moor-secure-operations-v1'),
  )!;
  const corrupted = structuredClone(entry[1]) as { operations: (typeof original)[] };
  corrupted.operations[0]!.previewReview!.annotations[0]!.snapshot.note = 'Corrupted on disk';
  memory.values.set(entry[0], corrupted);
  await assert.rejects(store.list(target), /原操作校验失败/);
});

test('pending and ending ledger entries block new product revisions while exact stopping remains possible', async () => {
  const store = new SecureStore(new Memory()),
    original = await store.stage(input(), now, current);
  const changed = input('changed');
  changed.target.product!.revision = 2;
  await assert.rejects(store.stage(changed, now, current), /先核查/);
  await store.transition(original, ['pending'], 'ending', undefined, current);
  await assert.rejects(store.stage(changed, now, current), /先核查/);
  assert.equal((await store.stage(input('stop', 'stop'), now, current)).kind, 'stop');
  assert.equal(
    (await store.list(target)).find((op) => op.operationId === original.operationId)?.target.product
      ?.revision,
    1,
  );
});

test('concurrent pages cannot both stage competing original operations', async () => {
  const memory = new Memory(),
    barrier = signal();
  let commits = 0;
  memory.beforeCommit = async () => {
    if (++commits === 2) barrier.resolve();
    await barrier.promise;
  };
  const results = await Promise.allSettled([
    new SecureStore(memory).stage(input('one'), now, current),
    new SecureStore(memory).stage(input('two'), now, current),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await new SecureStore(memory).list(target)).length, 1);
});

test('generation invalidation before commit leaves no dispatchable original', async () => {
  const memory = new Memory(),
    entered = signal(),
    finish = signal();
  let active = true;
  memory.beforeCommit = async () => {
    entered.resolve();
    await finish.promise;
  };
  const store = new SecureStore(memory),
    staged = store.stage(input(), now, () => {
      if (!active) throw Error('stale');
    });
  await entered.promise;
  active = false;
  finish.resolve();
  await assert.rejects(staged, /stale/);
  assert.deepEqual(await store.list(target), []);
});

for (const change of ['body', 'target', 'hash'] as const)
  test(`tampered ${change} fails closed on reload`, async () => {
    const memory = new Memory(),
      store = new SecureStore(memory);
    await store.stage(input(), now, current);
    const [key, raw] = [...memory.values][0] as [string, { operations: any[] }];
    if (change === 'body')
      raw.operations[0].body = raw.operations[0].body.replace('agent', 'other');
    else if (change === 'target') raw.operations[0].target.product.revision++;
    else raw.operations[0].requestVersion = 'sha256:' + '0'.repeat(64);
    memory.values.set(key, raw);
    await assert.rejects(store.list(target));
  });

test('draft CAS protects concurrent edits and partitions all frozen execution identities', async () => {
  const memory = new Memory(),
    first = new SecureStore(memory),
    second = new SecureStore(memory);
  await first.saveDraft(target, '', 'original draft', current);
  assert.equal(await second.readDraft(target), 'original draft');
  await second.saveDraft(target, 'original draft', 'newer draft', current);
  await assert.rejects(first.saveDraft(target, 'original draft', '', current), /另一页面/);
  assert.equal(await first.readDraft(target), 'newer draft');
  for (const changed of [
    { ...target, sessionId: 'different' },
    { ...target, hostDeviceId: 'different' },
    { ...target, product: { ...target.product!, revision: 2 } },
  ])
    assert.equal(await first.readDraft(changed), '');
});

test('dispatch holds one shared operation lock across the digest await and actual send before ending may commit', async (t) => {
  const locks = new TestOperationLocks(),
    values = new Map<string, unknown>();
  const first = new SecureStore(new Memory(locks, values)),
    second = new SecureStore(new Memory(locks, values));
  const op = await first.stage(input(), now, current);
  const hashing = signal(),
    releaseHash = signal(),
    sealingQueued = signal(),
    sent = signal(),
    reply = signal();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let intercepted = false,
    queued = 0;
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<SubtleCrypto['digest']>) => {
    if (!intercepted) {
      intercepted = true;
      hashing.resolve();
      await releaseHash.promise;
    }
    return digest(...args);
  });
  locks.queued = () => {
    if (++queued === 2) sealingQueued.resolve();
  };
  const events: string[] = [];
  const dispatch = first.dispatch(op, current, async (original) => {
    assert.equal(original.body, op.body);
    events.push('send');
    sent.resolve();
    await reply.promise;
    events.push('reply');
    return 'host-result';
  });
  await hashing.promise;
  const ending = second.transition(op, ['pending'], 'ending', undefined, current).then((value) => {
    events.push('ending');
    return value;
  });
  await sealingQueued.promise;
  const raw = [...values.values()][0] as { operations: Array<{ state: string }> };
  assert.equal(raw.operations[0].state, 'pending');
  releaseHash.resolve();
  await sent.promise;
  assert.deepEqual(events, ['send']);
  assert.equal(([...values.values()][0] as typeof raw).operations[0].state, 'pending');
  reply.resolve();
  assert.equal(await dispatch, 'host-result');
  await ending;
  assert.deepEqual(events, ['send', 'reply', 'ending']);
  assert.equal((await first.list(target))[0].state, 'ending');
});

test('ending that acquires the shared lock first prevents a queued dispatch even with a stale pending object', async (t) => {
  const locks = new TestOperationLocks(),
    values = new Map<string, unknown>();
  const first = new SecureStore(new Memory(locks, values)),
    second = new SecureStore(new Memory(locks, values));
  const op = await first.stage(input(), now, current);
  const hashing = signal(),
    releaseHash = signal(),
    dispatchQueued = signal();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let intercepted = false,
    queued = 0,
    sends = 0;
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<SubtleCrypto['digest']>) => {
    if (!intercepted) {
      intercepted = true;
      hashing.resolve();
      await releaseHash.promise;
    }
    return digest(...args);
  });
  locks.queued = () => {
    if (++queued === 2) dispatchQueued.resolve();
  };
  const ending = second.transition(op, ['pending'], 'ending', undefined, current);
  await hashing.promise;
  const dispatch = first.dispatch(op, current, async () => {
    sends++;
  });
  const rejected = assert.rejects(dispatch, /原操作状态已改变/);
  await dispatchQueued.promise;
  releaseHash.resolve();
  await ending;
  await rejected;
  assert.equal(sends, 0);
  assert.equal((await first.list(target))[0].state, 'ending');
});

test('queued dispatch rechecks navigation/account generation when it finally acquires the lock', async () => {
  const locks = new TestOperationLocks(),
    values = new Map<string, unknown>();
  const first = new SecureStore(new Memory(locks, values)),
    second = new SecureStore(new Memory(locks, values));
  const op = await first.stage(input(), now, current),
    entered = signal(),
    release = signal(),
    queued = signal();
  let active = true,
    sends = 0,
    requests = 0;
  locks.queued = () => {
    if (++requests === 2) queued.resolve();
  };
  const dispatch = first.dispatch(op, current, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const stale = second.dispatch(
    op,
    () => {
      if (!active) throw Error('stale generation');
    },
    async () => {
      sends++;
    },
  );
  const rejected = assert.rejects(stale, /stale generation/);
  await queued.promise;
  active = false;
  release.resolve();
  await dispatch;
  await rejected;
  assert.equal(sends, 0);
});

for (const cause of ['deadline', 'close'] as const)
  test(`IndexedDB operation lock waiting is bounded by ${cause} and never starts the task`, async () => {
    const deadline = new AbortController(),
      requested = signal();
    let duration = 0,
      calls = 0;
    const locks = {
      request: ((_key: string, options: LockOptions) =>
        new Promise((_resolve, reject) => {
          const signal = options.signal!;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          if (signal.aborted) reject(signal.reason);
          requested.resolve();
        })) as LockManager['request'],
    };
    const backend = new IndexedSecureStorage({
      locks,
      deadline: (milliseconds) => {
        duration = milliseconds;
        return deadline.signal;
      },
    });
    const pending = backend.exclusive('synthetic-operation', current, async () => {
      calls++;
    });
    const rejected = assert.rejects(pending);
    await requested.promise;
    if (cause === 'deadline') deadline.abort(Error('synthetic deadline'));
    else backend.close();
    await rejected;
    assert.equal(duration, 30000);
    assert.equal(calls, 0);
  });

test('missing native Web Locks fails closed instead of using an unsafe per-window mutex', async () => {
  const backend = new IndexedSecureStorage({ locks: null });
  let calls = 0;
  await assert.rejects(
    backend.exclusive('synthetic-operation', current, async () => {
      calls++;
    }),
    /无法协调/,
  );
  assert.equal(calls, 0);
});
