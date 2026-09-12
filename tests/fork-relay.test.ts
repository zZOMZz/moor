import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { PROTOCOL } from '../src/protocol';
import { SESSION_FORK_FEATURE, type SessionFork } from '../src/fork-protocol';
import type { Workspace } from '../src/catalog';
import { syntheticRelay } from './support/synthetic-relay';

const version = 'sha256:' + 'a'.repeat(64),
  oid = 'b'.repeat(40);
function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}
async function fixture() {
  const relay = await syntheticRelay();
  const controls = {
    transform: undefined as undefined | ((value: any) => unknown),
    hold: undefined as undefined | (() => Promise<void>),
    error: undefined as undefined | { status: number; message: string; rejected: boolean },
  };
  for (const synthetic of relay.hosts) {
    synthetic.runtime.features!.push(SESSION_FORK_FEATURE);
    synthetic.responses.set('fork-options', async (m) => {
      const { turnId, ...scope } = m.params;
      const result = {
        ...scope,
        confirmed: true,
        sourceVersion: version,
        execution: { mode: 'shared', status: 'ready', revision: 0 },
        agent: { id: 'synthetic', name: 'Synthetic', agentType: 'synthetic' },
        capabilities: { sameDirectory: true, worktree: true, turnCutoff: true },
        currentAvailable: true,
        turns: [
          {
            turnId: turnId ?? 'synthetic-turn',
            ordinal: 1,
            timestamp: '2026-09-12T00:00:00Z',
            available: true,
          },
        ],
        partial: false,
      };
      await controls.hold?.();
      if (controls.error) {
        synthetic.socket.send(
          JSON.stringify({ type: 'response', requestId: m.requestId, error: controls.error }),
        );
        return;
      }
      return controls.transform?.(result) ?? result;
    });
    synthetic.responses.set('fork-action', async (m) => {
      const input = m.params as SessionFork,
        worktree = input.directory.kind === 'worktree';
      const result = {
        forkVersion: 1,
        workspaceId: input.workspaceId,
        localProjectId: input.localProjectId,
        sessionId: input.sessionId,
        operationId: input.operationId,
        childSessionId: input.childSessionId,
        phase: 'accepted',
        confirmed: true,
        origin: {
          version: 1,
          sourceSessionId: input.sessionId,
          sourceVersion: input.expectedSourceVersion,
          sourceTitle: 'synthetic-fork-private-title',
          cutoff: input.cutoff,
          directory: input.directory.kind,
          ...(worktree ? { branch: (input.directory as any).newBranch, baseOid: oid } : {}),
          createdAt: '2026-09-12T00:00:00Z',
        },
        execution: worktree
          ? {
              mode: 'worktree',
              status: 'ready',
              revision: 1,
              executionId: 'synthetic-child-execution',
              branch: (input.directory as any).newBranch,
              baseOid: oid,
            }
          : { mode: 'shared', status: 'ready', revision: input.expectedExecutionRevision },
      };
      await controls.hold?.();
      if (controls.error) {
        synthetic.socket.send(
          JSON.stringify({ type: 'response', requestId: m.requestId, error: controls.error }),
        );
        return;
      }
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
  const host = space.hosts[0]!,
    replica = space.replicas.find(
      (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
    )!;
  const scope = {
    forkVersion: 1 as const,
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'synthetic-source',
  };
  const action: SessionFork = {
    ...scope,
    operationId: 'synthetic-fork-operation',
    childSessionId: 'synthetic-child',
    expectedSourceVersion: version,
    expectedExecutionRevision: 0,
    cutoff: { kind: 'turn', turnId: 'synthetic-turn' },
    directory: { kind: 'same-directory' },
  };
  const path = (kind: 'options' | 'action') =>
    `/api/workspaces/${space.id}/replicas/${replica.id}/fork/${kind}`;
  return {
    ...relay,
    controls,
    space,
    host,
    replica,
    scope,
    action,
    path,
    synthetic: relay.hosts.find((h) => h.device.id === host.deviceId)!,
  };
}

test('Fork options and native actions route to the exact replica and relay does not persist origins or child execution records', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const host of f.space.hosts) {
    const replica = f.space.replicas.find(
      (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
    )!;
    const synthetic = f.hosts.find((h) => h.device.id === host.deviceId)!;
    for (const [kind, input] of [
      ['options', { ...f.scope, turnId: 'synthetic-turn' }],
      ['action', f.action],
      [
        'action',
        {
          ...f.action,
          directory: {
            kind: 'worktree',
            baseBranch: 'main',
            expectedOid: oid,
            newBranch: 'synthetic-fork-branch',
          },
        },
      ],
    ] as const) {
      const response = await f.api(
        `/api/workspaces/${f.space.id}/replicas/${replica.id}/fork/${kind}`,
        input,
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const result = await response.json();
      assert.equal(result.confirmed, true);
      assert.deepEqual(synthetic.messages.at(-1).params, input);
      assert.equal(synthetic.messages.at(-1).method, 'fork-' + kind);
      assert.equal(synthetic.messages.at(-1).localProjectId, replica.localProjectId);
    }
  }
  for (const row of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    assert.match(String(row.name), /^[a-z_]+$/);
    assert.doesNotMatch(
      JSON.stringify(f.store.db.prepare(`SELECT * FROM ${row.name}`).all()),
      /synthetic-fork-private-title|synthetic-child-execution|synthetic-fork-operation/,
    );
  }
});

test('Fork rejects unauthorized, malformed, unsafe directory and unavailable requests before dispatch', async (t) => {
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
      body: JSON.stringify(f.action),
    });
    assert.equal(response.status, secret ? 404 : 401);
    assert.equal((await response.json()).rejected, true);
  }
  for (const changed of [
    { workspaceId: 'other' },
    { localProjectId: 'local-other' },
    { childSessionId: f.scope.sessionId },
    { cutoff: { kind: 'turn', messageId: 'raw-native-id' } },
    { directory: { kind: 'same-directory', cwd: '/arbitrary' } },
    { prompt: 'fake copied history' },
    { sourceNativeId: 'private-native-id' },
    { expectedSourceVersion: 'stale' },
  ]) {
    const response = await f.api(f.path('action'), { ...f.action, ...changed });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).rejected, true);
  }
  const oversized = await f.api(f.path('action'), { ...f.action, padding: 'x'.repeat(16384) });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).rejected, true);
  assert.equal((await f.api(f.path('action') + '/extra', f.action)).status, 404);
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
  const unavailable = await f.api(f.path('action'), f.action);
  assert.equal(unavailable.status, 409);
  assert.equal((await unavailable.json()).rejected, true);
  assert.equal(
    f.synthetic.messages.some((m) => m.method?.startsWith('fork-')),
    false,
  );
});

