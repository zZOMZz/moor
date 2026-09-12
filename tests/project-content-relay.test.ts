import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { PROTOCOL } from '../src/protocol';
import { PROJECT_TREE_FEATURE, PROJECT_DIFF_FEATURE } from '../src/project-content-protocol';
import { syntheticRelay } from './support/synthetic-relay';
import type { Workspace } from '../src/catalog';

const routes = ['project-tree', 'turn-diff', 'diff-file'] as const;
type Route = (typeof routes)[number];
const methods = {
  'project-tree': 'read-project-tree',
  'turn-diff': 'read-turn-diff',
  'diff-file': 'read-diff-file',
};
const digest = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
async function fixture() {
  const relay = await syntheticRelay();
  const controls = {
    transform: undefined as undefined | ((value: any, route: Route) => unknown),
    hold: undefined as undefined | (() => Promise<void>),
  };
  for (const host of relay.hosts) {
    host.runtime.features!.push(PROJECT_TREE_FEATURE, PROJECT_DIFF_FEATURE);
    for (const route of routes)
      host.responses.set(methods[route], async (m) => {
        const { contentVersion, workspaceId, localProjectId, sessionId } = m.params;
        const scope = { contentVersion, workspaceId, localProjectId, sessionId, confirmed: true };
        const text = 'Frozen synthetic bytes from ' + host.runtime.machineId;
        const file = {
          path: 'created.txt',
          size: Buffer.byteLength(text),
          state: 'text',
          version: digest(text),
          mediaType: 'text/plain',
        };
        const reference = {
          contentVersion: 1,
          basis: 'project-snapshot',
          turnId: 'assistant-turn',
          diffId: 'saved-diff',
          state: 'ready',
          version: digest('diff/' + text),
          changeCount: 1,
        };
        const treeVersion = digest('tree/' + text);
        const result =
          route === 'project-tree'
            ? {
                ...scope,
                version: treeVersion,
                source: 'git',
                entries: [{ path: file.path, type: 'file', size: file.size }],
                offset: 0,
                total: 1,
                partial: false,
                enumerationComplete: true,
                issues: [],
              }
            : route === 'turn-diff'
              ? {
                  ...scope,
                  turnId: reference.turnId,
                  state: reference.state,
                  reference,
                  changes: [{ path: file.path, kind: 'added', before: null, after: file }],
                  partial: false,
                  issues: [],
                  attribution: 'shared-project',
                }
              : {
                  ...scope,
                  turnId: reference.turnId,
                  path: file.path,
                  reference,
                  before: null,
                  after: { ...file, text },
                  partial: false,
                  issues: [],
                  attribution: 'shared-project',
                };
        const response = controls.transform?.(result, route) ?? result;
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
  const input = (route: Route) => ({
    contentVersion: 1,
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'same-session-id',
    ...(route === 'project-tree' ? {} : { turnId: 'assistant-turn' }),
    ...(route === 'diff-file' ? { path: 'created.txt' } : {}),
  });
  const path = (route: Route) => `/api/workspaces/${space.id}/replicas/${replica.id}/${route}`;
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

test('tree and frozen diff reads target the selected host and relay never persists their content', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const privateStrings: string[] = [];
  for (const host of f.space.hosts) {
    const replica = f.space.replicas.find(
      (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
    )!;
    const synthetic = f.hosts.find((h) => h.device.id === host.deviceId)!;
    for (const route of routes) {
      const response = await f.api(
        `/api/workspaces/${f.space.id}/replicas/${replica.id}/${route}`,
        f.input(route),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const data = await response.json();
      assert.equal(data.sessionId, 'same-session-id');
      assert.equal(data.confirmed, true);
      const request = synthetic.messages.at(-1);
      assert.equal(request.method, methods[route]);
      assert.equal(request.localProjectId, replica.localProjectId);
      assert.deepEqual(request.params, f.input(route));
      if (route === 'diff-file') {
        assert.match(data.after.text, new RegExp(synthetic.runtime.machineId));
        privateStrings.push(data.after.text, data.after.version, data.reference.version);
      }
    }
  }
  for (const table of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    assert.match(String(table.name), /^[a-z_]+$/u);
    const rows = JSON.stringify(f.store.db.prepare(`SELECT * FROM ${table.name}`).all());
    for (const value of privateStrings) assert.equal(rows.includes(value), false);
    assert.doesNotMatch(rows, /created\.txt|project-snapshot|Frozen synthetic/);
  }
});

test('project content routes reject account and project mismatches, injected fields and oversized read requests', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const route of routes) {
    for (const login of [undefined, f.store.createLogin('another-account')]) {
      const response = await fetch(f.origin + f.path(route), {
        method: 'POST',
        headers: {
          Origin: f.origin,
          'Content-Type': 'application/json',
          ...(login ? { Cookie: 'personal=' + login } : {}),
        },
        body: JSON.stringify(f.input(route)),
      });
      assert.equal(response.status, login ? 404 : 401);
    }
    for (const overrides of [
      { workspaceId: 'other-runtime' },
      { localProjectId: 'local-other' },
      { contentVersion: 2 },
      { command: 'injected' },
      { sessionId: '' },
    ])
      assert.equal((await f.api(f.path(route), { ...f.input(route), ...overrides })).status, 400);
    assert.equal((await f.api(f.path(route) + '/extra', f.input(route))).status, 404);
    assert.equal(
      (await f.api(f.path(route), { ...f.input(route), padding: 'x'.repeat(16 * 1024) })).status,
      413,
    );
  }
  assert.equal(
    (await f.api(f.path('diff-file'), { ...f.input('diff-file'), path: '../outside.txt' })).status,
    400,
  );
  assert.equal(
    f.synthetic.messages.some((m) => Object.values(methods).includes(m.method)),
    false,
  );
});

test('project content response scope, active protocol, turn, path and frozen version are revalidated', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const route of routes) {
    for (const override of [
      { workspaceId: 'wrong' },
      { localProjectId: 'wrong' },
      { sessionId: 'wrong' },
      { contentVersion: 2 },
      { confirmed: false },
      { extra: 'field' },
    ]) {
      f.controls.transform = (result) => ({ ...result, ...override });
      assert.equal(
        (await f.api(f.path(route), f.input(route))).status,
        502,
        JSON.stringify({ route, override }),
      );
    }
  }
  f.controls.transform = (result) => ({ ...result, turnId: 'wrong-turn' });
  for (const route of ['turn-diff', 'diff-file'] as const)
    assert.equal((await f.api(f.path(route), f.input(route))).status, 502);
  f.controls.transform = (result) => ({
    ...result,
    reference: { ...result.reference, turnId: 'wrong-turn' },
  });
  assert.equal((await f.api(f.path('diff-file'), f.input('diff-file'))).status, 502);
  f.controls.transform = (result) => ({ ...result, path: 'another.txt' });
  assert.equal((await f.api(f.path('diff-file'), f.input('diff-file'))).status, 502);
  f.controls.transform = undefined;
  for (const route of ['project-tree', 'diff-file'] as const) {
    assert.equal(
      (await f.api(f.path(route), { ...f.input(route), knownVersion: digest('wrong-version') }))
        .status,
      502,
    );
    const result = await (await f.api(f.path(route), f.input(route))).json();
    assert.equal(
      (
        await f.api(f.path(route), {
          ...f.input(route),
          knownVersion: result.version ?? result.reference.version,
        })
      ).status,
      200,
    );
  }
  f.controls.transform = (result) => ({ ...result, offset: 1 });
  assert.equal((await f.api(f.path('project-tree'), f.input('project-tree'))).status, 502);
});

test('legacy hosts cannot expose tree or diff endpoints without measured feature support', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const runtime = { ...f.synthetic.runtime, features: ['file-content-v1'] };
  const pong = once(f.synthetic.socket, 'pong');
  f.synthetic.socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: runtime.machineId,
      workspaces: [runtime],
    }),
  );
  f.synthetic.socket.ping();
  await pong;
  for (const route of routes)
    assert.equal((await f.api(f.path(route), f.input(route))).status, 409);
  assert.equal(
    f.synthetic.messages.some((m) => Object.values(methods).includes(m.method)),
    false,
  );
});

test('in-flight project content reads cannot disclose data after logout, reassignment or disconnect', async (t) => {
  for (const route of routes)
    for (const change of ['logout', 'move', 'unavailable'] as const)
      await t.test(route + '/' + change, async (t) => {
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
        const pending = f.api(f.path(route), f.input(route));
        await entered;
        try {
          let status: number;
          if (change === 'logout') {
            await f.api('/api/logout', {});
            status = 401;
            release();
          } else if (change === 'move') {
            const moved = await (
              await f.api('/api/workspaces', { name: 'Synthetic moved workspace' })
            ).json();
            await f.api(`/api/workspaces/${f.space.id}/hosts/${f.host.id}/move`, {
              workspaceId: moved.id,
            });
            status = 404;
            release();
          } else {
            f.synthetic.socket.send(JSON.stringify({ type: 'unavailable' }));
            status = 409;
          }
          const response = await pending;
          assert.equal(response.status, status);
          const result = await response.json();
          assert.equal(result.rejected, false);
          assert.equal('after' in result || 'changes' in result || 'entries' in result, false);
        } finally {
          release();
        }
      });
});
