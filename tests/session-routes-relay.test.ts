import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { syntheticRelay } from './support/synthetic-relay';
import { AppError, PROTOCOL } from '../src/protocol';
import type { Workspace } from '../src/catalog';
import { LoroDoc, delta } from '../src/model';
import { createApp } from '../src/relay/http';
import { Store } from '../src/relay/accounts';
import { SESSION_CONTROL_FEATURE } from '../src/session-control-protocol';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function hello(peer: Awaited<ReturnType<typeof syntheticRelay>>['hosts'][number]) {
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
type Method =
  | 'sessions'
  | 'session'
  | 'mutate'
  | 'session-action'
  | 'cancel'
  | 'session-control'
  | 'session-operations';
type Route = 'replica' | 'device' | 'host';
async function fixture() {
  const relay = await syntheticRelay();
  const [space]: Workspace[] = await (await relay.api('/api/workspaces')).json();
  const host = space.hosts[0]!;
  const replica = space.replicas.find(
    (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
  )!;
  const peer = relay.hosts.find((p) => p.device.id === host.deviceId)!;
  peer.runtime.features!.push(SESSION_CONTROL_FEATURE);
  await hello(peer);
  const base = `/api/workspaces/${space.id}/replicas/${replica.id}`;
  const original = await (await relay.api(base + '/sessions/same-session-id')).json();
  assert.ok(original.meta, JSON.stringify(original));
  const scope = {
    controlVersion: 1,
    workspaceId: peer.runtime.id,
    localProjectId: replica.localProjectId,
    sessionId: 'same-session-id',
    userId: peer.runtime.userId,
    machineId: peer.runtime.machineId,
  };
  const create = { ...scope, action: 'create', operationId: 'operation-create', agentId: 'agent' };
  const recover = { ...scope, action: 'inspect', request: { kind: 'control', value: create } };
  const inputs: Record<Method, any> = {
    sessions: undefined,
    session: undefined,
    mutate: {
      operationId: 'operation-send',
      workspaceId: peer.runtime.id,
      sessionId: scope.sessionId,
      kind: 'turn',
      expectedTurnId: null,
      update: delta(new LoroDoc()),
    },
    'session-action': {
      operationId: 'operation-archive',
      workspaceId: peer.runtime.id,
      localProjectId: replica.localProjectId,
      sessionId: scope.sessionId,
      action: 'archive',
      expectedRevision: 0,
    },
    cancel: { sessionId: scope.sessionId, turnId: 'assistant-turn' },
    'session-control': create,
    'session-operations': recover,
  };
  const results: Record<Method, any> = {
    sessions: [original.meta],
    session: original,
    mutate: { accepted: true, delivered: true, operationId: inputs.mutate.operationId },
    'session-action': {
      accepted: true,
      delivered: true,
      operationId: inputs['session-action'].operationId,
      meta: { ...original.meta, metadataRevision: 1, isArchived: true },
    },
    cancel: { success: true },
    'session-control': {
      ...scope,
      confirmed: true,
      kind: 'create',
      status: 'accepted',
      operationId: create.operationId,
    },
    'session-operations': {
      ...scope,
      confirmed: true,
      action: 'inspect',
      operationId: create.operationId,
      found: false,
    },
  };
  const controls: {
    hold?: () => Promise<void>;
    error?: { status: number; message: string; rejected?: boolean };
    transform?: (value: any) => unknown;
  } = {};
  for (const method of Object.keys(results) as Method[])
    peer.responses.set(method, async (request) => {
      await controls.hold?.();
      if (controls.error) {
        peer.socket.send(
          JSON.stringify({ type: 'response', requestId: request.requestId, error: controls.error }),
        );
        return undefined;
      }
      return controls.transform
        ? controls.transform(structuredClone(results[method]))
        : results[method];
    });
  function path(method: Method, route: Route = 'replica') {
    const action =
      method === 'mutate'
        ? 'mutations'
        : method === 'session-action'
          ? 'session-actions'
          : method === 'session'
            ? 'sessions/' + scope.sessionId
            : method;
    return route === 'replica'
      ? base + '/' + action
      : route === 'host'
        ? `/api/workspaces/${space.id}/hosts/${host.id}/${action}`
        : `/api/devices/${host.deviceId}/${action}?workspace=${peer.runtime.id}`;
  }
  return {
    ...relay,
    space,
    host,
    replica,
    peer,
    base,
    scope,
    controls,
    inputs,
    results,
    path,
    call: (method: Method, route: Route = 'replica') =>
      relay.api(path(method, route), inputs[method]),
  };
}

test('Common session routes preserve their original request and safe response contracts', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const route of ['replica', 'device'] as const)
    for (const method of ['sessions', 'session', 'mutate', 'session-action', 'cancel'] as const) {
      const response = await f.call(method, route);
      assert.equal(
        response.status,
        200,
        `${method}/${route}: ${JSON.stringify(await response.clone().json())}`,
      );
      assert.deepEqual(await response.json(), f.results[method]);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const request = f.peer.messages.filter((m) => m.method === method).at(-1)!;
      assert.equal(request.workspaceId, f.peer.runtime.id);
      assert.equal(
        request.localProjectId,
        route === 'replica' || method === 'session-action' ? f.replica.localProjectId : undefined,
      );
      if (f.inputs[method]) assert.deepEqual(request.params, f.inputs[method]);
    }
  assert.equal((await f.call('sessions', 'host')).status, 200);
  assert.equal((await f.call('session-control')).status, 200);
  assert.equal((await f.call('session-operations')).status, 200);
});

