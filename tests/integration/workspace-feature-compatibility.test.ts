import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkspaceStore,
  type WorkspaceLedger,
  type WorkspaceScope,
} from '../../apps/web/src/features/workspace/workspace-store';
import { workspaceFeatureTarget } from '../../apps/web/src/features/mcp/workspace-mcp';
import type { TaskPlan } from '@moor/protocol/task-protocol';
import type { GitTarget } from '../../apps/web/src/features/git/git-workspace';

const scope: WorkspaceScope = {
  source: 'local',
  target: {
    serverKey: 'https://synthetic.invalid',
    owner: 'owner',
    deviceId: 'device',
    userId: 'user',
    machineId: 'machine',
    workspaceId: 'runtime',
    localProjectId: 'project',
    catalogWorkspaceId: 'catalog',
    catalogProjectId: 'catalog-project',
    replicaId: 'replica',
  },
};
// A saved digest from the pre-retirement MCP/task mutation format.
const requestVersion = 'sha256:f726fe0c04681621b0a2b43a15fb0cec01e3c0f4fdb318648211628878f315cd';
function ledger(): WorkspaceLedger {
  const target = workspaceFeatureTarget({ ...scope.target, sessionId: 'session' });
  const plan: TaskPlan = {
    version: 1,
    tasks: [
      {
        taskId: 'task',
        title: 'Original task',
        agentId: 'agent',
        instruction: 'Synthetic work',
        completion: 'Synthetic result',
        selection: {},
        baseBranch: 'main',
        expectedOid: 'a'.repeat(40),
      },
    ],
    maxParallel: 1,
    maxTurnsPerTask: 1,
    timeoutMs: 1000,
    onParentEnd: 'cancel',
  };
  const taskReview = { reviewId: 'task-review', parentAgentId: 'agent', plan };
  const mcpReview = {
    reviewId: 'mcp-review',
    servers: [
      {
        id: 'server',
        name: 'Synthetic MCP',
        description: 'Original version',
        transport: 'http' as const,
      },
    ],
  };
  return {
    version: 1,
    scope,
    revision: 1,
    drafts: {},
    operations: [
      {
        status: 'pending',
        mcpReview,
        taskReview,
        original: {
          kind: 'mutation',
          value: {
            kind: 'turn',
            operationId: 'original',
            workspaceId: 'runtime',
            sessionId: 'session',
            expectedTurnId: null,
            update: 'c3ludGhldGlj',
            metaBundle: {},
          },
        },
      },
    ],
    mcp: {
      session: {
        version: 1,
        cacheRevision: 1,
        target,
        review: mcpReview,
        delivery: { operationId: 'original', review: mcpReview, requestVersion },
      },
    },
    tasks: {
      session: {
        version: 1,
        cacheRevision: 1,
        target,
        draft: plan,
        enabled: taskReview,
        delivery: { operationId: 'original', review: taskReview, requestVersion },
      },
    },
    roles: { session: { version: 1, cacheRevision: 1, target } },
    roleApplied: {
      session: {
        version: 1,
        target,
        base: 'Original draft',
        applied: [{ roleId: 'role', revision: 1 }],
      },
    },
  };
}
function read(record: WorkspaceLedger) {
  const store = new WorkspaceStore({
    read: async () => structuredClone(record),
    async compareAndSet() {
      assert.fail('Reading a valid historical ledger must not rewrite it');
    },
    async exclusive() {
      assert.fail('Reading a historical ledger must not start a write');
    },
  });
  return store.read(scope, () => {});
}

test('retired MCP, task and role records remain readable without rewriting the original operation', async () => {
  const record = ledger(),
    before = structuredClone(record);
  assert.deepEqual(await read(record), before);
  assert.deepEqual(record, before);
});

test('retired MCP and task deliveries still require the exact original mutation digest', async () => {
  for (const kind of ['mcp', 'tasks'] as const) {
    const record = ledger();
    record[kind]!.session!.delivery!.requestVersion = 'sha256:' + '0'.repeat(64);
    await assert.rejects(read(record), /匹配的原指令/);
  }
  const record = ledger(),
    original = record.operations[0]!.original;
  assert(original.kind === 'mutation');
  original.value.update = 'b3RoZXI=';
  await assert.rejects(read(record), /匹配的原指令/);
});

test('retired feature records cannot cross identities or lose their pending original', async () => {
  for (const kind of ['mcp', 'tasks', 'roles', 'roleApplied'] as const) {
    const record = ledger();
    for (const key of Object.keys(record[kind]!.session!.target) as Array<keyof GitTarget>) {
      const changed = structuredClone(record);
      changed[kind]!.session!.target[key] = 'foreign';
      await assert.rejects(read(changed));
    }
  }
  const missing = ledger();
  missing.operations = [];
  await assert.rejects(read(missing), /匹配的原指令/);
  const changedReview = ledger();
  changedReview.mcp!.session!.delivery!.review = structuredClone(
    changedReview.mcp!.session!.delivery!.review,
  );
  changedReview.mcp!.session!.delivery!.review.servers[0]!.description = 'Changed review';
  await assert.rejects(read(changedReview));
});
