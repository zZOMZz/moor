import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { HostCommandDispatcher } from '../src/bridge/host-command';
import { RuntimeStore } from '../src/runtime/store';
import { SecureWorkspaceController } from '../src/web/secure-controller';
import { SecureStore, type SecureStorageBackend } from '../src/web/secure-store';
import {
  desktopSecureStatusSchema,
  type DesktopSecureRequest,
} from '../src/security/desktop-client-protocol';
import { encryptedCatalogSchema } from '../src/security/encrypted-bridge-protocol';
import type { AgentCallbacks } from '../src/runtime/agent';
import { PERMISSION_REVIEW_FEATURE } from '../src/permission-review';
import { SecureAttachments } from '../src/web/secure-attachments';
import { syntheticCapabilities } from './support/agent-capabilities';
import { LoroDoc, decode, delta, mirror } from '../src/model';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
class TestOperationLocks {
  queues = new Map<string, Promise<void>>();
  queued?: (key: string) => void;
  async exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(key, tail);
    this.queued?.(key);
    try {
      await prior;
      current();
      return await task();
    } finally {
      release();
      if (this.queues.get(key) === tail) this.queues.delete(key);
    }
  }
}
class Memory implements SecureStorageBackend {
  constructor(
    readonly locks: TestOperationLocks = new TestOperationLocks(),
    readonly values = new Map<string, unknown>(),
  ) {}
  exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T> {
    return this.locks.exclusive(key, current, task);
  }
  readHook?: () => void;
  async read(key: string) {
    this.readHook?.();
    return structuredClone(this.values.get(key) ?? null);
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    current();
    assert.deepEqual(this.values.get(key) ?? null, expected);
    this.values.set(key, structuredClone(value));
  }
}
async function fixture(t: TestContext, uuid?: () => string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-secure-controller-'))),
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
    customAcp: { command: '/synthetic/never-run', args: [] },
  });
  const started = signal(),
    completion = signal();
  let prompts = 0,
    cancels = 0;
  let callbacks!: AgentCallbacks;
  const host = new HostWorkspace(
    runtime,
    {
      open: async (_agent, _cwd, _nativeId, cb) => {
        callbacks = cb;
        return {
          id: 'synthetic-native',
          capabilities: syntheticCapabilities,
          prompt: async () => {
            prompts++;
            started.resolve();
            await completion.promise;
          },
          cancel: async () => {
            cancels++;
            completion.resolve();
          },
          close: () => completion.resolve(),
        };
      },
    },
    () => {},
    () => {},
  );
  const dispatcher = new HostCommandDispatcher({
    ready: () => true,
    workspace: (id) => (id === host.workspace.id ? host : undefined),
    hasOperation: () => false,
  });
  const digest = Buffer.alloc(32, 1).toString('base64url');
  const pin = {
    serverOrigin: 'https://relay.synthetic.invalid',
    accountId: 'owner',
    rootKeyId: digest,
  };
  let status = desktopSecureStatusSchema.parse({
    device: {
      phase: 'active',
      revision: 1,
      pin,
      deviceId: 'client',
      roles: ['client'],
      trustEpoch: 1,
      pending: null,
      trust: null,
      devices: [],
    },
    connecting: false,
    connection: null,
  });
  const descriptor = {
    deviceId: 'host',
    keyId: digest,
    rootKeyId: digest,
    trustEpoch: 1,
    trustDigest: digest,
    hostChallenge: digest,
  };
  const products = {
    version: 1,
    authority: { ...pin, hostDeviceId: 'host' },
    revision: 1,
    workspaces: [{ id: 'space', name: 'Synthetic space' }],
    projects: [
      { id: 'product', workspaceId: 'space', name: 'Synthetic project', source: { kind: 'local' } },
    ],
    replicas: [
      {
        id: 'replica',
        catalogWorkspaceId: 'space',
        projectId: 'product',
        revision: 1,
        runtimeWorkspaceId: host.workspace.id,
        localProjectId: projectId,
        machineId: host.workspace.machineId,
        userId: host.workspace.userId,
        available: true,
      },
    ],
  };
  const memory = new Memory(),
    store = new SecureStore(memory),
    requests: DesktopSecureRequest[] = [];
  const fault: {
    loseMutation?: boolean;
    replaceActive?: boolean;
    before?: (input: DesktopSecureRequest) => Promise<void>;
    wrongAuthority?: boolean;
    omitPermissionFeature?: boolean;
    losePermissionBefore?: boolean;
    transformRead?: (value: unknown) => unknown;
  } = {};
  let account: { origin: string; owner: string } | null = {
    origin: pin.serverOrigin,
    owner: pin.accountId,
  };
  const request = async (input: DesktopSecureRequest) => {
    requests.push(structuredClone(input));
    await fault.before?.(input);
    if (input.action === 'status') return { ok: true, value: status };
    if (input.action === 'connect') {
      status = desktopSecureStatusSchema.parse({
        ...status,
        connection: {
          connectionId: crypto.randomUUID(),
          phase: 'connected',
          hosts: [descriptor],
          verified: false,
        },
      });
      return { ok: true, value: status };
    }
    if (input.action === 'disconnect') {
      status = { ...status, connection: null };
      return { ok: true, value: status };
    }
    if (input.action === 'catalog')
      return {
        ok: true,
        value: encryptedCatalogSchema.parse({
          catalogVersion: 2,
          machineId: host.workspace.machineId,
          workspaces: [
            fault.omitPermissionFeature
              ? {
                  ...host.workspace,
                  features: host.workspace.features?.filter(
                    (feature) => feature !== PERMISSION_REVIEW_FEATURE,
                  ),
                }
              : host.workspace,
          ],
          products: fault.wrongAuthority
            ? { ...products, authority: { ...products.authority, accountId: 'other' } }
            : products,
        }),
      };
    if (input.action !== 'execute') throw Error('unexpected action');
    if (
      input.command.method === 'mutate' &&
      input.command.params.kind === 'permission' &&
      fault.losePermissionBefore
    )
      return {
        ok: false,
        error: {
          code: 'unavailable',
          message: 'Synthetic lost before dispatch',
          status: null,
          rejected: false,
        },
      };
    let value: unknown;
    try {
      value = await dispatcher.execute(input.command);
    } catch (error) {
      const failure = dispatcher.error(input.command, error);
      return {
        ok: false,
        error: {
          code: 'host',
          message: failure.message,
          status: failure.status,
          rejected: failure.rejected,
        },
      };
    }
    if (input.command.method === 'session' && fault.transformRead)
      return { ok: true, value: fault.transformRead(value) };
    if (input.command.method === 'mutate' && fault.loseMutation)
      return {
        ok: false,
        error: {
          code: 'unavailable',
          message: 'Synthetic lost response',
          status: null,
          rejected: false,
        },
      };
    if (input.command.method === 'session' && fault.replaceActive) {
      const raw = structuredClone(value) as { update: string };
      const doc = new LoroDoc();
      doc.import(decode(raw.update));
      const view = mirror(doc, input.command.params.sessionId);
      view.setState((state) => {
        for (const turn of state.history)
          if (turn.role === 'assistant' && !turn.finished) turn.id = 'replacement-active';
      });
      doc.commit();
      raw.update = delta(doc);
      view.dispose();
      doc.free();
      return { ok: true, value: raw };
    }
    return { ok: true, value };
  };
  const controller = new SecureWorkspaceController({
    request,
    store,
    account: () => account,
    ...(uuid ? { uuid } : {}),
  });
  t.after(() => {
    completion.resolve();
    controller.close();
    host.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  const ready = async () => {
    await controller.refreshStatus();
    await controller.connect();
    await controller.selectHost('host');
    await controller.selectReplica('replica');
  };
  const create = async () => {
    await controller.createSession('agent', 'Synthetic session');
    await controller.refreshSessions();
    assert.equal(controller.state.sessions.length, 1);
    await controller.openSession(controller.state.sessions[0].id);
  };
  return {
    controller,
    project,
    request,
    store,
    memory,
    requests,
    fault,
    products,
    ready,
    create,
    started,
    update: (value: unknown) => callbacks.update(value),
    permission: (
      toolCall: Record<string, unknown> = {
        toolCallId: 'tool-1',
        title: 'Synthetic edit',
        rawInput: { path: 'synthetic.txt', content: 'reviewed' },
      },
    ) =>
      callbacks.permission({
        toolCall,
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Reject once', kind: 'reject_once' },
        ],
      }),
    prompts: () => prompts,
    cancels: () => cancels,
    account: (value: typeof account) => {
      account = value;
    },
  };
}

