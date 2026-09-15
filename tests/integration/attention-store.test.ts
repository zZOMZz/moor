import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '@moor/host/persistence/store';
import { mirror, putMeta } from '@moor/session/model';
import type { AttentionContext, AttentionContinue } from '@moor/protocol/attention';

function fixture(file = ':memory:') {
  let now = 1000;
  const store = new RuntimeStore(file, { now: () => now });
  const project = { id: 'project-a', name: 'Synthetic project', rootPath: '/synthetic/project' };
  store.machine.set(['localProject', project.id], project);
  store.saveMachine();
  const context: AttentionContext = {
    actor: { kind: 'relay', authorityId: 'authority-a', accountId: 'account-a' },
    executionDeviceId: 'device-a',
    machineId: store.workspace.machineId,
    catalogWorkspaceId: 'catalog-a',
    projectId: 'logical-a',
    replicaId: 'replica-a',
    runtimeWorkspaceId: store.workspace.id,
    localProjectId: project.id,
  };
  function session(id = 'session-a', finished = true) {
    putMeta(store.meta, 'session-' + id, {
      id,
      title: id,
      project: { localProjectId: project.id },
      status: { type: finished ? 'idle' : 'working' },
      isArchived: false,
    });
    const doc = store.doc(id),
      view = mirror(doc, id);
    view.setState((state) => {
      state.history.push({
        id: 'assistant-' + id,
        userTurnId: 'user-' + id,
        role: 'assistant',
        userId: undefined,
        read: undefined,
        inputConfig: undefined,
        fileDiff: undefined,
        timestamp: '2026-01-01T00:00:00Z',
        finished,
        status: finished ? 'handled' : undefined,
        items: [{ type: 'text', text: 'Synthetic result' }],
      });
    });
    view.dispose();
    store.persist(id, doc);
    return {
      sessionId: id,
      localProjectId: project.id,
      assistantTurnId: 'assistant-' + id,
      userTurnId: 'user-' + id,
      summary: 'Synthetic result',
    };
  }
  function outcome(id = 'session-a') {
    const input = session(id);
    return store.attention.recordOutcome({ ...input, cause: 'agent_returned' });
  }
  return {
    store,
    context,
    session,
    outcome,
    tick: () => ++now,
    target: (id = 'session-a') => ({ ...context, sessionId: id }),
  };
}

test('attention observations are Actor scoped, CAS protected, seen independent and receipts binding scoped', () => {
  const f = fixture();
  try {
    const itemId = f.outcome(),
      target = f.target();
    const request = {
      operationId: 'same-operation',
      eventRevision: 1,
      observationRevision: 0,
      disposition: 'checked' as const,
    };
    const first = f.store.attention.disposition(target, itemId, request);
    assert.equal(first.item?.disposition, 'checked');
    assert.equal(f.store.attention.list(f.context).total, 0);
    const other = { ...target, actor: { ...target.actor, authorityId: 'authority-b' } };
    assert.equal(f.store.attention.get(other, itemId).disposition, 'pending');
    assert.equal(
      f.store.attention.disposition(other, itemId, request).item?.observationRevision,
      1,
    );
    assert.throws(
      () =>
        f.store.attention.disposition(target, itemId, {
          ...request,
          operationId: 'competing-operation',
          disposition: 'needs_followup',
        }),
      /已更新/,
    );
    assert.deepEqual(f.store.attention.disposition(target, itemId, request), first);
    assert.throws(
      () =>
        f.store.attention.disposition(target, itemId, {
          ...request,
          disposition: 'needs_followup',
        }),
      /重复编号/,
    );
    assert.throws(
      () =>
        f.store.attention.disposition(
          { ...target, executionDeviceId: 'new-device' },
          itemId,
          request,
        ),
      /执行绑定/,
    );
    assert.deepEqual(
      f.store.attention.disposition(
        {
          ...target,
          catalogWorkspaceId: 'moved',
          projectId: 'moved-project',
          replicaId: 'moved-replica',
        },
        itemId,
        request,
      ),
      first,
    );
    const seen = f.store.attention.seen(target, itemId, { operationId: 'seen', eventRevision: 1 });
    assert.equal(seen.item?.seenRevision, 1);
    assert.equal(seen.item?.observationRevision, 1);
    assert.equal(seen.item?.disposition, 'checked');
    assert.equal(f.store.attention.get(other, itemId).seenRevision, 0);
    assert.throws(
      () =>
        f.store.attention.seen(target, itemId, { operationId: 'future-seen', eventRevision: 2 }),
      /版本/,
    );
    assert.throws(
      () => f.store.attention.get({ ...target, localProjectId: 'elsewhere' }, itemId),
      /项目/,
    );
  } finally {
    f.store.close();
  }
});