test('Common session endpoints reject extended paths, malformed IDs, oversized metadata and extra commands before RPC', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const before = f.peer.messages.length;
  for (const route of ['replica', 'device'] as const) {
    for (const method of [
      'session',
      'mutate',
      'session-action',
      'cancel',
      'session-control',
      'session-operations',
    ] as const) {
      const url = new URL(f.path(method, route), f.origin);
      url.pathname += '/extra';
      assert.equal((await f.api(url.pathname + url.search, f.inputs[method])).status, 404);
    }
    assert.equal(
      (await f.api(f.path('cancel', route), { ...f.inputs.cancel, command: 'secret' })).status,
      400,
    );
    assert.equal(
      (
        await f.api(f.path('session-action', route), {
          ...f.inputs['session-action'],
          padding: 'x'.repeat(4096),
        })
      ).status,
      413,
    );
  }
  assert.equal((await f.api(f.path('sessions', 'host') + '/extra')).status, 404);
  assert.equal((await f.api(f.base + '/sessions/bad%2Fid')).status, 400);
  assert.equal((await f.api(f.base + '/sessions/same-session-id?version=bad!')).status, 400);
  assert.equal((await f.api(f.base + '/cancel', { sessionId: '', turnId: 't' })).status, 400);
  assert.equal(
    (await f.api(f.base + '/mutations', { ...f.inputs.mutate, command: 'secret' })).status,
    400,
  );
  assert.equal(f.peer.messages.length, before);
});

