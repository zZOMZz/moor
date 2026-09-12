import test from 'node:test';
import assert from 'node:assert/strict';
import { GithubController, githubKey, safeGithubLink, type GithubTarget } from '../src/web/github';
import { ApiError } from '../src/web/api';
import type { GithubAction, GithubRead, GithubBinding } from '../src/github-protocol';
const target: GithubTarget = {
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
const version = 'sha256:' + 'a'.repeat(64),
  oid = 'b'.repeat(40),
  timestamp = '2026-09-12T00:00:00Z';
const repository = {
  id: 42,
  owner: 'example',
  name: 'private',
  private: true,
  defaultBranch: 'main',
  url: 'https://github.com/example/private',
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
    calls: { path: string; body: any }[] = [];
  let count = 0;
  const controls = {
    online: true,
    available: true,
    failWrite: false,
    rejected: false,
    lost: false,
    wrong: false,
    redacted: false,
    undelivered: false,
    version,
    wait: undefined as undefined | ((body: GithubRead | GithubAction) => Promise<void>),
  };
  let binding: GithubBinding = { revision: 0 };
  const receipts = new Map<string, any>();
  const item = {
    id: 99,
    number: 7,
    title: 'Synthetic <img src=x> title',
    state: 'open' as const,
    author: 'synthetic',
    url: repository.url + '/pull/7',
    updatedAt: timestamp,
    body: 'Private synthetic body <script>bad()</script>',
    bodyTruncated: false,
    labels: [],
    version,
    kind: 'pull' as const,
    head: {
      sha: oid,
      branch: 'contributor/fix',
      repository: { id: 43, owner: 'contributor', name: 'fork' },
    },
    base: {
      sha: 'c'.repeat(40),
      branch: 'main',
      repository: { id: 42, owner: 'example', name: 'private' },
    },
    mergeable: null,
  };
  const create = (t = target, current = () => true) =>
    new GithubController(t, {
      read: async (key) => structuredClone(cache.get(key)),
      compareWrite: async (key, revision, value, guard) => {
        if (!guard()) throw new Error('scope changed');
        if (controls.failWrite) throw new Error('storage failed');
        if ((cache.get(key)?.cacheRevision ?? 0) !== revision) return false;
        cache.set(key, structuredClone(value));
        return true;
      },
      current,
      online: () => controls.online,
      changed() {},
      uuid: () => `operation-${++count}`,
      request: async (path, raw) => {
        const body = raw as GithubRead | GithubAction;
        calls.push({ path, body: structuredClone(body) });
        await controls.wait?.(body);
        const scope = {
          githubVersion: 1,
          workspaceId: t.workspaceId,
          localProjectId: t.localProjectId,
          sessionId: t.sessionId,
          confirmed: true,
        };
        if ('action' in body) {
          assert.deepEqual(cache.get(githubKey(t)).pending.request, body);
          if (controls.rejected) throw new ApiError('explicit rejection', 409, true);
          if (controls.undelivered) throw new Error('request never reached host');
          let receipt = receipts.get(body.operationId);
          if (!receipt && path.endsWith('/abandon')) {
            receipt = {
              ...scope,
              operationId: body.operationId,
              abandoned: true,
              binding: { revision: body.expectedRevision },
            };
            receipts.set(body.operationId, receipt);
          } else if (!receipt) {
            binding = {
              revision: body.expectedRevision + 1,
              ...(body.action === 'bind'
                ? {
                    context: {
                      repository: { id: 42, owner: 'example', name: 'private' },
                      branch: body.branch,
                      subject: body.subject,
                      updatedAt: timestamp,
                    },
                  }
                : {}),
            };
            receipt = {
              ...scope,
              operationId: body.operationId,
              binding: structuredClone(binding),
            };
            receipts.set(body.operationId, receipt);
          }
          if (controls.lost) throw new Error('lost receipt');
          return {
            ...structuredClone(receipt),
            ...(controls.redacted && !receipt.abandoned
              ? { redacted: true, binding: { revision: receipt.binding.revision } }
              : {}),
            operationId: controls.wrong ? 'wrong' : body.operationId,
          };
        }
        const base = {
          ...scope,
          view: body.view,
          binding: structuredClone(binding),
          readAt: timestamp,
        };
        if (body.view === 'overview')
          return controls.available
            ? {
                ...base,
                status: 'available',
                repository,
                configVersion: controls.version,
                localBranch: 'different-local',
              }
            : {
                ...base,
                status: 'unavailable',
                binding: { revision: binding.revision },
                reason: '授权已停用',
              };
        if (!controls.available || body.configVersion !== controls.version)
          throw new ApiError('authorization changed', 409, true);
        const scoped = { ...base, repository, configVersion: controls.version };
        if (body.view === 'branches')
          return {
            ...scoped,
            result: {
              items: [{ name: 'main', sha: oid, protected: true }],
              page: body.page,
              hasNext: false,
              partial: false,
            },
          };
        if (body.view === 'pull') return { ...scoped, item };
        if (body.view === 'checks')
          return {
            ...scoped,
            number: body.number,
            headSha: body.headSha,
            checks: { items: [], page: body.page, hasNext: false, partial: true },
            statuses: {
              items: [],
              page: body.page,
              hasNext: false,
              partial: false,
              state: 'pending',
              totalCount: 0,
            },
          };
        assert.fail('unexpected read');
      },
    });
  return {
    create,
    cache,
    calls,
    controls,
    item,
    setBinding(value: GithubBinding) {
      binding = value;
    },
  };
}
test('GitHub private reads stay in memory and every explicit draft copy rechecks the exact authorized item', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  assert.equal(f.calls.length, 0);
  await c.refresh();
  await c.openItem('pull', 7);
  await c.loadChecks();
  assert.equal(f.cache.size, 0);
  assert.match(await c.contextForDraft(), /Private synthetic body/);
  assert.equal(f.calls.filter((v) => v.body.view === 'pull').length, 2);
  f.controls.available = false;
  await assert.rejects(c.contextForDraft(), /authorization/);
  assert.equal(c.detail, undefined);
  assert.equal(c.overview, undefined);
  assert.equal(c.checks, undefined);
  assert.equal(f.cache.size, 0);
  f.controls.available = true;
  await c.refresh();
  await c.openItem('pull', 7);
  f.controls.online = false;
  c.invalidate();
  assert.equal(c.detail, undefined);
  await assert.rejects(c.refresh(), /连接执行电脑/);
  assert.equal(f.cache.size, 0);
  assert.equal(
    safeGithubLink('https://github.com/example/private/pull/7', repository),
    'https://github.com/example/private/pull/7',
  );
  for (const value of [
    'javascript:alert(1)',
    'https://github.com/other/private/pull/7',
    'https://evil.invalid/example/private',
    'https://github.com/example/private/../../settings',
    'https://github.com/example/private?token=secret',
  ])
    assert.equal(safeGithubLink(value, repository), undefined);
});
test('abandon intent is durable and manual retries keep the exact original request without repeating a bind', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  await c.openItem('pull', 7);
  f.controls.undelivered = true;
  await assert.rejects(c.bind('main'), /never reached/);
  const original = structuredClone(c.pending!.request);
  f.controls.undelivered = false;
  f.controls.available = false;
  f.controls.lost = true;
  await assert.rejects(c.abandon(), /lost receipt/);
  assert.equal(c.pending!.abandon, true);
  assert.equal(f.cache.get(githubKey(target)).pending.abandon, true);
  const count = f.calls.length,
    restored = f.create();
  await restored.load();
  assert.equal(f.calls.length, count);
  assert.deepEqual(restored.pending!.request, original);
  f.controls.lost = false;
  f.controls.wrong = true;
  await assert.rejects(restored.retry(), /匹配的主机确认/);
  assert.ok(restored.pending);
  f.controls.wrong = false;
  const receipt = await restored.retry();
  assert.equal(receipt.abandoned, true);
  assert.equal(restored.pending, undefined);
  assert.equal(restored.blocked, false);
  assert.equal(restored.binding, undefined);
  assert.match(restored.error, /原请求未执行/);
  const abandoned = f.calls.filter((value) => value.path.endsWith('/abandon'));
  assert.equal(abandoned.length, 3);
  assert.ok(abandoned.every((value) => JSON.stringify(value.body) === JSON.stringify(original)));
  assert.equal(f.calls.filter((value) => value.path.endsWith('/action')).length, 1);
  assert.doesNotMatch(
    JSON.stringify([...f.cache.values()]),
    /Private synthetic body|example|title/,
  );
});
test('abandon cannot dispatch until its intent is durable and an already applied bind is only confirmed', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  await c.openItem('pull', 7);
  f.controls.lost = true;
  await assert.rejects(c.bind('main'), /lost/);
  const original = structuredClone(c.pending!.request),
    count = f.calls.length;
  f.controls.failWrite = true;
  await assert.rejects(c.abandon(), /storage failed/);
  assert.equal(f.calls.length, count);
  assert.equal(f.cache.get(githubKey(target)).pending.abandon, undefined);
  f.controls.failWrite = false;
  const restored = f.create();
  await restored.load();
  f.controls.lost = false;
  f.controls.redacted = true;
  f.controls.available = false;
  const receipt = await restored.abandon();
  assert.equal(receipt.redacted, true);
  assert.equal(receipt.abandoned, undefined);
  assert.equal(restored.pending, undefined);
  assert.match(restored.error, /确认原绑定操作/);
  assert.deepEqual(f.calls.at(-1)!.body, original);
});
test('GitHub binding outbox is durable, immutable across lost receipts and regrouping, and never stores body or retries automatically', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  await c.openItem('pull', 7);
  f.controls.lost = true;
  await assert.rejects(c.bind('main'), /lost/);
  const original = structuredClone(c.pending!.request);
  assert.equal(original.action === 'bind' && original.branch, 'contributor/fix');
  assert.doesNotMatch(
    JSON.stringify([...f.cache.values()]),
    /Private synthetic body|Synthetic <img|localBranch|example/,
  );
  const count = f.calls.length,
    moved = f.create({ ...target, catalogWorkspaceId: 'new-catalog', replicaId: 'new-replica' });
  await moved.load();
  assert.equal(f.calls.length, count);
  assert.deepEqual(moved.pending!.request, original);
  f.controls.lost = false;
  f.controls.wrong = true;
  await assert.rejects(moved.retry(), /匹配的主机确认/);
  assert.deepEqual(moved.pending!.request, original);
  f.controls.wrong = false;
  f.controls.rejected = true;
  await assert.rejects(moved.retry(), /explicit rejection/);
  assert.ok(moved.pending);
  const reload = f.create({
    ...target,
    catalogWorkspaceId: 'new-catalog',
    replicaId: 'new-replica',
  });
  await reload.load();
  assert.deepEqual(reload.pending!.request, original);
  f.controls.rejected = false;
  f.controls.available = false;
  f.controls.redacted = true;
  await reload.retry();
  assert.equal(reload.pending, undefined);
  assert.equal(reload.binding, undefined);
  assert.equal(reload.detail, undefined);
  assert.match(reload.error, /确认原绑定操作/);
  const actions = f.calls.filter((v) => v.path.endsWith('/action'));
  assert.equal(actions.length, 4);
  assert.ok(actions.slice(1).every((v) => JSON.stringify(v.body) === JSON.stringify(original)));
  assert.match(actions.at(-1)!.path, /new-catalog\/replicas\/new-replica/);
  f.controls.redacted = false;
  await reload.refresh();
  await reload.unbind();
  assert.equal((reload.binding as GithubBinding | undefined)?.context, undefined);
});
test('first explicit rejection clears only that new binding; storage failures and competing pages never dispatch an additional action', async () => {
  const f = fixture(),
    a = f.create(),
    b = f.create();
  await Promise.all([a.load(), b.load()]);
  await a.refresh();
  await a.loadBranches();
  await b.refresh();
  await b.loadBranches();
  f.controls.rejected = true;
  await assert.rejects(a.bind('main'), /explicit rejection/);
  assert.equal(a.pending, undefined);
  f.controls.rejected = false;
  await assert.rejects(b.bind('main'), /其他页面/);
  assert.equal(b.blocked, true);
  assert.equal(f.calls.filter((v) => v.path.endsWith('/action')).length, 1);
  const c = f.create();
  await c.load();
  await c.refresh();
  await c.loadBranches();
  f.controls.failWrite = true;
  await assert.rejects(c.bind('main'), /storage failed/);
  assert.equal(f.calls.filter((v) => v.path.endsWith('/action')).length, 1);
});
test('late private responses and receipts are discarded after scope invalidation; pending confirmation remains recoverable', async () => {
  const f = fixture(),
    c = f.create(),
    entered = signal(),
    release = signal();
  await c.load();
  await c.refresh();
  f.controls.wait = async (body) => {
    if ('view' in body && body.view === 'pull') {
      entered.resolve();
      await release.promise;
    }
  };
  const read = c.openItem('pull', 7);
  await entered.promise;
  c.invalidate('配置已变化');
  release.resolve();
  await assert.rejects(read, /已改变/);
  assert.equal(c.detail, undefined);
  assert.equal(f.cache.size, 0);
  f.controls.wait = undefined;
  await c.refresh();
  await c.loadBranches();
  const actionEntered = signal(),
    actionRelease = signal();
  f.controls.wait = async (body) => {
    if ('action' in body) {
      actionEntered.resolve();
      await actionRelease.promise;
    }
  };
  const action = c.bind('main');
  await actionEntered.promise;
  c.invalidate();
  actionRelease.resolve();
  await assert.rejects(action, /已改变/);
  const reload = f.create();
  await reload.load();
  assert.ok(reload.pending);
  assert.equal(reload.binding, undefined);
});
test('confirming an older original operation does not replace a newer host binding', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  await c.loadBranches();
  f.controls.lost = true;
  await assert.rejects(c.bind('main'), /lost/);
  const newer: GithubBinding = {
    revision: 2,
    context: {
      repository: { id: 42, owner: 'example', name: 'private' },
      branch: 'new-context',
      subject: null,
      updatedAt: timestamp,
    },
  };
  f.setBinding(newer);
  await c.refresh();
  f.controls.lost = false;
  await c.retry();
  assert.deepEqual(c.binding, newer);
  assert.equal(f.cache.get(githubKey(target)).revision, 2);
});
