import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostNotifications, notificationEventId } from '../src/runtime/host-notifications';
import { RuntimeStore } from '../src/runtime/store';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { Flock, LoroDoc, delta, mirror, putMeta, vv } from '../src/model';
import type { AgentCallbacks } from '../src/runtime/agent';
import type { Mutation } from '../src/protocol';
import {
  NOTIFICATION_LIMITS,
  hostNotificationEventSchema,
  type NotificationScope,
} from '../src/notification-protocol';
import { syntheticCapabilities } from './support/agent-capabilities';

const scope: NotificationScope = {
  userId: 'local:synthetic',
  machineId: 'machine',
  workspaceId: 'workspace',
  localProjectId: 'project',
  sessionId: 'session',
  turnId: 'turn',
};
function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function core(t: { after(fn: () => unknown): void }) {
  const db = new DatabaseSync(':memory:');
  let now = 1000;
  const notifications = new HostNotifications(db, { now: () => now });
  t.after(() => db.close());
  return {
    db,
    notifications,
    advance(ms: number) {
      now += ms;
    },
  };
}

test('notification identity includes every immutable dimension and retains one original terminal outcome and TTL', (t) => {
  const f = core(t),
    first = f.notifications.record(scope, 'completed');
  hostNotificationEventSchema.parse(first);
  f.advance(100);
  assert.deepEqual(f.notifications.record(scope, 'failed'), first);
  for (const key of Object.keys(scope) as (keyof NotificationScope)[]) {
    const other = f.notifications.record({ ...scope, [key]: 'other' }, 'completed');
    assert.notEqual(other.eventId, first.eventId, key);
  }
  const a = f.notifications.record(scope, 'approval-required', 'request-a');
  const b = f.notifications.record(scope, 'approval-required', 'request-b');
  assert.notEqual(a.eventId, b.eventId);
  assert.equal(a.expiresAt - a.createdAt, NOTIFICATION_LIMITS.approvalTtl);
  assert.equal(first.expiresAt - first.createdAt, NOTIFICATION_LIMITS.terminalTtl);
  assert.equal(first.eventId, notificationEventId(first));
  assert.throws(() => f.notifications.record(scope, 'completed', 'invalid-request'));
  assert.throws(() => f.notifications.record(scope, 'approval-required'));
  assert.throws(() =>
    f.notifications.record({ ...scope, title: 'private title' } as any, 'completed'),
  );
});

test('per-channel submission, retry delay and suppression survive recreation without replaying acknowledged events', (t) => {
  const f = core(t),
    event = f.notifications.record(scope, 'completed');
  assert.deepEqual(f.notifications.pending('native:installation'), [event]);
  f.notifications.retry('native:installation', event.eventId, 2000);
  assert.deepEqual(f.notifications.pending('native:installation'), []);
  assert.deepEqual(f.notifications.pending('relay:device'), [event]);
  f.advance(2000);
  assert.deepEqual(f.notifications.pending('native:installation'), [event]);
  f.notifications.acknowledge('native:installation', event.eventId, 'submitted');
  f.notifications.retry('native:installation', event.eventId, 0);
  f.notifications.acknowledge('native:installation', event.eventId, 'suppressed');
  assert.equal(
    f.db
      .prepare('SELECT state FROM notification_delivery WHERE channel=?')
      .get('native:installation')!.state,
    'submitted',
  );
  const recreated = new HostNotifications(f.db, { now: () => 3000 });
  assert.deepEqual(recreated.pending('native:installation'), []);
  assert.deepEqual(recreated.pending('relay:device'), [event]);
  recreated.acknowledge('relay:device', event.eventId, 'suppressed');
  assert.deepEqual(recreated.pending('relay:device'), []);
});

