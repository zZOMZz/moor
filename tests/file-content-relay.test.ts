import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { syntheticRelay } from './support/synthetic-relay';
import type { Workspace } from '../src/catalog';
import { PROTOCOL } from '../src/protocol';
import { CONTENT_VERSION, type ProjectFileRead } from '../src/content-protocol';

async function fixture() {
  const relay = await syntheticRelay();
  const [space]: Workspace[] = await (await relay.api('/api/workspaces')).json();
  const host = space.hosts[0];
  const replica = space.replicas.find(
    (item) => item.hostId === host.id && item.localProjectId === 'local-moor',
  )!;
  const path = `/api/workspaces/${space.id}/replicas/${replica.id}/file-content`;
  const input: ProjectFileRead = {
    contentVersion: CONTENT_VERSION,
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'same-session-id',
    path: 'README.md',
  };
  const syntheticHost = relay.hosts.find((item) => item.device.id === host.deviceId)!;
  const readCount = () =>
    relay.hosts.map((item) => item.messages.filter((m) => m.method === 'file-content').length);
  return { ...relay, space, host, replica, path, input, syntheticHost, readCount };
}

test('file-content reads select the exact host despite identical runtime, session and path; relay stores no file content', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const results = [];
  for (const host of f.space.hosts) {
    const replica = f.space.replicas.find(
      (item) => item.hostId === host.id && item.localProjectId === 'local-moor',
    )!;
    const response = await f.api(
      `/api/workspaces/${f.space.id}/replicas/${replica.id}/file-content`,
      f.input,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    const synthetic = f.hosts.find((item) => item.device.id === host.deviceId)!;
    assert.equal(result.status, 'content');
    assert.equal(result.confirmed, true);
    assert.deepEqual(Buffer.from(result.data, 'base64'), synthetic.fileContents.get('README.md'));
    const forwarded = synthetic.messages.at(-1);
    assert.equal(forwarded.method, 'file-content');
    assert.equal(forwarded.workspaceId, host.runtimeWorkspaceId);
    assert.equal(forwarded.localProjectId, replica.localProjectId);
    assert.deepEqual(forwarded.params, f.input);
    assert.equal(synthetic.operations.size, 0);
    assert.equal(synthetic.sessionActions.size, 0);
    results.push(result);
  }
  assert.notEqual(results[0].data, results[1].data);
  assert.deepEqual(f.readCount(), [1, 1]);
  const tables = f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  for (const { name } of tables) {
    assert.match(String(name), /^[a-z_]+$/);
    const rows = JSON.stringify(f.store.db.prepare(`SELECT * FROM ${name}`).all());
    for (const result of results) {
      assert.equal(rows.includes(result.data), false);
      assert.equal(rows.includes(result.content.version), false);
    }
    assert.doesNotMatch(rows, /Synthetic file from host|README\.md|base64|file-content/);
  }
});

