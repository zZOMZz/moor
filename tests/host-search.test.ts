import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { searchHostSessions } from '../src/bridge/host-search';
import { RuntimeStore } from '../src/runtime/store';
import { mirror, putMeta } from '../src/model';
import type { SessionSearchRequest } from '../src/search-protocol';
import type { ProjectSnapshot } from '../src/runtime/project-snapshot';

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'moor-host-search-'));
  const path = join(dir, 'runtime.sqlite');
  let store = new RuntimeStore(path);
  Object.assign(store.workspace, {
    id: 'workspace',
    userId: 'local:synthetic',
    machineId: 'machine',
  });
  store.save('identity', Buffer.from(JSON.stringify(store.workspace)));
  for (const id of ['project', 'other-project'])
    store.machine.set(['localProject', id], { id, name: id, rootPath: '/synthetic/' + id });
  store.saveMachine();
  let opens = 0;
  const open = () =>
    new HostWorkspace(
      store,
      {
        async open() {
          opens++;
          throw new Error('search must never open Agent');
        },
      },
      () => {},
      () => {},
    );
  let host = open();
  t.after(() => {
    host.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(opens, 0);
  });
  function save(
    sessionId: string,
    text: string,
    fields: Record<string, unknown> = {},
    items?: any[],
  ) {
    putMeta(store.meta, 'session-' + sessionId, {
      id: sessionId,
      userId: 'local:synthetic',
      machineId: 'machine',
      project: { localProjectId: 'project' },
      lastMessageAt: 0,
      ...fields,
    });
    const doc = store.doc(sessionId),
      view = mirror(doc, sessionId);
    view.setState((state: any) => {
      state.history.splice(0, state.history.length, {
        id: 'turn-' + sessionId,
        role: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        finished: true,
        status: 'completed',
        items: items ?? [{ type: 'text', text }],
      });
    });
    view.dispose();
    store.persist(sessionId, doc);
  }
  save('session', 'needle original message');
  const request = (
    query: string,
    scope: 'session' | 'project' = 'session',
    sessionId = 'session',
  ): SessionSearchRequest => ({
    searchVersion: 1,
    workspaceId: 'workspace',
    localProjectId: 'project',
    sessionId,
    scope,
    query,
    limit: 30,
  });
  return {
    get store() {
      return store;
    },
    get host() {
      return host;
    },
    save,
    request,
    search: (query: string, scope: 'session' | 'project' = 'session') =>
      searchHostSessions(host, request(query, scope), 'project'),
    restart() {
      host.close();
      store.close();
      store = new RuntimeStore(path);
      host = open();
    },
  };
}
const snapshot = (text: string): ProjectSnapshot => ({
  version: 1,
  source: 'git',
  partial: false,
  enumerationComplete: true,
  issues: [],
  bytesRead: Buffer.byteLength(text),
  files: [
    {
      path: 'src/saved.ts',
      size: Buffer.byteLength(text),
      state: 'text',
      metadataVersion: text,
      version: 'sha256:' + createHash('sha256').update(text).digest('hex'),
      mediaType: 'text/plain',
      text,
    },
  ],
});

test('host search lazily projects message/tool bodies and only saved frozen diff text with stable anchors', async (t) => {
  const f = fixture(t);
  f.save('session', '', {}, [
    { type: 'text', text: 'visible-message' },
    { type: 'thought', text: 'visible-thought' },
    {
      type: 'tool_call',
      title: 'visible-tool',
      rawInput: 'raw-secret',
      rawOutput: 'raw-secret',
      content: [{ type: 'content', content: { type: 'text', text: 'visible-result' } }],
    },
    { type: 'attachment', data: 'attachment-secret', name: 'attachment-secret' },
  ]);
  const lease = f.host.projectLease(f.request('x'));
  f.store.projectHistory.begin(lease, 'turn-session');
  f.store.projectHistory.saveBefore(lease, 'turn-session', snapshot('frozen-before'));
  const reference = f.store.projectHistory.finish(
    lease,
    'turn-session',
    undefined,
    snapshot('frozen-after'),
  );
  const doc = f.store.doc('session'),
    view = mirror(doc, 'session');
  view.setState((state) => {
    state.history[0]!.fileDiff = reference;
  });
  view.dispose();
  f.store.persist('session', doc);
  assert.equal(f.store.journal.db.prepare('SELECT COUNT(*) AS n FROM search_entry').get()!.n, 0);
  for (const [query, kind, itemIndex] of [
    ['visible-message', 'message', 0],
    ['visible-thought', 'message', 1],
    ['visible-result', 'tool', 2],
    ['frozen-before', 'diff', 0],
    ['frozen-after', 'diff', 0],
  ] as const) {
    const result = await f.search(query);
    assert.equal(result.partial, false, query);
    assert.equal(result.hits.length, 1, query);
    assert.equal(result.hits[0]!.kind, kind);
    assert.equal(result.hits[0]!.itemIndex, itemIndex);
    assert.equal(result.hits[0]!.turnId, 'turn-session');
    if (kind === 'diff') assert.equal(result.hits[0]!.path, 'src/saved.ts');
  }
  for (const query of ['raw-secret', 'attachment-secret', '/synthetic/project'])
    assert.equal((await f.search(query)).hits.length, 0);
  // No registered root exists; a successful result therefore cannot come from a current filesystem read.
});

