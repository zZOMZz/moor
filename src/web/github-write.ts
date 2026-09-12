import { z } from 'zod';
import { ApiError } from './api';
import {
  gitTargetSchema,
  gitWorkspaceKey,
  type GitTarget,
  type GitWorkspaceDependencies,
} from './git-workspace';
import { validateGithubRead, type GithubDetail } from './github';
import { githubReadSchema } from '../github-protocol';
import {
  githubWriteActionSchema,
  githubWriteReadSchema,
  githubWriteReadResultSchema,
  githubWriteReceiptSchema,
  githubWriteInspectSchema,
  githubWriteAbandonSchema,
  githubPatchLines,
  type GithubWriteAction,
  type GithubWriteRead,
  type GithubWriteReadResult,
  type GithubWriteReceipt,
} from '../github-write-protocol';
export type GithubWriteTarget = GitTarget;
const kindSchema = z.enum([
  'issue-comment',
  'review-comment',
  'review-reply',
  'pr-create',
  'pr-update',
  'pr-state',
  'pr-merge',
  'commit',
  'push',
]);
const scalar = z.union([
  z.string().max(16000),
  z.number().int().safe(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(1000)).max(50),
]);
export const githubWriteDraftSchema = z
  .object({
    id: z.string().min(1).max(2000),
    kind: kindSchema,
    values: z.record(z.string().max(100), scalar),
  })
  .strict();
export type GithubWriteDraft = z.infer<typeof githubWriteDraftSchema>;
const pendingSchema = z
  .object({
    target: gitTargetSchema,
    request: githubWriteActionSchema,
    draftId: z.string().max(2000),
  })
  .strict();
export type PendingGithubWrite = z.infer<typeof pendingSchema>;
const storedSchema = z
  .object({
    version: z.literal(1),
    cacheRevision: z.number().int().safe().nonnegative().default(0),
    target: gitTargetSchema,
    drafts: z.record(z.string(), githubWriteDraftSchema).default({}),
    pending: pendingSchema.optional(),
    receipt: githubWriteReceiptSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v.drafts).length <= 50);
export const githubWriteKey = (target: GithubWriteTarget) =>
  gitWorkspaceKey(target).replace('git-workspace-v1/', 'github-write-v1/');
const sameScope = (
  a: { workspaceId: string; localProjectId: string; sessionId: string },
  b: GitTarget,
) =>
  a.workspaceId === b.workspaceId &&
  a.localProjectId === b.localProjectId &&
  a.sessionId === b.sessionId;