test('resolved and expired approvals cannot be revived by original-event retries or delivery acknowledgements', (t) => {
  const f = core(t),
    event = f.notifications.record(scope, 'approval-required', 'request');
  f.notifications.resolveApprovals({ ...scope, sessionId: 'other' });
  assert.deepEqual(f.notifications.pending('native'), [event]);
  f.notifications.resolveApprovals(scope, 'request');
  assert.deepEqual(f.notifications.pending('native'), []);
  assert.deepEqual(f.notifications.record(scope, 'approval-required', 'request'), event);
  f.notifications.acknowledge('native', event.eventId, 'submitted');
  f.notifications.retry('native', event.eventId, 0);
  assert.deepEqual(f.notifications.pending('native'), []);
  assert.equal(f.notifications.get(event.eventId, true), undefined);
  const terminal = f.notifications.record(scope, 'completed');
  f.advance(NOTIFICATION_LIMITS.terminalTtl);
  assert.deepEqual(f.notifications.pending('native'), []);
  assert.deepEqual(f.notifications.record(scope, 'completed'), terminal);
  assert.equal(f.notifications.get(terminal.eventId, true), undefined);
});

test('event and session writes roll back together and records contain only notification references', (t) => {
  const f = core(t);
  f.db.exec('CREATE TABLE synthetic_session(body TEXT)');
  f.db.exec('BEGIN');
  f.db.prepare('INSERT INTO synthetic_session VALUES(?)').run('synthetic private prompt');
  f.notifications.record(scope, 'completed');
  f.db.exec('ROLLBACK');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM notification_event').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM synthetic_session').get()!.n, 0);
  const event = f.notifications.record(scope, 'completed');
  assert.deepEqual(
    JSON.parse(String(f.db.prepare('SELECT event FROM notification_event').get()!.event)),
    event,
  );
  assert.equal(JSON.stringify(event).includes('synthetic private prompt'), false);
  assert.deepEqual(
    Object.keys(event).sort(),
    [
      'notificationVersion',
      'eventId',
      'kind',
      'createdAt',
      'expiresAt',
      ...Object.keys(scope),
    ].sort(),
  );
});

test('pending queues and channel identifiers are bounded and cannot broaden a delivery lookup', (t) => {
  const f = core(t);
  for (let i = 0; i < 5; i++) f.notifications.record({ ...scope, turnId: 'turn-' + i }, 'failed');
  assert.equal(f.notifications.pending('native', 2).length, 2);
  assert.throws(() => f.notifications.pending('native', 0));
  assert.throws(() => f.notifications.pending('native', NOTIFICATION_LIMITS.events + 1));
  assert.throws(() => f.notifications.pending('native\0other'));
  assert.throws(() => f.notifications.get("' OR 1=1"));
  const event = f.notifications.pending('native')[0]!;
  assert.throws(() => f.notifications.acknowledge('native', event.eventId, 'delivered' as any));
  assert.throws(() => f.notifications.retry('native', event.eventId, -1));
});

test('only the latest bounded active events remain deliverable and overflow retries cannot resurrect tombstones', (t) => {
  const f = core(t),
    first = f.notifications.record(scope, 'completed');
  for (let i = 0; i < NOTIFICATION_LIMITS.events + 2; i++) {
    f.advance(1);
    const event = f.notifications.record({ ...scope, turnId: 'new-' + i }, 'completed');
    f.notifications.acknowledge('native', event.eventId, 'submitted');
  }
  assert.deepEqual(f.notifications.diagnostics(), { active: 1000, overflow: 3 });
  assert.deepEqual(f.notifications.pending('native'), []);
  assert.equal(f.notifications.pending('new-channel', 1000).length, 1000);
  assert.equal(f.notifications.get(first.eventId, true), undefined);
  assert.deepEqual(f.notifications.record(scope, 'failed'), first);
  f.notifications.retry('native', first.eventId, 0);
  assert.deepEqual(f.notifications.pending('native'), []);
  const restored = new HostNotifications(f.db, { now: () => 2500 });
  assert.deepEqual(restored.diagnostics(), { active: 1000, overflow: 3 });
  assert.equal(restored.get(first.eventId, true), undefined);
});

