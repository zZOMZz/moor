import {
  questionAnswerSchema,
  questionReceiptSchema,
  questionRequestSchema,
  steerReceiptSchema,
  steerRequestSchema,
  validateQuestionAnswer,
  type QuestionAnswer,
  type QuestionRequest,
} from '@moor/protocol/interaction-protocol';
import { id } from '@moor/protocol/protocol';
import { isRequestRejected } from '@moor/protocol/request-failure';
import { sessionEventSchema, type SessionEventState } from '@moor/protocol/session-events';
import { applySessionEvent } from '@moor/session/session-events';
import { z } from 'zod';

const scopeSchema = z
  .object({
    owner: z.string().min(1),
    deviceId: id,
    workspaceId: id,
    localProjectId: id,
    sessionId: id,
  })
  .strict();
export type InteractionScope = z.infer<typeof scopeSchema>;
export type InteractionTarget = InteractionScope & {
  catalogWorkspaceId: string;
  replicaId: string;
};
const routing = { owner: z.string().min(1), deviceId: id, catalogWorkspaceId: id, replicaId: id };
export const pendingInteractionSchema = z.discriminatedUnion('kind', [
  z.object({ ...routing, kind: z.literal('question'), request: questionAnswerSchema }).strict(),
  z.object({ ...routing, kind: z.literal('steer'), request: steerRequestSchema }).strict(),
]);
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;
const value = z.union([
  z.string().max(16000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(16000)).max(100),
]);
export const draftValuesSchema = z.record(z.string(), value);
export type QuestionDraftValues = z.infer<typeof draftValuesSchema>;
const closedSchema = z
  .object({
    operation: pendingInteractionSchema,
    outcome: z.enum(['not-injected', 'unknown']),
    message: z.string(),
  })
  .strict();
const savedSchema = z
  .object({
    version: z.literal(1),
    drafts: z.record(z.string(), draftValuesSchema),
    steerDraft: z.string().max(16000),
    pending: pendingInteractionSchema.optional(),
    closed: z.array(closedSchema).max(50),
  })
  .strict();
export const interactionSavedSchema = savedSchema;
export type InteractionSaved = z.infer<typeof savedSchema>;
export const emptyInteractionSaved = (): InteractionSaved => ({
  version: 1,
  drafts: {},
  steerDraft: '',
  closed: [],
});
type Saved = z.infer<typeof savedSchema>;
export function interactionKey(scope: InteractionScope) {
  return (
    'interaction-v1/' +
    JSON.stringify([
      scope.owner,
      scope.deviceId,
      scope.workspaceId,
      scope.localProjectId,
      scope.sessionId,
    ])
  );
}
export function questionDraftKey(request: Pick<QuestionRequest, 'expectedTurnId' | 'requestId'>) {
  return JSON.stringify([request.expectedTurnId, request.requestId]);
}
export function interactionScope(operation: PendingInteraction): InteractionScope {
  return {
    owner: operation.owner,
    deviceId: operation.deviceId,
    workspaceId: operation.request.workspaceId,
    localProjectId: operation.request.localProjectId,
    sessionId: operation.request.sessionId,
  };
}
export function routeInteraction(
  operation: PendingInteraction,
  target: InteractionTarget,
): PendingInteraction {
  if (interactionKey(interactionScope(operation)) !== interactionKey(target))
    throw new Error('交互请求的执行身份已改变，请重新打开原会话。');
  return {
    ...operation,
    catalogWorkspaceId: target.catalogWorkspaceId,
    replicaId: target.replicaId,
  };
}
export function questionDefaults(request: QuestionRequest): QuestionDraftValues {
  return Object.fromEntries(
    request.fields
      .filter((field) => field.default !== undefined)
      .map((field) => [field.id, structuredClone(field.default!)]),
  );
}
export function answerFromDraft(
  request: QuestionRequest,
  values: QuestionDraftValues,
): QuestionAnswer['answer'] {
  const result: QuestionDraftValues = {};
  for (const field of request.fields) {
    if (!Object.hasOwn(values, field.id)) continue;
    const value = values[field.id];
    if (field.kind === 'number') {
      if (value === '') continue;
      result[field.id] = typeof value === 'string' ? Number(value) : value;
    } else result[field.id] = value;
  }
  return { action: 'accept', values: result };
}

