import { z } from 'zod';
import { ApiError } from './api';
import {
  gitTargetSchema,
  gitWorkspaceKey,
  type GitTarget,
  type GitWorkspaceDependencies,
} from './git-workspace';
import {
  sessionExecutionSchema,
  gitStateResultSchema,
  type GitStateResult,
  type SessionExecution,
} from '../git-protocol';
import {
  forkOptionsReadSchema,
  forkOptionsResultSchema,
  forkReceiptSchema,
  sessionForkSchema,
  type ForkCutoff,
  type ForkDirectory,
  type ForkOptionsResult,
  type ForkReceipt,
  type SessionFork,
} from '../fork-protocol';

export type ForkTarget = GitTarget;
const operationSchema = z
  .object({
    target: gitTargetSchema,
    request: sessionForkSchema,
    sourceExecution: sessionExecutionSchema,
  })
  .strict();
export type ForkOperation = z.infer<typeof operationSchema>;
const resourceSchema = z
  .object({ operation: operationSchema, receipt: forkReceiptSchema })
  .strict();
export type ForkResource = z.infer<typeof resourceSchema>;
const storedSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().nonnegative().safe().default(0),
    target: gitTargetSchema,
    options: forkOptionsResultSchema.optional(),
    operation: operationSchema.optional(),
    receipt: forkReceiptSchema.optional(),
    resources: z.array(resourceSchema).max(20).default([]),
    cleanup: sessionExecutionSchema.optional(),
  })
  .strict();
