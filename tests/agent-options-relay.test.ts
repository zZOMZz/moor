import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { PROTOCOL } from '../src/protocol';
import type { Workspace } from '../src/catalog';
import { syntheticRelay } from './support/synthetic-relay';
import { syntheticCapabilities } from './support/agent-capabilities';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const relay = await syntheticRelay();
  const [space]: Workspace[] = await (await relay.api('/api/workspaces')).json();
  const host = space.hosts[0]!;
  const replica = space.replicas.find(
    (item) => item.hostId === host.id && item.localProjectId === 'local-moor',
  )!;
  const peer = relay.hosts.find((item) => item.device.id === host.deviceId)!;
  const controls: {
    hold?: () => Promise<void>;
    transform?: (value: any) => unknown;
    error?: { status: number; message: string };
  } = {};
  peer.responses.set('agent-options', async (request) => {
    await controls.hold?.();
    if (controls.error) {
      peer.socket.send(
        JSON.stringify({ type: 'response', requestId: request.requestId, error: controls.error }),
      );
      return undefined;
    }
    const value = {
      id: request.params.agentId,
      name: 'Synthetic Agent',
      cliType: 'builtin',
      agentType: 'codex',
      runConfig: syntheticCapabilities,
    };
    return controls.transform ? controls.transform(value) : value;
  });
  return {
    ...relay,
    space,
    host,
    replica,
    peer,
    controls,
    path: `/api/workspaces/${space.id}/replicas/${replica.id}/agent-options`,
    old: { agentId: 'retired-agent-v1', sessionId: 'same-session-id' },
  };
}
async function hello(peer: Awaited<ReturnType<typeof fixture>>['peer']) {
  const done = Promise.race([once(peer.socket, 'pong'), once(peer.socket, 'close')]);
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

test('Agent options forwards a retired version with exact session/project scope and only projects safe fields', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.controls.transform = (value) => ({
    ...value,
    customAcp: { command: '/private/agent', args: ['secret'] },
    runtimeOverrides: { codexPath: '/private/codex' },
    token: 'SECRET',
    runConfig: { ...value.runConfig, secret: 'HIDDEN' },
  });
  const response = await f.api(f.path, f.old);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.deepEqual(result, {
    id: f.old.agentId,
    name: 'Synthetic Agent',
    cliType: 'builtin',
    agentType: 'codex',
    runConfig: syntheticCapabilities,
  });
  assert.doesNotMatch(JSON.stringify(result), /private|SECRET|HIDDEN/);
  const messages = f.peer.messages.filter((message) => message.method === 'agent-options');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].params, f.old);
  assert.equal(messages[0].workspaceId, f.host.runtimeWorkspaceId);
  assert.equal(messages[0].localProjectId, f.replica.localProjectId);
  assert.equal(
    f.hosts
      .find((host) => host !== f.peer)!
      .messages.filter((message) => message.method === 'agent-options').length,
    0,
  );
});

test('Agent options rejects unknown current IDs, malformed scope, extra commands, long bodies and extended routes before dispatch', async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.api(f.path, { agentId: f.old.agentId })).status, 404);
  for (const value of [
    { agentId: 'bad/id' },
    { agentId: 'agent', sessionId: '' },
    { ...f.old, rootPath: '/private' },
    { ...f.old, command: 'run' },
    { ...f.old, workspaceId: 'other' },
  ])
    assert.equal((await f.api(f.path, value)).status, 400);
  assert.equal((await f.api(f.path, { ...f.old, padding: 'x'.repeat(4096) })).status, 413);
  assert.equal((await f.api(f.path + '/extra', f.old)).status, 404);
  const foreign = f.space.id + '-foreign';
  assert.equal((await f.api(f.path.replace(f.space.id, foreign), f.old)).status, 404);
  assert.equal(f.peer.messages.filter((message) => message.method === 'agent-options').length, 0);
  assert.equal((await f.api(f.path, { agentId: 'agent' })).status, 200);
});

