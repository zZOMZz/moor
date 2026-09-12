import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createECDH, createHash } from 'node:crypto';
import { RelayNotifications } from '../src/relay/notifications';
import type { NotificationEnvelope } from '../src/notification-protocol';
import type { WebPushResult, WebPushTransport } from '../src/relay/web-push';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const browser = createECDH('prime256v1');
browser.setPrivateKey(Buffer.alloc(32, 2));
const preferences = { completed: true, failed: true, approvals: true };
const subscription = (name = 'browser') => ({
  endpoint: 'https://web.push.apple.com/' + name,
  keys: {
    p256dh: browser.getPublicKey().toString('base64url'),
    auth: Buffer.alloc(16, 3).toString('base64url'),
  },
});
const owner = 'account',
  loginHash = hash('synthetic-login'),
  otherLogin = hash('other-login'),
  now = 10000;
const event = (name = 'event'): NotificationEnvelope => ({
  notificationVersion: 1,
  eventId: 'notification_' + hash(name),
  owner,
  deviceId: 'device',
  userId: 'local-user',
  machineId: 'machine',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
  workspaceId: 'workspace',
  localProjectId: 'project',
  sessionId: 'session',
  turnId: 'turn',
  kind: 'completed',
  createdAt: now,
  expiresAt: now + 60000,
});
function fixture(t: { after(fn: () => void): void }) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE login(token TEXT PRIMARY KEY,owner TEXT,expires INTEGER)');
  for (const [token, account] of [
    [loginHash, owner],
    [otherLogin, owner],
    [hash('foreign-login'), 'foreign'],
  ])
    db.prepare('INSERT INTO login VALUES(?,?,?)').run(token!, account!, now + 100000);
  t.after(() => db.close());
  let clock = now,
    authorized = true;
  const sent: { subscription: unknown; event: unknown }[] = [];
  let outcome: (event: NotificationEnvelope) => Promise<WebPushResult> = async () => ({
    status: 'sent',
    statusCode: 201,
  });
  const transport: WebPushTransport = {
    state: { configured: true, publicKey: browser.getPublicKey().toString('base64url') },
    async send(subscription, event) {
      sent.push({ subscription, event });
      return outcome(event);
    },
  };
  const options = { now: () => clock, transport, authorize: () => authorized };
  const relay = new RelayNotifications(db, options);
  const subscribe = (name = 'browser', token = loginHash, account = owner) =>
    relay.subscribe(account, token, {
      notificationVersion: 1,
      expectedOwner: account,
      subscription: subscription(name),
      preferences,
    });
  return {
    db,
    relay,
    options,
    sent,
    subscribe,
    setNow: (value: number) => {
      clock = value;
    },
    revoke: () => {
      authorized = false;
    },
    outcome: (value: typeof outcome) => {
      outcome = value;
    },
  };
}

test('subscription is idempotent, login-scoped, canonical, does not disclose endpoint keys and cannot be stolen', (t) => {
  const f = fixture(t),
    first = f.subscribe();
  assert.deepEqual(f.subscribe(), first);
  assert.equal(first.endpointHash, hash(subscription().endpoint));
  assert.equal(f.relay.state(owner, loginHash).subscriptions.length, 1);
  assert.equal(f.relay.state(owner, otherLogin).subscriptions.length, 0);
  assert.equal(
    JSON.stringify(f.relay.state(owner, loginHash)).includes(subscription().endpoint),
    false,
  );
  assert.equal(
    JSON.stringify(f.relay.state(owner, loginHash)).includes(subscription().keys.auth),
    false,
  );
  assert.throws(() => f.subscribe('browser', hash('foreign-login'), 'foreign'));
  assert.throws(() => f.relay.update(owner, otherLogin, first.id, preferences));
  assert.deepEqual(f.relay.remove(owner, otherLogin, first.id), { removed: true });
  assert.equal(f.relay.state(owner, loginHash).subscriptions.length, 1);
  assert.throws(() => f.relay.state(owner, hash('invalid')));
  assert.throws(() => f.subscribe('browser', hash('foreign-login'), owner));
});

test('explicit new login registration rebinds same owner while replacing endpoints disables duplicates', (t) => {
  const f = fixture(t),
    first = f.subscribe();
  assert.deepEqual(f.subscribe('browser', otherLogin), first);
  assert.equal(f.relay.state(owner, loginHash).subscriptions.length, 0);
  f.relay.revokeLogin(loginHash);
  assert.equal(f.relay.state(owner, otherLogin).subscriptions[0]!.enabled, true);
  const second = f.subscribe('replacement', otherLogin);
  const state = f.relay.state(owner, otherLogin).subscriptions;
  assert.equal(state.filter((entry) => entry.enabled).length, 1);
  assert.equal(state.find((entry) => entry.enabled)!.id, second.id);
});

