import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentUsageCache } from '../src/agents/usage-cache';
import { agentUsageUpdateSchema, type AgentUsageUpdate } from '@moor/protocol/agent-usage';

const current = () => {};
const snapshot = (account = 'a', usedPercent = 40): AgentUsageUpdate => ({
  version: 1,
  sequence: 1,
  status: 'ready',
  accountKey: account.repeat(64),
  rateLimitsByLimitId: {
    codex: { primary: { usedPercent, windowDurationMins: 300, resetsAt: 2000 } },
    extra: { secondary: { usedPercent: 70, windowDurationMins: 10080 } },
  },
});
test('quota reads coalesce, respect TTL and explicit refresh, and isolate scopes', async () => {
  let now = 1000,
    calls = 0,
    release!: (v: AgentUsageUpdate) => void;
  const cache = new AgentUsageCache(() => now);
  const load = () => {
    calls++;
    return new Promise<AgentUsageUpdate>((yes) => {
      release = yes;
    });
  };
  const a = cache.read('scope-a', load, current),
    b = cache.read('scope-a', load, current);
  await Promise.resolve();
  assert.equal(calls, 1);
  release(snapshot());
  assert.deepEqual(await a, await b);
  assert.equal((await a).buckets.length, 2);
  assert.equal(cache.peek('scope-b').status, 'unknown');
  const instant = async () => {
    calls++;
    return snapshot();
  };
  now += 59999;
  await cache.read('scope-a', instant, current);
  assert.equal(calls, 1);
  now++;
  await cache.read('scope-a', instant, current);
  assert.equal(calls, 2);
  await cache.read('scope-a', instant, current, true);
  assert.equal(calls, 3);
});
test('account switches discard every old bucket and suppress late reads', async () => {
  const cache = new AgentUsageCache(() => 1000);
  cache.update('a', snapshot());
  cache.update('a', { version: 1, sequence: 2, status: 'unknown', accountKey: 'a'.repeat(64) });
  assert.equal(
    cache.peek('a').status,
    'ready',
    'opening a session on the same account preserves quota',
  );
  cache.update('a', { version: 1, sequence: 3, status: 'unknown', accountKey: 'b'.repeat(64) });
  assert.deepEqual(
    cache.peek('a').buckets,
    [],
    'startup on another account clears the old account immediately',
  );
  cache.update('a', snapshot());
  let release!: (v: AgentUsageUpdate) => void;
  const read = cache.read(
    'a',
    () =>
      new Promise((yes) => {
        release = yes;
      }),
    current,
    true,
  );
  await Promise.resolve();
  cache.update('a', { version: 1, sequence: 2, status: 'unknown' });
  release(snapshot());
  assert.equal((await read).status, 'unknown');
  let calls = 0;
  await cache.read(
    'a',
    async () => {
      calls++;
      return snapshot('b', 12);
    },
    current,
  );
  assert.equal(calls, 1, 'account invalidation bypasses the previous TTL');
  cache.update('a', {
    version: 1,
    sequence: 3,
    status: 'ready',
    accountKey: 'c'.repeat(64),
    partial: true,
    rateLimits: { limitId: 'new', primary: { usedPercent: 1 } },
  });
  assert.deepEqual(
    cache.peek('a').buckets.map((b) => b.id),
    ['new'],
  );
});
test('pushes win over late snapshots, null windows clear, failures retain dated values only for the same account', async () => {
  let now = 1000;
  const cache = new AgentUsageCache(() => now);
  cache.update('a', snapshot());
  let release!: (v: AgentUsageUpdate) => void;
  const read = cache.read(
    'a',
    () =>
      new Promise((yes) => {
        release = yes;
      }),
    current,
    true,
  );
  await Promise.resolve();
  now = 2000;
  cache.update('a', {
    version: 1,
    sequence: 2,
    status: 'ready',
    accountKey: 'a'.repeat(64),
    partial: true,
    rateLimits: { limitId: 'codex', primary: null },
  });
  release(snapshot('a', 80));
  assert.equal((await read).buckets[0]?.primary, undefined);
  assert.equal(cache.peek('a').buckets[1]?.secondary?.usedPercent, 70);
  now = 3000;
  const failed = await cache.read(
    'a',
    async () => {
      throw Error('synthetic failure');
    },
    current,
    true,
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.observedAt, 2000);
  cache.update('a', { version: 1, sequence: 4, status: 'failed', accountKey: 'b'.repeat(64) });
  assert.deepEqual(cache.peek('a').buckets, []);
});
test('revoked contexts reject instead of populating cache; telemetry strips credentials', async () => {
  const cache = new AgentUsageCache();
  let valid = true,
    release!: (v: AgentUsageUpdate) => void;
  const guard = () => {
    assert.ok(valid);
  };
  const read = cache.read(
    'a',
    () =>
      new Promise((yes) => {
        release = yes;
      }),
    guard,
  );
  await Promise.resolve();
  valid = false;
  release(snapshot());
  await assert.rejects(read);
  assert.deepEqual(cache.peek('a').buckets, []);
  const clean = agentUsageUpdateSchema.parse({
    ...snapshot(),
    email: 'synthetic@example.invalid',
    token: 'synthetic-token',
  });
  assert.doesNotMatch(JSON.stringify(clean), /email|token/);
  assert.equal(
    agentUsageUpdateSchema.safeParse({
      ...snapshot(),
      rateLimitsByLimitId: { a: { primary: { usedPercent: null } } },
    }).success,
    false,
  );
});
