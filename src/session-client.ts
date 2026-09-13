import { z } from 'zod';
import { agentSchema, mutationSchema, id } from './protocol';
import { decode, delta, Flock, LoroDoc, mirror, putMeta, vv } from './model';
import { resolveRunSelection, type RunSelection } from './run-config';
import { sessionReadResponseSchema, validateSessionBundle } from './session-responses';
import { taskPlanSchema, type TaskPlan } from './task-protocol';
import { mcpServerIdsSchema } from './mcp-protocol';
import { permissionItemJson, PERMISSION_REVIEW_MAX_BYTES } from './permission-review';
import { promptAttachmentsSchema } from './attachment-protocol';
import type { AttachmentReference } from './content-protocol';
export type SessionClientScope = {
  userId: string;
  machineId: string;
  workspaceId: string;
  localProjectId: string;
  sessionId: string;
};
export function readClientSession(raw: unknown, scope: SessionClientScope) {
  const result = sessionReadResponseSchema.parse(raw);
  validateSessionBundle(result);
  if (
    result.meta.id !== scope.sessionId ||
    result.meta.userId !== scope.userId ||
    result.meta.machineId !== scope.machineId ||
    result.meta.project.localProjectId !== scope.localProjectId
  )
    throw new Error('会话响应与原执行范围不匹配');
  const doc = new LoroDoc();
  try {
    doc.import(decode(result.update));
    const view = mirror(doc, scope.sessionId);
    try {
      const state = view.getState();
      if (state.session.id !== scope.sessionId) throw new Error('会话文档身份不匹配');
      return { ...result, history: structuredClone(state.history) };
    } finally {
      view.dispose();
    }
  } finally {
    doc.free();
  }
}
export function buildSessionTurn(input: {
  scope: SessionClientScope;
  read: unknown;
  agent: z.infer<typeof agentSchema>;
  prompt: string;
  selection?: RunSelection;
  operationId: string;
  turnId: string;
  peerId: string;
  now: string;
  taskPlan?: TaskPlan;
  mcpServerIds?: string[];
  /** The caller obtains these from confirmed uploads for this exact execution target. */
  attachments?: AttachmentReference[];
}) {
  const read = readClientSession(input.read, input.scope),
    agent = agentSchema.parse(input.agent),
    taskPlan = input.taskPlan === undefined ? undefined : taskPlanSchema.parse(input.taskPlan),
    attachments = promptAttachmentsSchema.parse(input.attachments ?? []);
  if (taskPlan && read.meta.taskOrigin) throw new Error('子任务不能创建下一层协作任务');
  if (read.persisted === false || read.persistenceError)
    throw new Error('主机结果尚未持久保存，不能据此发送新指令');
  if (read.meta.isArchived) throw new Error('请先恢复会话');
  if (
    read.meta.status?.type === 'working' ||
    read.history.some((t) => t.role === 'assistant' && !t.finished)
  )
    throw new Error('当前回合尚未结束');
  if (
    read.meta.agentConfigId !== agent.id ||
    read.meta.cliType !== agent.cliType ||
    read.meta.agentType !== agent.agentType
  )
    throw new Error('Agent 与会话固定版本不匹配');
  if (
    (!input.prompt.trim() && attachments.length === 0) ||
    input.prompt.length > 100000 ||
    new TextEncoder().encode(input.prompt).byteLength > 1024 * 1024
  )
    throw new Error('指令必须在 100000 字符且 1 MiB 以内，并包含文本或附件');
  for (const attachment of attachments) {
    const category = attachment.content.mediaType.split('/')[0];
    if (
      !agent.inputCapabilities?.[
        category === 'image' ? 'image' : category === 'audio' ? 'audio' : 'embeddedContext'
      ]
    )
      throw Error('当前 Agent 不支持所选附件类型，请移除附件或选择支持的 Agent。');
  }
  const time = z.string().datetime().parse(input.now),
    doc = new LoroDoc();
  doc.import(decode(read.update));
  const flock = Flock.fromJson(
      read.metaBundle as Parameters<typeof Flock.fromJson>[0],
      input.peerId,
    ),
    before = vv(doc),
    version = flock.version(),
    view = mirror(doc, input.scope.sessionId);
  try {
    const run = resolveRunSelection(input.selection ?? {}, agent.runConfig);
    view.setState((s) => {
      s.history.push({
        id: input.turnId,
        role: 'user',
        userId: input.scope.userId,
        timestamp: time,
        status: 'pending',
        finished: true,
        read: undefined,
        userTurnId: undefined,
        inputConfig: {
          ...run,
          prompt: input.prompt,
          cliType: agent.cliType,
          agentType: agent.agentType,
          mcpServerIds: mcpServerIdsSchema.parse(input.mcpServerIds ?? []),
          taskToolsEnabled: !!taskPlan,
          ...(taskPlan ? { taskPlan } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
        items: [
          { type: 'text', text: input.prompt },
          ...attachments.map((attachment) => ({ type: 'attachment' as const, attachment })),
        ],
        fileDiff: null,
      });
    });
    doc.commit();
    putMeta(flock, 'session-' + input.scope.sessionId, {
      latestUserMsgId: input.turnId,
      lastMessageAt: Date.parse(time),
    });
    return mutationSchema.parse({
      operationId: input.operationId,
      workspaceId: input.scope.workspaceId,
      sessionId: input.scope.sessionId,
      kind: 'turn',
      expectedTurnId: read.meta.latestUserMsgId ?? null,
      update: delta(doc, before),
      metaBundle: flock.exportJson(version),
    });
  } finally {
    view.dispose();
    doc.free();
  }
}

const permissionScopeSchema = z
  .object({
    userId: z.string().min(1).max(160),
    machineId: id,
    workspaceId: id,
    localProjectId: id,
    sessionId: id,
  })
  .strict();
const permissionOptionSchema = z.object({
  optionId: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !/[\x00-\x1f\x7f]/u.test(value)),
  name: z.string().min(1).max(1000),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});
const permissionOptionsSchema = z
  .array(permissionOptionSchema)
  .min(1)
  .max(64)
  .refine((options) => new Set(options.map((option) => option.optionId)).size === options.length);
const permissionReviewSchema = z
  .object({
    version: z.literal(1),
    scope: permissionScopeSchema,
    expectedUserTurnId: id,
    assistantTurnId: id,
    requestId: id,
    itemJson: z.string().max(PERMISSION_REVIEW_MAX_BYTES),
    options: permissionOptionsSchema,
  })
  .strict();
export type SessionPermissionReview = z.infer<typeof permissionReviewSchema>;
export const sessionPermissionOutcomeSchema = z.discriminatedUnion('outcome', [
  z
    .object({ outcome: z.literal('selected'), optionId: permissionOptionSchema.shape.optionId })
    .strict(),
  z.object({ outcome: z.literal('cancelled') }).strict(),
]);
export type SessionPermissionOutcome = z.infer<typeof sessionPermissionOutcomeSchema>;

function permissionOwn(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw Error('审批内容格式不受支持。');
  return descriptor.value;
}
/** Extract once from a verified read; the UI keeps this exact snapshot until the user reviews it again. */
export function sessionPermissionReviews(
  read: Pick<
    ReturnType<typeof readClientSession>,
    'meta' | 'history' | 'persisted' | 'persistenceError'
  >,
  rawScope: SessionClientScope,
): SessionPermissionReview[] {
  try {
    const scope = permissionScopeSchema.parse({
      userId: rawScope.userId,
      machineId: rawScope.machineId,
      workspaceId: rawScope.workspaceId,
      localProjectId: rawScope.localProjectId,
      sessionId: rawScope.sessionId,
    });
    if (
      read.persisted === false ||
      read.persistenceError ||
      read.meta.isArchived ||
      read.meta.id !== scope.sessionId ||
      read.meta.userId !== scope.userId ||
      read.meta.machineId !== scope.machineId ||
      read.meta.project.localProjectId !== scope.localProjectId
    )
      return [];
    const expectedUserTurnId = id.parse(read.meta.latestUserMsgId);
    const active = read.history.filter((turn) => turn.role === 'assistant' && !turn.finished);
    if (active.length !== 1 || active[0].userTurnId !== expectedUserTurnId) return [];
    const assistant = active[0],
      counts = new Map<string, number>();
    for (const turn of read.history)
      for (const raw of turn.items ?? []) {
        if (!raw || typeof raw !== 'object') continue;
        const request = permissionOwn(raw, 'permissionRequest');
        const requestId =
          request && typeof request === 'object' ? permissionOwn(request, 'requestId') : undefined;
        if (typeof requestId === 'string') counts.set(requestId, (counts.get(requestId) ?? 0) + 1);
      }
    const reviews: SessionPermissionReview[] = [];
    for (const raw of assistant.items ?? []) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (permissionOwn(item, 'type') !== 'tool_call' || !permissionOwn(item, 'permissionRequest'))
        continue;
      if (
        !z
          .string()
          .min(1)
          .max(1000)
          .refine((value) => !/[\x00-\x1f\x7f]/u.test(value))
          .safeParse(permissionOwn(item, 'toolCallId')).success
      )
        return [];
      const itemJson = permissionItemJson(item);
      const snapshot = JSON.parse(itemJson) as {
        permissionRequest: { requestId?: unknown; outcome?: unknown; options?: unknown };
      };
      const request = snapshot.permissionRequest;
      if (request.outcome !== undefined && request.outcome !== null) continue;
      const requestId = id.parse(request.requestId);
      if (counts.get(requestId) !== 1 || reviews.length >= 64) return [];
      const options = permissionOptionsSchema.parse(request.options);
      reviews.push(
        permissionReviewSchema.parse({
          version: 1,
          scope,
          expectedUserTurnId,
          assistantTurnId: assistant.id,
          requestId,
          itemJson,
          options,
        }),
      );
    }
    return reviews;
  } catch {
    return [];
  }
}

