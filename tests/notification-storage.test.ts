import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNotificationStorage,
  notificationLocalSchema,
} from '../src/web/notification-storage';
function fixture() {
  const timers = new Set<() => void>();
  let closed = 0,
    aborted = 0,
    created = 0,
    puts = 0;
  const get: any = {},
    transaction: any = {
      abort() {
        aborted++;
        transaction.onabort?.();
      },
      objectStore: () => ({
        get: () => get,
        put: () => {
          puts++;
        },
      }),
    };
  const db: any = {
    close() {
      closed++;
    },
    createObjectStore() {
      created++;
    },
    transaction: () => transaction,
  };
  const open: any = { result: db, transaction };
  const local = createNotificationStorage({
    open: () => open,
    schedule: (callback) => {
      timers.add(callback);
      return callback;
    },
    cancel: (timer) => {
      timers.delete(timer as () => void);
    },
  });
  return {
    local,
    open,
    get,
    transaction,
    timers,
    timeout() {
      assert.equal(timers.size, 1);
      [...timers][0]!();
    },
    get closed() {
      return closed;
    },
    get aborted() {
      return aborted;
    },
    get created() {
      return created;
    },
    get puts() {
      return puts;
    },
  };
}
test('private notification storage aborts timed-out transactions and ignores late binding reads/completion', async () => {
  const f = fixture();
  let updates = 0;
  const writing = f.local((state) => {
    updates++;
    return {
      ...state,
      binding: {
        owner: 'user@example.invalid',
        preferences: { completed: true, failed: true, approvals: true },
      },
    };
  });
  f.open.onsuccess();
  await Promise.resolve();
  f.timeout();
  await assert.rejects(writing, /超时/);
  assert.equal(f.aborted, 1);
  assert.equal(f.closed, 1);
  f.get.onsuccess();
  f.transaction.oncomplete();
  assert.equal(updates, 0);
  assert.equal(f.puts, 0);
  const pending = fixture();
  const transaction = pending.local((state) => state);
  pending.open.onsuccess();
  await Promise.resolve();
  pending.get.onsuccess();
  assert.equal(pending.puts, 1);
  pending.timeout();
  await assert.rejects(transaction, /超时/);
  assert.equal(pending.aborted, 1);
});
test('timed-out database opens close late handles and abort late upgrades, valid owner IDs remain accepted', async () => {
  const f = fixture(),
    opening = f.local();
  f.timeout();
  await assert.rejects(opening, /超时/);
  const aborted = f.aborted;
  f.open.onupgradeneeded();
  assert.equal(f.aborted, aborted + 1);
  assert.equal(f.created, 0);
  f.open.onsuccess();
  assert.equal(f.closed, 1);
  assert.ok(
    notificationLocalSchema.safeParse({
      version: 1,
      revision: 0,
      binding: {
        owner: 'user@example.invalid',
        preferences: { completed: true, failed: true, approvals: true },
      },
      records: [],
    }).success,
  );
  assert.equal(
    notificationLocalSchema.safeParse({
      version: 1,
      revision: 0,
      binding: {
        owner: 'bad\nowner',
        preferences: { completed: true, failed: true, approvals: true },
      },
      records: [],
    }).success,
    false,
  );
});