test('Session envelopes reject foreign identities, malformed payloads and forged receipts without forwarding content', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const cases: Array<[Method, (value: any) => any]> = [
    ['session', (v) => ({ ...v, meta: { ...v.meta, id: 'foreign-session' } })],
    ['session', (v) => ({ ...v, meta: { ...v.meta, userId: 'foreign-user' } })],
    ['session', (v) => ({ ...v, meta: { ...v.meta, machineId: 'foreign-machine' } })],
    [
      'session',
      (v) => ({
        ...v,
        meta: { ...v.meta, project: { kind: 'local', localProjectId: 'local-other' } },
      }),
    ],
    ['session', (v) => ({ ...v, update: 'PRIVATE_INVALID_BASE64!' })],
    [
      'session',
      (v) => ({
        ...v,
        agent: { id: 'different-agent', name: 'secret', cliType: 'builtin', agentType: 'codex' },
      }),
    ],
    [
      'session',
      (v) => ({
        ...v,
        metaBundle: {
          version: 0,
          entries: { '["m","session-other","title"]': { c: 'clock', d: 'PRIVATE_FOREIGN_BODY' } },
        },
      }),
    ],
    [
      'session',
      (v) => ({
        ...v,
        metaBundle: {
          version: 0,
          entries: {
            '["m","session-same-session-id","token"]': { c: 'clock', d: 'PRIVATE_TOKEN' },
          },
        },
      }),
    ],
    ['sessions', (v) => [...v, ...v]],
    ['sessions', (v) => [{ ...v[0], userId: 'foreign-user' }]],
    ['mutate', (v) => ({ ...v, operationId: 'another-operation' })],
    ['mutate', (v) => ({ ...v, accepted: false })],
    ['mutate', (v) => ({ ...v, token: 'PRIVATE_TOKEN' })],
    ['session-action', (v) => ({ ...v, meta: { ...v.meta, metadataRevision: 5 } })],
    ['session-action', (v) => ({ ...v, meta: { ...v.meta, isArchived: false } })],
    ['cancel', () => ({ success: false, message: 'PRIVATE_TOKEN' })],
    ['session-control', (v) => ({ ...v, userId: 'other' })],
    ['session-control', (v) => ({ ...v, operationId: 'other' })],
    ['session-operations', (v) => ({ ...v, action: 'abandon' })],
    ['session-operations', (v) => ({ ...v, detail: 'PRIVATE_TOKEN' })],
  ];
  for (const [method, transform] of cases) {
    f.controls.transform = transform;
    const response = await f.call(method);
    assert.equal(response.status, 502, method);
    assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE_|foreign-user|clock/);
  }
});

test('Session reads project safe Agent launch fields and accept exact durable negative receipts', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.controls.transform = (v) => ({
    ...v,
    token: 'PRIVATE',
    meta: { ...v.meta, customAcp: { command: '/private' } },
    agent: { ...f.peer.runtime.agents[0], customAcp: { command: '/private' } },
  });
  const response = await f.call('session');
  assert.equal(response.status, 200);
  assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE|private|customAcp/);
  for (const method of ['mutate', 'session-action'] as const) {
    f.controls.transform = () => ({
      accepted: false,
      delivered: false,
      abandoned: true,
      operationId: f.inputs[method].operationId,
    });
    const response = await f.call(method);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).abandoned, true);
  }
});

for (const route of ['replica', 'device', 'host'] as const)
  for (const method of (route === 'host'
    ? ['sessions']
    : [
        'sessions',
        'session',
        'mutate',
        'session-action',
        'cancel',
        ...(route === 'replica' ? ['session-control', 'session-operations'] : []),
      ]) as Method[])
    for (const error of [false, true])
      test(`${route} ${method} withholds late ${error ? 'error' : 'success'} after logout`, async (t) => {
        const f = await fixture();
        t.after(f.close);
        const entered = signal(),
          release = signal();
        t.after(release.resolve);
        f.controls.hold = async () => {
          entered.resolve();
          await release.promise;
        };
        if (error)
          f.controls.error = { status: 400, message: 'PRIVATE_HOST_ERROR', rejected: true };
        const pending = f.call(method, route);
        await entered.promise;
        f.store.db.prepare('DELETE FROM login').run();
        release.resolve();
        const response = await pending;
        assert.equal(response.status, 401);
        const body = await response.json();
        assert.equal(body.rejected, false);
        assert.doesNotMatch(JSON.stringify(body), /PRIVATE|metaBundle|operation-send|合成会话/);
      });

