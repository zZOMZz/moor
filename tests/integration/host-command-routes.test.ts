import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { PROTOCOL } from '@moor/protocol/protocol';
import {
  HOST_COMMAND_METHODS,
  hostCommandSchema,
  type HostCommandMethod,
} from '@moor/protocol/host-command';
import {
  hostCommandContracts,
  hostCommandFeatures,
  matchHostCommandRoute,
} from '@moor/protocol/host-command-contract';
import { workspaceCommandRoute } from '@moor/client/workspace-transport';
import type { DesktopWorkspaceTarget } from '@moor/client/workspace-protocol';
import type { Workspace } from '@moor/protocol/catalog';
import { cases } from '../fixtures/host-command-cases';
import { syntheticRelay } from '../fixtures/synthetic-relay';

const retired = new Set<HostCommandMethod>(['preview-read', 'preview-action', 'preview-close']);
async function fixture() {
  const relay = await syntheticRelay();
  const [space]: Workspace[] = await (await relay.api('/api/workspaces')).json();
  const host = space.hosts[0],
    peer = relay.hosts.find((value) => value.device.id === host.deviceId)!,
    replica = space.replicas.find(
      (value) => value.hostId === host.id && value.localProjectId === 'local-moor',
    )!;
  const target: DesktopWorkspaceTarget = {
    serverKey: 'synthetic',
    owner: relay.owner,
    deviceId: host.deviceId,
    userId: peer.runtime.userId,
    machineId: peer.runtime.machineId,
    workspaceId: peer.runtime.id,
    localProjectId: replica.localProjectId,
    catalogWorkspaceId: space.id,
    catalogProjectId: replica.projectId,
    replicaId: replica.id,
    sessionId: 'same-session-id',
  };
  const scope = {
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    userId: target.userId,
    machineId: target.machineId,
  };
  function bind(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(bind);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [
        key,
        Object.hasOwn(scope, key) ? scope[key as keyof typeof scope] : bind(value),
      ]),
    );
  }
  const commands = HOST_COMMAND_METHODS.map((method) =>
    hostCommandSchema.parse({
      method,
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      params: bind(cases[method].params),
    }),
  );
  peer.runtime.features = [...new Set(commands.flatMap(hostCommandFeatures))];
  const pong = once(peer.socket, 'pong');
  peer.socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: peer.runtime.machineId,
      workspaces: [peer.runtime],
    }),
  );
  peer.socket.ping();
  await pong;
  for (const method of HOST_COMMAND_METHODS)
    peer.responses.set(method, (request) => {
      // A real Host RPC was reached. No execution or external service is needed
      // to prove route coverage; successful response validation has its own suite.
      peer.socket.send(
        JSON.stringify({
          type: 'response',
          requestId: request.requestId,
          error: { status: 409, message: 'Synthetic Host reached', rejected: true },
        }),
      );
      return undefined;
    });
  return { ...relay, target, peer, commands };
}

test('every declared command has a fixed client route that reaches the real authenticated Relay or its explicit retirement boundary', async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.deepEqual(Object.keys(hostCommandContracts).sort(), [...HOST_COMMAND_METHODS].sort());
  const publicPaths = new Set<string>();
  for (const command of f.commands) {
    const contract = hostCommandContracts[command.method];
    const routed = workspaceCommandRoute(f.target, command);
    const before = f.peer.messages.filter((value) => value.type === 'request').length;
    const response = await f.api(routed.path, routed.body);
    const requests = f.peer.messages.filter((value) => value.type === 'request');
    const url = new URL(routed.path, f.origin),
      suffix = url.pathname.split('/').filter(Boolean).slice(5);
    assert.equal(matchHostCommandRoute(contract.http.method, suffix), command.method);
    assert(!publicPaths.has(contract.http.method + ' ' + url.pathname), command.method);
    publicPaths.add(contract.http.method + ' ' + url.pathname);
    if (retired.has(command.method)) {
      assert.equal(response.status, 410, command.method);
      assert.equal(requests.length, before, command.method);
    } else {
      assert.equal(
        requests.length,
        before + 1,
        command.method + ': public route omitted Host dispatch',
      );
      const received = requests.at(-1)!;
      assert.equal(received.method, command.method);
      assert.equal(received.workspaceId, f.target.workspaceId);
      assert.equal(received.localProjectId, f.target.localProjectId);
      assert.equal(received.authorityOwner, f.owner);
      assert.deepEqual(received.params, command.params);
      assert.equal(
        response.status,
        ['git-operations', 'fork-operations'].includes(command.method) ? 502 : 409,
        command.method,
      );
      if (contract.delivery === 'recovery')
        assert.equal((await response.json()).rejected, false, command.method);
    }
  }
  assert.equal(publicPaths.size, HOST_COMMAND_METHODS.length);
});