test('content requests read the selected Host scope and never accept a mutation or foreign target', async (t) => {
  const f = await fixture(t);
  assert.equal(f.controller.contentContext.target, null);
  await f.ready();
  await f.create();
  writeFileSync(join(f.project, 'synthetic.txt'), 'Synthetic encrypted content\n');
  const context = f.controller.contentContext,
    target = context.target!;
  assert.equal(context.online, true);
  const params = {
    contentVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    path: 'synthetic.txt',
  };
  const file = (await f.controller.contentRequest(target, 'file-content', params)) as any;
  assert.equal(Buffer.from(file.data, 'base64').toString(), 'Synthetic encrypted content\n');
  const count = f.requests.length;
  await assert.rejects(f.controller.contentRequest(target, 'mutate' as any, params));
  await assert.rejects(
    f.controller.contentRequest(
      { ...target, rootKeyId: 'sha256:' + 'f'.repeat(64) },
      'file-content',
      params,
    ),
  );
  await assert.rejects(
    f.controller.contentRequest(target, 'file-content', { ...params, sessionId: 'other-session' }),
  );
  assert.equal(f.requests.length, count, 'bad requests never reach main IPC');
  await f.controller.disconnect();
  const offline = f.controller.contentContext;
  assert.deepEqual(offline.target, target);
  assert.equal(offline.online, false);
  assert(offline.generation > context.generation);
  await assert.rejects(f.controller.contentRequest(target, 'file-content', params));
  f.account(null);
  assert.equal(f.controller.contentContext.target, null);
});