test('Session scope guard checks runtime user, machine, root, registry, product project and device changes on success and failure', async (t) => {
  for (const change of [
    'user',
    'machine',
    'root',
    'unavailable',
    'project',
    'host-move',
    'device',
    'feature',
  ] as const)
    for (const error of [false, true])
      await t.test(`${change}/${error}`, async (t) => {
        const f = await fixture();
        t.after(f.close);
        const entered = signal(),
          release = signal();
        t.after(release.resolve);
        f.controls.hold = async () => {
          entered.resolve();
          await release.promise;
        };
        if (error)
          f.controls.error = { status: 400, message: 'PRIVATE_HOST_ERROR', rejected: true };
        const method = change === 'feature' ? 'session-control' : 'session';
        const pending = f.call(method);
        await entered.promise;
        if (change === 'device') f.store.revoke(f.owner, f.peer.device.id);
        else if (change === 'project')
          f.store.catalog.assign(
            f.owner,
            f.space.id,
            f.replica.id,
            f.space.projects.find((p) => p.id !== f.replica.projectId)!.id,
          );
        else if (change === 'host-move') {
          const other = f.store.catalog.create(f.owner, 'other');
          f.store.catalog.moveHost(f.owner, f.space.id, f.host.id, other.id);
        } else {
          if (change === 'user') f.peer.runtime.userId = 'other-user';
          if (change === 'machine') f.peer.runtime.machineId = 'other-machine';
          if (change === 'root') f.peer.runtime.projects[0]!.rootPath = '/synthetic/replaced-root';
          if (change === 'unavailable') f.peer.runtime.projects = [];
          if (change === 'feature') f.peer.runtime.features = [];
          await hello(f.peer);
        }
        release.resolve();
        const response = await pending;
        assert.ok(response.status >= 400);
        const body = await response.json();
        assert.equal(body.rejected, false);
        assert.doesNotMatch(JSON.stringify(body), /PRIVATE|metaBundle|合成会话/);
      });
});

test('Old sockets cannot resolve pending session requests after replacement and no retry is dispatched', async (t) => {
  for (const method of [
    'sessions',
    'session',
    'mutate',
    'session-action',
    'cancel',
    'session-control',
    'session-operations',
  ] as const)
    await t.test(method, async (t) => {
      const f = await fixture();
      t.after(f.close);
      const entered = signal(),
        release = signal();
      t.after(release.resolve);
      f.controls.hold = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = f.call(method);
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
      const response = await pending;
      assert.ok(response.status >= 400);
      assert.equal((await response.json()).rejected, false);
      release.resolve();
      assert.equal(
        f.peer.messages.filter((m) => m.method === method).length,
        method === 'session' ? 2 : 1,
      );
    });
});

test('Safe errors and bounded receipts never leak upstream diagnostics or manufacture recovery rejection', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const method of [
    'session',
    'sessions',
    'mutate',
    'session-action',
    'cancel',
    'session-control',
    'session-operations',
  ] as const) {
    f.controls.error = { status: 999, message: 'PRIVATE_HOST_ERROR', rejected: true };
    const response = await f.call(method);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_HOST_ERROR/);
    if (method === 'cancel' || method === 'session-operations') assert.equal(body.rejected, false);
  }
  f.controls.error = undefined;
  f.controls.transform = (v) => ({ ...v, oversized: 'x'.repeat(65536) });
  assert.equal((await f.call('mutate')).status, 502);
  assert.equal((await f.call('session-control')).status, 502);
  f.controls.transform = undefined;
  assert.equal((await f.call('session')).status, 200);
});

