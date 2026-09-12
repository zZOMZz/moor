import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NotificationController,
  pushEndpointHash,
  type NotificationBrowser,
} from '../src/web/notifications';
import type { NotificationLocalState } from '../src/web/notification-storage';
const preferences = { completed: true, failed: true, approvals: true };
const payload = {
  endpoint: 'https://push.synthetic.invalid/endpoint',
  keys: { p256dh: 'B' + 'a'.repeat(86), auth: 'a'.repeat(22) },
};
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const hash = await pushEndpointHash(payload.endpoint);
  const row = { id: 'subscription', enabled: true, endpointHash: hash, preferences };
  let local: NotificationLocalState = { version: 1, revision: 0, records: [] };
  let present = false,
    current = true,
    removeFails = false,
    badReceipt = false;
  const calls: string[] = [],
    requests: { path: string; body: any }[] = [];
  let registrationGate: (() => Promise<void>) | undefined;
  let tail = Promise.resolve();
  const browser: NotificationBrowser = {
    exclusive: async (work) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    },
    permission: () => 'default',
    requestPermission: () => {
      calls.push('permission');
      return Promise.resolve('granted');
    },
    getSubscription: async () => {
      calls.push('get');
      return present ? subscription : null;
    },
    subscribe: async () => {
      calls.push('subscribe');
      present = true;
      return subscription;
    },
    bind: async (owner, prefs, expectedRevision) => {
      if (expectedRevision !== undefined && local.revision !== expectedRevision)
        throw new Error('stale revision');
      calls.push(owner ? 'bind:' + owner : 'unbind');
      local = {
        ...local,
        revision: local.revision + 1,
        binding: owner ? { owner, preferences: prefs! } : undefined,
      };
    },
    local: async () => structuredClone(local),
    remember: async (record, expectedRevision) => {
      if (expectedRevision !== undefined && local.revision !== expectedRevision)
        throw new Error('stale revision');
      local.records = [
        ...local.records.filter((old) => old.id !== record.id || old.owner !== record.owner),
        structuredClone(record),
      ];
    },
    close: async () => {
      calls.push('close');
    },
  };
  const subscription = {
    toJSON: () => payload,
    unsubscribe: async () => {
      calls.push('unsubscribe');
      present = false;
      return true;
    },
  };
  const request = async (path: string, body?: unknown) => {
    requests.push({ path, body });
    calls.push(path);
    if (!body) return { configured: true, publicKey, subscriptions: [row] };
    if (path.endsWith('/remove')) {
      if (removeFails) throw new Error('offline');
      return { removed: true };
    }
    if (path === '/api/notifications/subscriptions') await registrationGate?.();
    return badReceipt
      ? { ...row, endpointHash: 'a'.repeat(64) }
      : { ...row, preferences: (body as any).preferences };
  };
  const create = () =>
    new NotificationController('owner', { browser, request, current: () => current, changed() {} });
  return {
    create,
    set registrationGate(value: (() => Promise<void>) | undefined) {
      registrationGate = value;
    },
    browser,
    calls,
    requests,
    row,
    get local() {
      return local;
    },
    set removeFails(v: boolean) {
      removeFails = v;
    },
    set badReceipt(v: boolean) {
      badReceipt = v;
    },
    set current(v: boolean) {
      current = v;
    },
  };
}
test('notification refresh exposes orphan server records without subscribing, enable preserves synchronous user activation', async () => {
  const f = await fixture(),
    controller = f.create();
  await controller.refresh();
  assert.equal(controller.enabled, false);
  assert.equal(controller.state?.subscriptions[0]?.enabled, true);
  assert.equal(f.calls.includes('permission'), false);
  assert.equal(f.calls.includes('subscribe'), false);
  f.calls.length = 0;
  const enabling = controller.enable();
  assert.equal(f.calls[0], 'permission');
  await enabling;
  assert.equal(controller.enabled, true);
  assert.equal(f.requests.at(-1)?.body.expectedOwner, 'owner');
  assert.ok(f.calls.indexOf('/api/notifications/subscriptions') < f.calls.indexOf('bind:owner'));
  assert.equal(f.local.records[0]?.id, 'subscription');
});
test('failed disable retains durable original server record across refresh and only manual retry removes it', async () => {
  const f = await fixture(),
    controller = f.create();
  await controller.refresh();
  await controller.enable();
  f.calls.length = 0;
  f.removeFails = true;
  await controller.disable();
  assert.equal(controller.enabled, false);
  assert.equal(f.local.binding, undefined);
  assert.equal(f.local.records[0]?.pendingDisable, true);
  assert.ok(
    f.calls.indexOf('unbind') <
      f.calls.indexOf('/api/notifications/subscriptions/subscription/remove'),
  );
  assert.ok(f.calls.includes('unsubscribe'));
  const replacement = f.create();
  f.calls.length = 0;
  await replacement.refresh();
  assert.equal(replacement.pendingDisable[0]?.id, 'subscription');
  assert.equal(replacement.enabled, false);
  assert.equal(f.calls.includes('subscribe'), false);
  assert.equal(
    f.calls.some((call) => call.endsWith('/remove')),
    false,
  );
  f.removeFails = false;
  await replacement.disable();
  assert.equal(replacement.pendingDisable.length, 0);
  assert.equal(f.local.records[0]?.pendingDisable, false);
});
test('wrong register receipt never binds a worker and stale account permission never subscribes', async () => {
  const f = await fixture(),
    controller = f.create();
  await controller.refresh();
  f.badReceipt = true;
  await controller.enable();
  assert.equal(controller.enabled, false);
  assert.equal(f.local.binding, undefined);
  assert.match(controller.error, /尚未确认/);
  const f2 = await fixture(),
    other = f2.create(),
    permission = deferred<NotificationPermission>();
  f2.browser.requestPermission = () => permission.promise;
  await other.refresh();
  const operation = other.enable();
  f2.current = false;
  permission.resolve('granted');
  await operation;
  assert.equal(f2.calls.includes('subscribe'), false);
  assert.equal(
    f2.requests.some((call) => call.body),
    false,
  );
});
test('disabling an orphan row does not disable a separately confirmed current browser', async () => {
  const f = await fixture(),
    controller = f.create();
  await controller.refresh();
  await controller.enable();
  await controller.disable({ id: 'orphan', endpointHash: 'b'.repeat(64) });
  assert.equal(controller.enabled, true);
  assert.equal(f.local.binding?.owner, 'owner');
  assert.equal(f.calls.includes('unsubscribe'), false);
});
test('unconfirmed preferences survive refresh as effective local settings until manual server confirmation', async () => {
  const f = await fixture(),
    controller = f.create();
  await controller.refresh();
  await controller.enable();
  f.badReceipt = true;
  await controller.savePreferences({ ...preferences, completed: false });
  assert.equal(controller.preferencesPending, true);
  assert.equal(controller.preferences.completed, false);
  const replacement = f.create();
  await replacement.refresh();
  assert.equal(replacement.preferencesPending, true);
  assert.equal(replacement.preferences.completed, false);
  f.badReceipt = false;
  await replacement.savePreferences(replacement.preferences);
  assert.equal(replacement.preferencesPending, false);
});
test('storage or browser-read failures do not skip remaining disable cleanup steps', async () => {
  for (const failing of ['remember', 'getSubscription'] as const) {
    const f = await fixture(),
      controller = f.create();
    await controller.refresh();
    await controller.enable();
    f.calls.length = 0;
    f.browser[failing] = async () => {
      throw new Error('Synthetic unavailable boundary');
    };
    await controller.disable();
    assert.ok(f.calls.includes('unbind'));
    assert.ok(f.calls.includes('close'));
    assert.ok(f.calls.some((call) => call.endsWith('/remove')));
    if (failing === 'remember') assert.ok(f.calls.includes('unsubscribe'));
    assert.match(controller.error, /尚未全部确认/);
  }
});

