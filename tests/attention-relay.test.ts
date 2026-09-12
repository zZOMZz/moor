import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';
import { Store } from '../src/relay/accounts';
import { createApp } from '../src/relay/http';
import { PROTOCOL, type RuntimeWorkspace } from '../src/protocol';
import {
  ACTOR_FEATURE,
  ATTENTION_FEATURE,
  FOLLOWUP_FEATURE,
  type AttentionActor,
  type AttentionContext,
} from '../src/attention';
import type { Workspace } from '../src/catalog';
import { RuntimeStore } from '../src/runtime/store';
import { LoroDoc, mirror, putMeta } from '../src/model';

const features = [ATTENTION_FEATURE, ACTOR_FEATURE, FOLLOWUP_FEATURE];
const addressOf = (server: ReturnType<typeof createServer>) => {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return 'http://127.0.0.1:' + address.port;
};
const nextMessage = (socket: WebSocket, matches: (message: any) => boolean) =>
  new Promise<any>((resolve) => {
    const listener = (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (matches(message)) {
        socket.off('message', listener);
        resolve(message);
      }
    };
    socket.on('message', listener);
  });

async function fixture(options: { localOnly?: boolean; authenticatedHello?: boolean } = {}) {
  const store = new Store(':memory:');
  const secret = await store.setup('synthetic@example.invalid', 'synthetic-password-only');
  const accountId = store.owner(secret);
  const actor: AttentionActor = {
    kind: options.localOnly ? 'local' : 'relay',
    authorityId: store.authorityId,
    accountId,
  };
  const app = createApp(store, {
    origin: 'http://127.0.0.1:0',
    setupToken: 'synthetic-only',
    localOnly: options.localOnly,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = addressOf(app.server);
  app.setOrigin(origin);
  const device = store.redeem(store.pair(accountId), 'Synthetic host');
  const runtime: RuntimeWorkspace = {
    id: 'runtime-synthetic',
    machineId: 'machine-synthetic',
    userId: 'host-user-synthetic',
    name: 'Synthetic runtime',
    projects: [{ id: 'local-project', name: 'Synthetic project', rootPath: '/synthetic/project' }],
    agents: [],
    features,
  };
  const requests: any[] = [];
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/bridge', {
    headers: { Authorization: 'Bearer ' + device.token },
  });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'request') return;
    requests.push(message);
    socket.send(
      JSON.stringify({ type: 'response', requestId: message.requestId, result: { routed: true } }),
    );
  });
  await once(socket, 'open');
  const ready = nextMessage(socket, (message) => message.type === 'ready');
  socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: runtime.machineId,
      workspaces: [runtime],
      ...(options.authenticatedHello === false ? {} : { attentionActor: actor }),
    }),
  );
  await ready;
  const api = (path: string, body?: unknown) =>
    fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: 'personal=' + secret, Origin: origin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const [space]: Workspace[] = await (await api('/api/workspaces')).json();
  const replica = space.replicas[0];
  const prefix = `/api/workspaces/${space.id}/replicas/${replica.id}`;
  return {
    store,
    app,
    actor,
    accountId,
    origin,
    device,
    runtime,
    requests,
    socket,
    api,
    space,
    replica,
    prefix,
    viewer: async () => {
      const viewer = new WebSocket(origin.replace('http:', 'ws:') + '/events', {
        headers: { Cookie: 'personal=' + secret, Origin: origin },
      });
      await once(viewer, 'open');
      return viewer;
    },
    close: async () => {
      await app.close();
      store.close();
    },
  };
}

test('authority survives reopening and identity APIs separate local and remote accounts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'moor-attention-authority-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'accounts.sqlite');
  const first = new Store(filename);
  const authority = first.authorityId;
  first.close();
  const reopened = new Store(filename);
  assert.equal(reopened.authorityId, authority);
  reopened.close();
  const other = new Store(':memory:');
  assert.notEqual(other.authorityId, authority);
  other.close();
  for (const localOnly of [false, true]) {
    const f = await fixture({ localOnly });
    t.after(f.close);
    const identity = await (await f.api('/api/me')).json();
    assert.deepEqual(identity.actor, f.actor);
    assert.deepEqual(identity.attentionFeatures, features);
    const response = await fetch(f.origin + '/api/device-context', {
      headers: { Authorization: 'Bearer ' + f.device.token },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      executionDeviceId: f.device.id,
      actor: f.actor,
      attentionFeatures: features,
    });
    assert.equal(
      (await f.api('/api/device-context')).status,
      401,
      'browser login is not a device bearer',
    );
    const code = f.store.pair(f.accountId);
    const paired = await fetch(f.origin + '/api/pair/redeem', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + code, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: 'Second synthetic host' }),
    });
    assert.equal(paired.status, 200);
    const result = await paired.json();
    assert.deepEqual(result.actor, f.actor);
    assert.equal(result.authorityId, f.actor.authorityId);
    assert.equal(result.accountId, f.accountId);
    f.store.revoke(f.accountId, f.device.id);
    assert.equal(
      (
        await fetch(f.origin + '/api/device-context', {
          headers: { Authorization: 'Bearer ' + f.device.token },
        })
      ).status,
      401,
    );
  }
});

