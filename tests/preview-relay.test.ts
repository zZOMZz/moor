import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { PROTOCOL } from '../src/protocol';
import { PREVIEW_FEATURE, previewActionSchema } from '../src/preview-protocol';
import type { Workspace } from '../src/catalog';
import { syntheticRelay } from './support/synthetic-relay';
import {
  previewFrame,
  previewSignal,
  previewVersion,
  previewViewport,
} from './support/preview-fixture';

async function fixture() {
  const relay = await syntheticRelay();
  const controls: { transform?: (result: any) => any; hold?: () => Promise<void> } = {};
  for (const host of relay.hosts) {
    host.runtime.features!.push(PREVIEW_FEATURE);
    for (const method of ['read', 'action', 'inspect', 'close'])
      host.responses.set('preview-' + method, async (message) => {
        const p = message.params.request ?? message.params;
        const scope = {
          previewVersion: 1,
          workspaceId: p.workspaceId,
          localProjectId: p.localProjectId,
          sessionId: p.sessionId,
        };
        const instance = { ...scope, clientId: p.clientId, previewId: p.previewId ?? 'preview' };
        let result: any;
        if (method === 'read') {
          const base = { ...instance, view: p.view, confirmed: true };
          if (p.view === 'options')
            result = {
              ...scope,
              view: 'options',
              confirmed: true,
              available: true,
              execution: { mode: 'shared', status: 'ready', revision: 0 },
              services: [
                { id: 'service', label: 'Synthetic', version: previewVersion, startPath: '/' },
              ],
            };
          else if (p.view === 'frame') result = { ...base, frame: previewFrame(), expiresAt: 1000 };
          else if (p.view === 'status') result = { ...base, status: 'open', expiresAt: 1000 };
          else
            result = {
              ...base,
              frameId: p.frameId,
              element: {
                elementId: 'element',
                frameId: p.frameId,
                tag: 'button',
                role: 'button',
                name: 'Synthetic',
                text: 'SYNTHETIC_PRIVATE_PREVIEW_PAGE',
                rect: { x: 0, y: 0, width: 10, height: 10 },
                editable: false,
                password: false,
              },
            };
        } else {
          const request = previewActionSchema.parse(p);
          result = {
            ...instance,
            operationId: p.operationId,
            action: p.action,
            requestVersion:
              'sha256:' + createHash('sha256').update(JSON.stringify(request)).digest('hex'),
            phase: method === 'close' ? 'closed' : 'accepted',
            closed: method === 'close',
            message: 'confirmed',
            checkedAt: '2026-09-12T00:00:00Z',
            ...(method === 'action' ? { frame: previewFrame() } : {}),
          };
        }
        await controls.hold?.();
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
  const [space]: Workspace[] = await (await relay.api('/api/workspaces')).json(),
    host = space.hosts[0]!;
  const replica = space.replicas.find(
    (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
  )!;
  const scope = {
    previewVersion: 1,
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'same-session-id',
  };
  const open = {
    ...scope,
    operationId: 'open',
    action: 'open',
    confirmed: true,
    clientId: 'client',
    serviceId: 'service',
    serviceVersion: previewVersion,
    executionRevision: 0,
    viewport: previewViewport,
  };
  const read = (view = 'frame') => ({
    ...scope,
    view,
    ...(view === 'options' ? {} : { clientId: 'client', previewId: 'preview' }),
    ...(view === 'locate' ? { frameId: 'frame', x: 10, y: 10 } : {}),
  });
  return {
    ...relay,
    controls,
    host,
    scope,
    open,
    read,
    path: (kind: string) => `/api/workspaces/${space.id}/replicas/${replica.id}/preview/${kind}`,
    synthetic: relay.hosts.find((h) => h.device.id === host.deviceId)!,
  };
}
test('preview typed reads and explicit actions use one exact replica, with no relay persistence', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const [kind, body] of [
    ['read', f.read('options')],
    ['read', f.read()],
    ['read', f.read('status')],
    ['read', f.read('locate')],
    ['action', f.open],
    ['inspect', { request: f.open }],
    ['close', { request: f.open }],
  ] as const) {
    const response = await f.api(f.path(kind), body);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(f.synthetic.messages.filter((m) => m.method?.startsWith('preview-')).length, 7);
  assert.equal(
    f.hosts.find((h) => h !== f.synthetic)!.messages.filter((m) => m.method?.startsWith('preview-'))
      .length,
    0,
  );
  for (const table of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const name = String(table.name);
    assert.match(name, /^[a-z_]+$/);
    const stored = JSON.stringify(f.store.db.prepare(`SELECT * FROM ${name}`).all());
    assert.ok(!stored.includes('SYNTHETIC_PRIVATE_PREVIEW_PAGE'));
    assert.ok(!stored.includes(previewFrame().image.data));
  }
});
test('preview rejects foreign scopes, raw URLs, scripts and additional controls before dispatch', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const input of [
    { ...f.open, workspaceId: 'foreign' },
    { ...f.open, localProjectId: 'foreign' },
    { ...f.open, url: 'http://127.0.0.1:22/' },
    { ...f.open, script: 'process.env' },
    { ...f.open, confirmed: false },
    { ...f.open, viewport: { width: 10000, height: 844 } },
  ]) {
    const response = await f.api(f.path('action'), input);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).rejected, true);
  }
  assert.equal(f.synthetic.messages.filter((m) => m.method?.startsWith('preview-')).length, 0);
});
test('preview validates returned scope, client, frame identity, image hash and PNG viewport', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const transform of [
    (v: any) => ({ ...v, workspaceId: 'other' }),
    (v: any) => ({ ...v, clientId: 'other' }),
    (v: any) => ({ ...v, frame: { ...v.frame, previewId: 'other' } }),
    (v: any) => ({
      ...v,
      frame: { ...v.frame, image: { ...v.frame.image, version: previewVersion } },
    }),
    (v: any) => ({ ...v, frame: { ...v.frame, viewport: { width: 800, height: 600 } } }),
  ]) {
    f.controls.transform = transform;
    const response = await f.api(f.path('read'), f.read());
    assert.equal(response.status, 502);
    assert.ok(!JSON.stringify(await response.json()).includes('SYNTHETIC_PRIVATE_PREVIEW_PAGE'));
  }
});
test('preview action receipt must match original request and recovery errors never imply safe replay', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.controls.transform = (v) => ({ ...v, requestVersion: previewVersion });
  for (const kind of ['action', 'inspect', 'close']) {
    const response = await f.api(f.path(kind), kind === 'action' ? f.open : { request: f.open });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).rejected, false);
  }
});
test('logout during preview read prevents late page disclosure', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const entered = previewSignal(),
    release = previewSignal();
  f.controls.hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.api(f.path('read'), f.read());
  await entered.promise;
  f.store.db.prepare('DELETE FROM login').run();
  release.resolve();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.ok(!JSON.stringify(await response.json()).includes('SYNTHETIC_PRIVATE_PREVIEW_PAGE'));
});
test('preview feature withdrawal after request blocks its stale response', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const entered = previewSignal(),
    release = previewSignal();
  f.controls.hold = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.api(f.path('read'), f.read());
  await entered.promise;
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
  release.resolve();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.ok(!JSON.stringify(await response.json()).includes('SYNTHETIC_PRIVATE_PREVIEW_PAGE'));
});
