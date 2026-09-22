import test from 'node:test';
import assert from 'node:assert/strict';
import { paginationFixture, signal } from '../fixtures/workspace-pagination';

test('modern clients request bounded summaries and exact cursors while preserving each cached page', async (t) => {
  const f = await paginationFixture(t),
    target = f.catalog.targets[0].target;
  const [pinned, recent] = await Promise.all([
    f.controller.listProjectSessionPage('local', target, { pinned: 'pinned' }),
    f.controller.listProjectSessionPage('local', target, { pinned: 'unpinned' }),
  ]);
  assert.equal(pinned.items.length, 5);
  assert.equal(recent.items.length, 30);
  assert.equal(recent.partial, true);
  assert.equal(recent.legacy, false);
  const second = await f.controller.listProjectSessionPage('local', target, {
    pinned: 'unpinned',
    cursor: recent.nextCursor!,
  });
  assert.equal(second.items.length, 30);
  assert(second.items.every((item) => !recent.items.some((before) => before.id === item.id)));
  assert.equal(f.listCalls().length, 3);
  for (const call of f.listCalls()) {
    assert.equal(call.action, 'execute');
    if (call.action !== 'execute' || call.command.method !== 'sessions-page')
      throw Error('Must use pages');
    assert.equal(call.command.params.limit, 30);
  }
  const last = f.listCalls().at(-1)!;
  assert(last.action === 'execute' && last.command.method === 'sessions-page');
  assert.equal(last.command.params.cursor, recent.nextCursor);
  assert.equal(
    [...f.memory.values.keys()].filter((key) => key.includes('moor-workspace-session-page-v1'))
      .length,
    3,
  );
  assert.equal(
    [...f.memory.values.keys()].some((key) => key.includes('moor-workspace-session-list-v1')),
    false,
  );
});

test('catalog refresh invalidates only changed execution projects and does not discard unaffected in-flight pages', async (t) => {
  const f = await paginationFixture(t),
    [a, b] = f.catalog.targets;
  await f.controller.listProjectSessionPage('local', a.target);
  await f.controller.listProjectSessionPage('local', b.target);
  const before = f.controller.projectRevision('local', a.target);
  await f.controller.refreshCatalog('local');
  assert.equal(f.controller.projectRevision('local', a.target), before);
  await f.controller.listProjectSessionPage('local', a.target);
  assert.equal(f.listCalls().length, 2);
  await f.controller.synchronize({
    source: 'local',
    connectionId: f.catalog.connectionId,
    owner: f.catalog.owner,
    kind: 'changed',
    deviceId: a.target.deviceId,
  });
  assert.equal(f.controller.projectRevision('local', a.target), before);
  await f.controller.listProjectSessionPage('local', a.target);
  assert.equal(f.listCalls().length, 2);
  for (const target of f.catalog.targets)
    target.runtime.projects.find((entry) => entry.id === b.target.localProjectId)!.rootPath =
      '/synthetic/moved-b';
  await f.controller.synchronize({
    source: 'local',
    connectionId: f.catalog.connectionId,
    owner: f.catalog.owner,
    kind: 'changed',
    deviceId: b.target.deviceId,
  });
  assert.equal(f.controller.projectRevision('local', a.target), before);
  assert(f.controller.projectRevision('local', b.target) > before);
  await f.controller.listProjectSessionPage('local', a.target);
  assert.equal(f.listCalls().length, 2);
  await f.controller.listProjectSessionPage('local', b.target);
  assert.equal(f.listCalls().length, 3);
  const entered = signal(),
    release = signal();
  f.controls.after = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.controller.listProjectSessionPage('local', a.target, { fresh: true });
  await entered.promise;
  await f.controller.refreshCatalog('local');
  release.resolve();
  assert.equal((await pending).items.length, 30);
});

test('offline pages reveal only cached scope/cursor coverage and do not mark another project offline', async (t) => {
  const f = await paginationFixture(t),
    [a, b] = f.catalog.targets;
  await f.controller.selectProject('local', a.target);
  const first = await f.controller.listProjectSessionPage('local', b.target);
  f.failures.set(b.target.localProjectId, {
    code: 'network',
    status: null,
    rejected: false,
    message: 'Synthetic disconnect',
  });
  const cached = await f.controller.listProjectSessionPage('local', b.target, { fresh: true });
  assert.equal(cached.source, 'cache');
  assert.equal(cached.partial, true);
  assert.deepEqual(cached.items, first.items);
  await assert.rejects(
    f.controller.listProjectSessionPage('local', b.target, {
      cursor: first.nextCursor!,
      fresh: true,
    }),
  );
  assert.equal(f.controller.state.offline, false);
  assert.deepEqual(f.controller.state.scope!.target, a.target);
  await assert.rejects(
    f.controller.listProjectSessionPage('local', { ...b.target, owner: 'other' }),
  );
});

