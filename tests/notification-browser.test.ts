import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire as createPackageRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const preferences = { completed: true, failed: true, approvals: true };
test('browser cleanup clears bindings before failing APIs, keeps pending records and independently closes/unsubscribes', async () => {
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json')),
    { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/notification-browser-')),
    outfile = join(directory, 'browser.mjs');
  await build({
    entryPoints: ['src/web/notification-browser.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    plugins: [
      {
        name: 'synthetic-private-notification-storage',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/notification-storage$/ }, () => ({
            path: 'storage',
            namespace: 'synthetic',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({
            loader: 'js',
            contents:
              'export const notificationLocal=async update=>{if(globalThis.__notificationStorageFailure)throw new Error("Synthetic storage unavailable");if(update)globalThis.__notificationState=update(globalThis.__notificationState);return structuredClone(globalThis.__notificationState);};export const rememberNotification=async()=>{};',
          }));
        },
      },
    ],
  });
  let getFails = false,
    closed = 0,
    unsubscribed = 0,
    subscribed = 0;
  const messages: any[] = [];
  const subscription = {
    toJSON: () => ({
      endpoint: 'https://push.synthetic.invalid/token',
      keys: { p256dh: 'B' + 'a'.repeat(86), auth: 'a'.repeat(22) },
    }),
    unsubscribe: async () => {
      unsubscribed++;
      return true;
    },
  };
  const registration = {
    active: {
      postMessage: (message: unknown, ports: MessagePort[]) => {
        messages.push(message);
        ports[0]!.postMessage({ ok: true });
      },
    },
    pushManager: {
      getSubscription: async () => {
        if (getFails) throw new Error('Synthetic browser unavailable');
        return subscription;
      },
      subscribe: async () => {
        subscribed++;
        return subscription;
      },
    },
    getNotifications: async () => [
      {
        close: () => {
          closed++;
        },
      },
    ],
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: { request: async (_name: string, _options: unknown, work: () => unknown) => work() },
      serviceWorker: { getRegistration: async () => registration },
    },
  });
  const globals = globalThis as any;
  const reset = () => {
    globals.__notificationStorageFailure = false;
    globals.__notificationState = {
      version: 1,
      revision: 0,
      binding: { owner: 'previous-owner', preferences },
      records: [
        {
          owner: 'previous-owner',
          id: 'subscription',
          endpointHash: 'a'.repeat(64),
          pendingDisable: false,
        },
      ],
    };
  };
  try {
    const adapter = await import(pathToFileURL(outfile).href);
    reset();
    getFails = true;
    await assert.rejects(adapter.clearLocalNotifications(), /browser unavailable/);
    assert.equal(globals.__notificationState.binding, undefined);
    assert.equal(globals.__notificationState.records[0].pendingDisable, true);
    assert.equal(closed, 1);
    assert.deepEqual(Object.keys(messages[0]).sort(), ['expectedRevision', 'type']);
    reset();
    getFails = false;
    globals.__notificationStorageFailure = true;
    await assert.rejects(adapter.clearLocalNotifications(), /storage unavailable/);
    assert.equal(closed, 2);
    assert.equal(unsubscribed, 1);
    reset();
    await adapter.reconcileNotificationAccount('new-owner');
    assert.equal(globals.__notificationState.binding, undefined);
    assert.equal(unsubscribed, 2);
    assert.equal(subscribed, 0);
    reset();
    await adapter.clearLocalNotifications(999);
    assert.equal(globals.__notificationState.binding.owner, 'previous-owner');
    assert.equal(unsubscribed, 2);
  } finally {
    delete globals.__notificationStorageFailure;
    delete globals.__notificationState;
    await rm(directory, { recursive: true, force: true });
  }
});
