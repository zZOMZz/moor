import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { PROTOCOL } from '../src/protocol';
import { MCP_FEATURE, MCP_LIMITS } from '../src/mcp-protocol';
import type { Workspace } from '../src/catalog';
import { syntheticRelay } from './support/synthetic-relay';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const relay = await syntheticRelay();
  const controls: { transform?: (value: any) => unknown; hold?: () => Promise<void> } = {};
  for (const host of relay.hosts) {
    host.runtime.features!.push(MCP_FEATURE);
    host.responses.set('mcp-read', async ({ params }) => {
      const result = {
        ...params,
        confirmed: true,
        catalogRevision: 1,
        servers: [
          {
            id: 'mcpv_synthetic',
            name: 'Synthetic MCP',
            description: 'Synthetic project tools',
            transport: 'http',
          },
        ],
      };
      await controls.hold?.();
      return controls.transform?.(result) ?? result;
    });
    const pong = once(host.socket, 'pong');
    host.socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        machineId: host.runtime.machineId,
        workspaces: [host.runtime],
      }),
    );
    host.socket.ping();
    await pong;
  }
  const [space]: Workspace[] = await (await relay.api('/api/workspaces')).json();
  const host = space.hosts[0]!,
    replica = space.replicas.find(
      (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
    )!;
  const input = {
    mcpVersion: 1,
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'same-session-id',
  };
  return {
    ...relay,
    controls,
    space,
    replica,
    host,
    input,
    path: `/api/workspaces/${space.id}/replicas/${replica.id}/mcp/read`,
    synthetic: relay.hosts.find((h) => h.device.id === host.deviceId)!,
  };
}
test('MCP relay exposes only a scoped no-store catalog and persists no server descriptions', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const response = await f.api(f.path, f.input);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).servers[0].name, 'Synthetic MCP');
  const requests = f.synthetic.messages.filter((m) => m.method === 'mcp-read');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].params, f.input);
  assert.equal(requests[0].localProjectId, f.replica.localProjectId);
  assert.equal(
    f.hosts.find((h) => h !== f.synthetic)!.messages.filter((m) => m.method === 'mcp-read').length,
    0,
  );
  for (const row of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const table = String(row.name);
    assert.match(table, /^[a-z_]+$/);
    assert.doesNotMatch(
      JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table}`).all()),
      /Synthetic project tools|mcpv_synthetic/,
    );
  }
});
test('MCP relay rejects injected commands, credentials, foreign scope and oversized input before dispatch', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const input of [
    { ...f.input, workspaceId: 'foreign' },
    { ...f.input, localProjectId: 'foreign' },
    { ...f.input, command: '/bin/sh' },
    { ...f.input, url: 'https://private.invalid/' },
    { ...f.input, headers: { Authorization: 'SYNTHETIC_PRIVATE_MCP' } },
    { ...f.input, mcpVersion: 2 },
  ])
    assert.equal((await f.api(f.path, input)).status, 400);
  assert.equal(
    (await f.api(f.path, { ...f.input, value: 'x'.repeat(MCP_LIMITS.requestBytes) })).status,
    413,
  );
  assert.equal((await f.api(f.path.replace('/read', '/save'), f.input)).status, 404);
  assert.equal(f.synthetic.messages.filter((m) => m.method === 'mcp-read').length, 0);
});
test('MCP relay withholds unverifiable catalogs and never returns private fields in errors', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const transform of [
    (v: any) => ({ ...v, sessionId: 'other' }),
    (v: any) => ({ ...v, workspaceId: 'other' }),
    (v: any) => ({ ...v, confirmed: false }),
    (v: any) => ({ ...v, catalogRevision: -1 }),
    (v: any) => ({ ...v, servers: [...v.servers, ...v.servers] }),
    (v: any) => ({
      ...v,
      servers: v.servers.map((s: any) => ({ ...s, url: 'SYNTHETIC_PRIVATE_MCP' })),
    }),
    (v: any) => ({
      ...v,
      servers: v.servers.map((s: any) => ({ ...s, env: { TOKEN: 'SYNTHETIC_PRIVATE_MCP' } })),
    }),
    (v: any) => ({ ...v, servers: v.servers.map((s: any) => ({ ...s, transport: 'shell' })) }),
    (v: any) => ({ ...v, private: 'SYNTHETIC_PRIVATE_MCP'.repeat(MCP_LIMITS.responseBytes) }),
  ]) {
    f.controls.transform = transform;
    const response = await f.api(f.path, f.input);
    assert.equal(response.status, 502);
    assert.doesNotMatch(JSON.stringify(await response.json()), /SYNTHETIC_PRIVATE_MCP/);
  }
});
test('MCP late reads cannot cross logout, identity, feature or project assignment changes', async (t) => {
  for (const change of ['logout', 'user', 'machine', 'feature', 'project'] as const)
    await t.test(change, async (t) => {
      const f = await fixture();
      t.after(f.close);
      const entered = signal(),
        release = signal();
      f.controls.hold = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = f.api(f.path, f.input);
      await entered.promise;
      if (change === 'logout') f.store.db.prepare('DELETE FROM login').run();
      else if (change === 'project')
        f.store.catalog.assign(
          f.owner,
          f.space.id,
          f.replica.id,
          f.space.projects.find((p) => p.id !== f.replica.projectId)!.id,
        );
      else {
        if (change === 'user') f.synthetic.runtime.userId = 'different-user';
        if (change === 'machine') f.synthetic.runtime.machineId = 'different-machine';
        if (change === 'feature') f.synthetic.runtime.features = [];
        const pong = Promise.race([
          once(f.synthetic.socket, 'pong'),
          once(f.synthetic.socket, 'close'),
        ]);
        f.synthetic.socket.send(
          JSON.stringify({
            type: 'hello',
            protocol: PROTOCOL,
            machineId: f.synthetic.runtime.machineId,
            workspaces: [f.synthetic.runtime],
          }),
        );
        f.synthetic.socket.ping();
        await pong;
      }
      release.resolve();
      const response = await pending;
      assert(response.status >= 400);
      assert.doesNotMatch(JSON.stringify(await response.json()), /Synthetic project tools/);
    });
});
test('MCP pending read rejects a replaced host socket and ignores its late response', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const entered = signal(),
    release = signal();
  f.controls.hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.api(f.path, f.input);
  await entered.promise;
  const replacement = new WebSocket(f.origin.replace('http:', 'ws:') + '/bridge', {
    headers: { Authorization: 'Bearer ' + f.synthetic.device.token },
  });
  t.after(() => replacement.terminate());
  await once(replacement, 'open');
  const pong = once(replacement, 'pong');
  replacement.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: f.synthetic.runtime.machineId,
      workspaces: [f.synthetic.runtime],
    }),
  );
  replacement.ping();
  await pong;
  release.resolve();
  const response = await pending;
  assert(response.status >= 400);
  assert.doesNotMatch(JSON.stringify(await response.json()), /Synthetic project tools/);
});
test('MCP configuration change emits only an authorized scoped invalidation marker', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const viewer = new WebSocket(f.origin.replace('http:', 'ws:') + '/events', {
    headers: { Cookie: 'personal=' + f.secret, Origin: f.origin },
  });
  t.after(() => viewer.terminate());
  await once(viewer, 'open');
  const message = once(viewer, 'message'),
    event = { type: 'mcp-changed', workspaceId: f.input.workspaceId };
  f.synthetic.socket.send(JSON.stringify(event));
  assert.deepEqual(JSON.parse(String((await message)[0])), {
    type: 'changed',
    deviceId: f.host.deviceId,
    workspaceId: f.input.workspaceId,
    room: { scope: 'mcp' },
  });
  const closed = once(viewer, 'close');
  f.store.db.prepare('DELETE FROM login').run();
  f.synthetic.socket.send(JSON.stringify(event));
  assert.equal((await closed)[0], 1008);
});
