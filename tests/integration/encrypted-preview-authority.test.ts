import test, { type TestContext } from 'node:test';
import { HostProductCatalog } from '@moor/host/commands/product-catalog';
import { HostCommandDispatcher, type HostCommand } from '@moor/host/commands/host-command';
import { EncryptedHostCommands } from '@moor/host/commands/encrypted-host-command';
import { E2eeChannel, newChannelChallenge } from '@moor/e2ee/e2ee-channel';
import { generateDeviceEncryptionKey } from '@moor/e2ee/e2ee-crypto';
import {
  generateTrustRoot,
  encryptionKeyId,
  signTrustManifest,
  VerifiedTrust,
} from '@moor/e2ee/e2ee-trust';
import type { EncryptedProductTarget } from '@moor/e2ee/encrypted-product-catalog';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '@moor/host/sessions/workspace';
import { RuntimeStore } from '@moor/host/persistence/store';
import type { PreviewDriver } from '@moor/host/integrations/preview/driver';
import { AppError } from '@moor/protocol/protocol';
import {
  previewActionSchema,
  type PreviewAction,
  type PreviewOpen,
} from '@moor/protocol/preview-protocol';
import {
  previewFrame,
  previewSignal,
  previewVersion,
  previewViewport,
} from '../fixtures/preview-fixture';

function baseFixture(t: { after(work: () => unknown): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'moor-preview-host-')),
    root = join(dir, 'project'),
    file = join(dir, 'host.sqlite');
  mkdirSync(root);
  let store = new RuntimeStore(file);
  store.machine.set(['localProject', 'project'], {
    id: 'project',
    name: 'Synthetic',
    rootPath: root,
  });
  store.machine.set(['localProject', 'other'], { id: 'other', name: 'Other', rootPath: root });
  store.saveMachine();
  let now = Date.parse('2026-09-12T00:00:00Z'),
    next = 0;
  const timers = new Map<number, { at: number; work(): void }>();
  const state = {
    valid: true,
    calls: [] as string[],
    closed: [] as string[],
    sequence: 0,
    before: undefined as undefined | (() => Promise<void>),
    after: undefined as undefined | (() => Promise<void>),
  };
  const service = {
    id: 'service',
    label: 'Synthetic',
    version: previewVersion,
    startPath: '/',
    origin: 'http://127.0.0.1:12345',
    localProjectId: 'project',
    executionId: 'shared',
    rootIdentity: previewVersion,
    projectRootIdentity: previewVersion,
  };
  const frame = (id: string, viewport = previewViewport) =>
    previewFrame(id, 'frame-' + ++state.sequence, viewport);
  const driver: PreviewDriver = {
    async available() {
      return { available: true };
    },
    async open(binding, check) {
      await state.before?.();
      check.assertCurrent();
      check.beforeDispatch!();
      state.calls.push('open');
      await state.after?.();
      check.assertCurrent();
      return frame(binding.previewId, binding.viewport);
    },
    async capture(id, check) {
      await state.before?.();
      check.assertCurrent();
      return frame(id);
    },
    async locate(id, frameId, point, check) {
      check.assertCurrent();
      return {
        elementId: 'element',
        frameId,
        tag: 'button',
        role: 'button',
        name: 'Synthetic',
        text: 'SYNTHETIC_PRIVATE_PREVIEW_PAGE',
        rect: { x: point.x, y: point.y, width: 20, height: 20 },
        editable: false,
        password: false,
      };
    },
    async interact(request, check) {
      await state.before?.();
      check.assertCurrent();
      check.beforeDispatch!();
      state.calls.push(request.action);
      await state.after?.();
      check.assertCurrent();
      return frame(request.previewId, 'viewport' in request ? request.viewport : previewViewport);
    },
    async close(id) {
      state.closed.push(id);
    },
    async closeAll() {},
  };
  const makeHost = () =>
    new HostWorkspace(
      store,
      {
        async open() {
          throw new Error('must not start an agent');
        },
      },
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        driver,
        config: {
          getServices: () => {
            const { id, label, version, startPath } = service;
            const publicService = { id, label, version, startPath };
            return state.valid ? [publicService] : [];
          },
          getService: () => (state.valid ? service : undefined),
          isCurrent: () => state.valid,
        },
        now: () => now,
        schedule: (ms, work) => {
          const id = ++next;
          timers.set(id, { at: now + ms, work });
          return () => {
            timers.delete(id);
          };
        },
      },
    );
  let host = makeHost();
  const scope = {
    previewVersion: 1 as const,
    workspaceId: store.workspace.id,
    localProjectId: 'project',
    sessionId: 'new-session',
  };
  const open = (operationId = 'open'): PreviewOpen => ({
    ...scope,
    operationId,
    clientId: 'client',
    confirmed: true,
    action: 'open',
    serviceId: 'service',
    serviceVersion: previewVersion,
    executionRevision: 0,
    viewport: previewViewport,
  });
  const action = (previewId: string, frameId: string, extra: object = {}): PreviewAction =>
    previewActionSchema.parse({
      ...scope,
      previewId,
      frameId,
      clientId: 'client',
      operationId: 'click',
      confirmed: true,
      action: 'click',
      elementId: 'element',
      ...extra,
    });
  const read = (previewId: string, view: 'frame' | 'status' = 'frame') =>
    host.readPreview({ ...scope, clientId: 'client', previewId, view });
  t.after(() => {
    host.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    state,
    scope,
    open,
    action,
    read,
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= now) {
          timers.delete(id);
          timer.work();
        }
    },
    restart() {
      host.close();
      store.close();
      store = new RuntimeStore(file);
      host = makeHost();
    },
  };
}