test('active permissions remain pending after viewing and reconcile only from live requests', () => {
  const f = fixture();
  try {
    const input = f.session('session-a', false);
    const a = f.store.attention.recordPermission({ ...input, requestId: 'request-a' });
    const b = f.store.attention.recordPermission({ ...input, requestId: 'request-b' });
    const page = f.store.attention.list(f.context);
    assert.equal(page.total, 1);
    assert.equal(page.sessions[0].itemCount, 2);
    f.store.attention.seen(f.target(), a, { operationId: 'seen-a', eventRevision: 1 });
    assert.equal(f.store.attention.list(f.context).total, 1);
    assert.throws(
      () =>
        f.store.attention.disposition(f.target(), a, {
          operationId: 'invalid-disposition',
          eventRevision: 1,
          observationRevision: 0,
          disposition: 'checked',
        }),
      /审批事项/,
    );
    f.store.attention.reconcilePermissions('project-a', (item) => item.requestId === 'request-b');
    assert.equal(f.store.attention.get(f.target(), a).lifecycle, 'invalidated');
    assert.equal(f.store.attention.get(f.target(), a).eventRevision, 2);
    assert.equal(f.store.attention.get(f.target(), b).lifecycle, 'active');
    f.store.attention.resolvePermission(input.sessionId, input.assistantTurnId, 'request-b');
    assert.equal(f.store.attention.list(f.context).total, 0);
    f.store.attention.resolvePermission(input.sessionId, input.assistantTurnId, 'request-b');
    assert.equal(f.store.attention.get(f.target(), b).eventRevision, 2);
    assert.equal(f.store.attention.recordPermission({ ...input, requestId: 'request-a' }), a);
    assert.equal(f.store.attention.get(f.target(), a).lifecycle, 'invalidated');
  } finally {
    f.store.close();
  }
});

test('outcome facts are idempotent and observations, archive and ordinary next turns do not rewrite them', () => {
  const f = fixture();
  try {
    const itemId = f.outcome(),
      original = f.store.attention.get(f.target(), itemId);
    f.tick();
    assert.equal(
      f.store.attention.recordOutcome({
        sessionId: 'session-a',
        assistantTurnId: original.assistantTurnId,
        userTurnId: original.userTurnId,
        localProjectId: 'project-a',
        cause: 'execution_failed',
        summary: 'Late different payload',
      }),
      itemId,
    );
    assert.deepEqual(f.store.attention.get(f.target(), itemId), original);
    putMeta(f.store.meta, 'session-session-a', {
      title: 'Changed title',
      isPinned: true,
      isArchived: true,
    });
    const next = f.store.attention.recordOutcome({
      sessionId: 'session-a',
      assistantTurnId: 'next-assistant',
      userTurnId: 'next-user',
      localProjectId: 'project-a',
      cause: 'execution_failed',
    });
    const page = f.store.attention.list(f.context);
    assert.equal(page.total, 1);
    assert.equal(page.sessions[0].isArchived, true);
    assert.equal(page.sessions[0].title, 'Changed title');
    assert.equal(page.sessions[0].items[0].itemId, next);
    assert.equal(page.sessions[0].itemCount, 2);
    assert.deepEqual(f.store.attention.get(f.target(), itemId), original);
  } finally {
    f.store.close();
  }
});