test('command routes preserve public spellings and reject arbitrary methods, extra segments and malformed scopes without forwarding', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const expected: Partial<Record<HostCommandMethod, string>> = {
    sessions: 'sessions',
    session: 'sessions/same-session-id?version=YQ%3D%3D',
    'sessions-page': 'sessions-page',
    'send-turn': 'send-turn',
    'respond-permission': 'respond-permission',
    mutate: 'mutations',
    'session-action': 'session-actions',
    'git-operations': 'git/operations',
    'fork-operations': 'fork/operations',
    'read-project-tree': 'project-tree',
    'read-turn-diff': 'turn-diff',
    'read-diff-file': 'diff-file',
    'answer-question': 'question-answers',
    'read-attachment': 'attachments/read',
  };
  const prefix = `/api/workspaces/${f.target.catalogWorkspaceId}/replicas/${f.target.replicaId}/`;
  for (const command of f.commands)
    if (expected[command.method])
      assert.equal(
        workspaceCommandRoute(f.target, command).path,
        prefix + expected[command.method],
      );
  const before = f.peer.messages.filter((value) => value.type === 'request').length;
  for (const suffix of [
    'command',
    'raw-shell',
    'git/operations/extra',
    'sessions-page/extra',
    'constructor',
    '__proto__',
  ])
    assert.equal((await f.api(prefix + suffix, { method: 'sessions' })).status, 404, suffix);
  assert.equal((await f.api(prefix + 'sessions', {})).status, 404);
  assert.equal((await f.api(prefix + 'sessions-page')).status, 404);
  for (const command of f.commands) {
    if (retired.has(command.method)) continue;
    const request = workspaceCommandRoute(f.target, command);
    if (!request.body || !('workspaceId' in request.body)) continue;
    assert.equal(
      (await f.api(request.path, { ...request.body, workspaceId: 'foreign-runtime' })).status,
      400,
      command.method,
    );
  }
  assert.equal(f.peer.messages.filter((value) => value.type === 'request').length, before);
});

