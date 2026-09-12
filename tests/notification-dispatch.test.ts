import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { HostNotifications } from '../src/runtime/host-notifications';
import {
  NotificationDispatcher,
  NOTIFICATION_DISPATCH_LIMITS,
  relayNotificationChannel,
  type NotificationHost,
} from '../src/bridge/notification-dispatch';
import {
  NOTIFICATION_LIMITS,
  type HostNotificationEvent,
  type NotificationScope,
} from '../src/notification-protocol';

const scope: NotificationScope = {
  userId: 'synthetic-owner',
  machineId: 'machine',
  workspaceId: 'workspace',
  localProjectId: 'project',
  sessionId: 'session',
  turnId: 'turn',
};
function fixture(t: { after(fn: () => unknown): void }) {
  const db = new DatabaseSync(':memory:');
  let now = 1000,
    nextTimer = 0,
    current = true,
    writesFail = false;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const outbox = new HostNotifications(db, { now: () => now });
  const host: NotificationHost = {
    pendingNotifications(channel, limit) {
      return outbox.pending(channel, limit);
    },
    isNotificationCurrent(event) {
      return current && JSON.stringify(event) === JSON.stringify(outbox.get(event.eventId, true));
    },
    acknowledgeNotification(channel, eventId, state) {
      if (writesFail) throw new Error('synthetic persistence failure');
      if (current) outbox.acknowledge(channel, eventId, state);
      else outbox.discard(eventId);
    },
    retryNotification(channel, eventId, delay) {
      if (writesFail) throw new Error('synthetic persistence failure');
      if (current) outbox.retry(channel, eventId, delay);
      else outbox.discard(eventId);
    },
  };
  const dispatchers: NotificationDispatcher[] = [];
  function dispatcher() {
    const dispatcher = new NotificationDispatcher({
      hosts: () => [host],
      now: () => now,
      setTimeout: ((callback: () => void, ms: number) => {
        const id = ++nextTimer;
        timers.set(id, { at: now + ms, callback });
        return id;
      }) as unknown as typeof setTimeout,
      clearTimeout: ((id: number) => {
        timers.delete(id);
      }) as unknown as typeof clearTimeout,
    });
    dispatchers.push(dispatcher);
    return dispatcher;
  }
  t.after(() => {
    for (const d of dispatchers) d.close();
    db.close();
  });
  return {
    outbox,
    db,
    host,
    dispatcher,
    timers,
    record(turnId = 'turn', input = scope) {
      return outbox.record({ ...input, turnId }, 'completed');
    },
    current(value: boolean) {
      current = value;
    },
    writesFail(value: boolean) {
      writesFail = value;
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
      }
      now = target;
    },
    state(channel: string, event: HostNotificationEvent) {
      return db
        .prepare('SELECT state FROM notification_delivery WHERE channel=? AND event_id=?')
        .get(channel, event.eventId)?.state;
    },
  };
}
const ack = (event: HostNotificationEvent, status: string) => ({
  type: 'notification-ack',
  eventId: event.eventId,
  status,
});

test('native and relay acknowledgement meanings are distinct and durable per channel', (t) => {
  const f = fixture(t),
    event = f.record(),
    dispatcher = f.dispatcher(),
    native = {},
    relay = {};
  const sent: HostNotificationEvent[] = [];
  dispatcher.connect('native:machine', native, 'native', (e) => {
    sent.push(e);
    return true;
  });
  dispatcher.connect('relay:device', relay, 'relay', (e) => {
    sent.push(e);
    return true;
  });
  assert.deepEqual(sent, [event, event]);
  assert.equal(dispatcher.acknowledge('native:machine', native, ack(event, 'handled')), false);
  assert.equal(dispatcher.acknowledge('relay:device', relay, ack(event, 'shown')), false);
  assert.equal(dispatcher.acknowledge('native:machine', native, ack(event, 'shown')), true);
  assert.equal(dispatcher.acknowledge('relay:device', relay, ack(event, 'handled')), true);
  assert.equal(f.state('native:machine', event), 'submitted');
  assert.equal(f.state('relay:device', event), 'submitted');
  dispatcher.drain();
  assert.equal(sent.length, 2);
  assert.equal(f.timers.size, 0);
});

