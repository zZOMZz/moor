import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { RuntimeStore } from '@moor/host/persistence/store';
import { HostDeviceMetadata } from '@moor/host/persistence/device-metadata';
import { Store } from '@moor/gateway/accounts';
import { PROTOCOL } from '@moor/protocol/protocol';
import { syntheticRelay } from '../fixtures/synthetic-relay';
import { DesktopDeviceMetadata } from '../../apps/desktop/src/main/device-metadata.cjs';

test(
  'real desktop host accepts private name IPC without restarting and restores host state over stale startup settings',
  { timeout: 20000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-device-ipc-')));
    const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
    t.after(async () => {
      for (const { child, closed } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
      }
      rmSync(root, { recursive: true, force: true });
    });
    const start = () => {
      const child = fork(
        resolve('apps/host/src/main.ts'),
        [
          '--desktop',
          '--server',
          '',
          '--config',
          join(root, 'private', 'bridge.json'),
          '--name',
          'Stale startup name',
          '--public-dir',
          resolve('apps/web/public'),
        ],
        {
          execArgv: ['--import', 'tsx'],
          env: { ...process.env, MOOR_RUNTIME_DATA: join(root, 'private', 'runtime.sqlite') },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      const closed = once(child, 'close');
      children.push({ child, closed });
      child.stdout?.resume();
      child.stderr?.resume();
      const messages: any[] = [],
        waiters = new Set<{ predicate: (m: any) => boolean; resolve: (m: any) => void }>();
      child.on('message', (message) => {
        messages.push(message);
        for (const waiter of waiters)
          if (waiter.predicate(message)) {
            waiters.delete(waiter);
            waiter.resolve(message);
          }
      });
      const wait = (predicate: (m: any) => boolean): Promise<any> => {
        const prior = messages.find(predicate);
        return prior
          ? Promise.resolve(prior)
          : Promise.race([
              new Promise((resolve) => waiters.add({ predicate, resolve })),
              closed.then(() => {
                throw Error('Synthetic host exited before IPC');
              }),
            ]);
      };
      let sequence = 0;
      const request = (action: unknown) => {
        const requestId = 'name-' + ++sequence;
        const result = wait(
          (m) => m.type === 'device-metadata-result' && m.requestId === requestId,
        );
        child.send({ type: 'device-metadata', requestId, action });
        return result;
      };
      return { child, closed, request, wait };
    };
    const host = start();
    await host.wait((m) => m.type === 'local-ready');
    const before = await host.request({ action: 'read' });
    assert.equal(before.state.metadata.name, 'Stale startup name');
    const pid = host.child.pid;
    const renamed = await host.request({
      action: 'rename',
      name: 'Host saved name',
      expectedRevision: before.state.metadata.revision,
    });
    assert.equal(renamed.ok, true);
    assert.equal(renamed.state.metadata.name, 'Host saved name');
    assert.equal(renamed.state.sync, 'unpaired');
    assert.equal(host.child.pid, pid);
    assert.equal(host.child.exitCode, null);
    assert.deepEqual(
      (await host.request({ action: 'read' })).state.metadata,
      renamed.state.metadata,
    );
    assert.equal(
      (await host.request({ action: 'rename', name: 'Stale edit', expectedRevision: 1 })).ok,
      false,
    );
    host.child.kill('SIGTERM');
    await host.closed;
    const reopened = start();
    await reopened.wait((m) => m.type === 'local-ready');
    assert.deepEqual(
      (await reopened.request({ action: 'read' })).state.metadata,
      renamed.state.metadata,
    );
  },
);

test('host name persists revisions across reopen and rejects stale edits, identity changes and failed writes', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-device-name-'))),
    file = join(root, 'runtime.sqlite');
  let store = new RuntimeStore(file);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  let names = new HostDeviceMetadata(store, 'Synthetic A');
  assert.deepEqual(names.read(), { version: 1, name: 'Synthetic A', revision: 1 });
  const first = names.handle({ action: 'rename', name: 'Synthetic B', expectedRevision: 1 });
  assert.equal(first.revision, 2);
  assert.deepEqual(
    names.handle({ action: 'rename', name: 'Synthetic B', expectedRevision: 2 }),
    first,
  );
  assert.throws(
    () => names.handle({ action: 'rename', name: 'Stale', expectedRevision: 1 }),
    /已更新/,
  );
  for (const name of ['', 'line\nbreak', 'x'.repeat(101)])
    assert.throws(() => names.handle({ action: 'rename', name, expectedRevision: 2 }));
  store.journal.db.exec(
    "CREATE TRIGGER reject_name BEFORE INSERT ON runtime_state WHEN NEW.key='device-metadata-v1' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END",
  );
  assert.throws(
    () => names.handle({ action: 'rename', name: 'Unsaved', expectedRevision: 2 }),
    /synthetic disk failure/,
  );
  assert.deepEqual(names.read(), first);
  store.journal.db.exec('DROP TRIGGER reject_name');
  store.close();
  store = new RuntimeStore(file);
  names = new HostDeviceMetadata(store, 'stale desktop settings');
  assert.deepEqual(names.read(), first);
  store.workspace.machineId = 'other-machine';
  assert.throws(() => names.read(), /执行身份/);
});

test('relay device name and catalog binding commit together and survive revoked, stale or legacy publications', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const login = await store.setup('synthetic-name@example.invalid', 'synthetic-password'),
    owner = store.owner(login);
  const pair = store.redeem(store.pair(owner), 'Paired name'),
    device = store.device(owner, pair.id);
  const workspace = {
    id: 'runtime',
    machineId: 'machine',
    userId: 'synthetic',
    name: 'Workspace',
    projects: [],
    agents: [],
  };
  const name = { version: 1 as const, name: 'Renamed', revision: 2 };
  assert.deepEqual(store.bind(device, 'machine', [workspace], name), name);
  assert.deepEqual(
    store.bind(device, 'machine', [workspace], { ...name, name: 'Old', revision: 1 }),
    name,
  );
  assert.deepEqual(store.bind(device, 'machine', [workspace]), name);
  assert.throws(
    () => store.bind(device, 'machine', [workspace], { ...name, name: 'Conflict' }),
    /不一致/,
  );
  const originalDiscover = store.catalog.discover;
  store.catalog.discover = () => {
    throw Error('synthetic catalog write failed');
  };
  assert.throws(() =>
    store.bind(device, 'machine', [workspace], { ...name, name: 'Unsaved', revision: 3 }),
  );
  store.catalog.discover = originalDiscover;
  assert.equal(store.device(owner, pair.id).name, name.name);
  assert.equal(store.catalog.list(owner, () => [workspace])[0].hosts[0].name, name.name);
  assert.throws(
    () => store.bind(device, 'other-machine', [], { ...name, revision: 3 }),
    /另一台机器/,
  );
  store.revoke(owner, pair.id);
  assert.throws(() => store.bind(device, 'machine', [], { ...name, revision: 3 }), /设备不可用/);
});