test('attention routes inject complete trusted scope and cannot degrade into legacy session operations', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const context: AttentionContext = {
    actor: f.actor,
    executionDeviceId: f.device.id,
    machineId: f.runtime.machineId,
    catalogWorkspaceId: f.space.id,
    projectId: f.replica.projectId,
    replicaId: f.replica.id,
    runtimeWorkspaceId: f.runtime.id,
    localProjectId: f.replica.localProjectId,
  };
  assert.equal((await f.api(f.prefix + '/attention?limit=3')).status, 200);
  assert.equal(f.requests.at(-1).method, 'attention-list');
  assert.deepEqual(f.requests.at(-1).context, context);
  assert.deepEqual(f.requests.at(-1).params, { view: 'pending', limit: 3 });
  const items = f.prefix + '/sessions/session-one/attention';
  assert.equal((await f.api(items + '?view=processed')).status, 200);
  assert.equal(f.requests.at(-1).method, 'attention-items');
  const item = items + '/outcome%3Aturn-one';
  assert.equal((await f.api(item)).status, 200);
  assert.equal(f.requests.at(-1).method, 'attention-detail');
  assert.deepEqual(f.requests.at(-1).context, { ...context, sessionId: 'session-one' });
  assert.equal(f.requests.at(-1).params.itemId, 'outcome:turn-one');
  const seen = { operationId: 'seen-one', eventRevision: 1 };
  const disposition = { ...seen, observationRevision: 0, disposition: 'checked' };
  const permission = {
    ...seen,
    requestId: 'request-one',
    expectedTurnId: 'user-turn',
    optionId: 'allow',
  };
  const continuation = {
    eventRevision: 1,
    observationRevision: 0,
    mutation: {
      operationId: 'continue-one',
      workspaceId: f.runtime.id,
      sessionId: 'session-one',
      kind: 'turn',
      expectedTurnId: 'user-turn',
      update: 'synthetic-update',
    },
  };
  for (const [action, input] of [
    ['seen', seen],
    ['disposition', disposition],
    ['permission', permission],
    ['continue', continuation],
  ] as const) {
    assert.equal((await f.api(item + '/' + action, input)).status, 200);
    assert.equal(f.requests.at(-1).method, 'attention-' + action);
    assert.deepEqual(f.requests.at(-1).params.input, input);
  }
  const count = f.requests.length;
  assert.equal((await f.api(item + '/seen', { ...seen, actor: f.actor })).status, 400);
  assert.equal(
    (
      await f.api(item + '/continue', {
        ...continuation,
        mutation: { ...continuation.mutation, sessionId: 'other-session' },
      })
    ).status,
    400,
  );
  assert.equal((await f.api(f.prefix + '/attention?actor=forged')).status, 400);
  assert.equal((await f.api(f.prefix + '/attention?limit=51')).status, 400);
  assert.equal((await f.api(item + '/unsupported', seen)).status, 404);
  assert.equal((await f.api(f.prefix + '/mutations', continuation)).status, 400);
  assert.equal((await fetch(f.origin + item)).status, 401);
  assert.equal(
    f.requests.length,
    count,
    'rejected requests never reach a legacy or attention host method',
  );
  const moved = await (await f.api('/api/workspaces', { name: 'Moved scope' })).json();
  await f.api(`/api/workspaces/${f.space.id}/hosts/${f.space.hosts[0].id}/move`, {
    workspaceId: moved.id,
  });
  assert.equal((await f.api(item)).status, 404);
  const movedPath = `/api/workspaces/${moved.id}/replicas/${f.replica.id}/attention`;
  assert.equal((await f.api(movedPath)).status, 200);
  assert.equal(f.requests.at(-1).context.catalogWorkspaceId, moved.id);
  await f.api(`/api/devices/${f.device.id}/revoke`, {});
  assert.equal((await f.api(movedPath)).status, 404);
});

