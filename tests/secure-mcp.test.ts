import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureMcp, type SecureMcpDraft, type SecureMcpTurnInput } from '../src/web/secure-mcp';
import {
  SecureStore,
  secureBrowserRequestVersion,
  type SecureStorageBackend,
} from '../src/web/secure-store';
import {
  secureOperationSchema,
  secureOriginal,
  type SecureCliTarget,
  type SecureMcpReview,
} from '../src/cli/secure-operation';
import { CliState } from '../src/cli/state';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { hostCommandSchema } from '../src/bridge/host-command';
import { readClientSession } from '../src/session-client';
import { productCanonicalJson } from '../src/security/encrypted-product-catalog';
import { type McpReadResult, type McpServerView } from '../src/mcp-protocol';
import { syntheticCapabilities } from './support/agent-capabilities';
import type { AgentOpenOptions } from '../src/runtime/agent';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Memory implements SecureStorageBackend {
  values = new Map<string, unknown>();
  locks = new Map<string, Promise<void>>();
  beforeRead?: (key: string) => Promise<void>;
  beforeWrite?: (key: string) => Promise<void>;
  queued?: (key: string) => void;
  async read(key: string) {
    await this.beforeRead?.(key);
    return structuredClone(this.values.get(key) ?? null);
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    await this.beforeWrite?.(key);
    current();
    assert.deepEqual(this.values.get(key) ?? null, expected, 'CAS conflict');
    this.values.set(key, structuredClone(value));
  }
  async exclusive<T>(key: string, current: () => void, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const release = signal();
    this.locks.set(key, release.promise);
    this.queued?.(key);
    await previous;
    try {
      current();
      return await task();
    } finally {
      release.resolve();
      if (this.locks.get(key) === release.promise) this.locks.delete(key);
    }
  }
}
const target: SecureCliTarget = {
  origin: 'https://relay.synthetic.invalid',
  owner: 'owner',
  rootKeyId: Buffer.alloc(32, 1).toString('base64url'),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'workspace',
  localProjectId: 'project',
  userId: 'local-user',
  machineId: 'machine',
  sessionId: 'session',
  product: {
    catalogWorkspaceId: 'catalog',
    projectId: 'product',
    replicaId: 'replica',
    revision: 1,
  },
};
const server: McpServerView = {
  id: 'mcp-version-1',
  name: 'Synthetic MCP',
  description: 'Synthetic project tools',
  transport: 'http',
};
const second: McpServerView = { ...server, id: 'mcp-version-2', name: 'Other MCP' };
const current = () => {};
const now = '2026-09-13T00:00:00.000Z';
function catalog(t = target, servers = [server, second]): McpReadResult {
  return {
    mcpVersion: 1,
    confirmed: true,
    workspaceId: t.workspaceId,
    localProjectId: t.localProjectId,
    sessionId: t.sessionId,
    catalogRevision: 1,
    servers,
  };
}
function setup() {
  const memory = new Memory(),
    store = new SecureStore(memory);
  let id = 0;
  return { memory, store, mcp: new SecureMcp(store, { uuid: () => `review-${++id}` }) };
}
async function select(f: ReturnType<typeof setup>, servers = [server], t = target) {
  return f.mcp.apply(
    t,
    await f.mcp.read(t, current),
    servers,
    { online: true, catalog: catalog(t) },
    current,
  );
}
function fakeTurn(t: SecureCliTarget, review: SecureMcpReview, operationId = 'original') {
  return {
    operationId,
    kind: 'turn' as const,
    target: structuredClone(t),
    mcpReview: structuredClone(review),
    body: JSON.stringify({
      method: 'mutate',
      workspaceId: t.workspaceId,
      localProjectId: t.localProjectId,
      params: {
        kind: 'turn',
        operationId,
        workspaceId: t.workspaceId,
        sessionId: t.sessionId,
        expectedTurnId: null,
        update: 'c3ludGhldGlj',
        metaBundle: {},
      },
    }),
  };
}
async function fixture(t: TestContext) {
  const f = setup(),
    root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-secure-mcp-'))),
    projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  const runtime = new RuntimeStore(join(root, 'private', 'host.sqlite')),
    projectId = runtime.registerProject(projectRoot);
  const agent = runtime.registerAgent('synthetic', {
    id: 'agent',
    name: 'Synthetic',
    machineId: runtime.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/never-run', args: [] },
  });
  const options: Array<AgentOpenOptions | undefined> = [];
  let prompts = 0,
    started = signal(),
    completed = signal();
  const host = new HostWorkspace(
    runtime,
    {
      async open(_agent, _cwd, _native, _callbacks, input) {
        options.push(input);
        return {
          id: 'synthetic-native',
          capabilities: syntheticCapabilities,
          async prompt() {
            prompts++;
            started.resolve();
            await completed.promise;
          },
          async cancel() {
            completed.resolve();
          },
          close() {
            completed.resolve();
          },
        };
      },
    },
    () => {},
    () => {},
  );
  const scope = {
    workspaceId: runtime.workspace.id,
    localProjectId: projectId,
    sessionId: 'session',
    userId: runtime.workspace.userId,
    machineId: runtime.workspace.machineId,
  };
  const fullTarget = { ...target, ...scope };
  await host.controlManager.control(
    { ...scope, controlVersion: 1, operationId: 'create', action: 'create', agentId: agent.id },
    projectId,
  );
  const config = await host.mcpSettings.handle({
    action: 'save',
    expectedRevision: 0,
    name: 'Synthetic MCP',
    description: 'Explicit synthetic metadata',
    projectIds: [projectId],
    enabled: true,
    connection: {
      transport: 'http',
      url: 'https://synthetic.invalid/mcp',
      headers: { Authorization: 'Bearer SYNTHETIC_PRIVATE_MCP_TOKEN' },
    },
  });
  const preset = config.presets[0]!;
  const calls: unknown[] = [];
  const request = async (
    destination: SecureCliTarget,
    query: Parameters<HostWorkspace['readMcp']>[0],
  ) => {
    assert.deepEqual(destination, fullTarget);
    calls.push(structuredClone(query));
    return host.readMcp(query, projectId);
  };
  const authority = {
    serverOrigin: target.origin,
    ownerId: target.owner,
    deviceId: target.hostDeviceId,
    current,
  };
  t.after(async () => {
    completed.resolve();
    await Promise.allSettled([...host.active.values()].map((run) => run.done));
    host.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    ...f,
    host,
    runtime,
    target: fullTarget,
    root,
    projectId,
    preset,
    scope,
    request,
    calls,
    options,
    authority,
    get prompts() {
      return prompts;
    },
    get started() {
      return started.promise;
    },
    async finish() {
      const run = host.active.get(scope.sessionId);
      completed.resolve();
      await run?.done;
      started = signal();
      completed = signal();
    },
    async input(operationId = 'turn'): Promise<SecureMcpTurnInput> {
      return {
        scope,
        read: await host.read(scope.sessionId, undefined, projectId),
        agent: host.workspace.agents[0]!,
        prompt: 'Synthetic explicit instruction',
        operationId,
        turnId: `user-${operationId}`,
        peerId: 'abcd1234',
        now,
      };
    },
    async select() {
      const list = await f.mcp.readCatalog(fullTarget, current, request);
      return f.mcp.apply(
        fullTarget,
        await f.mcp.read(fullTarget, current),
        list.servers,
        { online: true, catalog: list },
        current,
      );
    },
  };
}

test('explicit host metadata reads and local selection start neither Agent nor MCP and expose no private configuration', async (t) => {
  const f = await fixture(t);
  assert.equal(f.calls.length, 0);
  const draft = await f.select();
  assert.equal(f.calls.length, 1);
  assert.equal(f.options.length, 0);
  assert.equal(f.prompts, 0);
  assert.equal(draft.review?.servers[0].id, f.preset.versionId);
  assert.doesNotMatch(
    JSON.stringify([...f.memory.values.values(), draft]),
    /SYNTHETIC_PRIVATE_MCP_TOKEN|Authorization|synthetic\.invalid\/mcp/,
  );
  assert.deepEqual(await new SecureMcp(new SecureStore(f.memory)).read(f.target, current), draft);
  assert.deepEqual(await f.store.list(f.target), []);
});

test('original turn freezes MCP review; dropped acceptance recovers exact body once and next turn gets no inherited MCP', async (t) => {
  const f = await fixture(t),
    draft = await f.select(),
    input = await f.input();
  await f.mcp.validateBeforeSend(f.target, draft, current, f.request);
  const original = await f.mcp.stageTurn(f.target, draft, input, current, f.request);
  assert.deepEqual(original.mcpReview, draft.review);
  assert.equal(original.userTurnId, input.turnId);
  assert.equal(f.options.length, 0);
  const command = hostCommandSchema.parse(JSON.parse(original.body));
  assert.equal(command.method, 'mutate');
  if (command.method !== 'mutate') throw Error();
  const accepted = await f.host.mutate(command.params, f.projectId, f.authority);
  await f.started;
  assert.equal(f.prompts, 1);
  assert.equal(f.options[0]?.mcp?.servers.length, 1);
  await f.finish();
  const cold = new SecureMcp(new SecureStore(f.memory));
  assert.equal((await cold.read(f.target, current)).delivery?.operationId, original.operationId);
  assert.equal(f.prompts, 1);
  assert.deepEqual((await f.store.list(f.target))[0], original);
  await f.host.mcpSettings.handle({
    action: 'enabled',
    expectedRevision: f.host.mcpSettings.read().revision,
    id: f.preset.id,
    enabled: false,
  });
  const retry = await f.store.dispatch(original, current, async (fixed) => {
    assert.deepEqual(fixed, original);
    const body = hostCommandSchema.parse(JSON.parse(fixed.body));
    if (body.method !== 'mutate') throw Error();
    return f.host.mutate(body.params, f.projectId, f.authority);
  });
  assert.deepEqual(retry, accepted);
  assert.equal(f.prompts, 1);
  await f.store.transition(original, ['pending'], 'accepted', retry, current);
  const empty = await cold.read(f.target, current);
  assert.equal(empty.review, undefined);
  assert.equal(empty.delivery, undefined);
  const reads = f.calls.length;
  const next = await cold.stageTurn(f.target, empty, await f.input('next'), current);
  assert.equal(f.calls.length, reads);
  assert.equal(next.mcpReview, undefined);
  const nextCommand = hostCommandSchema.parse(JSON.parse(next.body));
  if (nextCommand.method !== 'mutate') throw Error();
  await f.host.mutate(nextCommand.params, f.projectId, f.authority);
  await f.started;
  assert.equal(f.options[1]?.mcp, undefined);
  assert.equal(f.prompts, 2);
  await f.finish();
  const history = readClientSession(
    await f.host.read(f.scope.sessionId, undefined, f.projectId),
    f.scope,
  ).history;
  assert.deepEqual(
    (history.find((turn) => turn.id === input.turnId)?.inputConfig as { mcpServerIds: string[] })
      .mcpServerIds,
    [f.preset.versionId],
  );
  assert.deepEqual(
    (history.find((turn) => turn.id === 'user-next')?.inputConfig as { mcpServerIds: string[] })
      .mcpServerIds,
    [],
  );
});

test('fresh send validation rejects revoked versions before staging or executing and never substitutes a new version', async (t) => {
  const f = await fixture(t),
    draft = await f.select();
  await f.host.mcpSettings.handle({
    action: 'enabled',
    expectedRevision: f.host.mcpSettings.read().revision,
    id: f.preset.id,
    enabled: false,
  });
  await assert.rejects(
    f.mcp.validateBeforeSend(f.target, draft, current, f.request),
    /原版本已不可用/,
  );
  await assert.rejects(
    f.mcp.stageTurn(f.target, draft, await f.input(), current, f.request),
    /原版本已不可用/,
  );
  assert.deepEqual(await f.store.list(f.target), []);
  assert.equal(f.prompts, 0);
  assert.deepEqual(await f.mcp.read(f.target, current), draft);
});

test('old rendered empty review cannot authorize an unseen selection', async (t) => {
  const f = await fixture(t),
    empty = await f.mcp.read(f.target, current);
  await f.select();
  const calls = f.calls.length;
  await assert.rejects(f.mcp.validateBeforeSend(f.target, empty, current, f.request), /草稿已改变/);
  await assert.rejects(
    f.mcp.stageTurn(f.target, empty, await f.input(), current, f.request),
    /草稿已改变/,
  );
  assert.equal(f.calls.length, calls);
  assert.deepEqual(await f.store.list(f.target), []);
  assert.equal(f.prompts, 0);
});

test('accepted original consumes only its exact review and preserves a newer explicit selection', async () => {
  const f = setup(),
    draft = await select(f),
    original = await f.store.stage(fakeTurn(target, draft.review!), now, current);
  const pending = await f.mcp.read(target, current);
  assert.equal(pending.delivery?.state, 'pending');
  const next = await f.mcp.apply(
    target,
    pending,
    [second],
    { online: true, catalog: catalog() },
    current,
  );
  assert.notEqual(next.review?.reviewId, draft.review?.reviewId);
  await f.store.transition(original, ['pending'], 'accepted', { synthetic: true }, current);
  assert.deepEqual(
    (await new SecureMcp(new SecureStore(f.memory)).read(target, current)).review,
    next.review,
  );
  assert.deepEqual((await f.store.list(target))[0].mcpReview, draft.review);
});

test('pending and sealing retain immutable selection; abandonment and rejection preserve draft for another manual review', async () => {
  for (const terminal of ['abandoned', 'rejected'] as const) {
    const f = setup(),
      draft = await select(f),
      original = await f.store.stage(fakeTurn(target, draft.review!), now, current);
    await f.store.transition(original, ['pending'], 'ending', undefined, current);
    const ending = await f.mcp.read(target, current);
    assert.equal(ending.delivery?.state, 'ending');
    assert.deepEqual(ending.review, draft.review);
    await assert.rejects(
      f.mcp.validateBeforeSend(target, ending, current, async () => catalog()),
      /先确认原指令/,
    );
    await f.store.transition(original, ['ending'], terminal, { synthetic: true }, current);
    assert.deepEqual(await f.mcp.read(target, current), draft);
  }
});

test('offline saves can only retain or remove existing full metadata and cannot add a cached item', async () => {
  const f = setup(),
    draft = await select(f, [server, second]);
  await assert.rejects(
    f.mcp.apply(
      target,
      draft,
      [{ ...server, description: 'Changed' }],
      { online: false, catalog: catalog() },
      current,
    ),
    /离线只能/,
  );
  const reduced = await f.mcp.apply(
    target,
    draft,
    [server],
    { online: false, catalog: catalog() },
    current,
  );
  await assert.rejects(
    f.mcp.apply(target, reduced, [server, second], { online: false, catalog: catalog() }, current),
    /离线只能/,
  );
  const empty = await f.mcp.apply(target, reduced, [], { online: false }, current);
  assert.deepEqual(empty.review?.servers, []);
  assert.deepEqual(await f.store.list(target), []);
});

test('MCP selection enforces zero to eight unique immutable versions and rejects raw configuration', async () => {
  const f = setup(),
    empty = await f.mcp.read(target, current),
    servers = Array.from({ length: 9 }, (_, index) => ({ ...server, id: `version-${index}` }));
  await assert.rejects(
    f.mcp.apply(
      target,
      empty,
      servers,
      { online: true, catalog: catalog(target, servers) },
      current,
    ),
  );
  await assert.rejects(
    f.mcp.apply(target, empty, [server, server], { online: true, catalog: catalog() }, current),
  );
  await assert.rejects(
    f.mcp.apply(
      target,
      empty,
      [{ ...server, connection: { url: 'https://synthetic.invalid' } } as McpServerView],
      { online: true, catalog: catalog() },
      current,
    ),
  );
  const full = await f.mcp.apply(
    target,
    empty,
    servers.slice(0, 8),
    { online: true, catalog: catalog(target, servers) },
    current,
  );
  assert.equal(full.review?.servers.length, 8);
});

test('catalog validation rejects cross-scope results, duplicate IDs, raw connection fields and stale generation', async () => {
  const f = setup();
  for (const raw of [
    catalog({ ...target, sessionId: 'other' }),
    catalog(target, [server, server]),
    { ...catalog(), servers: [{ ...server, headers: { Authorization: 'synthetic' } }] },
  ])
    await assert.rejects(f.mcp.readCatalog(target, current, async () => raw));
  let active = true;
  await assert.rejects(
    f.mcp.readCatalog(
      target,
      () => {
        assert(active, 'stale generation');
      },
      async () => {
        active = false;
        return catalog();
      },
    ),
    /stale generation/,
  );
  assert.equal(f.memory.values.size, 0);
});

test('every secure target dimension isolates drafts and copied rows fail embedded identity validation', async () => {
  const f = setup();
  await select(f);
  const source = [...f.memory.values.entries()].find(([key]) =>
    key.includes('moor-secure-mcp-draft-v1'),
  )![1];
  const changed: SecureCliTarget[] = [
    ...(
      [
        'origin',
        'owner',
        'rootKeyId',
        'clientDeviceId',
        'hostDeviceId',
        'workspaceId',
        'localProjectId',
        'userId',
        'machineId',
        'sessionId',
      ] as const
    ).map((field) => ({
      ...target,
      [field]:
        field === 'origin'
          ? 'https://other.synthetic.invalid'
          : field === 'rootKeyId'
            ? Buffer.alloc(32, 2).toString('base64url')
            : 'other',
    })),
    ...(['catalogWorkspaceId', 'projectId', 'replicaId', 'revision'] as const).map((field) => ({
      ...target,
      product: { ...target.product!, [field]: field === 'revision' ? 2 : 'other' },
    })),
  ];
  for (const destination of changed) {
    assert.equal((await f.mcp.read(destination, current)).review, undefined);
    f.memory.values.set(
      productCanonicalJson(['moor-secure-mcp-draft-v1', destination]),
      structuredClone(source),
    );
    await assert.rejects(f.mcp.read(destination, current), /完整执行身份/);
  }
  const key = productCanonicalJson(['moor-secure-mcp-draft-v1', target]);
  const missing = structuredClone(source) as Record<string, unknown>;
  delete missing.target;
  f.memory.values.set(key, missing);
  await assert.rejects(f.mcp.read(target, current));
});

test('simultaneous pages save only one review and stale reload cannot overwrite it', async () => {
  const f = setup(),
    draft = await f.mcp.read(target, current),
    other = new SecureMcp(new SecureStore(f.memory));
  const results = await Promise.allSettled([
    f.mcp.apply(target, draft, [server], { online: true, catalog: catalog() }, current),
    other.apply(target, draft, [second], { online: true, catalog: catalog() }, current),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const written = await f.mcp.read(target, current);
  await assert.rejects(other.apply(target, draft, [], { online: false }, current), /草稿已改变/);
  assert.deepEqual(await other.read(target, current), written);
});

test('stage holds the target lock across host revalidation and cannot mix a concurrent saved MCP review into the body', async (t) => {
  const f = await fixture(t),
    draft = await f.select(),
    entered = signal(),
    release = signal(),
    queued = signal();
  const input = await f.input();
  const staging = f.mcp.stageTurn(f.target, draft, input, current, async (destination, query) => {
    entered.resolve();
    await release.promise;
    return f.request(destination, query);
  });
  await entered.promise;
  const other = new SecureMcp(new SecureStore(f.memory));
  f.memory.queued = () => queued.resolve();
  const saving = other.apply(f.target, draft, [], { online: false }, current);
  const rejected = assert.rejects(saving, /草稿已改变/);
  await queued.promise;
  release.resolve();
  const original = await staging;
  await rejected;
  assert.deepEqual(original.mcpReview, draft.review);
  assert.equal(f.prompts, 0);
  assert.equal((await f.store.list(f.target)).length, 1);
});

test('scope generation invalidation while saving or validating never creates a dispatchable turn', async (t) => {
  const f = await fixture(t),
    draft = await f.select(),
    input = await f.input();
  let active = true;
  const check = () => {
    assert(active, 'scope changed');
  };
  await assert.rejects(
    f.mcp.stageTurn(f.target, draft, input, check, async (destination, query) => {
      const response = await f.request(destination, query);
      active = false;
      return response;
    }),
    /scope changed/,
  );
  assert.deepEqual(await f.store.list(f.target), []);
  active = true;
  f.memory.beforeWrite = async () => {
    active = false;
  };
  await assert.rejects(f.mcp.apply(f.target, draft, [], { online: false }, check), /scope changed/);
  assert.deepEqual(await f.mcp.read(f.target, current), draft);
});

test('review metadata is covered by the durable digest, CLI compatibility and original-ID conflict checks', async (t) => {
  const f = setup(),
    draft = await select(f),
    input = fakeTurn(target, draft.review!);
  const original = await f.store.stage(input, now, current);
  const changed = {
    ...input,
    mcpReview: { ...draft.review!, servers: [{ ...server, description: 'other metadata' }] },
  };
  assert.notEqual(await secureBrowserRequestVersion(changed), original.requestVersion);
  await assert.rejects(f.store.stage(changed, now, current));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-secure-mcp-cli-'))),
    cli = new CliState(root);
  t.after(() => {
    cli.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(cli.secureStage(input, now).requestVersion, original.requestVersion);
  assert.deepEqual(cli.secureOperation(input.operationId), original);
  assert.throws(() => cli.secureStage(changed, now), /原操作编号/);
  assert.equal(secureOriginal(original).kind, 'mutation');
  assert.equal(secureOperationSchema.safeParse({ ...original, kind: 'permission' }).success, false);
  const entry = [...f.memory.values.entries()].find(([key]) =>
    key.includes('moor-secure-operations-v1'),
  )!;
  const ledger = structuredClone(entry[1]) as { operations: Array<Record<string, unknown>> };
  ledger.operations[0].mcpReview = changed.mcpReview;
  f.memory.values.set(entry[0], ledger);
  await assert.rejects(f.store.list(target), /原操作校验失败/);
});

test('reusing an existing review ID or changing immutable review content is refused', async () => {
  const f = setup(),
    draft = await select(f),
    reused = new SecureMcp(f.store, { uuid: () => draft.review!.reviewId });
  await assert.rejects(
    reused.apply(target, draft, [], { online: false }, current),
    /审阅编号已使用/,
  );
  await f.store.stage(fakeTurn(target, draft.review!), now, current);
  const entry = [...f.memory.values.entries()].find(([key]) =>
    key.includes('moor-secure-mcp-draft-v1'),
  )!;
  const document = structuredClone(entry[1]) as { review: SecureMcpReview };
  document.review.servers[0].description = 'silently changed';
  f.memory.values.set(entry[0], document);
  await assert.rejects(f.mcp.read(target, current), /不可变内容不匹配/);
});

test('precise user turn identity is independently digest-bound without changing the immutable review', async (t) => {
  const f = setup(),
    draft = await select(f),
    input = { ...fakeTurn(target, draft.review!), userTurnId: 'reviewed-user-turn' };
  const original = await f.store.stage(input, now, current);
  assert.deepEqual(original.mcpReview, draft.review);
  assert.notEqual(
    original.requestVersion,
    await secureBrowserRequestVersion({ ...input, userTurnId: 'other-turn' }),
  );
  assert.notEqual(
    original.requestVersion,
    await secureBrowserRequestVersion(fakeTurn(target, draft.review!)),
  );
  await assert.rejects(f.store.stage({ ...input, userTurnId: 'other-turn' }, now, current));
  assert.equal((await f.mcp.read(target, current)).delivery?.operationId, original.operationId);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-secure-mcp-turn-cli-'))),
    cli = new CliState(root);
  t.after(() => {
    cli.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(cli.secureStage(input, now).requestVersion, original.requestVersion);
  assert.deepEqual(cli.secureOperation(input.operationId), original);
  assert.throws(() => cli.secureStage({ ...input, userTurnId: 'other-turn' }, now));
  const badControl = {
    ...original,
    kind: 'create',
    mcpReview: undefined,
    body: JSON.stringify({
      method: 'session-control',
      workspaceId: target.workspaceId,
      localProjectId: target.localProjectId,
      params: {
        controlVersion: 1,
        operationId: original.operationId,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
        userId: target.userId,
        machineId: target.machineId,
        action: 'create',
        agentId: 'agent',
      },
    }),
  };
  assert.equal(
    secureOperationSchema.safeParse({ ...badControl, userTurnId: undefined }).success,
    true,
  );
  assert.equal(secureOperationSchema.safeParse(badControl).success, false);
  await f.store.transition(original, ['pending'], 'accepted', { synthetic: true }, current);
  assert.equal((await f.mcp.read(target, current)).review, undefined);
});