/** Loading and draft edits never transmit. Every attempt is an explicit user action. */
export class InteractionController {
  private saved: Saved = { version: 1, drafts: {}, steerDraft: '', closed: [] };
  private queue: Promise<unknown> = Promise.resolve();
  busy = false;
  constructor(
    readonly scope: InteractionScope,
    private readonly dependencies: {
      read: <T>(key: string) => Promise<T | undefined>;
      write: (key: string, value: unknown) => Promise<void>;
      request: (method: 'answer-question' | 'steer', body: unknown) => Promise<unknown>;
      onChange?: () => void;
      uuid: () => string;
    },
  ) {
    this.scope = Object.freeze(
      scopeSchema.parse({
        owner: scope.owner,
        deviceId: scope.deviceId,
        workspaceId: scope.workspaceId,
        localProjectId: scope.localProjectId,
        sessionId: scope.sessionId,
      }),
    );
  }
  get pending() {
    return this.saved.pending ? structuredClone(this.saved.pending) : undefined;
  }
  get steerDraft() {
    return this.saved.steerDraft;
  }
  get closed() {
    return structuredClone(this.saved.closed);
  }
  questionDraft(request: QuestionRequest) {
    return structuredClone(
      this.saved.drafts[questionDraftKey(request)] ?? questionDefaults(request),
    );
  }
  async load() {
    const stored = await this.dependencies.read(interactionKey(this.scope));
    const parsed = stored === undefined ? this.saved : savedSchema.parse(stored);
    for (const operation of [parsed.pending, ...parsed.closed.map((item) => item.operation)])
      if (operation && interactionKey(interactionScope(operation)) !== interactionKey(this.scope))
        throw new Error('本地交互草稿不属于当前会话。');
    this.saved = parsed;
    this.dependencies.onChange?.();
  }
  private save(update: (previous: Saved) => Saved) {
    const next = this.queue.then(async () => {
      const next = savedSchema.parse(update(this.saved));
      await this.dependencies.write(interactionKey(this.scope), next);
      this.saved = next;
      this.dependencies.onChange?.();
    });
    this.queue = next.catch(() => {});
    return next;
  }
  saveQuestionDraft(request: QuestionRequest, values: QuestionDraftValues) {
    this.assertQuestion(request);
    if (this.busy || this.pending) return Promise.resolve();
    const copy = draftValuesSchema.parse(values);
    return this.save((previous) => ({
      ...previous,
      drafts: { ...previous.drafts, [questionDraftKey(request)]: copy },
    }));
  }
  saveSteerDraft(prompt: string) {
    if (this.busy || this.pending) return Promise.resolve();
    return this.save((previous) => ({ ...previous, steerDraft: prompt }));
  }
  private assertQuestion(request: QuestionRequest) {
    questionRequestSchema.parse(request);
    if (
      request.workspaceId !== this.scope.workspaceId ||
      request.localProjectId !== this.scope.localProjectId ||
      request.sessionId !== this.scope.sessionId
    )
      throw new Error('问题不属于当前会话。');
  }
  answer(request: QuestionRequest, answer: QuestionAnswer['answer'], target: InteractionTarget) {
    this.assertQuestion(request);
    const payload = validateQuestionAnswer(request, {
      interactionVersion: 1,
      workspaceId: request.workspaceId,
      localProjectId: request.localProjectId,
      sessionId: request.sessionId,
      expectedTurnId: request.expectedTurnId,
      requestId: request.requestId,
      operationId: this.dependencies.uuid(),
      answer,
    });
    return this.deliver(
      {
        kind: 'question',
        owner: this.scope.owner,
        deviceId: this.scope.deviceId,
        catalogWorkspaceId: target.catalogWorkspaceId,
        replicaId: target.replicaId,
        request: payload,
      },
      target,
      false,
    );
  }
  steer(
    expectedTurnId: string,
    prompt: string,
    target: InteractionTarget,
    onDelivered?: () => void,
  ) {
    const payload = steerRequestSchema.parse({
      workspaceId: this.scope.workspaceId,
      localProjectId: this.scope.localProjectId,
      sessionId: this.scope.sessionId,
      expectedTurnId,
      operationId: this.dependencies.uuid(),
      prompt,
    });
    return this.deliver(
      {
        kind: 'steer',
        owner: this.scope.owner,
        deviceId: this.scope.deviceId,
        catalogWorkspaceId: target.catalogWorkspaceId,
        replicaId: target.replicaId,
        request: payload,
      },
      target,
      false,
      onDelivered,
    );
  }
  retry(target: InteractionTarget) {
    if (!this.pending) throw new Error('没有待确认交互。');
    return this.deliver(this.pending, target, true);
  }
  private async deliver(
    operation: PendingInteraction,
    target: InteractionTarget,
    retry: boolean,
    onDelivered?: () => void,
  ) {
    if (this.busy || (!retry && this.pending)) throw new Error('请先确认或关闭原交互记录。');
    const original = pendingInteractionSchema.parse(routeInteraction(operation, target));
    if (interactionKey(interactionScope(original)) !== interactionKey(this.scope))
      throw new Error('交互范围不匹配。');
    this.busy = true;
    this.dependencies.onChange?.();
    try {
      await this.save((previous) => ({ ...previous, pending: original }));
      let response: unknown;
      try {
        response = await this.dependencies.request(
          operation.kind === 'question' ? 'answer-question' : 'steer',
          original.request,
        );
      } catch (error) {
        // Only the host can prove an operation was never staged. Timeouts keep the exact request.
        if (isRequestRejected(error))
          await this.save((previous) => ({ ...previous, pending: undefined }));
        throw error;
      }
      const parsed = (
        original.kind === 'question' ? questionReceiptSchema : steerReceiptSchema
      ).safeParse(response);
      const fields = [
        'workspaceId',
        'localProjectId',
        'sessionId',
        'expectedTurnId',
        'operationId',
      ] as const;
      if (
        !parsed.success ||
        fields.some((field) => parsed.data[field] !== original.request[field]) ||
        (original.kind === 'question' &&
          (!('requestId' in parsed.data) || parsed.data.requestId !== original.request.requestId))
      )
        throw new Error('交互尚未获得有效的主机确认，请手动重试原请求。');
      onDelivered?.();
      try {
        await this.save((previous) => {
          const drafts = { ...previous.drafts };
          if (original.kind === 'question') delete drafts[questionDraftKey(original.request)];
          return {
            ...previous,
            pending: undefined,
            drafts,
            steerDraft: original.kind === 'steer' ? '' : previous.steerDraft,
          };
        });
      } catch (cause) {
        throw new Error('交互已送达，但本机确认状态未能更新；请核查原交互，不要重新提交。', {
          cause,
        });
      }
      return parsed.data;
    } finally {
      this.busy = false;
      this.dependencies.onChange?.();
    }
  }
  async dismiss(outcome: 'not-injected' | 'unknown', message: string) {
    if (this.busy || !this.pending) throw new Error('交互操作尚未结束。');
    await this.save((previous) => ({
      ...previous,
      pending: undefined,
      closed: [...previous.closed.slice(-49), { operation: previous.pending!, outcome, message }],
    }));
  }
}

