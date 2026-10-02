import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostWorkspace } from '@moor/host/adapters/composition/workspace';
import { RuntimeStore } from '@moor/host/adapters/persistence/workspace';
import { HostCommandDispatcher } from '@moor/host/features/commands/dispatcher';
import { metas } from '@moor/session/model';
import { syntheticCapabilities } from '../fixtures/agent-capabilities';

for (const method of [
  'session-control',
  'send-turn',
  'session-action',
  'attachment-action',
] as const)
  test(`queued ${method} rechecks the original connection before committing or dispatching`, async (t) => {
    const store = new RuntimeStore(':memory:');
    const project = store.registerProject(process.cwd());
    const agent = store.registerAgent('synthetic', {
      id: 'agent',
      name: 'Synthetic',
      machineId: store.workspace.machineId,
      cliType: 'custom',
      agentType: 'synthetic',
      customAcp: { command: '/synthetic/never-run', args: [] },
    });
    let prompts = 0;
    const host = createHostWorkspace(
      store,
      {
        async open() {
          return {
            id: 'synthetic-native',
            capabilities: syntheticCapabilities,
            async prompt() {
              prompts++;
            },
            async cancel() {},
            close() {},
          };
        },
      },
      () => {},
      () => {},
      async () => {
        throw Error('disabled synthetic file read');
      },
      {
        capture: async () => {
          throw Error('disabled synthetic capture');
        },
        tree: async () => {
          throw Error('disabled synthetic tree');
        },
      },
    );
    t.after(async () => {
      await Promise.allSettled([...host.active.values()].map((run) => run.done));
      host.close();
      store.close();
    });
    const dispatcher = new HostCommandDispatcher({
      ready: () => true,
      workspace: (id) => (id === host.workspace.id ? host : undefined),
      hasOperation: (id) => store.journal.has(id),
    });
    const scope = {
      workspaceId: host.workspace.id,
      userId: host.workspace.userId,
      machineId: host.workspace.machineId,
      localProjectId: project,
      sessionId: 'session',
    };
    const command = (method: string, params: unknown) => ({
      method,
      workspaceId: scope.workspaceId,
      localProjectId: project,
      params,
    });
    const create = {
      ...scope,
      controlVersion: 1,
      operationId: 'create',
      action: 'create',
      agentId: agent.id,
    };
    if (method !== 'session-control')
      await dispatcher.execute(command('session-control', create), { current: () => {} });
    const before = metas(store.meta)['session-session'];
    const input =
      method === 'session-control'
        ? create
        : method === 'send-turn'
          ? {
              ...scope,
              intentVersion: 1,
              operationId: 'send',
              expectedTurnId: null,
              agentId: agent.id,
              turnId: 'user-turn',
              prompt: 'Synthetic only',
              selection: {},
              attachments: [],
            }
          : method === 'session-action'
            ? {
                workspaceId: scope.workspaceId,
                localProjectId: scope.localProjectId,
                sessionId: scope.sessionId,
                operationId: 'rename',
                action: 'rename',
                title: 'changed',
                expectedRevision: 0,
              }
            : {
                workspaceId: scope.workspaceId,
                localProjectId: scope.localProjectId,
                sessionId: scope.sessionId,
                contentVersion: 1,
                operationId: 'attachment',
                action: 'remove',
                attachmentId: 'attachment',
              };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = host.serial(scope.sessionId, () => gate);
    let live = true;
    const pending = dispatcher.execute(command(method, input), {
      current() {
        assert.ok(live, 'synthetic connection revoked');
      },
    });
    live = false;
    release();
    await holding;
    await assert.rejects(pending, /synthetic connection revoked/);
    assert.equal(store.journal.has(String(input.operationId)), false);
    assert.equal(prompts, 0);
    assert.deepEqual(metas(store.meta)['session-session'], before);
  });
