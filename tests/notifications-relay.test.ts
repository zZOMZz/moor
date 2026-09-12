import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createECDH, createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { Store } from '../src/relay/accounts';
import { createApp } from '../src/relay/http';
import { PROTOCOL, type RuntimeWorkspace } from '../src/protocol';
import type { Workspace } from '../src/catalog';
import {
  NOTIFICATIONS_FEATURE,
  notificationIdentity,
  type HostNotificationEvent,
  type NotificationEnvelope,
} from '../src/notification-protocol';
import type { WebPushResult, WebPushTransport } from '../src/relay/web-push';

const owner = 'synthetic-relay-account',
  now = 10000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const browser = createECDH('prime256v1');
browser.setPrivateKey(Buffer.alloc(32, 2));
const preferences = { completed: true, failed: true, approvals: true };
const subscription = (name = 'browser') => ({
  endpoint: 'https://web.push.apple.com/synthetic-' + name,
  keys: {
    p256dh: browser.getPublicKey().toString('base64url'),
    auth: Buffer.alloc(16, 3).toString('base64url'),
  },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function hostEvent(
  runtime: RuntimeWorkspace,
  turnId = 'turn',
  changes: Partial<HostNotificationEvent> = {},
): HostNotificationEvent {
  const event: HostNotificationEvent = {
    notificationVersion: 1,
    eventId: '',
    userId: runtime.userId,
    machineId: runtime.machineId,
    workspaceId: runtime.id,
    localProjectId: runtime.projects[0]!.id,
    sessionId: 'synthetic-session',
    turnId,
    kind: 'completed',
    createdAt: now,
    expiresAt: now + 60000,
    ...changes,
  };
  event.eventId = 'notification_' + hash(notificationIdentity(event));
  return event;
}

// Actual HTTP and WebSocket handlers, with no runtime or provider connection.
async function fixture(t: TestContext, configured = true) {
  const store = new Store(':memory:', () => now);
  const secret = store.createLogin(owner);
  const sent: NotificationEnvelope[] = [];
  const started: { count: number; resolve: () => void }[] = [];
  let outcome: (event: NotificationEnvelope) => Promise<WebPushResult> = async () => ({
    status: 'sent',
    statusCode: 201,
  });
  const transport: WebPushTransport = {
    state: configured
      ? { configured: true, publicKey: browser.getPublicKey().toString('base64url') }
      : { configured: false, reason: '合成测试未配置推送' },
    async send(_subscription, event) {
      sent.push(structuredClone(event));
      for (const signal of started) if (sent.length >= signal.count) signal.resolve();
      return outcome(event);
    },
  };
  const app = createApp(store, {
    origin: 'http://127.0.0.1:0',
    setupToken: 'synthetic',
    pushTransport: transport,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  app.setOrigin(origin);
  t.after(async () => {
    await app.close();
    store.close();
  });
  async function api(path: string, body?: unknown, login = secret, requestOrigin = origin) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: 'personal=' + login,
        Origin: requestOrigin,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  }
  async function subscribe(name = 'browser', login = secret, expectedOwner = owner) {
    const response = await api(
      '/api/notifications/subscriptions',
      { notificationVersion: 1, expectedOwner, subscription: subscription(name), preferences },
      login,
    );
    assert.equal(response.status, 200);
    return response.body;
  }
  const runtime: RuntimeWorkspace = {
    id: 'local-workspace',
    name: 'Synthetic workspace',
    machineId: 'synthetic-machine',
    userId: 'authenticated-local-user',
    projects: [{ id: 'local-project', name: 'Synthetic project', rootPath: '/synthetic/project' }],
    agents: [],
    features: [NOTIFICATIONS_FEATURE],
  };
  const device = store.redeem(store.pair(owner), 'Synthetic host');
  async function connect() {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/bridge', {
      headers: { Authorization: 'Bearer ' + device.token },
    });
    const messages: any[] = [],
      inbox: any[] = [];
    const waiters: { matches: (message: any) => boolean; resolve: (message: any) => void }[] = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      const index = waiters.findIndex((waiter) => waiter.matches(message));
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(message);
      else inbox.push(message);
    });
    function next(type: string, eventId?: string): Promise<any> {
      const matches = (message: any) =>
        message.type === type && (eventId === undefined || message.eventId === eventId);
      const index = inbox.findIndex(matches);
      return index >= 0
        ? Promise.resolve(inbox.splice(index, 1)[0])
        : new Promise((resolve) => waiters.push({ matches, resolve }));
    }
    async function hello(workspaces = [runtime]) {
      const ready = next('ready');
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL,
          machineId: runtime.machineId,
          workspaces,
        }),
      );
      await ready;
    }
    function notify(event: HostNotificationEvent) {
      socket.send(JSON.stringify({ type: 'notification', event }));
    }
    async function barrier() {
      const pong = once(socket, 'pong');
      socket.ping();
      await pong;
    }
    await once(socket, 'open');
    await hello();
    return {
      socket,
      messages,
      hello,
      notify,
      barrier,
      ack: (event: HostNotificationEvent) => next('notification-ack', event.eventId),
    };
  }
  async function route() {
    const spaces = (await api('/api/workspaces')).body as Workspace[];
    const workspace = spaces.find((space) =>
      space.hosts.some((host) => host.deviceId === device.id),
    )!;
    const host = workspace.hosts.find((host) => host.deviceId === device.id)!;
    return {
      workspace,
      host,
      replica: workspace.replicas.find((replica) => replica.hostId === host.id)!,
    };
  }
  return {
    store,
    api,
    subscribe,
    secret,
    device,
    runtime,
    connect,
    route,
    sent,
    outcome: (fn: typeof outcome) => {
      outcome = fn;
    },
    waitForSent: (count: number) =>
      sent.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => started.push({ count, resolve })),
  };
}

