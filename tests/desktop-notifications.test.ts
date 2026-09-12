import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import {
  DesktopNotifications,
  validateEvent,
  notificationUrl,
} from '../src/desktop/notifications.cjs';
import {
  hostNotificationEventSchema,
  notificationIdentity,
  type HostNotificationEvent,
} from '../src/notification-protocol';
const scope = {
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'workspace:local',
  localProjectId: 'project',
  sessionId: 'session',
  turnId: 'turn',
};
const makeEvent = (kind: HostNotificationEvent['kind'] = 'completed'): HostNotificationEvent => {
  const identity = {
    ...scope,
    kind,
    ...(kind === 'approval-required' ? { requestId: 'permission:1' } : {}),
  };
  return hostNotificationEventSchema.parse({
    ...identity,
    notificationVersion: 1,
    eventId:
      'notification_' + createHash('sha256').update(notificationIdentity(identity)).digest('hex'),
    createdAt: 100,
    expiresAt: 1000,
  });
};
function fixture() {
  let settings = { enabled: false, completed: true, failed: true, approvals: true },
    stored: any,
    support = true,
    clock = 200,
    saveFails = false;
  const notifications: any[] = [],
    timers = new Map<number, () => void>(),
    clicks: any[] = [];
  let nextTimer = 0;
  class NativeNotification extends EventEmitter {
    static isSupported() {
      return support;
    }
    shown = false;
    closed = false;
    constructor(readonly options: any) {
      super();
      notifications.push(this);
    }
    show() {
      this.shown = true;
    }
    close() {
      this.closed = true;
      this.emit('close');
    }
  }
  const dependencies = {
    Notification: NativeNotification,
    load: () => structuredClone(stored),
    save: (value: any) => {
      if (saveFails) throw new Error('Synthetic write failure');
      stored = structuredClone(value);
    },
    getSettings: () => settings,
    onClick: (event: any) => clicks.push(event),
    now: () => clock,
    schedule: ((fn: () => void) => {
      timers.set(++nextTimer, fn);
      return nextTimer;
    }) as any,
    cancel: ((id: number) => timers.delete(id)) as any,
  };
  return {
    notifications,
    timers,
    clicks,
    dependencies,
    manager: () => new DesktopNotifications(dependencies),
    stored: () => stored,
    setStored: (value: any) => (stored = value),
    setSettings: (value: Partial<typeof settings>) => {
      settings = { ...settings, ...value };
    },
    setSupport: (value: boolean) => (support = value),
    setNow: (value: number) => (clock = value),
    setSaveFails: (value: boolean) => (saveFails = value),
  };
}
test('native notifications default off, respect categories and acknowledge only the native show event', async () => {
  const f = fixture(),
    manager = f.manager();
  const event = makeEvent();
  assert.equal(await manager.receive(event), 'ignored');
  assert.equal(f.notifications.length, 0);
  f.setSettings({ enabled: true, approvals: false });
  assert.equal(await manager.receive(makeEvent('approval-required')), 'ignored');
  const next = { ...event, turnId: 'another-turn' };
  next.eventId =
    'notification_' + createHash('sha256').update(notificationIdentity(next)).digest('hex');
  let resolved = false;
  const pending = manager.receive(next).then((status) => {
    resolved = true;
    return status;
  });
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].shown, true);
  assert.equal(resolved, false);
  assert.equal(
    f.stored().events.at(-1).status,
    'failed',
    'attempt is persisted before calling native display',
  );
  assert.deepEqual(f.notifications[0].options, {
    title: 'Moor',
    body: '任务已完成',
    silent: false,
    hasReply: false,
  });
  f.notifications[0].emit('show');
  assert.equal(await pending, 'shown');
  assert.equal(f.timers.size, 0);
  assert.equal(manager.state().lastStatus, 'shown');
  f.notifications[0].emit('click');
  assert.deepEqual(f.clicks, [next]);
  assert.equal(await manager.receive(next), 'shown');
  assert.equal(f.notifications.length, 1);
  const restored = f.manager();
  assert.equal(await restored.receive(next), 'shown');
  assert.equal(f.notifications.length, 1, 'restart never replays an already attempted event');
});
test('native failed events, timeout, unsupported platform and persistence errors never report delivery', async () => {
  const f = fixture();
  f.setSettings({ enabled: true });
  const manager = f.manager(),
    pending = manager.receive(makeEvent());
  f.notifications[0].emit('failed', 'Raw OS error containing a private path');
  assert.equal(await pending, 'failed');
  assert.doesNotMatch(manager.state().message, /private path/);
  assert.equal(await f.manager().receive(makeEvent()), 'failed');
  assert.equal(f.notifications.length, 1);
  const timed = manager.test();
  f.timers.values().next().value!();
  assert.equal(await timed, 'failed');
  assert.equal(f.notifications[1].closed, true);
  f.setSupport(false);
  assert.equal(await manager.test(), 'failed');
  assert.equal(f.notifications.length, 2);
  const broken = fixture();
  broken.setSettings({ enabled: true });
  broken.setSaveFails(true);
  assert.equal(await broken.manager().receive(makeEvent()), 'failed');
  assert.equal(broken.notifications.length, 0);
});
test('current policy and event validity prevent forged or expired events, and disabling closes outstanding notifications', async () => {
  const f = fixture(),
    manager = f.manager(),
    event = makeEvent();
  for (const candidate of [
    { ...event, body: 'Leak content' },
    { ...event, sessionId: 'other' },
    { ...event, expiresAt: 100 },
    { ...event, kind: 'approval-required' },
    { ...event, createdAt: 100000, expiresAt: 100001 },
  ])
    await assert.rejects(manager.receive(candidate));
  f.setNow(1000);
  assert.equal(await manager.receive(event), 'ignored');
  f.setNow(200);
  f.setSettings({ enabled: true });
  const pending = manager.receive(event);
  f.setSettings({ enabled: false });
  manager.updateSettings();
  assert.equal(await pending, 'ignored');
  assert.equal(f.notifications[0].closed, true);
  f.notifications[0].emit('click');
  assert.equal(f.clicks.length, 0);
  const corrupted = fixture();
  corrupted.setStored({
    version: 1,
    events: [{ eventId: 'bad', status: 'shown', expiresAt: 1000 }],
  });
  corrupted.setSettings({ enabled: true });
  assert.equal(await corrupted.manager().receive(event), 'failed');
  assert.equal(corrupted.notifications.length, 0);
});
test('notification click URLs carry only validated host scope and cannot select an external origin or action', () => {
  const event = makeEvent('approval-required');
  assert.deepEqual(validateEvent(event), event);
  const url = new URL(notificationUrl('http://127.0.0.1:4321', event));
  assert.equal(url.origin, 'http://127.0.0.1:4321');
  assert.equal(url.pathname, '/');
  assert.deepEqual(JSON.parse(url.searchParams.get('notification')!), event);
  assert.deepEqual([...url.searchParams.keys()], ['notification']);
  for (const origin of [
    'https://external.invalid',
    'http://127.0.0.1:4321/other',
    'http://user@127.0.0.1:4321',
    'http://127.0.0.1:4321/?approve=yes',
  ])
    assert.throws(() => notificationUrl(origin, event));
});