test('unbound and downgraded bridge connections cannot advertise or receive attention operations', async (t) => {
  const f = await fixture({ authenticatedHello: false });
  t.after(f.close);
  const [space]: Workspace[] = await (await f.api('/api/workspaces')).json();
  const devices = await (await f.api('/api/devices')).json();
  assert.deepEqual(devices[0].workspaces[0].features, []);
  assert.equal(space.hosts.length, 1);
  assert.equal((await f.api(f.prefix + '/attention')).status, 409);
  assert.equal(f.requests.length, 0);
  const closed = once(f.socket, 'close');
  f.socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: f.runtime.machineId,
      workspaces: [f.runtime],
      attentionActor: { ...f.actor, authorityId: 'wrong-authority' },
    }),
  );
  assert.equal((await closed)[0], 1008);
});

test('personal invalidations stay in the authenticated actor and reject extra payloads or foreign scopes', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const viewer = await f.viewer();
  const delivered = nextMessage(viewer, (message) => message.room?.scope === 'attention');
  f.socket.send(
    JSON.stringify({
      type: 'attention-changed',
      actor: f.actor,
      workspaceId: f.runtime.id,
      sessionId: 'session-one',
    }),
  );
  const event = await delivered;
  assert.deepEqual(event.room, { scope: 'attention', actor: f.actor, docId: 'session-one' });
  const foreign: any[] = [];
  viewer.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.room?.scope === 'attention') foreign.push(message);
  });
  const closed = once(f.socket, 'close');
  f.socket.send(
    JSON.stringify({
      type: 'attention-changed',
      actor: { ...f.actor, accountId: 'another-account' },
      workspaceId: f.runtime.id,
      sessionId: 'secret-session',
    }),
  );
  assert.equal((await closed)[0], 1008);
  const pong = once(viewer, 'pong');
  viewer.ping();
  await pong;
  assert.deepEqual(foreign, []);
  const extra = await fixture();
  t.after(extra.close);
  const rejected = once(extra.socket, 'close');
  extra.socket.send(
    JSON.stringify({
      type: 'attention-changed',
      actor: extra.actor,
      workspaceId: extra.runtime.id,
      sessionId: 'session-one',
      observation: { private: 'synthetic-payload' },
    }),
  );
  assert.equal((await rejected)[0], 1008, 'invalidations cannot carry observation payloads');
});