test('a pending content read cannot return after the selected session document is invalidated', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  writeFileSync(join(f.project, 'synthetic.txt'), 'Synthetic delayed content\n');
  const target = f.controller.contentContext.target!,
    entered = signal(),
    release = signal();
  f.fault.before = async (input) => {
    if (input.action === 'execute' && input.command.method === 'file-content') {
      entered.resolve();
      await release.promise;
    }
  };
  const reading = f.controller.contentRequest(target, 'file-content', {
    contentVersion: 1,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    path: 'synthetic.txt',
  });
  const rejected = assert.rejects(reading);
  await entered.promise;
  f.controller.invalidate();
  release.resolve();
  await rejected;
  assert.equal(f.controller.contentContext.target, null);
});

test('a render-time empty attachment review cannot send attachments loaded after that render', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  const shown = {
    target: f.controller.contentContext.target!,
    attachments: f.controller.state.attachmentDraft,
  };
  const otherPage = new SecureAttachments(f.store);
  await otherPage.addFiles(
    shown.target,
    [],
    [new File(['Synthetic unseen attachment'], 'unreviewed.txt', { type: 'text/plain' })],
    () => {},
  );
  await f.controller.refreshOperations();
  assert.equal(f.controller.state.attachmentDraft.length, 1);
  const count = f.requests.length;
  await assert.rejects(f.controller.send('Synthetic reviewed prompt', shown), /已审阅/);
  assert.equal(f.requests.length, count);
  assert.equal(f.prompts(), 0);
  assert(f.controller.state.operations.every((operation) => operation.kind === 'create'));
});

test('a render-time send target cannot be moved to a later selected session', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  const shown = { target: f.controller.contentContext.target!, attachments: [] };
  await f.controller.createSession('agent', 'Other synthetic session');
  await f.controller.refreshSessions();
  await f.controller.openSession(
    f.controller.state.sessions.find((session) => session.id !== shown.target.sessionId)!.id,
  );
  const count = f.requests.length;
  await assert.rejects(f.controller.send('Synthetic old target prompt', shown), /发送目标/);
  assert.equal(f.requests.length, count);
  assert.equal(f.prompts(), 0);
});

test('explicit desktop workflow uses actual Host receipts and CRDT for create, rename, send and exact stop', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  assert.equal(f.controller.state.operations[0].state, 'accepted');
  await f.controller.metadata('rename', 'Renamed synthetic session');
  await f.controller.refreshSession();
  assert.equal(f.controller.state.session?.meta.title, 'Renamed synthetic session');
  await f.controller.saveDraft('A deterministic synthetic prompt');
  await f.controller.send('A deterministic synthetic prompt');
  await f.started.promise;
  assert.equal(f.prompts(), 1);
  assert.equal(f.controller.state.draft, '');
  await f.controller.refreshSession();
  const shown = f.controller.state.session!.history.find(
    (turn) => turn.role === 'assistant' && !turn.finished,
  )!;
  assert(shown);
  await f.controller.stop();
  const stop = f.controller.state.operations.find((operation) => operation.kind === 'stop')!;
  assert.equal(JSON.parse(stop.body).params.turnId, shown.id);
  assert.equal((stop.receipt as { confirmed: boolean }).confirmed, true);
  assert.equal(f.cancels(), 1);
});

