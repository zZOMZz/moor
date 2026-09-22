import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PROTOCOL } from '@moor/protocol/protocol';
import {
  GIT_OPERATIONS_FEATURE,
  gitRequestVersion,
  type GitAction,
} from '@moor/protocol/git-protocol';
import {
  FORK_OPERATIONS_FEATURE,
  forkRequestVersion,
  type SessionFork,
} from '@moor/protocol/fork-protocol';
import { DesktopWorkspaceClient } from '@moor/client/node/workspace-client';
import { BrowserWorkspaceClient } from '@moor/client/browser-workspace-client';
import { desktopWorkspaceCatalogSchema } from '@moor/client/workspace-protocol';
import { syntheticRelay } from '../fixtures/synthetic-relay';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(browser = false) {
  const relay = await syntheticRelay();
  const controls: { transform?: (result: any) => unknown; hold?: () => Promise<void> } = {};
  const peer = relay.hosts[0]!;
  peer.runtime.features!.push(GIT_OPERATIONS_FEATURE, FORK_OPERATIONS_FEATURE);
  for (const kind of ['git', 'fork'] as const)
    peer.responses.set(kind + '-operations', async (message) => {
      const { action, request } = message.params;
      const scope = {
        workspaceId: request.workspaceId,
        localProjectId: request.localProjectId,
        sessionId: request.sessionId,
        operationId: request.operationId,
      };
      const result = {
        ...scope,
        [kind + 'Version']: 1,
        action,
        confirmed: true,
        requestVersion:
          kind === 'git' ? await gitRequestVersion(request) : await forkRequestVersion(request),
        found: action === 'abandon',
        ...(action === 'abandon'
          ? {
              receipt: {
                ...scope,
                [kind + 'Version']: 1,
                phase: 'abandoned',
                confirmed: false,
                ...(kind === 'git'
                  ? { execution: { mode: 'shared', status: 'ready', revision: 0 } }
                  : { childSessionId: request.childSessionId }),
              },
            }
          : {}),
      };
      await controls.hold?.();
      return controls.transform ? controls.transform(result) : result;
    });
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
  const calls: string[] = [];
  const Client = browser ? BrowserWorkspaceClient : DesktopWorkspaceClient;
  const client = new Client({
    source: 'remote',
    origin: relay.origin,
    cookie: 'personal=' + relay.secret,
    current() {},
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      const headers = new Headers(init?.headers);
      // Node fetch has no ambient cookie jar. Inject the fixture's cookie only at
      // this test boundary; the browser adapter itself must never supply it.
      if (browser) {
        assert.equal(headers.get('Cookie'), null);
        assert.equal(init?.credentials, 'same-origin');
        headers.set('Cookie', 'personal=' + relay.secret);
        headers.set('Origin', relay.origin);
      }
      return fetch(input, { ...init, headers });
    },
  });
  const opened: any = await client.request({ action: 'catalog', source: 'remote' });
  assert.equal(opened.ok, true);
  const catalog = desktopWorkspaceCatalogSchema.parse(opened.value);
  const row = catalog.targets.find(
    (row) => row.target.deviceId === peer.device.id && row.target.localProjectId === 'local-moor',
  )!;
  const scope = {
    workspaceId: row.target.workspaceId,
    localProjectId: row.target.localProjectId,
    sessionId: 'same-session-id',
  };
  const git: GitAction = {
    ...scope,
    gitVersion: 1,
    operationId: 'original-git',
    expectedRevision: 0,
    action: 'prepare',
    baseBranch: 'main',
    expectedOid: 'a'.repeat(40),
    newBranch: 'codex/synthetic',
  };
  const fork: SessionFork = {
    ...scope,
    forkVersion: 1,
    operationId: 'original-fork',
    childSessionId: 'synthetic-child',
    expectedSourceVersion: 'sha256:' + 'b'.repeat(64),
    expectedExecutionRevision: 0,
    cutoff: { kind: 'current' },
    directory: { kind: 'same-directory' },
  };
  const call = (kind: 'git' | 'fork', action = 'inspect') =>
    client.request({
      action: 'execute',
      source: 'remote',
      connectionId: catalog.connectionId,
      target: { ...row.target, sessionId: scope.sessionId },
      command: {
        method: kind + '-operations',
        workspaceId: scope.workspaceId,
        localProjectId: scope.localProjectId,
        params: { action, request: kind === 'git' ? git : fork },
      },
    }) as Promise<any>;
  return {
    ...relay,
    peer,
    controls,
    calls,
    git,
    fork,
    call,
    path: `/api/workspaces/${row.target.catalogWorkspaceId}/replicas/${row.target.replicaId}`,
    close: async () => {
      client.close();
      await relay.close();
    },
  };
}

for (const browser of [false, true])
  test(`${browser ? 'Browser' : 'Node'} ordinary transport reaches exact Git/Fork recovery routes without replay`, async (t) => {
    const f = await fixture(browser);
    t.after(f.close);
    for (const kind of ['git', 'fork'] as const)
      for (const action of ['inspect', 'abandon']) {
        const before = f.calls.length;
        const result = await f.call(kind, action);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.value.operationId, f[kind].operationId);
        assert.equal(result.value.found, action === 'abandon');
        assert.equal(
          result.value.requestVersion,
          kind === 'git' ? await gitRequestVersion(f.git) : await forkRequestVersion(f.fork),
        );
        assert.deepEqual(f.calls.slice(before), [
          f.path + '/context',
          f.path + '/' + kind + '/operations',
          f.path + '/context',
        ]);
        const sent = f.peer.messages.filter((m) => m.method === kind + '-operations').at(-1);
        assert.deepEqual(sent.params, { action, request: f[kind] });
      }
    assert.equal(
      f.hosts.some((host) =>
        host.messages.some((m) => ['mutate', 'git-action', 'fork-action'].includes(m.method)),
      ),
      false,
    );
  });

test('real recovery route rejects foreign scope, original request fingerprints and unadvertised capability', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const kind of ['git', 'fork'] as const) {
    const before = f.peer.messages.filter((m) => m.method === kind + '-operations').length;
    const invalid = await f.api(f.path + '/' + kind + '/operations', {
      action: 'inspect',
      request: { ...f[kind], localProjectId: 'local-other' },
    });
    assert.equal(invalid.status, 400);
    assert.equal(f.peer.messages.filter((m) => m.method === kind + '-operations').length, before);
    for (const transform of [
      (value: any) => ({ ...value, operationId: 'other' }),
      (value: any) => ({ ...value, requestVersion: 'sha256:' + '0'.repeat(64) }),
    ]) {
      f.controls.transform = transform;
      const response = await f.api(f.path + '/' + kind + '/operations', {
        action: 'inspect',
        request: f[kind],
      });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).rejected, false);
    }
  }
  f.peer.runtime.features = f.peer.runtime.features!.filter(
    (value) => value !== GIT_OPERATIONS_FEATURE,
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
  assert.equal(
    (await f.api(f.path + '/git/operations', { action: 'inspect', request: f.git })).status,
    409,
  );
});

test('revocation during recovery suppresses late results and keeps the original outcome uncertain', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const entered = gate(),
    release = gate();
  f.controls.hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.api(f.path + '/fork/operations', { action: 'inspect', request: f.fork });
  await entered.promise;
  await f.api('/api/devices/' + f.peer.device.id + '/revoke', {});
  release.resolve();
  const response = await pending;
  assert.notEqual(response.status, 200);
  assert.equal((await response.json()).rejected, false);
  assert.equal(f.peer.messages.filter((m) => m.method === 'fork-operations').length, 1);
});
