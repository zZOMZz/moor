import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Flock, metas, mirror, putMeta, vv } from '@moor/session/model';
import { appendSessionText } from '@moor/session/session-output';
import { sessionPageRequestSchema } from '@moor/protocol/session-page';
import { RuntimeStore } from '../src/persistence/store';
import { HostWorkspace } from '../src/sessions/workspace';

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-session-index-')));
  const root = join(directory, 'project');
  mkdirSync(root);
  const file = join(directory, 'host.sqlite');
  const store = new RuntimeStore(file, { outputCheckpoint: { updates: 2, bytes: 1024 * 1024 } });
  const project = store.registerProject(root);
  store.machine.set(['agentConfig', 'agent'], {
    id: 'agent',
    name: 'Synthetic',
    machineId: store.workspace.machineId,
    cliType: 'builtin',
    agentType: 'codex',
    runtimeOverrides: { codexPath: process.execPath },
  });
  store.saveMachine();
  const host = new HostWorkspace(
    store,
    {
      async open() {
        throw Error('Metadata tests must never launch an Agent');
      },
    },
    () => {},
    () => {},
  );
  t.after(() => {
    host.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const scope = {
    workspaceId: host.workspace.id,
    userId: host.workspace.userId,
    machineId: host.workspace.machineId,
    localProjectId: project,
  };
  const request = (changes: Record<string, unknown> = {}) =>
    sessionPageRequestSchema.parse({
      pageVersion: 1,
      workspaceId: scope.workspaceId,
      localProjectId: project,
      ...changes,
    });
  return {
    store,
    host,
    file,
    project,
    scope,
    request,
    page: (changes: Record<string, unknown> = {}) =>
      host.readSessionPage(request(changes), project),
    create: (sessionId: string) =>
      host.controlManager.control(
        {
          ...scope,
          sessionId,
          controlVersion: 1,
          action: 'create',
          operationId: 'create-' + sessionId,
          agentId: 'agent',
        },
        project,
      ),
  };
}

test('legacy metadata is projected once without importing bodies; later startup and first page never enumerate Flock', (t) => {
  const f = fixture(t),
    ids: string[] = [];
  for (let project = 0; project < 25; project++)
    for (let index = 0; index < 90; index++) {
      const id = `project-${project}-session-${index}`;
      ids.push(id);
      putMeta(f.store.meta, 'session-' + id, {
        id,
        userId: f.scope.userId,
        machineId: f.scope.machineId,
        project: {
          kind: 'local',
          localProjectId: project === 0 ? f.project : 'other-project-' + project,
        },
        agentConfigId: 'agent',
        cliType: 'builtin',
        agentType: 'codex',
        title: 'History ' + index,
        lastMessageAt: index,
        isPinned: index === 0,
        isArchived: false,
      });
    }
  // A previous host stores the authoritative Flock without this projection.
  f.store.save('meta', f.store.meta.exportFile());
  const doc = f.store.doc(ids[0]!);
  const view = mirror(doc, ids[0]!);
  view.setState((state) => {
    state.session.id = ids[0]!;
    state.history.push({
      id: 'completed',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      finished: true,
      userTurnId: 'old-user',
      userId: undefined,
      read: undefined,
      inputConfig: undefined,
      status: 'handled',
      items: [{ type: 'text', text: 'large settled history '.repeat(100000) }],
      fileDiff: null,
    });
  });
  view.dispose();
  doc.commit();
  f.store.journal.db
    .prepare('INSERT INTO session VALUES(?,?)')
    .run(ids[0]!, doc.export({ mode: 'snapshot' }));
  f.store.journal.db.exec('DELETE FROM session_recovery');
  doc.free();
  let metadataScans = 0,
    importedBodies = 0;
  const scan = Flock.prototype.scan;
  t.mock.method(
    Flock.prototype,
    'scan',
    function (this: Flock, options: Parameters<Flock['scan']>[0]) {
      if (options?.prefix?.[0] === 'm') metadataScans++;
      return scan.call(this, options);
    },
  );
  t.mock.method(RuntimeStore.prototype, 'doc', () => {
    importedBodies++;
    throw Error('Pagination must not read a body');
  });
  const migrated = new RuntimeStore(f.file);
  assert.equal(metadataScans, 1);
  assert.equal(importedBodies, 0);
  const migratedVersion = migrated.sessionPages.version(f.scope);
  migrated.close();
  metadataScans = 0;
  const reopened = new RuntimeStore(f.file);
  t.after(() => reopened.close());
  assert.equal(metadataScans, 0);
  assert.equal(importedBodies, 0);
  assert.deepEqual(reopened.sessionPages.version(f.scope), migratedVersion);
  const host = new HostWorkspace(
    reopened,
    {
      async open() {
        throw Error('No execution');
      },
    },
    () => {},
    () => {},
  );
  t.after(() => host.close());
  t.mock.method(host, 'list', () => {
    throw Error('No legacy full list');
  });
  const returned: number[] = [],
    statements: string[] = [];
  const prepare = reopened.journal.db.prepare.bind(reopened.journal.db);
  t.mock.method(reopened.journal.db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('SELECT metadata,')) {
      statements.push(sql);
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', (...args: Parameters<typeof all>) => {
        const rows = all(...args);
        returned.push(rows.length);
        return rows;
      });
    }
    return statement;
  });
  const first = host.readSessionPage(f.request(), f.project);
  assert.equal(first.items.length, 30);
  assert.equal(first.items[0]!.id, ids[0]);
  assert.deepEqual(returned, [31]);
  assert.equal(metadataScans, 0);
  assert.equal(importedBodies, 0);
  const plan = prepare('EXPLAIN QUERY PLAN ' + statements[0]).all(
    f.scope.userId,
    f.scope.machineId,
    f.project,
    0,
    31,
  );
  assert(plan.some((row) => String(row.detail).includes('session_metadata_active')));
  assert(!plan.some((row) => /SCAN session_metadata|TEMP B-TREE/.test(String(row.detail))));
});