test(
  'notification HTTP state is authenticated and unconfigured relay suppresses delivery cleanly',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, false);
    assert.equal((await f.api('/api/notifications', undefined, 'invalid')).status, 401);
    assert.deepEqual((await f.api('/api/notifications')).body, {
      notificationVersion: 1,
      configured: false,
      reason: '合成测试未配置推送',
      subscriptions: [],
    });
    assert.equal(
      (
        await f.api('/api/notifications/subscriptions', {
          notificationVersion: 1,
          expectedOwner: owner,
          subscription: subscription(),
          preferences,
        })
      ).status,
      409,
    );
    const host = await f.connect(),
      event = hostEvent(f.runtime);
    host.notify(event);
    assert.equal((await host.ack(event)).status, 'handled');
    assert.equal(f.sent.length, 0);
  },
);

test(
  'notification HTTP mutations bind expected owner, cookie login and origin without exposing keys',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      otherLogin = f.store.createLogin(owner),
      foreignLogin = f.store.createLogin('foreign-account');
    const input = {
      notificationVersion: 1,
      expectedOwner: owner,
      subscription: subscription(),
      preferences,
    };
    assert.equal((await f.api('/api/notifications/subscriptions', input, 'invalid')).status, 401);
    assert.equal(
      (await f.api('/api/notifications/subscriptions', input, f.secret, 'https://foreign.invalid'))
        .status,
      403,
    );
    assert.equal(
      (
        await f.api('/api/notifications/subscriptions', {
          ...input,
          expectedOwner: 'foreign-account',
        })
      ).status,
      409,
    );
    const { expectedOwner: _, ...missingOwner } = input;
    assert.equal((await f.api('/api/notifications/subscriptions', missingOwner)).status, 400);
    const sub = await f.subscribe();
    assert.deepEqual(await f.subscribe(), sub);
    assert.equal(sub.endpointHash, hash(subscription().endpoint));
    const state = (await f.api('/api/notifications')).body;
    assert.deepEqual(state.subscriptions, [sub]);
    assert.equal(JSON.stringify(state).includes(subscription().endpoint), false);
    assert.equal(JSON.stringify(state).includes(subscription().keys.auth), false);
    assert.deepEqual(
      (await f.api('/api/notifications', undefined, otherLogin)).body.subscriptions,
      [],
    );
    assert.deepEqual(
      (await f.api('/api/notifications', undefined, foreignLogin)).body.subscriptions,
      [],
    );
    assert.equal(
      (
        await f.api(
          '/api/notifications/subscriptions',
          { ...input, expectedOwner: 'foreign-account' },
          foreignLogin,
        )
      ).status,
      409,
    );
    const path = '/api/notifications/subscriptions/' + sub.id;
    const edit = {
      notificationVersion: 1,
      expectedOwner: owner,
      preferences: { ...preferences, completed: false },
    };
    assert.equal((await f.api(path + '/preferences', edit, otherLogin)).status, 404);
    assert.equal(
      (await f.api(path + '/preferences', { ...edit, expectedOwner: 'foreign-account' })).status,
      409,
    );
    assert.deepEqual((await f.api(path + '/preferences', edit)).body.preferences, edit.preferences);
    assert.equal(
      (await f.api(path + '/remove', { notificationVersion: 1, expectedOwner: 'foreign-account' }))
        .status,
      409,
    );
    assert.equal(
      (await f.api(path + '/remove', { notificationVersion: 1, expectedOwner: owner }, otherLogin))
        .status,
      200,
    );
    assert.equal((await f.api('/api/notifications')).body.subscriptions.length, 1);
    assert.deepEqual(
      (await f.api(path + '/remove', { notificationVersion: 1, expectedOwner: owner })).body,
      { removed: true },
    );
    assert.deepEqual((await f.api('/api/notifications')).body.subscriptions, []);
  },
);