test('online viewers observe a confirmed name and reconnect reads the same name without dispatching an operation', async (t) => {
  const f = await syntheticRelay();
  t.after(f.close);
  const host = f.hosts[0];
  const viewer = new WebSocket(f.origin.replace('http:', 'ws:') + '/events', {
    headers: { Origin: f.origin, Cookie: 'personal=' + f.secret },
  });
  await once(viewer, 'open');
  t.after(() => viewer.terminate());
  const changes: any[] = [];
  viewer.on('message', (raw) => changes.push(JSON.parse(raw.toString())));
  const publish = async (socket: WebSocket, revision: number, name: string) => {
    const reply = new Promise<any>((resolve) => {
      const receive = (raw: any) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== 'ready') return;
        socket.off('message', receive);
        resolve(message);
      };
      socket.on('message', receive);
    });
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        machineId: host.runtime.machineId,
        workspaces: [host.runtime],
        deviceMetadata: { version: 1, name, revision },
      }),
    );
    return reply;
  };
  const changed = once(viewer, 'message');
  const reply = await publish(host.socket, 1, 'Synthetic desk');
  await changed;
  assert.equal(reply.deviceMetadata.name, 'Synthetic desk');
  assert.ok(changes.length);
  const spaces = await (await f.api('/api/workspaces')).json();
  const binding = spaces[0].hosts.find((entry: any) => entry.deviceId === host.device.id);
  assert.equal(binding.name, 'Synthetic desk');
  const oldClosed = once(host.socket, 'close');
  host.socket.close();
  await oldClosed;
  const replacement = new WebSocket(f.origin.replace('http:', 'ws:') + '/bridge', {
    headers: { Authorization: 'Bearer ' + host.device.token },
  });
  t.after(() => replacement.terminate());
  await once(replacement, 'open');
  await publish(replacement, 2, 'Offline rename');
  const staleReply = await publish(replacement, 1, 'Synthetic desk');
  assert.equal(staleReply.deviceMetadata.name, 'Offline rename');
  const devices = await (await f.api('/api/devices')).json();
  assert.equal(devices.find((entry: any) => entry.id === host.device.id).name, 'Offline rename');
  assert.equal(host.operations.size, 0);
  assert.equal(f.hosts[1].operations.size, 0);
});

test('desktop name IPC binds child, frame and reviewed version, strips private fields and never retries after timeout', async () => {
  const sent: any[] = [],
    timers = new Map<number, () => void>();
  let child = { connected: true, send: (message: any) => sent.push(message) },
    current = true,
    counter = 0;
  const bridge = new DesktopDeviceMetadata({
    bridge: () => child,
    schedule: (fn: () => void) => {
      timers.set(++counter, fn);
      return counter;
    },
    cancel: (timer: unknown) => timers.delete(Number(timer)),
  });
  const action = { action: 'rename', name: 'Synthetic', expectedRevision: 1 };
  const pending = bridge.request(action, () => current);
  const response = {
    type: 'device-metadata-result',
    requestId: sent[0].requestId,
    ok: true,
    state: {
      metadata: { version: 1, name: 'Synthetic', revision: 2, secret: 'PRIVATE' },
      sync: 'pending',
    },
  };
  bridge.receive({}, response);
  assert.equal(timers.size, 1);
  bridge.receive(child, response);
  assert.deepEqual(await pending, {
    metadata: { version: 1, name: 'Synthetic', revision: 2 },
    sync: 'pending',
  });
  const timeout = bridge.request({ action: 'read' }, () => current),
    failed = assert.rejects(timeout, /不会自动重试/);
  [...timers.values()][0]();
  await failed;
  assert.equal(sent.length, 2);
  const stale = bridge.request({ action: 'read' }, () => current),
    staleFailed = assert.rejects(stale, /窗口已变化/);
  current = false;
  bridge.receive(child, { ...response, requestId: sent[2].requestId });
  await staleFailed;
  current = true;
  const wrong = bridge.request(action, () => current),
    wrongFailed = assert.rejects(wrong, /不可验证/);
  bridge.receive(child, {
    ...response,
    requestId: sent[3].requestId,
    state: { ...response.state, metadata: { ...response.state.metadata, name: 'Other' } },
  });
  await wrongFailed;
  const replaced = bridge.request({ action: 'read' }, () => current),
    replacedFailed = assert.rejects(replaced, /已重启/);
  const previous = child;
  child = { ...child };
  bridge.disconnect(previous);
  await replacedFailed;
  bridge.close();
  assert.equal(timers.size, 0);
});
