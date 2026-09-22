import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionPageRequestSchema, type SessionPageRequest } from '@moor/protocol/session-page';
import type { SessionMetadata } from '@moor/protocol/session-responses';
import { SESSION_PAGE_CACHE_LIMITS } from '../../apps/web/src/features/workspace/workspace-session-pages';
import { paginationFixture } from '../fixtures/workspace-pagination';

const revision = 'sha256:' + 'a'.repeat(64);
const page = (request: SessionPageRequest, items: SessionMetadata[] = [], rev = revision) => {
  const { cursor: _cursor, ...body } = request;
  return { ...body, confirmed: true, revision: rev, items, nextCursor: null };
};
const dataKeys = (values: Map<string, unknown>) =>
  [...values.keys()].filter((key) => key.includes('moor-workspace-session-page-v1'));
const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('page cache evicts only its own oldest metadata keys and preserves other scopes, drafts and unknown operations', async (t) => {
  const f = await paginationFixture(t),
    [a, b] = f.catalog.targets,
    scope = { source: 'local' as const, target: a.target };
  await f.store.saveDraft(scope, 'draft', 0, 'preserve draft', {}, () => {});
  await f.store.stage(
    scope,
    {
      kind: 'control',
      value: {
        controlVersion: 1,
        action: 'create',
        operationId: 'unknown-create',
        sessionId: 'draft',
        workspaceId: a.target.workspaceId,
        localProjectId: a.target.localProjectId,
        userId: a.target.userId,
        machineId: a.target.machineId,
        agentId: 'agent',
      },
    },
    undefined,
    () => {},
  );
  const original = await f.store.read(scope, () => {}, 'draft');
  const neighbor = await f.controller.listProjectSessionPage('local', b.target);
  const requests: SessionPageRequest[] = [];
  for (let i = 0; i < 65; i++) {
    const request = sessionPageRequestSchema.parse({
      pageVersion: 1,
      workspaceId: a.target.workspaceId,
      localProjectId: a.target.localProjectId,
      query: 'query-' + i,
    });
    requests.push(request);
    await f.store.sessionPage(scope, () => {}, request, page(request));
  }
  assert.equal(
    dataKeys(f.memory.values).length,
    65,
    '64 pages here and the untouched neighboring page',
  );
  assert.equal(await f.store.sessionPage(scope, () => {}, requests[0]), undefined);
  assert.ok(await f.store.sessionPage(scope, () => {}, requests.at(-1)!));
  assert.deepEqual(await f.store.read(scope, () => {}, 'draft'), original);
  assert.equal((await f.store.readDraft(scope, 'draft', () => {})).text, 'preserve draft');
  f.failures.set(b.target.localProjectId, {
    code: 'network',
    status: null,
    rejected: false,
    message: 'offline',
  });
  const cached = await f.controller.listProjectSessionPage('local', b.target, { fresh: true });
  assert.deepEqual(cached.items, neighbor.items);
  assert.equal(cached.source, 'cache');
  assert.equal(
    [...f.memory.values.values()].some((value) => value === null),
    false,
    'eviction physically deletes keys',
  );
});

test('new first-page revisions atomically retire old cursor pages while preserving other filter views', async (t) => {
  const f = await paginationFixture(t),
    target = f.catalog.targets[0].target,
    scope = { source: 'local' as const, target };
  const first = sessionPageRequestSchema.parse({
    pageVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
  });
  const tail = { ...first, cursor: 'oldCursor' },
    other = { ...first, query: 'another-filter' };
  await f.store.sessionPage(scope, () => {}, first, page(first));
  await f.store.sessionPage(scope, () => {}, tail, page(tail));
  await f.store.sessionPage(scope, () => {}, other, page(other));
  f.memory.failDeletion = true;
  const before = structuredClone(f.memory.values);
  await assert.rejects(
    f.store.sessionPage(scope, () => {}, first, page(first, [], 'sha256:' + 'b'.repeat(64))),
    /atomic cache failure/,
  );
  assert.deepEqual(f.memory.values, before);
  f.memory.failDeletion = false;
  await f.store.sessionPage(scope, () => {}, first, page(first, [], 'sha256:' + 'b'.repeat(64)));
  assert.equal(await f.store.sessionPage(scope, () => {}, tail), undefined);
  assert.ok(await f.store.sessionPage(scope, () => {}, other));
  assert.equal(dataKeys(f.memory.values).length, 2);
});

