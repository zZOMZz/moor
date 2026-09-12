import { z } from 'zod';
import { assert, id } from './protocol';
import { contentScopeSchema } from './content-protocol';
import { gitBranchSchema, sessionExecutionSchema } from './git-protocol';

export const SESSION_TASKS_FEATURE = 'session-tasks-v1';
export const TASK_LIMITS = {
  tasks: 8,
  parallel: 4,
  turns: 3,
  instructionCharacters: 10000,
  responseBytes: 1024 * 1024,
  requestBytes: 512 * 1024,
  waitMs: 20000,
  grantMs: 3600000,
} as const;
export const taskSpecSchema = z
  .object({
    taskId: id,
    title: z.string().trim().min(1).max(120),
    agentId: id,
    instruction: z.string().trim().min(1).max(TASK_LIMITS.instructionCharacters),
    completion: z.string().trim().min(1).max(2000),
    selection: z
      .object({
        modelId: z.string().min(1).max(300).optional(),
        reasoningEffort: z.string().min(1).max(300).optional(),
        modeId: z.string().min(1).max(300).optional(),
      })
      .strict()
      .optional(),
    baseBranch: gitBranchSchema,
    expectedOid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  })
  .strict();
export const taskPlanSchema = z
  .object({
    version: z.literal(1),
    tasks: z.array(taskSpecSchema).min(1).max(TASK_LIMITS.tasks),
    maxParallel: z.number().int().min(1).max(TASK_LIMITS.parallel),
    maxTurnsPerTask: z.number().int().min(1).max(TASK_LIMITS.turns),
    timeoutMs: z.number().int().min(1000).max(TASK_LIMITS.grantMs),
    onParentEnd: z.literal('cancel'),
  })
  .strict()
  .refine(
    (plan) => new Set(plan.tasks.map((task) => task.taskId)).size === plan.tasks.length,
    '子任务编号不能重复',
  );
export type TaskPlan = z.infer<typeof taskPlanSchema>;
export type TaskSpec = z.infer<typeof taskSpecSchema>;
export const taskOriginSchema = z
  .object({
    version: z.literal(1),
    grantId: id,
    parentSessionId: id,
    parentUserTurnId: id,
    parentAssistantTurnId: id,
    taskId: id,
    completion: z.string().max(2000),
  })
  .strict();
export type TaskOrigin = z.infer<typeof taskOriginSchema>;
export const taskScopeSchema = contentScopeSchema.extend({ taskVersion: z.literal(1) }).strict();
export type TaskScope = z.infer<typeof taskScopeSchema>;
// Canonical, unpadded base64url encoding of exactly 32 bytes. Keep the shared
// task protocol independent of the endpoint cryptography implementation.
const secureDigest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const taskSecureChannelSchema = z
  .object({
    version: z.literal(1),
    clientDeviceId: id,
    clientKeyId: secureDigest,
    rootKeyId: secureDigest,
    trustEpoch: z.number().int().positive().safe(),
    trustDigest: secureDigest,
    hostChallenge: secureDigest,
    clientChallenge: secureDigest,
  })
  .strict();
export const taskAuthoritySchema = z
  .object({
    serverOrigin: z.string().url().max(2048),
    ownerId: z.string().min(1).max(1000),
    deviceId: id,
    secureChannel: taskSecureChannelSchema.optional(),
  })
  .strict();
export type TaskAuthority = z.infer<typeof taskAuthoritySchema>;
export type TaskAuthorityLease = TaskAuthority & { current(): void };
export const taskReadSchema = taskScopeSchema.extend({ grantId: id.optional() }).strict();
const taskActionBaseSchema = taskScopeSchema
  .extend({
    grantId: id,
    operationId: id,
    action: z.enum(['inspect', 'abandon', 'revoke', 'cleanup']),
    taskId: id.optional(),
    expectedExecutionRevision: z.number().int().nonnegative().safe().optional(),
  })
  .strict();