test('file-content route rejects unauthenticated and other-account requests, invalid scopes and noncanonical routes', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const fetchAs = (secret?: string) =>
    fetch(f.origin + f.path, {
      method: 'POST',
      headers: {
        Origin: f.origin,
        'Content-Type': 'application/json',
        ...(secret ? { Cookie: 'personal=' + secret } : {}),
      },
      body: JSON.stringify(f.input),
    });
  assert.equal((await fetchAs()).status, 401);
  assert.equal((await fetchAs(f.store.createLogin('another-account'))).status, 404);
  for (const changes of [
    { workspaceId: 'other-runtime' },
    { localProjectId: 'local-other' },
    { contentVersion: 2 },
    { path: '../outside.txt' },
    { command: 'injected' },
  ])
    assert.equal((await f.api(f.path, { ...f.input, ...changes })).status, 400);
  assert.equal((await f.api(f.path + '/extra', f.input)).status, 404);
  assert.equal(
    (
      await f.api(
        `/api/devices/${f.host.deviceId}/file-content?workspace=${f.host.runtimeWorkspaceId}`,
        f.input,
      )
    ).status,
    404,
  );
  const otherSpace = await (await f.api('/api/workspaces', { name: 'Other workspace' })).json();
  assert.equal(
    (await f.api(`/api/workspaces/${otherSpace.id}/replicas/${f.replica.id}/file-content`, f.input))
      .status,
    404,
  );
  assert.deepEqual(f.readCount(), [0, 0]);
  const otherProject = f.space.replicas.find(
    (item) => item.hostId === f.host.id && item.localProjectId === 'local-other',
  )!;
  assert.equal(
    (
      await f.api(`/api/workspaces/${f.space.id}/replicas/${otherProject.id}/file-content`, {
        ...f.input,
        localProjectId: otherProject.localProjectId,
      })
    ).status,
    404,
  );
  assert.equal((await f.api(f.path, { ...f.input, sessionId: 'unknown-session' })).status, 404);
  assert.equal((await f.api(f.path, { ...f.input, path: 'missing.txt' })).status, 404);
  assert.deepEqual(f.readCount(), [3, 0]);
});

test('file-content requests have a small body limit without changing existing route limits', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const oversized = { ...f.input, padding: 'x'.repeat(16 * 1024) };
  const response = await f.api(f.path, oversized);
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.readCount(), [0, 0]);
  // The existing session-action route still parses a larger body and rejects its
  // unknown field as a schema error, rather than applying the new file-read cap.
  const action = await f.api(f.path.replace('/file-content', '/session-actions'), {
    operationId: 'oversized-nonfile',
    workspaceId: f.input.workspaceId,
    localProjectId: f.input.localProjectId,
    sessionId: f.input.sessionId,
    expectedRevision: 0,
    action: 'pin',
    padding: oversized.padding,
  });
  assert.equal(action.status, 400);
});

test('file-content requests require advertised support and a current, online, nonrevoked binding', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const advertise = async (workspaces: unknown[]) => {
    const pong = once(f.syntheticHost.socket, 'pong');
    f.syntheticHost.socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        machineId: f.syntheticHost.runtime.machineId,
        workspaces,
      }),
    );
    f.syntheticHost.socket.ping();
    await pong;
  };
  const { features: _features, ...legacy } = f.syntheticHost.runtime;
  await advertise([legacy]);
  assert.equal((await f.api(f.path, f.input)).status, 409);
  assert.deepEqual(f.readCount(), [0, 0]);
  await advertise([f.syntheticHost.runtime]);
  const target = await (await f.api('/api/workspaces', { name: 'Moved workspace' })).json();
  await f.api(`/api/workspaces/${f.space.id}/hosts/${f.host.id}/move`, {
    workspaceId: target.id,
  });
  assert.equal((await f.api(f.path, f.input)).status, 404);
  assert.deepEqual(f.readCount(), [0, 0]);
  const currentPath = `/api/workspaces/${target.id}/replicas/${f.replica.id}/file-content`;
  assert.equal((await f.api(currentPath, f.input)).status, 200);
  const pong = once(f.syntheticHost.socket, 'pong');
  f.syntheticHost.socket.send(JSON.stringify({ type: 'unavailable' }));
  f.syntheticHost.socket.ping();
  await pong;
  assert.equal((await f.api(currentPath, f.input)).status, 409);
  assert.deepEqual(f.readCount(), [1, 0]);
  await f.api(`/api/devices/${f.host.deviceId}/revoke`, {});
  assert.equal((await f.api(currentPath, f.input)).status, 404);
  assert.deepEqual(f.readCount(), [1, 0]);
});