async function fixture(t: TestContext) {
  const f = baseFixture(t);
  const [root, clientKey, hostKey] = await Promise.all([
    generateTrustRoot(),
    generateDeviceEncryptionKey(),
    generateDeviceEncryptionKey(),
  ]);
  const pin = {
    serverOrigin: 'https://relay.synthetic.invalid',
    accountId: 'owner',
    rootKeyId: root.keyId,
  };
  const signed = await signTrustManifest({
    rootPrivateKey: root.privateKey,
    rootPublicKey: root.publicKey,
    manifest: {
      ...pin,
      version: 1,
      epoch: 1,
      previous: null,
      devices: [
        {
          deviceId: 'client',
          keyId: await encryptionKeyId(clientKey.publicKey),
          publicKey: clientKey.publicKey,
          roles: ['client'],
        },
        {
          deviceId: 'host',
          keyId: await encryptionKeyId(hostKey.publicKey),
          publicKey: hostKey.publicKey,
          roles: ['host'],
        },
      ],
    },
  });
  const trust = await VerifiedTrust.verify({ signed, rootPublicKey: root.publicKey, pin });
  const runtime = () => ({
    catalogVersion: 1 as const,
    machineId: f.host.workspace.machineId,
    workspaces: [f.host.workspace],
  });
  const products = new HostProductCatalog({
    db: f.store.journal.db,
    authority: { ...pin, hostDeviceId: 'host' },
    runtime,
  });
  const replica = products.read().replicas.find((replica) => replica.localProjectId === 'project')!;
  const target: EncryptedProductTarget = {
    catalogWorkspaceId: replica.catalogWorkspaceId,
    projectId: replica.projectId,
    replicaId: replica.id,
    revision: replica.revision,
  };
  const dispatcher = new HostCommandDispatcher({
    ready: () => !f.host.closed,
    workspace: (id) => (id === f.host.workspace.id ? f.host : undefined),
    hasOperation: (id) => f.store.journal.has(id),
  });
  const connect = async () => {
    let active = true;
    const common = {
      trust,
      clientDeviceId: 'client',
      hostDeviceId: 'host',
      hostChallenge: newChannelChallenge(),
      clientChallenge: newChannelChallenge(),
    };
    const [client, host] = await Promise.all([
      E2eeChannel.create({
        ...common,
        side: 'client',
        privateKey: clientKey.privateKey,
        current: () => trust,
      }),
      E2eeChannel.create({
        ...common,
        side: 'host',
        privateKey: hostKey.privateKey,
        current: () => (active ? trust : undefined),
      }),
    ]);
    const adapter = new EncryptedHostCommands({
      channel: host,
      dispatcher,
      products,
      catalog: () => ({ ...runtime(), catalogVersion: 2, products: products.read() }),
      invalidateAuthorizations: () => f.host.previewManager.invalidateUnavailable(),
    });
    t.after(() => {
      client.close();
      host.close();
    });
    const send = async (
      request: unknown,
      resource: Parameters<E2eeChannel['send']>[0]['resource'],
    ) => {
      const record = await client.send({
        kind: 'request',
        requestId: newChannelChallenge(),
        resource,
        plaintext: new TextEncoder().encode(JSON.stringify(request)),
      });
      return JSON.parse(
        new TextDecoder().decode((await client.receive(await adapter.execute(record))).plaintext),
      );
    };
    return {
      execute(method: HostCommand['method'], params: unknown, selected = target) {
        return send(
          {
            method: 'mapped-command',
            target: selected,
            command: {
              method,
              workspaceId: f.scope.workspaceId,
              localProjectId: 'project',
              params,
            },
          },
          {
            kind: 'session',
            workspaceId: f.scope.workspaceId,
            projectId: 'project',
            sessionId: f.scope.sessionId,
            catalogWorkspaceId: selected.catalogWorkspaceId,
            replicaId: selected.replicaId,
          },
        );
      },
      catalog(request: unknown) {
        return send(request, {
          kind: 'catalog',
          workspaceId: null,
          projectId: null,
          sessionId: null,
          catalogWorkspaceId: null,
          replicaId: null,
        });
      },
      retire() {
        active = false;
        host.close();
        f.host.previewManager.invalidateUnavailable();
      },
    };
  };
  const first = await connect(),
    second = await connect();
  const move = async () => {
    for (const request of [
      {
        version: 1,
        action: 'create-workspace',
        operationId: 'create-space',
        expectedRevision: products.read().revision,
        id: 'other-space',
        name: 'Other',
      },
      {
        version: 1,
        action: 'move-host',
        operationId: 'move',
        expectedRevision: products.read().revision + 1,
        runtimeWorkspaceId: f.scope.workspaceId,
        targetWorkspaceId: 'other-space',
      },
    ])
      assert.equal((await second.catalog({ method: 'catalog-action', params: request })).ok, true);
  };
  return { ...f, first, second, connect, products, target, move };
}

