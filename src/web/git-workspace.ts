import { z } from 'zod';
import { ApiError } from './api';
import { id } from '../protocol';
import { contentScopeSchema } from '../content-protocol';
import {
  gitActionSchema,
  gitActionReceiptSchema,
  gitStateReadSchema,
  gitStateResultSchema,
  type GitAction,
  type GitActionReceipt,
  type GitStateResult,
} from '../git-protocol';
export const gitTargetSchema = contentScopeSchema
  .extend({
    owner: z.string().min(1).max(1000),
    deviceId: id,
    userId: z.string().min(1).max(1000),
    machineId: id,
    catalogWorkspaceId: id,
    replicaId: id,
  })
  .strict();
export type GitTarget = z.infer<typeof gitTargetSchema>;
const pendingSchema = z.object({ target: gitTargetSchema, request: gitActionSchema }).strict();
export type PendingGitAction = z.infer<typeof pendingSchema>;
const storedSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().nonnegative().safe().default(0),
    target: gitTargetSchema,
    state: gitStateResultSchema.optional(),
    receipt: gitActionReceiptSchema.optional(),
    pending: pendingSchema.optional(),
  })
  .strict();
export function gitWorkspaceKey(target: GitTarget) {
  return (
    'git-workspace-v1/' +
    JSON.stringify([
      target.owner,
      target.deviceId,
      target.userId,
      target.machineId,
      target.workspaceId,
      target.localProjectId,
      target.sessionId,
    ])
  );
}
function sameScope(
  result: { workspaceId: string; localProjectId: string; sessionId: string },
  target: GitTarget,
) {
  return (
    result.workspaceId === target.workspaceId &&
    result.localProjectId === target.localProjectId &&
    result.sessionId === target.sessionId
  );
}
export type GitWorkspaceDependencies = {
  read(key: string): Promise<unknown>;
  compareWrite(
    key: string,
    expectedRevision: number,
    value: { cacheRevision: number },
    current: () => boolean,
  ): Promise<boolean>;
  request(path: string, body: unknown): Promise<unknown>;
  current(): boolean;
  changed(): void;
  uuid?(): string;
};
/** Only explicit prepare/remove/retry methods can transmit a Git action. */
export class GitWorkspaceController {
  readonly target: GitTarget;
  state?: GitStateResult;
  receipt?: GitActionReceipt;
  pending?: PendingGitAction;
  source: 'host' | 'cache' = 'cache';
  busy = false;
  loaded = false;
  error = '';
  loadError = '';
  private cacheRevision = 0;
  constructor(
    target: GitTarget,
    private dependencies: GitWorkspaceDependencies,
  ) {
    this.target = gitTargetSchema.parse(target);
  }
  get execution() {
    return this.receipt?.phase === 'accepted' &&
      (!this.state || this.receipt.execution.revision > this.state.execution.revision)
      ? this.receipt.execution
      : this.state?.execution;
  }
  get blocked() {
    return (
      !this.loaded ||
      Boolean(
        this.loadError ||
        this.pending ||
        this.busy ||
        (this.execution && this.execution.status !== 'ready'),
      )
    );
  }
  private current() {
    if (!this.dependencies.current())
      throw new Error('执行目标已改变，请回到原会话确认 Git 操作。');
  }
  private async save(
    values: Partial<Pick<GitWorkspaceController, 'state' | 'receipt' | 'pending'>> = {},
  ) {
    this.current();
    if (this.loadError) throw new Error(this.loadError);
    const value = storedSchema.parse({
      version: 1,
      cacheRevision: this.cacheRevision + 1,
      target: this.target,
      state: this.state,
      receipt: this.receipt,
      pending: this.pending,
      ...values,
    });
    try {
      const saved = await this.dependencies.compareWrite(
        gitWorkspaceKey(this.target),
        this.cacheRevision,
        value,
        this.dependencies.current,
      );
      this.current();
      if (!saved) throw new Error('Git 操作记录已被其他页面更新。');
      this.cacheRevision = value.cacheRevision;
    } catch (error) {
      this.loadError = 'Git 操作记录未确认保存，请重新打开原会话后继续；不会发送新操作。';
      throw error;
    }
  }
  private async work(fn: () => Promise<void>) {
    this.current();
    if (this.busy) throw new Error('正在确认 Git 状态，请稍后重试。');
    this.busy = true;
    this.error = '';
    this.dependencies.changed();
    try {
      await fn();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.busy = false;
      if (this.dependencies.current()) this.dependencies.changed();
    }
  }
  async load() {
    this.loadError = '';
    try {
      const value = await this.dependencies.read(gitWorkspaceKey(this.target));
      this.current();
      if (value !== undefined) {
        const stored = storedSchema.parse(value);
        if (
          gitWorkspaceKey(stored.target) !== gitWorkspaceKey(this.target) ||
          (stored.state && !sameScope(stored.state, this.target)) ||
          (stored.receipt && !sameScope(stored.receipt, this.target)) ||
          (stored.pending &&
            (gitWorkspaceKey(stored.pending.target) !== gitWorkspaceKey(this.target) ||
              !sameScope(stored.pending.request, this.target)))
        )
          throw new Error('Git 草稿范围不匹配。');
        this.state = stored.state;
        this.receipt = stored.receipt;
        this.pending = stored.pending;
        this.cacheRevision = stored.cacheRevision;
      }
      this.loaded = true;
      this.source = 'cache';
    } catch (error) {
      this.loadError = 'Git 操作记录无法恢复，请重新打开原会话；尚未发送任何新操作。';
      throw error;
    } finally {
      if (this.dependencies.current()) this.dependencies.changed();
    }
  }
  private async readState() {
    this.current();
    if (this.loadError) throw new Error(this.loadError);
    const result = gitStateResultSchema.parse(
      await this.dependencies.request(
        this.endpoint('/state'),
        gitStateReadSchema.parse({ ...this.scope(), gitVersion: 1 }),
      ),
    );
    this.current();
    if (!sameScope(result, this.target)) throw new Error('Git 状态不属于当前会话。');
    await this.save({ state: result });
    this.current();
    this.state = result;
    this.source = 'host';
  }
  refresh() {
    return this.work(() => this.readState());
  }
  private scope() {
    return {
      workspaceId: this.target.workspaceId,
      localProjectId: this.target.localProjectId,
      sessionId: this.target.sessionId,
    };
  }
  private endpoint(suffix: string) {
    return `/api/workspaces/${this.target.catalogWorkspaceId}/replicas/${this.target.replicaId}/git${suffix}`;
  }
  prepare(baseBranch: string, expectedOid: string, newBranch: string) {
    return this.work(async () => {
      if (this.pending || this.loadError || !this.loaded) throw new Error('请先确认原 Git 操作。');
      await this.readState();
      this.current();
      const state = this.state!;
      if (!state.canPrepare || !state.repository.writeSupported)
        throw new Error(state.execution.reason || '此会话当前不能创建独立工作目录。');
      if (
        !state.repository.branches.some(
          (branch) => branch.name === baseBranch && branch.oid === expectedOid,
        )
      )
        throw new Error('所选基线已经改变，请重新读取并选择当前提交。');
      const request = gitActionSchema.parse({
        ...this.scope(),
        gitVersion: 1,
        operationId: this.dependencies.uuid?.() ?? crypto.randomUUID(),
        expectedRevision: state.execution.revision,
        action: 'prepare',
        baseBranch,
        expectedOid,
        newBranch,
      });
      await this.stage(request);
      await this.deliver(true);
    });
  }
  remove() {
    return this.work(async () => {
      if (this.pending || this.loadError || !this.loaded) throw new Error('请先确认原 Git 操作。');
      await this.readState();
      this.current();
      const state = this.state!;
      if (!state.canRemove || state.execution.mode !== 'worktree' || !state.execution.executionId)
        throw new Error(
          state.execution.reason || '此工作目录当前不能清理；请先确认未提交改动与活动回合。',
        );
      await this.stage(
        gitActionSchema.parse({
          ...this.scope(),
          gitVersion: 1,
          operationId: this.dependencies.uuid?.() ?? crypto.randomUUID(),
          expectedRevision: state.execution.revision,
          action: 'remove',
          executionId: state.execution.executionId,
          expectedStateVersion: state.repository.version,
        }),
      );
      await this.deliver(true);
    });
  }
  private async stage(request: GitAction) {
    const pending = { target: this.target, request };
    await this.save({ pending });
    this.current();
    this.pending = pending;
    this.source = 'cache';
    this.dependencies.changed();
    this.current();
  }
  retry() {
    return this.work(async () => {
      if (this.loadError || !this.loaded) throw new Error(this.loadError || '请重新打开原会话。');
      if (!this.pending) throw new Error('没有待确认的 Git 操作。');
      await this.deliver();
    });
  }
  private async deliver(firstDelivery = false) {
    const pending = this.pending!;
    // Persist route rebinding before transmission; the action and immutable
    // execution identity remain byte-for-byte equal to the original request.
    if (gitWorkspaceKey(pending.target) !== gitWorkspaceKey(this.target))
      throw new Error('原操作的执行电脑或项目已经改变。');
    await this.save({ pending: { ...pending, target: this.target } });
    this.current();
    let response: unknown;
    try {
      response = await this.dependencies.request(this.endpoint('/action'), pending.request);
    } catch (error) {
      this.current();
      // Only a fresh operation's first explicit rejection proves no dispatch.
      // Rejection of a retry says nothing about its earlier unknown delivery.
      if (firstDelivery && error instanceof ApiError && error.rejected) {
        await this.save({ pending: undefined });
        this.current();
        this.pending = undefined;
      }
      throw error;
    }
    this.current();
    const receipt = gitActionReceiptSchema.parse(response);
    if (!sameScope(receipt, this.target) || receipt.operationId !== pending.request.operationId)
      throw new Error('Git 操作尚未获得匹配的主机确认；请手动重试确认。');
    if (receipt.phase === 'accepted') {
      const execution = receipt.execution,
        request = pending.request;
      if (
        execution.mode !== 'worktree' ||
        execution.revision !== request.expectedRevision + 1 ||
        (request.action === 'prepare'
          ? execution.status !== 'ready' ||
            execution.branch !== request.newBranch ||
            execution.baseOid !== request.expectedOid
          : execution.status !== 'removed' || execution.executionId !== request.executionId)
      )
        throw new Error('主机确认的工作目录与原 Git 操作不匹配，请手动重试确认。');
    }
    await this.save({ receipt, pending: receipt.phase === 'unknown' ? pending : undefined });
    this.current();
    this.receipt = receipt;
    if (receipt.phase === 'unknown')
      throw new Error(receipt.message || 'Git 操作结果仍未知，请手动重试确认原请求。');
    this.pending = undefined;
    if (receipt.phase === 'rejected')
      throw new Error(receipt.message || '主机拒绝了此 Git 操作，请重新读取状态。');
    // A successful write changes the execution directory. The earlier file
    // listing is only a cache until a fresh read confirms its new contents.
    this.source = 'cache';
    if (this.dependencies.current()) await this.readState();
  }
}