export function sessionForkKey(target: ForkTarget) {
  return gitWorkspaceKey(target).replace('git-workspace-v1/', 'session-fork-v1/');
}
function sameScope(
  value: { workspaceId: string; localProjectId: string; sessionId: string },
  target: ForkTarget,
) {
  return (
    value.workspaceId === target.workspaceId &&
    value.localProjectId === target.localProjectId &&
    value.sessionId === target.sessionId
  );
}
export function validateForkReceipt(value: unknown, operation: ForkOperation): ForkReceipt {
  const receipt = forkReceiptSchema.parse(value),
    request = operation.request;
  if (
    !sameScope(receipt, operation.target) ||
    receipt.operationId !== request.operationId ||
    receipt.childSessionId !== request.childSessionId
  )
    throw new Error('Fork 尚未获得匹配的主机确认；请手动重试原请求。');
  if (receipt.phase !== 'accepted') return receipt;
  const origin = receipt.origin!,
    execution = receipt.execution!,
    source = operation.sourceExecution;
  if (
    origin.sourceSessionId !== request.sessionId ||
    origin.sourceVersion !== request.expectedSourceVersion ||
    JSON.stringify(origin.cutoff) !== JSON.stringify(request.cutoff) ||
    origin.directory !== request.directory.kind
  )
    throw new Error('Fork 确认的来源或历史截止点与原请求不匹配。');
  const expected: Partial<SessionExecution> =
    request.directory.kind === 'worktree'
      ? {
          mode: 'worktree',
          revision: 1,
          branch: request.directory.newBranch,
          baseOid: request.directory.expectedOid,
        }
      : {
          mode: source.mode,
          revision: source.mode === 'shared' ? 0 : source.revision,
          executionId: source.executionId,
          branch: source.branch,
          baseOid: source.baseOid,
        };
  if (
    Object.entries(expected).some(
      ([key, value]) => execution[key as keyof SessionExecution] !== value,
    ) ||
    (request.directory.kind === 'worktree' &&
      (origin.branch !== request.directory.newBranch ||
        origin.baseOid !== request.directory.expectedOid))
  )
    throw new Error('Fork 确认的执行目录与原请求不匹配。');
  return receipt;
}
/** Native context is created only by explicit create/retry requests, never load or refresh. */
export class SessionForkController {
  readonly target: ForkTarget;
  options?: ForkOptionsResult;
  operation?: ForkOperation;
  receipt?: ForkReceipt;
  resources: ForkResource[] = [];
  cleanup?: SessionExecution;
  loaded = false;
  busy = false;
  source: 'host' | 'cache' = 'cache';
  error = '';
  loadError = '';
  private cacheRevision = 0;
  constructor(
    target: ForkTarget,
    private dependencies: GitWorkspaceDependencies,
  ) {
    this.target = gitTargetSchema.parse(target);
  }
  get pending() {
    return this.operation && (!this.receipt || this.receipt.phase === 'unknown')
      ? this.operation
      : undefined;
  }
  get blocked() {
    return !this.loaded || !!(this.loadError || this.busy || this.pending);
  }
  private current() {
    if (!this.dependencies.current()) throw new Error('执行目标已改变，请回到源会话确认 Fork。');
  }
  private async save(
    values: Partial<
      Pick<SessionForkController, 'options' | 'operation' | 'receipt' | 'resources' | 'cleanup'>
    > = {},
  ) {
    this.current();
    if (this.loadError) throw new Error(this.loadError);
    const value = storedSchema.parse({
      version: 1,
      cacheRevision: this.cacheRevision + 1,
      target: this.target,
      options: this.options,
      operation: this.operation,
      receipt: this.receipt,
      resources: this.resources,
      cleanup: this.cleanup,
      ...values,
    });
    try {
      const saved = await this.dependencies.compareWrite(
        sessionForkKey(this.target),
        this.cacheRevision,
        value,
        this.dependencies.current,
      );
      this.current();
      if (!saved) throw new Error('Fork 记录已被其他页面更新。');
      this.cacheRevision = value.cacheRevision;
    } catch (error) {
      this.loadError = 'Fork 记录未确认保存，请重新打开源会话；不会发送新操作。';
      throw error;
    }
  }
  private async work<T>(work: () => Promise<T>) {
    this.current();
    if (!this.loaded || this.loadError || this.busy)
      throw new Error(this.loadError || '请先等待 Fork 记录恢复。');
    this.busy = true;
    this.error = '';
    this.dependencies.changed();
    try {
      return await work();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.busy = false;
      if (this.dependencies.current()) this.dependencies.changed();
    }
  }
  async load() {
    try {
      const value = await this.dependencies.read(sessionForkKey(this.target));
      this.current();
      if (value !== undefined) {
        const stored = storedSchema.parse(value);
        if (
          sessionForkKey(stored.target) !== sessionForkKey(this.target) ||
          (stored.options && !sameScope(stored.options, this.target)) ||
          (stored.operation &&
            (sessionForkKey(stored.operation.target) !== sessionForkKey(this.target) ||
              !sameScope(stored.operation.request, this.target)))
        )
          throw new Error('Fork 记录范围不匹配。');
        if (stored.receipt) {
          if (!stored.operation) throw new Error('Fork 确认缺少原请求。');
          validateForkReceipt(stored.receipt, stored.operation);
        }
        this.cacheRevision = stored.cacheRevision;
        this.options = stored.options;
        this.operation = stored.operation;
        this.receipt = stored.receipt;
        for (const resource of stored.resources) {
          if (
            sessionForkKey(resource.operation.target) !== sessionForkKey(this.target) ||
            !sameScope(resource.operation.request, this.target) ||
            resource.receipt.phase !== 'rejected' ||
            resource.receipt.execution?.mode !== 'worktree'
          )
            throw new Error('Fork 资源记录范围不匹配。');
          validateForkReceipt(resource.receipt, resource.operation);
        }
        if (
          stored.cleanup &&
          (!stored.receipt ||
            stored.receipt.phase !== 'rejected' ||
            stored.cleanup.status !== 'removed' ||
            stored.cleanup.executionId !== stored.receipt.execution?.executionId)
        )
          throw new Error('Fork 清理记录范围不匹配。');
        this.resources = stored.resources;
        this.cleanup = stored.cleanup;
      }
      this.loaded = true;
    } catch (error) {
      this.loadError = 'Fork 记录无法恢复，请重新打开源会话。';
      throw error;
    } finally {
      if (this.dependencies.current()) this.dependencies.changed();
    }
  }
  private endpoint(kind: string) {
    return `/api/workspaces/${this.target.catalogWorkspaceId}/replicas/${this.target.replicaId}/fork/${kind}`;
  }
  private scope() {
    return {
      forkVersion: 1 as const,
      workspaceId: this.target.workspaceId,
      localProjectId: this.target.localProjectId,
      sessionId: this.target.sessionId,
    };
  }
  private async readOptions(turnId?: string) {
    const value = await this.dependencies.request(
      this.endpoint('options'),
      forkOptionsReadSchema.parse({ ...this.scope(), ...(turnId ? { turnId } : {}) }),
    );
    this.current();
    const options = forkOptionsResultSchema.parse(value);
    if (!sameScope(options, this.target)) throw new Error('Fork 选项不属于源会话。');
    await this.save({ options });
    this.current();
    this.options = options;
    this.source = 'host';
  }
  refresh(turnId?: string) {
    return this.work(() => this.readOptions(turnId));
  }
  create(cutoff: ForkCutoff, directory: ForkDirectory) {
    return this.work(async () => {
      if (this.pending || !this.options) throw new Error('请先确认原 Fork 请求并读取可用选项。');
      if (this.resources.length >= 20)
        throw new Error('请先清理此前 Fork 保留的工作目录，再创建更多副本。');
      const expected = this.options;
      await this.readOptions(cutoff.kind === 'turn' ? cutoff.turnId : undefined);
      this.current();
      const options = this.options!;
      if (
        options.sourceVersion !== expected.sourceVersion ||
        options.execution.revision !== expected.execution.revision
      )
        throw new Error('源会话已经改变，请检查新的历史截止点后再创建副本。');
      if (
        options.execution.status !== 'ready' ||
        (cutoff.kind === 'current'
          ? !options.currentAvailable
          : !options.capabilities.turnCutoff ||
            !options.turns.some((turn) => turn.turnId === cutoff.turnId && turn.available))
      )
        throw new Error('所选历史截止点目前不可用，请重新读取 Fork 选项。');
      if (
        directory.kind === 'same-directory'
          ? !options.capabilities.sameDirectory
          : !options.capabilities.worktree ||
            !options.repository?.writeSupported ||
            !options.repository.branches.some(
              (branch) =>
                branch.name === directory.baseBranch && branch.oid === directory.expectedOid,
            )
      )
        throw new Error('所选目录或 Git 基线目前不可用，请重新选择。');
      const uuid = this.dependencies.uuid ?? (() => crypto.randomUUID());
      const request = sessionForkSchema.parse({
        ...this.scope(),
        operationId: uuid(),
        childSessionId: uuid(),
        expectedSourceVersion: options.sourceVersion,
        expectedExecutionRevision: options.execution.revision,
        cutoff,
        directory,
      });
      const operation = operationSchema.parse({
        target: this.target,
        request,
        sourceExecution: options.execution,
      });
      const resources = [...this.resources];
      if (
        this.operation &&
        this.receipt?.phase === 'rejected' &&
        this.receipt.execution?.mode === 'worktree' &&
        this.receipt.execution.status !== 'removed' &&
        !this.cleanup
      )
        resources.push({ operation: this.operation, receipt: this.receipt });
      await this.save({ operation, receipt: undefined, resources, cleanup: undefined });
      this.current();
      this.operation = operation;
      this.receipt = undefined;
      this.resources = resources;
      this.cleanup = undefined;
      this.dependencies.changed();
      return this.deliver(true);
    });
  }
  retry() {
    return this.work(() => {
      if (!this.pending) throw new Error('没有待确认的 Fork。');
      return this.deliver(false);
    });
  }
  confirmResourceCleanup(childSessionId: string, value: GitStateResult) {
    return this.work(async () => {
      const result = gitStateResultSchema.parse(value);
      const receipt =
        this.receipt?.childSessionId === childSessionId
          ? this.receipt
          : this.resources.find((resource) => resource.receipt.childSessionId === childSessionId)
              ?.receipt;
      if (
        !receipt ||
        receipt.phase !== 'rejected' ||
        receipt.execution?.mode !== 'worktree' ||
        result.workspaceId !== this.target.workspaceId ||
        result.localProjectId !== this.target.localProjectId ||
        result.sessionId !== childSessionId ||
        result.execution.mode !== 'worktree' ||
        result.execution.status !== 'removed' ||
        result.execution.executionId !== receipt.execution.executionId ||
        result.execution.revision <= receipt.execution.revision
      )
        throw new Error('Fork 目录尚未获得匹配的清理确认。');
      const resources = this.resources.filter(
          (resource) => resource.receipt.childSessionId !== childSessionId,
        ),
        cleanup = this.receipt?.childSessionId === childSessionId ? result.execution : this.cleanup;
      await this.save({ resources, cleanup });
      this.current();
      this.resources = resources;
      this.cleanup = cleanup;
    });
  }
  private async deliver(first: boolean) {
    const operation = this.pending!;
    if (sessionForkKey(operation.target) !== sessionForkKey(this.target))
      throw new Error('Fork 执行电脑或项目已经改变。');
    await this.save({ operation: { ...operation, target: this.target } });
    this.current();
    let response: unknown;
    try {
      response = await this.dependencies.request(this.endpoint('action'), operation.request);
    } catch (error) {
      this.current();
      if (first && error instanceof ApiError && error.rejected) {
        await this.save({ operation: undefined, receipt: undefined });
        this.current();
        this.operation = undefined;
        this.receipt = undefined;
      }
      throw error;
    }
    this.current();
    const receipt = validateForkReceipt(response, operation);
    await this.save({ receipt });
    this.current();
    this.receipt = receipt;
    if (receipt.phase !== 'accepted')
      throw new Error(
        receipt.message ||
          (receipt.phase === 'unknown'
            ? 'Fork 结果未知；请手动重试原请求，主机不会再次调用已记录的原生 Fork。'
            : '主机拒绝了此 Fork，请重新读取选项。'),
      );
    return receipt;
  }
}