test('a pending permission cannot re-enable after another page disables, and registration is serialized with cleanup', async () => {
  const f = await fixture(),
    controller = f.create(),
    permission = deferred<NotificationPermission>();
  await controller.refresh();
  f.browser.requestPermission = () => permission.promise;
  const enabling = controller.enable();
  await f.browser.exclusive(() => f.browser.bind());
  permission.resolve('granted');
  await enabling;
  assert.equal(f.local.binding, undefined);
  assert.equal(f.calls.includes('subscribe'), false);
  assert.match(controller.error, /已改变/);
  const other = await fixture(),
    first = other.create();
  await first.refresh();
  const started = deferred<void>(),
    release = deferred<void>();
  other.registrationGate = async () => {
    started.resolve();
    await release.promise;
  };
  const registering = first.enable();
  await started.promise;
  let cleanupStarted = false;
  const cleanup = other.browser.exclusive(async () => {
    cleanupStarted = true;
    await other.browser.bind();
    const sub = await other.browser.getSubscription();
    await sub?.unsubscribe();
  });
  assert.equal(cleanupStarted, false);
  release.resolve();
  await registering;
  await cleanup;
  assert.equal(other.local.binding, undefined);
  assert.equal(cleanupStarted, true);
  assert.equal(other.calls.filter((call) => call === 'bind:owner').length, 1);
  assert.ok(other.calls.indexOf('bind:owner') < other.calls.indexOf('unbind'));
});
