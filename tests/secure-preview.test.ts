import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import type { PreviewDriver } from '../src/runtime/preview-driver';
import {
  previewReadSchema,
  previewActionSchema,
  previewInspectSchema,
  previewCloseSchema,
  type PreviewViewport,
} from '../src/preview-protocol';
import {
  SecurePreviewAnnotations,
  SecurePreviewController,
  type SecurePreviewContext,
  type SecurePreviewMethod,
} from '../src/web/secure-preview';
import {
  SecureStore,
  type SecureStorageBackend,
  secureBrowserRequestVersion,
} from '../src/web/secure-store';
import { SecureScopedStorage } from '../src/web/secure-scoped-storage';
import { SecureMcp } from '../src/web/secure-mcp';
import {
  secureOperationSchema,
  secureOperationDigestSource,
  type SecureCliTarget,
} from '../src/cli/secure-operation';
import { CliState } from '../src/cli/state';
import { hostCommandSchema } from '../src/bridge/host-command';
import {
  previewFrame,
  previewVersion,
  previewViewport,
  previewSignal,
} from './support/preview-fixture';
import { syntheticCapabilities } from './support/agent-capabilities';

const target: SecureCliTarget = {
  origin: 'https://relay.synthetic.invalid',
  owner: 'owner',
  rootKeyId: 'A'.repeat(43),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'workspace',
  localProjectId: 'project',
  userId: 'local-user',
  machineId: 'machine',
  sessionId: 'session',
  product: { catalogWorkspaceId: 'space', projectId: 'product', replicaId: 'replica', revision: 1 },
};
const now = '2026-09-12T00:00:00.000Z';
class Memory implements SecureStorageBackend {
  values = new Map<string, unknown>();
  queues = new Map<string, Promise<void>>();
  beforeWrite?: () => Promise<void>;
  queued?: (key: string) => void;
  async read(key: string) {
    return structuredClone(this.values.get(key) ?? null);
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    await this.beforeWrite?.();
    current();
    assert.deepEqual(this.values.get(key) ?? null, expected);
    this.values.set(key, structuredClone(value));
  }
  async exclusive<T>(key: string, current: () => void, work: () => Promise<T>) {
    const prior = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((done) => {
      release = done;
    });
    this.queues.set(key, tail);
    this.queued?.(key);
    try {
      await prior;
      current();
      return await work();
    } finally {
      release();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }
}
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-secure-preview-'))),
    project = join(root, 'project');
  mkdirSync(project);
  const runtime = new RuntimeStore(join(root, 'host.sqlite')),
    projectId = runtime.registerProject(project);
  runtime.registerAgent('synthetic', {
    id: 'agent',
    name: 'Synthetic',
    machineId: runtime.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/not-run', args: [] },
  });
  const calls: string[] = [],
    closed: string[] = [],
    timers = new Map<number, () => void>();
  let timerId = 0,
    sequence = 0,
    agentOpens = 0;
  const viewports = new Map<string, PreviewViewport>(),
    paths = new Map<string, string>();
  const controls = {
    valid: true,
    before: undefined as undefined | (() => Promise<void>),
    after: undefined as undefined | (() => Promise<void>),
    lose: undefined as undefined | SecurePreviewMethod,
    transform: undefined as undefined | ((value: unknown) => unknown),
  };
  const frame = (id: string) => ({
    ...previewFrame(id, 'frame-' + ++sequence, viewports.get(id) ?? previewViewport),
    path: paths.get(id) ?? '/',
  });
  const driver: PreviewDriver = {
    async available() {
      return { available: true };
    },
    async open(binding, guard) {
      await controls.before?.();
      guard.assertCurrent();
      guard.beforeDispatch!();
      calls.push('open');
      viewports.set(binding.previewId, binding.viewport);
      await controls.after?.();
      guard.assertCurrent();
      return frame(binding.previewId);
    },
    async capture(id, guard) {
      await controls.before?.();
      guard.assertCurrent();
      calls.push('capture');
      return frame(id);
    },
    async locate(_id, frameId, point, guard) {
      guard.assertCurrent();
      calls.push('locate');
      return {
        elementId: 'element-' + frameId,
        frameId,
        tag: 'input',
        role: 'textbox',
        name: 'Synthetic <script>unsafe()</script>',
        text: 'SYNTHETIC_PRIVATE_PAGE_TEXT',
        rect: { x: point.x, y: point.y, width: 20, height: 20 },
        editable: true,
        password: false,
      };
    },
    async interact(request, guard) {
      await controls.before?.();
      guard.assertCurrent();
      guard.beforeDispatch!();
      calls.push(request.action);
      if (request.action === 'resize') viewports.set(request.previewId, request.viewport);
      if (request.action === 'navigate') paths.set(request.previewId, request.path);
      await controls.after?.();
      guard.assertCurrent();
      return frame(request.previewId);
    },
    async close(id) {
      closed.push(id);
    },
    async closeAll() {},
  };
  const service = {
    id: 'service',
    label: 'Synthetic preview',
    version: previewVersion,
    startPath: '/',
    origin: 'http://127.0.0.1:12345',
    localProjectId: projectId,
    executionId: 'shared',
    rootIdentity: previewVersion,
    projectRootIdentity: previewVersion,
  };
  const host = new HostWorkspace(
    runtime,
    {
      async open() {
        agentOpens++;
        return {
          id: 'synthetic-native',
          capabilities: syntheticCapabilities,
          async prompt() {},
          async cancel() {},
          close() {},
        };
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
        getServices: () =>
          controls.valid
            ? [
                {
                  id: service.id,
                  label: service.label,
                  version: service.version,
                  startPath: service.startPath,
                },
              ]
            : [],
        getService: () => (controls.valid ? service : undefined),
        isCurrent: () => controls.valid,
      },
      now: () => Date.parse(now),
      schedule: () => () => {},
    },
  );
  const fullTarget = {
    ...target,
    workspaceId: runtime.workspace.id,
    localProjectId: projectId,
    userId: runtime.workspace.userId,
    machineId: runtime.workspace.machineId,
  };
  const memory = new Memory(),
    store = new SecureStore(memory),
    storage = new SecureScopedStorage(store),
    annotations = new SecurePreviewAnnotations(store, storage);
  let context: SecurePreviewContext = {
    target: structuredClone(fullTarget),
    online: true,
    generation: 1,
  };
  const requests: { target: SecureCliTarget; method: SecurePreviewMethod; params: unknown }[] = [],
    images: unknown[] = [];
  const controller = new SecurePreviewController({
    context: () => context,
    storage,
    annotations,
    request: async (destination, method, params, current) => {
      current();
      requests.push(structuredClone({ target: destination, method, params }));
      let value: unknown;
      if (method === 'preview-read')
        value = await host.readPreview(previewReadSchema.parse(params), projectId);
      else if (method === 'preview-action')
        value = await host.previewAction(previewActionSchema.parse(params), projectId);
      else if (method === 'preview-inspect')
        value = await host.inspectPreview(previewInspectSchema.parse(params), projectId);
      else value = await host.closePreview(previewCloseSchema.parse(params), projectId);
      if (controls.lose === method) {
        controls.lose = undefined;
        throw Error('Synthetic lost receipt');
      }
      current();
      return controls.transform?.(value) ?? value;
    },
    addImage: async (destination, item, current) => {
      current();
      images.push(structuredClone({ target: destination, item }));
    },
    schedule: (ms, work) => {
      assert.equal(ms, 12000);
      const id = ++timerId;
      timers.set(id, () => {
        timers.delete(id);
        work();
      });
      return () => {
        timers.delete(id);
      };
    },
  });
  t.after(async () => {
    await controller.dismiss();
    host.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const review = () => controller.state!.review;
  return {
    root,
    host,
    runtime,
    store,
    memory,
    storage,
    annotations,
    controller,
    controls,
    calls,
    closed,
    timers,
    requests,
    images,
    target: fullTarget,
    review,
    context: () => context,
    setContext: (value: SecurePreviewContext) => {
      context = value;
    },
    agentOpens: () => agentOpens,
    async connect() {
      await controller.open(fullTarget);
      await controller.action(review(), { connect: 'service', viewport: previewViewport });
    },
    async locate() {
      await controller.action(review(), { locate: { x: 20, y: 20 } });
    },
  };
}
test('trusted preview supports explicit service connection, screenshots, element lookup and every bounded interaction without Agent startup', async (t) => {
  const f = fixture(t);
  assert.equal(f.requests.length, 0);
  await f.connect();
  assert.equal(f.calls[0], 'open');
  assert.equal(f.controller.state!.controller.frame!.viewport.width, 390);
  await f.controller.action(f.review(), 'capture');
  await f.locate();
  await f.controller.action(f.review(), {
    interact: { action: 'input', text: 'Synthetic input', replace: true },
  });
  await f.locate();
  await f.controller.action(f.review(), { interact: { action: 'click' } });
  for (const interact of [
    { action: 'key', key: 'Enter' },
    { action: 'scroll', deltaX: 0, deltaY: 500 },
    { action: 'resize', viewport: { width: 768, height: 1024 } },
    { action: 'navigate', path: '/settings' },
    { action: 'reload' },
  ] as const)
    await f.controller.action(f.review(), { interact });
  assert.deepEqual(f.calls, [
    'open',
    'capture',
    'locate',
    'input',
    'locate',
    'click',
    'key',
    'scroll',
    'resize',
    'navigate',
    'reload',
  ]);
  for (const request of f.requests) assert.deepEqual(request.target, f.target);
  assert.equal(f.agentOpens(), 0);
  assert.equal(f.timers.size, 1);
  const heartbeatDone = previewSignal();
  const stopWatching = f.controller.subscribe(() => {
    const last = f.requests.at(-1);
    if (
      last?.method === 'preview-read' &&
      (last.params as { view?: string }).view === 'status' &&
      !f.controller.state?.controller.busy
    )
      heartbeatDone.resolve();
  });
  [...f.timers.values()][0]();
  await heartbeatDone.promise;
  stopWatching();
  assert.equal(
    (f.requests.at(-1)!.params as { view: string }).view,
    'status',
    'keepalive reads only status without recapturing or replaying interactions',
  );
  await f.controller.action(f.review(), 'close');
  assert.equal(f.controller.state!.controller.openRequest, undefined);
  assert.equal(f.timers.size, 0);
  assert.equal(f.closed.length, 1);
});
test('frozen annotation create/select/edit/image/remove all remain local and preserve reviewed versions', async (t) => {
  const f = fixture(t);
  await f.connect();
  await f.locate();
  const requests = f.requests.length;
  await f.controller.save(f.review(), 'Synthetic note <img src=x>', true);
  let item = f.controller.state!.annotations!.items[0];
  assert(item.snapshot.image);
  assert.equal(item.selectionId, undefined);
  await f.controller.select(f.review(), item.id, true);
  item = f.controller.state!.annotations!.items[0];
  assert(item.selectionId);
  await f.controller.image(f.review(), item.id);
  assert.deepEqual(f.images, [{ target: f.target, item }]);
  await f.controller.edit(f.review(), item.id, 'Edited note');
  const edited = f.controller.state!.annotations!.items[0];
  assert.notEqual(edited.version, item.version);
  assert.equal(edited.selectionId, undefined);
  await f.controller.remove(f.review(), item.id);
  assert.equal(f.controller.state!.annotations!.items.length, 0);
  assert.equal(f.requests.length, requests);
  assert.equal(f.agentOpens(), 0);
});
test('dropped interaction acceptance persists one original request; reopen never replays and inspect cannot restore a live frame', async (t) => {
  const f = fixture(t);
  await f.connect();
  await f.locate();
  f.controls.lose = 'preview-action';
  await assert.rejects(
    f.controller.action(f.review(), { interact: { action: 'click' } }),
    /lost receipt/,
  );
  const pending = structuredClone(f.controller.state!.controller.pending);
  assert.equal(pending!.action, 'click');
  assert.equal(f.timers.size, 0);
  f.setContext({ ...f.context(), online: false, generation: 2 });
  f.controller.sync();
  assert.equal(f.controller.state, null);
  const before = f.requests.length;
  f.setContext({ ...f.context(), online: true, generation: 3 });
  f.controller.sync();
  assert.equal(f.requests.length, before);
  await f.controller.open(f.target);
  assert.deepEqual(f.controller.state!.controller.pending, pending);
  assert.equal(f.calls.filter((call) => call === 'click').length, 1);
  await f.controller.action(f.review(), 'inspect');
  assert.equal(f.controller.state!.controller.pending, undefined);
  assert.equal(f.controller.state!.controller.frame, undefined);
  assert.equal(f.calls.filter((call) => call === 'click').length, 1);
});
test('closing while an interaction is in flight hides the panel, freezes closure and never resends that action', async (t) => {
  const f = fixture(t);
  await f.connect();
  await f.locate();
  const entered = previewSignal(),
    release = previewSignal();
  f.controls.after = async () => {
    entered.resolve();
    await release.promise;
  };
  const clicking = f.controller.action(f.review(), { interact: { action: 'click' } }),
    rejected = assert.rejects(clicking);
  await entered.promise;
  const closing = f.controller.dismiss();
  assert.equal(f.controller.state, null);
  await closing;
  release.resolve();
  await rejected;
  assert.equal(f.calls.filter((call) => call === 'click').length, 1);
  assert.equal(f.closed.length, 1);
  assert.equal(f.timers.size, 0);
  const records = await f.storage.list(f.target, () => {}),
    record = records.find((record) => record.key.startsWith('project-preview-v1/'))!;
  assert.equal(record.value.open, undefined);
  assert.equal(record.value.uncertainClosed, true);
});
test('rendered frame, element and service snapshots cannot silently bind to newer content', async (t) => {
  const f = fixture(t);
  await f.connect();
  await f.locate();
  const old = f.review();
  await f.controller.action(f.review(), 'capture');
  const count = f.requests.length;
  await assert.rejects(f.controller.action(old, { interact: { action: 'click' } }), /已改变/);
  assert.equal(f.requests.length, count);
  await assert.rejects(f.controller.save(old, 'Unreviewed late annotation', false), /已改变/);
  assert.equal((await f.annotations.read(f.target, () => {})).length, 0);
  await f.controller.action(f.review(), 'close');
  await f.controller.action(f.review(), 'options');
  const serviceReview = f.review();
  f.controller.state!.controller.options!.services[0].label = 'Different rendering';
  await assert.rejects(
    f.controller.action(serviceReview, { connect: 'service', viewport: previewViewport }),
    /已改变/,
  );
});
test('selection or connection ABA during image verification cannot reveal a frame or append a late annotation', async (t) => {
  const f = fixture(t);
  await f.connect();
  const digest = crypto.subtle.digest.bind(crypto.subtle),
    entered = previewSignal(),
    release = previewSignal();
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<typeof digest>) => {
    const bytes = await digest(...args);
    entered.resolve();
    await release.promise;
    return bytes;
  });
  const capturing = f.controller.action(f.review(), 'capture'),
    rejected = assert.rejects(capturing);
  await entered.promise;
  f.setContext({ ...f.context(), generation: 3 });
  assert.equal(f.controller.state, null);
  f.controller.sync();
  release.resolve();
  await rejected;
  assert.equal(f.timers.size, 0);
  assert.equal(f.agentOpens(), 0);
});
test('all complete target dimensions isolate stored annotations and invalidate visible preview content', async (t) => {
  const f = fixture(t);
  await f.connect();
  await f.locate();
  await f.controller.save(f.review(), 'Bound annotation', false);
  const original = f.context();
  const changed: SecureCliTarget[] = [
    ...(
      [
        'owner',
        'clientDeviceId',
        'hostDeviceId',
        'workspaceId',
        'localProjectId',
        'userId',
        'machineId',
        'sessionId',
      ] as const
    ).map((field) => ({ ...f.target, [field]: 'other' })),
    { ...f.target, origin: 'https://other.synthetic.invalid' },
    { ...f.target, rootKeyId: Buffer.alloc(32, 2).toString('base64url') },
    ...(['catalogWorkspaceId', 'projectId', 'replicaId'] as const).map((field) => ({
      ...f.target,
      product: { ...f.target.product!, [field]: 'other' },
    })),
    { ...f.target, product: { ...f.target.product!, revision: 2 } },
  ];
  for (const target of changed) {
    f.setContext({ ...original, target });
    assert.equal(f.controller.state, null);
    assert.equal((await f.annotations.read(target, () => {})).length, 0);
  }
  f.setContext(original);
  assert(f.controller.state);
});
test('old mapping pending preview records remain discoverable and can only be inspected or closed under original scope', async (t) => {
  const f = fixture(t);
  f.controls.lose = 'preview-action';
  await f.controller.open(f.target);
  await assert.rejects(
    f.controller.action(f.review(), { connect: 'service', viewport: previewViewport }),
  );
  const oldOpen = structuredClone(f.controller.state!.controller.openRequest!);
  const changed = { ...f.target, product: { ...f.target.product!, revision: 2 } };
  f.setContext({ target: changed, online: true, generation: 2 });
  f.controller.sync();
  await f.controller.open(changed);
  const record = f.controller.state!.recoveries[0];
  assert.deepEqual(record.target, f.target);
  assert.deepEqual(record.pending, oldOpen);
  const before = f.requests.length;
  await f.controller.recover(f.review(), record, 'inspect');
  assert.equal(f.requests[before].method, 'preview-inspect');
  assert.deepEqual(f.requests[before].target, f.target);
  assert.equal(f.calls.filter((value) => value === 'open').length, 1);
  await f.controller.recover(f.review(), f.controller.state!.recoveries[0], 'close');
  assert.equal(f.controller.state!.recoveries.length, 0);
  assert.equal(f.closed.length, 1);
});

