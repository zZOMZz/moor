import test from 'node:test';
import assert from 'node:assert/strict';
import { LoroDoc, Flock, mirror, putMeta, encode } from '@moor/session/model';
import { BrowserWorkspaceRuntime } from '../../apps/web/src/platform/browser-workspace';
import {
  WorkspaceStore,
  type WorkspaceScope,
} from '../../apps/web/src/features/workspace/workspace-store';
import type { StorageBackend, StorageChange } from '../../apps/web/src/platform/indexed-storage';

class Memory implements StorageBackend {
  values = new Map<string, unknown>();
  async read(key: string) {
    return structuredClone(this.values.get(key) ?? null);
  }
  async exclusive<T>(_key: string, current: () => void, task: () => Promise<T>) {
    current();
    return task();
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    return this.compareAndSetMany([{ key, expected, value }], current);
  }
  async compareAndSetMany(changes: StorageChange[], current: () => void) {
    current();
    for (const change of changes)
      assert.deepEqual(this.values.get(change.key) ?? null, change.expected);
    for (const change of changes) this.values.set(change.key, structuredClone(change.value));
  }
}
function fixture(memory = new Memory(), initialCache = false) {
  const origin = 'https://relay.synthetic.invalid',
    owner = 'owner';
  const actor = { kind: 'relay', accountId: owner, authorityId: 'authority' };
  const agent = { id: 'agent', name: 'Synthetic', cliType: 'custom', agentType: 'synthetic' };
  const runtime = {
    id: 'runtime',
    userId: 'user',
    machineId: 'machine',
    name: 'Host',
    projects: [{ id: 'project', name: 'Project', rootPath: '/synthetic' }],
    agents: [agent],
    features: [],
  };
  const scope: WorkspaceScope = {
    source: 'remote',
    target: {
      serverKey: origin,
      owner,
      deviceId: 'device',
      userId: 'user',
      machineId: 'machine',
      workspaceId: 'runtime',
      localProjectId: 'project',
      catalogWorkspaceId: 'catalog',
      catalogProjectId: 'logical',
      replicaId: 'replica',
    },
  };
  const meta = {
    id: 'session',
    userId: 'user',
    machineId: 'machine',
    project: { kind: 'local', localProjectId: 'project' },
    agentConfigId: 'agent',
    cliType: 'custom',
    agentType: 'synthetic',
    title: 'Synthetic saved session',
  };
  const doc = new LoroDoc(),
    view = mirror(doc, 'session'),
    flock = new Flock();
  view.setState((state) => {
    state.session.id = 'session';
  });
  view.dispose();
  putMeta(flock, 'session-session', meta);
  doc.commit();
  const snapshot = {
    snapshot: encode(doc.export({ mode: 'snapshot' })),
    metaBundle: flock.exportJson(),
    meta,
    agent,
  };
  doc.free();
  const response = {
    ...snapshot,
    update: snapshot.snapshot,
    online: true,
    synced: true,
    persisted: true,
  };
  const state = { offline: false, denied: false, owner, wrongSession: false };
  const calls: Array<{ path: string; method: string }> = [];
  const legacy = new Map<string, unknown>();
  const store = new WorkspaceStore(memory);
  const client = new BrowserWorkspaceRuntime({
    origin,
    owner,
    store,
    initialCache,
    legacyRead: async <T>(key: string) => structuredClone(legacy.get(key)) as T | undefined,
    fetch: async (input, options) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, method: options?.method ?? 'GET' });
      if (state.offline) throw Error('Synthetic disconnected network');
      if (state.denied) return Response.json({ error: 'not signed in' }, { status: 401 });
      const identity = { owner: state.owner, actor: { ...actor, accountId: state.owner } };
      if (path === '/api/workspace-catalog')
        return Response.json({
          version: 1,
          identity,
          workspaces: [
            {
              id: 'catalog',
              name: 'Workspace',
              hosts: [
                {
                  id: 'host',
                  deviceId: 'device',
                  machineId: 'machine',
                  runtimeWorkspaceId: 'runtime',
                  name: 'Host',
                  online: true,
                  agents: [agent],
                },
              ],
              projects: [{ id: 'logical', name: 'Project' }],
              replicas: [
                {
                  id: 'replica',
                  projectId: 'logical',
                  hostId: 'host',
                  localProjectId: 'project',
                  available: true,
                },
              ],
            },
          ],
          devices: [{ id: 'device', name: 'Host', online: true, workspaces: [runtime] }],
        });
      if (path.endsWith('/context')) {
        const { serverKey: _key, ...target } = scope.target;
        return Response.json({
          version: 1,
          identity,
          target,
          runtime,
          mappingVersion: 'a'.repeat(64),
        });
      }
      if (path.endsWith('/sessions/session'))
        return Response.json(
          state.wrongSession ? { ...response, meta: { ...meta, userId: 'foreign' } } : response,
        );
      if (path.endsWith('/sessions')) return Response.json([meta]);
      if (path.endsWith('/agent-options')) return Response.json(agent);
      throw Error('Unexpected synthetic route ' + path);
    },
  });
  return { client, store, memory, scope, state, calls, legacy, snapshot, response };
}
const current = () => {};

