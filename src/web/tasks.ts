import { z } from 'zod';
import { id, mutationSchema, type Mutation } from '../protocol';
import {
  taskPlanSchema,
  taskSpecSchema,
  taskActionSchema,
  taskReadSchema,
  validateTaskReadResult,
  validateTaskActionResult,
  type TaskPlan,
  type TaskAction,
  type TaskReadResult,
  type TaskActionResult,
} from '../task-protocol';
import { resolveRunSelection, type RunCapabilities } from '../run-config';
import {
  gitTargetSchema,
  gitWorkspaceKey,
  type GitTarget,
  type GitWorkspaceDependencies,
} from './git-workspace';
import type { DraftBundleEntry } from './cache';
export const taskDraftSchema = z
  .object({
    version: z.literal(1),
    tasks: z
      .array(
        z
          .object({
            taskId: id,
            title: z.string().max(120),
            agentId: z.string().max(160),
            instruction: z.string().max(10000),
            completion: z.string().max(2000),
            selection: taskSpecSchema.shape.selection,
            baseBranch: z.string().max(300),
            expectedOid: z.string().max(64),
          })
          .strict(),
      )
      .max(8),
    maxParallel: z.number().int().min(1).max(4),
    maxTurnsPerTask: z.number().int().min(1).max(3),
    timeoutMs: z.number().int().min(1000).max(3600000),
    onParentEnd: z.literal('cancel'),
  })
  .strict();
export type TaskDraft = z.infer<typeof taskDraftSchema>;
const reviewedSchema = z.object({ reviewId: id, parentAgentId: id, plan: taskPlanSchema }).strict();
export type ReviewedTasks = z.infer<typeof reviewedSchema>;
const deliverySchema = z
  .object({
    operationId: id,
    review: reviewedSchema,
    requestVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type TaskDelivery = z.infer<typeof deliverySchema>;
const storedSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().nonnegative().safe(),
    target: gitTargetSchema,
    draft: taskDraftSchema,
    enabled: reviewedSchema.optional(),
    delivery: deliverySchema.optional(),
    pending: taskActionSchema.optional(),
  })
  .strict();
type Stored = z.infer<typeof storedSchema>;
export const tasksKey = (target: GitTarget) =>
  gitWorkspaceKey(target).replace('git-workspace-v1/', 'task-draft-v1/');
export const emptyTaskDraft = (): TaskDraft => ({
  version: 1,
  tasks: [],
  maxParallel: 2,
  maxTurnsPerTask: 1,
  timeoutMs: 600000,
  onParentEnd: 'cancel',
});
export function validateTaskReview(
  draft: TaskDraft,
  context: {
    parentAgentId: string;
    child: boolean;
    agents: readonly { id: string; runConfig?: RunCapabilities }[];
    branches: readonly { name: string; oid: string }[];
  },
) {
  if (context.child) throw new Error('子任务会话不能再次授权协作任务。');
  id.parse(context.parentAgentId);
  const plan = taskPlanSchema.parse(draft);
  for (const task of plan.tasks) {
    const agent = context.agents.find((agent) => agent.id === task.agentId);
    if (!agent) throw new Error('子任务 Agent 版本已不可用于新会话，请重新选择。');
    resolveRunSelection(task.selection ?? {}, agent.runConfig);
    if (
      !context.branches.some(
        (branch) => branch.name === task.baseBranch && branch.oid === task.expectedOid,
      )
    )
      throw new Error('任务基线分支或提交已变化，请重新读取并选择。');
  }
  return plan;
}
async function mutationVersion(mutation: Mutation) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(mutationSchema.parse(mutation))),
  );
  return (
    'sha256:' +
    Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}