test('lost reply stays pending across controller restart; explicit inspect confirms original once without replay', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  await f.controller.saveDraft('Keep this draft');
  f.fault.loseMutation = true;
  await f.controller.send('Keep this draft');
  await f.started.promise;
  const op = f.controller.state.operations.find((operation) => operation.kind === 'turn')!;
  assert.equal(op.state, 'pending');
  assert.equal(f.controller.state.draft, 'Keep this draft');
  const count = f.requests.length;
  f.controller.close();
  const restored = new SecureWorkspaceController({
    request: f.request,
    store: new SecureStore(f.memory),
    account: () => ({ origin: 'https://relay.synthetic.invalid', owner: 'owner' }),
  });
  t.after(() => restored.close());
  await restored.refreshStatus();
  assert.deepEqual(
    f.requests.slice(count).map((request) => request.action),
    ['status'],
  );
  assert.equal(restored.state.session, null);
  assert.equal(
    restored.state.operations.find((entry) => entry.operationId === op.operationId)?.state,
    'pending',
  );
  await restored.selectHost('host');
  await restored.recover(op.operationId, 'inspect');
  assert.equal(
    restored.state.operations.find((entry) => entry.operationId === op.operationId)?.state,
    'accepted',
  );
  assert.equal(f.prompts(), 1);
});

test('pending retries keep the original mapping revision after a catalog change', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  f.fault.loseMutation = true;
  await f.controller.send('One original');
  await f.started.promise;
  const original = f.controller.state.operations.find((operation) => operation.kind === 'turn')!;
  f.products.replicas[0].revision = 2;
  f.products.revision = 2;
  await f.controller.selectHost('host');
  await f.controller.recover(original.operationId, 'retry');
  const retried = f.requests.filter(
    (request) => request.action === 'execute' && request.command.method === 'mutate',
  );
  assert.equal(retried.length, 2);
  assert.deepEqual(
    (retried[1] as Extract<DesktopSecureRequest, { action: 'execute' }>).target,
    original.target.product,
  );
  assert.equal(
    JSON.stringify((retried[1] as Extract<DesktopSecureRequest, { action: 'execute' }>).command),
    original.body,
  );
  assert.equal(f.prompts(), 1);
});

test('stop refuses a replacement active turn that the user has not seen', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  await f.controller.send('Start original');
  await f.started.promise;
  await f.controller.refreshSession();
  f.fault.replaceActive = true;
  await assert.rejects(f.controller.stop(), /活动回合已改变/);
  assert.equal(f.cancels(), 0);
  assert(!f.controller.state.operations.some((operation) => operation.kind === 'stop'));
});

test('selection and account invalidation suppress late reads and expose no prior account ledger', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  const entered = signal(),
    finish = signal();
  f.fault.before = async (request) => {
    if (request.action === 'execute' && request.command.method === 'session') {
      entered.resolve();
      await finish.promise;
    }
  };
  const pending = f.controller.refreshSession();
  await entered.promise;
  f.controller.invalidate();
  finish.resolve();
  await assert.rejects(pending, /选择已改变/);
  assert.equal(f.controller.state.session, null);
  assert.deepEqual(f.controller.state.operations, []);
  f.account({ origin: 'https://relay.synthetic.invalid', owner: 'other' });
  let storageReads = 0;
  f.memory.readHook = () => {
    storageReads++;
  };
  await assert.rejects(f.controller.refreshStatus(), /账号/);
  assert.equal(storageReads, 0);
  assert.deepEqual(f.controller.state.operations, []);
});

test('catalog must carry exact account/root/host authority before offering a product', async (t) => {
  const f = await fixture(t);
  await f.controller.refreshStatus();
  await f.controller.connect();
  f.fault.wrongAuthority = true;
  await assert.rejects(f.controller.selectHost('host'), /主机产品目录/);
  assert.equal(f.controller.state.catalog, null);
});

test('completed original ID collisions never dispatch a second create', async (t) => {
  let ids = 0;
  const f = await fixture(t, () => (++ids % 2 === 1 ? 'synthetic-session' : 'synthetic-operation'));
  await f.ready();
  await f.create();
  await assert.rejects(
    f.controller.createSession('agent', 'Synthetic session'),
    /原操作编号已完成/,
  );
  assert.equal(
    f.requests.filter(
      (request) => request.action === 'execute' && request.command.method === 'session-control',
    ).length,
    1,
  );
});