test('native ignored/failed and relay rejected suppress future permission or OS retry spam', (t) => {
  const f = fixture(t),
    event = f.record(),
    dispatcher = f.dispatcher();
  for (const [kind, status] of [
    ['native', 'ignored'],
    ['native', 'failed'],
    ['relay', 'rejected'],
  ] as const) {
    const generation = {},
      channel = kind + ':' + status;
    let count = 0;
    dispatcher.connect(channel, generation, kind, () => {
      count++;
      return true;
    });
    assert.equal(dispatcher.acknowledge(channel, generation, ack(event, status)), true);
    f.advance(NOTIFICATION_DISPATCH_LIMITS.acknowledgementMs);
    dispatcher.drain();
    assert.equal(count, 1);
    assert.equal(f.state(channel, event), 'suppressed');
  }
});

test('only the current connection may acknowledge an actually sent exact event', (t) => {
  const f = fixture(t),
    event = f.record(),
    unsent = f.record('unsent'),
    dispatcher = f.dispatcher(),
    old = {},
    replacement = {};
  f.outbox.retry('relay:device', unsent.eventId, 100000);
  dispatcher.connect('relay:device', old, 'relay', () => true);
  assert.equal(dispatcher.acknowledge('relay:device', {}, ack(event, 'handled')), false);
  assert.equal(dispatcher.acknowledge('relay:device', old, ack(unsent, 'handled')), false);
  assert.equal(
    dispatcher.acknowledge('relay:device', old, { ...ack(event, 'handled'), sessionId: 'forged' }),
    false,
  );
  dispatcher.connect('relay:device', replacement, 'relay', () => true);
  dispatcher.disconnect('relay:device', old);
  assert.equal(dispatcher.acknowledge('relay:device', old, ack(event, 'handled')), false);
  f.advance(NOTIFICATION_DISPATCH_LIMITS.retryMs);
  dispatcher.drain();
  assert.equal(dispatcher.acknowledge('relay:device', old, ack(event, 'handled')), false);
  assert.equal(dispatcher.acknowledge('relay:device', replacement, ack(event, 'handled')), true);
  assert.equal(f.state('relay:device', unsent), 'pending');
});

test('timeouts and explicit relay retries preserve original timestamps and payload through a dispatcher restart', (t) => {
  const f = fixture(t),
    event = f.record(),
    first = f.dispatcher(),
    firstSocket = {},
    sent: HostNotificationEvent[] = [];
  first.connect('relay:device', firstSocket, 'relay', (e) => {
    sent.push(e);
    return true;
  });
  f.advance(NOTIFICATION_DISPATCH_LIMITS.acknowledgementMs);
  first.drain();
  assert.equal(sent.length, 1);
  first.close();
  const second = f.dispatcher(),
    nextSocket = {};
  second.connect('relay:device', nextSocket, 'relay', (e) => {
    sent.push(e);
    return true;
  });
  f.advance(NOTIFICATION_DISPATCH_LIMITS.retryMs);
  second.drain();
  assert.deepEqual(sent, [event, event]);
  assert.equal(second.acknowledge('relay:device', nextSocket, ack(event, 'retry')), true);
  f.advance(NOTIFICATION_DISPATCH_LIMITS.retryMs);
  second.drain();
  assert.deepEqual(sent, [event, event, event]);
  second.acknowledge('relay:device', nextSocket, ack(event, 'handled'));
  assert.equal(f.state('relay:device', event), 'submitted');
});

test('delivery and acknowledgements revalidate current scope and expire stale approvals', (t) => {
  const f = fixture(t),
    event = f.record(),
    dispatcher = f.dispatcher(),
    generation = {};
  let count = 0;
  f.current(false);
  dispatcher.connect('native:machine', generation, 'native', () => {
    count++;
    return true;
  });
  assert.equal(count, 0);
  f.current(true);
  dispatcher.drain();
  assert.equal(count, 1);
  f.current(false);
  assert.equal(dispatcher.acknowledge('native:machine', generation, ack(event, 'shown')), false);
  assert.equal(f.state('native:machine', event), undefined);
  assert.equal(f.outbox.get(event.eventId, true), undefined);
  f.current(true);
  const approval = f.outbox.record(scope, 'approval-required', 'request');
  dispatcher.drain();
  f.outbox.resolveApprovals(scope, 'request');
  assert.equal(dispatcher.acknowledge('native:machine', generation, ack(approval, 'shown')), false);
  assert.equal(f.state('native:machine', approval), undefined);
});

