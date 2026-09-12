import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { PROTOCOL } from '../src/protocol';
import { GIT_WORKTREE_FEATURE, type GitAction } from '../src/git-protocol';
import { syntheticRelay } from './support/synthetic-relay';
import type { Workspace } from '../src/catalog';

const oid = 'a'.repeat(40);
const version = 'sha256:' + createHash('sha256').update('synthetic-git-state').digest('hex');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const relay = await syntheticRelay();
  const controls = {
    transform: undefined as undefined | ((value: any) => unknown),
    hold: undefined as undefined | (() => Promise<void>),
  };
  for (const synthetic of relay.hosts) {
    synthetic.runtime.features!.push(GIT_WORKTREE_FEATURE);
    synthetic.responses.set('git-state', async (m) => {
      const result = {
        ...m.params,
        confirmed: true,
        repository: {
          kind: 'git',
          branch: 'main',
          headOid: oid,
          branches: [{ name: 'main', oid }],
          changes: [{ path: 'synthetic-git-private-path.txt', index: ' ', worktree: 'M' }],
          dirty: true,
          partial: false,
          outsideProjectChanges: false,
          version,
          issues: [],
          writeSupported: true,
        },
        execution: { mode: 'shared', status: 'ready', revision: 0 },
        canPrepare: true,
        canRemove: false,
      };
      await controls.hold?.();
      return controls.transform?.(result) ?? result;
    });
    synthetic.responses.set('git-action', async (m) => {
      const input = m.params as GitAction;
      const result = {
        gitVersion: 1,
        workspaceId: input.workspaceId,
        localProjectId: input.localProjectId,
        sessionId: input.sessionId,
        operationId: input.operationId,
        phase: 'accepted',
        confirmed: true,
        execution: {
          mode: 'worktree',
          status: input.action === 'prepare' ? 'ready' : 'removed',
          revision: input.expectedRevision + 1,
          executionId: input.action === 'remove' ? input.executionId : 'execution-synthetic',
          branch: input.action === 'prepare' ? input.newBranch : 'synthetic-branch',
          baseOid: oid,
        },
      };
      await controls.hold?.();
      return controls.transform?.(result) ?? result;
    });
    const pong = once(synthetic.socket, 'pong');
    synthetic.socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        machineId: synthetic.runtime.machineId,
        workspaces: [synthetic.runtime],
      }),
    );
    synthetic.socket.ping();
    await pong;
  }
  const [space]: Workspace[] = await (await relay.api('/api/workspaces')).json();
  const host = space.hosts[0]!;
  const replica = space.replicas.find(
    (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
  )!;
  const scope = {
    gitVersion: 1 as const,
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'synthetic-new-session',
  };
  const prepare: GitAction = {
    ...scope,
    action: 'prepare',
    operationId: 'synthetic-prepare',
    expectedRevision: 0,
    baseBranch: 'main',
    expectedOid: oid,
    newBranch: 'synthetic-branch',
  };
  const remove: GitAction = {
    ...scope,
    action: 'remove',
    operationId: 'synthetic-remove',
    expectedRevision: 1,
    executionId: 'execution-synthetic',
    expectedStateVersion: version,
  };
  const path = (kind: 'state' | 'action') =>
    `/api/workspaces/${space.id}/replicas/${replica.id}/git/${kind}`;
  return {
    ...relay,
    controls,
    space,
    host,
    replica,
    scope,
    prepare,
    remove,
    path,
    synthetic: relay.hosts.find((h) => h.device.id === host.deviceId)!,
  };
}

test('Git reads and manual actions bind a replica and relay stores no Git status or worktree receipts', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const host of f.space.hosts) {
    const replica = f.space.replicas.find(
      (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
    )!;
    const synthetic = f.hosts.find((h) => h.device.id === host.deviceId)!;
    for (const [kind, input] of [
      ['state', f.scope],
      ['action', f.prepare],
      ['action', f.remove],
    ] as const) {
      const response = await f.api(
        `/api/workspaces/${f.space.id}/replicas/${replica.id}/git/${kind}`,
        input,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const result = await response.json();
      assert.equal(result.confirmed, true);
      assert.equal(result.sessionId, input.sessionId);
      const message = synthetic.messages.at(-1);
      assert.equal(message.method, 'git-' + kind);
      assert.equal(message.localProjectId, replica.localProjectId);
      assert.deepEqual(message.params, input);
    }
  }
  for (const row of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    assert.match(String(row.name), /^[a-z_]+$/);
    assert.doesNotMatch(
      JSON.stringify(f.store.db.prepare(`SELECT * FROM ${row.name}`).all()),
      /synthetic-git-private-path|synthetic-branch|execution-synthetic|synthetic-prepare/,
    );
  }
});