for (const method of ['send-turn', 'respond-permission'] as const) {
  test(
    method +
      ' recovery forwards the original DTO and requires typed support before any Host request',
    async (t) => {
      const f = await fixture();
      t.after(f.close);
      const original = f.commands.find((command) => command.method === method)!;
      assert(original.method === method);
      const scope = {
        workspaceId: f.target.workspaceId,
        localProjectId: f.target.localProjectId,
        sessionId: f.target.sessionId!,
        userId: f.target.userId,
        machineId: f.target.machineId,
        controlVersion: 1,
      };
      const params = {
        ...scope,
        action: 'inspect',
        request: { kind: method, value: original.params },
      };
      const command = hostCommandSchema.parse({
        method: 'session-operations',
        workspaceId: f.target.workspaceId,
        localProjectId: f.target.localProjectId,
        params,
      });
      const receipt = {
        ...scope,
        operationId: original.params.operationId,
        confirmed: true,
        kind: method,
        status: 'accepted',
      };
      const result = {
        ...scope,
        action: 'inspect',
        operationId: original.params.operationId,
        confirmed: true,
        found: true,
        receipt,
      };
      f.peer.responses.set('session-operations', () => result);
      const routed = workspaceCommandRoute(f.target, command);
      assert.deepEqual(await (await f.api(routed.path, routed.body)).json(), result);
      assert.deepEqual(
        f.peer.messages.filter((value) => value.type === 'request').at(-1)!.params,
        params,
      );
      f.peer.responses.set('session-operations', () => ({
        ...result,
        receipt: { ...receipt, kind: 'mutation' },
      }));
      assert.equal((await f.api(routed.path, routed.body)).status, 502);
      const before = f.peer.messages.filter((value) => value.type === 'request').length;
      f.peer.runtime.features = f.peer.runtime.features!.filter(
        (value) => value !== 'session-intents-v1',
      );
      const pong = once(f.peer.socket, 'pong');
      f.peer.socket.send(
        JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL,
          machineId: f.peer.runtime.machineId,
          workspaces: [f.peer.runtime],
        }),
      );
      f.peer.socket.ping();
      await pong;
      const refused = await f.api(routed.path, routed.body);
      assert.equal(refused.status, 409);
      assert.equal((await refused.json()).rejected, false);
      assert.equal(f.peer.messages.filter((value) => value.type === 'request').length, before);
    },
  );
  test(
    method +
      ' validates exact success and abandonment, refuses old Hosts and never retries an uncertain receipt',
    async (t) => {
      const f = await fixture();
      t.after(f.close);
      const command = f.commands.find((command) => command.method === method)!;
      assert(command.method === method);
      const routed = workspaceCommandRoute(f.target, command);
      const calls = () => f.peer.messages.filter((value) => value.type === 'request');
      const accepted = { operationId: command.params.operationId, accepted: true, delivered: true };
      f.peer.responses.set(method, () => accepted);
      assert.deepEqual(await (await f.api(routed.path, routed.body)).json(), accepted);
      assert.deepEqual(calls().at(-1)!.params, command.params);
      const abandoned = {
        operationId: command.params.operationId,
        accepted: false,
        delivered: false,
        abandoned: true,
      };
      f.peer.responses.set(method, () => abandoned);
      assert.deepEqual(await (await f.api(routed.path, routed.body)).json(), abandoned);
      f.peer.responses.set(method, () => ({ ...accepted, operationId: 'different-operation' }));
      const before = calls().length;
      const unknown = await f.api(routed.path, routed.body);
      assert.equal(unknown.status, 502);
      assert.equal((await unknown.json()).rejected, false);
      assert.equal(calls().length, before + 1);
      assert(calls().every((call) => call.method === method));
      for (const field of ['workspaceId', 'localProjectId', 'userId', 'machineId'])
        assert.equal(
          (await f.api(routed.path, { ...routed.body, [field]: 'foreign' })).status,
          400,
          field,
        );
      for (const extra of [{ update: '' }, { metaBundle: {} }, { timestamp: 'injected' }])
        assert.equal((await f.api(routed.path, { ...routed.body, ...extra })).status, 400);
      assert.equal(
        (await f.api(routed.path, { ...routed.body, extra: 'x'.repeat(1024 * 1024) })).status,
        413,
      );
      assert.equal(calls().length, before + 1);
      f.peer.runtime.features = f.peer.runtime.features!.filter(
        (value) => value !== 'session-intents-v1',
      );
      const pong = once(f.peer.socket, 'pong');
      f.peer.socket.send(
        JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL,
          machineId: f.peer.runtime.machineId,
          workspaces: [f.peer.runtime],
        }),
      );
      f.peer.socket.ping();
      await pong;
      assert.equal((await f.api(routed.path, routed.body)).status, 409);
      assert.equal(
        calls().length,
        before + 1,
        'unsupported Host cannot select the legacy mutation route',
      );
    },
  );

  test(
    method + ' keeps a dispatched request uncertain when authorization changes before its reply',
    async (t) => {
      const f = await fixture();
      t.after(f.close);
      let entered!: () => void, release!: () => void;
      const observed = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.after(() => release());
      const command = f.commands.find((command) => command.method === method)!;
      assert(command.method === method);
      f.peer.responses.set(method, async () => {
        entered();
        await held;
        return { operationId: command.params.operationId, accepted: true, delivered: true };
      });
      const routed = workspaceCommandRoute(f.target, command);
      const pending = f.api(routed.path, routed.body);
      await observed;
      await f.api('/api/logout', {});
      release();
      const result = await pending;
      assert.equal(result.status, 401);
      const body = await result.json();
      assert.equal(body.rejected, false);
      assert.equal(body.accepted, undefined);
      assert.equal(f.peer.messages.filter((value) => value.type === 'request').length, 1);
    },
  );
}