test('a concurrent sealing transition immediately before dispatch prevents sending stale pending bytes', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  let reads = 0;
  f.memory.readHook = () => {
    for (const value of f.memory.values.values()) {
      if (value && typeof value === 'object' && 'operations' in value) {
        const ledger = value as {
          revision: number;
          operations: Array<{ kind: string; state: string }>;
        };
        const pending = ledger.operations.find(
          (entry) => entry.kind === 'turn' && entry.state === 'pending',
        );
        if (pending && ++reads === 2) {
          pending.state = 'ending';
          ledger.revision++;
        }
      }
    }
  };
  await f.controller.send('Do not send after sealing');
  assert(
    !f.requests.some(
      (request) => request.action === 'execute' && request.command.method === 'mutate',
    ),
  );
  assert.equal(
    f.controller.state.operations.find((operation) => operation.kind === 'turn')?.state,
    'ending',
  );
});

test('explicit disconnect preserves a frozen local draft and never sends it on reconnect', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  const sessionId = f.controller.state.session!.meta.id;
  await f.controller.saveDraft('Before disconnect');
  await f.controller.disconnect();
  assert.equal(f.controller.state.session?.meta.id, sessionId);
  assert.equal(f.controller.state.status?.connection, null);
  await f.controller.saveDraft('Edited offline');
  await assert.rejects(f.controller.send('Edited offline'), /显式连接/);
  const count = f.requests.length;
  await f.controller.connect();
  await f.controller.selectHost('host');
  await f.controller.selectReplica('replica');
  await f.controller.openSession(sessionId);
  assert.equal(f.controller.state.draft, 'Edited offline');
  assert(
    !f.requests
      .slice(count)
      .some((request) => request.action === 'execute' && request.command.method === 'mutate'),
  );
});

test('account callback changes suppress a late session read without relying on a UI invalidation event', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  const entered = signal(),
    finish = signal();
  f.fault.before = async (request) => {
    if (request.action === 'execute' && request.command.method === 'session') {
      entered.resolve();
      await finish.promise;
    }
  };
  const pending = f.controller.refreshSession();
  await entered.promise;
  f.account(null);
  finish.resolve();
  await assert.rejects(pending, /账号/);
  assert.equal(f.controller.state.session, null);
});

test('controller dispatch snapshot cannot be overtaken by another store committing ending', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.create();
  const entered = signal(),
    release = signal(),
    queued = signal();
  const read = f.memory.read.bind(f.memory);
  const exclusive = f.memory.exclusive.bind(f.memory);
  let dispatchLockHeld = false;
  f.memory.exclusive = (key, current, task) =>
    exclusive(key, current, async () => {
      dispatchLockHeld = true;
      try {
        return await task();
      } finally {
        dispatchLockHeld = false;
      }
    });
  let paused = false;
  f.memory.read = async (key) => {
    const snapshot = await read(key);
    if (
      snapshot &&
      typeof snapshot === 'object' &&
      'operations' in snapshot &&
      (snapshot as { operations: Array<{ kind: string; state: string }> }).operations.some(
        (entry) => entry.kind === 'turn' && entry.state === 'pending',
      ) &&
      dispatchLockHeld &&
      !paused
    ) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return snapshot;
  };
  const events: string[] = [];
  f.fault.before = async (request) => {
    if (request.action === 'execute' && request.command.method === 'mutate')
      events.push('dispatch');
  };
  const sending = f.controller.send('Synthetic digest race');
  await entered.promise;
  const original = f.controller.state.operations.find((operation) => operation.kind === 'turn')!;
  f.memory.locks.queued = () => queued.resolve();
  const ending = new SecureStore(new Memory(f.memory.locks, f.memory.values))
    .transition(original, ['pending'], 'ending', undefined, () => {})
    .then(() => {
      events.push('ending');
    });
  await queued.promise;
  assert.deepEqual(events, []);
  release.resolve();
  await sending;
  await ending;
  assert.deepEqual(events, ['dispatch', 'ending']);
  assert.equal(
    f.controller.state.operations.find(
      (operation) => operation.operationId === original.operationId,
    )?.state,
    'ending',
  );
});

async function waitingPermission(f: Awaited<ReturnType<typeof fixture>>) {
  await f.ready();
  await f.create();
  await f.controller.send('Start synthetic permission run');
  await f.started.promise;
  const outcome = f.permission();
  await f.controller.refreshSession();
  assert.equal(f.controller.state.permissionReviews.length, 1);
  return { outcome, review: f.controller.state.permissionReviews[0] };
}