test('group pagination is bounded, totals cover full set, cursors expire and cannot cross Actor or project scope', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 55; i++) f.outcome('session-' + i);
    for (let i = 0; i < 60; i++)
      f.store.attention.recordOutcome({
        sessionId: 'session-0',
        assistantTurnId: 'extra-' + i,
        userTurnId: 'extra-user-' + i,
        localProjectId: 'project-a',
        cause: 'agent_returned',
        summary: 'x'.repeat(300),
      });
    const first = f.store.attention.list(f.context);
    assert.equal(first.total, 55);
    assert.equal(first.sessions.length, 50);
    assert.equal(first.sessions[0].itemCount, 61);
    assert.equal(first.sessions[0].items.length, 50);
    assert.equal(first.sessions[0].items[0].summary.length, 240);
    const remaining = f.store.attention.sessionItems(f.target('session-0'), {
      cursor: first.sessions[0].nextItemsCursor,
    });
    assert.equal(remaining.total, 61);
    assert.equal(remaining.items.length, 11);
    assert.equal(remaining.nextCursor, undefined);
    assert.equal(
      new Set([...first.sessions[0].items, ...remaining.items].map((item) => item.itemId)).size,
      61,
    );
    assert.throws(
      () =>
        f.store.attention.sessionItems(f.target('session-1'), {
          cursor: first.sessions[0].nextItemsCursor,
        }),
      /范围/,
    );
    const second = f.store.attention.list(f.context, { cursor: first.nextCursor });
    assert.equal(second.sessions.length, 5);
    assert.equal(second.total, 55);
    assert.equal(second.nextCursor, undefined);
    assert.throws(
      () =>
        f.store.attention.list(
          { ...f.context, actor: { ...f.context.actor, accountId: 'another' } },
          { cursor: first.nextCursor },
        ),
      /范围/,
    );
    putMeta(f.store.meta, 'session-session-0', { title: 'Updated while paginating' });
    assert.throws(
      () => f.store.attention.list(f.context, { cursor: first.nextCursor }),
      /列表已更新/,
    );
    assert.throws(() => f.store.attention.list(f.context, { cursor: 'invalid' }), /游标/);
  } finally {
    f.store.close();
  }
});

