import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { buildSessionTurn } from '../src/session-client';
import { MCP_FEATURE } from '../src/mcp-protocol';
import { syntheticCapabilities } from './support/agent-capabilities';
import type { AgentOpenOptions } from '../src/runtime/agent';
import { mirror } from '../src/model';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext, holdOpen = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-mcp-host-'))),
    projectRoot = join(root, 'project'),
    otherRoot = join(root, 'other');
  mkdirSync(projectRoot);
  mkdirSync(otherRoot);
  const store = new RuntimeStore(join(root, 'private', 'host.sqlite')),
    project = store.registerProject(projectRoot),
    other = store.registerProject(otherRoot);
  const agent = store.registerAgent('synthetic', {
    id: 'synthetic-agent',
    name: 'Synthetic',
    machineId: store.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/never-run', args: [] },
  });
  const opening = signal(),
    releaseOpen = signal(),
    started = signal(),
    completed = signal();
  let options: AgentOpenOptions | undefined,
    opens = 0,
    prompts = 0,
    cancels = 0,
    closed = 0;
  let connected = true;
  const host = new HostWorkspace(
    store,
    {
      async open(_agent, _cwd, _native, _callbacks, input) {
        options = input;
        opens++;
        opening.resolve();
        if (holdOpen) await releaseOpen.promise;
        return {
          id: 'synthetic-native',
          capabilities: syntheticCapabilities,
          async prompt() {
            prompts++;
            started.resolve();
            await completed.promise;
          },
          async cancel() {
            cancels++;
            completed.resolve();
          },
          close() {
            closed++;
            completed.resolve();
          },
        };
      },
    },
    () => {},
    () => {},
  );
  const scope = {
    workspaceId: store.workspace.id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
    localProjectId: project,
    sessionId: 'synthetic-session',
  };
  await host.controlManager.control(
    {
      ...scope,
      controlVersion: 1,
      operationId: 'create-original',
      action: 'create',
      agentId: agent.id,
    },
    project,
  );
  const state = await host.mcpSettings.handle({
    action: 'save',
    expectedRevision: 0,
    name: 'Synthetic MCP',
    description: 'Explicit synthetic project tools',
    projectIds: [project],
    enabled: true,
    connection: {
      transport: 'http',
      url: 'https://synthetic.invalid/mcp',
      headers: { Authorization: 'Bearer SYNTHETIC_PRIVATE_MCP_TOKEN' },
    },
  });
  const preset = state.presets[0]!;
  const authority = {
    serverOrigin: 'https://synthetic.invalid',
    ownerId: 'owner',
    deviceId: 'device',
    current() {
      assert(connected, 'synthetic connection revoked');
    },
  };
  t.after(async () => {
    releaseOpen.resolve();
    completed.resolve();
    await Promise.allSettled([...host.active.values()].map((run) => run.done));
    host.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const request = async (ids = [preset.versionId]) =>
    buildSessionTurn({
      scope,
      read: await host.read(scope.sessionId, undefined, project),
      agent: host.workspace.agents[0]!,
      prompt: 'Synthetic user authorization',
      operationId: 'send-original',
      turnId: 'user-original',
      peerId: 'abcd1234',
      now: '2026-09-13T00:00:00.000Z',
      mcpServerIds: ids,
    });
  return {
    root,
    projectRoot,
    store,
    host,
    scope,
    project,
    other,
    preset,
    authority,
    request,
    opening,
    releaseOpen,
    started,
    completed,
    get options() {
      return options;
    },
    get opens() {
      return opens;
    },
    get prompts() {
      return prompts;
    },
    get cancels() {
      return cancels;
    },
    get closed() {
      return closed;
    },
    revokeConnection() {
      connected = false;
      host.invalidateMcp();
    },
    async disable() {
      const current = host.mcpSettings.read();
      await host.mcpSettings.handle({
        action: 'enabled',
        expectedRevision: current.revision,
        id: preset.id,
        enabled: false,
      });
    },
    grants() {
      return store.journal.db
        .prepare("SELECT value FROM runtime_state WHERE key LIKE 'mcp-grant-v1/%'")
        .all();
    },
  };
}

test('MCP catalog and grant are scoped and read-only until one manual turn is accepted', async (t) => {
  const f = await fixture(t);
  assert(f.host.workspace.features?.includes(MCP_FEATURE));
  const query = {
    mcpVersion: 1 as const,
    workspaceId: f.scope.workspaceId,
    localProjectId: f.project,
    sessionId: f.scope.sessionId,
  };
  const catalog = f.host.readMcp(query, f.project);
  assert.equal(catalog.servers[0]?.id, f.preset.versionId);
  assert.doesNotMatch(JSON.stringify(catalog), /Authorization|PRIVATE_MCP|synthetic\.invalid/);
  assert.equal(f.opens, 0);
  assert.equal(f.grants().length, 0);
  assert.equal(
    f.host.readMcp({ ...query, sessionId: 'reserved-new-session' }, f.project).servers[0]?.id,
    f.preset.versionId,
  );
  assert.throws(() => f.host.readMcp({ ...query, localProjectId: f.other }, f.other));
  const request = await f.request();
  const receipt = await f.host.mutate(request, f.project, f.authority);
  const run = f.host.active.get(f.scope.sessionId)!;
  await f.started.promise;
  assert.equal(f.options?.mcp?.servers.length, 1);
  assert.equal(f.grants().length, 1);
  const grant = JSON.parse(Buffer.from(f.grants()[0]!.value as Uint8Array).toString('utf8'));
  assert.deepEqual(grant.scope, f.scope);
  assert.equal(grant.operationId, request.operationId);
  assert.equal(grant.assistantTurnId, run.turnId);
  assert.deepEqual(grant.serverIds, [f.preset.versionId]);
  const shared = await f.host.read(f.scope.sessionId, undefined, f.project);
  assert.doesNotMatch(JSON.stringify(shared), /PRIVATE_MCP|Authorization|synthetic\.invalid/);
  f.completed.resolve();
  await run.done;
  await f.disable();
  assert.deepEqual(await f.host.mutate(request, f.project, f.authority), receipt);
  assert.equal(f.opens, 1);
  assert.equal(f.prompts, 1);
});

test('MCP cannot be activated without original connection authority or with arbitrary version IDs', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.host.mutate(await f.request(), f.project), /MCP/);
  await assert.rejects(f.host.mutate(await f.request(['not-registered']), f.project, f.authority));
  assert.equal(f.opens, 0);
  assert.equal(f.grants().length, 0);
});