test('Git preflight rejects wrong identity, untyped arguments and unsupported hosts before dispatch', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const secret of [undefined, f.store.createLogin('foreign-synthetic-account')]) {
    const response = await fetch(f.origin + f.path('action'), {
      method: 'POST',
      headers: {
        Origin: f.origin,
        'Content-Type': 'application/json',
        ...(secret ? { Cookie: 'personal=' + secret } : {}),
      },
      body: JSON.stringify(f.prepare),
    });
    assert.equal(response.status, secret ? 404 : 401);
    assert.equal((await response.json()).rejected, true);
  }
  for (const path of [
    f.path('action').replace(f.space.id, 'missing-workspace'),
    f.path('action').replace(/\/replicas\/[^/]+\//, '/replicas/missing-replica/'),
  ]) {
    const response = await f.api(path, f.prepare);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).rejected, true);
  }
  for (const changed of [
    { workspaceId: 'foreign-runtime' },
    { localProjectId: 'local-other' },
    { command: 'git checkout main' },
    { targetPath: '/arbitrary' },
    { gitVersion: 2 },
    { newBranch: 'line\nbreak' },
  ]) {
    const response = await f.api(f.path('action'), { ...f.prepare, ...changed });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).rejected, true);
  }
  assert.equal((await f.api(f.path('action') + '/extra', f.prepare)).status, 404);
  assert.equal(
    (await f.api(f.path('action'), { ...f.prepare, padding: 'x'.repeat(16384) })).status,
    413,
  );
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
  const response = await f.api(f.path('action'), f.prepare);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).rejected, true);
  f.synthetic.runtime.projects = [];
  const removed = once(f.synthetic.socket, 'pong');
  f.synthetic.socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: f.synthetic.runtime.machineId,
      workspaces: [f.synthetic.runtime],
    }),
  );
  f.synthetic.socket.ping();
  await removed;
  const unavailable = await f.api(f.path('action'), f.prepare);
  assert.equal(unavailable.status, 409);
  assert.equal((await unavailable.json()).rejected, true);
  assert.equal(
    f.synthetic.messages.some((m) => m.method?.startsWith('git-')),
    false,
  );
});

test('a login revoked while the Git request body is pending cannot start an operation', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const text = JSON.stringify(f.prepare),
    entered = deferred();
  f.app.server.once('request', () => entered.resolve());
  const result = new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = httpRequest(
      f.origin + f.path('action'),
      {
        method: 'POST',
        headers: {
          Origin: f.origin,
          Cookie: 'personal=' + f.secret,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    request.on('error', reject);
    request.write(text.slice(0, 1));
    void entered.promise
      .then(async () => {
        await f.api('/api/logout', {});
        request.end(text.slice(1));
      })
      .catch(reject);
  });
  const response = await result;
  assert.equal(response.status, 401);
  assert.equal(response.body.rejected, true);
  assert.equal(
    f.synthetic.messages.some((m) => m.method === 'git-action'),
    false,
  );
});

test('Git receipts revalidate the original scope, operation, version and requested branch', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const changes = [
    (r: any) => ({ ...r, workspaceId: 'other' }),
    (r: any) => ({ ...r, localProjectId: 'local-other' }),
    (r: any) => ({ ...r, sessionId: 'other' }),
    (r: any) => ({ ...r, operationId: 'other' }),
    (r: any) => ({ ...r, confirmed: false }),
    (r: any) => ({ ...r, execution: { ...r.execution, revision: 9 } }),
    (r: any) => ({ ...r, execution: { ...r.execution, branch: 'other' } }),
    (r: any) => ({ ...r, execution: { ...r.execution, baseOid: 'b'.repeat(40) } }),
    (r: any) => ({ ...r, execution: { ...r.execution, status: 'removed' } }),
    (r: any) => ({ ...r, execution: { ...r.execution, cwd: '/private/host/path' } }),
  ];
  for (const change of changes) {
    f.controls.transform = change;
    const response = await f.api(f.path('action'), f.prepare);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).rejected, false);
  }
  f.controls.transform = (r) => ({
    ...r,
    phase: 'unknown',
    confirmed: false,
    message: '合成结果待确认',
  });
  const response = await f.api(f.path('action'), f.prepare);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).phase, 'unknown');
  f.controls.transform = (r) => ({
    ...r,
    repository: { ...r.repository, changes: [{ path: '../private', index: ' ', worktree: 'M' }] },
  });
  assert.equal((await f.api(f.path('state'), f.scope)).status, 502);
});

test('a Git action that was dispatched is not called rejected after logout, regrouping or runtime replacement', async (t) => {
  for (const change of ['logout', 'move', 'runtime'] as const)
    await t.test(change, async (t) => {
      const f = await fixture();
      t.after(f.close);
      const entered = deferred(),
        release = deferred();
      f.controls.hold = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = f.api(f.path('action'), f.prepare);
      await entered.promise;
      try {
        if (change === 'logout') await f.api('/api/logout', {});
        else if (change === 'move') {
          const space = await (
            await f.api('/api/workspaces', { name: 'Synthetic moved Git workspace' })
          ).json();
          await f.api(`/api/workspaces/${f.space.id}/hosts/${f.host.id}/move`, {
            workspaceId: space.id,
          });
        } else {
          f.synthetic.runtime.userId = 'replacement-runtime-user';
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
        }
        release.resolve();
        const response = await pending;
        assert.equal(response.status, change === 'logout' ? 401 : change === 'move' ? 404 : 409);
        const body = await response.json();
        assert.equal(body.rejected, false);
        assert.equal(body.execution, undefined);
        assert.equal(f.synthetic.messages.filter((m) => m.method === 'git-action').length, 1);
      } finally {
        release.resolve();
      }
    });
});
