import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, type RuntimeWorkspace } from '@moor/protocol/protocol';
import type { SessionMetadata } from '@moor/protocol/session-responses';
import {
  SESSION_PAGE_FEATURE,
  SESSION_PAGE_LIMITS,
  sessionPageRequestSchema,
  validateSessionPageResult,
  type SessionPageRequest,
} from '@moor/protocol/session-page';
import { readSessionPage } from '@moor/host/sessions/page';
import { HostCommandDispatcher } from '@moor/host/commands/host-command';
import { syntheticSessionPageIndex } from '../fixtures/session-page-index';
const opened: { close(): void }[] = [];
afterEach(() => {
  for (const item of opened.splice(0)) item.close();
});

function fixture(count = 85) {
  const workspace: RuntimeWorkspace = {
    id: 'runtime-a',
    name: 'Synthetic',
    userId: 'owner-a',
    machineId: 'machine-a',
    projects: ['project-a', 'project-b'].map((id) => ({
      id,
      name: id,
      rootPath: '/synthetic/' + id,
    })),
    agents: [],
    features: [SESSION_PAGE_FEATURE],
  };
  const rows: SessionMetadata[] = Array.from({ length: count }, (_, index) => ({
    id: 'session-' + String(index).padStart(3, '0'),
    userId: workspace.userId,
    machineId: workspace.machineId,
    project: { kind: 'local', localProjectId: 'project-a' },
    agentConfigId: 'agent-a',
    cliType: 'fixture',
    agentType: 'fixture',
    title: 'Task ' + index,
    lastMessageAt: Math.floor(index / 2),
    metadataRevision: 0,
    isPinned: index === 0,
    isArchived: false,
  }));
  const calls: string[] = [];
  const projection = syntheticSessionPageIndex(rows);
  opened.push(projection);
  const source = { workspace, index: projection.index };
  const readPage = (input: SessionPageRequest, project?: string) => {
    projection.sync();
    if (
      input.workspaceId === workspace.id &&
      project === input.localProjectId &&
      workspace.projects.some((p) => p.id === project)
    )
      calls.push(project);
    return readSessionPage(source, input, project);
  };
  const request = (extra: Partial<SessionPageRequest> = {}) =>
    sessionPageRequestSchema.parse({
      pageVersion: 1,
      workspaceId: workspace.id,
      localProjectId: 'project-a',
      ...extra,
    });
  const page = (extra: Partial<SessionPageRequest> = {}) => {
    const input = request(extra);
    return readPage(input, input.localProjectId);
  };
  return { rows, workspace, source, calls, request, page, readPage };
}
const status = (code: number) => (error: unknown) =>
  error instanceof AppError && error.status === code;

test('project pages bound transfer to 30 by default, preserve stable ordering and expose every item once', () => {
  const f = fixture();
  const first = f.page();
  assert.equal(first.items.length, 30);
  assert.equal(first.items[0].id, 'session-000');
  assert.equal(first.items[1].id, 'session-084');
  assert.equal(first.items[2].id, 'session-082');
  assert.equal(first.items[3].id, 'session-083');
  const seen = first.items.map((item) => item.id);
  let cursor = first.nextCursor;
  while (cursor) {
    const page = f.page({ cursor });
    assert(page.items.length <= 30);
    assert.equal(page.revision, first.revision);
    assert(Buffer.byteLength(JSON.stringify(page)) <= SESSION_PAGE_LIMITS.responseBytes);
    seen.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 85);
  assert.equal(new Set(seen).size, 85);
  assert.deepEqual(f.calls, ['project-a', 'project-a', 'project-a']);
  assert.equal(f.page({ limit: 100 }).items.length, 85);
});

test('archived, pinned and title/id query filters have explicit bounded semantics', () => {
  const f = fixture(5);
  f.rows[0].title = 'Needle pinned';
  f.rows[1].title = 'Needle archived';
  f.rows[1].isArchived = true;
  f.rows[2].title = 'NEEDLE active';
  const page = f.page({ query: ' Needle ' });
  assert.equal(page.query, 'Needle');
  assert.deepEqual(
    new Set(page.items.map((item) => item.id)),
    new Set(['session-000', 'session-002']),
  );
  assert.deepEqual(
    f.page({ pinned: 'pinned' }).items.map((item) => item.id),
    ['session-000'],
  );
  assert.equal(f.page({ pinned: 'unpinned', archived: 'all' }).items.length, 4);
  assert.deepEqual(
    f.page({ archived: 'archived' }).items.map((item) => item.id),
    ['session-001'],
  );
  assert.deepEqual(
    f.page({ query: 'session-003' }).items.map((item) => item.id),
    ['session-003'],
  );
  assert.equal(f.page({ query: 'absent' }).nextCursor, null);
});

test('cursors cannot migrate between filters, page sizes or authenticated project/host identities', () => {
  const f = fixture(),
    cursor = f.page().nextCursor!;
  for (const changes of [
    { query: 'Task' },
    { archived: 'all' as const },
    { pinned: 'unpinned' as const },
    { limit: 10 },
  ])
    assert.throws(() => f.page({ cursor, ...changes }), status(409));
  for (const key of ['userId', 'machineId', 'id'] as const) {
    const other = fixture();
    other.workspace[key] = 'another';
    for (const row of other.rows) {
      row.userId = other.workspace.userId;
      row.machineId = other.workspace.machineId;
    }
    assert.throws(() => other.page({ cursor }), status(409));
  }
  for (const row of f.rows) row.project.localProjectId = 'project-b';
  assert.throws(() => f.page({ cursor, localProjectId: 'project-b' }), status(409));
});