test('preferences gate delivery, duplicate events do not resend and only routing metadata is persisted', async (t) => {
  const f = fixture(t),
    sub = f.subscribe();
  f.relay.update(owner, loginHash, sub.id, { ...preferences, completed: false });
  assert.equal((await f.relay.deliver(event('off'))).staged, 0);
  f.relay.update(owner, loginHash, sub.id, preferences);
  assert.deepEqual(await f.relay.deliver(event()), { staged: 1, sent: 1, failed: 0, unknown: 0 });
  assert.equal((await f.relay.deliver(event())).staged, 0);
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.relay.deliver({ ...event(), sessionId: 'different-session' }));
  const rows = f.db.prepare('SELECT * FROM push_event').all();
  assert.equal(JSON.stringify(rows).includes('session'), false);
  assert.equal(JSON.stringify(rows).includes('local-user'), false);
  assert.equal(JSON.stringify(rows).includes('project'), false);
  const columns = f.db
    .prepare('PRAGMA table_info(push_delivery)')
    .all()
    .map((row) => row.name);
  assert.deepEqual(columns, [
    'owner',
    'event_id',
    'subscription_id',
    'status',
    'status_code',
    'updated_at',
  ]);
  await assert.rejects(f.relay.deliver({ ...event('private'), body: 'task content' } as any));
  assert.equal(f.sent.length, 1);
});

test('logout revocation shares its parent transaction, expiry and current authorization prevent delivery', async (t) => {
  const f = fixture(t);
  f.subscribe();
  f.db.exec('BEGIN');
  f.relay.revokeLogin(loginHash);
  f.db.prepare('DELETE FROM login WHERE token=?').run(loginHash);
  f.db.exec('ROLLBACK');
  assert.equal(f.relay.state(owner, loginHash).subscriptions[0]!.enabled, true);
  f.db.exec('BEGIN');
  f.relay.revokeLogin(loginHash);
  f.db.prepare('DELETE FROM login WHERE token=?').run(loginHash);
  f.db.exec('COMMIT');
  assert.throws(() => f.relay.state(owner, loginHash));
  assert.equal((await f.relay.deliver(event())).staged, 0);
  f.subscribe('new', otherLogin);
  f.revoke();
  assert.equal((await f.relay.deliver(event('revoked'))).staged, 0);
  assert.equal(f.sent.length, 0);
});

test('live login expiration and push subscription expiration disable background delivery', async (t) => {
  const f = fixture(t);
  f.subscribe();
  f.setNow(now + 100001);
  assert.equal(
    (await f.relay.deliver({ ...event(), createdAt: now + 100001, expiresAt: now + 110001 }))
      .staged,
    0,
  );
  assert.equal(f.sent.length, 0);
  assert.throws(() => f.relay.state(owner, loginHash));
  f.setNow(now);
  f.relay.subscribe(owner, otherLogin, {
    notificationVersion: 1,
    expectedOwner: owner,
    subscription: { ...subscription('expiring'), expirationTime: now + 1 },
    preferences,
  });
  f.setNow(now + 2);
  assert.equal(f.relay.state(owner, otherLogin).subscriptions[0]!.enabled, false);
});

test('provider 404/410 disables exact subscription and ambiguous failures have no automatic retry', async (t) => {
  const f = fixture(t);
  f.subscribe();
  f.outcome(async () => ({ status: 'expired', statusCode: 410 }));
  assert.equal((await f.relay.deliver(event('gone'))).failed, 1);
  assert.equal(f.relay.state(owner, loginHash).subscriptions[0]!.enabled, false);
  f.subscribe();
  f.outcome(async () => {
    throw new Error('synthetic provider private response');
  });
  assert.equal((await f.relay.deliver(event('uncertain'))).unknown, 1);
  assert.equal((await f.relay.deliver(event('uncertain'))).staged, 0);
  assert.equal(f.sent.length, 2);
  assert.equal(
    JSON.stringify(f.db.prepare('SELECT * FROM push_delivery').all()).includes('private response'),
    false,
  );
});