test('desktop permission delivers only the reviewed request through actual Host CRDT and leaves other same-tool requests pending', async (t) => {
  const f = await fixture(t),
    first = await waitingPermission(f);
  const second = f.permission();
  await f.controller.refreshSession();
  assert.equal(f.controller.state.permissionReviews.length, 2);
  await f.controller.respondPermission(first.review, { outcome: 'selected', optionId: 'allow' });
  assert.deepEqual(await first.outcome, { outcome: { outcome: 'selected', optionId: 'allow' } });
  await f.controller.refreshSession();
  assert.equal(f.controller.state.permissionReviews.length, 1);
  assert.notEqual(
    f.controller.state.permissionReviews[0].request.requestId,
    first.review.request.requestId,
  );
  await f.controller.respondPermission(f.controller.state.permissionReviews[0], {
    outcome: 'cancelled',
  });
  assert.deepEqual(await second, { outcome: { outcome: 'cancelled' } });
  const operations = f.controller.state.operations.filter(
    (operation) => operation.kind === 'permission',
  );
  assert.equal(operations.length, 2);
  assert(operations.every((operation) => operation.state === 'accepted'));
  assert.equal(
    JSON.parse(operations[1].body).params.expectedTurnId,
    first.review.request.expectedUserTurnId,
  );
  assert.notEqual(first.review.request.expectedUserTurnId, first.review.request.assistantTurnId);
  assert.equal(f.prompts(), 1);
});

for (const changed of ['assistant', 'request', 'options', 'rawInput', 'outcome'] as const)
  test(`desktop permission refuses ${changed} changed between render and fresh read`, async (t) => {
    const f = await fixture(t),
      waiting = await waitingPermission(f);
    f.fault.transformRead = (value) => {
      const raw = structuredClone(value) as { update: string },
        doc = new LoroDoc();
      doc.import(decode(raw.update));
      const view = mirror(doc, waiting.review.target.sessionId);
      view.setState((state) => {
        const turn = state.history.find(
          (entry) => entry.id === waiting.review.request.assistantTurnId,
        )!;
        const item = turn.items!.find(
          (entry: any) => entry.permissionRequest?.requestId === waiting.review.request.requestId,
        ) as any;
        if (changed === 'assistant') turn.id = 'unseen-assistant';
        else if (changed === 'request') item.permissionRequest.requestId = 'unseen-request';
        else if (changed === 'options') item.permissionRequest.options[0].name = 'Changed meaning';
        else if (changed === 'rawInput') item.rawInput = { path: 'different.txt' };
        else item.permissionRequest.outcome = { outcome: 'selected', optionId: 'deny' };
      });
      doc.commit();
      raw.update = delta(doc);
      view.dispose();
      doc.free();
      return raw;
    };
    await assert.rejects(
      f.controller.respondPermission(waiting.review, { outcome: 'selected', optionId: 'allow' }),
      /审批.*改变/,
    );
    assert(!f.controller.state.operations.some((operation) => operation.kind === 'permission'));
    assert(
      !f.requests.some(
        (request) =>
          request.action === 'execute' &&
          request.command.method === 'mutate' &&
          request.command.params.kind === 'permission',
      ),
    );
  });

test('an old rendered permission snapshot cannot silently adopt newer controller details', async (t) => {
  const f = await fixture(t),
    waiting = await waitingPermission(f);
  const changed = structuredClone(waiting.review);
  changed.request.itemJson = changed.request.itemJson.replace('reviewed', 'unreviewed');
  await assert.rejects(
    f.controller.respondPermission(changed, { outcome: 'selected', optionId: 'allow' }),
    /审批.*改变/,
  );
  const before = f.requests.length;
  await assert.rejects(
    f.controller.respondPermission(
      { ...waiting.review, target: { ...waiting.review.target, hostDeviceId: 'other-host' } },
      { outcome: 'cancelled' },
    ),
    /审批.*改变/,
  );
  assert.equal(f.requests.length, before);
});