test('any project metadata change invalidates the old cursor even if no timestamp or revision was advanced', () => {
  for (const change of ['title', 'revision', 'pin', 'archive', 'insert', 'remove'] as const) {
    const f = fixture(),
      cursor = f.page().nextCursor!;
    if (change === 'title') f.rows[0].title = 'renamed without revision';
    if (change === 'revision') f.rows[0].metadataRevision = 1;
    if (change === 'pin') f.rows[0].isPinned = false;
    if (change === 'archive') f.rows[0].isArchived = true;
    if (change === 'insert') f.rows.push({ ...f.rows[0], id: 'new-session' });
    if (change === 'remove') f.rows.pop();
    assert.throws(() => f.page({ cursor }), status(409), change);
  }
  const f = fixture(),
    cursor = f.page().nextCursor!;
  f.rows.push({
    ...f.rows[0],
    id: 'other-project-session',
    project: { kind: 'local', localProjectId: 'project-b' },
  });
  assert.doesNotThrow(() => f.page({ cursor }));
  f.rows.reverse();
  assert.doesNotThrow(() => f.page({ cursor }));
});

test('malformed requests and opaque cursors cannot widen a project read', () => {
  const f = fixture();
  for (const bad of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { query: 'x'.repeat(201) },
    { query: 'line\nfeed' },
    { archived: true },
    { pinned: true },
    { cursor: '' },
    { cursor: 'x'.repeat(2049) },
    { cursor: '../bad' },
    { arbitrary: 'field' },
  ])
    assert.equal(sessionPageRequestSchema.safeParse({ ...f.request(), ...bad }).success, false);
  assert.throws(() => readSessionPage(f.source, f.request(), undefined), status(400));
  assert.throws(() => readSessionPage(f.source, f.request(), 'project-b'), status(400));
  assert.throws(() => f.page({ localProjectId: 'unknown' }), status(404));
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.page({ cursor: 'bm90LWpzb24' }), status(409));
  const cursor = JSON.parse(Buffer.from(f.page().nextCursor!, 'base64url').toString());
  assert.throws(
    () =>
      f.page({
        cursor: Buffer.from(
          JSON.stringify({
            version: 1,
            binding: cursor.binding,
            revision: cursor.revision,
            offset: 30,
          }),
        ).toString('base64url'),
      }),
    status(409),
  );
  assert.throws(
    () =>
      f.page({
        cursor: Buffer.from(
          JSON.stringify({ ...cursor, position: { ...cursor.position, id: 'absent-session' } }),
        ).toString('base64url'),
      }),
    status(409),
  );
  for (const offset of [0, -1, 999999]) {
    assert.throws(
      () =>
        f.page({
          cursor: Buffer.from(JSON.stringify({ ...cursor, offset })).toString('base64url'),
        }),
      status(409),
    );
  }
});

test('page schemas reject mismatched echoes, foreign rows, duplicates, unsorted pages and nonadvancing cursors', () => {
  const f = fixture(3),
    request = f.request(),
    page = f.page();
  for (const raw of [
    { ...page, localProjectId: 'other' },
    { ...page, archived: 'all' },
    { ...page, limit: 20 },
    { ...page, query: 'different' },
    { ...page, items: [page.items[0], page.items[0]] },
    { ...page, items: [...page.items].reverse() },
    { ...page, items: [{ ...page.items[0], project: { kind: 'local', localProjectId: 'other' } }] },
    { ...page, items: [{ ...page.items[0], isArchived: true }] },
    { ...page, items: [], nextCursor: 'abc' },
    { ...page, surprise: 'private' },
  ])
    assert.throws(() => validateSessionPageResult(request, raw));
  assert.throws(() =>
    validateSessionPageResult({ ...request, cursor: 'abc' }, { ...page, nextCursor: 'abc' }),
  );
  const oversized = { ...page, extra: 'x'.repeat(SESSION_PAGE_LIMITS.responseBytes) };
  assert.throws(() => validateSessionPageResult(request, oversized), status(502));
});

test('dispatcher binds the page body to its project route and calls no execution operation', async () => {
  const f = fixture();
  const dispatcher = new HostCommandDispatcher({
    ready: () => true,
    workspace: () => ({ ...f.source, readSessionPage: f.readPage, closed: false }) as never,
    hasOperation() {
      throw Error('Read must not consult or write an operation');
    },
  });
  const command = {
    method: 'sessions-page',
    workspaceId: f.workspace.id,
    localProjectId: 'project-a',
    params: f.request(),
  };
  const result: any = await dispatcher.execute(command);
  assert.equal(result.items.length, 30);
  assert.deepEqual(f.calls, ['project-a']);
  await assert.rejects(
    dispatcher.execute({ ...command, localProjectId: 'project-b' }),
    status(400),
  );
  await assert.rejects(
    dispatcher.execute({ ...command, params: { ...f.request(), workspaceId: 'other' } }),
    status(400),
  );
  assert.equal(f.calls.length, 1);
});