test('auth, stale cursor, mapping and malformed-response failures never fall back to cached or legacy lists', async (t) => {
  const f = await paginationFixture(t),
    target = f.catalog.targets[0].target;
  await f.controller.selectProject('local', target);
  for (const error of [
    { code: 'host', status: 401 },
    { code: 'host', status: 403 },
    { code: 'host', status: 409 },
    { code: 'unavailable', status: null },
    { code: 'host', status: 502 },
  ]) {
    f.failures.set(target.localProjectId, {
      ...error,
      rejected: false,
      message: 'Synthetic scope failure',
    });
    await assert.rejects(f.controller.listProjectSessionPage('local', target, { fresh: true }));
    assert.equal(f.controller.state.offline, false);
  }
  assert(
    f
      .listCalls()
      .every((call) => call.action === 'execute' && call.command.method === 'sessions-page'),
  );
  f.failures.set(target.localProjectId, {
    code: 'host',
    status: 401,
    rejected: false,
    message: 'Expired',
  });
  await assert.rejects(f.controller.refreshSessions());
  assert.deepEqual(f.controller.state.sessions, []);
  assert.equal(f.controller.state.offline, false);
});

test('server filters find unloaded titles and archives, and a stale cursor requires an explicit fresh read', async (t) => {
  const f = await paginationFixture(t),
    target = f.catalog.targets[0].target;
  const first = await f.controller.listProjectSessionPage('local', target, { pinned: 'unpinned' });
  assert(!first.items.some((item) => item.title === 'Needle far session'));
  const search = await f.controller.listProjectSessionPage('local', target, { query: 'Needle' });
  assert.equal(search.items.length, 1);
  const archived = await f.controller.listProjectSessionPage('local', target, {
    archived: 'archived',
  });
  assert.equal(archived.items.length, 5);
  f.rows[0].title = 'Changed metadata';
  const before = f.listCalls().length;
  await assert.rejects(
    f.controller.listProjectSessionPage('local', target, {
      pinned: 'unpinned',
      cursor: first.nextCursor!,
      fresh: true,
    }),
  );
  assert.equal(f.listCalls().length, before + 1, 'a 409 must not silently restart or execute');
  const refreshed = await f.controller.listProjectSessionPage('local', target, {
    pinned: 'unpinned',
    fresh: true,
  });
  assert.notEqual(refreshed.revision, first.revision);
});

test('metadata pagination does not rewrite drafts or unknown operations, and legacy compatibility is explicit', async (t) => {
  const f = await paginationFixture(t, { legacy: true }),
    target = f.catalog.targets[0].target,
    scope = { source: 'local' as const, target };
  await f.store.saveDraft(scope, 'draft-session', 0, 'Keep local draft', {}, () => {});
  await f.store.stage(
    scope,
    {
      kind: 'control',
      value: {
        controlVersion: 1,
        action: 'create',
        operationId: 'unknown-create',
        sessionId: 'draft-session',
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        userId: target.userId,
        machineId: target.machineId,
        agentId: 'agent',
      },
    },
    undefined,
    () => {},
  );
  const before = await f.store.read(scope, () => {}, 'draft-session');
  const [one, two] = await Promise.all([
    f.controller.listProjectSessionPage('local', target, { pinned: 'pinned' }),
    f.controller.listProjectSessionPage('local', target, { pinned: 'unpinned' }),
  ]);
  assert.equal(one.legacy, true);
  assert.equal(two.legacy, true);
  assert.equal(f.listCalls().length, 1, 'compatibility consumers share a concurrent legacy read');
  assert.deepEqual(await f.store.read(scope, () => {}, 'draft-session'), before);
  assert.equal(
    (await f.store.readDraft(scope, 'draft-session', () => {})).text,
    'Keep local draft',
  );
  assert.equal(before.operations[0].status, 'pending');
  assert(
    f.listCalls().every((call) => call.action === 'execute' && call.command.method === 'sessions'),
  );
});