export type TaskDependencies = GitWorkspaceDependencies & {
  online(): boolean;
  compareSubmission(entries: readonly DraftBundleEntry[], current: () => boolean): Promise<boolean>;
};
/** Task plans are local drafts. Only the ordinary parent mutation can authorize execution. */
export class TasksController {
  readonly target: GitTarget;
  draft = emptyTaskDraft();
  enabled?: ReviewedTasks;
  delivery?: TaskDelivery;
  pending?: TaskAction;
  list?: TaskReadResult;
  receipt?: TaskActionResult;
  loaded = false;
  busy = false;
  saving = false;
  error = '';
  loadError = '';
  private cacheRevision = 0;
  private generation = 0;
  private contentGeneration = 0;
  private saved?: Stored;
  private writes: Promise<void> = Promise.resolve();
  private queued = 0;
  constructor(
    target: GitTarget,
    private deps: TaskDependencies,
  ) {
    this.target = gitTargetSchema.parse(target);
  }
  private current(generation = this.generation) {
    if (!this.deps.current() || generation !== this.generation)
      throw new Error('任务清单或执行目标已改变，请重新打开。');
  }
  private access(generation = this.generation) {
    this.current(generation);
    if (!this.deps.online()) throw new Error('当前离线；草稿不会执行，请连接后手动操作。');
  }
  private base() {
    return {
      taskVersion: 1 as const,
      workspaceId: this.target.workspaceId,
      localProjectId: this.target.localProjectId,
      sessionId: this.target.sessionId,
    };
  }
  private endpoint(kind: string) {
    return `/api/workspaces/${this.target.catalogWorkspaceId}/replicas/${this.target.replicaId}/tasks-${kind}`;
  }
  private record(extra: Partial<Stored> = {}): Stored {
    return storedSchema.parse({
      version: 1,
      cacheRevision: this.cacheRevision + 1,
      target: this.target,
      draft: this.draft,
      ...(this.enabled ? { enabled: this.enabled } : {}),
      ...(this.delivery ? { delivery: this.delivery } : {}),
      ...(this.pending ? { pending: this.pending } : {}),
      ...extra,
    });
  }
  async load() {
    try {
      const raw = await this.deps.read(tasksKey(this.target));
      this.current();
      if (raw !== undefined) {
        const saved = storedSchema.parse(raw);
        if (
          tasksKey(saved.target) !== tasksKey(this.target) ||
          (saved.pending &&
            (saved.pending.workspaceId !== this.target.workspaceId ||
              saved.pending.localProjectId !== this.target.localProjectId ||
              saved.pending.sessionId !== this.target.sessionId))
        )
          throw new Error('任务草稿范围不匹配。');
        if (
          saved.enabled &&
          JSON.stringify(saved.enabled.plan) !== JSON.stringify(taskPlanSchema.parse(saved.draft))
        )
          throw new Error('已启用任务与草稿不匹配。');
        this.saved = saved;
        this.cacheRevision = saved.cacheRevision;
        this.draft = saved.draft;
        this.enabled = saved.enabled;
        this.delivery = saved.delivery;
        this.pending = saved.pending;
      }
      this.loaded = true;
    } catch (error) {
      this.loadError = '任务草稿无法安全恢复，请重新打开原会话。';
      throw error;
    } finally {
      if (this.deps.current()) this.deps.changed();
    }
  }
  private async persist(extra: Partial<Stored> = {}, generation = this.generation) {
    this.current(generation);
    const value = this.record(extra);
    try {
      const written = await this.deps.compareWrite(
        tasksKey(this.target),
        this.cacheRevision,
        value,
        () => this.deps.current() && generation === this.generation,
      );
      this.current(generation);
      if (!written) throw new Error('另一页面已修改任务草稿。');
      this.saved = value;
      this.cacheRevision = value.cacheRevision;
    } catch (error) {
      this.loadError = '任务草稿保存未确认；当前输入仍保留，请重新打开原会话后核对。';
      throw error;
    }
  }
  edit(value: TaskDraft) {
    this.current();
    if (!this.loaded || this.loadError || this.busy)
      throw new Error(this.loadError || '请等待任务操作完成。');
    this.draft = taskDraftSchema.parse(value);
    this.enabled = undefined;
    const generation = this.generation;
    this.queued++;
    this.saving = true;
    this.error = '';
    this.deps.changed();
    const writing = this.writes
      .catch(() => {})
      .then(async () => {
        if (this.loadError) throw new Error(this.loadError);
        await this.persist({}, generation);
      })
      .catch((error) => {
        if (generation === this.generation && this.deps.current())
          this.error = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        this.queued--;
        this.saving = this.queued > 0;
        if (generation === this.generation && this.deps.current()) this.deps.changed();
      });
    this.writes = writing;
    return writing;
  }
  async flush() {
    await this.writes;
    this.current();
    if (this.loadError) throw new Error(this.loadError);
  }
  private async exclusive<T>(work: (generation: number) => Promise<T>) {
    if (this.busy) throw new Error('请等待当前任务操作完成。');
    const generation = this.generation;
    this.busy = true;
    this.error = '';
    this.deps.changed();
    try {
      return await work(generation);
    } finally {
      if (generation === this.generation && this.deps.current()) {
        this.busy = false;
        this.deps.changed();
      }
    }
  }
  async enable(plan: TaskPlan, parentAgentId: string) {
    return this.exclusive(async (generation) => {
      await this.flush();
      this.access(generation);
      if (this.delivery) throw new Error('请先确认原父指令。');
      const parsed = taskPlanSchema.parse(plan);
      if (JSON.stringify(parsed) !== JSON.stringify(taskPlanSchema.parse(this.draft)))
        throw new Error('任务草稿已改变，请重新审查。');
      const review = reviewedSchema.parse({
        reviewId: (this.deps.uuid ?? (() => crypto.randomUUID()))(),
        parentAgentId,
        plan: parsed,
      });
      await this.persist({ enabled: review }, generation);
      this.enabled = review;
    });
  }
  async disable() {
    return this.exclusive(async (generation) => {
      await this.flush();
      this.current(generation);
      await this.persist({ enabled: undefined }, generation);
      this.enabled = undefined;
    });
  }
  async stageSubmission(
    mutation: Mutation,
    pendingKey: string,
    pendingValue: unknown,
    extra: readonly DraftBundleEntry[] = [],
    extraCurrent: () => boolean = () => true,
  ) {
    return this.exclusive(async (generation) => {
      await this.flush();
      this.access(generation);
      if (
        mutation.kind !== 'turn' ||
        mutation.workspaceId !== this.target.workspaceId ||
        mutation.sessionId !== this.target.sessionId
      )
        throw new Error('任务计划与原指令范围不匹配。');
      const version = await mutationVersion(mutation);
      this.current(generation);
      if (this.delivery) {
        if (
          this.delivery.operationId !== mutation.operationId ||
          this.delivery.requestVersion !== version
        )
          throw new Error('请先确认原任务指令，不可替换请求。');
        return this.delivery;
      }
      if (!this.enabled) throw new Error('任务计划尚未审查启用。');
      const delivery: TaskDelivery = {
        operationId: mutation.operationId,
        review: structuredClone(this.enabled),
        requestVersion: version,
      };
      const value = this.record({ delivery });
      const existing = await this.deps.read(pendingKey);
      this.current(generation);
      if (existing !== undefined) throw new Error('原父指令仍待确认，任务计划未发送。');
      try {
        const written = await this.deps.compareSubmission(
          [
            { key: tasksKey(this.target), expected: this.saved, value },
            { key: pendingKey, expected: undefined, value: pendingValue },
            ...extra,
          ],
          () => this.deps.current() && generation === this.generation && extraCurrent(),
        );
        this.current(generation);
        if (!written) throw new Error('任务提交草稿已在其他页面改变。');
      } catch (error) {
        this.loadError = '任务计划与原指令未能一起保存，请重新打开原会话。';
        throw error;
      }
      this.saved = value;
      this.cacheRevision = value.cacheRevision;
      this.delivery = delivery;
      return delivery;
    });
  }
  async verifySubmission(mutation: Mutation) {
    if (!this.delivery) return false;
    const generation = this.generation,
      version = await mutationVersion(mutation);
    this.access(generation);
    if (
      this.delivery.operationId !== mutation.operationId ||
      this.delivery.requestVersion !== version
    )
      throw new Error('待确认指令与原任务授权不匹配。');
    return true;
  }
  async confirmSubmission(operationId: string, accepted = true) {
    return this.exclusive(async (generation) => {
      await this.flush();
      this.current(generation);
      if (this.delivery?.operationId !== operationId) return;
      const enabled =
        accepted && this.enabled?.reviewId === this.delivery.review.reviewId
          ? undefined
          : this.enabled;
      await this.persist({ delivery: undefined, enabled }, generation);
      this.delivery = undefined;
      this.enabled = enabled;
    });
  }
  invalidate(reason = '') {
    this.contentGeneration++;
    this.list = undefined;
    this.receipt = undefined;
    this.error = reason;
    this.deps.changed();
  }
  dispose() {
    this.generation++;
    this.contentGeneration++;
    this.list = undefined;
  }
  async refresh() {
    return this.exclusive(async (generation) => {
      await this.flush();
      this.access(generation);
      const content = ++this.contentGeneration;
      try {
        const request = taskReadSchema.parse(this.base()),
          value = validateTaskReadResult(
            await this.deps.request(this.endpoint('read'), request),
            request,
          );
        this.access(generation);
        if (content !== this.contentGeneration) return;
        this.list = value;
        this.receipt = undefined;
      } catch (error) {
        if (generation === this.generation && this.deps.current())
          this.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
  }
  action(
    action: TaskAction['action'],
    grantId: string,
    operationId?: string,
    cleanup?: { taskId: string; expectedExecutionRevision: number },
  ) {
    return this.deliver(
      taskActionSchema.parse({
        ...this.base(),
        action,
        grantId,
        operationId: operationId ?? (this.deps.uuid ?? (() => crypto.randomUUID()))(),
        ...cleanup,
      }),
    );
  }
  private async deliver(request: TaskAction) {
    return this.exclusive(async (generation) => {
      await this.flush();
      this.access(generation);
      const content = this.contentGeneration;
      if (this.pending?.action === 'revoke' && request.action !== 'revoke')
        throw new Error('撤销授权只能手动重试原撤销请求。');
      const sameOriginal =
        this.pending?.grantId === request.grantId &&
        this.pending?.operationId === request.operationId;
      if (
        this.pending &&
        !(sameOriginal && (request.action === 'inspect' || request.action === 'abandon')) &&
        JSON.stringify(this.pending) !== JSON.stringify(request)
      )
        throw new Error('请先核查或继续原任务操作。');
      try {
        if (
          request.action !== 'inspect' &&
          JSON.stringify(this.pending) !== JSON.stringify(request)
        ) {
          await this.persist({ pending: request }, generation);
          this.pending = request;
        }
        this.access(generation);
        const result = validateTaskActionResult(
          await this.deps.request(this.endpoint('action'), request),
          request,
        );
        this.access(generation);
        const terminal =
          result.operation &&
          ['accepted', 'abandoned', 'rejected'].includes(result.operation.state);
        const resolved =
          terminal || (request.action === 'revoke' && result.grant.state !== 'active');
        if (
          (this.pending && sameOriginal && resolved) ||
          (this.pending && this.pending.operationId === request.operationId && resolved)
        ) {
          await this.persist({ pending: undefined }, generation);
          this.pending = undefined;
        }
        this.receipt = content === this.contentGeneration ? result : undefined;
        this.list = undefined;
        this.error = this.pending
          ? '原任务操作仍待确认；刷新和重连不会执行，请手动核查原编号。'
          : '';
        return result;
      } catch (error) {
        if (generation === this.generation && this.deps.current())
          this.error = this.pending
            ? '原任务操作尚未确认；请手动核查或封存原编号。'
            : error instanceof Error
              ? error.message
              : String(error);
        throw error;
      }
    });
  }
  retry() {
    if (!this.pending) throw new Error('没有待确认的任务操作。');
    return this.deliver(this.pending);
  }
}