export async function githubWriteRequestVersion(request: GithubWriteAction) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(githubWriteActionSchema.parse(request))),
  );
  return (
    'sha256:' + Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('')
  );
}
export async function validateGithubWriteReceipt(value: unknown, pending: PendingGithubWrite) {
  const receipt = githubWriteReceiptSchema.parse(value);
  if (
    !sameScope(receipt, pending.target) ||
    receipt.operationId !== pending.request.operationId ||
    receipt.action !== pending.request.action ||
    receipt.requestVersion !== (await githubWriteRequestVersion(pending.request))
  )
    throw new Error('写入结果尚未获得匹配的主机确认，请保留原操作并手动核查。');
  return receipt;
}
export type GithubWriteOverview = Extract<GithubWriteReadResult, { view: 'overview' }>;
export class GithubWriteController {
  readonly target: GithubWriteTarget;
  overview?: GithubWriteOverview;
  detail?: GithubDetail;
  files?: Extract<GithubWriteReadResult, { view: 'files' }>;
  comments?: Extract<GithubWriteReadResult, { view: 'review-comments' }>;
  branches?: Extract<GithubWriteReadResult, { view: 'branches' }>;
  commitPreview?: Extract<GithubWriteReadResult, { view: 'commit-preview' }>;
  pushPreview?: Extract<GithubWriteReadResult, { view: 'push-preview' }>;
  drafts: Record<string, GithubWriteDraft> = {};
  pending?: PendingGithubWrite;
  receipt?: GithubWriteReceipt;
  review?: { request: GithubWriteAction; draftId: string };
  loaded = false;
  busy = false;
  error = '';
  loadError = '';
  private cacheRevision = 0;
  private generation = 0;
  private saving: Promise<unknown> = Promise.resolve();
  private verifiedBranches = new Map<string, { sha: string; page: number }>();
  constructor(
    target: GithubWriteTarget,
    private deps: GitWorkspaceDependencies & { online(): boolean },
  ) {
    this.target = gitTargetSchema.parse(target);
  }
  get blocksExecution() {
    return (
      !!this.loadError ||
      !this.loaded ||
      this.pending?.request.action === 'commit' ||
      this.pending?.request.action === 'push'
    );
  }
  get blocked() {
    return this.busy || !!this.pending || !!this.loadError || !this.loaded;
  }
  get branchChoices() {
    return [...this.verifiedBranches].map(([name, value]) => ({ name, ...value }));
  }
  branch(name: string) {
    return this.verifiedBranches.get(name);
  }
  private current(generation = this.generation) {
    if (!this.deps.current() || generation !== this.generation)
      throw new Error('写入面板或执行目标已变化，请重新打开。');
  }
  private access(generation = this.generation) {
    this.current(generation);
    if (!this.deps.online()) throw new Error('执行电脑离线，手工草稿已保留；连接后请手动操作。');
  }
  private changed() {
    if (this.deps.current()) this.deps.changed();
  }
  private clearProvider() {
    this.overview = undefined;
    this.detail = undefined;
    this.files = undefined;
    this.comments = undefined;
    this.branches = undefined;
    this.commitPreview = undefined;
    this.pushPreview = undefined;
    this.review = undefined;
    this.verifiedBranches.clear();
  }
  invalidate(reason = '') {
    this.generation++;
    this.clearProvider();
    this.error = reason;
    this.changed();
  }
  async load() {
    try {
      const value = await this.deps.read(githubWriteKey(this.target));
      this.current();
      if (value !== undefined) {
        const saved = storedSchema.parse(value);
        if (
          githubWriteKey(saved.target) !== githubWriteKey(this.target) ||
          (saved.pending &&
            (!sameScope(saved.pending.request, this.target) ||
              githubWriteKey(saved.pending.target) !== githubWriteKey(this.target))) ||
          (saved.receipt && !sameScope(saved.receipt, this.target))
        )
          throw new Error('写入记录不属于当前执行范围。');
        for (const [id, draft] of Object.entries(saved.drafts))
          if (id !== draft.id) throw new Error('草稿编号不匹配。');
        this.cacheRevision = saved.cacheRevision;
        this.drafts = saved.drafts;
        this.pending = saved.pending;
        this.receipt = saved.receipt;
      }
      this.loaded = true;
    } catch (cause) {
      this.loadError = '写入记录无法安全恢复，请重新打开原会话。';
      throw cause;
    } finally {
      this.changed();
    }
  }
  private async save(
    values: {
      drafts?: Record<string, GithubWriteDraft>;
      pending?: PendingGithubWrite;
      receipt?: GithubWriteReceipt;
    },
    generation: number,
  ) {
    this.current(generation);
    if (this.loadError) throw new Error(this.loadError);
    const next = storedSchema.parse({
      version: 1,
      cacheRevision: this.cacheRevision + 1,
      target: this.target,
      drafts: this.drafts,
      pending: this.pending,
      receipt: this.receipt,
      ...values,
    });
    try {
      const success = await this.deps.compareWrite(
        githubWriteKey(this.target),
        this.cacheRevision,
        next,
        () => this.deps.current() && generation === this.generation,
      );
      this.current(generation);
      if (!success) throw new Error('写入记录已由其他页面更新。');
      this.cacheRevision = next.cacheRevision;
      this.drafts = next.drafts;
      this.pending = next.pending;
      this.receipt = next.receipt;
    } catch (cause) {
      this.loadError = '写入草稿或操作未确认保存，请重新打开原会话；不会继续发布。';
      throw cause;
    }
  }
  saveDraft(input: GithubWriteDraft) {
    this.current();
    if (this.busy) throw new Error('请等待当前操作完成后再编辑草稿。');
    const draft = githubWriteDraftSchema.parse(input),
      generation = this.generation;
    const work = this.saving.then(async () => {
      this.current(generation);
      if (this.pending?.draftId === draft.id) throw new Error('该草稿正在核查，请保留原内容。');
      await this.save({ drafts: { ...this.drafts, [draft.id]: draft } }, generation);
      this.review = undefined;
      this.changed();
    });
    this.saving = work.catch(() => {});
    return work;
  }
  removeDraft(id: string) {
    const generation = this.generation;
    const work = this.saving.then(async () => {
      if (this.pending?.draftId === id) throw new Error('请先结束原操作核查。');
      const drafts = { ...this.drafts };
      delete drafts[id];
      await this.save({ drafts }, generation);
      this.review = undefined;
      this.changed();
    });
    this.saving = work.catch(() => {});
    return work;
  }
  private async work<T>(fn: (generation: number) => Promise<T>) {
    this.access();
    if (this.busy || this.loadError || !this.loaded)
      throw new Error(this.loadError || '请等待当前读取或写入完成。');
    const generation = this.generation;
    this.busy = true;
    this.error = '';
    this.changed();
    try {
      await this.saving;
      this.access(generation);
      return await fn(generation);
    } catch (cause) {
      if (this.deps.current() && generation === this.generation) {
        this.invalidate(cause instanceof Error ? cause.message : String(cause));
      }
      throw cause;
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  private scope() {
    return {
      githubWriteVersion: 1 as const,
      workspaceId: this.target.workspaceId,
      localProjectId: this.target.localProjectId,
      sessionId: this.target.sessionId,
    };
  }
  private endpoint(kind: string) {
    return `/api/workspaces/${this.target.catalogWorkspaceId}/replicas/${this.target.replicaId}/github-write/${kind}`;
  }
  private remote() {
    if (!this.overview?.repository || !this.overview.configVersion)
      throw new Error('请先读取主机授权仓库。');
    return {
      repositoryId: this.overview.repository.id,
      configVersion: this.overview.configVersion,
    };
  }
  private async read(input: unknown, generation: number) {
    this.access(generation);
    const request = githubWriteReadSchema.parse({ ...this.scope(), ...(input as object) }),
      raw = await this.deps.request(this.endpoint('read'), request);
    this.access(generation);
    const result = githubWriteReadResultSchema.parse(raw);
    if (!sameScope(result, this.target) || result.view !== request.view)
      throw new Error('读取结果不属于当前写入目标。');
    if (
      'repositoryId' in request &&
      (!('repository' in result) ||
        result.repository?.id !== request.repositoryId ||
        result.configVersion !== request.configVersion)
    )
      throw new Error('GitHub 授权已变化。');
    if ('page' in request && (!('result' in result) || result.result.page !== request.page))
      throw new Error('返回页码不匹配。');
    if (
      (request.view === 'files' || request.view === 'review-comments') &&
      (!('number' in result) ||
        result.number !== request.number ||
        result.headSha !== request.headSha ||
        result.baseSha !== request.baseSha)
    )
      throw new Error('PR 比较提交已变化。');
    if (
      request.view === 'push-preview' &&
      (result.view !== 'push-preview' ||
        result.branch !== request.branch ||
        result.headOid !== request.headOid)
    )
      throw new Error('推送目标已变化。');
    if (
      request.view === 'commit-preview' &&
      (result.view !== 'commit-preview' ||
        JSON.stringify(result.files.map((f) => f.path).sort()) !==
          JSON.stringify([...request.paths].sort()))
    )
      throw new Error('提交文件范围不匹配。');
    if (result.view === 'overview') {
      if (
        this.overview?.repository?.id !== result.repository?.id ||
        this.overview?.configVersion !== result.configVersion
      )
        this.clearProvider();
      this.overview = result;
    } else if (result.view === 'branches') {
      this.branches = result;
      for (const [name, branch] of this.verifiedBranches)
        if (branch.page === result.result.page) this.verifiedBranches.delete(name);
      for (const item of result.result.items)
        this.verifiedBranches.set(item.name, { sha: item.sha, page: result.result.page });
    } else if (result.view === 'files') this.files = result;
    else if (result.view === 'review-comments') this.comments = result;
    else if (result.view === 'commit-preview') this.commitPreview = result;
    else if (result.view === 'push-preview') this.pushPreview = result;
    return result;
  }
  refresh() {
    return this.work((generation) => this.read({ view: 'overview' }, generation));
  }
  loadBranches(page = 1) {
    return this.work((generation) =>
      this.read({ ...this.remote(), view: 'branches', page }, generation),
    );
  }
  private async readDetail(kind: 'issue' | 'pull', number: number, generation: number) {
    const request = githubReadSchema.parse({
        githubVersion: 1,
        workspaceId: this.target.workspaceId,
        localProjectId: this.target.localProjectId,
        sessionId: this.target.sessionId,
        ...this.remote(),
        view: kind,
        number,
      }),
      value = await this.deps.request(
        this.endpoint('read').replace('/github-write/read', '/github/read'),
        request,
      );
    this.access(generation);
    const detail = validateGithubRead(value, request);
    if (detail.view !== 'issue' && detail.view !== 'pull') throw new Error('条目类型不匹配。');
    this.detail = detail;
    return detail;
  }
  openDetail(kind: 'issue' | 'pull', number: number) {
    return this.work(async (generation) => {
      this.files = undefined;
      this.comments = undefined;
      await this.readDetail(kind, number, generation);
    });
  }
  loadPull(view: 'files' | 'review-comments', page = 1) {
    return this.work((generation) => {
      if (this.detail?.view !== 'pull') throw new Error('请选择真实 PR。');
      return this.read(
        {
          ...this.remote(),
          view,
          number: this.detail.item.number,
          headSha: this.detail.item.head.sha,
          baseSha: this.detail.item.base.sha,
          page,
        },
        generation,
      );
    });
  }
  previewCommit(paths: string[]) {
    return this.work((generation) => this.read({ view: 'commit-preview', paths }, generation));
  }
  previewPush() {
    return this.work((generation) => {
      const git = this.overview?.git;
      if (!git?.branch || !git.headOid) throw new Error('当前本地分支与 HEAD 不可用。');
      return this.read(
        { ...this.remote(), view: 'push-preview', branch: git.branch, headOid: git.headOid },
        generation,
      );
    });
  }
  async createDraft(
    kind: GithubWriteDraft['kind'],
    values: GithubWriteDraft['values'],
    id?: string,
  ) {
    const draft = {
      id: id ?? this.deps.uuid?.() ?? crypto.randomUUID(),
      kind,
      values: kind === 'commit' ? values : { ...values, repositoryId: this.remote().repositoryId },
    };
    await this.saveDraft(draft);
    return draft.id;
  }
  prepare(id: string) {
    return this.work(async (generation) => {
      if (this.pending) throw new Error('请先核查或结束原写入操作。');
      const draft = this.drafts[id];
      if (!draft) throw new Error('请先保存手工草稿。');
      const v = draft.values;
      let values: Record<string, unknown> = {
        ...this.scope(),
        operationId: this.deps.uuid?.() ?? crypto.randomUUID(),
        confirmed: true,
        action: draft.kind,
      };
      await this.read({ view: 'overview' }, generation);
      if (draft.kind === 'commit') {
        const result = await this.read({ view: 'commit-preview', paths: v.paths }, generation);
        if (result.view !== 'commit-preview' || !this.overview?.canCommit)
          throw new Error('当前目录不能提交。');
        values = {
          ...values,
          paths: v.paths,
          candidateVersion: result.candidateVersion,
          branch: result.branch,
          parentOid: result.parentOid,
          indexVersion: result.indexVersion,
          executionRevision: result.execution.revision,
          message: v.message,
          author: { name: v.authorName, email: v.authorEmail },
        };
      } else {
        if (draft.values.repositoryId !== this.overview?.repository?.id)
          throw new Error('草稿的 GitHub 仓库已变化，请重新选择原仓库，或明确创建另一份草稿。');
        if (!this.overview?.writesEnabled)
          throw new Error(this.overview?.reason || '执行电脑未启用 GitHub 外部写入。');
        values = {
          ...values,
          ...this.remote(),
          expectedBindingRevision: this.overview.bindingRevision,
        };
        if (draft.kind === 'push') {
          const result = await this.read(
            { ...this.remote(), view: 'push-preview', branch: v.branch, headOid: v.headOid },
            generation,
          );
          if (
            result.view !== 'push-preview' ||
            !result.canPush ||
            result.expectedRemoteOid !== v.expectedRemoteOid
          )
            throw new Error('推送状态已经变化，请重新查看目标。');
          values = {
            ...values,
            branch: result.branch,
            headOid: result.headOid,
            expectedRemoteOid: result.expectedRemoteOid,
            executionRevision: result.execution.revision,
          };
        } else if (draft.kind === 'pr-create') {
          for (const page of new Set([v.headPage, v.basePage]))
            await this.read({ ...this.remote(), view: 'branches', page }, generation);
          if (
            this.branch(String(v.headBranch))?.sha !== v.headSha ||
            this.branch(String(v.baseBranch))?.sha !== v.baseSha
          )
            throw new Error('PR 来源或目标分支已变化，请重新选择。');
          values = {
            ...values,
            headBranch: v.headBranch,
            baseBranch: v.baseBranch,
            headSha: v.headSha,
            baseSha: v.baseSha,
            title: v.title,
            body: v.body,
            draft: v.draft === true,
          };
        } else {
          const detail = await this.readDetail(
            draft.kind === 'issue-comment' ? (v.subject as 'issue' | 'pull') : 'pull',
            Number(v.number),
            generation,
          );
          if (v.expectedVersion && detail.item.version !== v.expectedVersion)
            throw new Error('Issue 或 PR 已变化，请重新读取并审查。');
          if (draft.kind === 'issue-comment')
            values = {
              ...values,
              subject: v.subject,
              number: v.number,
              expectedVersion: detail.item.version,
              body: v.body,
            };
          else {
            if (detail.view !== 'pull') throw new Error('需要 PR。');
            if (
              detail.item.head.sha !== v.headSha ||
              (v.baseSha && detail.item.base.sha !== v.baseSha)
            )
              throw new Error('PR 提交已变化，请重新选择行或操作。');
            const pull = {
              number: v.number,
              headSha: detail.item.head.sha,
              expectedVersion: detail.item.version,
            };
            if (draft.kind === 'review-comment') {
              const result = await this.read(
                {
                  ...this.remote(),
                  view: 'files',
                  number: v.number,
                  headSha: v.headSha,
                  baseSha: v.baseSha,
                  page: v.filePage,
                },
                generation,
              );
              const file =
                result.view === 'files'
                  ? result.result.items.find((f) => f.path === v.path)
                  : undefined;
              if (
                !file ||
                file.version !== v.fileVersion ||
                !githubPatchLines(file).some(
                  (row) => (v.side === 'LEFT' ? row.oldLine : row.newLine) === v.line,
                )
              )
                throw new Error('所选评论行不再属于完整的 PR diff。');
              values = {
                ...values,
                number: v.number,
                headSha: v.headSha,
                baseSha: v.baseSha,
                filePage: v.filePage,
                path: v.path,
                fileVersion: v.fileVersion,
                side: v.side,
                line: v.line,
                body: v.body,
              };
            } else if (draft.kind === 'review-reply') {
              const result = await this.read(
                {
                  ...this.remote(),
                  view: 'review-comments',
                  number: v.number,
                  headSha: v.headSha,
                  baseSha: v.baseSha,
                  page: v.commentPage,
                },
                generation,
              );
              const comment =
                result.view === 'review-comments'
                  ? result.result.items.find((c) => c.id === v.commentId)
                  : undefined;
              if (!comment || comment.replyTo !== undefined || comment.version !== v.commentVersion)
                throw new Error('评论线程已经变化，请重新读取。');
              values = {
                ...values,
                number: v.number,
                headSha: v.headSha,
                baseSha: v.baseSha,
                commentId: v.commentId,
                commentVersion: v.commentVersion,
                body: v.body,
              };
            } else if (draft.kind === 'pr-update') {
              if (detail.item.bodyTruncated || detail.item.body.length > 12000)
                throw new Error('PR 正文未完整读取或超过写入上限，不能覆盖编辑。');
              values = { ...values, ...pull, title: v.title, body: v.body };
            } else if (draft.kind === 'pr-state') values = { ...values, ...pull, state: v.state };
            else values = { ...values, ...pull, method: v.method };
          }
        }
      }
      const request = githubWriteActionSchema.parse(values);
      this.review = { request, draftId: id };
      return request;
    });
  }
  cancelReview() {
    this.review = undefined;
    this.changed();
  }
  confirm() {
    return this.work(async (generation) => {
      if (this.pending || !this.review) throw new Error('请先审查本次具体操作。');
      const pending = { target: this.target, ...this.review };
      await this.save({ pending, receipt: undefined }, generation);
      this.access(generation);
      this.review = undefined;
      let raw: unknown;
      try {
        raw = await this.deps.request(this.endpoint('action'), pending.request);
      } catch (cause) {
        this.access(generation);
        if (cause instanceof ApiError && cause.rejected)
          await this.save({ pending: undefined }, generation);
        throw cause;
      }
      return this.finish(raw, pending, generation);
    });
  }
  inspect(page = 1) {
    return this.work(async (generation) => {
      if (!this.pending) throw new Error('没有待核查的原操作。');
      const pending = this.pending,
        value = await this.deps.request(
          this.endpoint('inspect'),
          githubWriteInspectSchema.parse({ request: pending.request, page }),
        );
      return this.finish(value, pending, generation);
    });
  }
  abandon() {
    return this.work(async (generation) => {
      if (!this.pending) throw new Error('没有待核查的原操作。');
      const pending = this.pending,
        value = await this.deps.request(
          this.endpoint('abandon'),
          githubWriteAbandonSchema.parse({ request: pending.request }),
        );
      return this.finish(value, pending, generation);
    });
  }
  private async finish(value: unknown, pending: PendingGithubWrite, generation: number) {
    this.access(generation);
    const receipt = await validateGithubWriteReceipt(value, pending);
    this.access(generation);
    await this.save(
      {
        receipt,
        ...(receipt.phase !== 'unknown' || receipt.released ? { pending: undefined } : {}),
      },
      generation,
    );
    this.current(generation);
    this.review = undefined;
    if (receipt.phase === 'accepted') {
      if (receipt.action === 'commit') {
        this.overview = undefined;
        this.commitPreview = undefined;
        this.pushPreview = undefined;
      } else if (receipt.action === 'push') this.pushPreview = undefined;
    }
    if (receipt.phase === 'unknown')
      this.error = receipt.released
        ? '已结束本机核查，远端结果仍未知；这不表示远端操作已取消。'
        : receipt.message;
    return receipt;
  }
}
