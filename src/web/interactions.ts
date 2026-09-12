import { z } from 'zod';
import { id } from '../protocol';
import {
  questionAnswerSchema,
  questionReceiptSchema,
  questionRequestSchema,
  steerReceiptSchema,
  steerRequestSchema,
  validateQuestionAnswer,
  type QuestionAnswer,
  type QuestionRequest,
} from '../interaction-protocol';
import {
  applySessionEvent,
  sessionEventSchema,
  type AccountRateLimit,
  type SessionEventState,
} from '../runtime/session-events';
import { ApiError } from './api';
import { esc, markdown } from './content';

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
      request: (path: string, body: unknown) => Promise<unknown>;
      onChange?: () => void;
      uuid?: () => string;
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
      operationId: (this.dependencies.uuid ?? (() => crypto.randomUUID()))(),
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
  steer(expectedTurnId: string, prompt: string, target: InteractionTarget) {
    const payload = steerRequestSchema.parse({
      workspaceId: this.scope.workspaceId,
      localProjectId: this.scope.localProjectId,
      sessionId: this.scope.sessionId,
      expectedTurnId,
      operationId: (this.dependencies.uuid ?? (() => crypto.randomUUID()))(),
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
    );
  }
  retry(target: InteractionTarget) {
    if (!this.pending) throw new Error('没有待确认交互。');
    return this.deliver(this.pending, target, true);
  }
  private async deliver(operation: PendingInteraction, target: InteractionTarget, retry: boolean) {
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
          `/api/workspaces/${original.catalogWorkspaceId}/replicas/${original.replicaId}/${original.kind === 'question' ? 'question-answers' : 'steer'}`,
          original.request,
        );
      } catch (error) {
        // Only the host can prove an operation was never staged. Timeouts keep the exact request.
        if (error instanceof ApiError && error.rejected)
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
export type SteerItem = z.infer<typeof steerItemSchema>;
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
const count = (value: number | undefined) =>
  value === undefined ? '未提供' : esc(value.toLocaleString());
const rateLimitStatuses = {
  allowed: '可用',
  allowed_warning: '接近限额',
  rejected: '已受限',
};
const rateLimitWindows = {
  five_hour: '5 小时',
  seven_day: '7 天',
  seven_day_opus: '7 天 · Opus',
  seven_day_sonnet: '7 天 · Sonnet',
  seven_day_overage_included: '7 天 · 包含的额外用量',
  overage: '额外用量',
};
const overageReasons = {
  overage_not_provisioned: '未开通额外用量',
  org_level_disabled: '组织已停用',
  org_level_disabled_until: '组织暂时停用',
  out_of_credits: '额度已耗尽',
  seat_tier_level_disabled: '席位等级不支持',
  member_level_disabled: '成员已停用',
  seat_tier_zero_credit_limit: '席位额度上限为零',
  group_zero_credit_limit: '组额度上限为零',
  member_zero_credit_limit: '成员额度上限为零',
  org_service_level_disabled: '组织服务已停用',
  no_limits_configured: '未配置额度',
  fetch_error: 'Agent 未能读取额外用量',
  unknown: 'Agent 未提供具体原因',
};
const resetTime = (seconds: number | undefined) =>
  seconds === undefined ? '未提供' : esc(new Date(seconds * 1000).toISOString());
function rateLimitHtml(value: AccountRateLimit) {
  const overage =
    value.overageStatus !== undefined ||
    value.overageResetsAt !== undefined ||
    value.overageDisabledReason !== undefined;
  return `<section class="agent-rate-limit"><h4>${value.rateLimitType ? rateLimitWindows[value.rateLimitType] : '窗口未提供'}</h4><p class="muted">来源：Claude ACP ${esc(value.adapterVersion)} · Agent 最近一次上报</p><dl class="agent-usage"><dt>上报状态</dt><dd>${rateLimitStatuses[value.status]}</dd><dt>已用比例</dt><dd>${value.utilization === undefined ? '未提供' : `${esc((value.utilization * 100).toLocaleString(undefined, { maximumSignificantDigits: 15 }))}%`}</dd><dt>窗口重置时间（UTC）</dt><dd>${resetTime(value.resetsAt)}</dd>${overage ? `<dt>额外用量状态</dt><dd>${value.overageStatus ? rateLimitStatuses[value.overageStatus] : '未提供'}</dd><dt>额外用量重置时间（UTC）</dt><dd>${resetTime(value.overageResetsAt)}</dd><dt>额外用量不可用原因</dt><dd>${value.overageDisabledReason ? overageReasons[value.overageDisabledReason] : '未提供'}</dd>` : ''}</dl></section>`;
}
export function informationHtml(state: SessionEventState) {
  const context = state.contextUsage,
    tokens = state.tokenUsage;
  const plans = state.plans
    .map(
      (plan) =>
        `<section class="agent-plan">${plan.planId ? `<h4>${esc(plan.planId)}</h4>` : ''}${plan.content.format === 'markdown' ? markdown(plan.content.text) : plan.content.format === 'file' ? `<p>文件计划引用：<code>${esc(plan.content.uri)}</code></p><p class="muted">引用尚未解析；不会自动读取或访问该地址。</p>` : `<ol>${plan.content.entries.map((entry) => `<li><span class="plan-status">${esc({ pending: '待处理', in_progress: '进行中', completed: '已完成' }[entry.status])} · ${esc({ high: '高', medium: '中', low: '低' }[entry.priority])}优先级</span><span>${esc(entry.content)}</span></li>`).join('')}</ol>`}</section>`,
    )
    .join('');
  return `<section class="agent-information"><p class="muted">来源：Agent 通过 ACP 上报。以下是最近一次原始计数；不会跨回合相加。</p><h3>计划</h3>${plans || `<p>${state.planObserved ? '当前没有计划条目' : '未提供计划'}</p>`}<h3>用量</h3><dl class="agent-usage"><dt>上下文已用 / 容量</dt><dd>${count(context?.used)} / ${count(context?.size)}</dd><dt>费用</dt><dd>${context?.cost ? `${esc(context.cost.amount)} ${esc(context.cost.currency)}` : '未提供'}</dd>${(
    [
      ['总 token', tokens?.totalTokens],
      ['输入 token', tokens?.inputTokens],
      ['输出 token', tokens?.outputTokens],
      ['思考 token', tokens?.thoughtTokens],
      ['缓存读取 token', tokens?.cachedReadTokens],
      ['缓存写入 token', tokens?.cachedWriteTokens],
    ] as const
  )
    .map(([label, value]) => `<dt>${label}</dt><dd>${count(value)}</dd>`)
    .join(
      '',
    )}</dl><p class="muted">token 范围由 Agent 报告，未推断为本回合增量；费用仅显示上报币种与金额。</p><h3>账号额度</h3>${state.rateLimits?.length ? state.rateLimits.map(rateLimitHtml).join('') : '<p>Agent 未提供可验证的账号额度报告</p>'}<p class="muted">各窗口分别保留最后一次上报，不代表当前实时余额，也不跨窗口相加。重置时间到达后不会推断额度已恢复；离线时仅显示已读历史。</p></section>`;
}
export function renderInteractionItem(item: unknown, key: string): string | undefined {
  const value = item as any;
  if (value?.type === 'question') {
    const parsed = questionItemSchema.safeParse(value);
    if (!parsed.success) return '<p class="interaction-warning">问题记录不可用</p>';
    const q = parsed.data;
    return `<section class="interaction-history"><strong>Agent 问题 · ${questionStatus[q.status]}</strong><p>${esc(q.request.title ?? q.request.message)}</p>${q.request.title ? `<p>${esc(q.request.message)}</p>` : ''}<button type="button" data-open-question="${esc(questionDraftKey(q.request))}">查看${q.status === 'pending' ? '并回答' : ''}问题</button></section>`;
  }
  if (value?.type === 'steer') {
    const parsed = steerItemSchema.safeParse(value);
    if (!parsed.success) return '<p class="interaction-warning">追加记录不可用</p>';
    return `<section class="interaction-history"><strong>回合内追加 · ${steerStatus[parsed.data.status]}</strong><p>${esc(parsed.data.prompt)}</p>${parsed.data.message ? `<p>${esc(parsed.data.message)}</p>` : ''}</section>`;
  }
  if (value?.type === 'agent_features') return '';
  if (value?.type === 'session_event') {
    const parsed = sessionEventSchema.safeParse(value.event);
    if (!parsed.success) return '<p class="interaction-warning">运行事件格式不可用</p>';
    const event = parsed.data;
    if (event.kind === 'commands')
      return `<details class="interaction-history" data-detail="${esc(key)}"><summary>Agent 命令快照 · ${event.commands.length}</summary><p class="muted">命令仅可填入输入框，由你手动发送。</p>${event.commands.map((command) => `<p><code>${esc(command.name)}</code> ${esc(command.description)}</p>`).join('') || '<p>Agent 未提供可用命令</p>'}</details>`;
    if (event.kind === 'plan-removed')
      return `<p class="muted">Agent 已移除计划：${esc(event.planId)}</p>`;
    return `<details class="interaction-history" data-detail="${esc(key)}"><summary>${event.kind === 'plan' ? '计划快照' : '用量快照'} · ACP</summary>${informationHtml(applySessionEvent(undefined, event))}</details>`;
  }
}