test('encrypted preview authority survives the open receipt and protects every frame and interaction from another channel', async (t) => {
  const f = await fixture(t),
    open = f.open(),
    opened = await f.first.execute('preview-action', open);
  assert.equal(opened.ok, true);
  assert.equal(opened.result.phase, 'accepted');
  const previewId = opened.result.previewId,
    frameId = opened.result.frame.frameId;
  const frame = { ...f.scope, clientId: open.clientId, previewId, view: 'frame' };
  assert.equal((await f.first.execute('preview-read', frame)).ok, true);
  assert.equal((await f.second.execute('preview-read', frame)).ok, false);
  const priorCalls = [...f.state.calls];
  const attempted = await f.second.execute('preview-action', f.action(previewId, frameId));
  assert.ok(!attempted.ok || attempted.result.phase === 'rejected');
  assert.deepEqual(f.state.calls, priorCalls);
  const fresh = await f.first.execute('preview-read', frame);
  const clicked = await f.first.execute(
    'preview-action',
    f.action(previewId, fresh.result.frame.frameId, { operationId: 'own-click' }),
  );
  assert.equal(clicked.ok, true);
  assert.equal(clicked.result.phase, 'accepted');
  assert.deepEqual(f.state.calls, ['open', 'click']);
});

test('retiring one preview channel destroys only its instances and a new connection can only inspect or close the original open', async (t) => {
  const f = await fixture(t),
    original = f.open('first-open');
  const first = (await f.first.execute('preview-action', original)).result;
  const second = (
    await f.second.execute('preview-action', { ...f.open('second-open'), clientId: 'other-client' })
  ).result;
  f.first.retire();
  assert.ok(f.state.closed.includes(first.previewId));
  assert.ok(!f.state.closed.includes(second.previewId));
  const replacement = await f.connect();
  const inspected = await replacement.execute('preview-inspect', { request: original });
  assert.equal(inspected.result.closed, true);
  assert.equal(inspected.result.frame, undefined);
  assert.equal(
    (
      await replacement.execute('preview-read', {
        ...f.scope,
        clientId: original.clientId,
        previewId: first.previewId,
        view: 'frame',
      })
    ).ok,
    false,
  );
  assert.equal(
    (await replacement.execute('preview-close', { request: original })).result.phase,
    'closed',
  );
  assert.equal((await replacement.execute('preview-action', original)).result.phase, 'closed');
  assert.equal(
    (
      await f.second.execute('preview-read', {
        ...f.scope,
        clientId: 'other-client',
        previewId: second.previewId,
        view: 'frame',
      })
    ).ok,
    true,
  );
  assert.deepEqual(f.state.calls, ['open', 'open']);
});

