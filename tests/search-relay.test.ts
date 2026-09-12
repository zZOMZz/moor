import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PROTOCOL } from '../src/protocol';
import { SESSION_SEARCH_FEATURE } from '../src/search-protocol';
import { syntheticRelay } from './support/synthetic-relay';
import type { Workspace } from '../src/catalog';

async function fixture() {
  const relay = await syntheticRelay();
  const controls = {
    transform: undefined as undefined | ((result: any) => unknown),
    hold: undefined as undefined | (() => Promise<void>),
  };
  for (const host of relay.hosts) {
    host.runtime.features!.push(SESSION_SEARCH_FEATURE);
    host.responses.set('search-sessions', async (m) => {
      const { workspaceId, localProjectId, sessionId, searchVersion, scope, query } = m.params;
      const result = {
        workspaceId,
        localProjectId,
        sessionId,
        searchVersion,
        scope,
        query,
        confirmed: true,
        source: 'host-index',
        hits: [
          {
            sessionId,
            turnId: 'search-turn',
            itemIndex: 0,
            kind: 'message',
            excerpt: 'Synthetic indexed output from ' + host.runtime.machineId,
          },
        ],
        more: false,
        partial: false,
      };
      const response = controls.transform?.(result) ?? result;
      await controls.hold?.();
      return response;
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
  const host = space.hosts[0]!;
  const replica = space.replicas.find(
    (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
  )!;
  const input = {
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'same-session-id',
    searchVersion: 1,
    scope: 'session',
    query: '合成内容',
    limit: 30,
  };
  const path = `/api/workspaces/${space.id}/replicas/${replica.id}/session-search`;
  return {
    ...relay,
    space,
    host,
    replica,
    input,
    path,
    controls,
    synthetic: relay.hosts.find((h) => h.device.id === host.deviceId)!,
  };
}

test('host-only session search forwards the authorized project and never stores query or excerpts on the relay', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const host of f.space.hosts) {
    const replica = f.space.replicas.find(
      (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
    )!;
    const synthetic = f.hosts.find((h) => h.device.id === host.deviceId)!;
    const response = await f.api(
      `/api/workspaces/${f.space.id}/replicas/${replica.id}/session-search`,
      f.input,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.match(data.hits[0].excerpt, new RegExp(synthetic.runtime.machineId));
    assert.deepEqual(synthetic.messages.at(-1).params, f.input);
    assert.equal(synthetic.messages.at(-1).localProjectId, replica.localProjectId);
  }
  for (const table of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    assert.match(String(table.name), /^[a-z_]+$/u);
    assert.doesNotMatch(
      JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table.name}`).all()),
      /合成内容|Synthetic indexed output|host-index|search-turn/,
    );
  }
});

test('search rejects foreign scopes, unsupported features and malformed queries before reaching the host', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const other = f.store.createLogin('another-owner');
  const response = await fetch(f.origin + f.path, {
    method: 'POST',
    headers: { Cookie: 'personal=' + other, Origin: f.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(f.input),
  });
  assert.equal(response.status, 404);
  for (const change of [
    { workspaceId: 'other' },
    { localProjectId: 'other' },
    { sessionId: '' },
    { query: '' },
    { query: 'x'.repeat(501) },
    { scope: 'all-accounts' },
    { limit: 101 },
    { command: 'injected' },
  ])
    assert.equal((await f.api(f.path, { ...f.input, ...change })).status, 400);
  assert.equal((await f.api(f.path, { ...f.input, padding: 'x'.repeat(8 * 1024) })).status, 413);
  assert.equal((await f.api(f.path + '/extra', f.input)).status, 404);
  const pong = once(f.synthetic.socket, 'pong');
  f.synthetic.socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: f.synthetic.runtime.machineId,
      workspaces: [{ ...f.synthetic.runtime, features: [] }],
    }),
  );
  f.synthetic.socket.ping();
  await pong;
  assert.equal((await f.api(f.path, f.input)).status, 409);
  assert.equal(
    f.synthetic.messages.some((m) => m.method === 'search-sessions'),
    false,
  );
});

test('search results must match the original query, scope and requested result count', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const change of [
    { workspaceId: 'other' },
    { localProjectId: 'other' },
    { sessionId: 'other' },
    { scope: 'project' },
    { query: 'another' },
    { confirmed: false },
    { source: 'relay-index' },
  ]) {
    f.controls.transform = (result) => ({ ...result, ...change });
    assert.equal((await f.api(f.path, f.input)).status, 502);
  }
  f.controls.transform = (result) => ({
    ...result,
    hits: [{ ...result.hits[0], sessionId: 'other-session' }],
  });
  assert.equal((await f.api(f.path, f.input)).status, 502);
  assert.equal((await f.api(f.path, { ...f.input, scope: 'project' })).status, 200);
  f.controls.transform = (result) => ({ ...result, hits: [result.hits[0], result.hits[0]] });
  assert.equal((await f.api(f.path, { ...f.input, limit: 1 })).status, 502);
});

test('in-flight search results cannot survive logout, host moves or connection loss', async (t) => {
  for (const change of ['logout', 'move', 'unavailable'] as const)
    await t.test(change, async (t) => {
      const f = await fixture();
      t.after(f.close);
      let observed!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.controls.hold = async () => {
        observed();
        await held;
      };
      const pending = f.api(f.path, f.input);
      await entered;
      try {
        let status: number;
        if (change === 'logout') {
          await f.api('/api/logout', {});
          status = 401;
          release();
        } else if (change === 'move') {
          const target = await (
            await f.api('/api/workspaces', { name: 'Synthetic moved workspace' })
          ).json();
          await f.api(`/api/workspaces/${f.space.id}/hosts/${f.host.id}/move`, {
            workspaceId: target.id,
          });
          status = 404;
          release();
        } else {
          f.synthetic.socket.send(JSON.stringify({ type: 'unavailable' }));
          status = 409;
        }
        const response = await pending;
        assert.equal(response.status, status);
        assert.equal('hits' in (await response.json()), false);
      } finally {
        release();
      }
    });
});