test('per-channel inflight work stays bounded and closing clears timers without awaiting or acknowledging transport', (t) => {
  const f = fixture(t),
    dispatcher = f.dispatcher(),
    generation = {},
    sent: HostNotificationEvent[] = [];
  for (let i = 0; i < 50; i++) f.record('turn-' + i);
  dispatcher.connect('native:machine', generation, 'native', (e) => {
    sent.push(e);
    return true;
  });
  for (let i = 0; i < 20; i++) dispatcher.drain();
  assert.equal(sent.length, NOTIFICATION_DISPATCH_LIMITS.perChannel);
  assert.equal(f.timers.size, NOTIFICATION_DISPATCH_LIMITS.perChannel);
  dispatcher.close();
  assert.equal(f.timers.size, 0);
  f.advance(NOTIFICATION_DISPATCH_LIMITS.acknowledgementMs);
  assert.equal(dispatcher.acknowledge('native:machine', generation, ack(sent[0]!, 'shown')), false);
  assert.equal(f.outbox.pending('native:machine', 100).length, 50);
  assert.equal(f.state('native:machine', sent[0]!), undefined);
});

test('send failures and database errors remain bounded and cannot break a committed turn callback', (t) => {
  const f = fixture(t),
    event = f.record(),
    dispatcher = f.dispatcher(),
    generation = {};
  let sends = 0;
  dispatcher.connect('relay:device', generation, 'relay', () => {
    sends++;
    throw new Error('synthetic send failure');
  });
  dispatcher.drain();
  assert.equal(sends, 1);
  assert.equal(f.timers.size, 0);
  f.advance(NOTIFICATION_DISPATCH_LIMITS.retryMs);
  f.writesFail(true);
  assert.doesNotThrow(() => dispatcher.drain());
  assert.equal(dispatcher.diagnostics().failures, 3);
  f.writesFail(false);
  dispatcher.disconnect('relay:device', generation);
  const recovered = {};
  dispatcher.connect('relay:device', recovered, 'relay', () => true);
  dispatcher.acknowledge('relay:device', recovered, ack(event, 'handled'));
  assert.equal(f.state('relay:device', event), 'submitted');
});

test('senders cannot rewrite acknowledgement scope, and synchronous acknowledgements clear the timeout', (t) => {
  const f = fixture(t),
    event = f.record(),
    dispatcher = f.dispatcher(),
    generation = {};
  dispatcher.connect('native:machine', generation, 'native', (copy) => {
    copy.sessionId = 'tampered';
    assert.equal(dispatcher.acknowledge('native:machine', generation, ack(copy, 'shown')), true);
    return true;
  });
  assert.equal(f.state('native:machine', event), 'submitted');
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.outbox.get(event.eventId), event);
});

test('oversize metadata is suppressed, TTL is never extended, and channels use canonical relay origins', (t) => {
  const f = fixture(t),
    event = f.record('oversize', { ...scope, userId: '界'.repeat(1000) }),
    dispatcher = f.dispatcher(),
    generation = {};
  let sends = 0;
  assert.ok(Buffer.byteLength(JSON.stringify(event)) > NOTIFICATION_LIMITS.payloadBytes);
  dispatcher.connect('native:machine', generation, 'native', () => {
    sends++;
    return true;
  });
  assert.equal(sends, 0);
  assert.equal(f.state('native:machine', event), 'suppressed');
  const ordinary = f.record();
  f.advance(NOTIFICATION_LIMITS.terminalTtl);
  dispatcher.drain();
  assert.equal(sends, 0);
  assert.deepEqual(f.outbox.record(scope, 'completed'), ordinary);
  assert.equal(
    relayNotificationChannel('device', 'https://relay.example/a'),
    relayNotificationChannel('device', 'https://relay.example:443/b'),
  );
  assert.notEqual(
    relayNotificationChannel('device', 'https://relay.example'),
    relayNotificationChannel('device', 'https://other.example'),
  );
  assert.notEqual(
    relayNotificationChannel('device', 'https://relay.example'),
    relayNotificationChannel('other', 'https://relay.example'),
  );
});

test('repeated ready frames retain current inflight state and global channel capacity remains bounded', (t) => {
  const f = fixture(t),
    event = f.record(),
    dispatcher = f.dispatcher(),
    generation = {};
  let sends = 0;
  dispatcher.connect('native:machine', generation, 'native', () => {
    sends++;
    return true;
  });
  dispatcher.connect('native:machine', generation, 'native', () => {
    throw new Error('duplicate ready replaced sender');
  });
  assert.equal(sends, 1);
  for (let i = 0; i < 20; i++) dispatcher.connect('relay:device-' + i, {}, 'relay', () => true);
  assert.equal(dispatcher.diagnostics().channels, NOTIFICATION_DISPATCH_LIMITS.channels);
  assert.equal(dispatcher.acknowledge('native:machine', generation, ack(event, 'shown')), true);
});