test('an encrypted catalog move immediately revokes the old preview even without a further preview request', async (t) => {
  const f = await fixture(t),
    original = f.open(),
    opened = (await f.first.execute('preview-action', original)).result;
  await f.move();
  assert.ok(f.state.closed.includes(opened.previewId));
  assert.equal(
    (await f.first.execute('preview-inspect', { request: original })).result.closed,
    true,
  );
  assert.equal(
    (await f.first.execute('preview-close', { request: original })).result.phase,
    'closed',
  );
  assert.equal((await f.first.execute('preview-action', original)).ok, false);
  assert.deepEqual(f.state.calls, ['open']);
});

test('a runtime project generation change immediately revokes the old encrypted preview without a further preview request', async (t) => {
  const f = await fixture(t),
    original = f.open(),
    opened = (await f.first.execute('preview-action', original)).result;
  const project = f.store.machine.get(['localProject', 'project']) as {
    id: string;
    name: string;
    rootPath: string;
  };
  f.store.machine.set(['localProject', 'project'], {
    ...project,
    rootPath: project.rootPath + '-replaced',
  });
  f.store.saveMachine();
  f.host.updateCatalogue();
  assert.ok(f.state.closed.includes(opened.previewId));
  assert.equal((await f.first.execute('preview-inspect', { request: original })).ok, false);
  assert.equal((await f.first.execute('preview-action', original)).ok, false);
  assert.deepEqual(f.state.calls, ['open']);
});

test('an in-flight encrypted open loses its channel before completion and never publishes a late frame or reopens on inspection', async (t) => {
  const f = await fixture(t),
    original = f.open(),
    entered = previewSignal(),
    release = previewSignal();
  f.state.after = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.first.execute('preview-action', original);
  await entered.promise;
  f.first.retire();
  release.resolve();
  await assert.rejects(pending);
  const inspected = (await f.second.execute('preview-inspect', { request: original })).result;
  assert.equal(inspected.closed, true);
  assert.equal(inspected.frame, undefined);
  assert.equal(inspected.phase, 'unknown');
  assert.equal(
    (await f.second.execute('preview-close', { request: original })).result.phase,
    'closed',
  );
  assert.deepEqual(f.state.calls, ['open']);
});

test('a never-arrived preview can inspect and seal the Host-published old mapping without opening any browser', async (t) => {
  const f = await fixture(t),
    original = f.open();
  await f.move();
  const inspected = (await f.first.execute('preview-inspect', { request: original })).result;
  assert.equal(inspected.phase, 'unknown');
  assert.equal(inspected.frame, undefined);
  assert.equal(f.store.journal.has(original.operationId), false);
  assert.equal(
    (await f.first.execute('preview-close', { request: original })).result.phase,
    'closed',
  );
  assert.equal((await f.first.execute('preview-action', original)).ok, false);
  assert.deepEqual(f.state.calls, []);
});

test('the encrypted original preview channel supports the complete finite interaction set with fresh frames', async (t) => {
  const f = await fixture(t),
    original = f.open();
  let receipt = (await f.first.execute('preview-action', original)).result;
  for (const operation of [
    { action: 'click', elementId: 'element' },
    { action: 'input', elementId: 'element', text: 'Synthetic input', replace: true },
    { action: 'key', key: 'Enter' },
    { action: 'scroll', deltaX: 0, deltaY: 100 },
    { action: 'resize', viewport: { width: 800, height: 600 } },
    { action: 'navigate', path: '/synthetic' },
    { action: 'reload' },
  ]) {
    const response = await f.first.execute('preview-action', {
      ...f.scope,
      clientId: original.clientId,
      previewId: receipt.previewId,
      frameId: receipt.frame.frameId,
      operationId: 'finite-' + operation.action,
      confirmed: true,
      ...operation,
    });
    assert.equal(response.ok, true, operation.action);
    assert.equal(response.result.phase, 'accepted', operation.action);
    receipt = response.result;
  }
  const located = await f.first.execute('preview-read', {
    ...f.scope,
    clientId: original.clientId,
    previewId: receipt.previewId,
    view: 'locate',
    frameId: receipt.frame.frameId,
    x: 10,
    y: 10,
  });
  assert.equal(located.ok, true);
  assert.equal(located.result.element.elementId, 'element');
  assert.deepEqual(f.state.calls, [
    'open',
    'click',
    'input',
    'key',
    'scroll',
    'resize',
    'navigate',
    'reload',
  ]);
});