test('Fork receipts bind child identity, source version, exact cutoff and requested Git basis', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const transform of [
    (v: any) => ({ ...v, operationId: 'other' }),
    (v: any) => ({ ...v, childSessionId: 'other' }),
    (v: any) => ({ ...v, sessionId: 'other' }),
    (v: any) => ({ ...v, sourceNativeId: 'secret' }),
    (v: any) => ({ ...v, origin: { ...v.origin, sourceSessionId: 'other' } }),
    (v: any) => ({ ...v, origin: { ...v.origin, sourceVersion: 'sha256:' + 'c'.repeat(64) } }),
    (v: any) => ({ ...v, origin: { ...v.origin, cutoff: { kind: 'current' } } }),
    (v: any) => ({ ...v, origin: { ...v.origin, directory: 'worktree' } }),
    (v: any) => ({ ...v, execution: { ...v.execution, revision: 10 } }),
    (v: any) => ({ ...v, execution: { ...v.execution, status: 'unknown' } }),
  ]) {
    f.controls.transform = transform;
    const response = await f.api(f.path('action'), f.action);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).rejected, false);
  }
  const worktree = {
    ...f.action,
    directory: {
      kind: 'worktree',
      baseBranch: 'main',
      expectedOid: oid,
      newBranch: 'feature/fork',
    },
  };
  for (const transform of [
    (v: any) => ({ ...v, execution: { ...v.execution, branch: 'other' } }),
    (v: any) => ({ ...v, execution: { ...v.execution, baseOid: 'c'.repeat(40) } }),
    (v: any) => ({ ...v, origin: { ...v.origin, baseOid: 'c'.repeat(40) } }),
  ]) {
    f.controls.transform = transform;
    const response = await f.api(f.path('action'), worktree);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).rejected, false);
  }
  f.controls.transform = (v) => ({
    ...v,
    phase: 'unknown',
    confirmed: false,
    origin: undefined,
    execution: undefined,
  });
  assert.equal((await (await f.api(f.path('action'), f.action)).json()).phase, 'unknown');
  f.controls.transform = (v) => ({ ...v, turns: [{ ...v.turns[0], turnId: 'different-turn' }] });
  assert.equal(
    (await f.api(f.path('options'), { ...f.scope, turnId: 'synthetic-turn' })).status,
    502,
  );
});

