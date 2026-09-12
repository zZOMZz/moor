import { z } from 'zod';
import { ApiError } from './api';
import {
  gitTargetSchema,
  gitWorkspaceKey,
  type GitTarget,
  type GitWorkspaceDependencies,
} from './git-workspace';
import {
  githubReadSchema,
  githubReadResultSchema,
  githubActionSchema,
  githubReceiptSchema,
  githubUrlSchema,
  type GithubRead,
  type GithubReadResult,
  type GithubAction,
  type GithubReceipt,
  type GithubBinding,
  type GithubSubject,
  type GithubRepository,
  type GithubBranch,
} from '../github-protocol';

export type GithubTarget = GitTarget;
export type GithubDetail = Extract<GithubReadResult, { view: 'issue' | 'pull' }>;
type GithubOverview = Extract<GithubReadResult, { view: 'overview' }>;
const pendingSchema = z
  .object({
    target: gitTargetSchema,
    request: githubActionSchema,
    abandon: z.literal(true).optional(),
  })
  .strict();
export type PendingGithubAction = z.infer<typeof pendingSchema>;
const storedSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().nonnegative().safe().default(0),
    target: gitTargetSchema,
    revision: z.number().int().nonnegative().safe().default(0),
    pending: pendingSchema.optional(),
  })
  .strict();