test('create, rename, archive and pin update project pages in their original acceptance transaction', async (t) => {
  const f = fixture(t);
  for (const id of ['a', 'b', 'c']) await f.create(id);
  let revision = 0,
    prior = f.page({ limit: 1 });
  for (const action of ['rename', 'pin', 'archive', 'restore', 'unpin'] as const) {
    await f.host.sessionAction(
      {
        workspaceId: f.scope.workspaceId,
        localProjectId: f.project,
        sessionId: 'a',
        operationId: 'metadata-' + action,
        expectedRevision: revision++,
        action,
        ...(action === 'rename' ? { title: 'Renamed' } : {}),
      } as never,
      f.project,
    );
    assert.throws(
      () => f.page({ limit: 1, cursor: prior.nextCursor }),
      (error: any) => error.status === 409,
    );
    const current = f.page({ archived: 'all' }).items.find((row) => row.id === 'a')!;
    assert.equal(current.metadataRevision, revision);
    assert.equal(current.title, 'Renamed');
    assert.equal(current.isArchived, action === 'archive');
    assert.equal(current.isPinned, ['pin', 'archive', 'restore'].includes(action));
    prior = f.page({ limit: 1 });
  }
});

for (const fault of ['projection', 'version', 'receipt'] as const)
  test(`a ${fault} failure rolls metadata and the cursor version back together`, async (t) => {
    const f = fixture(t);
    await f.create('a');
    await f.create('b');
    const page = f.page({ limit: 1 }),
      meta = Buffer.from(f.store.load('meta')!);
    const table =
      fault === 'projection'
        ? 'session_metadata'
        : fault === 'version'
          ? 'session_metadata_version'
          : 'operation';
    f.store.journal.db.exec(
      `CREATE TRIGGER fail_metadata BEFORE ${fault === 'version' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic metadata failure'); END`,
    );
    await assert.rejects(
      f.host.sessionAction(
        {
          workspaceId: f.scope.workspaceId,
          localProjectId: f.project,
          sessionId: 'a',
          operationId: 'rename-failure',
          expectedRevision: 0,
          action: 'rename',
          title: 'Must roll back',
        },
        f.project,
      ),
    );
    assert.deepEqual(Buffer.from(f.store.load('meta')!), meta);
    assert.equal(f.page({ limit: 1 }).revision, page.revision);
    assert.doesNotThrow(() => f.page({ limit: 1, cursor: page.nextCursor }));
    assert.equal(f.store.journal.has('rename-failure'), false);
    await assert.rejects(f.create('new-session'));
    assert.equal(
      f.store.journal.db.prepare('SELECT 1 FROM session WHERE id=?').get('new-session'),
      undefined,
    );
    assert.equal(f.store.meta.get(['m', 'session-new-session', 'id']), undefined);
    assert.equal(f.store.journal.has('create-new-session'), false);
    assert.equal(f.page({ limit: 1 }).revision, page.revision);
    f.store.journal.db.exec('DROP TRIGGER fail_metadata');
  });