test('staging is atomic and a restart marks unfinished delivery unknown instead of retrying', async (t) => {
  const f = fixture(t);
  f.subscribe();
  f.db.exec(
    "CREATE TRIGGER fail_push BEFORE INSERT ON push_delivery BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  await assert.rejects(f.relay.deliver(event()));
  assert.equal(f.sent.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM push_event').get()!.n, 0);
  f.db.exec('DROP TRIGGER fail_push');
  let release!: (outcome: WebPushResult) => void;
  f.outcome(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  const pending = f.relay.deliver(event());
  await Promise.resolve();
  assert.equal(f.sent.length, 1);
  assert.equal(f.db.prepare('SELECT status FROM push_delivery').get()!.status, 'staged');
  const restarted = new RelayNotifications(f.db, f.options);
  assert.equal(f.db.prepare('SELECT status FROM push_delivery').get()!.status, 'unknown');
  assert.equal((await restarted.deliver(event())).staged, 0);
  assert.equal(f.sent.length, 1);
  release({ status: 'unknown' });
  await pending;
});

test('subscription and event budgets remain bounded and explicit removal is idempotent', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) f.subscribe('subscription-' + i);
  assert.throws(() => f.subscribe('subscription-overflow'));
  const first = f.relay.state(owner, loginHash).subscriptions[0]!;
  f.relay.remove(owner, loginHash, first.id);
  f.relay.remove(owner, loginHash, first.id);
  f.subscribe('subscription-new');
  const insert = f.db.prepare('INSERT INTO push_event VALUES(?,?,?,?,?,?,?)');
  for (let i = 0; i < 1000; i++)
    insert.run(owner, 'synthetic-' + i, 'fingerprint', 'device', 'completed', now, now + 1);
  await assert.rejects(f.relay.deliver(event()));
  f.setNow(now + 2);
  assert.equal((await f.relay.deliver(event())).staged, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM push_event').get()!.n, 1);
});

test('later delivery waves recheck login, preferences and device route after async provider work', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 5; i++) {
    const token = hash('browser-' + i);
    f.db.prepare('INSERT INTO login VALUES(?,?,?)').run(token, owner, now + 100000);
    f.subscribe('parallel-' + i, token);
  }
  let count = 0;
  f.outcome(async () => {
    count++;
    if (count === 4) f.revoke();
    return { status: 'sent' };
  });
  const result = await f.relay.deliver(event());
  assert.equal(result.staged, 5);
  assert.equal(result.sent, 4);
  assert.equal(result.failed, 1);
  assert.equal(f.sent.length, 4);
});

test('catalog regrouping preserves dedup while immutable execution identity changes are rejected', async (t) => {
  const f = fixture(t);
  f.subscribe();
  await f.relay.deliver(event());
  const regrouped = { ...event(), catalogWorkspaceId: 'moved-catalog', replicaId: 'moved-replica' };
  assert.equal((await f.relay.deliver(regrouped)).staged, 0);
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.relay.deliver({ ...regrouped, deviceId: 'another-device' }));
  assert.throws(() =>
    f.relay.subscribe(owner, loginHash, {
      notificationVersion: 1,
      expectedOwner: 'old-account',
      subscription: subscription('new-browser'),
      preferences,
    }),
  );
});

test('global concurrency is bounded across events and closing settles staged attempts without replay', async (t) => {
  const f = fixture(t);
  f.subscribe();
  let ready!: () => void;
  const fourStarted = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const releases: ((outcome: WebPushResult) => void)[] = [];
  f.outcome(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
        if (releases.length === 4) ready();
      }),
  );
  const pending = Array.from({ length: 6 }, (_, i) =>
    f.relay.deliver(event('parallel-event-' + i)),
  );
  await fourStarted;
  assert.equal(f.sent.length, 4);
  f.relay.close();
  assert.deepEqual(
    new Set(
      f.db
        .prepare('SELECT status FROM push_delivery')
        .all()
        .map((row) => row.status),
    ),
    new Set(['unknown']),
  );
  for (const resolve of releases) resolve({ status: 'unknown' });
  await Promise.all(pending);
  assert.equal(f.sent.length, 4);
  assert.throws(() => f.relay.state(owner, loginHash));
  assert.equal((await f.relay.deliver(event('after-close'))).staged, 0);
});

test('late invalid-subscription response does not disable explicitly refreshed subscription keys', async (t) => {
  const f = fixture(t);
  f.subscribe();
  let release!: (outcome: WebPushResult) => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  f.outcome(
    () =>
      new Promise((resolve) => {
        release = resolve;
        ready();
      }),
  );
  const pending = f.relay.deliver(event());
  await started;
  f.relay.subscribe(owner, loginHash, {
    notificationVersion: 1,
    expectedOwner: owner,
    subscription: {
      ...subscription(),
      keys: { ...subscription().keys, auth: Buffer.alloc(16, 9).toString('base64url') },
    },
    preferences,
  });
  release({ status: 'expired', statusCode: 410 });
  await pending;
  assert.equal(f.relay.state(owner, loginHash).subscriptions[0]!.enabled, true);
});