export function githubKey(target: GithubTarget) {
  return gitWorkspaceKey(target).replace('git-workspace-v1/', 'github-binding-v1/');
}
function sameScope(
  value: { workspaceId: string; localProjectId: string; sessionId: string },
  target: GithubTarget,
) {
  return (
    value.workspaceId === target.workspaceId &&
    value.localProjectId === target.localProjectId &&
    value.sessionId === target.sessionId
  );
}
export function safeGithubLink(
  value: string,
  repository: Pick<GithubRepository, 'owner' | 'name'>,
): string | undefined {
  if (!githubUrlSchema.safeParse(value).success) return;
  const url = new URL(value),
    path = `/${repository.owner}/${repository.name}`;
  return url.pathname === path || url.pathname.startsWith(path + '/') ? url.href : undefined;
}
export function validateGithubRead(value: unknown, request: GithubRead): GithubReadResult {
  const result = githubReadResultSchema.parse(value);
  if (
    result.workspaceId !== request.workspaceId ||
    result.localProjectId !== request.localProjectId ||
    result.sessionId !== request.sessionId ||
    result.view !== request.view
  )
    throw new Error('GitHub 内容不属于当前请求。');
  if (request.view !== 'overview') {
    if (
      result.repository?.id !== request.repositoryId ||
      result.configVersion !== request.configVersion
    )
      throw new Error('GitHub 仓库授权已改变，请重新打开面板。');
    if ('page' in request) {
      if (
        result.view === 'checks'
          ? result.checks.page !== request.page || result.statuses.page !== request.page
          : !('result' in result) || result.result.page !== request.page
      )
        throw new Error('GitHub 返回的页码不匹配。');
    }
    if ('state' in request && (!('state' in result) || result.state !== request.state))
      throw new Error('GitHub 列表状态不匹配。');
    if (
      (request.view === 'issue' || request.view === 'pull') &&
      (!('item' in result) ||
        result.item.number !== request.number ||
        result.item.kind !== request.view)
    )
      throw new Error('GitHub 条目不匹配。');
    if (
      request.view === 'comments' &&
      (result.view !== 'comments' ||
        result.number !== request.number ||
        result.subject !== request.subject)
    )
      throw new Error('GitHub 评论不匹配。');
    if (
      request.view === 'checks' &&
      (result.view !== 'checks' ||
        result.number !== request.number ||
        result.headSha !== request.headSha)
    )
      throw new Error('PR 的提交已改变，请重新读取检查状态。');
    if (
      (result.view === 'issues' || result.view === 'pulls') &&
      result.result.items.some(
        (item) => item.kind !== (result.view === 'issues' ? 'issue' : 'pull'),
      )
    )
      throw new Error('GitHub 列表类型不匹配。');
  }
  return result;
}
export function validateGithubReceipt(
  value: unknown,
  operation: PendingGithubAction,
): GithubReceipt {
  const receipt = githubReceiptSchema.parse(value),
    request = operation.request,
    context = receipt.binding.context;
  if (
    !sameScope(receipt, operation.target) ||
    receipt.operationId !== request.operationId ||
    receipt.binding.revision !== request.expectedRevision + (receipt.abandoned ? 0 : 1) ||
    (!receipt.abandoned &&
      (request.action === 'unbind'
        ? context !== undefined || receipt.redacted
        : !receipt.redacted &&
          (!context ||
            context.repository.id !== request.repositoryId ||
            context.branch !== request.branch ||
            JSON.stringify(context.subject) !== JSON.stringify(request.subject))))
  )
    throw new Error('GitHub 绑定尚未获得匹配的主机确认，请手动重试原请求。');
  return receipt;
}
/** Provider content remains in memory. Only a minimal manual binding outbox is durable. */
export class GithubController {
  readonly target: GithubTarget;
  overview?: GithubOverview;
  branches?: Extract<GithubReadResult, { view: 'branches' }>;
  listing?: Extract<GithubReadResult, { view: 'issues' | 'pulls' }>;
  detail?: GithubDetail;
  comments?: Extract<GithubReadResult, { view: 'comments' }>;
  checks?: Extract<GithubReadResult, { view: 'checks' }>;
  binding?: GithubBinding;
  pending?: PendingGithubAction;
  loaded = false;
  busy = false;
  error = '';
  loadError = '';
  private revision = 0;
  private cacheRevision = 0;
  private generation = 0;
  private verifiedBranches = new Map<string, GithubBranch>();
  constructor(
    target: GithubTarget,
    private dependencies: GitWorkspaceDependencies & { online(): boolean },
  ) {
    this.target = gitTargetSchema.parse(target);
  }
  get blocked() {
    return !this.loaded || !!(this.pending || this.loadError || this.busy);
  }
  branch(name: string) {
    return this.verifiedBranches.get(name);
  }
  private current(generation = this.generation) {
    if (!this.dependencies.current() || generation !== this.generation)
      throw new Error('GitHub 面板或会话已改变，请重新打开。');
  }
  private access(generation = this.generation) {
    this.current(generation);
    if (!this.dependencies.online())
      throw new Error('当前无法访问 GitHub，请连接执行电脑后重新读取。');
  }
  private clearContent() {
    this.overview = undefined;
    this.branches = undefined;
    this.listing = undefined;
    this.detail = undefined;
    this.comments = undefined;
    this.checks = undefined;
    this.binding = undefined;
    this.verifiedBranches.clear();
  }
  invalidate(reason = '') {
    this.generation++;
    this.clearContent();
    this.error = reason;
    if (this.dependencies.current()) this.dependencies.changed();
  }
  clearSelection() {
    this.current();
    if (this.busy) return;
    this.detail = undefined;
    this.comments = undefined;
    this.checks = undefined;
    this.dependencies.changed();
  }
  async load() {
    try {
      const value = await this.dependencies.read(githubKey(this.target));
      this.current();
      if (value !== undefined) {
        const stored = storedSchema.parse(value);
        if (
          githubKey(stored.target) !== githubKey(this.target) ||
          (stored.pending &&
            (githubKey(stored.pending.target) !== githubKey(this.target) ||
              !sameScope(stored.pending.request, this.target)))
        )
          throw new Error('GitHub 绑定记录范围不匹配。');
        this.cacheRevision = stored.cacheRevision;
        this.revision = stored.revision;
        this.pending = stored.pending;
      }
      this.loaded = true;
    } catch (error) {
      this.loadError = 'GitHub 绑定记录无法恢复，请重新打开会话。';
      throw error;
    } finally {
      if (this.dependencies.current()) this.dependencies.changed();
    }
  }
  private async save(
    values: { revision?: number; pending?: PendingGithubAction },
    generation: number,
  ) {
    this.current(generation);
    if (this.loadError) throw new Error(this.loadError);
    const value = storedSchema.parse({
      version: 1,
      cacheRevision: this.cacheRevision + 1,
      target: this.target,
      revision: this.revision,
      pending: this.pending,
      ...values,
    });
    try {
      const saved = await this.dependencies.compareWrite(
        githubKey(this.target),
        this.cacheRevision,
        value,
        () => this.dependencies.current() && generation === this.generation,
      );
      this.current(generation);
      if (!saved) throw new Error('GitHub 绑定记录已由其他页面更新。');
      this.cacheRevision = value.cacheRevision;
    } catch (error) {
      this.loadError = 'GitHub 绑定记录未确认保存，请重新打开原会话后继续。';
      throw error;
    }
  }
  private async work<T>(fn: (generation: number) => Promise<T>) {
    this.access();
    if (!this.loaded || this.loadError || this.busy)
      throw new Error(this.loadError || '请等待当前 GitHub 操作完成。');
    const generation = this.generation;
    this.busy = true;
    this.error = '';
    this.dependencies.changed();
    try {
      return await fn(generation);
    } catch (error) {
      if (this.dependencies.current() && generation === this.generation) {
        this.clearContent();
        this.error = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      this.busy = false;
      if (this.dependencies.current()) this.dependencies.changed();
    }
  }
  private scope() {
    return {
      githubVersion: 1 as const,
      workspaceId: this.target.workspaceId,
      localProjectId: this.target.localProjectId,
      sessionId: this.target.sessionId,
    };
  }
  private endpoint(kind: string) {
    return `/api/workspaces/${this.target.catalogWorkspaceId}/replicas/${this.target.replicaId}/github/${kind}`;
  }
  private repo() {
    if (
      this.overview?.status !== 'available' ||
      !this.overview.repository ||
      !this.overview.configVersion
    )
      throw new Error('请先读取主机已授权的 GitHub 仓库。');
    return {
      repositoryId: this.overview.repository.id,
      configVersion: this.overview.configVersion,
    };
  }
  private async read(input: unknown, generation: number) {
    this.access(generation);
    const request = githubReadSchema.parse({ ...this.scope(), ...(input as object) });
    const raw = await this.dependencies.request(this.endpoint('read'), request);
    this.access(generation);
    const result = validateGithubRead(raw, request);
    this.binding = result.binding;
    this.revision = result.binding.revision;
    if (result.view === 'overview') {
      if (
        result.status !== 'available' ||
        this.overview?.repository?.id !== result.repository?.id ||
        this.overview?.configVersion !== result.configVersion
      )
        this.clearContent();
      this.overview = result;
      this.binding = result.binding;
    }
    return result;
  }
  refresh() {
    return this.work(async (generation) => {
      await this.read({ view: 'overview' }, generation);
    });
  }
  loadBranches(page = 1) {
    return this.work(async (generation) => {
      const result = await this.read({ ...this.repo(), view: 'branches', page }, generation);
      if (result.view !== 'branches') return;
      this.branches = result;
      for (const branch of result.result.items) this.verifiedBranches.set(branch.name, branch);
    });
  }
  loadList(view: 'issues' | 'pulls', state: 'open' | 'closed' | 'all' = 'open', page = 1) {
    return this.work(async (generation) => {
      const result = await this.read({ ...this.repo(), view, state, page }, generation);
      if (result.view === 'issues' || result.view === 'pulls') this.listing = result;
    });
  }
  openItem(view: 'issue' | 'pull', number: number) {
    return this.work(async (generation) => {
      const result = await this.read({ ...this.repo(), view, number }, generation);
      if (result.view === 'issue' || result.view === 'pull') {
        this.detail = result;
        this.comments = undefined;
        this.checks = undefined;
      }
    });
  }
  loadComments(page = 1) {
    return this.work(async (generation) => {
      if (!this.detail) throw new Error('请先选择 Issue 或 PR。');
      const result = await this.read(
        {
          ...this.repo(),
          view: 'comments',
          subject: this.detail.item.kind,
          number: this.detail.item.number,
          page,
        },
        generation,
      );
      if (result.view === 'comments') this.comments = result;
    });
  }
  loadChecks(page = 1) {
    return this.work(async (generation) => {
      if (this.detail?.view !== 'pull') throw new Error('请先选择 PR。');
      const result = await this.read(
        {
          ...this.repo(),
          view: 'checks',
          number: this.detail.item.number,
          headSha: this.detail.item.head.sha,
          page,
        },
        generation,
      );
      if (result.view === 'checks') this.checks = result;
    });
  }
  private async freshDetail(generation: number) {
    const previous = this.detail;
    if (!previous) throw new Error('请先选择 Issue 或 PR。');
    const result = await this.read(
      { ...this.repo(), view: previous.item.kind, number: previous.item.number },
      generation,
    );
    if (result.view !== 'issue' && result.view !== 'pull') throw new Error('GitHub 条目不匹配。');
    this.detail = result;
    if (
      result.item.version !== previous.item.version ||
      (previous.view === 'pull' &&
        result.view === 'pull' &&
        result.item.head.sha !== previous.item.head.sha)
    )
      throw new Error('GitHub 条目已经更新，请重新查看内容后再操作。');
    return result;
  }
  contextForDraft() {
    return this.work(async (generation) => {
      const detail = await this.freshDetail(generation),
        item = detail.item;
      const url = safeGithubLink(item.url, detail.repository);
      return `${item.kind === 'pull' ? 'PR' : 'Issue'} #${item.number}: ${item.title}\n${url ? url + '\n' : ''}\n${item.body}${item.bodyTruncated ? '\n\n（正文仅包含本次读取的部分内容）' : ''}`;
    });
  }
  bind(branch: string) {
    return this.work(async (generation) => {
      if (this.pending) throw new Error('请先确认原 GitHub 绑定请求。');
      const repo = this.repo(),
        expectedRevision = this.revision,
        selected = this.detail;
      if (selected?.view === 'pull') branch = selected.item.head.branch;
      else if (!this.verifiedBranches.has(branch)) throw new Error('请明确选择已读取的远端分支。');
      await this.read({ view: 'overview' }, generation);
      if (
        JSON.stringify(this.repo()) !== JSON.stringify(repo) ||
        this.revision !== expectedRevision
      )
        throw new Error('GitHub 授权或会话绑定已改变，请重新确认。');
      let subject: GithubSubject | null = null;
      if (selected) {
        this.detail = selected;
        const detail = await this.freshDetail(generation);
        subject =
          detail.view === 'pull'
            ? {
                kind: 'pull',
                number: detail.item.number,
                version: detail.item.version,
                headSha: detail.item.head.sha,
              }
            : { kind: 'issue', number: detail.item.number, version: detail.item.version };
      }
      const request = githubActionSchema.parse({
        ...this.scope(),
        operationId: this.dependencies.uuid?.() ?? crypto.randomUUID(),
        expectedRevision,
        action: 'bind',
        ...repo,
        branch,
        subject,
      });
      await this.stage(request, generation);
      return this.deliver(true, generation);
    });
  }
  unbind() {
    return this.work(async (generation) => {
      if (this.pending) throw new Error('请先确认原 GitHub 绑定请求。');
      const request = githubActionSchema.parse({
        ...this.scope(),
        operationId: this.dependencies.uuid?.() ?? crypto.randomUUID(),
        expectedRevision: this.revision,
        action: 'unbind',
      });
      await this.stage(request, generation);
      return this.deliver(true, generation);
    });
  }
  private async stage(request: GithubAction, generation: number) {
    const pending = { target: this.target, request };
    await this.save({ pending }, generation);
    this.pending = pending;
    this.access(generation);
    this.dependencies.changed();
  }
  retry() {
    return this.work((generation) => {
      if (!this.pending) throw new Error('没有待确认的 GitHub 绑定。');
      return this.deliver(false, generation);
    });
  }
  abandon() {
    return this.work(async (generation) => {
      if (!this.pending) throw new Error('没有待确认的 GitHub 绑定。');
      const pending = { ...this.pending, abandon: true as const };
      await this.save({ pending }, generation);
      this.current(generation);
      this.pending = pending;
      return this.deliver(false, generation);
    });
  }
  private async deliver(first: boolean, generation: number) {
    const pending = this.pending!;
    if (githubKey(pending.target) !== githubKey(this.target))
      throw new Error('原 GitHub 绑定的执行身份已改变。');
    await this.save({ pending: { ...pending, target: this.target } }, generation);
    this.access(generation);
    let raw: unknown;
    try {
      raw = await this.dependencies.request(
        this.endpoint(pending.abandon ? 'abandon' : 'action'),
        pending.request,
      );
    } catch (error) {
      this.access(generation);
      if (first && error instanceof ApiError && error.rejected) {
        await this.save({ pending: undefined }, generation);
        this.current(generation);
        this.pending = undefined;
      }
      throw error;
    }
    this.access(generation);
    const receipt = validateGithubReceipt(raw, pending);
    const revision = Math.max(this.revision, receipt.binding.revision);
    await this.save({ pending: undefined, revision }, generation);
    this.current(generation);
    this.pending = undefined;
    this.revision = revision;
    if (receipt.redacted || receipt.abandoned) {
      this.clearContent();
      this.error = receipt.abandoned
        ? '主机已确认原请求未执行，迟到的同编号请求也不会执行。请重新读取当前绑定。'
        : '主机已确认原绑定操作。请重新读取当前状态；授权已撤销时仍可解除绑定。';
    } else if (!this.binding || this.binding.revision <= receipt.binding.revision)
      this.binding = receipt.binding;
    return receipt;
  }
}