test('file-content validates host responses and only accepts not-modified for the requested version', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const initial = await (await f.api(f.path, f.input)).json();
  const known = { ...f.input, knownVersion: initial.content.version };
  const unchanged = await f.api(f.path, known);
  assert.equal(unchanged.status, 200);
  assert.deepEqual(await unchanged.json(), {
    contentVersion: CONTENT_VERSION,
    workspaceId: f.input.workspaceId,
    localProjectId: f.input.localProjectId,
    sessionId: f.input.sessionId,
    path: f.input.path,
    confirmed: true,
    content: initial.content,
    status: 'not-modified',
  });
  f.syntheticHost.fileContents.set('README.md', Buffer.from('Synthetic revised file\n'));
  const changed = await (await f.api(f.path, known)).json();
  assert.equal(changed.status, 'content');
  assert.notEqual(changed.content.version, initial.content.version);
  for (const override of [
    { workspaceId: 'wrong-runtime' },
    { localProjectId: 'local-other' },
    { sessionId: 'another-session' },
    { path: 'another.txt' },
    { confirmed: false },
    { contentVersion: 2 },
    { encoding: 'utf8' },
    { data: '@invalid-base64' },
    { unknown: true },
  ]) {
    f.syntheticHost.fileResponse.transform = (result) => ({ ...result, ...override });
    const response = await f.api(f.path, f.input);
    assert.equal(response.status, 502, JSON.stringify(override));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  f.syntheticHost.fileResponse.transform = (result) => {
    const { data: _data, encoding: _encoding, ...scope } = result as typeof initial;
    return { ...scope, status: 'not-modified' };
  };
  assert.equal((await f.api(f.path, f.input)).status, 502);
  assert.equal((await f.api(f.path, known)).status, 502);
  f.syntheticHost.fileResponse.transform = undefined;
  assert.equal((await f.api(f.path, f.input)).status, 200);
});

test('pending file reads cannot deliver after logout, a host move, or a bridge connection change', async (t) => {
  for (const change of ['move', 'logout', 'unavailable', 'revoke', 'replace'] as const)
    await t.test(change, async (t) => {
      const f = await fixture();
      t.after(f.close);
      let observed!: () => void, release!: () => void;
      const requested = new Promise<void>((resolve) => (observed = resolve));
      const held = new Promise<void>((resolve) => (release = resolve));
      f.syntheticHost.fileResponse.beforeSend = async () => {
        observed();
        await held;
      };
      const pending = f.api(f.path, f.input);
      await requested;
      try {
        let expectedStatus = 409;
        if (change === 'move') {
          const target = await (
            await f.api('/api/workspaces', { name: 'Moved during read' })
          ).json();
          await f.api(`/api/workspaces/${f.space.id}/hosts/${f.host.id}/move`, {
            workspaceId: target.id,
          });
          expectedStatus = 404;
          release();
        } else if (change === 'logout') {
          await f.api('/api/logout', {});
          expectedStatus = 401;
          release();
        } else if (change === 'unavailable')
          f.syntheticHost.socket.send(JSON.stringify({ type: 'unavailable' }));
        else if (change === 'revoke') await f.api(`/api/devices/${f.host.deviceId}/revoke`, {});
        else {
          const replacement = new WebSocket(f.origin.replace('http:', 'ws:') + '/bridge', {
            headers: { Authorization: 'Bearer ' + f.syntheticHost.device.token },
          });
          await once(replacement, 'open');
          replacement.send(
            JSON.stringify({
              type: 'hello',
              protocol: PROTOCOL,
              machineId: f.syntheticHost.runtime.machineId,
              workspaces: [f.syntheticHost.runtime],
            }),
          );
        }
        // Connection transitions reject immediately, even while the synthetic
        // reader is still held. Move/logout reject when it returns its bytes.
        const response = await pending;
        assert.equal(response.status, expectedStatus);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const result = await response.json();
        assert.equal('data' in result, false);
        assert.equal(result.rejected, false, 'a read has no execution acknowledgement');
        assert.deepEqual(f.readCount(), [1, 0]);
      } finally {
        release();
      }
    });
});
