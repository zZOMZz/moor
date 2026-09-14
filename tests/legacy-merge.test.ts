import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLegacyToolState } from '../src/web/legacy-merge';

test('legacy tool merges preserve later edits and cannot replace unknown originals through whole-object shortcuts', () => {
  const previous = {
    version: 1,
    cacheRevision: 1,
    draft: { text: 'old', selection: 'old' },
    pending: { request: { operationId: 'one', body: 'exact one' } },
  };
  const incoming = {
    ...previous,
    draft: { text: 'source edit', selection: 'new' },
    pending: { request: { operationId: 'two', body: 'exact two' } },
  };
  assert.throws(() => mergeLegacyToolState(previous, incoming, previous), /未确认原请求/);
  const local = {
    ...previous,
    cacheRevision: 2,
    draft: { text: 'local edit', selection: 'old' },
    pending: undefined,
  };
  const merged = mergeLegacyToolState(previous, incoming, local) as any;
  assert.deepEqual(merged.draft, { text: 'local edit', selection: 'new' });
  assert.deepEqual(merged.pending, incoming.pending);
  assert.deepEqual(
    mergeLegacyToolState(previous, previous, local),
    local,
    'same source cannot resurrect a confirmed original',
  );
  assert.deepEqual(
    (mergeLegacyToolState(previous, { ...previous, pending: undefined }, previous) as any).pending,
    previous.pending,
    'source flags are not host confirmation',
  );
  assert.throws(
    () =>
      mergeLegacyToolState(
        previous,
        { ...incoming, pending: { request: { operationId: 'one', body: 'changed original' } } },
        undefined,
      ),
    /同一旧工具操作编号/,
  );
  assert.deepEqual(previous.pending.request, { operationId: 'one', body: 'exact one' });
});

test('legacy tool merging keeps nested revisions, independent resources and full execution bindings', () => {
  const previous = { execution: { revision: 1, branch: 'main' }, resources: [{ id: 'old' }] };
  const incoming = {
    execution: { revision: 2, branch: 'source' },
    resources: [{ id: 'old' }, { id: 'source' }],
  };
  const local = {
    execution: { revision: 3, branch: 'local' },
    resources: [{ id: 'old' }, { id: 'local' }],
  };
  const result = mergeLegacyToolState(previous, incoming, local) as any;
  assert.deepEqual(result.execution, local.execution);
  assert.deepEqual(
    result.resources.map((item: any) => item.id),
    ['old', 'local', 'source'],
  );
  assert.throws(
    () =>
      mergeLegacyToolState(
        { target: { account: 'owner' } },
        { target: { account: 'other' } },
        { target: { account: 'owner' } },
      ),
    /执行身份/,
  );
});

test('ordinary draft fields named pending remain user text rather than operation records', () => {
  const previous = { drafts: { pending: { answer: 'old' } } };
  const incoming = { drafts: { pending: { answer: 'source' } } };
  const local = { drafts: { pending: { answer: 'local' } } };
  assert.deepEqual(mergeLegacyToolState(previous, incoming, local), local);
});