test('receipt failure rolls back observation and continuation alongside the host acceptance transaction', () => {
  const f = fixture();
  try {
    const itemId = f.outcome();
    const request = {
      operationId: 'mark',
      eventRevision: 1,
      observationRevision: 0,
      disposition: 'needs_followup' as const,
    };
    f.store.journal.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON attention_receipt
      BEGIN SELECT RAISE(ABORT, 'synthetic attention receipt failure'); END`);
    assert.throws(() => f.store.attention.disposition(f.target(), itemId, request), /synthetic/);
    assert.equal(f.store.attention.get(f.target(), itemId).observationRevision, 0);
    f.store.journal.db.exec('DROP TRIGGER fail_receipt');
    f.store.attention.disposition(f.target(), itemId, request);
    const continuation: AttentionContinue = {
      eventRevision: 1,
      observationRevision: 1,
      mutation: {
        operationId: 'continue',
        sessionId: 'session-a',
        workspaceId: f.context.runtimeWorkspaceId,
        kind: 'turn',
        expectedTurnId: null,
        update: '',
      },
    };
    assert.throws(
      () => f.store.attention.continue(f.target(), itemId, continuation, 'next-user'),
      /同一主机事务/,
    );
    assert.throws(
      () =>
        f.store.transaction(() => {
          f.store.save('synthetic-turn', Buffer.from('accepted'));
          f.store.attention.continue(f.target(), itemId, continuation, 'next-user');
          throw new Error('synthetic commit failure');
        }),
      /synthetic/,
    );
    assert.equal(f.store.load('synthetic-turn'), undefined);
    assert.equal(f.store.attention.get(f.target(), itemId).disposition, 'needs_followup');
    const result = f.store.transaction(() => {
      f.store.save('synthetic-turn', Buffer.from('accepted'));
      return f.store.attention.continue(f.target(), itemId, continuation, 'next-user');
    });
    assert.equal(result.item?.disposition, 'continued');
    assert.equal(result.item?.followupUserTurnId, 'next-user');
    assert.deepEqual(
      f.store.attention.lookupReceipt(f.target(), itemId, 'continue', continuation, 'continue'),
      result,
    );
    f.store.attention.disposition(f.target(), itemId, {
      operationId: 'reopen',
      eventRevision: 1,
      observationRevision: 2,
      disposition: 'pending',
    });
    assert.equal(f.store.attention.list(f.context).total, 1);
  } finally {
    f.store.close();
  }
});

test('first migration baselines finished history before restart interruption and preserves facts across backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-attention-'));
  const file = join(dir, 'host.sqlite');
  try {
    const f = fixture(file);
    f.session('historical');
    f.session('interrupted', false);
    // Build an actual pre-feature Moor database, with only its original v1 tables.
    for (const table of [
      'attention_item',
      'attention_observation',
      'attention_receipt',
      'attention_projection_state',
    ])
      f.store.journal.db.exec('DROP TABLE ' + table);
    f.store.journal.db
      .prepare('DELETE FROM runtime_state WHERE key=?')
      .run('attention-v1-authoritative');
    f.store.close();
    const restored = new RuntimeStore(file, { now: () => 9000 });
    const page = restored.attention.list(f.context);
    assert.equal(page.total, 1);
    assert.equal(page.sessions[0].sessionId, 'interrupted');
    assert.equal(page.sessions[0].items[0].cause, 'host_restarted');
    assert.equal(page.sessions[0].items[0].occurredAt, 9000);
    const historical = restored.attention.list(f.context, { view: 'processed' }).sessions[0]
      .items[0];
    assert.equal(historical.lifecycle, 'historical');
    assert.equal(historical.cause, 'unknown');
    assert.equal(historical.occurredAt, null);
    assert.equal(
      historical.disposition,
      'pending',
      'historical is not a fabricated user inspection',
    );
    restored.attention.disposition(
      { ...f.context, sessionId: 'interrupted' },
      page.sessions[0].items[0].itemId,
      {
        operationId: 'check-after-restart',
        eventRevision: 1,
        observationRevision: 0,
        disposition: 'checked',
      },
    );
    restored.close();
    const backup = join(dir, 'backup.sqlite');
    copyFileSync(file, backup);
    const next = new RuntimeStore(backup, { now: () => 9999 });
    assert.equal(next.attention.list(f.context).total, 0);
    const all = next.attention.list(f.context, { view: 'processed' });
    assert.equal(all.total, 2);
    assert.equal(all.sessions[0].items[0].occurredAt, 9000);
    assert.equal(all.sessions[0].items[0].itemId, page.sessions[0].items[0].itemId);
    assert.equal(all.sessions[0].items[0].observationRevision, 1);
    next.attention.disposition({ ...f.context, sessionId: 'historical' }, historical.itemId, {
      operationId: 'reopen-history',
      eventRevision: 1,
      observationRevision: 0,
      disposition: 'pending',
    });
    assert.equal(next.attention.list(f.context).total, 1);
    next.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart invalidates old persisted approval and does not duplicate its terminal interruption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-attention-restart-'));
  const file = join(dir, 'host.sqlite');
  try {
    const f = fixture(file),
      input = f.session('session-a', false);
    const permission = f.store.attention.recordPermission({ ...input, requestId: 'old-request' });
    f.store.close();
    const restarted = new RuntimeStore(file, { now: () => 2000 });
    assert.equal(restarted.attention.get(f.target(), permission).lifecycle, 'invalidated');
    assert.equal(restarted.attention.list(f.context).sessions[0].itemCount, 1);
    const result = restarted.attention.list(f.context).sessions[0].items[0];
    restarted.close();
    const again = new RuntimeStore(file, { now: () => 3000 });
    assert.deepEqual(again.attention.list(f.context).sessions[0].items[0], result);
    assert.equal(again.attention.get(f.target(), permission).eventRevision, 2);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing authoritative table after initialization is rejected rather than reconstructed from session text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-attention-missing-'));
  const file = join(dir, 'host.sqlite');
  try {
    const f = fixture(file);
    f.outcome();
    f.store.journal.db.exec('DROP TABLE attention_item');
    f.store.close();
    assert.throws(() => new RuntimeStore(file), /权威数据不完整/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit user cancellation is processed history until deliberately reopened', () => {
  const f = fixture();
  try {
    const input = f.session();
    const itemId = f.store.attention.recordOutcome({ ...input, cause: 'user_canceled' });
    assert.equal(f.store.attention.list(f.context).total, 0);
    assert.equal(f.store.attention.list(f.context, { view: 'processed' }).total, 1);
    f.store.attention.disposition(f.target(), itemId, {
      operationId: 'reopen-cancellation',
      eventRevision: 1,
      observationRevision: 0,
      disposition: 'pending',
    });
    assert.equal(f.store.attention.list(f.context).total, 1);
  } finally {
    f.store.close();
  }
});

test('authoritative fact storage failure rolls back the session snapshot and sequence together', () => {
  const f = fixture();
  try {
    const input = f.session(),
      doc = f.store.doc(input.sessionId),
      view = mirror(doc, input.sessionId);
    view.setState((state) => {
      state.history[0].items = [{ type: 'text', text: 'New terminal output' }];
    });
    view.dispose();
    f.store.journal.db.exec(`CREATE TRIGGER fail_fact BEFORE INSERT ON attention_item
      BEGIN SELECT RAISE(ABORT, 'synthetic fact storage failure'); END`);
    assert.throws(
      () =>
        f.store.transaction(() => {
          f.store.persist(input.sessionId, doc);
          f.store.attention.recordOutcome({ ...input, cause: 'agent_returned' });
        }),
      /synthetic fact/,
    );
    const original = mirror(f.store.doc(input.sessionId), input.sessionId);
    assert.equal((original.getState().history[0].items![0] as any).text, 'Synthetic result');
    original.dispose();
    assert.equal(f.store.attention.list(f.context).total, 0);
    f.store.journal.db.exec('DROP TRIGGER fail_fact');
    const itemId = f.store.attention.recordOutcome({ ...input, cause: 'agent_returned' });
    assert.equal(f.store.attention.get(f.target(), itemId).sequence, 1);
  } finally {
    f.store.close();
  }
});

test('summary reconstruction preserves lifecycle facts, stable ordering and personal observations', () => {
  const f = fixture();
  try {
    const input = f.session(),
      itemId = f.store.attention.recordOutcome({
        ...input,
        cause: 'execution_failed',
        summary: 'Stale derived index',
      });
    f.store.attention.disposition(f.target(), itemId, {
      operationId: 'checked-before-rebuild',
      eventRevision: 1,
      observationRevision: 0,
      disposition: 'checked',
    });
    const { summary: _oldSummary, ...before } = f.store.attention.get(f.target(), itemId);
    f.tick();
    f.store.attention.rebuildSummaries();
    const { summary, ...after } = f.store.attention.get(f.target(), itemId);
    assert.equal(summary, 'Synthetic result');
    assert.deepEqual(after, before);
    assert.equal(f.store.attention.list(f.context).total, 0);
  } finally {
    f.store.close();
  }
});

test('deleted lifecycle rows are detected from the authoritative sequence at restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moor-attention-corrupt-'));
  const file = join(dir, 'host.sqlite');
  try {
    const f = fixture(file);
    f.outcome();
    f.store.journal.db.exec('DELETE FROM attention_item');
    f.store.close();
    assert.throws(() => new RuntimeStore(file), /权威数据不完整/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