function checkTaskAction(action: z.infer<typeof taskActionBaseSchema>, context: z.RefinementCtx) {
  if (
    action.action === 'cleanup'
      ? !action.taskId || action.expectedExecutionRevision === undefined
      : action.taskId !== undefined || action.expectedExecutionRevision !== undefined
  )
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '清理操作必须核对原任务与工作目录版本，其他操作不能携带清理参数',
    });
}
export const taskActionSchema = taskActionBaseSchema.superRefine(checkTaskAction);
export type TaskRead = z.infer<typeof taskReadSchema>;
export type TaskAction = z.infer<typeof taskActionSchema>;
export const taskOperationViewSchema = z
  .object({
    operationId: id,
    taskId: id,
    kind: z.enum(['create', 'send', 'cancel', 'cleanup']),
    state: z.enum(['pending', 'accepted', 'abandoned', 'rejected', 'unknown']),
    userTurnId: id.optional(),
    assistantTurnId: id.optional(),
    message: z.string().max(500).optional(),
  })
  .strict();
export type TaskOperationView = z.infer<typeof taskOperationViewSchema>;
export const taskSlotViewSchema = z
  .object({
    taskId: id,
    childSessionId: id,
    sessionCreated: z.boolean(),
    title: z.string().max(120),
    agentId: id,
    completion: z.string().max(2000),
    status: z.enum(['reserved', 'preparing', 'ready', 'running', 'terminal', 'unknown']),
    turnsUsed: z.number().int().min(0).max(TASK_LIMITS.turns),
    userTurnId: id.optional(),
    assistantTurnId: id.optional(),
    lastOperationId: id.optional(),
    execution: sessionExecutionSchema.optional(),
    terminal: z.enum(['success', 'failed', 'canceled', 'interrupted']).optional(),
    goalVerified: z.literal(false),
  })
  .strict();
export type TaskSlotView = z.infer<typeof taskSlotViewSchema>;
export const taskGrantViewSchema = z
  .object({
    grantId: id,
    parentSessionId: id,
    parentUserTurnId: id,
    parentAssistantTurnId: id,
    state: z.enum(['active', 'expired', 'interrupted', 'canceled']),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    plan: taskPlanSchema,
    tasks: z.array(taskSlotViewSchema).max(TASK_LIMITS.tasks),
    operations: z.array(taskOperationViewSchema).max(128),
  })
  .strict();
export type TaskGrantView = z.infer<typeof taskGrantViewSchema>;
export const taskReadResultSchema = taskReadSchema
  .extend({
    confirmed: z.literal(true),
    grants: z.array(taskGrantViewSchema).max(20),
    truncated: z.boolean(),
  })
  .strict();
export const taskActionResultSchema = taskActionBaseSchema
  .extend({
    confirmed: z.literal(true),
    grant: taskGrantViewSchema,
    operation: taskOperationViewSchema.optional(),
  })
  .strict()
  .superRefine(checkTaskAction);
export type TaskReadResult = z.infer<typeof taskReadResultSchema>;
export type TaskActionResult = z.infer<typeof taskActionResultSchema>;
function validateGrant(grant: TaskGrantView, sessionId: string) {
  assert(grant.parentSessionId === sessionId, 502, '协作结果不属于原父会话');
  const slots = new Map(grant.plan.tasks.map((task) => [task.taskId, task]));
  assert(
    grant.tasks.length === slots.size &&
      new Set(grant.tasks.map((t) => t.taskId)).size === slots.size &&
      new Set(grant.tasks.map((t) => t.childSessionId)).size === slots.size,
    502,
    '子任务投影不完整',
  );
  for (const task of grant.tasks) {
    const spec = slots.get(task.taskId);
    assert(
      spec &&
        spec.agentId === task.agentId &&
        spec.title === task.title &&
        spec.completion === task.completion &&
        task.childSessionId !== sessionId &&
        task.turnsUsed <= grant.plan.maxTurnsPerTask,
      502,
      '子任务与原授权不匹配',
    );
  }
  assert(
    new Set(grant.operations.map((op) => op.operationId)).size === grant.operations.length &&
      grant.operations.every((op) => slots.has(op.taskId)),
    502,
    '子任务操作不属于原授权',
  );
}
export function validateTaskReadResult(raw: unknown, request: TaskRead) {
  const result = taskReadResultSchema.parse(raw);
  for (const key of [
    'taskVersion',
    'workspaceId',
    'localProjectId',
    'sessionId',
    'grantId',
  ] as const)
    assert(result[key] === request[key], 502, '协作读取范围已变化');
  assert(
    new Set(result.grants.map((g) => g.grantId)).size === result.grants.length,
    502,
    '协作授权重复',
  );
  for (const grant of result.grants) {
    validateGrant(grant, request.sessionId);
    assert(!request.grantId || grant.grantId === request.grantId, 502, '协作授权不匹配');
  }
  return result;
}
export function validateTaskActionResult(raw: unknown, request: TaskAction) {
  const result = taskActionResultSchema.parse(raw);
  for (const key of [
    'taskVersion',
    'workspaceId',
    'localProjectId',
    'sessionId',
    'grantId',
    'action',
    'operationId',
    'taskId',
    'expectedExecutionRevision',
  ] as const)
    assert(result[key] === request[key], 502, '协作操作范围已变化');
  validateGrant(result.grant, request.sessionId);
  assert(
    result.grant.grantId === request.grantId &&
      (!result.operation ||
        (result.operation.operationId === request.operationId &&
          result.grant.tasks.some((task) => task.taskId === result.operation!.taskId) &&
          (request.action !== 'cleanup' ||
            (result.operation.kind === 'cleanup' && result.operation.taskId === request.taskId)))),
    502,
    '协作操作不属于原授权',
  );
  return result;
}