function hostFixture(t: { after(fn: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'moor-host-notifications-')),
    file = join(dir, 'runtime.sqlite');
  let now = 1000,
    store = new RuntimeStore(file, { now: () => now });
  Object.assign(store.workspace, {
    id: scope.workspaceId,
    userId: scope.userId,
    machineId: scope.machineId,
  });
  store.save('identity', Buffer.from(JSON.stringify(store.workspace)));
  store.machine.set(['localProject', scope.localProjectId], {
    id: scope.localProjectId,
    name: 'Synthetic',
    rootPath: '/synthetic/project',
  });
  store.machine.set(['agentConfig', 'agent'], {
    id: 'agent',
    name: 'Synthetic',
    machineId: scope.machineId,
    cliType: 'builtin',
    agentType: 'codex',
  });
  store.saveMachine();
  let callbacks!: AgentCallbacks,
    opens = 0,
    failPrompt = false,
    started = signal(),
    release = signal(),
    after = signal(),
    afterStarted = signal(),
    blockAfter = false;
  let captures = 0;
  const open = () =>
    new HostWorkspace(
      store,
      {
        async open(_agent, _path, _native, c) {
          callbacks = c;
          opens++;
          return {
            id: 'native',
            capabilities: syntheticCapabilities,
            async prompt() {
              started.resolve();
              await release.promise;
              if (failPrompt) throw new Error('private synthetic error');
            },
            async cancel() {
              release.resolve();
            },
            close() {
              release.resolve();
            },
          };
        },
      },
      () => {},
      () => {},
      async () => {
        throw new Error('No file read');
      },
      {
        capture: async () => {
          if (++captures % 2 === 0) {
            afterStarted.resolve();
            if (blockAfter) await after.promise;
          }
          return {
            version: 1,
            source: 'git',
            files: [],
            partial: false,
            enumerationComplete: true,
            issues: [],
            bytesRead: 0,
          };
        },
        tree: async () => {
          throw new Error('No file tree');
        },
      },
    );
  let host = open();
  t.after(() => {
    after.resolve();
    release.resolve();
    host.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function start() {
    const doc = new LoroDoc(),
      before = vv(doc),
      flock = Flock.fromFile(store.meta.exportFile()),
      version = flock.version(),
      view = mirror(doc, scope.sessionId),
      turnId = randomUUID();
    view.setState((state: any) => {
      state.history.push({
        id: turnId,
        role: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        userId: scope.userId,
        finished: true,
        status: 'pending',
        items: [{ type: 'text', text: 'private synthetic prompt' }],
        inputConfig: {
          prompt: 'private synthetic prompt',
          cliType: 'builtin',
          agentType: 'codex',
          mcpServerIds: [],
          taskToolsEnabled: false,
        },
        fileDiff: null,
      });
    });
    view.dispose();
    doc.commit();
    putMeta(flock, 'session-' + scope.sessionId, {
      id: scope.sessionId,
      userId: scope.userId,
      machineId: scope.machineId,
      cliType: 'builtin',
      agentType: 'codex',
      agentConfigId: 'agent',
      project: { kind: 'local', localProjectId: scope.localProjectId },
      createdAt: '2026-01-01T00:00:00Z',
      latestUserMsgId: turnId,
      lastMessageAt: 1,
      isArchived: false,
      status: { type: 'idle' },
    });
    const mutation: Mutation = {
      operationId: randomUUID(),
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      kind: 'turn',
      expectedTurnId: null,
      update: delta(doc, before),
      metaBundle: flock.exportJson(version),
    };
    await host.mutate(mutation, scope.localProjectId);
    await started.promise;
    return mutation;
  }
  return {
    get store() {
      return store;
    },
    get host() {
      return host;
    },
    get callbacks() {
      return callbacks;
    },
    start,
    opens: () => opens,
    permission() {
      return callbacks.permission({
        toolCall: { toolCallId: 'tool', title: 'private tool title' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });
    },
    choice(original: Mutation): Mutation {
      const doc = new LoroDoc();
      doc.import(host.active.get(scope.sessionId)!.doc.export({ mode: 'snapshot' }));
      const before = vv(doc),
        view = mirror(doc, scope.sessionId);
      let requestId = '';
      view.setState((state: any) => {
        const item = state.history.at(-1).items.find((item: any) => item.permissionRequest);
        requestId = item.permissionRequest.requestId;
        item.permissionRequest.outcome = { outcome: 'selected', optionId: 'allow' };
      });
      view.dispose();
      doc.commit();
      return {
        ...original,
        kind: 'permission',
        operationId: randomUUID(),
        expectedTurnId: store.journal.lookup(scope.workspaceId, original).turn_id,
        requestId,
        update: delta(doc, before),
        metaBundle: undefined,
      };
    },
    async finish(fail = false) {
      failPrompt = fail;
      const done = host.active.get(scope.sessionId)?.done;
      release.resolve();
      await done;
    },
    blockAfter() {
      blockAfter = true;
    },
    afterStarted: () => afterStarted.promise,
    releaseAfter() {
      after.resolve();
    },
    async crash() {
      host.closed = true;
      const done = host.active.get(scope.sessionId)?.done;
      release.resolve();
      await done;
      store.close();
      store = new RuntimeStore(file, { now: () => now });
      host = open();
    },
    restart() {
      host.close();
      store.close();
      store = new RuntimeStore(file, { now: () => now });
      host = open();
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

test('terminal notifications appear only after durable final diff and remain channel-deduplicated across restart', async (t) => {
  const f = hostFixture(t);
  await f.start();
  assert.deepEqual(f.host.pendingNotifications('native'), []);
  f.blockAfter();
  const finished = f.finish();
  await f.afterStarted();
  assert.deepEqual(f.host.pendingNotifications('native'), []);
  f.releaseAfter();
  await finished;
  const events = f.host.pendingNotifications('native');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'completed');
  assert.equal(JSON.stringify(events).includes('private'), false);
  f.host.acknowledgeNotification('native', events[0]!.eventId, 'submitted');
  f.restart();
  assert.deepEqual(f.host.pendingNotifications('native'), []);
  assert.deepEqual(f.host.pendingNotifications('relay:device'), events);
  assert.equal(f.opens(), 1);
});

test('failed turns emit safe failed metadata while cancelled turns emit no terminal notification', async (t) => {
  const failed = hostFixture(t);
  await failed.start();
  await failed.finish(true);
  const events = failed.host.pendingNotifications('native');
  assert.equal(events[0]!.kind, 'failed');
  assert.equal(JSON.stringify(events).includes('private'), false);
  const cancelled = hostFixture(t);
  await cancelled.start();
  await cancelled.host.cancel(scope.sessionId, cancelled.host.active.get(scope.sessionId)!.turnId);
  assert.deepEqual(cancelled.host.pendingNotifications('native'), []);
});

test('approval notifications bind the actual request, resolve with the answer transaction and cannot be resurrected', async (t) => {
  const f = hostFixture(t),
    mutation = await f.start(),
    native = f.permission();
  const event = f.host.pendingNotifications('native')[0]!;
  assert.equal(event.kind, 'approval-required');
  assert.equal(event.turnId, f.host.active.get(scope.sessionId)!.turnId);
  const choice = f.choice(mutation);
  assert.equal(event.requestId, choice.requestId);
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_receipt BEFORE UPDATE ON operation BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END",
  );
  await assert.rejects(f.host.mutate(choice));
  assert.deepEqual(f.host.pendingNotifications('native'), [event]);
  f.store.journal.db.exec('DROP TRIGGER fail_receipt');
  await f.host.mutate(choice);
  assert.deepEqual(await native, { outcome: { outcome: 'selected', optionId: 'allow' } });
  assert.deepEqual(f.host.pendingNotifications('native'), []);
  f.host.retryNotification('native', event.eventId, 0);
  assert.equal(f.host.isNotificationCurrent(event), false);
  await f.finish();
  assert.deepEqual(
    f.host.pendingNotifications('native').map((value) => value.kind),
    ['completed'],
  );
});

test('cancel and restart invalidate pending approvals without replaying callbacks or Agent execution', async (t) => {
  const f = hostFixture(t);
  await f.start();
  const native = f.permission();
  const approval = f.host.pendingNotifications('native')[0]!;
  await f.crash();
  assert.deepEqual(await native, { outcome: { outcome: 'cancelled' } });
  assert.equal(f.host.isNotificationCurrent(approval), false);
  const events = f.host.pendingNotifications('native');
  assert.deepEqual(
    events.map((event) => event.kind),
    ['failed'],
  );
  f.restart();
  assert.deepEqual(f.host.pendingNotifications('native'), events);
  assert.equal(f.opens(), 1);
});

test('cancellation immediately retires a pending approval without producing a completed notification', async (t) => {
  const f = hostFixture(t);
  await f.start();
  const native = f.permission(),
    approval = f.host.pendingNotifications('native')[0]!;
  await f.host.cancel(scope.sessionId, approval.turnId);
  assert.deepEqual(await native, { outcome: { outcome: 'cancelled' } });
  assert.equal(f.host.isNotificationCurrent(approval), false);
  assert.deepEqual(f.host.pendingNotifications('native'), []);
  assert.deepEqual(f.host.pendingNotifications('relay:device'), []);
  const rows = f.store.journal.db.prepare('SELECT kind,state FROM notification_event').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, 'approval-required');
  assert.equal(rows[0]!.state, 'resolved');
});

test('immutable host reservation and project registry are checked again for queued notifications', async (t) => {
  const f = hostFixture(t);
  await f.start();
  await f.finish();
  const event = f.host.pendingNotifications('native')[0]!;
  f.store.journal.db
    .prepare('UPDATE attachment_scope SET workspace_id=? WHERE session_id=?')
    .run('other-workspace', scope.sessionId);
  assert.equal(f.host.isNotificationCurrent(event), false);
  f.store.journal.db
    .prepare('UPDATE attachment_scope SET workspace_id=? WHERE session_id=?')
    .run(scope.workspaceId, scope.sessionId);
  f.store.machine.set(['localProject', scope.localProjectId], undefined);
  assert.equal(f.host.isNotificationCurrent(event), false);
  assert.deepEqual(f.host.pendingNotifications('native'), []);
});

test('notification writes roll back with failed terminal persistence and never describe unsaved completion', async (t) => {
  const f = hostFixture(t);
  await f.start();
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_session BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT,'synthetic terminal failure'); END",
  );
  await f.finish();
  assert.equal(f.host.active.size, 0);
  assert.equal(f.host.settlementFailures.has(scope.sessionId), true);
  assert.deepEqual(f.host.pendingNotifications('native'), []);
  assert.equal(
    f.store.journal.db.prepare('SELECT count(*) AS n FROM notification_event').get()!.n,
    0,
  );
});

test('notification permission persistence failure rolls back request and outbox before native handling', async (t) => {
  const f = hostFixture(t);
  await f.start();
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_notification BEFORE INSERT ON notification_event BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END",
  );
  await assert.rejects(f.permission());
  assert.deepEqual(f.host.pendingNotifications('native'), []);
  assert.equal(f.host.active.get(scope.sessionId)!.permissions.size, 0);
  const view = mirror(f.store.doc(scope.sessionId), scope.sessionId);
  assert.equal(
    view
      .getState()
      .history.at(-1)!
      .items!.some((item: any) => item.permissionRequest),
    false,
  );
  view.dispose();
  f.store.journal.db.exec('DROP TRIGGER fail_notification');
  await f.finish();
});

test('notification delivery rechecks immutable owner/project scope and rejects forged or stale events', async (t) => {
  const f = hostFixture(t);
  await f.start();
  await f.finish();
  const event = f.host.pendingNotifications('native')[0]!;
  assert.equal(f.host.isNotificationCurrent({ ...event, kind: 'failed' }), false);
  putMeta(f.store.meta, 'session-' + scope.sessionId, { userId: 'other' });
  assert.deepEqual(f.host.pendingNotifications('native'), []);
  putMeta(f.store.meta, 'session-' + scope.sessionId, { userId: scope.userId });
  assert.equal(f.host.isNotificationCurrent(event), false);
  assert.deepEqual(f.host.pendingNotifications('relay'), []);
});