test('MCP grant and input rollback together when host persistence fails', async (t) => {
  const f = await fixture(t),
    request = await f.request();
  const original = f.store.persist.bind(f.store);
  f.store.persist = () => {
    throw new Error('synthetic save failure');
  };
  await assert.rejects(f.host.mutate(request, f.project, f.authority), /synthetic save/);
  f.store.persist = original;
  assert.equal(f.grants().length, 0);
  assert.equal(f.opens, 0);
  const view = mirror(f.store.doc(f.scope.sessionId), f.scope.sessionId);
  assert.equal(view.getState().history.length, 0);
  view.dispose();
  await f.host.mutate(request, f.project, f.authority);
  const run = f.host.active.get(f.scope.sessionId)!;
  await f.started.promise;
  f.completed.resolve();
  await run.done;
  assert.equal(f.grants().length, 1);
  assert.equal(f.prompts, 1);
});

test('revoking MCP while Agent opens prevents prompt and closes the late session', async (t) => {
  const f = await fixture(t, true);
  await f.host.mutate(await f.request(), f.project, f.authority);
  const run = f.host.active.get(f.scope.sessionId)!;
  await f.opening.promise;
  await f.disable();
  f.releaseOpen.resolve();
  await run.done;
  assert.equal(f.prompts, 0);
  assert(f.closed >= 1);
  assert.throws(() => f.options?.mcp?.assertCurrent());
});

test('MCP disable, connection loss and replaced project stop only the exact authorized active turn', async (t) => {
  for (const kind of ['disable', 'connection', 'directory'] as const)
    await t.test(kind, async (child) => {
      const f = await fixture(child);
      await f.host.mutate(await f.request(), f.project, f.authority);
      const run = f.host.active.get(f.scope.sessionId)!;
      await f.started.promise;
      if (kind === 'disable') await f.disable();
      else if (kind === 'connection') f.revokeConnection();
      else {
        renameSync(f.projectRoot, f.projectRoot + '-old');
        mkdirSync(f.projectRoot);
        f.host.updateCatalogue();
      }
      await run.done;
      assert.equal(f.cancels, 1);
      assert(f.closed >= 1);
      assert.equal(f.prompts, 1);
      assert.throws(() => f.options?.mcp?.assertCurrent());
    });
});