test('text deltas, compaction and unchanged metadata checkpoints retain the project cursor', async (t) => {
  const f = fixture(t);
  await f.create('a');
  await f.create('b');
  let doc = f.store.doc('a');
  const view = mirror(doc, 'a');
  view.setState((state) => {
    state.history.push({
      id: 'assistant',
      role: 'assistant',
      userTurnId: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      finished: false,
      items: [],
      fileDiff: null,
      userId: undefined,
      inputConfig: undefined,
      read: undefined,
      status: undefined,
    });
  });
  view.dispose();
  putMeta(f.store.meta, 'session-a', { status: { type: 'working' } });
  f.store.persist('a', doc);
  const before = f.page({ limit: 1 });
  for (let i = 0; i < 5; i++) {
    const from = doc.version(),
      next = doc.fork();
    next.setPeerId(doc.peerIdStr);
    appendSessionText(next, 'a', 'assistant', 'text', 'chunk-' + i);
    f.store.persistOutput('a', next, from);
    from.free();
    doc.free();
    doc = next;
    assert.equal(f.page({ limit: 1 }).revision, before.revision);
  }
  f.store.persist('a', doc);
  assert.equal(f.page({ limit: 1 }).revision, before.revision);
  assert.doesNotThrow(() => f.page({ limit: 1, cursor: before.nextCursor }));
  putMeta(f.store.meta, 'session-a', { status: { type: 'idle' } });
  f.store.persist('a', doc);
  doc.free();
  assert.notEqual(f.page().revision, before.revision);
});

test('session reads inspect only their own metadata and root identity, preserving raw clocks and tombstones', async (t) => {
  const f = fixture(t);
  await f.create('a');
  const selected = 'session-a';
  putMeta(f.store.meta, selected, { title: 'removed title' });
  f.store.meta.delete(['m', selected, 'title']);
  f.store.meta.putWithMeta(['m', selected, 'custom'], 'kept', {
    metadata: { provenance: 'synthetic' },
  });
  f.store.meta.commit();
  for (let index = 0; index < 1000; index++)
    putMeta(f.store.meta, `session-a-other-${index}`, { id: `other-${index}`, title: 'unrelated' });
  const expectedMeta = metas(f.store.meta)[selected];
  const fullBundle = f.store.meta.exportJson();
  const expectedBundle = {
    ...fullBundle,
    entries: Object.fromEntries(
      Object.entries(fullBundle.entries).filter(([key]) => {
        const parts = JSON.parse(key);
        return parts[1] === selected && ['e', 'm'].includes(parts[0]);
      }),
    ),
  };
  const doc = f.store.doc('a');
  f.host.active.set('a', { doc } as never);
  const base = vv(doc);
  const rows: number[] = [];
  let broadScans = 0;
  const scan = f.store.meta.scan.bind(f.store.meta);
  t.mock.method(f.store.meta, 'scan', (options: Parameters<Flock['scan']>[0]) => {
    if (options?.prefix?.[1] !== selected) broadScans++;
    assert.deepEqual(options?.prefix?.slice(0, 2), [options?.prefix?.[0], selected]);
    assert.ok(['e', 'm'].includes(String(options?.prefix?.[0])));
    const result = scan(options);
    rows.push(result.length);
    return result;
  });
  t.mock.method(f.store.meta, 'exportJson', () => {
    assert.fail('single-session reads must not export every session');
  });
  t.mock.method(doc, 'getList', () => {
    assert.fail('identity validation must not decode history through a Mirror');
  });
  try {
    const result = await f.host.read('a', base, f.project);
    assert.deepEqual(result.meta, expectedMeta);
    assert.deepEqual(
      result.metaBundle,
      expectedBundle,
      'raw export matches the previous complete-export filter',
    );
    assert.equal(result.persisted, true);
    assert.equal(
      broadScans,
      0,
      'optional capability reads must not hide broad scans behind fallback',
    );
    assert.ok(rows.every((count) => count <= Object.keys(expectedBundle.entries).length));
    await assert.rejects(f.host.read('a', base, 'other-project'), /会话不属于该项目副本/);
    doc.getMap('session').set('id', 'other-session');
    await assert.rejects(f.host.read('a', base, f.project), /会话文档身份与主机记录不匹配/);
    doc.getMap('session').delete('id');
    await assert.rejects(f.host.read('a', base, f.project), /会话文档身份尚未迁移/);
    doc.getMap('session').set('id', 'a');
    f.store.meta.delete(['m', selected, 'userId']);
    f.store.meta.commit();
    await assert.rejects(f.host.read('a', base, f.project), /会话不属于这台电脑/);
  } finally {
    f.host.active.delete('a');
    doc.free();
  }
});