test(
  'HTTP subscription validation rejects unapproved endpoints and invalid point or auth material',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    for (const push of [
      { ...subscription(), endpoint: 'https://127.0.0.1/private' },
      { ...subscription(), endpoint: 'https://web.push.apple.com.attacker.invalid/private' },
      { ...subscription(), endpoint: 'https://arbitrary.push.apple.com/private' },
      {
        ...subscription(),
        keys: { ...subscription().keys, p256dh: Buffer.alloc(65, 0).toString('base64url') },
      },
      {
        ...subscription(),
        keys: { ...subscription().keys, auth: Buffer.alloc(15, 0).toString('base64url') },
      },
    ])
      assert.equal(
        (
          await f.api('/api/notifications/subscriptions', {
            notificationVersion: 1,
            expectedOwner: owner,
            subscription: push,
            preferences,
          })
        ).status,
        400,
      );
    assert.deepEqual((await f.api('/api/notifications')).body.subscriptions, []);
    assert.equal(f.sent.length, 0);
  },
);

test(
  'logout revokes only its login subscriptions atomically and rolls back on database failure',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      otherLogin = f.store.createLogin(owner);
    const sub = await f.subscribe(),
      otherSub = await f.subscribe('other-browser', otherLogin);
    f.store.db.exec(
      "CREATE TEMP TRIGGER synthetic_logout_failure BEFORE DELETE ON login BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END",
    );
    assert.equal((await f.api('/api/logout', {})).status, 500);
    assert.equal(f.store.owner(f.secret), owner);
    assert.equal((await f.api('/api/notifications')).body.subscriptions[0].enabled, true);
    f.store.db.exec('DROP TRIGGER synthetic_logout_failure');
    assert.equal((await f.api('/api/logout', {})).status, 200);
    assert.equal((await f.api('/api/notifications')).status, 401);
    assert.equal(
      f.store.db.prepare('SELECT 1 FROM login WHERE token=?').get(hash(f.secret)),
      undefined,
    );
    assert.equal(
      f.store.db.prepare('SELECT enabled FROM push_subscription WHERE id=?').get(sub.id)!.enabled,
      0,
    );
    assert.equal(
      (await f.api('/api/notifications', undefined, otherLogin)).body.subscriptions[0].id,
      otherSub.id,
    );
    assert.equal(
      (await f.api('/api/notifications', undefined, otherLogin)).body.subscriptions[0].enabled,
      true,
    );
  },
);