test('full annotation review is frozen in a real original turn and acceptance consumes only its original selected versions', async (t) => {
  const f = fixture(t);
  await f.connect();
  await f.locate();
  await f.controller.save(f.review(), 'First reviewed note', true);
  let item = f.controller.state!.annotations!.items[0];
  await f.controller.select(f.review(), item.id, true);
  await f.controller.save(f.review(), 'Second reviewed note', false);
  const second = f.controller.state!.annotations!.items[1];
  await f.controller.select(f.review(), second.id, true);
  const shown = [...f.controller.state!.annotations!.selected];
  const scope = {
    workspaceId: f.target.workspaceId,
    localProjectId: f.target.localProjectId,
    sessionId: f.target.sessionId,
    machineId: f.target.machineId,
    userId: f.target.userId,
  };
  await f.host.controlManager.control({
    ...scope,
    controlVersion: 1,
    action: 'create',
    operationId: 'create',
    agentId: 'agent',
  });
  const mcp = new SecureMcp(f.store),
    draft = await mcp.read(f.target, () => {}),
    read = await f.host.read(f.target.sessionId, undefined, f.target.localProjectId);
  const original = await f.annotations.withReview(
    f.target,
    shown,
    'Synthetic user prompt',
    () => {},
    ({ prompt, previewReview }) =>
      mcp.stageTurn(
        f.target,
        draft,
        {
          scope,
          read,
          agent: f.host.workspace.agents[0],
          prompt,
          operationId: 'send',
          turnId: 'user-send',
          peerId: 'abcdef12',
          now,
        },
        () => {},
        undefined,
        previewReview,
      ),
  );
  assert.deepEqual(original.previewReview!.annotations, shown);
  assert.equal(original.userTurnId, 'user-send');
  const cold = new SecurePreviewAnnotations(new SecureStore(f.memory));
  await assert.rejects(
    cold.validate(f.target, shown, () => {}),
    /核查原指令/,
  );
  const selected = await f.annotations.read(f.target, () => {});
  await f.annotations.change(
    f.target,
    selected,
    () => {},
    async (store) => {
      await store.select(item.id, false);
      await store.select(item.id, true);
    },
  );
  const reselection = (await f.annotations.read(f.target, () => {}))[0];
  assert.notEqual(reselection.selectionId, shown[0].selectionId);
  const command = hostCommandSchema.parse(JSON.parse(original.body));
  if (command.method !== 'mutate') throw Error();
  const receipt = await f.host.mutate(command.params, f.target.localProjectId);
  await f.host.active.get(f.target.sessionId)?.done;
  await f.store.transition(original, ['pending'], 'accepted', receipt, () => {});
  assert.equal(
    (await cold.read(f.target, () => {}))[0].selectionId,
    reselection.selectionId,
    'new selection survives old acceptance',
  );
  assert.equal(
    (await cold.read(f.target, () => {}))[1].selectionId,
    undefined,
    'unchanged original selection is consumed',
  );
  const cli = new CliState(join(f.root, 'cli'));
  t.after(() => cli.close());
  assert.equal(
    cli.secureStage(
      {
        operationId: original.operationId,
        kind: 'turn',
        target: original.target,
        body: original.body,
        userTurnId: original.userTurnId,
        previewReview: original.previewReview,
      },
      now,
    ).requestVersion,
    original.requestVersion,
  );
  const changed = structuredClone(original);
  changed.previewReview!.annotations[0].snapshot.note = 'Changed review';
  assert.notEqual(await secureBrowserRequestVersion(changed), original.requestVersion);
  assert.equal(secureOperationSchema.safeParse({ ...original, kind: 'permission' }).success, false);
  assert.equal(
    secureOperationSchema.safeParse({ ...original, userTurnId: undefined }).success,
    false,
  );
  const { previewReview: _review, ...legacy } = original;
  assert.notEqual(secureOperationDigestSource(legacy), secureOperationDigestSource(original));
});
test('annotation selection changes before send are rejected before staging and image-save CAS aborts on panel close', async (t) => {
  const f = fixture(t);
  await f.connect();
  await f.locate();
  await f.controller.save(f.review(), 'Persisted annotation', false);
  const item = f.controller.state!.annotations!.items[0];
  await f.controller.select(f.review(), item.id, true);
  const shown = [...f.controller.state!.annotations!.selected];
  await f.annotations.change(
    f.target,
    await f.annotations.read(f.target, () => {}),
    () => {},
    (store) => store.select(item.id, false),
  );
  await assert.rejects(
    f.annotations.validate(f.target, shown, () => {}),
    /已改变/,
  );
  let staged = false;
  await assert.rejects(
    f.annotations.withReview(
      f.target,
      shown,
      'Prompt',
      () => {},
      async () => {
        staged = true;
      },
    ),
    /已改变/,
  );
  assert.equal(staged, false);
  await f.controller.open(f.target);
  await f.controller.action(f.review(), { connect: 'service', viewport: previewViewport });
  await f.locate();
  const entered = previewSignal(),
    release = previewSignal();
  f.memory.beforeWrite = async () => {
    entered.resolve();
    await release.promise;
  };
  const saving = f.controller.save(f.review(), 'Must not save after closure', true),
    rejected = assert.rejects(saving);
  await entered.promise;
  const closing = f.controller.dismiss();
  f.memory.beforeWrite = undefined;
  release.resolve();
  await Promise.all([closing, rejected]);
  assert.equal((await f.annotations.read(f.target, () => {})).length, 1);
});