const toolScopeSchema = z.object({ grantId: id, taskId: id });
export const taskToolInputSchemas = {
  moor_task_create: toolScopeSchema.extend({ operationId: id }).strict(),
  moor_task_read: toolScopeSchema
    .extend({
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    })
    .strict(),
  moor_task_send: toolScopeSchema
    .extend({
      operationId: id,
      expectedUserTurnId: id.nullable(),
      prompt: z.string().trim().min(1).max(TASK_LIMITS.instructionCharacters).optional(),
    })
    .strict(),
  moor_task_wait: toolScopeSchema
    .extend({ expectedUserTurnId: id, timeoutMs: z.number().int().min(1).max(TASK_LIMITS.waitMs) })
    .strict(),
  moor_task_cancel: toolScopeSchema
    .extend({ operationId: id, expectedAssistantTurnId: id })
    .strict(),
} as const;
export type TaskToolName = keyof typeof taskToolInputSchemas;
const stringId = { type: 'string', minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9_:-]+$' };
const properties = { grantId: stringId, taskId: stringId };
const definition = (
  name: TaskToolName,
  description: string,
  extra: Record<string, unknown>,
  required: string[],
) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: { ...properties, ...extra },
    required: ['grantId', 'taskId', ...required],
    additionalProperties: false,
  },
});
export const taskToolDefinitions = [
  definition(
    'moor_task_create',
    'Create only a user-authorized child task in its fixed isolated Git worktree. Does not send its instruction. Unknown operations require manual user recovery; never change IDs to retry.',
    { operationId: stringId },
    ['operationId'],
  ),
  definition(
    'moor_task_read',
    'Read bounded history of an authorized child. Terminal output is not proof the user completion condition has been met.',
    {
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
    },
    [],
  ),
  definition(
    'moor_task_send',
    'Send to the authorized child with an exact history head. The first turn uses the user-approved instruction; followups require prompt and consume the finite turn budget. Unknown sends require manual user recovery.',
    {
      operationId: stringId,
      expectedUserTurnId: { anyOf: [stringId, { type: 'null' }] },
      prompt: { type: 'string', minLength: 1, maxLength: TASK_LIMITS.instructionCharacters },
    },
    ['operationId', 'expectedUserTurnId'],
  ),
  definition(
    'moor_task_wait',
    'Wait for the specified child user turn, up to 20 seconds. Timeout does not stop the child or establish goal completion.',
    {
      expectedUserTurnId: stringId,
      timeoutMs: { type: 'integer', minimum: 1, maximum: TASK_LIMITS.waitMs },
    },
    ['expectedUserTurnId', 'timeoutMs'],
  ),
  definition(
    'moor_task_cancel',
    'Stop only the exact active assistant turn in the authorized child. Does not cancel future turns or answer permissions.',
    { operationId: stringId, expectedAssistantTurnId: stringId },
    ['operationId', 'expectedAssistantTurnId'],
  ),
] as const;