export function buildSessionPermission(input: {
  scope: SessionClientScope;
  read: unknown;
  review: SessionPermissionReview;
  outcome: SessionPermissionOutcome;
  operationId: string;
}) {
  const review = permissionReviewSchema.parse(input.review),
    outcome = sessionPermissionOutcomeSchema.parse(input.outcome);
  const read = readClientSession(input.read, input.scope);
  const current = sessionPermissionReviews(read, input.scope).find(
    (entry) =>
      entry.assistantTurnId === review.assistantTurnId && entry.requestId === review.requestId,
  );
  if (!current || JSON.stringify(current) !== JSON.stringify(review))
    throw Error('审批回合、请求或操作内容已改变，请重新读取并审阅。');
  if (
    outcome.outcome === 'selected' &&
    !current.options.some((option) => option.optionId === outcome.optionId)
  )
    throw Error('审批选项不属于已审阅的请求。');
  const doc = new LoroDoc();
  try {
    doc.import(decode(read.update));
    const before = vv(doc),
      view = mirror(doc, input.scope.sessionId);
    try {
      view.setState((state) => {
        const turn = state.history.find((entry) => entry.id === review.assistantTurnId)!;
        const item = turn.items!.find(
          (entry: any) => entry.permissionRequest?.requestId === review.requestId,
        ) as { permissionRequest: { outcome?: unknown } };
        item.permissionRequest.outcome = outcome;
      });
      doc.commit();
      return mutationSchema.parse({
        operationId: id.parse(input.operationId),
        workspaceId: input.scope.workspaceId,
        sessionId: input.scope.sessionId,
        kind: 'permission',
        expectedTurnId: review.expectedUserTurnId,
        requestId: review.requestId,
        permissionReview: {
          version: 1,
          assistantTurnId: review.assistantTurnId,
          itemJson: review.itemJson,
        },
        update: delta(doc, before),
      });
    } finally {
      view.dispose();
    }
  } finally {
    doc.free();
  }
}