test('scope validation requires an existing context and filters all neighbor metadata dimensions', async (t) => {
  const f = fixture(t);
  f.save('neighbor', 'needle neighbor');
  f.save('wrong-user', 'needle forbidden', { userId: 'other' });
  f.save('wrong-machine', 'needle forbidden', { machineId: 'other' });
  f.save('wrong-project', 'needle forbidden', { project: { localProjectId: 'other-project' } });
  f.save('wrong-id', 'needle forbidden', { id: 'mismatch' });
  assert.deepEqual(
    new Set((await f.search('needle', 'project')).hits.map((hit) => hit.sessionId)),
    new Set(['session', 'neighbor']),
  );
  assert.deepEqual(
    (await f.search('needle')).hits.map((hit) => hit.sessionId),
    ['session'],
  );
  for (const request of [
    f.request('needle', 'project', 'new-session'),
    { ...f.request('needle'), workspaceId: 'other' },
    { ...f.request('needle'), localProjectId: 'other-project' },
    { ...f.request('needle'), scope: 'all' },
    { ...f.request('needle'), query: '' },
    { ...f.request('needle'), limit: 101 },
    { ...f.request('needle'), unexpected: true },
  ])
    await assert.rejects(searchHostSessions(f.host, request as any, 'project'));
  f.host.close();
  await assert.rejects(f.search('needle'));
});

test('metadata revocation excludes old indexed rows before result limit', async (t) => {
  const f = fixture(t);
  f.save('neighbor', 'needle neighbor');
  await f.search('needle', 'project');
  putMeta(f.store.meta, 'session-neighbor', { userId: 'revoked' });
  const result = await searchHostSessions(f.host, { ...f.request('needle', 'project'), limit: 1 });
  assert.deepEqual(
    result.hits.map((hit) => hit.sessionId),
    ['session'],
  );
  assert.equal(result.more, false);
  assert.equal(result.partial, false);
});

test('immutable host session scope must authorize neighbors before indexing and before cached results', async (t) => {
  const f = fixture(t);
  f.save('moved', 'needle forbidden moved history');
  const lease = f.host.projectLease(f.request('x'));
  f.store.reserveAttachmentScope({ ...lease, sessionId: 'moved', userId: 'previous-owner' });
  assert.throws(() => f.host.projectLease(f.request('needle', 'session', 'moved')));
  assert.equal(
    (await f.search('needle', 'project')).hits.some((hit) => hit.sessionId === 'moved'),
    false,
  );
  assert.equal(f.store.searchIndexVersion({ ...lease, sessionId: 'moved' }), undefined);
  f.save('cached', 'needle cached history');
  assert.equal(
    (await f.search('needle', 'project')).hits.some((hit) => hit.sessionId === 'cached'),
    true,
  );
  f.store.reserveAttachmentScope({ ...lease, sessionId: 'cached', workspaceId: 'old-workspace' });
  assert.throws(() => f.host.projectLease(f.request('needle', 'session', 'cached')));
  const result = await searchHostSessions(f.host, { ...f.request('needle', 'project'), limit: 1 });
  assert.deepEqual(
    result.hits.map((hit) => hit.sessionId),
    ['session'],
  );
  assert.equal(result.partial, false);
});

test('dirty source replacement removes stale hits and rolls index back on failed write', async (t) => {
  const f = fixture(t);
  await f.search('original');
  const scope = f.host.projectLease(f.request('x')),
    old = f.store.searchIndexVersion(scope);
  f.save('session', 'needle replacement');
  assert.ok(f.store.searchSource('session')!.revision > old!.revision);
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_search BEFORE INSERT ON search_entry BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  const failed = await f.search('original');
  assert.equal(failed.partial, true);
  assert.equal(failed.hits.length, 0);
  assert.deepEqual(f.store.searchIndexVersion(scope), old);
  assert.equal(
    f.store.journal.db
      .prepare("SELECT count(*) AS n FROM search_text WHERE body LIKE '%original%'")
      .get()!.n,
    1,
  );
  f.store.journal.db.exec('DROP TRIGGER fail_search');
  assert.equal((await f.search('original')).hits.length, 0);
  assert.equal((await f.search('replacement')).hits.length, 1);
});

