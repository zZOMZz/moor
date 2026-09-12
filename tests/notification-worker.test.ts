import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NotificationWorker,
  genericNotification,
  type NotificationWorkerDependencies,
} from '../src/web/notification-worker';
import type { NotificationLocalState } from '../src/web/notification-storage';
const preferences = { completed: true, failed: true, approvals: true };
const event = {
  notificationVersion: 1,
  eventId: 'notification_' + 'a'.repeat(64),
  kind: 'completed',
  createdAt: 100,
  expiresAt: 10000,
  userId: 'host-user',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'session',
  turnId: 'turn',
  owner: 'owner',
  deviceId: 'device',
  catalogWorkspaceId: 'untrusted-route',
  replicaId: 'untrusted-replica',
};
function fixture() {
  let state: NotificationLocalState = {
    version: 1,
    revision: 0,
    binding: { owner: 'owner', preferences },
    records: [],
  };
  const shown: { title: string; options: NotificationOptions & { renotify?: boolean } }[] = [],
    navigations: string[] = [];
  const client = {
    id: 'page',
    type: 'window',
    url: 'https://moor.synthetic.invalid/current',
    navigate: async (url: string) => {
      navigations.push(url);
    },
    focus: async () => {},
  };
  const deps: NotificationWorkerDependencies = {
    origin: 'https://moor.synthetic.invalid',
    now: () => 1000,
    local: async (update) => {
      if (update) state = update(state);
      return structuredClone(state);
    },
    identity: async () => ({ owner: 'owner' }),
    show: async (title, options) => {
      shown.push({ title, options });
    },
    close: async () => {},
    client: async () => client,
    clients: async () => [client],
    open: async (url) => {
      navigations.push(url);
    },
  };
  return {
    worker: new NotificationWorker(deps),
    deps,
    shown,
    navigations,
    client,
    get state() {
      return state;
    },
  };
}
test('worker displays only fixed kind text, replaces event tags without renotify and click uses a fixed same-origin route', async () => {
  const f = fixture();
  await f.worker.push(event);
  await f.worker.push(event);
  assert.equal(f.shown.length, 2);
  assert.equal(f.shown[0]?.options.tag, event.eventId);
  assert.equal(f.shown[0]?.options.renotify, false);
  assert.equal(f.shown[0]?.title, 'Moor：回合已完成');
  assert.equal(JSON.stringify(f.shown[0]?.options).includes('body-from-agent'), false);
  await f.worker.click(event);
  const url = new URL(f.navigations[0]!);
  assert.equal(url.origin, f.deps.origin);
  assert.equal(url.pathname, '/');
  assert.deepEqual(JSON.parse(url.searchParams.get('notification')!), event);
});
test('invalid, expired, unwanted, owner-mismatched and login-unavailable pushes always show generic reminders without event data', async () => {
  for (const payload of [
    null,
    { ...event, body: 'secret' },
    { ...event, expiresAt: 999 },
    { ...event, owner: 'other' },
    { ...event, createdAt: 90000, expiresAt: 100000 },
  ]) {
    const f = fixture();
    await f.worker.push(payload);
    assert.deepEqual(f.shown, [genericNotification]);
    await f.worker.click(payload);
    assert.equal(f.navigations[0], f.deps.origin + '/');
  }
  const f = fixture();
  f.deps.identity = async () => {
    throw new Error('offline');
  };
  await f.worker.push(event);
  assert.deepEqual(f.shown, [genericNotification]);
  const disabled = fixture();
  await disabled.deps.local((state) => ({ ...state, binding: undefined }));
  await disabled.worker.push(event);
  assert.deepEqual(disabled.shown, [genericNotification]);
  const excluded = fixture();
  await excluded.deps.local((state) => ({
    ...state,
    binding: { owner: 'owner', preferences: { ...preferences, completed: false } },
  }));
  await excluded.worker.push(event);
  assert.deepEqual(excluded.shown, [genericNotification]);
});
test('a logout while fresh identity is being checked cannot retain event data', async () => {
  const f = fixture();
  f.deps.identity = async () => {
    await f.deps.local((state) => ({ ...state, binding: undefined }));
    return { owner: 'owner' };
  };
  await f.worker.push(event);
  assert.deepEqual(f.shown, [genericNotification]);
});
test('binding accepts only trusted current window clients and exact revision with a matching fresh account', async () => {
  const f = fixture(),
    message = {
      type: 'moor:notification-binding',
      expectedRevision: 0,
      owner: 'owner',
      preferences,
    };
  f.client.url = 'https://other.invalid';
  await assert.rejects(f.worker.binding('page', message));
  f.client.url = f.deps.origin;
  f.client.type = 'worker';
  await assert.rejects(f.worker.binding('page', message));
  f.client.type = 'window';
  f.deps.identity = async () => ({ owner: 'other' });
  await assert.rejects(f.worker.binding('page', message));
  f.deps.identity = async () => ({ owner: 'owner' });
  await f.worker.binding('page', message);
  assert.equal(f.state.revision, 1);
  await assert.rejects(
    f.worker.binding('page', { type: 'moor:notification-binding', expectedRevision: 0 }),
  );
  assert.equal(f.state.binding?.owner, 'owner');
  await f.worker.binding('page', { type: 'moor:notification-binding', expectedRevision: 1 });
  assert.equal(f.state.binding, undefined);
});