test('Local instance probe is local-only, unauthenticated, exact and pins credential-bearing requests', async (t) => {
  for (const localOnly of [false, true]) {
    const store = new Store(':memory:');
    const app = createApp(store, {
      origin: 'http://127.0.0.1:0',
      setupToken: 'unused',
      localOnly,
      localInstanceId: 'instance-synthetic',
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    app.setOrigin(origin);
    t.after(async () => {
      await app.close();
      store.close();
    });
    const probe = await fetch(origin + '/api/local-instance');
    assert.equal(probe.status, localOnly ? 200 : 404);
    if (localOnly) assert.deepEqual(await probe.json(), { instanceId: 'instance-synthetic' });
    for (const instance of ['other-instance', 'instance-synthetic']) {
      const response = await fetch(origin + '/api/me', {
        headers: { 'X-Moor-Instance': instance },
      });
      assert.equal(response.status, localOnly && instance === 'instance-synthetic' ? 200 : 409);
    }
    assert.equal((await fetch(origin + '/api/local-instance/extra')).status, 401);
  }
});

test('Local challenge proofs bind the fresh challenge and instance without accepting credentials or arbitrary queries', async (t) => {
  const secret = 'synthetic-private-cli-secret',
    instanceId = 'instance-synthetic';
  const signed: string[] = [];
  const proof = (challenge: string) => {
    signed.push(challenge);
    return createHmac('sha256', secret)
      .update(JSON.stringify(['moor-cli-proof-v1', instanceId, challenge]))
      .digest('hex');
  };
  const store = new Store(':memory:');
  const app = createApp(store, {
    origin: 'http://127.0.0.1:0',
    setupToken: 'unused',
    localOnly: true,
    localInstanceId: instanceId,
    localInstanceProof: proof,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  app.setOrigin(origin);
  t.after(async () => {
    await app.close();
    store.close();
  });
  const challenges = [
    Buffer.alloc(32, 1).toString('base64url'),
    Buffer.alloc(32, 2).toString('base64url'),
  ];
  const signatures: string[] = [];
  for (const challenge of challenges) {
    const response = await fetch(origin + '/api/local-instance?challenge=' + challenge);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result, {
      instanceId,
      challenge,
      proof: createHmac('sha256', secret)
        .update(JSON.stringify(['moor-cli-proof-v1', instanceId, challenge]))
        .digest('hex'),
    });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-cli-secret/);
    signatures.push(result.proof);
  }
  assert.notEqual(signatures[0], signatures[1]);
  for (const query of [
    '?challenge=',
    '?challenge=short',
    '?challenge=' + 'A'.repeat(42),
    '?challenge=' + 'A'.repeat(44),
    '?challenge=' + 'A'.repeat(42) + 'B', // noncanonical base64 padding bits
    '?challenge=' + challenges[0] + '&challenge=' + challenges[1],
    '?challenge=' + challenges[0] + '&extra=1',
    '?extra=1',
  ])
    assert.equal((await fetch(origin + '/api/local-instance' + query)).status, 400);
  assert.deepEqual(signed, challenges);
  assert.equal(
    (
      await fetch(origin + '/api/local-instance?challenge=' + challenges[0], {
        headers: { 'X-Moor-Instance': 'stale' },
      })
    ).status,
    409,
  );
  assert.deepEqual(signed, challenges);
});

test('Local challenge cannot expose a missing, invalid or failed private proof provider', async (t) => {
  for (const provider of ['missing', 'invalid', 'failed'] as const) {
    const store = new Store(':memory:');
    const app = createApp(store, {
      origin: 'http://127.0.0.1:0',
      setupToken: 'unused',
      localOnly: true,
      localInstanceId: 'instance-synthetic',
      ...(provider === 'missing'
        ? {}
        : {
            localInstanceProof: () => {
              if (provider === 'failed') throw new AppError(403, 'PRIVATE_DIAGNOSTIC');
              return 'PRIVATE_PROOF';
            },
          }),
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    app.setOrigin(origin);
    t.after(async () => {
      await app.close();
      store.close();
    });
    const response = await fetch(
      origin + '/api/local-instance?challenge=' + Buffer.alloc(32, 3).toString('base64url'),
    );
    assert.equal(response.status, provider === 'invalid' ? 502 : 404);
    assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE/);
  }
});
