import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ACTOR_FEATURE,
  ATTENTION_FEATURE,
  FOLLOWUP_FEATURE,
  type AttentionItem,
  type AttentionDetail,
  type AttentionPage,
} from '@moor/protocol/attention';
import { ApiError } from '../src/platform/api';
import {
  AttentionController,
  attentionEndpoint,
  attentionGroups,
  attentionItemKey,
  attentionOperationId,
  attentionPendingKey,
  attentionScopeKey,
  attentionPending,
  deliverAttention,
  pendingAttentionSchema,
  routeAttention,
  type AttentionContext,
  type AttentionDependencies,
  type AttentionRoute,
  type AttentionTarget,
  type PendingAttention,
} from '../src/features/attention/attention';
import { AttentionWorkbench } from '../src/features/attention/attention-ui';

const route: AttentionRoute = {
  origin: 'https://synthetic.invalid',
  actor: { kind: 'relay', authorityId: 'authority-a', accountId: 'account-a' },
  catalogWorkspaceId: 'workspace',
  projectId: 'project',
  replicaId: 'replica',
  executionDeviceId: 'device',
  machineId: 'machine',
  runtimeWorkspaceId: 'runtime',
  localProjectId: 'local-project',
};
const target: AttentionTarget = {
  ...route,
  hostName: '合成 Mac',
  projectName: '合成项目',
  online: true,
  features: [ATTENTION_FEATURE, ACTOR_FEATURE, FOLLOWUP_FEATURE],
};
const context: AttentionContext = {
  origin: route.origin,
  actor: route.actor,
  workspaceId: route.catalogWorkspaceId,
  workspaceName: '合成工作区',
  connected: true,
  targets: [target],
};
const seed: AttentionItem = {
  itemId: 'outcome-a',
  sessionId: 'session-a',
  localProjectId: 'local-project',
  assistantTurnId: 'assistant-a',
  userTurnId: 'user-a',
  kind: 'outcome',
  lifecycle: 'ended',
  eventRevision: 1,
  observationRevision: 0,
  sequence: 1,
  occurredAt: 1,
  summary: '合成执行结果',
  seenRevision: 0,
  disposition: 'pending',
  cause: 'agent_returned',
};
const selection = { replicaId: route.replicaId, sessionId: seed.sessionId, itemId: seed.itemId };
const original: PendingAttention = {
  route,
  sessionId: seed.sessionId,
  itemId: seed.itemId,
  operation: {
    kind: 'disposition',
    body: {
      operationId: 'check-once',
      eventRevision: 1,
      observationRevision: 0,
      disposition: 'checked',
    },
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function atomicCache(storage = new Map<string, unknown>()) {
  return {
    read: async <T>(key: string) => structuredClone(storage.get(key)) as T | undefined,
    compareAndSet: async (key: string, expected: unknown, value: unknown) => {
      if (JSON.stringify(storage.get(key)) !== JSON.stringify(expected)) return false;
      storage.set(key, structuredClone(value));
      return true;
    },
  };
}
function fixture(overrides: Partial<AttentionDependencies> = {}) {
  let item = structuredClone(seed),
    sequence = 0;
  const storage = new Map<string, unknown>(),
    calls: { path: string; body: any }[] = [];
  const detail = (): AttentionDetail => ({
    item: structuredClone(item),
    title: '合成会话',
    isArchived: false,
    turn: { items: [{ text: '<script>synthetic</script>' }] },
    userTurn: { items: [{ text: '原始输入' }] },
  });
  const page = (view = 'pending'): AttentionPage => ({
    sessions: (
      view === 'pending'
        ? ['pending', 'needs_followup'].includes(item.disposition)
        : ['checked', 'continued'].includes(item.disposition)
    )
      ? [
          {
            sessionId: item.sessionId,
            title: '合成会话',
            isArchived: false,
            items: [structuredClone(item)],
            itemCount: 1,
          },
        ]
      : [],
    total: (
      view === 'pending'
        ? ['pending', 'needs_followup'].includes(item.disposition)
        : ['checked', 'continued'].includes(item.disposition)
    )
      ? 1
      : 0,
    version: item.observationRevision,
  });
  const deps: AttentionDependencies = {
    now: () => 100,
    uuid: () => 'synthetic-operation-' + ++sequence,
    changed: () => {},
    read: async <T>(key: string) => structuredClone(storage.get(key)) as T | undefined,
    compareAndSet: atomicCache(storage).compareAndSet,
    write: async (key, value) => {
      storage.set(key, structuredClone(value));
    },
    readSessionDraft: async () => '',
    prepareTurn: async () => ({
      operationId: 'continue-once',
      workspaceId: 'runtime',
      sessionId: 'session-a',
      kind: 'turn',
      expectedTurnId: 'user-a',
      update: 'AA==',
    }),
    continued: async () => {},
    request: async (path, body) => {
      calls.push({ path, body: structuredClone(body) });
      const url = new URL(path, route.origin);
      if (!body)
        return url.pathname.endsWith('/' + item.itemId)
          ? detail()
          : page(url.searchParams.get('view') ?? 'pending');
      assert.ok(
        storage.get(
          attentionPendingKey({
            route,
            sessionId: item.sessionId,
            itemId: item.itemId,
            ...(url.pathname.endsWith('/seen')
              ? {
                  operation: {
                    kind: 'seen' as const,
                    body: body as { operationId: string; eventRevision: number },
                  },
                }
              : {}),
          }),
        ),
        'persist before transmission',
      );
      const request = body as any;
      if (url.pathname.endsWith('/seen')) item = { ...item, seenRevision: request.eventRevision };
      if (url.pathname.endsWith('/disposition'))
        item = {
          ...item,
          disposition: request.disposition,
          observationRevision: item.observationRevision + 1,
        };
      if (url.pathname.endsWith('/continue'))
        item = {
          ...item,
          disposition: 'continued',
          observationRevision: item.observationRevision + 1,
        };
      return {
        accepted: true,
        delivered: true,
        operationId: request.operationId ?? request.mutation.operationId,
        item: structuredClone(item),
      };
    },
    ...overrides,
  };
  const controller = new AttentionController(deps);
  controller.configure(structuredClone(context));
  return { controller, deps, storage, calls, detail, page, getItem: () => item };
}

test('attention keys isolate authority, actor kind, origin, host, runtime, project, session and item', () => {
  const key = attentionScopeKey(route);
  for (const field of ['origin', 'machineId', 'runtimeWorkspaceId', 'localProjectId'] as const)
    assert.notEqual(attentionScopeKey({ ...route, [field]: 'another' }), key, field);
  for (const actor of [
    { ...route.actor, kind: 'local' as const },
    { ...route.actor, authorityId: 'another' },
    { ...route.actor, accountId: 'another' },
  ])
    assert.notEqual(attentionScopeKey({ ...route, actor }), key);
  assert.notEqual(attentionItemKey(route, 's1', 'i1'), attentionItemKey(route, 's2', 'i1'));
  assert.notEqual(attentionItemKey(route, 's1', 'i1'), attentionItemKey(route, 's1', 'i2'));
  assert.throws(
    () => routeAttention(original, { ...route, executionDeviceId: 'repaired-device' }),
    /绑定已改变/,
  );
  assert.equal(
    routeAttention(original, { ...route, catalogWorkspaceId: 'moved', replicaId: 'new-replica' })
      .route.replicaId,
    'new-replica',
  );
});

test('unknown confirmations remain durable and an explicit retry uses the exact original operation', async () => {
  const writes = new Map<string, unknown>(),
    sent: unknown[] = [];
  let pending: PendingAttention | undefined;
  const deps = {
    ...atomicCache(writes),
    onPending: (value?: PendingAttention) => {
      pending = value;
    },
    request: async (path: string, body?: unknown) => {
      assert.ok(writes.get(attentionPendingKey(original)));
      sent.push({ path, body });
      if (sent.length === 1) throw new ApiError('synthetic reply lost', 0);
      return {
        accepted: true,
        delivered: true,
        operationId: 'check-once',
        item: { ...seed, disposition: 'checked' },
      };
    },
  };
  await assert.rejects(deliverAttention(original, deps), /reply lost/);
  assert.deepEqual(pending, original);
  const restored = pendingAttentionSchema.parse(writes.get(attentionPendingKey(original)));
  assert.equal(sent.length, 1);
  await deliverAttention(restored, deps);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(pending, undefined);
});

test('storage failure and changed authorization prevent transmission; wrong receipts preserve pending', async () => {
  let transmissions = 0;
  await assert.rejects(
    deliverAttention(original, {
      ...atomicCache(),
      compareAndSet: async () => {
        throw new Error('storage failed');
      },
      request: async () => {
        transmissions++;
      },
      onPending: () => assert.fail('not durable'),
    }),
    /storage failed/,
  );
  assert.equal(transmissions, 0);
  let authorized = true;
  await assert.rejects(
    deliverAttention(original, {
      ...atomicCache(),
      compareAndSet: async () => {
        authorized = false;
        return true;
      },
      isAuthorized: () => authorized,
      request: async () => {
        transmissions++;
      },
      onPending: () => {},
    }),
    /访问范围/,
  );
  assert.equal(transmissions, 0);
  let pending: PendingAttention | undefined;
  await assert.rejects(
    deliverAttention(original, {
      ...atomicCache(),
      onPending: (value) => {
        pending = value;
      },
      request: async () => ({ accepted: true, delivered: true, operationId: 'wrong-id' }),
    }),
    /主机确认/,
  );
  assert.deepEqual(pending, original);
});

test('background reads never mark seen, opening only marks seen, and checking preserves the selected view', async () => {
  const f = fixture();
  await f.controller.refresh();
  assert.equal(f.calls.filter((call) => call.body).length, 0);
  await f.controller.open(selection);
  assert.equal(f.calls.filter((call) => call.body).length, 1);
  assert.match(f.calls.find((call) => call.body)!.path, /\/seen$/);
  assert.equal(f.getItem().disposition, 'pending');
  await f.controller.refresh();
  assert.equal(f.calls.filter((call) => call.path.endsWith('/seen')).length, 1);
  await f.controller.disposition('checked');
  assert.equal(f.controller.state.view, 'pending');
  assert.equal(f.controller.state.detail?.item.disposition, 'checked');
  assert.equal(f.controller.total(), 0);
  await f.controller.setView('processed');
  assert.equal(f.controller.total(), 1);
});

test('late pages from an old authority cannot appear after account scope changes', async () => {
  const first = deferred<unknown>();
  const started = deferred<void>();
  const f = fixture({
    request: async () => {
      started.resolve();
      return first.promise;
    },
  });
  const reading = f.controller.refresh();
  await started.promise;
  f.controller.configure({
    ...context,
    actor: { ...route.actor, authorityId: 'new-authority' },
    targets: [{ ...target, actor: { ...route.actor, authorityId: 'new-authority' } }],
  });
  first.resolve(f.page());
  await reading;
  assert.equal(f.controller.state.lists.length, 0);
  assert.equal(f.controller.state.detail, undefined);
});

test('late pre-check pages cannot restore a confirmed result to pending', async () => {
  const f = fixture();
  await f.controller.refresh();
  await f.controller.open(selection);
  const old = f.page(),
    release = deferred<unknown>(),
    started = deferred<void>();
  const request = f.deps.request;
  let defer = true;
  f.deps.request = async (path, body) => {
    if (!body && path.includes('?view=') && defer) {
      defer = false;
      started.resolve();
      return release.promise;
    }
    return request(path, body);
  };
  const reading = f.controller.refresh();
  await started.promise;
  await f.controller.disposition('checked');
  release.resolve(old);
  await reading;
  assert.equal(f.controller.total(), 0);
  assert.equal(f.controller.state.detail?.item.disposition, 'checked');
});

test('offline drafts preserve existing text; reconnect reads never submit and a manual share stays pending', async () => {
  const f = fixture({ readSessionDraft: async () => '已有草稿不可覆盖' });
  await f.controller.refresh();
  await f.controller.open(selection);
  f.controller.configure({ ...context, connected: false });
  await f.controller.createDraft();
  assert.equal(f.controller.state.draft?.text, '已有草稿不可覆盖');
  assert.match(f.controller.state.draft?.insertion ?? '', /继续检查/);
  f.controller.mergeDraft();
  assert.match(f.controller.state.draft?.text ?? '', /^已有草稿不可覆盖\n\n/);
  const before = f.calls.filter((call) => call.body).length;
  await f.controller.saveDraft();
  assert.equal(f.calls.filter((call) => call.body).length, before);
  f.controller.configure(context);
  await f.controller.refresh();
  assert.equal(f.calls.filter((call) => call.body).length, before);
  await f.controller.disposition('needs_followup');
  assert.equal(f.controller.state.detail?.item.disposition, 'needs_followup');
  assert.equal(f.controller.total(), 1);
  assert.equal(f.controller.state.draft?.shared, true);
});

test('failed draft storage never changes shared state and continue has no ordinary mutation fallback', async () => {
  const f = fixture();
  await f.controller.refresh();
  await f.controller.open(selection);
  await f.controller.createDraft();
  const write = f.deps.write;
  f.deps.write = async (key, value) => {
    if (key.endsWith('/draft')) throw new Error('draft disk full');
    return write(key, value);
  };
  const before = f.calls.filter((call) => call.body).length;
  await assert.rejects(f.controller.saveDraft(), /disk full/);
  assert.equal(f.calls.filter((call) => call.body).length, before);
  f.deps.write = write;
  await f.controller.saveDraft();
  await f.controller.sendContinue();
  assert.ok(f.calls.some((call) => call.path.endsWith('/continue')));
  assert.equal(
    f.calls.some((call) => call.path.includes('/mutations')),
    false,
  );
  assert.equal(f.controller.state.detail?.item.disposition, 'continued');
  assert.equal(f.controller.state.draft, undefined);
});

test('cached UI is read-only, escapes source text, and separate hosts never merge matching session ids', async () => {
  const f = fixture();
  await f.controller.refresh();
  await f.controller.open(selection);
  f.controller.configure({ ...context, connected: false });
  const html = renderToStaticMarkup(
    createElement(AttentionWorkbench, { controller: f.controller, onOpenSession: async () => {} }),
  );
  assert.match(html, /缓存内容/);
  assert.match(html, /disabled="">检查完成/);
  assert.match(html, /&lt;script&gt;synthetic&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const groups = attentionGroups([
    { target, cached: false, loading: false, page: f.page() },
    {
      target: {
        ...target,
        machineId: 'machine-b',
        executionDeviceId: 'device-b',
        replicaId: 'replica-b',
      },
      cached: false,
      loading: false,
      page: f.page(),
    },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(attentionOperationId(original.operation), 'check-once');
  assert.equal(attentionEndpoint(route, 'session/a', 'item/a').includes('session%2Fa'), true);
});

test('unconfirmed seen records use a separate channel and never lock a processing decision', async () => {
  const f = fixture(),
    request = f.deps.request;
  f.deps.request = async (path, body) => {
    const result = await request(path, body);
    if (path.endsWith('/seen')) throw new ApiError('seen reply lost', 0);
    return result;
  };
  await f.controller.refresh();
  await f.controller.open(selection);
  assert.ok(f.controller.state.seenPending);
  assert.equal(f.controller.state.pending, undefined);
  assert.equal(f.controller.state.busy, false);
  assert.equal(f.controller.state.detailFresh, true);
  await f.controller.disposition('checked');
  assert.equal(f.getItem().disposition, 'checked');
  assert.ok(f.controller.state.seenPending, 'unknown seen receipt remains manually retryable');
});

test('background refresh retains edits newer than the persisted draft', async () => {
  const f = fixture();
  await f.controller.refresh();
  await f.controller.open(selection);
  await f.controller.createDraft();
  await f.controller.saveDraft();
  f.controller.editDraft('尚未保存的新编辑');
  await f.controller.refresh();
  assert.equal(f.controller.state.draft?.text, '尚未保存的新编辑');
  assert.equal(f.controller.state.draft?.saved, false);
});

test('changing availability invalidates in-flight reads and unknown targets do not report zero', async () => {
  const release = deferred<unknown>(),
    started = deferred<void>();
  const f = fixture({
    request: async () => {
      started.resolve();
      return release.promise;
    },
  });
  assert.equal(f.controller.total(), undefined);
  const reading = f.controller.refresh();
  await started.promise;
  f.controller.configure({ ...context, connected: false });
  release.resolve(f.page());
  await reading;
  assert.equal(f.controller.state.lists[0].page, undefined);
  assert.equal(f.controller.total(), undefined);
  assert.equal(f.controller.state.detailFresh, false);
});

test('switching items while a request is pending does not leave the next item busy', async () => {
  const f = fixture();
  await f.controller.refresh();
  await f.controller.open(selection);
  const release = deferred<unknown>(),
    started = deferred<void>(),
    request = f.deps.request;
  f.deps.request = async (path, body) => {
    if (path.endsWith('/disposition')) {
      const response = await request(path, body);
      started.resolve();
      await release.promise;
      return response;
    }
    return request(path, body);
  };
  const writing = f.controller.disposition('checked');
  await started.promise;
  await f.controller.open({ ...selection, itemId: 'not-cached-yet' });
  assert.equal(f.controller.state.busy, false);
  release.resolve(undefined);
  await writing;
  assert.equal(f.controller.state.busy, false);
  assert.equal(f.controller.state.selected?.itemId, 'not-cached-yet');
});

test('historical outcomes explicitly reopened stay pending while unobserved user cancellations do not', () => {
  assert.equal(
    attentionPending({ ...seed, lifecycle: 'historical', observationRevision: 0 }),
    false,
  );
  assert.equal(
    attentionPending({ ...seed, lifecycle: 'historical', observationRevision: 1 }),
    true,
  );
  assert.equal(
    attentionPending({ ...seed, cause: 'user_canceled', observationRevision: 0 }),
    false,
  );
  assert.equal(attentionPending({ ...seed, cause: 'user_canceled', observationRevision: 1 }), true);
  assert.equal(
    attentionPending({ ...seed, disposition: 'checked', observationRevision: 1 }),
    false,
  );
});

test('old pairing pending records cannot overwrite a replacement pairing pending record', () => {
  const replacement = { ...original, route: { ...route, executionDeviceId: 'new-device-binding' } };
  assert.notEqual(attentionPendingKey(original), attentionPendingKey(replacement));
  assert.throws(() => routeAttention(original, replacement.route), /绑定已改变/);
});

test('late acknowledgement cannot clear a newer operation stored by another page', async () => {
  const storage = new Map<string, unknown>(),
    release = deferred<void>(),
    started = deferred<void>();
  let pending: PendingAttention | undefined;
  const acknowledgement = { accepted: true, delivered: true, operationId: 'check-once' };
  let calls = 0;
  const deps = {
    ...atomicCache(storage),
    onPending: (value?: PendingAttention) => {
      pending = value;
    },
    request: async () => {
      if (++calls === 1) {
        started.resolve();
        await release.promise;
      }
      return acknowledgement;
    },
  };
  const delayed = deliverAttention(original, deps);
  await started.promise;
  await deliverAttention(original, deps);
  const newer: PendingAttention = {
    ...original,
    operation: {
      kind: 'disposition',
      body: {
        ...(original.operation.body as any),
        operationId: 'new-decision',
        disposition: 'pending',
      },
    },
  };
  storage.set(attentionPendingKey(newer), structuredClone(newer));
  release.resolve();
  await delayed;
  assert.deepEqual(storage.get(attentionPendingKey(newer)), newer);
  assert.deepEqual(pending, newer, 'old response does not clear the new UI pending slot');
  let sent = false;
  await assert.rejects(
    deliverAttention(original, {
      ...deps,
      request: async () => {
        sent = true;
      },
    }),
    /另一页面/,
  );
  assert.equal(sent, false);
});

test('draft edits made during storage are retained and stay unsaved', async () => {
  const f = fixture();
  await f.controller.refresh();
  await f.controller.open(selection);
  await f.controller.createDraft();
  const write = f.deps.write,
    release = deferred<void>(),
    started = deferred<void>();
  f.deps.write = async (key, value) => {
    if (key.endsWith('/draft')) {
      started.resolve();
      await release.promise;
    }
    await write(key, value);
  };
  const saving = f.controller.saveDraft();
  await started.promise;
  f.controller.editDraft('保存期间的新编辑');
  release.resolve();
  await saving;
  assert.equal(f.controller.state.draft?.text, '保存期间的新编辑');
  assert.equal(f.controller.state.draft?.saved, false);
  assert.equal(f.getItem().disposition, 'pending');
});

test('unscoped legacy drafts are not adopted into the attention actor scope', async () => {
  const f = fixture({ readSessionDraft: async () => ({ text: '', unscoped: true }) });
  await f.controller.refresh();
  await f.controller.open(selection);
  await f.controller.createDraft();
  assert.match(f.controller.state.notice, /未关联当前账号/);
  assert.match(f.controller.state.draft?.text ?? '', /合成执行结果/);
});
