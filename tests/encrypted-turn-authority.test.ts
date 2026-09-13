import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { taskPlanSchema } from '../src/task-protocol';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { HostProductCatalog } from '../src/bridge/host-product-catalog';
import { HostCommandDispatcher } from '../src/bridge/host-command';
import { EncryptedHostCommands } from '../src/bridge/encrypted-host-command';
import { buildSessionTurn } from '../src/session-client';
import { captureProjectSnapshot, enumerateProjectFiles } from '../src/runtime/project-snapshot';
import { E2eeChannel, newChannelChallenge } from '../src/security/e2ee-channel';
import { generateDeviceEncryptionKey } from '../src/security/e2ee-crypto';
import {
  encryptionKeyId,
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
} from '../src/security/e2ee-trust';
import { syntheticCapabilities } from './support/agent-capabilities';
import type { AgentOpenOptions } from '../src/runtime/agent';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext, mode: 'mcp' | 'tasks' = 'mcp') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-encrypted-turn-authority-'))),
    projectRoot = join(directory, 'project');
  mkdirSync(projectRoot);
  let expectedOid = '';
  if (mode === 'tasks') {
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init', '-b', 'main');
    git(
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'Synthetic baseline',
    );
    expectedOid = git('rev-parse', 'HEAD');
  }
  const runtime = new RuntimeStore(join(directory, 'host.sqlite')),
    projectId = runtime.registerProject(projectRoot);
  runtime.registerAgent('synthetic', {
    id: 'agent',
    name: 'Synthetic',
    machineId: runtime.workspace.machineId,
    cliType: 'custom',
    agentType: 'synthetic',
    customAcp: { command: '/synthetic/never-run', args: [] },
  });
  const releaseCapture = signal(),
    captured = signal(),
    started = signal(),
    completed = signal();
  let opens = 0,
    prompts = 0,
    cancels = 0,
    options: AgentOpenOptions | undefined;
  const host = new HostWorkspace(
    runtime,
    {
      async open(_agent, _cwd, _native, _callbacks, input) {
        options = input;
        opens++;
        return {
          id: 'synthetic-native',
          capabilities: syntheticCapabilities,
          async prompt() {
            options?.mcp?.assertCurrent();
            options?.taskTools?.assertCurrent();
            options?.taskTools?.onPromptDispatch();
            prompts++;
            started.resolve();
            await completed.promise;
          },
          async cancel() {
            cancels++;
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
    undefined,
    {
      capture: async (...args) => {
        captured.resolve();
        await releaseCapture.promise;
        return captureProjectSnapshot(...args);
      },
      tree: enumerateProjectFiles,
    },
  );
  const scope = {
    workspaceId: host.workspace.id,
    localProjectId: projectId,
    userId: host.workspace.userId,
    machineId: host.workspace.machineId,
    sessionId: 'session',
  };
  await host.controlManager.control(
    { ...scope, controlVersion: 1, action: 'create', operationId: 'create', agentId: 'agent' },
    projectId,
  );
  const settings = await host.mcpSettings.handle({
    action: 'save',
    expectedRevision: 0,
    name: 'Synthetic MCP',
    description: 'Synthetic tools',
    projectIds: [projectId],
    enabled: true,
    connection: {
      transport: 'http',
      url: 'https://synthetic.invalid/mcp',
      headers: { Authorization: 'Bearer SYNTHETIC_PRIVATE_TOKEN' },
    },
  });
  const [root, clientKey, hostKey] = await Promise.all([
    generateTrustRoot(),
    generateDeviceEncryptionKey(),
    generateDeviceEncryptionKey(),
  ]);
  const pin = {
    accountId: 'owner',
    serverOrigin: 'https://synthetic.invalid',
    rootKeyId: root.keyId,
  };
  const devices = [
    {
      deviceId: 'client',
      keyId: await encryptionKeyId(clientKey.publicKey),
      publicKey: clientKey.publicKey,
      roles: ['client' as const],
    },
    {
      deviceId: 'host',
      keyId: await encryptionKeyId(hostKey.publicKey),
      publicKey: hostKey.publicKey,
      roles: ['host' as const],
    },
  ];
  const signed = await signTrustManifest({
    rootPrivateKey: root.privateKey,
    rootPublicKey: root.publicKey,
    manifest: { ...pin, version: 1, epoch: 1, previous: null, devices },
  });
  const trust = await VerifiedTrust.verify({ signed, rootPublicKey: root.publicKey, pin });
  const common = {
    trust,
    clientDeviceId: 'client',
    hostDeviceId: 'host',
    hostChallenge: newChannelChallenge(),
    clientChallenge: newChannelChallenge(),
  };
  let active = true;
  const [client, channel] = await Promise.all([
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
  const products = new HostProductCatalog({
    db: runtime.journal.db,
    authority: { ...pin, hostDeviceId: 'host' },
    runtime: () => ({
      catalogVersion: 1,
      machineId: host.workspace.machineId,
      workspaces: [host.workspace],
    }),
  });
  const replica = products.read().replicas[0]!,
    target = {
      catalogWorkspaceId: replica.catalogWorkspaceId,
      projectId: replica.projectId,
      replicaId: replica.id,
      revision: replica.revision,
    };
  const dispatcher = new HostCommandDispatcher({
    ready: () => !host.closed,
    workspace: (id) => (id === host.workspace.id ? host : undefined),
    hasOperation: (id) => runtime.journal.has(id),
  });
  const adapter = new EncryptedHostCommands({
    channel,
    dispatcher,
    products,
    invalidateAuthorizations: () => {
      host.taskManager.invalidateUnavailable();
      host.invalidateMcp();
    },
    catalog: () => ({
      catalogVersion: 2,
      machineId: host.workspace.machineId,
      workspaces: [host.workspace],
      products: products.read(),
    }),
  });
  const mutation = buildSessionTurn({
    scope,
    read: await host.read(scope.sessionId, undefined, projectId),
    agent: host.workspace.agents[0],
    prompt: 'Synthetic authorized MCP turn',
    operationId: 'turn',
    turnId: 'user',
    peerId: 'abcd1234',
    now: '2026-01-02T00:00:00.000Z',
    mcpServerIds: mode === 'mcp' ? [settings.presets[0].versionId] : [],
    ...(mode === 'tasks'
      ? {
          taskPlan: taskPlanSchema.parse({
            version: 1,
            tasks: [
              {
                taskId: 'child-task',
                title: 'Synthetic child',
                agentId: 'agent',
                instruction: 'Synthetic child instruction',
                completion: 'Review synthetic result',
                baseBranch: 'main',
                expectedOid,
              },
            ],
            maxParallel: 1,
            maxTurnsPerTask: 1,
            timeoutMs: 60000,
            onParentEnd: 'cancel',
          }),
        }
      : {}),
  });
  const send = async () => {
    const record = await client.send({
      kind: 'request',
      requestId: newChannelChallenge(),
      resource: {
        kind: 'session',
        workspaceId: scope.workspaceId,
        projectId,
        sessionId: scope.sessionId,
        catalogWorkspaceId: target.catalogWorkspaceId,
        replicaId: target.replicaId,
      },
      plaintext: encode({
        method: 'mapped-command',
        target,
        command: {
          method: 'mutate',
          workspaceId: scope.workspaceId,
          localProjectId: projectId,
          params: mutation,
        },
      }),
    });
    return JSON.parse(
      new TextDecoder().decode((await client.receive(await adapter.execute(record))).plaintext),
    );
  };
  t.after(async () => {
    releaseCapture.resolve();
    completed.resolve();
    await Promise.allSettled([...host.active.values()].map((run) => run.done));
    channel.close();
    client.close();
    host.close();
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    host,
    runtime,
    products,
    target,
    scope,
    send,
    async move() {
      for (const request of [
        {
          version: 1,
          action: 'create-workspace',
          operationId: 'space',
          expectedRevision: products.read().revision,
          id: 'other-space',
          name: 'Other',
        },
        {
          version: 1,
          action: 'move-host',
          operationId: 'move',
          expectedRevision: products.read().revision + 1,
          runtimeWorkspaceId: scope.workspaceId,
          targetWorkspaceId: 'other-space',
        },
      ]) {
        const record = await client.send({
          kind: 'request',
          requestId: newChannelChallenge(),
          resource: {
            kind: 'catalog',
            workspaceId: null,
            projectId: null,
            sessionId: null,
            catalogWorkspaceId: null,
            replicaId: null,
          },
          plaintext: encode({ method: 'catalog-action', params: request }),
        });
        const result = JSON.parse(
          new TextDecoder().decode((await client.receive(await adapter.execute(record))).plaintext),
        );
        assert.equal(result.ok, true);
      }
    },
    captured,
    releaseCapture,
    started,
    completed,
    get opens() {
      return opens;
    },
    get prompts() {
      return prompts;
    },
    get cancels() {
      return cancels;
    },
    get options() {
      return options;
    },
    revoke() {
      active = false;
      host.taskManager.invalidateUnavailable();
      host.invalidateMcp();
    },
  };
}

test('MCP authorization survives its encrypted receipt while the original connection and execution mapping remain current', async (t) => {
  const f = await fixture(t);
  const result = await f.send();
  assert.equal(result.ok, true);
  assert.equal(result.result.accepted, true);
  await f.captured.promise;
  const run = f.host.active.get(f.scope.sessionId)!;
  // The RPC has completely finished and released its short product lease before Agent startup resumes.
  f.releaseCapture.resolve();
  await Promise.race([f.started.promise, run.done]);
  assert.equal(
    f.prompts,
    1,
    `MCP must execute after acceptance; terminal=${JSON.stringify(run.terminal)}`,
  );
  assert.equal(f.opens, 1);
  assert.doesNotThrow(() => f.options?.mcp?.assertCurrent());
  f.completed.resolve();
  await run.done;
});

for (const change of ['connection', 'catalog', 'runtime'] as const)
  test(`an accepted MCP turn is canceled when its original ${change} authority changes`, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.send()).ok, true);
    await f.captured.promise;
    const run = f.host.active.get(f.scope.sessionId)!;
    f.releaseCapture.resolve();
    await Promise.race([f.started.promise, run.done]);
    assert.equal(f.prompts, 1);
    assert.doesNotThrow(() => f.options!.mcp!.assertCurrent());
    if (change === 'connection') f.revoke();
    else if (change === 'catalog') await f.move();
    else {
      f.host.workspace.projects[0]!.rootPath += '-replaced';
      f.host.invalidateMcp();
    }
    assert.equal(run.stopped, true, 'revocation is synchronous before process cleanup');
    assert.throws(() => f.options!.mcp!.assertCurrent());
    await run.done;
    assert.equal(f.cancels, 1);
    assert.equal(run.terminal?.status, 'canceled');
  });

test('Task tools retain exact execution authority after the encrypted receipt and lose it on original connection retirement', async (t) => {
  const f = await fixture(t, 'tasks');
  assert.equal((await f.send()).ok, true);
  await f.captured.promise;
  const run = f.host.active.get(f.scope.sessionId)!;
  f.releaseCapture.resolve();
  await Promise.race([f.started.promise, run.done]);
  assert.equal(f.prompts, 1, JSON.stringify(run.terminal));
  assert.ok(f.options!.taskTools);
  assert.doesNotThrow(() => f.options!.taskTools!.assertCurrent());
  f.revoke();
  assert.throws(() => f.options!.taskTools!.assertCurrent());
  f.completed.resolve();
  await run.done;
});