export const questionItemSchema = z.object({
  type: z.literal('question'),
  request: questionRequestSchema,
  status: z.enum(['pending', 'answered', 'cancelled', 'expired']),
  answer: questionAnswerSchema.shape.answer.optional(),
  operationId: id.optional(),
});
export const steerItemSchema = z.object({
  type: z.literal('steer'),
  operationId: id,
  expectedTurnId: id,
  prompt: z.string().max(16000),
  status: z.enum(['pending', 'delivered', 'not-injected', 'unknown']),
  message: z.string().optional(),
});
export const interactionCapabilitiesSchema = z.object({
  questions: z.boolean(),
  steer: z.boolean(),
  steerUnavailableReason: z.string().optional(),
});
export type QuestionItem = z.infer<typeof questionItemSchema>;
export const questionStatus = {
  pending: '等待回答',
  answered: '已回答',
  cancelled: '已取消',
  expired: '已失效',
};
export const steerStatus = {
  pending: '送达待确认',
  delivered: '已送达活动回合',
  'not-injected': '未进入活动回合',
  unknown: '结果未知',
};
export function sessionInformation(items: unknown[]): SessionEventState {
  let state: SessionEventState = { version: 1, plans: [] };
  for (const item of items) {
    const value = item as any;
    if (value?.type !== 'session_event') continue;
    const parsed = sessionEventSchema.safeParse(value.event);
    if (parsed.success) state = applySessionEvent(state, parsed.data);
  }
  return state;
}