test('preexisting histories migrate on open and fresh durable indexes survive restart without replacement', async (t) => {
  const f = fixture(t);
  f.store.journal.db.exec(
    'DROP TRIGGER search_source_insert; DROP TRIGGER search_source_update; DROP TABLE search_source',
  );
  f.restart();
  assert.equal(f.store.searchSource('session')!.revision, 1);
  assert.equal((await f.search('original')).hits.length, 1);
  const version = f.store.searchIndexVersion(f.host.projectLease(f.request('x')));
  f.restart();
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_search BEFORE INSERT ON search_entry BEGIN SELECT RAISE(ABORT,'must reuse fresh index'); END",
  );
  const result = await f.search('original');
  assert.equal(result.hits.length, 1);
  assert.equal(result.partial, false);
  assert.deepEqual(f.store.searchIndexVersion(f.host.projectLease(f.request('x'))), version);
});

test('bounded refresh reports unindexed sessions and subsequent manual search advances', async (t) => {
  const f = fixture(t);
  f.save('neighbor', 'needle neighbor');
  const first = await searchHostSessions(f.host, f.request('needle', 'project'), undefined, {
    sessions: 1,
  });
  assert.equal(first.partial, true);
  assert.deepEqual(
    first.hits.map((hit) => hit.sessionId),
    ['session'],
  );
  const second = await searchHostSessions(f.host, f.request('needle', 'project'), undefined, {
    sessions: 1,
  });
  assert.equal(second.partial, false);
  assert.equal(second.hits.length, 2);
  f.save('session', 'needle newer body');
  const bounded = await searchHostSessions(f.host, f.request('needle'), undefined, { bytes: 1 });
  assert.equal(bounded.partial, true);
  assert.equal(bounded.hits.length, 0);
});

test('large frozen diff history leaves visible messages searchable with explicit partial coverage', async (t) => {
  const f = fixture(t),
    lease = f.host.projectLease(f.request('x'));
  f.store.projectHistory.begin(lease, 'turn-session');
  f.store.projectHistory.saveBefore(lease, 'turn-session', snapshot('before-' + 'x'.repeat(10000)));
  const reference = f.store.projectHistory.finish(
    lease,
    'turn-session',
    undefined,
    snapshot('after-' + 'y'.repeat(10000)),
  );
  const doc = f.store.doc('session'),
    view = mirror(doc, 'session');
  view.setState((state) => {
    state.history[0]!.fileDiff = reference;
  });
  view.dispose();
  f.store.persist('session', doc);
  const result = await searchHostSessions(f.host, f.request('original'), undefined, {
    bytes: f.store.searchSource('session')!.bytes + 1000,
  });
  assert.equal(result.partial, true);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0]!.kind, 'message');
  const cached = await f.search('original');
  assert.equal(cached.partial, true);
  assert.equal(cached.hits.length, 1);
});

test('source changes and unsaved output during refresh cannot expose stale snippets', async (t) => {
  const f = fixture(t);
  const result = await searchHostSessions(f.host, f.request('original'), undefined, {
    checkpoint(stage) {
      if (stage === 'after-refresh') f.save('session', 'updated during refresh');
    },
  });
  assert.equal(result.partial, true);
  assert.equal(result.hits.length, 0);
  assert.equal((await f.search('updated')).hits.length, 1);
  f.host.settlementFailures.set('session', f.store.doc('session'));
  assert.equal((await f.search('updated')).hits.length, 0);
  assert.equal((await f.search('updated')).partial, true);
});

test('lease is checked after every asynchronous refresh boundary', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    searchHostSessions(f.host, f.request('needle'), undefined, {
      checkpoint(stage) {
        if (stage === 'after-refresh') f.store.workspace.userId = 'changed-owner';
      },
    }),
  );
});

test('dirty markers roll back with session writes and missing index rows are rebuilt', async (t) => {
  const f = fixture(t);
  await f.search('original');
  const source = f.store.searchSource('session');
  assert.throws(() =>
    f.store.transaction(() => {
      f.store.persist('session', f.store.doc('session'));
      throw new Error('rollback');
    }),
  );
  assert.deepEqual(f.store.searchSource('session'), source);
  f.store.journal.db.exec('DELETE FROM search_document');
  assert.equal((await f.search('original')).hits.length, 1);
});

test('restart expires interactions on completed turns without changing their execution status', (t) => {
  const f = fixture(t);
  f.save('session', '', {}, [
    { type: 'question', status: 'pending' },
    { type: 'steer', status: 'pending' },
  ]);
  f.restart();
  const view = mirror(f.store.doc('session'), 'session'),
    turn = view.getState().history[0]!;
  assert.equal(turn.finished, true);
  assert.equal(turn.status, 'completed');
  assert.equal((turn.items![0] as any).status, 'expired');
  assert.equal((turn.items![1] as any).status, 'unknown');
  view.dispose();
});
