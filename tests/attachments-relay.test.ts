import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Store } from '../src/relay/accounts';
import { createApp } from '../src/relay/http';
import { RuntimeStore } from '../src/runtime/store';
import { HostWorkspace } from '../src/bridge/host-workspace';
import type { Workspace } from '../src/catalog';
import { AppError, PROTOCOL } from '../src/protocol';
import { putMeta } from '../src/model';
import { CONTENT_LIMITS, CONTENT_VERSION } from '../src/content-protocol';
import {
  ATTACHMENTS_FEATURE,
  attachmentActionSchema,
  attachmentReadSchema,
  type AttachmentAction,
} from '../src/attachment-protocol';

function upload(
  bytes = Buffer.from('private synthetic attachment'),
  operationId = 'upload-one',
): AttachmentAction {
  return {
    contentVersion: CONTENT_VERSION,
    workspaceId: 'synthetic-runtime',
    localProjectId: 'project-a',
    sessionId: 'same-session',
    operationId,
    action: 'upload',
    attachment: {
      contentVersion: CONTENT_VERSION,
      attachmentId: operationId,
      name: operationId + '.bin',
      content: {
        version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length,
        mediaType: 'application/octet-stream',
      },
    },
    data: bytes.toString('base64'),
  };
}
function read(input: AttachmentAction) {
  assert.equal(input.action, 'upload');
  if (input.action !== 'upload') throw new Error('Expected an upload');
  return {
    contentVersion: CONTENT_VERSION,
    workspaceId: input.workspaceId,
    localProjectId: input.localProjectId,
    sessionId: input.sessionId,
    attachmentId: input.attachment.attachmentId,
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'moor-attachment-relay-'));
  const store = new Store(':memory:');
  const secret = await store.setup('attachment@synthetic.invalid', 'synthetic-password-only');
  const owner = store.owner(secret);
  const app = createApp(store, { origin: 'http://127.0.0.1:0', setupToken: 'synthetic' });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const origin = `http://127.0.0.1:${address.port}`;
  app.setOrigin(origin);
  const hosts: {
    device: ReturnType<Store['redeem']>;
    runtime: RuntimeStore;
    host: HostWorkspace;
    socket: WebSocket;
    messages: any[];
    response: { transform?: (result: any) => unknown; beforeSend?: () => Promise<void> };
    hello: () => void;
    launches: () => number;
  }[] = [];
  for (const label of ['a', 'b']) {
    const device = store.redeem(store.pair(owner), 'Synthetic attachment host ' + label);
    const runtime = new RuntimeStore(':memory:');
    Object.assign(runtime.workspace, {
      id: 'synthetic-runtime',
      name: 'Synthetic workspace',
      userId: 'synthetic-user-' + label,
      machineId: 'synthetic-machine-' + label,
    });
    for (const id of ['project-a', 'project-b']) {
      const rootPath = join(directory, label, id);
      mkdirSync(rootPath, { recursive: true });
      runtime.machine.set(['localProject', id], { id, name: id, rootPath });
    }
    runtime.saveMachine();
    putMeta(runtime.meta, 'session-same-session', {
      id: 'same-session',
      machineId: runtime.workspace.machineId,
      userId: runtime.workspace.userId,
      project: { kind: 'local', localProjectId: 'project-a' },
    });
    let launches = 0;
    const host = new HostWorkspace(
      runtime,
      {
        async open() {
          launches++;
          throw new Error('Attachment management must not open an Agent');
        },
      },
      () => {},
      () => {},
    );
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/bridge', {
      headers: { Authorization: 'Bearer ' + device.token },
    });
    const messages: any[] = [];
    const response: { transform?: (result: any) => unknown; beforeSend?: () => Promise<void> } = {};
    const ready = new Promise<void>((resolve) =>
      socket.on('message', async (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'ready') resolve();
        if (message.type !== 'request') return;
        messages.push(message);
        let result: unknown, error: unknown;
        try {
          assert.equal(message.workspaceId, runtime.workspace.id);
          if (message.method === 'attachment-action')
            result = await host.attachmentAction(
              attachmentActionSchema.parse(message.params),
              message.localProjectId,
            );
          else if (message.method === 'read-attachment')
            result = await host.readAttachment(
              attachmentReadSchema.parse(message.params),
              message.localProjectId,
            );
          else throw new Error('Unexpected method');
          if (response.transform) result = response.transform(result);
        } catch (failure) {
          error = {
            status: failure instanceof AppError ? failure.status : 502,
            message: failure instanceof AppError ? failure.message : 'Synthetic host failure',
          };
        }
        await response.beforeSend?.();
        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({ type: 'response', requestId: message.requestId, result, error }),
          );
      }),
    );
    await once(socket, 'open');
    const hello = () =>
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL,
          machineId: runtime.workspace.machineId,
          workspaces: [runtime.workspace],
        }),
      );
    hello();
    await ready;
    hosts.push({
      device,
      runtime,
      host,
      socket,
      messages,
      response,
      hello,
      launches: () => launches,
    });
  }
  const api = (path: string, body?: unknown, login: string | null = secret) =>
    fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(login ? { Cookie: 'personal=' + login } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const [space]: Workspace[] = await (await api('/api/workspaces')).json();
  const route = (hostIndex = 0, localProjectId = 'project-a', workspaceId = space.id) => {
    const host = space.hosts.find((item) => item.deviceId === hosts[hostIndex].device.id)!;
    const replica = space.replicas.find(
      (item) => item.hostId === host.id && item.localProjectId === localProjectId,
    )!;
    return `/api/workspaces/${workspaceId}/replicas/${replica.id}`;
  };
  return {
    store,
    secret,
    owner,
    app,
    hosts,
    api,
    space,
    route,
    close: async () => {
      await app.close();
      for (const { host, runtime, launches } of hosts) {
        host.close();
        runtime.close();
        assert.equal(launches(), 0);
      }
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('canonical attachment routes persist only on the selected real host and retry the exact receipt', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const input = upload();
  const actionPath = f.route() + '/attachment-actions',
    readPath = f.route() + '/attachments/read';
  const response = await f.api(actionPath, input);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const receipt = await response.json();
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.delivered, true);
  assert.equal(receipt.operationId, input.operationId);
  assert.equal('data' in receipt, false);
  assert.deepEqual(await (await f.api(actionPath, input)).json(), receipt);
  const content = await (await f.api(readPath, read(input))).json();
  assert.equal(content.confirmed, true);
  assert.equal(input.action === 'upload' && content.data, input.action === 'upload' && input.data);
  assert.equal((await f.api(f.route(1) + '/attachments/read', read(input))).status, 404);
  assert.equal(
    (
      await f.api(actionPath, {
        ...input,
        data: Buffer.from('private synthetic ATTACHMENT').toString('base64'),
      })
    ).status,
    409,
  );
  const remove = { ...read(input), action: 'remove', operationId: 'remove-one' };
  assert.equal((await f.api(actionPath, remove)).status, 200);
  assert.equal((await f.api(readPath, read(input))).status, 404);
  assert.equal((await f.api(actionPath, remove)).status, 200);
  for (const row of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    assert.match(String(row.name), /^[a-z_]+$/);
    const stored = JSON.stringify(f.store.db.prepare(`SELECT * FROM ${row.name}`).all());
    assert.equal(input.action === 'upload' && stored.includes(input.data), false);
    assert.equal(stored.includes('private synthetic attachment'), false);
    assert.equal(stored.includes('sha256:'), false);
  }
});

test('attachment APIs isolate account, route, host, runtime, project and session before disclosure', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const input = upload(),
    actionPath = f.route() + '/attachment-actions';
  assert.equal((await f.api(actionPath, input)).status, 200);
  const readPath = f.route() + '/attachments/read';
  assert.equal((await f.api(readPath, read(input), null)).status, 401);
  assert.equal(
    (await f.api(readPath, read(input), f.store.createLogin('another-account'))).status,
    404,
  );
  for (const change of [
    { workspaceId: 'other-runtime' },
    { localProjectId: 'project-b' },
    { command: 'not-a-file-operation' },
    { contentVersion: 2 },
  ])
    assert.equal((await f.api(readPath, { ...read(input), ...change })).status, 400);
  assert.equal(
    (await f.api(readPath, { ...read(input), sessionId: 'another-session' })).status,
    404,
  );
  assert.equal(
    (
      await f.api(f.route(0, 'project-b') + '/attachments/read', {
        ...read(input),
        localProjectId: 'project-b',
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.api(f.route(0, 'project-b') + '/attachment-actions', {
        ...input,
        localProjectId: 'project-b',
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.api(`/api/devices/${f.hosts[0].device.id}/attachments/read`, read(input))).status,
    404,
  );
  assert.equal((await f.api(readPath + '/extra', read(input))).status, 404);
  assert.equal((await f.api(actionPath + '/extra', input)).status, 404);
});

test('canonical 8 MiB attachments cross HTTP and WebSocket intact while oversized bodies are rejected', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const input = upload(Buffer.alloc(CONTENT_LIMITS.attachmentBytes, 0xa5), 'maximum-size');
  const response = await f.api(f.route() + '/attachment-actions', input);
  assert.equal(response.status, 200);
  const downloaded = await f.api(f.route() + '/attachments/read', read(input));
  assert.equal(downloaded.status, 200);
  const content = await downloaded.json();
  assert.equal(content.data, input.action === 'upload' && input.data);
  assert.equal(Buffer.from(content.data, 'base64').length, CONTENT_LIMITS.attachmentBytes);
  assert.equal(
    (
      await f.api(f.route() + '/attachment-actions', {
        ...input,
        padding: 'x'.repeat(2 * 1024 * 1024),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await f.api(f.route() + '/attachments/read', {
        ...read(input),
        padding: 'x'.repeat(16 * 1024),
      })
    ).status,
    413,
  );
});

test('attachments require a live host advertising the feature and reject malformed host confirmations', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const host = f.hosts[0],
    input = upload(),
    path = f.route() + '/attachment-actions';
  host.runtime.workspace.features = host.runtime.workspace.features!.filter(
    (feature) => feature !== ATTACHMENTS_FEATURE,
  );
  let pong = once(host.socket, 'pong');
  host.hello();
  host.socket.ping();
  await pong;
  assert.equal((await f.api(path, input)).status, 409);
  assert.equal(host.messages.length, 0);
  host.runtime.workspace.features.push(ATTACHMENTS_FEATURE);
  pong = once(host.socket, 'pong');
  host.hello();
  host.socket.ping();
  await pong;
  for (const change of [
    { operationId: 'wrong-operation' },
    { sessionId: 'wrong-session' },
    { workspaceId: 'wrong-runtime' },
    { localProjectId: 'wrong-project' },
    { delivered: false },
    { data: 'must-not-leak' },
  ]) {
    host.response.transform = (result) => ({ ...result, ...change });
    assert.equal((await f.api(path, input)).status, 502, JSON.stringify(change));
  }
  for (const change of [
    { name: 'wrong-name.bin' },
    {
      content: {
        version: input.action === 'upload' && input.attachment.content.version,
        byteLength: 1,
        mediaType: 'text/plain',
      },
    },
  ]) {
    host.response.transform = (result) => ({
      ...result,
      attachment: { ...result.attachment, ...change },
    });
    assert.equal((await f.api(path, input)).status, 502, JSON.stringify(change));
  }
  host.response.transform = undefined;
  assert.equal((await f.api(path, input)).status, 200);
});

test('pending attachment reads cannot disclose bytes after logout, move or connection loss', async (t) => {
  for (const change of ['logout', 'move', 'unavailable'] as const)
    await t.test(change, async (t) => {
      const f = await fixture();
      t.after(f.close);
      const input = upload();
      assert.equal((await f.api(f.route() + '/attachment-actions', input)).status, 200);
      let observed!: () => void, release!: () => void;
      const requested = new Promise<void>((resolve) => (observed = resolve));
      const held = new Promise<void>((resolve) => (release = resolve));
      f.hosts[0].response.beforeSend = async () => {
        observed();
        await held;
      };
      const pending = f.api(f.route() + '/attachments/read', read(input));
      await requested;
      try {
        let expected = 409;
        if (change === 'logout') {
          await f.api('/api/logout', {});
          expected = 401;
          release();
        } else if (change === 'move') {
          const target = await (
            await f.api('/api/workspaces', { name: 'Moved synthetic host' })
          ).json();
          const host = f.space.hosts.find((item) => item.deviceId === f.hosts[0].device.id)!;
          await f.api(`/api/workspaces/${f.space.id}/hosts/${host.id}/move`, {
            workspaceId: target.id,
          });
          expected = 404;
          release();
        } else f.hosts[0].socket.send(JSON.stringify({ type: 'unavailable' }));
        const response = await pending;
        assert.equal(response.status, expected);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal('data' in (await response.json()), false);
      } finally {
        release();
      }
    });
});