test('logout while receiving a Fork request prevents its first dispatch', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const body = JSON.stringify(f.action),
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
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let output = '';
        response.on('data', (value) => (output += value));
        response.on('end', () =>
          resolve({ status: response.statusCode!, body: JSON.parse(output) }),
        );
      },
    );
    request.on('error', reject);
    request.write(body.slice(0, 1));
    void entered.promise
      .then(async () => {
        await f.api('/api/logout', {});
        request.end(body.slice(1));
      })
      .catch(reject);
  });
  const response = await result;
  assert.equal(response.status, 401);
  assert.equal(response.body.rejected, true);
  assert.equal(
    f.synthetic.messages.some((m) => m.method === 'fork-action'),
    false,
  );
});

test('a dispatched native Fork stays unconfirmed after logout, regrouping or runtime replacement', async (t) => {
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
      const pending = f.api(f.path('action'), f.action);
      await entered.promise;
      if (change === 'logout') await f.api('/api/logout', {});
      else if (change === 'move') {
        const workspace = f.store.catalog.create(f.owner, 'Synthetic moved');
        f.store.catalog.moveHost(f.owner, f.space.id, f.host.id, workspace.id);
      } else {
        f.synthetic.runtime.userId = 'other-runtime-user';
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
      assert.equal((await response.json()).rejected, false);
      assert.equal(f.synthetic.messages.filter((m) => m.method === 'fork-action').length, 1);
    });
});

test('Fork rechecks authorization before returning either an options error or an action error', async (t) => {
  for (const kind of ['options', 'action'] as const)
    for (const change of ['none', 'logout', 'move'] as const)
      await t.test(`${kind} ${change}`, async (t) => {
        const f = await fixture();
        t.after(f.close);
        const entered = deferred(),
          release = deferred();
        f.controls.error = { status: 409, message: 'synthetic-private-fork-error', rejected: true };
        f.controls.hold = async () => {
          entered.resolve();
          await release.promise;
        };
        const pending = f.api(f.path(kind), kind === 'action' ? f.action : f.scope);
        await entered.promise;
        try {
          if (change === 'logout') await f.api('/api/logout', {});
          if (change === 'move') {
            const workspace = f.store.catalog.create(f.owner, 'Synthetic moved error');
            f.store.catalog.moveHost(f.owner, f.space.id, f.host.id, workspace.id);
          }
          release.resolve();
          const response = await pending,
            body = await response.json();
          assert.equal(response.status, change === 'none' ? 409 : change === 'logout' ? 401 : 404);
          if (change === 'none')
            assert.deepEqual(body, { error: f.controls.error.message, rejected: true });
          else {
            assert.doesNotMatch(JSON.stringify(body), /synthetic-private-fork-error/);
            assert.equal(body.rejected, false);
          }
          assert.equal(
            f.synthetic.messages.filter((message) => message.method === 'fork-' + kind).length,
            1,
          );
        } finally {
          release.resolve();
        }
      });
});

test('same-directory Fork confirmation distinguishes original directories from managed worktrees', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.controls.transform = (value) => ({
    ...value,
    execution: { ...value.execution, mode: 'worktree', executionId: 'wrong-worktree' },
  });
  const wrongOriginal = await f.api(f.path('action'), f.action);
  assert.equal(wrongOriginal.status, 502);
  assert.equal((await wrongOriginal.json()).rejected, false);
  const managed = { ...f.action, expectedExecutionRevision: 1 };
  f.controls.transform = undefined;
  const wrongManaged = await f.api(f.path('action'), managed);
  assert.equal(wrongManaged.status, 502);
  assert.equal((await wrongManaged.json()).rejected, false);
  f.controls.transform = (value) => ({
    ...value,
    execution: { ...value.execution, mode: 'worktree', executionId: 'managed-execution' },
  });
  assert.equal((await f.api(f.path('action'), managed)).status, 200);
});
