import { taskGrantViewSchema, taskPlanSchema } from '../../src/task-protocol';
export function syntheticTaskPlan() {
  return taskPlanSchema.parse({
    version: 1,
    tasks: [
      {
        taskId: 'task-one',
        title: 'Synthetic task',
        agentId: 'agent',
        instruction: 'Synthetic instruction',
        completion: 'Human verifies synthetic result',
        baseBranch: 'main',
        expectedOid: 'a'.repeat(40),
      },
    ],
    maxParallel: 1,
    maxTurnsPerTask: 1,
    timeoutMs: 60000,
    onParentEnd: 'cancel',
  });
}
export function syntheticTaskGrant(parentSessionId = 'parent') {
  const plan = syntheticTaskPlan(),
    task = plan.tasks[0]!;
  return taskGrantViewSchema.parse({
    grantId: 'grant',
    parentSessionId,
    parentUserTurnId: 'parent-user',
    parentAssistantTurnId: 'parent-assistant',
    state: 'active',
    createdAt: '2026-09-12T00:00:00.000Z',
    expiresAt: '2026-09-12T00:01:00.000Z',
    plan,
    tasks: [
      {
        taskId: task.taskId,
        childSessionId: 'child',
        sessionCreated: false,
        title: task.title,
        agentId: task.agentId,
        completion: task.completion,
        status: 'reserved',
        turnsUsed: 0,
        goalVerified: false,
      },
    ],
    operations: [],
  });
}
