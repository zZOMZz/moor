import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { PROTOCOL } from '../src/protocol';
import { ROLE_FEATURE, ROLE_LIMITS, type RoleAction, type RolesRead } from '../src/role-protocol';
import type { Workspace } from '../src/catalog';
import { syntheticRelay } from './support/synthetic-relay';

const instructions = 'SYNTHETIC_PRIVATE_ROLE_BODY 中文 `do not execute`';
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function fixture() {
  const relay = await syntheticRelay();
  const controls: {
    transform?: (value: any) => unknown;
    hold?: () => Promise<void>;
    failure?: { status: number; message: string; rejected?: boolean };
    found?: boolean;
    sealed?: boolean;
  } = {};
  for (const host of relay.hosts) {
    host.runtime.features!.push(ROLE_FEATURE);
    for (const method of ['roles-read', 'roles-action'])
      host.responses.set(method, async (message) => {
        const input =
          message.params.action === 'inspect' || message.params.action === 'abandon'
            ? message.params.request
            : message.params;
        const base = {
          rolesVersion: 1,
          workspaceId: input.workspaceId,
          localProjectId: input.localProjectId,
          sessionId: input.sessionId,
          confirmed: true,
        };
        const receipt =
          controls.sealed || (message.params.action === 'abandon' && controls.found === false)
            ? {
                ...base,
                accepted: false,
                abandoned: true,
                action: input.action,
                operationId: input.operationId,
                catalogRevision: input.expectedRevision,
              }
            : {
                ...base,
                accepted: true,
                action: input.action,
                operationId: input.operationId,
                catalogRevision: input.expectedRevision + 1,
                roleId: input.id ?? 'role-synthetic',
              };
        const result =
          method === 'roles-read'
            ? {
                ...base,
                catalogRevision: 1,
                roles: [
                  {
                    id: 'role-synthetic',
                    name: '合成角色',
                    revision: 1,
                    agentId: 'agent',
                    selection: {},
                    instructions,
                    available: true,
                  },
                ],
              }
            : message.params.action === 'inspect'
              ? {
                  ...base,
                  action: 'inspect',
                  operationId: input.operationId,
                  found: controls.found !== false,
                  ...(controls.found !== false ? { receipt } : {}),
                }
              : receipt;
        await controls.hold?.();
        if (controls.failure)
          host.socket.send(
            JSON.stringify({
              type: 'response',
              requestId: message.requestId,
              error: controls.failure,
            }),
          );
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
  const replica = space.replicas[0]!,
    host = space.hosts.find((host) => host.id === replica.hostId)!;
  const synthetic = relay.hosts.find((item) => item.device.id === host.deviceId)!;
  const scope: RolesRead = {
    rolesVersion: 1,
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'new-role-draft',
  };
  const action: RoleAction = {
    ...scope,
    action: 'save',
    operationId: 'original-role-operation',
    expectedRevision: 1,
    name: '合成角色',
    agentId: 'agent',
    selection: {},
    instructions,
  };
  return {
    ...relay,
    controls,
    space,
    replica,
    synthetic,
    scope,
    action,
    path: `/api/workspaces/${space.id}/replicas/${replica.id}/roles`,
  };
}

test('roles relay forwards read, save, remove and original inspect envelopes only to the exact project host', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const remove = {
    ...f.scope,
    action: 'remove',
    operationId: 'remove-operation',
    expectedRevision: 2,
    id: 'role-synthetic',
  };
  for (const [kind, input] of [
    ['read', f.scope],
    ['action', f.action],
    ['action', remove],
    ['action', { action: 'inspect', request: f.action }],
  ] as const) {
    const response = await f.api(f.path + '/' + kind, input);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const request = f.synthetic.messages
      .filter((message) => message.method === 'roles-' + kind)
      .at(-1)!;
    assert.equal(request.workspaceId, f.scope.workspaceId);
    assert.equal(request.localProjectId, f.scope.localProjectId);
    assert.deepEqual(request.params, input);
  }
  assert.equal(
    f.hosts
      .find((host) => host !== f.synthetic)!
      .messages.filter((message) => message.method?.startsWith('roles-')).length,
    0,
  );
  for (const row of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const table = String(row.name);
    assert.match(table, /^[a-z_]+$/);
    assert.doesNotMatch(
      JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table}`).all()),
      /SYNTHETIC_PRIVATE_ROLE_BODY/,
    );
  }
});

test('role request schemas reject arbitrary launch fields, foreign scopes, extra route parts and oversized bodies', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const input of [
    { ...f.action, workspaceId: 'other' },
    { ...f.action, localProjectId: 'other' },
    { ...f.action, command: '/private/program' },
    { ...f.action, selection: { tool: 'shell' } },
    { ...f.action, instructions: '界'.repeat(6000) },
    { action: 'inspect', request: f.action, operationId: 'replacement' },
  ])
    assert.equal((await f.api(f.path + '/action', input)).status, 400);
  assert.equal(
    (await f.api(f.path + '/action', { ...f.action, extra: 'x'.repeat(ROLE_LIMITS.requestBytes) }))
      .status,
    413,
  );
  assert.equal(
    (await f.api(f.path + '/read', { ...f.scope, extra: 'x'.repeat(4096) })).status,
    413,
  );
  for (const path of ['/action/extra', '/execute', '/read/extra'])
    assert.equal((await f.api(f.path + path, f.action)).status, 404);
  assert.equal(
    f.synthetic.messages.filter((message) => message.method?.startsWith('roles-')).length,
    0,
  );
});

test('roles relay checks read uniqueness, revision, safe fields and exact mutation receipt identity', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const transform of [
    (value: any) => ({ ...value, sessionId: 'wrong' }),
    (value: any) => ({ ...value, roles: [...value.roles, ...value.roles] }),
    (value: any) => ({ ...value, catalogRevision: 0 }),
    (value: any) => ({
      ...value,
      roles: [{ ...value.roles[0], customAcp: { command: '/private/path' } }],
    }),
    (value: any) => ({ ...value, roles: [{ ...value.roles[0], available: false }] }),
  ]) {
    f.controls.transform = transform;
    const response = await f.api(f.path + '/read', f.scope);
    assert.equal(response.status, 502);
    assert.doesNotMatch(
      JSON.stringify(await response.json()),
      /SYNTHETIC_PRIVATE_ROLE_BODY|private\/path/,
    );
  }
  for (const transform of [
    (value: any) => ({ ...value, operationId: 'wrong' }),
    (value: any) => ({ ...value, catalogRevision: 1 }),
    (value: any) => ({ ...value, action: 'remove' }),
    (value: any) => ({ ...value, localProjectId: 'other' }),
    (value: any) => ({ ...value, instructions }),
    (value: any) => ({ ...value, roleId: 'other' }),
  ]) {
    f.controls.transform = transform;
    const response = await f.api(f.path + '/action', { ...f.action, id: 'role-synthetic' });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).rejected, false);
  }
});

test('role inspect not-found remains a read-only observation and malformed found receipts are rejected', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.controls.found = false;
  const input = { action: 'inspect', request: f.action };
  const response = await f.api(f.path + '/action', input);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).found, false);
  assert.equal(
    f.synthetic.messages.filter((message) => message.method === 'roles-action').length,
    1,
  );
  f.controls.found = true;
  f.controls.transform = (value) => ({
    ...value,
    receipt: { ...value.receipt, operationId: 'wrong' },
  });
  const invalid = await f.api(f.path + '/action', input);
  assert.equal(invalid.status, 502);
  assert.equal((await invalid.json()).rejected, false);
});

test('role failures conceal host diagnostics, never auto retry, and inspect errors cannot reject an original operation', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.controls.failure = {
    status: 409,
    message: 'SYNTHETIC_PRIVATE_ROLE_BODY /private/agent token=credential',
    rejected: true,
  };
  for (const input of [f.action, { action: 'inspect', request: f.action }]) {
    const response = await f.api(f.path + '/action', input);
    assert.equal(response.status, 409);
    const result = await response.json();
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|credential|private\/agent/);
    assert.equal(result.rejected, input.action !== 'inspect');
  }
  assert.equal(
    f.synthetic.messages.filter((message) => message.method === 'roles-action').length,
    2,
  );
  f.controls.failure = undefined;
  assert.equal((await f.api(f.path + '/action', f.action)).status, 200);
  assert.deepEqual(
    f.synthetic.messages.filter((message) => message.method === 'roles-action').at(-1)?.params,
    f.action,
  );
});

test('late role responses and failures are withheld after login, runtime or catalog scope changes', async (t) => {
  for (const change of [
    'logout',
    'user',
    'machine',
    'feature',
    'project',
    'removed-project',
  ] as const)
    await t.test(change, async (t) => {
      const f = await fixture();
      t.after(f.close);
      const entered = signal(),
        release = signal();
      t.after(release.resolve);
      f.controls.hold = async () => {
        entered.resolve();
        await release.promise;
      };
      if (change === 'user')
        f.controls.failure = { status: 409, message: instructions, rejected: true };
      const pending = f.api(f.path + '/action', f.action);
      await entered.promise;
      if (change === 'logout') f.store.db.prepare('DELETE FROM login').run();
      else if (change === 'project') {
        const other = f.space.projects.find((project) => project.id !== f.replica.projectId)!;
        f.store.catalog.assign(f.owner, f.space.id, f.replica.id, other.id);
      } else {
        if (change === 'user') f.synthetic.runtime.userId = 'changed-user';
        if (change === 'machine') f.synthetic.runtime.machineId = 'changed-machine';
        if (change === 'feature') f.synthetic.runtime.features = [];
        if (change === 'removed-project') f.synthetic.runtime.projects = [];
        const received = Promise.race([
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
        await received;
      }
      release.resolve();
      const response = await pending;
      assert.ok(response.status >= 400);
      const result = await response.json();
      assert.equal(result.rejected, false);
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_ROLE_BODY/);
    });
});

test('replaced host sockets settle pending role actions as unknown before any late receipt', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const entered = signal(),
    release = signal();
  t.after(release.resolve);
  f.controls.hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.api(f.path + '/action', f.action);
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
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).rejected, false);
  release.resolve();
});

test('role feature support is checked before dispatch', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.synthetic.runtime.features = [];
  const pong = once(f.synthetic.socket, 'pong');
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
  assert.equal((await f.api(f.path + '/read', f.scope)).status, 409);
  assert.equal((await f.api(f.path + '/action', f.action)).status, 409);
  assert.equal(
    f.synthetic.messages.filter((message) => message.method?.startsWith('roles-')).length,
    0,
  );
});

test('manual role abandonment forwards the original request and accepts only exact accepted or sealed receipts', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const input = { action: 'abandon', request: f.action };
  assert.equal((await f.api(f.path + '/action', input)).status, 200);
  f.controls.found = false;
  const response = await f.api(f.path + '/action', input);
  assert.equal(response.status, 200);
  const sealed = await response.json();
  assert.equal(sealed.accepted, false);
  assert.equal(sealed.abandoned, true);
  assert.equal(sealed.catalogRevision, f.action.expectedRevision);
  assert.equal('roleId' in sealed, false);
  assert.deepEqual(
    f.synthetic.messages.filter((message) => message.method === 'roles-action').at(-1)?.params,
    input,
  );
  f.controls.sealed = true;
  f.controls.found = true;
  assert.deepEqual(await (await f.api(f.path + '/action', f.action)).json(), sealed);
  const inspected = await (
    await f.api(f.path + '/action', { action: 'inspect', request: f.action })
  ).json();
  assert.deepEqual(inspected.receipt, sealed);
  for (const transform of [
    (value: any) => ({ ...value, catalogRevision: value.catalogRevision + 1 }),
    (value: any) => ({ ...value, accepted: true }),
    (value: any) => ({ ...value, operationId: 'other' }),
    (value: any) => ({ ...value, instructions }),
    (value: any) => ({ ...value, roleId: 'invented' }),
  ]) {
    f.controls.transform = transform;
    const invalid = await f.api(f.path + '/action', input);
    assert.equal(invalid.status, 502);
    assert.equal((await invalid.json()).rejected, false);
  }
});

test('abandon transport errors never imply that the original role operation did not run', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.controls.failure = { status: 409, message: instructions, rejected: true };
  const response = await f.api(f.path + '/action', { action: 'abandon', request: f.action });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).rejected, false);
  assert.equal(
    f.synthetic.messages.filter((message) => message.method === 'roles-action').length,
    1,
  );
});
