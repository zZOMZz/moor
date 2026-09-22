import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationStore } from '@moor/sync/store';
import { CollaborationExecutionStore } from '../src/persistence/collaboration-execution-store';
import {
  collaborationKey,
  taskIntentSchema,
  type CollaborationScope,
  type TaskExecutionTarget,
} from '@moor/protocol/collaboration-protocol';

const owner = { kind: 'local' as const, authorityId: 'authority', accountId: 'owner' };
const scope: CollaborationScope = {
  authorityId: 'authority',
  workspaceId: 'workspace',
  projectId: 'project',
  sessionId: 'session',
};
const target: TaskExecutionTarget = {
  executionDeviceId: 'device',
  workspaceId: 'runtime',
  userId: 'user',
  machineId: 'machine',
  localProjectId: 'local-project',
  sessionId: 'session',
  agentId: 'agent',
};
const intent = (id: string, expiresAt = 100000) =>
  taskIntentSchema.parse({
    version: 1,
    kind: 'submit',
    operationId: id,
    scope,
    author: { actor: owner, clientId: 'client' },
    createdAt: 1,
    input: { prompt: 'Synthetic task ' + id, selection: {} },
    target,
    authorization: { kind: 'execute', ordering: 'after-previous', expiresAt },
  });
function fixture(t: TestContext) {
  let now = 1000;
  const state = new CollaborationStore(':memory:', scope.authorityId, () => now);
  t.after(() => state.close());
  state.createWorkspace(owner, scope.workspaceId);
  state.registerSession(owner, scope, target);
  const queue = new CollaborationExecutionStore(state);
  const enqueue = (id: string, sequence: number, expiresAt?: number) => {
    const next = intent(id, expiresAt);
    state.append(owner, scope, [next]);
    queue.enqueue(next, sequence);
  };
  return { state, queue, enqueue, clock: (value: number) => (now = value) };
}

test('claiming and restart use a phase index despite ten thousand terminal ledger records', (t) => {
  const { state, queue, enqueue } = fixture(t);
  // Seed only the private archive to isolate queue-selection work. The current
  // queued task still uses the real authorized document and public projection.
  const insert = state.db.prepare(
    'INSERT INTO collaboration_execution VALUES(?,?,?,?,?,NULL,NULL)',
  );
  state.atomic(() => {
    for (let i = 0; i < 10000; i++) {
      const id = 'completed-' + i;
      insert.run(
        collaborationKey(scope),
        id,
        i + 1,
        JSON.stringify(intent(id)),
        JSON.stringify({
          taskId: id,
          scope,
          sequence: i + 1,
          phase: 'completed',
          revision: 2,
          updatedAt: 1000,
        }),
      );
    }
  });
  enqueue('next', 10001);

  const sql: string[] = [];
  const prepare = state.db.prepare;
  t.mock.method(state.db, 'prepare', function (query: string) {
    sql.push(query);
    return prepare.call(state.db, query);
  });
  const claim = queue.claim(scope, target, 'claim');
  assert.equal(claim?.intent.operationId, 'next');
  assert.equal(queue.claim(scope, target, 'another-claim'), undefined);
  queue.interruptExecution(scope, target);
  assert.equal(
    state.projection(scope).tasks.find((task) => task.taskId === 'next')?.phase,
    'interrupted',
  );
  assert.equal(
    state.db
      .prepare(
        "SELECT COUNT(*) AS count FROM collaboration_execution WHERE json_extract(state,'$.phase')='completed'",
      )
      .get()!.count,
    10000,
  );

  const selections = sql.filter(
    (query) =>
      query.startsWith('SELECT') &&
      query.includes('FROM collaboration_execution WHERE scope=?') &&
      !query.includes('id=?'),
  );
  assert.ok(selections.length >= 3);
  for (const query of selections) {
    const plan = prepare.call(state.db, 'EXPLAIN QUERY PLAN ' + query).all(collaborationKey(scope));
    assert.ok(
      plan.some((row) => String(row.detail).includes('collaboration_execution_phase')),
      query,
    );
  }
});

test('indexed selection preserves order, blocks expired input and rolls back failed public state', (t) => {
  const { state, queue, enqueue, clock } = fixture(t);
  enqueue('expired-before-claim', 1, 1500);
  enqueue('first-valid', 2);
  enqueue('second-valid', 3);
  clock(2000);
  state.db.exec(`CREATE TRIGGER synthetic_projection_failure BEFORE UPDATE ON collaboration_document
    BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END`);
  assert.throws(() => queue.claim(scope, target, 'failed-claim'), /synthetic projection failure/);
  assert.deepEqual(
    state.projection(scope).tasks.map((task) => task.phase),
    ['queued', 'queued', 'queued'],
  );
  state.db.exec('DROP TRIGGER synthetic_projection_failure');

  const first = queue.claim(scope, target, 'first-claim')!;
  assert.equal(first.intent.operationId, 'first-valid');
  assert.equal(state.projection(scope).tasks[0].phase, 'blocked');
  queue.settle(first, 'completed');
  const second = queue.claim(scope, target, 'second-claim')!;
  assert.equal(second.intent.operationId, 'second-valid');
  assert.throws(() => queue.claim(scope, { ...target, machineId: 'other' }, 'foreign'));
});