test('lost permission receipt retries only original bytes and inspect confirms the same choice once', async (t) => {
  const f = await fixture(t),
    waiting = await waitingPermission(f);
  f.fault.loseMutation = true;
  await f.controller.respondPermission(waiting.review, { outcome: 'selected', optionId: 'allow' });
  assert.deepEqual(await waiting.outcome, { outcome: { outcome: 'selected', optionId: 'allow' } });
  const original = f.controller.state.operations.find(
    (operation) => operation.kind === 'permission',
  )!;
  assert.equal(original.state, 'pending');
  f.products.revision = 2;
  f.products.replicas[0].revision = 2;
  await f.controller.selectHost('host');
  f.fault.loseMutation = false;
  await f.controller.recover(original.operationId, 'retry');
  const sent = f.requests.filter(
    (request) =>
      request.action === 'execute' &&
      request.command.method === 'mutate' &&
      request.command.params.kind === 'permission',
  ) as Array<Extract<DesktopSecureRequest, { action: 'execute' }>>;
  assert.equal(sent.length, 2);
  assert.equal(JSON.stringify(sent[1].command), original.body);
  assert.deepEqual(sent[1].target, original.target.product);
  await f.controller.recover(original.operationId, 'inspect');
  assert.equal(
    f.controller.state.operations.find(
      (operation) => operation.operationId === original.operationId,
    )?.state,
    'accepted',
  );
  assert.equal(f.prompts(), 1);
});

test('sealing a lost approval submission leaves the Agent request waiting until an explicit cancellation is delivered', async (t) => {
  const f = await fixture(t),
    waiting = await waitingPermission(f);
  let settled = false;
  void waiting.outcome.then(() => {
    settled = true;
  });
  f.fault.losePermissionBefore = true;
  await f.controller.respondPermission(waiting.review, { outcome: 'selected', optionId: 'allow' });
  const original = f.controller.state.operations.find(
    (operation) => operation.kind === 'permission',
  )!;
  assert.equal(original.state, 'pending');
  await f.controller.recover(original.operationId, 'abandon');
  assert.equal(
    f.controller.state.operations.find(
      (operation) => operation.operationId === original.operationId,
    )?.state,
    'abandoned',
  );
  await f.controller.refreshSession();
  assert.equal(f.controller.state.permissionReviews.length, 1);
  assert.equal(settled, false);
  f.fault.losePermissionBefore = false;
  await f.controller.respondPermission(f.controller.state.permissionReviews[0], {
    outcome: 'cancelled',
  });
  assert.deepEqual(await waiting.outcome, { outcome: { outcome: 'cancelled' } });
});

test('offline approval and a pending original never dispatch a new decision on reconnect', async (t) => {
  const f = await fixture(t),
    waiting = await waitingPermission(f);
  await f.controller.disconnect();
  await assert.rejects(
    f.controller.respondPermission(waiting.review, { outcome: 'selected', optionId: 'allow' }),
    /显式连接/,
  );
  const before = f.requests.length;
  await f.controller.connect();
  assert.deepEqual(
    f.requests.slice(before).map((request) => request.action),
    ['connect'],
  );
  await f.controller.selectHost('host');
  await f.controller.selectReplica('replica');
  await f.controller.openSession(waiting.review.target.sessionId);
  f.fault.losePermissionBefore = true;
  await f.controller.respondPermission(f.controller.state.permissionReviews[0], {
    outcome: 'selected',
    optionId: 'allow',
  });
  await assert.rejects(
    f.controller.respondPermission(f.controller.state.permissionReviews[0], {
      outcome: 'cancelled',
    }),
    /先核查/,
  );
  assert.equal(
    f.requests.filter(
      (request) =>
        request.action === 'execute' &&
        request.command.method === 'mutate' &&
        request.command.params.kind === 'permission',
    ).length,
    1,
  );
});

test('rendered old details are rejected before any Host read after controller has read newer same-ID details', async (t) => {
  const f = await fixture(t),
    waiting = await waitingPermission(f);
  f.fault.transformRead = (value) => {
    const raw = structuredClone(value) as { update: string },
      doc = new LoroDoc();
    doc.import(decode(raw.update));
    const view = mirror(doc, waiting.review.target.sessionId);
    view.setState((state) => {
      const turn = state.history.find(
        (entry) => entry.id === waiting.review.request.assistantTurnId,
      )!;
      const item = turn.items!.find(
        (entry: any) => entry.permissionRequest?.requestId === waiting.review.request.requestId,
      ) as any;
      item.rawInput = { path: 'newly-rendered.txt', content: 'different operation' };
    });
    doc.commit();
    raw.update = delta(doc);
    view.dispose();
    doc.free();
    return raw;
  };
  await f.controller.refreshSession();
  assert.notEqual(
    f.controller.state.permissionReviews[0].request.itemJson,
    waiting.review.request.itemJson,
  );
  const before = f.requests.length;
  await assert.rejects(
    f.controller.respondPermission(waiting.review, { outcome: 'selected', optionId: 'allow' }),
    /审批.*改变/,
  );
  assert.equal(f.requests.length, before);
});