test('annotation-to-MCP staging holds the reviewed selection until the original turn is durable while a second page waits', async (t) => {
  const f = fixture(t);
  await f.connect();
  await f.locate();
  await f.controller.save(f.review(), 'Frozen concurrent annotation', false);
  const item = f.controller.state!.annotations!.items[0];
  await f.controller.select(f.review(), item.id, true);
  const shown = [...f.controller.state!.annotations!.selected],
    items = await f.annotations.read(f.target, () => {});
  const scope = {
    workspaceId: f.target.workspaceId,
    localProjectId: f.target.localProjectId,
    sessionId: f.target.sessionId,
    userId: f.target.userId,
    machineId: f.target.machineId,
  };
  await f.host.controlManager.control({
    ...scope,
    controlVersion: 1,
    action: 'create',
    operationId: 'create',
    agentId: 'agent',
  });
  const mcp = new SecureMcp(f.store),
    draft = await mcp.read(f.target, () => {}),
    read = await f.host.read(f.target.sessionId, undefined, f.target.localProjectId);
  const entered = previewSignal(),
    release = previewSignal(),
    queued = previewSignal();
  let edited = false;
  const staging = f.annotations.withReview(
    f.target,
    shown,
    'Original prompt',
    () => {},
    async ({ prompt, previewReview }) => {
      entered.resolve();
      await release.promise;
      return mcp.stageTurn(
        f.target,
        draft,
        {
          scope,
          read,
          agent: f.host.workspace.agents[0],
          prompt,
          operationId: 'original',
          turnId: 'original-user',
          peerId: 'abcdef12',
          now,
        },
        () => {},
        undefined,
        previewReview,
      );
    },
  );
  await entered.promise;
  f.memory.queued = (key) => {
    if (key.includes('preview-annotations')) queued.resolve();
  };
  const otherPage = new SecurePreviewAnnotations(new SecureStore(f.memory));
  const editing = otherPage.change(
    f.target,
    items,
    () => {},
    async (store) => {
      await store.save({ ...item.snapshot, note: 'Later page edit' }, item.id);
      edited = true;
    },
  );
  await queued.promise;
  assert.equal(edited, false);
  release.resolve();
  const original = await staging;
  await editing;
  assert.deepEqual(original.previewReview!.annotations, shown);
  assert.equal(original.userTurnId, 'original-user');
  assert.equal((await f.store.list(f.target))[0].operationId, 'original');
  const changed = (await f.annotations.read(f.target, () => {}))[0];
  assert.equal(changed.snapshot.note, 'Later page edit');
  assert.equal(changed.selectionId, undefined);
  assert.equal(f.agentOpens(), 0, 'staging and local edits never execute an Agent');
});
