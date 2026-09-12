import test from 'node:test';
import assert from 'node:assert/strict';
import {
  taskPlanSchema,
  taskActionSchema,
  taskOriginSchema,
  taskToolInputSchemas,
  validateTaskReadResult,
  validateTaskActionResult,
} from '../src/task-protocol';
import { syntheticTaskPlan, syntheticTaskGrant } from './support/task-plan';
import { Flock, LoroDoc, putMeta, metas, delta } from '../src/model';
import { sessionReadResponseSchema, validateSessionBundle } from '../src/session-responses';
const scope = {
  taskVersion: 1 as const,
  workspaceId: 'workspace',
  localProjectId: 'project',
  sessionId: 'parent',
};
test('finite task plans reject unknown launch fields, duplicate slots, unbounded budgets and arbitrary directories', () => {
  const plan = syntheticTaskPlan();
  for (const invalid of [
    { ...plan, maxParallel: 5 },
    { ...plan, maxTurnsPerTask: 4 },
    { ...plan, timeoutMs: 3600001 },
    { ...plan, onParentEnd: 'keep-running' },
    { ...plan, tasks: [...plan.tasks, ...plan.tasks] },
    { ...plan, tasks: [{ ...plan.tasks[0], rootPath: '/private' }] },
    { ...plan, tasks: [{ ...plan.tasks[0], command: 'sh' }] },
    { ...plan, tasks: [{ ...plan.tasks[0], completion: '' }] },
    { ...plan, tasks: [{ ...plan.tasks[0], selection: { modelId: 'model', token: 'secret' } }] },
  ])
    assert.equal(taskPlanSchema.safeParse(invalid).success, false);
  assert.equal(
    taskActionSchema.safeParse({
      ...scope,
      grantId: 'grant',
      action: 'cleanup',
      operationId: 'cleanup',
    }).success,
    false,
  );
  assert.equal(
    taskActionSchema.safeParse({
      ...scope,
      grantId: 'grant',
      action: 'inspect',
      operationId: 'old',
      taskId: 'task-one',
      expectedExecutionRevision: 1,
    }).success,
    false,
  );
  assert.equal(
    taskToolInputSchemas.moor_task_send.safeParse({
      grantId: 'grant',
      taskId: 'task-one',
      operationId: 'send',
      expectedUserTurnId: null,
      agentId: 'other',
    }).success,
    false,
  );
  assert.equal(
    taskToolInputSchemas.moor_task_wait.safeParse({
      grantId: 'grant',
      taskId: 'task-one',
      expectedUserTurnId: 'old',
      timeoutMs: 20001,
    }).success,
    false,
  );
});
test('task projections reject swapped scope, incomplete slots, spoofed goals and cleanup result identities', () => {
  const grant = syntheticTaskGrant(),
    raw = { ...scope, confirmed: true as const, grants: [grant], truncated: false };
  assert.deepEqual(validateTaskReadResult(raw, scope), raw);
  for (const invalid of [
    { ...raw, sessionId: 'other' },
    { ...raw, grants: [{ ...grant, parentSessionId: 'other' }] },
    { ...raw, grants: [{ ...grant, authority: { token: 'private' } }] },
    { ...raw, grants: [{ ...grant, tasks: [] }] },
    { ...raw, grants: [{ ...grant, tasks: [{ ...grant.tasks[0], goalVerified: true }] }] },
    { ...raw, grants: [{ ...grant, tasks: [{ ...grant.tasks[0], childSessionId: 'parent' }] }] },
    {
      ...raw,
      grants: [
        {
          ...grant,
          operations: [
            { operationId: 'wrong', taskId: 'other-task', kind: 'send', state: 'accepted' },
          ],
        },
      ],
    },
  ])
    assert.throws(() => validateTaskReadResult(invalid, scope));
  const action = taskActionSchema.parse({
    ...scope,
    grantId: 'grant',
    action: 'cleanup',
    operationId: 'cleanup',
    taskId: 'task-one',
    expectedExecutionRevision: 1,
  });
  const result = { ...action, confirmed: true as const, grant: { ...grant, state: 'canceled' } };
  assert.doesNotThrow(() => validateTaskActionResult(result, action));
  assert.throws(() => validateTaskActionResult({ ...result, taskId: 'another-task' }, action));
  assert.throws(() =>
    validateTaskActionResult({ ...result, expectedExecutionRevision: 2 }, action),
  );
  for (const operation of [
    { operationId: 'cleanup', taskId: 'task-one', kind: 'send', state: 'accepted' },
    { operationId: 'cleanup', taskId: 'other-task', kind: 'cleanup', state: 'accepted' },
  ])
    assert.throws(() => validateTaskActionResult({ ...result, operation }, action));
});
test('host-authored task origin preserves original Flock clocks and never accepts private authority', () => {
  const origin = taskOriginSchema.parse({
    version: 1,
    grantId: 'grant',
    parentSessionId: 'parent',
    parentUserTurnId: 'parent-user',
    parentAssistantTurnId: 'parent-assistant',
    taskId: 'task-one',
    completion: 'Human verifies output',
  });
  const flock = new Flock();
  putMeta(flock, 'session-child', {
    id: 'child',
    userId: 'user',
    machineId: 'machine',
    agentConfigId: 'agent',
    cliType: 'custom',
    agentType: 'synthetic',
    project: { kind: 'local', localProjectId: 'project' },
    taskOrigin: origin,
  });
  const raw = {
    meta: metas(flock)['session-child'],
    metaBundle: flock.exportJson(),
    update: delta(new LoroDoc()),
    synced: true,
    online: true,
  };
  const read = sessionReadResponseSchema.parse(raw);
  validateSessionBundle(read);
  assert.deepEqual(read.metaBundle, raw.metaBundle);
  assert.equal(
    taskOriginSchema.safeParse({ ...origin, ownerId: 'owner', token: 'secret' }).success,
    false,
  );
});