test(
  'host pins a legacy pairing and validates every attention request against its trusted Target',
  { timeout: 20000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'moor-attention-target-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const actor: AttentionActor = {
      kind: 'relay',
      authorityId: 'synthetic-authority',
      accountId: 'synthetic-account',
    };
    const executionDeviceId = 'synthetic-device';
    let contextReads = 0;
    const server = createServer((request, response) => {
      if (request.url !== '/api/device-context') {
        response.writeHead(404).end();
        return;
      }
      assert.equal(request.headers.authorization, 'Bearer synthetic-private-token');
      contextReads++;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ executionDeviceId, actor, attentionFeatures: features }));
    });
    const sockets = new WebSocketServer({ server, path: '/bridge' });
    t.after(async () => {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = addressOf(server);
    const configFile = join(directory, 'pair.json');
    writeFileSync(
      configFile,
      JSON.stringify({ server: origin, id: executionDeviceId, token: 'synthetic-private-token' }),
      { mode: 0o600 },
    );
    const runtimeFile = join(directory, 'runtime.sqlite');
    const seeded = new RuntimeStore(runtimeFile);
    const localProjectId = seeded.registerProject(directory);
    const sessionId = 'session-synthetic';
    const doc = new LoroDoc();
    const view = mirror(doc, sessionId);
    const turnDefaults = {
      timestamp: '2026-01-01T00:00:00Z',
      userId: undefined,
      userTurnId: undefined,
      status: undefined,
      read: undefined,
      inputConfig: undefined,
      fileDiff: null,
      finished: true,
    };
    view.setState((state) => {
      state.history.push(
        {
          ...turnDefaults,
          id: 'user-synthetic',
          role: 'user',
          timestamp: '2026-01-01T00:00:00Z',
          finished: true,
          items: [{ type: 'text', text: 'Synthetic input' }],
        },
        {
          ...turnDefaults,
          id: 'assistant-synthetic',
          userTurnId: 'user-synthetic',
          role: 'assistant',
          timestamp: '2026-01-01T00:00:00Z',
          finished: true,
          status: 'handled',
          items: [{ type: 'text', text: 'Synthetic result' }],
        },
      );
    });
    view.dispose();
    putMeta(seeded.meta, 'session-' + sessionId, {
      id: sessionId,
      title: 'Synthetic result',
      userId: seeded.workspace.userId,
      machineId: seeded.workspace.machineId,
      project: { kind: 'local', localProjectId },
      status: { type: 'idle' },
    });
    seeded.transaction(() => {
      seeded.persist(sessionId, doc);
      seeded.attention.recordOutcome({
        sessionId,
        localProjectId,
        assistantTurnId: 'assistant-synthetic',
        userTurnId: 'user-synthetic',
        cause: 'agent_returned',
        summary: 'Synthetic result',
      });
    });
    seeded.close();
    const connected = once(sockets, 'connection');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('src/bridge/host-main.ts'),
        '--config',
        configFile,
        '--runtime-data',
        runtimeFile,
        '--project',
        directory,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    });
    const [socket] = (await Promise.race([
      connected,
      once(child, 'exit').then(() => {
        throw new Error('synthetic host exited: ' + output);
      }),
    ])) as [WebSocket];
    const hello = await nextMessage(socket, (message) => message.type === 'hello');
    assert.deepEqual(hello.attentionActor, actor);
    assert.equal(contextReads, 1);
    assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')).actor, actor);
    socket.send(JSON.stringify({ type: 'ready', actor, attentionFeatures: features }));
    const runtime = hello.workspaces[0];
    const context: AttentionContext = {
      actor,
      executionDeviceId,
      machineId: runtime.machineId,
      catalogWorkspaceId: 'synthetic-space',
      projectId: 'synthetic-project',
      replicaId: 'synthetic-replica',
      runtimeWorkspaceId: runtime.id,
      localProjectId: runtime.projects[0].id,
    };
    const request = async (
      scope: AttentionContext,
      method = 'attention-list',
      params: unknown = { view: 'pending', limit: 50 },
    ) => {
      const requestId = crypto.randomUUID();
      const received = nextMessage(
        socket,
        (message) => message.type === 'response' && message.requestId === requestId,
      );
      socket.send(
        JSON.stringify({
          type: 'request',
          requestId,
          method,
          workspaceId: runtime.id,
          localProjectId: context.localProjectId,
          context: scope,
          params,
        }),
      );
      return received;
    };
    const valid = await request(context);
    assert.equal(valid.error, undefined, output);
    assert.equal(valid.result.total, 1);
    for (const scope of [
      { ...context, actor: { ...actor, kind: 'local' as const } },
      { ...context, actor: { ...actor, accountId: 'another-account' } },
      { ...context, actor: { ...actor, authorityId: 'another-authority' } },
      { ...context, executionDeviceId: 'another-device' },
      { ...context, machineId: 'another-machine' },
      { ...context, runtimeWorkspaceId: 'another-runtime' },
      { ...context, localProjectId: 'another-local-project' },
    ])
      assert.equal((await request(scope)).error.status, 403);
    const item = valid.result.sessions[0].items[0];
    const scoped = { ...context, sessionId };
    const seen = {
      itemId: item.itemId,
      input: { operationId: 'seen-synthetic', eventRevision: item.eventRevision },
    };
    const accepted = await request(scoped, 'attention-seen', seen);
    assert.equal(accepted.result.accepted, true);
    assert.deepEqual((await request(scoped, 'attention-seen', seen)).result, accepted.result);
    const changedRetry = await request(scoped, 'attention-seen', {
      ...seen,
      input: { ...seen.input, eventRevision: item.eventRevision + 1 },
    });
    assert.equal(
      changedRetry.error.rejected,
      false,
      'an existing accepted receipt must retain uncertain delivery state',
    );
    const conflict = await request(scoped, 'attention-disposition', {
      itemId: item.itemId,
      input: {
        operationId: 'not-accepted',
        eventRevision: item.eventRevision + 1,
        observationRevision: 0,
        disposition: 'checked',
      },
    });
    assert.equal(conflict.error.status, 409);
    assert.equal(
      conflict.error.rejected,
      true,
      'a fully scoped, absent receipt proves the new operation was not accepted',
    );
    const foreignReceipt = await request(
      { ...scoped, actor: { ...actor, accountId: 'another-account' } },
      'attention-seen',
      seen,
    );
    assert.equal(
      foreignReceipt.error.rejected,
      false,
      'untrusted scope cannot inspect another actor receipt',
    );
    const closed = once(socket, 'close');
    socket.send(
      JSON.stringify({
        type: 'ready',
        actor: { ...actor, authorityId: 'replacement-authority' },
        attentionFeatures: features,
      }),
    );
    assert.equal((await closed)[0], 1008);
    assert.deepEqual(
      JSON.parse(readFileSync(configFile, 'utf8')).actor,
      actor,
      'handshake cannot silently rewrite pinned identity',
    );
  },
);