test('Agent options verifies reply ID, agent kind and bounded capability shapes', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const transform of [
    (value: any) => ({ ...value, id: 'another-version' }),
    (value: any) => ({ ...value, cliType: 'custom' }),
    (value: any) => ({ ...value, agentType: 'claude' }),
    (value: any) => ({ ...value, runConfig: { models: 'private invalid shape', modes: [] } }),
    (value: any) => ({ ...value, name: 'x'.repeat(201) }),
  ]) {
    f.controls.transform = transform;
    const response = await f.api(f.path, { agentId: 'agent' });
    assert.equal(response.status, 502);
    assert.doesNotMatch(JSON.stringify(await response.json()), /private invalid shape/);
  }
});

test('Agent options redacts ACP errors, cleans pending requests and accepts a later manual retry', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const status of [404, 409, 502, 999]) {
    f.controls.error = { status, message: '/private/agent TOKEN_SECRET raw ACP stderr' };
    const response = await f.api(f.path, f.old);
    assert.equal(response.status, status === 999 ? 502 : status);
    assert.doesNotMatch(JSON.stringify(await response.json()), /private|TOKEN_SECRET|stderr/);
  }
  f.controls.error = undefined;
  assert.equal((await f.api(f.path, f.old)).status, 200);
});

test('Agent options withholds late success and error responses after identity, project or login changes', async (t) => {
  for (const error of [false, true])
    for (const change of [
      'logout',
      'device',
      'unavailable',
      'user',
      'machine',
      'workspace',
      'project',
      'runtime-project',
    ] as const)
      await t.test(`${change}/${error ? 'error' : 'success'}`, async (t) => {
        const f = await fixture();
        t.after(f.close);
        const entered = signal(),
          release = signal();
        f.controls.hold = async () => {
          entered.resolve();
          await release.promise;
        };
        if (error) f.controls.error = { status: 403, message: 'RAW_AGENT_SECRET' };
        const pending = f.api(f.path, f.old);
        await entered.promise;
        if (change === 'logout') f.store.db.prepare('DELETE FROM login').run();
        else if (change === 'device') f.store.revoke(f.owner, f.peer.device.id);
        else if (change === 'unavailable') {
          const pong = once(f.peer.socket, 'pong');
          f.peer.socket.send(JSON.stringify({ type: 'unavailable' }));
          f.peer.socket.ping();
          await pong;
        } else if (change === 'project') {
          const other = f.space.projects.find((project) => project.id !== f.replica.projectId)!;
          f.store.catalog.assign(f.owner, f.space.id, f.replica.id, other.id);
        } else {
          if (change === 'user') f.peer.runtime.userId = 'different-user';
          if (change === 'machine') f.peer.runtime.machineId = 'different-machine';
          if (change === 'workspace') f.peer.runtime.id = 'different-workspace';
          if (change === 'runtime-project')
            f.peer.runtime.projects = f.peer.runtime.projects.filter(
              (project) => project.id !== f.replica.localProjectId,
            );
          await hello(f.peer);
        }
        release.resolve();
        const response = await pending;
        assert.ok(response.status >= 400);
        assert.doesNotMatch(
          JSON.stringify(await response.json()),
          /Synthetic Agent|RAW_AGENT_SECRET/,
        );
      });
});

test('Agent options rejects an in-flight current version that leaves the catalogue', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const entered = signal(),
    release = signal();
  f.controls.hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.api(f.path, { agentId: 'agent' });
  await entered.promise;
  f.peer.runtime.agents = [];
  await hello(f.peer);
  release.resolve();
  assert.equal((await pending).status, 409);
});

test('Agent options invalidates pending work when its socket is replaced and ignores the old response', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const entered = signal(),
    release = signal();
  f.controls.hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.api(f.path, f.old);
  await entered.promise;
  const replacement = new WebSocket(f.origin.replace('http:', 'ws:') + '/bridge', {
    headers: { Authorization: 'Bearer ' + f.peer.device.token },
  });
  t.after(() => replacement.terminate());
  await once(replacement, 'open');
  const pong = once(replacement, 'pong');
  replacement.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: f.peer.runtime.machineId,
      workspaces: [f.peer.runtime],
    }),
  );
  replacement.ping();
  await pong;
  // Invalidating the socket settles the HTTP request before the stale peer responds.
  const response = await pending;
  assert.ok(response.status >= 400);
  assert.doesNotMatch(JSON.stringify(await response.json()), /Synthetic Agent/);
  release.resolve();
});