test(
  'host notifications stamp authenticated relay routing, ack after transport and persist metadata only',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.subscribe();
    await f.subscribe('foreign-browser', f.store.createLogin('foreign-account'), 'foreign-account');
    const host = await f.connect(),
      route = await f.route(),
      event = hostEvent(f.runtime);
    const gate = deferred();
    t.after(gate.resolve);
    f.outcome(async () => {
      await gate.promise;
      return { status: 'sent', statusCode: 201 };
    });
    host.notify(event);
    await f.waitForSent(1);
    await host.barrier();
    assert.equal(
      host.messages.some((message) => message.type === 'notification-ack'),
      false,
    );
    assert.deepEqual(f.sent[0], {
      ...event,
      owner,
      deviceId: f.device.id,
      catalogWorkspaceId: route.workspace.id,
      replicaId: route.replica.id,
    });
    assert.notEqual(f.sent[0]!.userId, owner);
    gate.resolve();
    assert.equal((await host.ack(event)).status, 'handled');
    host.notify(event);
    assert.equal((await host.ack(event)).status, 'handled');
    assert.equal(f.sent.length, 1);
    const persisted = JSON.stringify([
      f.store.db.prepare('SELECT * FROM push_event').all(),
      f.store.db.prepare('SELECT * FROM push_delivery').all(),
    ]);
    for (const privateValue of [
      event.userId,
      event.sessionId,
      event.localProjectId,
      '/synthetic/project',
    ])
      assert.equal(persisted.includes(privateValue), false);
    assert.equal(f.store.db.prepare('SELECT status FROM push_delivery').get()!.status, 'sent');
  },
);

test(
  'provider failure and ambiguous outcomes are handled receipts without host-triggered resend',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.subscribe();
    const host = await f.connect();
    for (const status of ['failed', 'unknown'] as const) {
      f.outcome(async () => ({ status }));
      const event = hostEvent(f.runtime, status);
      host.notify(event);
      assert.equal((await host.ack(event)).status, 'handled');
      assert.equal(
        f.store.db.prepare('SELECT status FROM push_delivery WHERE event_id=?').get(event.eventId)!
          .status,
        status,
      );
      host.notify(event);
      assert.equal((await host.ack(event)).status, 'handled');
    }
    assert.equal(f.sent.length, 2);
  },
);

test(
  'host rejects forged event hashes and wrong local user, machine, workspace or project scope',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.subscribe();
    const host = await f.connect();
    const forged = { ...hostEvent(f.runtime), eventId: 'notification_' + 'a'.repeat(64) };
    for (const event of [
      forged,
      ...[
        { userId: owner },
        { machineId: 'other-machine' },
        { workspaceId: 'other-workspace' },
        { localProjectId: 'other-project' },
      ].map((change, index) => hostEvent(f.runtime, 'invalid-' + index, change)),
    ]) {
      host.notify(event);
      assert.equal((await host.ack(event)).status, 'rejected');
    }
    await host.hello([{ ...f.runtime, features: [] }]);
    const unsupported = hostEvent(f.runtime, 'unsupported');
    host.notify(unsupported);
    assert.equal((await host.ack(unsupported)).status, 'rejected');
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_event').get()!.n, 0);
  },
);

test(
  'host cannot inject a relay owner or task body through the strict notification frame',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.subscribe();
    for (const injected of [
      { owner: 'foreign-account' },
      { body: 'synthetic private task body' },
    ]) {
      const host = await f.connect(),
        closed = once(host.socket, 'close');
      host.notify({ ...hostEvent(f.runtime), ...injected });
      assert.equal((await closed)[0], 1008);
    }
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM push_event').get()!.n, 0);
  },
);