test('account loss during approval fresh-read cannot stage or dispatch the reviewed decision', async (t) => {
  const f = await fixture(t),
    waiting = await waitingPermission(f),
    entered = signal(),
    release = signal();
  f.fault.before = async (request) => {
    if (request.action === 'execute' && request.command.method === 'session') {
      entered.resolve();
      await release.promise;
    }
  };
  const approving = f.controller.respondPermission(waiting.review, {
    outcome: 'selected',
    optionId: 'allow',
  });
  const rejected = assert.rejects(approving, /账号/);
  await entered.promise;
  f.account(null);
  release.resolve();
  await rejected;
  assert(!f.controller.state.operations.some((operation) => operation.kind === 'permission'));
  assert(
    !f.requests.some(
      (request) =>
        request.action === 'execute' &&
        request.command.method === 'mutate' &&
        request.command.params.kind === 'permission',
    ),
  );
});

test('Host rejects a permission whose tool input changes after the final read and before actual mutation', async (t) => {
  const f = await fixture(t),
    waiting = await waitingPermission(f);
  let settled = false,
    changes = 0;
  void waiting.outcome.then(() => {
    settled = true;
  });
  f.fault.before = async (request) => {
    if (
      request.action === 'execute' &&
      request.command.method === 'mutate' &&
      request.command.params.kind === 'permission'
    ) {
      changes++;
      f.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'Changed after review',
        rawInput: { path: 'UNREVIEWED.txt', content: 'unreviewed input' },
      });
    }
  };
  await f.controller.respondPermission(waiting.review, { outcome: 'selected', optionId: 'allow' });
  assert.equal(changes, 1);
  const original = f.controller.state.operations.find(
    (operation) => operation.kind === 'permission',
  )!;
  assert.equal(original.state, 'rejected');
  assert.equal(settled, false);
  const binding = JSON.parse(original.body).params.permissionReview;
  assert.deepEqual(binding, {
    version: 1,
    assistantTurnId: waiting.review.request.assistantTurnId,
    itemJson: waiting.review.request.itemJson,
  });
  await f.controller.refreshSession();
  const current = f.controller.state.permissionReviews[0];
  assert.equal(JSON.parse(current.request.itemJson).rawInput.path, 'UNREVIEWED.txt');
  assert.notEqual(current.request.itemJson, waiting.review.request.itemJson);
  f.fault.before = undefined;
  await f.controller.respondPermission(current, { outcome: 'cancelled' });
  assert.deepEqual(await waiting.outcome, { outcome: { outcome: 'cancelled' } });
});

test('a Host without exact permission-review capability remains readable but cannot receive an approval', async (t) => {
  const f = await fixture(t),
    waiting = await waitingPermission(f);
  f.fault.omitPermissionFeature = true;
  await f.controller.selectHost('host');
  await f.controller.selectReplica('replica');
  await f.controller.openSession(waiting.review.target.sessionId);
  assert(f.controller.state.session);
  assert.deepEqual(f.controller.state.permissionReviews, []);
  assert.match(f.controller.state.notice!, /主机尚不支持精确审批/);
  const before = f.requests.length;
  await assert.rejects(
    f.controller.respondPermission(waiting.review, { outcome: 'selected', optionId: 'allow' }),
    /主机尚不支持精确审批/,
  );
  assert.equal(f.requests.length, before);
  assert(!f.controller.state.operations.some((operation) => operation.kind === 'permission'));
});

for (const action of ['inspect', 'retry', 'abandon'] as const)
  test(`permission ${action} refuses a downgraded Host without sending or rewriting its original binding`, async (t) => {
    const f = await fixture(t),
      waiting = await waitingPermission(f);
    f.fault.losePermissionBefore = true;
    await f.controller.respondPermission(waiting.review, {
      outcome: 'selected',
      optionId: 'allow',
    });
    const original = f.controller.state.operations.find(
      (operation) => operation.kind === 'permission',
    )!;
    assert.equal(original.state, 'pending');
    f.fault.omitPermissionFeature = true;
    await f.controller.selectHost('host');
    const before = f.requests.length;
    await assert.rejects(
      f.controller.recover(original.operationId, action),
      /主机尚不支持精确审批/,
    );
    assert.equal(f.requests.length, before);
    assert.deepEqual(
      f.controller.state.operations.find(
        (operation) => operation.operationId === original.operationId,
      ),
      original,
    );
  });
