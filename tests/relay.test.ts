import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { syntheticRelay } from './support/synthetic-relay';
import type { Workspace } from '../src/catalog';

test('workspace HTTP routes bind a same-id session to the chosen replica and reject stale ownership', async (t) => {
  const f = await syntheticRelay();
  t.after(f.close);
  const spaces: Workspace[] = await (await f.api('/api/workspaces')).json();
  const space = spaces[0];
  assert.equal(space.hosts.length, 2);
  const [a, b] = space.hosts;
  const ra = space.replicas.find((r) => r.hostId === a.id && r.localProjectId === 'local-moor')!;
  const rb = space.replicas.find((r) => r.hostId === b.id && r.localProjectId === 'local-moor')!;
  const path = (replicaId: string) => `/api/workspaces/${space.id}/replicas/${replicaId}`;
  const session = '/sessions/same-session-id';
  assert.equal((await (await f.api(path(ra.id) + session)).json()).meta.machineId, a.machineId);
  assert.equal((await (await f.api(path(rb.id) + session)).json()).meta.machineId, b.machineId);
  const last = f.hosts[1].messages.at(-1);
  assert.equal(last.workspaceId, b.runtimeWorkspaceId);
  assert.equal(last.localProjectId, 'local-moor');
  const wrong = space.replicas.find(
    (r) => r.hostId === a.id && r.localProjectId === 'local-other',
  )!;
  assert.equal((await f.api(path(wrong.id) + session)).status, 404);
  const badMutation = {
    workspaceId: 'wrong-runtime',
    operationId: 'op',
    sessionId: 'same-session-id',
    kind: 'turn',
    expectedTurnId: null,
    update: '',
  };
  const count = f.hosts[0].messages.length;
  assert.equal((await f.api(path(ra.id) + '/mutations', badMutation)).status, 400);
  assert.equal(f.hosts[0].messages.length, count, 'invalid routing must not reach any host');
  assert.equal((await fetch(f.origin + path(ra.id) + session)).status, 401);
  const target = await (await f.api('/api/workspaces', { name: '研究' })).json();
  const move = await f.api(`/api/workspaces/${space.id}/hosts/${b.id}/move`, {
    workspaceId: target.id,
  });
  assert.equal(move.status, 200);
  assert.equal((await f.api(path(rb.id) + session)).status, 404);
  assert.equal(
    (await f.api(`/api/workspaces/${target.id}/replicas/${rb.id}${session}`)).status,
    200,
  );
  assert.equal(
    (await f.api(`/api/workspaces/${target.id}/replicas/${ra.id}${session}`)).status,
    404,
  );
});
test('workspace project grouping is durable metadata; offline and revoked hosts cannot execute', async (t) => {
  const f = await syntheticRelay();
  t.after(f.close);
  const [space]: Workspace[] = await (await f.api('/api/workspaces')).json();
  const replica = space.replicas[0],
    host = space.hosts.find((h) => h.id === replica.hostId)!;
  const project = await (
    await f.api(`/api/workspaces/${space.id}/projects`, { name: '统一项目' })
  ).json();
  assert.equal(
    (
      await f.api(`/api/workspaces/${space.id}/replicas/${replica.id}/assign`, {
        projectId: project.id,
      })
    ).status,
    200,
  );
  const socket = f.hosts.find((h) => h.device.id === host.deviceId)!.socket;
  const pong = once(socket, 'pong');
  socket.send(JSON.stringify({ type: 'unavailable' }));
  socket.ping();
  await pong;
  const [offline]: Workspace[] = await (await f.api('/api/workspaces')).json();
  assert.equal(offline.hosts.find((h) => h.id === host.id)!.online, false);
  assert.equal(offline.replicas.find((r) => r.id === replica.id)!.projectId, project.id);
  assert.equal(
    (await f.api(`/api/workspaces/${space.id}/replicas/${replica.id}/sessions/same-session-id`))
      .status,
    409,
  );
  await f.api(`/api/devices/${host.deviceId}/revoke`, {});
  assert.equal(
    (await f.api(`/api/workspaces/${space.id}/replicas/${replica.id}/sessions/same-session-id`))
      .status,
    404,
  );
});
test('subscriptions cannot combine a workspace, replica and different device', async (t) => {
  const f = await syntheticRelay();
  t.after(f.close);
  const [space]: Workspace[] = await (await f.api('/api/workspaces')).json();
  const viewer = new WebSocket(f.origin.replace('http:', 'ws:') + '/events', {
    headers: { Cookie: 'personal=' + f.secret, Origin: f.origin },
  });
  await once(viewer, 'open');
  const closed = once(viewer, 'close');
  viewer.send(
    JSON.stringify({
      type: 'watch',
      catalogWorkspaceId: space.id,
      replicaId: space.replicas[0].id,
      deviceId: space.hosts[1].deviceId,
      workspaceId: space.hosts[1].runtimeWorkspaceId,
      sessionId: 'same-session-id',
    }),
  );
  assert.equal((await closed)[0], 1008);
  assert.equal(
    f.hosts[1].messages.some((m) => m.type === 'watch'),
    false,
  );
});
