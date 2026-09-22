import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { DesktopWorkspaceClient } from '@moor/client/node/workspace-client';
import { desktopWorkspaceCatalogSchema } from '@moor/client/workspace-protocol';
import {
  workspaceCatalogSnapshotSchema,
  workspaceReplicaContextSchema,
} from '@moor/protocol/workspace-catalog';
import { PROTOCOL } from '@moor/protocol/protocol';
import { syntheticRelay } from '../fixtures/synthetic-relay';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

test('authenticated navigation returns one account snapshot and replica context exposes only the selected project', async (t) => {
  const f = await syntheticRelay();
  t.after(f.close);
  assert.equal((await fetch(f.origin + '/api/workspace-catalog')).status, 401);
  const response = await f.api('/api/workspace-catalog');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const snapshot = workspaceCatalogSnapshotSchema.parse(await response.json());
  assert.equal(snapshot.identity.owner, f.owner);
  assert.equal(snapshot.identity.actor.accountId, f.owner);
  assert.equal(snapshot.devices.length, 2);
  assert.equal(snapshot.workspaces[0]!.hosts.length, 2);
  const workspace = snapshot.workspaces[0]!;
  const replica = workspace.replicas[0]!;
  const path = `/api/workspaces/${workspace.id}/replicas/${replica.id}/context`;
  assert.equal((await fetch(f.origin + path)).status, 401);
  const context = workspaceReplicaContextSchema.parse(await (await f.api(path)).json());
  assert.deepEqual(context.identity, snapshot.identity);
  assert.equal(context.target.replicaId, replica.id);
  assert.equal(context.target.catalogProjectId, replica.projectId);
  assert.deepEqual(
    context.runtime.projects.map((project) => project.id),
    [replica.localProjectId],
  );
  assert.equal(
    f.hosts.flatMap((host) => host.messages).some((message) => message.type === 'request'),
    false,
  );

  f.store.revoke(f.owner, context.target.deviceId);
  assert.equal((await f.api(path)).status, 404);
  const after = workspaceCatalogSnapshotSchema.parse(
    await (await f.api('/api/workspace-catalog')).json(),
  );
  assert(!after.devices.some((device) => device.id === context.target.deviceId));
  assert(
    !after.workspaces
      .flatMap((value) => value.hosts)
      .some((host) => host.deviceId === context.target.deviceId),
  );
});

test('stable desktop requests use three scoped HTTP calls without full catalog scans or unrelated-project invalidation', async (t) => {
  const f = await syntheticRelay();
  t.after(f.close);
  const paths: string[] = [];
  const client = new DesktopWorkspaceClient({
    source: 'remote',
    origin: f.origin,
    cookie: 'personal=' + f.secret,
    current() {},
    fetch: (input, init) => {
      paths.push(new URL(String(input)).pathname);
      return fetch(input, init);
    },
  });
  t.after(() => client.close());
  const response: any = await client.request({ action: 'catalog', source: 'remote' });
  assert.equal(response.ok, true);
  const shown = desktopWorkspaceCatalogSchema.parse(response.value);
  const selected = shown.targets.find((entry) => entry.target.localProjectId === 'local-moor')!;
  const target = selected.target;
  const host = f.hosts.find((entry) => entry.device.id === target.deviceId)!;
  const entered = gate(),
    resumed = gate();
  host.responses.set('sessions', async () => {
    entered.release();
    await resumed.promise;
    return [];
  });
  let scans = 0;
  f.store.catalog.list = () => {
    scans++;
    throw Error('unexpected full catalog scan');
  };
  f.store.devices = () => {
    scans++;
    throw Error('unexpected full device scan');
  };
  const before = paths.length;
  const pending = client.request({
    action: 'execute',
    source: 'remote',
    connectionId: shown.connectionId,
    target,
    command: {
      method: 'sessions',
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      params: {},
    },
  });
  await entered.promise;
  const other = shown.targets.find(
    (entry) =>
      entry.target.deviceId === target.deviceId &&
      entry.target.localProjectId !== target.localProjectId,
  )!;
  const project = f.store.catalog.createProject(f.owner, target.catalogWorkspaceId, 'Unrelated', {
    kind: 'local',
  });
  f.store.catalog.assign(f.owner, target.catalogWorkspaceId, other.target.replicaId, project.id);
  resumed.release();
  assert.deepEqual(await pending, { ok: true, value: [] });
  assert.equal(scans, 0);
  const base = `/api/workspaces/${target.catalogWorkspaceId}/replicas/${target.replicaId}`;
  assert.deepEqual(paths.slice(before), [base + '/context', base + '/sessions', base + '/context']);
});

for (const change of ['assignment', 'logout'] as const)
  test(`scoped workspace responses recheck authorization after an in-flight ${change}`, async (t) => {
    const f = await syntheticRelay();
    t.after(f.close);
    const client = new DesktopWorkspaceClient({
      source: 'remote',
      origin: f.origin,
      cookie: 'personal=' + f.secret,
      current() {},
    });
    t.after(() => client.close());
    const response: any = await client.request({ action: 'catalog', source: 'remote' });
    const shown = desktopWorkspaceCatalogSchema.parse(response.value);
    const target = shown.targets.find(
      (entry) => entry.target.localProjectId === 'local-moor',
    )!.target;
    const host = f.hosts.find((entry) => entry.device.id === target.deviceId)!;
    const entered = gate(),
      resumed = gate();
    host.responses.set('sessions', async () => {
      entered.release();
      await resumed.promise;
      return [];
    });
    const pending = client.request({
      action: 'execute',
      source: 'remote',
      connectionId: shown.connectionId,
      target,
      command: {
        method: 'sessions',
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        params: {},
      },
    });
    await entered.promise;
    if (change === 'logout') f.store.logout(f.secret);
    else {
      const project = f.store.catalog.createProject(
        f.owner,
        target.catalogWorkspaceId,
        'Reassigned',
        { kind: 'local' },
      );
      f.store.catalog.assign(f.owner, target.catalogWorkspaceId, target.replicaId, project.id);
    }
    resumed.release();
    const result: any = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.rejected, false);
    assert.equal(host.messages.filter((message) => message.type === 'request').length, 1);
  });

test('replica mapping versions change when the same authenticated host reconnects', async (t) => {
  const f = await syntheticRelay();
  t.after(f.close);
  const snapshot = workspaceCatalogSnapshotSchema.parse(
    await (await f.api('/api/workspace-catalog')).json(),
  );
  const workspace = snapshot.workspaces[0]!;
  const replica = workspace.replicas[0]!;
  const path = `/api/workspaces/${workspace.id}/replicas/${replica.id}/context`;
  const before = workspaceReplicaContextSchema.parse(await (await f.api(path)).json());
  const host = f.hosts.find((entry) => entry.device.id === before.target.deviceId)!;
  const socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/bridge', {
    headers: { Authorization: 'Bearer ' + host.device.token },
  });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const ready = once(socket, 'message');
  socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: host.runtime.machineId,
      workspaces: [host.runtime],
    }),
  );
  await ready;
  const after = workspaceReplicaContextSchema.parse(await (await f.api(path)).json());
  assert.deepEqual(after.target, before.target);
  assert.notEqual(after.mappingVersion, before.mappingVersion);
});