test('damaged page heads cannot nominate arbitrary keys or another scope for deletion', async (t) => {
  const f = await paginationFixture(t),
    target = f.catalog.targets[0].target,
    scope = { source: 'local' as const, target };
  await f.store.saveDraft(scope, 'draft', 0, 'private draft remains', {}, () => {});
  await f.store.stage(
    scope,
    {
      kind: 'control',
      value: {
        controlVersion: 1,
        action: 'create',
        operationId: 'unknown-poison',
        sessionId: 'draft',
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
  const request = sessionPageRequestSchema.parse({
    pageVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
  });
  await f.store.sessionPage(scope, () => {}, request, page(request));
  const index = [...f.memory.values.keys()].find((key) =>
    key.includes('moor-workspace-session-pages-index-v1'),
  )!;
  const draftKey = [...f.memory.values.keys()].find((key) => key.includes('moor-desktop-draft'))!;
  const operationKey = [...f.memory.values.keys()].find(
    (key) => key.includes('moor-desktop-record-v2') && key.includes('unknown-poison'),
  )!;
  const valid: any = structuredClone(f.memory.values.get(index));
  assert(draftKey);
  assert(operationKey);
  for (const change of [
    'raw-draft-key',
    'raw-operation-key',
    'foreign-scope',
    'duplicate',
  ] as const) {
    const corrupt = structuredClone(valid);
    if (change === 'raw-draft-key') corrupt.pages[0].key = draftKey;
    if (change === 'raw-operation-key') corrupt.pages[0].key = operationKey;
    if (change === 'foreign-scope') corrupt.pages[0].request.localProjectId = 'another-project';
    if (change === 'duplicate') corrupt.pages.push(structuredClone(corrupt.pages[0]));
    f.memory.values.set(index, corrupt);
    const before = structuredClone(f.memory.values);
    await assert.rejects(
      f.store.sessionPage(scope, () => {}, request, page(request, [], 'sha256:' + 'b'.repeat(64))),
    );
    assert.deepEqual(f.memory.values, before);
    assert.equal((await f.store.readDraft(scope, 'draft', () => {})).text, 'private draft remains');
  }
});

test('serialized metadata pages and their small reference head stay within the byte budget', async (t) => {
  const f = await paginationFixture(t),
    target = { ...f.catalog.targets[0].target, userId: 'u'.repeat(1000) },
    scope = { source: 'local' as const, target };
  for (let n = 0; n < 50; n++) {
    const request = sessionPageRequestSchema.parse({
      pageVersion: 1,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      limit: 100,
      cursor: 'cursor_' + n,
    });
    const items: SessionMetadata[] = Array.from({ length: 100 }, (_, i) => ({
      id: `session-${n}-${i}`,
      userId: target.userId,
      machineId: target.machineId,
      project: { kind: 'local', localProjectId: target.localProjectId },
      agentConfigId: 'historical-agent',
      cliType: 'c'.repeat(200),
      agentType: 'a'.repeat(200),
      title: '字'.repeat(220),
      lastMessageAt: 100 - i,
    }));
    await f.store.sessionPage(scope, () => {}, request, page(request, items));
  }
  const values = [...f.memory.values.entries()].filter(([key]) =>
    key.includes('moor-workspace-session-page'),
  );
  assert(dataKeys(f.memory.values).length < 50);
  assert(dataKeys(f.memory.values).length <= SESSION_PAGE_CACHE_LIMITS.pages);
  assert(
    values.reduce((sum, [, value]) => sum + utf8(value), 0) <= SESSION_PAGE_CACHE_LIMITS.bytes,
  );
  assert(values.every(([, value]) => value !== null));
});
