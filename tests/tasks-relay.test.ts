import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { syntheticRelay } from './support/synthetic-relay';
import { syntheticTaskGrant } from './support/task-plan';
import { SESSION_TASKS_FEATURE, TASK_LIMITS } from '../src/task-protocol';
import { PROTOCOL } from '../src/protocol';
import type { Workspace } from '../src/catalog';
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
async function fixture() {
  const relay = await syntheticRelay(),
    [space]: Workspace[] = await (await relay.api('/api/workspaces')).json(),
    binding = space.hosts[0]!;
  const peer = relay.hosts.find((peer) => peer.device.id === binding.deviceId)!,
    replica = space.replicas.find(
      (replica) => replica.hostId === binding.id && replica.localProjectId === 'local-moor',
    )!;
  peer.runtime.features!.push(SESSION_TASKS_FEATURE);
  async function hello() {
    const done = once(peer.socket, 'pong');
    peer.socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        machineId: peer.runtime.machineId,
        workspaces: [peer.runtime],
      }),
    );
    peer.socket.ping();
    await done;
  }
  await hello();
  const base = `/api/workspaces/${space.id}/replicas/${replica.id}`,
    scope = {
      taskVersion: 1,
      workspaceId: peer.runtime.id,
      localProjectId: replica.localProjectId,
      sessionId: 'same-session-id',
    };
  const grant = syntheticTaskGrant(scope.sessionId),
    read = { ...scope, confirmed: true, grants: [grant], truncated: false },
    action = { ...scope, grantId: 'grant', action: 'revoke', operationId: 'revoke' };
  const controls: {
    hold?: () => Promise<void>;
    transform?: (value: any) => unknown;
    failure?: boolean;
  } = {};
  for (const method of ['tasks-read', 'tasks-action'])
    peer.responses.set(method, async (request) => {
      await controls.hold?.();
      if (controls.failure) {
        peer.socket.send(
          JSON.stringify({
            type: 'response',
            requestId: request.requestId,
            error: { status: 400, message: 'SYNTHETIC_PRIVATE_ERROR', rejected: true },
          }),
        );
        return undefined;
      }
      const value =
        method === 'tasks-read'
          ? read
          : { ...request.params, confirmed: true, grant: { ...grant, state: 'canceled' } };
      return controls.transform ? controls.transform(structuredClone(value)) : value;
    });
  return { ...relay, peer, binding, replica, base, scope, grant, read, action, controls, hello };
}
test('task routes forward only scoped operations with trusted account authority and bounded safe responses', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const [method, input] of [
    ['tasks-read', f.scope],
    ['tasks-action', f.action],
  ] as const) {
    const response = await f.api(f.base + '/' + method, input);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const message = f.peer.messages.filter((message) => message.method === method).at(-1)!;
    assert.deepEqual(message.params, input);
    assert.equal(message.authorityOwner, f.owner);
    assert.equal(message.localProjectId, f.scope.localProjectId);
  }
  const count = f.peer.messages.filter((message) => message.method?.startsWith('tasks-')).length;
  for (const [path, input] of [
    [f.base + '/tasks-read/extra', f.scope],
    [f.base + '/tasks-read', { ...f.scope, localProjectId: 'other' }],
    [f.base + '/tasks-read', { ...f.scope, command: 'raw shell' }],
    [f.base + '/tasks-action', { ...f.action, action: 'send-anywhere' }],
    [f.base + '/tasks-read', { ...f.scope, padding: 'x'.repeat(TASK_LIMITS.requestBytes) }],
  ] as const)
    assert.notEqual((await f.api(path, input)).status, 200);
  assert.equal(
    f.peer.messages.filter((message) => message.method?.startsWith('tasks-')).length,
    count,
  );
  assert.equal(
    (
      await f.api(
        `/api/devices/${f.binding.deviceId}/tasks-read?workspace=${f.scope.workspaceId}`,
        f.scope,
      )
    ).status,
    404,
  );
});
for (const method of ['tasks-read', 'tasks-action'] as const)
  for (const failure of [false, true])
    test(`${method} hides late ${failure ? 'failure' : 'success'} after logout`, async (t) => {
      const f = await fixture();
      t.after(f.close);
      const entered = signal(),
        release = signal();
      t.after(release.resolve);
      f.controls.failure = failure;
      f.controls.hold = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = f.api(f.base + '/' + method, method === 'tasks-read' ? f.scope : f.action);
      await entered.promise;
      f.store.db.prepare('DELETE FROM login').run();
      release.resolve();
      const response = await pending;
      assert.equal(response.status, 401);
      assert.doesNotMatch(
        await response.text(),
        /SYNTHETIC_PRIVATE|instruction|completion|parent-assistant/,
      );
    });
test('task routes reject stale execution identities and malformed grant projections', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const transform of [
    (value: any) => ({ ...value, workspaceId: 'other' }),
    (value: any) => ({ ...value, grants: [{ ...value.grants[0], parentSessionId: 'foreign' }] }),
    (value: any) => ({
      ...value,
      grants: [{ ...value.grants[0], authority: { token: 'SYNTHETIC_PRIVATE' } }],
    }),
  ]) {
    f.controls.transform = transform;
    const response = await f.api(f.base + '/tasks-read', f.scope);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /SYNTHETIC_PRIVATE|instruction/);
  }
  f.controls.transform = undefined;
  const entered = signal(),
    release = signal();
  t.after(release.resolve);
  f.controls.hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.api(f.base + '/tasks-read', f.scope);
  await entered.promise;
  f.peer.runtime.userId = 'replacement-user';
  await f.hello();
  release.resolve();
  assert.equal((await pending).status, 409);
});