test('browser reconnect cache is read-only, and authentication failures never fall back to it', async () => {
  const f = fixture();
  assert.equal(((await f.client.request({ action: 'catalog', source: 'remote' })) as any).ok, true);
  const restored = fixture(f.memory);
  restored.state.offline = true;
  const cached: any = await restored.client.request({ action: 'catalog', source: 'remote' });
  assert.equal(cached.ok, true);
  assert.equal(cached.value.targets[0].online, false);
  assert.equal(restored.client.authenticated, false);
  const calls = restored.calls.length;
  assert.equal(
    (
      (await restored.client.request({
        action: 'execute',
        source: 'remote',
        connectionId: cached.value.connectionId,
        target: { ...restored.scope.target, sessionId: 'session' },
        command: {
          method: 'cancel',
          workspaceId: 'runtime',
          localProjectId: 'project',
          params: { sessionId: 'session', turnId: 'turn' },
        },
      })) as any
    ).ok,
    false,
  );
  assert.equal(restored.calls.length, calls, 'cache cannot dispatch even an explicit command');
  restored.state.offline = false;
  restored.state.denied = true;
  assert.equal(
    ((await restored.client.request({ action: 'catalog', source: 'remote' })) as any).ok,
    false,
  );
  restored.state.denied = false;
  restored.state.owner = 'foreign';
  assert.equal(
    ((await restored.client.request({ action: 'catalog', source: 'remote' })) as any).ok,
    false,
  );
});

test('bootstrap can show a cached directory before network I/O, while every execution remains unauthenticated', async () => {
  const first = fixture();
  await first.client.request({ action: 'catalog', source: 'remote' });
  const restored = fixture(first.memory, true);
  restored.state.denied = true;
  const cached: any = await restored.client.request({ action: 'catalog', source: 'remote' });
  assert.equal(cached.ok, true);
  assert.equal(restored.calls.length, 0);
  assert.equal(restored.client.authenticated, false);
  assert.equal(
    ((await restored.client.request({ action: 'catalog', source: 'remote' })) as any).ok,
    false,
  );
});

test('old browser requests migrate only after the original host confirms the same session and preserve exact bytes without dispatch', async () => {
  const f = fixture(),
    prefix = 'owner/device/runtime/session';
  const pending = {
    operationId: 'old-original',
    workspaceId: 'runtime',
    sessionId: 'session',
    kind: 'turn',
    expectedTurnId: null,
    update: 'AA==',
  };
  f.legacy.set(prefix + '/session', f.snapshot);
  f.legacy.set(prefix + '/draft', 'Old editable draft');
  f.legacy.set(prefix + '/pending', pending);
  const metadata = {
    owner: 'owner',
    deviceId: 'device',
    catalogWorkspaceId: 'catalog',
    replicaId: 'replica',
    request: {
      operationId: 'old-metadata',
      workspaceId: 'runtime',
      localProjectId: 'project',
      sessionId: 'session',
      expectedRevision: 0,
      action: 'rename',
      title: 'Original reviewed title',
    },
  };
  const metadataKey = 'owner/device/runtime/project/session/session-action';
  f.legacy.set(metadataKey, metadata);
  const original = structuredClone(f.legacy);
  await f.client.request({ action: 'catalog', source: 'remote' });
  await f.client.restoreLegacy(f.scope, 'session', current);
  assert.deepEqual((await f.store.operation(f.scope, pending.operationId, current))?.original, {
    kind: 'mutation',
    value: pending,
  });
  assert.deepEqual(
    (await f.store.operation(f.scope, metadata.request.operationId, current))?.original,
    { kind: 'metadata', value: metadata.request },
  );
  assert.equal((await f.store.readDraft(f.scope, 'session', current)).text, 'Old editable draft');
  assert.deepEqual(f.legacy, original);
  assert(f.calls.every((call) => call.method === 'GET'));
  const revision = (await f.store.read(f.scope, current)).revision;
  await f.client.restoreLegacy(f.scope, 'session', current);
  assert.equal((await f.store.read(f.scope, current)).revision, revision);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/sessions/session')).length, 1);
  for (const field of ['owner', 'deviceId', 'catalogWorkspaceId', 'replicaId']) {
    const other = fixture();
    other.legacy.set(prefix + '/session', other.snapshot);
    other.legacy.set(metadataKey, { ...metadata, [field]: 'different' });
    const retained = structuredClone(other.legacy);
    await other.client.request({ action: 'catalog', source: 'remote' });
    await assert.rejects(other.client.restoreLegacy(other.scope, 'session', current));
    assert.equal((await other.store.read(other.scope, current)).operations.length, 0);
    assert.deepEqual(other.legacy, retained);
    assert(other.calls.every((call) => call.method === 'GET'));
  }
});

test('foreign and unsupported old records remain in their original database with no new dispatchable operation', async () => {
  for (const kind of ['foreign', 'unsupported']) {
    const f = fixture(),
      prefix = 'owner/device/runtime/session';
    f.legacy.set(prefix + '/session', f.snapshot);
    f.legacy.set(
      prefix + '/pending',
      kind === 'foreign'
        ? {
            operationId: 'old',
            workspaceId: 'runtime',
            sessionId: 'session',
            kind: 'turn',
            expectedTurnId: null,
            update: 'AA==',
          }
        : { previewDraftVersion: 1, mutation: { operationId: 'old' } },
    );
    f.state.wrongSession = kind === 'foreign';
    const original = structuredClone(f.legacy);
    await f.client.request({ action: 'catalog', source: 'remote' });
    await assert.rejects(f.client.restoreLegacy(f.scope, 'session', current));
    assert.deepEqual(f.legacy, original);
    assert.equal((await f.store.read(f.scope, current)).operations.length, 0);
    assert(f.calls.every((call) => call.method === 'GET'));
  }
});