// Four pending sends fill the relay semaphore; ping is an ordered message barrier.
async function queued(t: TestContext) {
  const f = await fixture(t);
  await f.subscribe();
  const host = await f.connect(),
    gate = deferred();
  t.after(gate.resolve);
  f.outcome(async () => {
    await gate.promise;
    return { status: 'sent' };
  });
  const first = Array.from({ length: 4 }, (_, index) => hostEvent(f.runtime, 'occupy-' + index));
  for (const event of first) host.notify(event);
  await f.waitForSent(4);
  const pending = hostEvent(f.runtime, 'queued');
  host.notify(pending);
  await host.barrier();
  assert.equal(f.sent.length, 4);
  assert.equal(
    f.store.db.prepare('SELECT status FROM push_delivery WHERE event_id=?').get(pending.eventId)!
      .status,
    'staged',
  );
  return { ...f, host, gate, first, pending };
}

test(
  'a replaced host socket cannot authorize its queued notification through the new connection',
  { timeout: 10000 },
  async (t) => {
    const f = await queued(t),
      closed = once(f.host.socket, 'close');
    const replacement = await f.connect();
    await closed;
    f.gate.resolve();
    const marker = hostEvent(f.runtime, 'new-connection-marker');
    replacement.notify(marker);
    assert.equal((await replacement.ack(marker)).status, 'handled');
    assert.equal(
      f.sent.some((event) => event.eventId === f.pending.eventId),
      false,
    );
    assert.equal(
      f.store.db
        .prepare('SELECT status FROM push_delivery WHERE event_id=?')
        .get(f.pending.eventId)!.status,
      'failed',
    );
    assert.equal(
      f.host.messages.some((message) => message.type === 'notification-ack'),
      false,
    );
  },
);

test(
  'catalog regrouping invalidates queued routing and replay of an old receipt never resends',
  { timeout: 10000 },
  async (t) => {
    const f = await queued(t),
      route = await f.route();
    const target = await f.api('/api/workspaces', { name: 'Moved workspace' });
    assert.equal(target.status, 200);
    assert.equal(
      (
        await f.api(`/api/workspaces/${route.workspace.id}/hosts/${route.host.id}/move`, {
          workspaceId: target.body.id,
        })
      ).status,
      200,
    );
    f.gate.resolve();
    assert.equal((await f.host.ack(f.pending)).status, 'handled');
    for (const event of f.first) assert.equal((await f.host.ack(event)).status, 'handled');
    assert.equal(f.sent.length, 4);
    assert.equal(
      f.store.db
        .prepare('SELECT status FROM push_delivery WHERE event_id=?')
        .get(f.pending.eventId)!.status,
      'failed',
    );
    f.host.notify(f.first[0]!);
    assert.equal((await f.host.ack(f.first[0]!)).status, 'handled');
    assert.equal(f.sent.length, 4);
    const fresh = hostEvent(f.runtime, 'after-regroup');
    f.host.notify(fresh);
    assert.equal((await f.host.ack(fresh)).status, 'handled');
    assert.equal(f.sent.at(-1)!.catalogWorkspaceId, target.body.id);
  },
);

test(
  'logout while a notification waits for transport removes its delivery authorization',
  { timeout: 10000 },
  async (t) => {
    const f = await queued(t);
    assert.equal((await f.api('/api/logout', {})).status, 200);
    f.gate.resolve();
    assert.equal((await f.host.ack(f.pending)).status, 'handled');
    assert.equal(f.sent.length, 4);
    assert.equal(
      f.store.db
        .prepare('SELECT status FROM push_delivery WHERE event_id=?')
        .get(f.pending.eventId)!.status,
      'failed',
    );
  },
);
