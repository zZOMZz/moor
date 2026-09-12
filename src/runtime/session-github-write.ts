import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { relative, isAbsolute } from 'node:path';
import { AppError, assert } from '../protocol';
import { metas, mirror } from '../model';
import type { ContentScope } from '../content-protocol';
import type { AttachmentScope, RuntimeStore } from './store';
import type { ExecutionLease, SessionExecutionManager } from './session-execution';
import type { GitHubConfig, GitHubProjectConfig } from './github-config';
import { createGitHubClient, type GitHubRepositoryTarget } from './github-client';
import {
  createGitHubWriteClient,
  GitHubWriteClientError,
  githubOperationBody,
  type GitHubRecovery,
} from './github-write-client';
import { readProjectGit } from './project-git';
import {
  inspectCommitCandidate,
  planProjectCommit,
  commitProject,
  inspectProjectCommit,
  inspectProjectPush,
  pushProject,
  type GitCommitPlan,
  type GitPushPlan,
  type GitPushTransport,
} from './project-git-actions';
import {
  githubWriteReadSchema,
  githubWriteReadResultSchema,
  githubWriteActionSchema,
  githubWriteInspectSchema,
  githubWriteAbandonSchema,
  githubWriteReceiptSchema,
  githubPatchLines,
  type GithubWriteRead,
  type GithubWriteReadResult,
  type GithubWriteAction,
  type GithubWriteInspect,
  type GithubWriteReceipt,
  type GithubWriteOutcome,
} from '../github-write-protocol';
import type { GithubPull } from '../github-protocol';

type Host = {
  store: RuntimeStore;
  active: ReadonlyMap<string, unknown>;
  settlementFailures: ReadonlyMap<string, unknown>;
  executionManager: SessionExecutionManager;
  forkManager: { busy: ReadonlySet<string> };
  ensureConnected(): void;
  projectRootLease(
    input: ContentScope,
    localProjectId?: string,
  ): AttachmentScope & { rootPath: string };
  projectLease(
    input: ContentScope,
    localProjectId?: string,
  ): AttachmentScope & { rootPath: string };
  executionLease(input: ContentScope, localProjectId?: string, allowNew?: boolean): ExecutionLease;
  serial<T>(id: string, work: () => Promise<T>): Promise<T>;
};
const git = {
  inspectCommitCandidate,
  planProjectCommit,
  commitProject,
  inspectProjectCommit,
  inspectProjectPush,
  pushProject,
  readProjectGit,
};
export type SessionGithubWriteOptions = {
  config?: Pick<GitHubConfig, 'getProject' | 'isCurrent'>;
  client?: typeof createGitHubClient;
  writer?: typeof createGitHubWriteClient;
  git?: typeof git;
  pushTransport?: (plan: GitPushPlan) => GitPushTransport;
  now?: () => number;
  signal?: () => AbortSignal;
};
type Plan = {
  scope: AttachmentScope;
  requestVersion: string;
  remote?: GitHubRepositoryTarget;
  marker?: string;
  authorId?: number;
  execution?: ExecutionLease;
  commit?: GitCommitPlan;
  writerSettled?: true;
  push?: GitPushPlan;
};
type Record = {
  phase: string;
  approval: string | null;
  result: string | null;
  fingerprint: string;
};
const key = (s: AttachmentScope) =>
  JSON.stringify([s.workspaceId, s.userId, s.machineId, s.localProjectId, s.sessionId]);
const hash = (v: string) => 'sha256:' + createHash('sha256').update(v).digest('hex');
const overlaps = (a: string, b: string) => {
  const child = (root: string, path: string) => {
    const rel = relative(root, path);
    return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
  };
  return child(a, b) || child(b, a);
};
/** Durable plans separate a user's one dispatch from later, read-only inspection. */
export class SessionGithubWriteManager {
  private busyRoots = new Set<string>();
  private executionUsers = new Map<string, number>();
  private git: typeof git;
  constructor(
    private host: Host,
    private options: SessionGithubWriteOptions = {},
  ) {
    this.git = options.git ?? git;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private at() {
    return new Date(this.now()).toISOString();
  }
  private envelope(s: ContentScope) {
    return {
      githubWriteVersion: 1 as const,
      workspaceId: s.workspaceId,
      localProjectId: s.localProjectId,
      sessionId: s.sessionId,
    };
  }
  private lease(request: ContentScope, localProjectId?: string) {
    this.host.ensureConnected();
    const store = this.host.store;
    const lease =
      metas(store.meta)['session-' + request.sessionId] ||
      store.searchSource(request.sessionId) ||
      store.hasNativeSession(request.sessionId)
        ? this.host.projectLease(request, localProjectId)
        : this.host.projectRootLease(request, localProjectId);
    const { rootPath, ...scope } = lease;
    store.github.get(scope);
    return { scope, lease };
  }
  private bindingRevision(scope: AttachmentScope) {
    return this.host.store.github.get(scope).revision;
  }
  private currentLease(
    request: ContentScope,
    lease: AttachmentScope & { rootPath: string },
    localProjectId?: string,
  ) {
    assert(
      isDeepStrictEqual(this.lease(request, localProjectId).lease, lease),
      409,
      '写入操作的执行范围已变化',
    );
  }
  private remote(
    request: ContentScope & { repositoryId?: number },
    localProjectId?: string,
    needsWrite = false,
    hooks: { beforeDispatch?: () => void; onResult?: (v: GithubWriteOutcome) => void } = {},
  ) {
    const { scope, lease } = this.lease(request, localProjectId),
      config = this.options.config?.getProject(scope.localProjectId);
    assert(config, 409, '请在执行电脑登记并验证 GitHub 仓库');
    assert(
      request.repositoryId === undefined || config.repositoryId === request.repositoryId,
      409,
      'GitHub 仓库身份已变化',
    );
    if (needsWrite)
      assert(config.writesEnabled === true, 403, '请先在执行电脑本机设置中启用此仓库的外部写入');
    const revision = this.bindingRevision(scope),
      signal = this.options.signal?.() ?? AbortSignal.timeout(25000);
    const current = () => {
      this.currentLease(request, lease, localProjectId);
      assert(!signal.aborted, 504, 'GitHub 操作已超时，请手动核查原请求');
      assert(this.options.config?.isCurrent(config), 409, 'GitHub 本机配置或授权已变化');
      assert(this.bindingRevision(scope) === revision, 409, '会话的 GitHub 关联已变化');
    };
    current();
    const opts = { token: config.token, signal, assertCurrent: current };
    return {
      scope,
      lease,
      config,
      current,
      revision,
      repo: { owner: config.owner, repo: config.repo, repositoryId: config.repositoryId },
      client: (this.options.client ?? createGitHubClient)(opts),
      writer: (this.options.writer ?? createGitHubWriteClient)({ ...opts, ...hooks }),
    };
  }
  private idle(sessionId: string) {
    if (
      this.host.active.has(sessionId) ||
      this.host.settlementFailures.has(sessionId) ||
      this.host.forkManager.busy.has(sessionId) ||
      this.host.executionManager.busy.has(sessionId)
    )
      return false;
    const meta = metas(this.host.store.meta)['session-' + sessionId];
    if (!meta) return true;
    if (
      (meta.status as { type?: string } | undefined)?.type === 'working' ||
      (meta.latestUserMsgId && meta.latestUserMsgId !== meta.lastHandledUserMsgId)
    )
      return false;
    const view = mirror(this.host.store.doc(sessionId), sessionId);
    try {
      return !view
        .getState()
        .history.some(
          (t) => !t.finished || (t.role === 'user' && !t.read && t.status === 'pending'),
        );
    } finally {
      view.dispose();
    }
  }
  private idleRoot(root: string) {
    for (const path of this.executionUsers.keys())
      assert(!overlaps(root, path), 409, '该目录正在处理工作目录或 Fork 操作');
    for (const meta of Object.values(metas(this.host.store.meta))) {
      if (typeof meta.id !== 'string' || this.idle(meta.id)) continue;
      try {
        const project = (meta.project as { localProjectId?: string } | undefined)?.localProjectId;
        if (!project) continue;
        const execution = this.host.executionLease({
          workspaceId: this.host.store.workspace.id,
          localProjectId: project,
          sessionId: meta.id,
        });
        assert(!overlaps(root, execution.rootPath), 409, '该目录仍有活动会话，请先停止并确认回合');
      } catch (error) {
        if (error instanceof AppError && error.message === '该目录仍有活动会话，请先停止并确认回合')
          throw error;
        const project = (meta.project as { localProjectId?: string } | undefined)?.localProjectId;
        const p = this.host.store.workspace.projects.find((p) => p.id === project);
        assert(!p || !overlaps(root, p.rootPath), 409, '该目录的其他会话尚未就绪');
      }
    }
  }
  assertExecutionAvailable(execution: Pick<ExecutionLease, 'rootPath'>, ownOperationId?: string) {
    for (const root of this.busyRoots)
      assert(!overlaps(root, execution.rootPath), 409, '该目录正在准备提交，请等待原操作');
    const rows = this.host.store.journal.db
      .prepare(
        "SELECT id,approval,result FROM operation WHERE phase IN ('github-write-prepared','github-write-dispatched','github-write-unknown')",
      )
      .all();
    for (const row of rows) {
      if (row.id === ownOperationId || !row.approval) continue;
      const plan = JSON.parse(String(row.approval)) as Plan;
      if (
        plan.writerSettled &&
        row.result &&
        githubWriteReceiptSchema.parse(JSON.parse(String(row.result))).released
      )
        continue;
      if (plan.commit)
        assert(
          !overlaps(plan.commit.candidate.repository.rootPath, execution.rootPath),
          409,
          '该目录的提交结果尚未确认，请先核查原操作',
        );
    }
  }
  async withExecutionTask<T>(
    request: ContentScope,
    localProjectId: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const { scope, lease } = this.lease(request, localProjectId);
    const record = this.host.store.executions.get(scope);
    const paths = new Set([
      lease.rootPath,
      ...(record
        ? [record.repository.rootPath, record.managed?.cwd ?? record.plan.targetPath]
        : []),
    ]);
    for (const rootPath of paths) this.assertExecutionAvailable({ rootPath });
    for (const path of paths)
      this.executionUsers.set(path, (this.executionUsers.get(path) ?? 0) + 1);
    try {
      return await work();
    } finally {
      for (const path of paths) {
        const remaining = this.executionUsers.get(path)! - 1;
        if (remaining) this.executionUsers.set(path, remaining);
        else this.executionUsers.delete(path);
      }
    }
  }
  private lookup(scope: AttachmentScope, request: GithubWriteAction) {
    const record = this.host.store.journal.lookup(key(scope), request) as Record | undefined;
    if (record) assert(record.phase.startsWith('github-write-'), 409, '原操作编号已用于其他操作');
    return record;
  }
  private receipt(
    request: GithubWriteAction,
    phase: GithubWriteReceipt['phase'],
    message: string,
    result?: GithubWriteOutcome,
    released?: true,
  ) {
    return githubWriteReceiptSchema.parse({
      ...this.envelope(request),
      operationId: request.operationId,
      action: request.action,
      requestVersion: hash(JSON.stringify(request)),
      phase,
      confirmed: phase === 'accepted',
      message,
      checkedAt: this.at(),
      ...(result ? { result } : {}),
      ...(released ? { released } : {}),
    });
  }
  private prior(request: GithubWriteAction, record: Record) {
    return record.result
      ? githubWriteReceiptSchema.parse(JSON.parse(record.result))
      : this.receipt(request, 'unknown', '主机已保存原操作计划，请手动核查；不会重复执行');
  }
  private stage(scope: AttachmentScope, request: GithubWriteAction, plan: Plan) {
    this.host.store.transaction(() => {
      assert(!this.lookup(scope, request), 409, '原操作已登记');
      this.host.store.reserveAttachmentScope(scope);
      this.host.store.journal.db
        .prepare(
          'INSERT INTO operation(id,fingerprint,phase,turn_id,result,approval) VALUES(?,?,?,NULL,NULL,?)',
        )
        .run(
          request.operationId,
          this.host.store.journal.fingerprint(key(scope), request),
          'github-write-prepared',
          JSON.stringify(plan),
        );
    });
  }
  private dispatch(scope: AttachmentScope, request: GithubWriteAction) {
    const row = this.lookup(scope, request);
    assert(row?.phase === 'github-write-prepared', 409, '原操作已发送或已停止，不能重复执行');
    this.host.store.journal.db
      .prepare('UPDATE operation SET phase=? WHERE id=?')
      .run('github-write-dispatched', request.operationId);
  }
  private settle(scope: AttachmentScope, request: GithubWriteAction, receipt: GithubWriteReceipt) {
    const row = this.lookup(scope, request);
    assert(row, 409, '原操作记录不可用');
    if (row.phase === 'github-write-accepted') return this.prior(request, row);
    assert(
      !['github-write-rejected', 'github-write-abandoned'].includes(row.phase),
      409,
      '原操作已结束',
    );
    this.host.store.journal.db
      .prepare('UPDATE operation SET phase=?,result=? WHERE id=?')
      .run('github-write-' + receipt.phase, JSON.stringify(receipt), request.operationId);
    return receipt;
  }
  async read(input: GithubWriteRead, localProjectId?: string): Promise<GithubWriteReadResult> {
    const request = githubWriteReadSchema.parse(input),
      { scope, lease } = this.lease(request, localProjectId);
    const base = { ...this.envelope(scope), confirmed: true as const, readAt: this.at() };
    if (request.view === 'overview') {
      const state = await this.host.executionManager.read({
        gitVersion: 1,
        workspaceId: scope.workspaceId,
        localProjectId: scope.localProjectId,
        sessionId: scope.sessionId,
      });
      this.currentLease(request, lease, localProjectId);
      let repository,
        configVersion,
        reason,
        writesEnabled = false;
      try {
        const c = this.remote(request, localProjectId);
        repository = await c.client.getRepository(c.repo);
        c.current();
        configVersion = c.config.version;
        writesEnabled = c.config.writesEnabled === true;
      } catch (error) {
        reason = error instanceof AppError ? error.message : 'GitHub 授权当前不可读取';
      }
      this.currentLease(request, lease, localProjectId);
      let canCommit =
        this.idle(scope.sessionId) &&
        !this.host.store.forks.blocked(scope.sessionId) &&
        state.execution.status === 'ready' &&
        state.repository.writeSupported;
      try {
        this.assertExecutionAvailable(this.host.executionLease(scope, localProjectId, true));
      } catch {
        canCommit = false;
      }
      return githubWriteReadResultSchema.parse({
        ...base,
        view: request.view,
        repository,
        configVersion,
        writesEnabled,
        bindingRevision: this.bindingRevision(scope),
        reason,
        git: state.repository,
        execution: state.execution,
        canCommit,
      });
    }
    if (request.view === 'commit-preview') {
      const execution = this.host.executionLease(scope, localProjectId, true);
      this.assertExecutionAvailable(execution);
      assert(this.idle(scope.sessionId), 409, '请先停止活动回合');
      const current = () => {
        this.currentLease(request, lease, localProjectId);
        assert(
          isDeepStrictEqual(this.host.executionLease(scope, localProjectId, true), execution),
          409,
          '提交目录已变化',
        );
      };
      const candidate = await this.git.inspectCommitCandidate(execution.rootPath, request.paths, {
        assertCurrent: current,
      });
      current();
      return githubWriteReadResultSchema.parse({
        ...base,
        view: request.view,
        candidateVersion: candidate.version,
        branch: candidate.branch,
        parentOid: candidate.parentOid,
        indexVersion: candidate.indexVersion,
        files: candidate.files,
        execution: this.host.store.executions.info(scope),
      });
    }
    const c = this.remote(request, localProjectId);
    assert(c.config.version === request.configVersion, 409, 'GitHub 配置版本已变化，请重新读取');
    const repository = await c.client.getRepository(c.repo);
    c.current();
    const remoteBase = {
      ...base,
      repository,
      configVersion: c.config.version,
      writesEnabled: c.config.writesEnabled === true,
      bindingRevision: c.revision,
    };
    let result: unknown;
    if (request.view === 'branches')
      result = {
        ...remoteBase,
        view: request.view,
        result: await c.client.listBranches(c.repo, { page: request.page }),
      };
    else if (request.view === 'push-preview') {
      const execution = this.host.executionLease(scope, localProjectId, true),
        local = await this.git.readProjectGit(execution.rootPath);
      const current = () => {
        c.current();
        assert(
          isDeepStrictEqual(this.host.executionLease(scope, localProjectId, true), execution),
          409,
          '推送工作目录已变化',
        );
      };
      current();
      assert(
        local.repository &&
          local.state.branch === request.branch &&
          local.state.headOid === request.headOid,
        409,
        '本地分支或提交已变化',
      );
      const plan: GitPushPlan = {
        version: 1,
        repository: local.repository,
        branch: request.branch,
        headOid: request.headOid,
        remote: c.repo,
        expectedRemoteOid: null,
      };
      const inspected = await this.git.inspectProjectPush(plan, {
        token: c.config.token,
        assertCurrent: current,
        transport: this.options.pushTransport?.(plan),
      });
      current();
      assert(
        inspected.status !== 'unknown' || inspected.remoteOid !== null,
        409,
        '远端分支状态尚未确认，请重新读取推送预览',
      );
      result = {
        ...remoteBase,
        view: request.view,
        branch: request.branch,
        headOid: request.headOid,
        expectedRemoteOid: inspected.remoteOid,
        canPush: local.state.writeSupported && inspected.remoteOid !== request.headOid,
        execution: this.host.store.executions.info(scope),
      };
    } else {
      const before = await c.client.getPull(c.repo, request.number);
      this.pullHead(before, request);
      const page =
        request.view === 'files'
          ? await c.writer.listPullFiles(c.repo, request.number, { page: request.page })
          : await c.writer.listReviewComments(c.repo, request.number, { page: request.page });
      const after = await c.client.getPull(c.repo, request.number);
      this.pullHead(after, request);
      assert(
        isDeepStrictEqual(before.head, after.head) && isDeepStrictEqual(before.base, after.base),
        409,
        'PR 的来源或目标已变化',
      );
      result = {
        ...remoteBase,
        view: request.view,
        number: request.number,
        headSha: request.headSha,
        baseSha: request.baseSha,
        result: page,
      };
    }
    c.current();
    return githubWriteReadResultSchema.parse(result);
  }
  private pullHead(pull: GithubPull, expected: { headSha: string; baseSha?: string }) {
    assert(
      pull.head.sha === expected.headSha &&
        (!expected.baseSha || pull.base.sha === expected.baseSha),
      409,
      'PR 提交已变化，请重新读取并审查',
    );
  }
  private async preflight(
    request: Exclude<GithubWriteAction, { action: 'commit' | 'push' }>,
    c: ReturnType<SessionGithubWriteManager['remote']>,
  ) {
    await c.client.getRepository(c.repo);
    c.current();
    if (request.action === 'issue-comment') {
      const item =
        request.subject === 'pull'
          ? await c.client.getPull(c.repo, request.number)
          : await c.client.getIssue(c.repo, request.number);
      assert(item.version === request.expectedVersion, 409, '评论目标已变化，请重新审查');
    } else if (request.action === 'pr-create') {
      assert(request.headBranch !== request.baseBranch, 400, 'PR 来源和目标分支必须不同');
      const head = await c.client.getBranch(c.repo, request.headBranch),
        base = await c.client.getBranch(c.repo, request.baseBranch);
      assert(
        head.sha === request.headSha && base.sha === request.baseSha,
        409,
        'PR 分支提交已变化，请重新审查',
      );
    } else {
      const pull = await c.client.getPull(c.repo, request.number);
      this.pullHead(pull, request);
      if ('expectedVersion' in request)
        assert(pull.version === request.expectedVersion, 409, 'PR 已变化，请重新审查');
      if (request.action === 'review-comment') {
        assert(pull.state === 'open', 409, '只能在开放 PR 中发布新的行评论');
        const page = await c.writer.listPullFiles(c.repo, request.number, {
            page: request.filePage,
          }),
          file = page.items.find((f) => f.path === request.path);
        assert(
          file && file.version === request.fileVersion,
          409,
          '所选文件版本已变化或未包含于此页',
        );
        assert(
          githubPatchLines(file).some((line) =>
            request.side === 'LEFT' ? line.oldLine === request.line : line.newLine === request.line,
          ),
          400,
          '所选行不在可验证的 PR 补丁内',
        );
      } else if (request.action === 'review-reply') {
        const parent = (await c.writer.getReviewComment(c.repo, request.number, request.commentId))
          .value;
        assert(
          !parent.replyTo && parent.version === request.commentVersion,
          409,
          '原评论已变化，或不是可回复的顶层评论',
        );
      } else if (request.action === 'pr-merge')
        assert(pull.state === 'open' && !pull.draft, 409, '只有开放且非草稿的 PR 可以合并');
      if (request.action === 'review-comment' || request.action === 'review-reply') {
        const after = await c.client.getPull(c.repo, request.number);
        this.pullHead(after, request);
        assert(
          isDeepStrictEqual(pull.head, after.head) && isDeepStrictEqual(pull.base, after.base),
          409,
          'PR 分支身份已变化',
        );
      }
    }
    c.current();
  }
  private async publish(
    request: Exclude<GithubWriteAction, { action: 'commit' | 'push' }>,
    plan: Plan,
    c: ReturnType<SessionGithubWriteManager['remote']>,
  ) {
    const body = 'body' in request ? githubOperationBody(request.body, plan.marker!) : undefined;
    switch (request.action) {
      case 'issue-comment':
        return c.writer.createIssueComment(c.repo, request.number, { body: body! });
      case 'review-comment':
        return c.writer.createReviewComment(c.repo, request.number, {
          body: body!,
          commitSha: request.headSha,
          path: request.path,
          side: request.side,
          line: request.line,
        });
      case 'review-reply':
        return c.writer.replyReviewComment(c.repo, request.number, request.commentId, {
          body: body!,
        });
      case 'pr-create':
        return c.writer.createPull(c.repo, {
          headBranch: request.headBranch,
          baseBranch: request.baseBranch,
          title: request.title,
          body: body!,
          draft: request.draft,
        });
      case 'pr-update':
        return c.writer.updatePull(c.repo, request.number, { title: request.title, body: body! });
      case 'pr-state':
        return c.writer.updatePull(c.repo, request.number, { state: request.state });
      case 'pr-merge':
        return c.writer.mergePull(c.repo, request.number, {
          headSha: request.headSha,
          method: request.method,
        });
    }
  }
  async action(input: GithubWriteAction, localProjectId?: string): Promise<GithubWriteReceipt> {
    const request = githubWriteActionSchema.parse(input);
    return this.host.serial(request.sessionId, async () => {
      const { scope, lease } = this.lease(request, localProjectId),
        existing = this.lookup(scope, request);
      if (existing) return this.prior(request, existing);
      assert(
        !this.host.store.forks.blocked(scope.sessionId) &&
          !this.host.forkManager.busy.has(scope.sessionId),
        409,
        '请先确认此会话的 Fork',
      );
      const plan: Plan = { scope, requestVersion: hash(JSON.stringify(request)) };
      let root: string | undefined;
      try {
        let c: ReturnType<SessionGithubWriteManager['remote']> | undefined;
        const current = () => {
          this.currentLease(request, lease, localProjectId);
          if (plan.execution)
            assert(
              isDeepStrictEqual(
                this.host.executionLease(scope, localProjectId, true),
                plan.execution,
              ),
              409,
              '原操作的工作目录已变化',
            );
          c?.current();
        };
        const beforeDispatch = () => {
          current();
          if (plan.commit) {
            this.idleRoot(plan.commit.candidate.repository.rootPath);
            assert(this.idle(scope.sessionId), 409, '提交期间会话已开始执行');
          }
          this.dispatch(scope, request);
        };
        const onResult = (result: GithubWriteOutcome) => {
          this.settle(
            scope,
            request,
            this.receipt(
              request,
              'accepted',
              request.action === 'pr-create' && result.sha !== request.headSha
                ? 'PR 已创建，但创建期间来源分支已变化；请检查下方实际提交并重新读取 PR'
                : '执行主机已确认原操作结果',
              result,
            ),
          );
        };
        if (request.action !== 'commit') {
          c = this.remote(request, localProjectId, true, { beforeDispatch, onResult });
          assert(
            c.config.version === request.configVersion &&
              c.revision === request.expectedBindingRevision,
            409,
            '仓库授权或会话关联已变化，请重新审查',
          );
          plan.remote = c.repo;
        }
        if (request.action === 'commit' || request.action === 'push') {
          assert(this.idle(scope.sessionId), 409, '请先停止活动回合并确认结果');
          plan.execution = this.host.executionLease(scope, localProjectId, true);
          this.assertExecutionAvailable(plan.execution);
          assert(
            plan.execution.executionRevision === request.executionRevision,
            409,
            '工作目录版本已变化',
          );
          if (request.action === 'commit') {
            root = plan.execution.rootPath;
            this.busyRoots.add(root);
            const candidate = await this.git.inspectCommitCandidate(root, request.paths, {
              assertCurrent: current,
            });
            assert(
              candidate.version === request.candidateVersion &&
                candidate.branch === request.branch &&
                candidate.parentOid === request.parentOid &&
                candidate.indexVersion === request.indexVersion,
              409,
              '选中文件、分支或暂存区已变化，请重新审查',
            );
            this.idleRoot(candidate.repository.rootPath);
            this.busyRoots.delete(root);
            this.assertExecutionAvailable({ rootPath: candidate.repository.rootPath });
            root = candidate.repository.rootPath;
            this.busyRoots.add(root);
            plan.commit = await this.git.planProjectCommit(
              candidate,
              {
                message: request.message,
                author: request.author,
                timestamp: this.now(),
              },
              { assertCurrent: current },
            );
          } else {
            await c!.client.getRepository(c!.repo);
            const read = await this.git.readProjectGit(plan.execution.rootPath);
            current();
            assert(
              read.repository &&
                read.state.writeSupported &&
                read.state.branch === request.branch &&
                read.state.headOid === request.headOid,
              409,
              '推送分支或本地提交已变化',
            );
            plan.push = {
              version: 1,
              repository: read.repository,
              branch: request.branch,
              headOid: request.headOid,
              remote: c!.repo,
              expectedRemoteOid: request.expectedRemoteOid,
            };
          }
        } else {
          const author = await c!.client.getUser();
          plan.authorId = author.id;
          plan.marker = hash(JSON.stringify([key(scope), request]));
          await this.preflight(request, c!);
        }
        current();
        this.stage(scope, request, plan);
        let result: GithubWriteOutcome;
        if (plan.commit) {
          let committed: { oid: string };
          try {
            committed = await this.git.commitProject(plan.commit, {
              assertCurrent: current,
              onDispatched: beforeDispatch,
            });
          } catch (error) {
            // The local writer awaits every subprocess and finishes its lock cleanup
            // before rejecting. A process crash never manufactures this evidence.
            plan.writerSettled = true;
            this.host.store.journal.db
              .prepare('UPDATE operation SET approval=? WHERE id=?')
              .run(JSON.stringify(plan), request.operationId);
            throw error;
          }
          result = { sha: committed.oid };
          onResult(result);
        } else if (plan.push) {
          const pushed = await this.git.pushProject(plan.push, {
            token: c!.config.token,
            assertCurrent: current,
            onDispatched: beforeDispatch,
            transport: this.options.pushTransport?.(plan.push),
          });
          result = { sha: pushed.oid };
          onResult(result);
        } else
          result = await this.publish(
            request as Exclude<GithubWriteAction, { action: 'commit' | 'push' }>,
            plan,
            c!,
          );
        current();
        return this.settle(
          scope,
          request,
          this.receipt(request, 'accepted', '执行主机已确认原操作结果', result),
        );
      } catch (error) {
        const record = this.lookup(scope, request);
        if (record) {
          if (record.phase === 'github-write-accepted') {
            try {
              this.currentLease(request, lease, localProjectId);
            } catch {
              throw new AppError(409, '原操作的执行范围已变化，请在原范围核查结果', false);
            }
            return this.prior(request, record);
          }
          if (error instanceof GitHubWriteClientError && error.knownResult) {
            const receipt = this.settle(
              scope,
              request,
              this.receipt(request, 'accepted', '执行主机已确认原操作结果', error.knownResult),
            );
            try {
              this.currentLease(request, lease, localProjectId);
            } catch {
              throw new AppError(409, '原操作的执行范围已变化，请在原范围核查结果', false);
            }
            return receipt;
          }
          const prepared =
            record.phase === 'github-write-prepared' ||
            (plan.commit &&
              plan.writerSettled &&
              error instanceof AppError &&
              error.rejected === true);
          const receipt = this.settle(
            scope,
            request,
            this.receipt(
              request,
              prepared ? 'rejected' : 'unknown',
              prepared
                ? '主机检查未通过，原操作未执行，请重新读取后审查'
                : '原操作结果尚未确认。请手动核查；不会重复发布或推送',
            ),
          );
          try {
            this.currentLease(request, lease, localProjectId);
          } catch {
            throw new AppError(409, '原操作的执行范围已变化，请在原范围核查结果', false);
          }
          return receipt;
        }
        throw new AppError(
          error instanceof AppError ? error.status : 409,
          error instanceof AppError ? error.message : '写入预检失败，原操作尚未执行',
          true,
        );
      } finally {
        if (root) this.busyRoots.delete(root);
      }
    });
  }
  private matchesBody<T>(record: GitHubRecovery<T>, request: GithubWriteAction, plan: Plan) {
    return (
      'body' in request &&
      record.authorId === plan.authorId &&
      record.marker === plan.marker &&
      record.bodyVersion === hash(githubOperationBody(request.body, plan.marker!))
    );
  }
  async inspect(input: GithubWriteInspect, localProjectId?: string): Promise<GithubWriteReceipt> {
    const { request, page } = githubWriteInspectSchema.parse(input);
    return this.host.serial(request.sessionId, async () => {
      const { scope } = this.lease(request, localProjectId),
        record = this.lookup(scope, request);
      if (!record)
        return this.receipt(
          request,
          'unknown',
          '主机尚未记录原操作。核查不会首次执行；可明确撤销待确认请求',
        );
      const prior = this.prior(request, record);
      if (['accepted', 'rejected', 'abandoned'].includes(prior.phase)) return prior;
      const plan = JSON.parse(record.approval!) as Plan;
      if (record.phase === 'github-write-prepared')
        return this.receipt(
          request,
          'unknown',
          '主机未确认发出原操作；可撤销此请求，核查不会执行它',
        );
      try {
        if (plan.commit) {
          const current = () => {
            this.lease(request, localProjectId);
            assert(
              isDeepStrictEqual(
                this.host.executionLease(scope, localProjectId, true),
                plan.execution,
              ),
              409,
              '原提交工作目录已变化',
            );
          };
          const state = await this.git.inspectProjectCommit(plan.commit, {
            assertCurrent: current,
          });
          current();
          if (state.status === 'accepted')
            return this.settle(
              scope,
              request,
              this.receipt(request, 'accepted', '已核实原提交与暂存区', { sha: state.oid }),
            );
        } else {
          const c = this.remote(request, localProjectId);
          assert(isDeepStrictEqual(c.repo, plan.remote), 409, '原仓库已不在此项目的授权范围');
          await c.client.getRepository(c.repo);
          c.current();
          let result: GithubWriteOutcome | undefined;
          if (plan.push) {
            const state = await this.git.inspectProjectPush(plan.push, {
              token: c.config.token,
              assertCurrent: c.current,
              transport: this.options.pushTransport?.(plan.push),
            });
            if (state.status === 'accepted') result = { sha: plan.push.headOid };
          } else if (request.action === 'issue-comment') {
            const list = await c.writer.listRecoveryIssueComments(c.repo, request.number, { page });
            const matches = list.items.filter((item) => this.matchesBody(item, request, plan));
            if (matches.length === 1) result = { id: matches[0]!.value.id, number: request.number };
          } else if (request.action === 'review-comment' || request.action === 'review-reply') {
            const list = await c.writer.listRecoveryReviewComments(c.repo, request.number, {
              page,
            });
            const matches = list.items.filter(
              (item) =>
                this.matchesBody(item, request, plan) &&
                (request.action === 'review-reply'
                  ? item.value.replyTo === request.commentId
                  : item.value.path === request.path &&
                    item.value.originalCommitSha === request.headSha &&
                    item.value.side === request.side &&
                    item.value.originalLine === request.line),
            );
            if (matches.length === 1) result = { id: matches[0]!.value.id, number: request.number };
          } else if (request.action === 'pr-create') {
            const list = await c.writer.listRecoveryPulls(c.repo, {
              headBranch: request.headBranch,
              baseBranch: request.baseBranch,
              page,
            });
            const matches = list.items.filter(
              (item) =>
                this.matchesBody(item, request, plan) &&
                item.value.title === request.title &&
                item.value.head.sha === request.headSha &&
                item.value.base.sha === request.baseSha,
            );
            if (matches.length === 1)
              result = { id: matches[0]!.value.id, number: matches[0]!.value.number };
          } else if (request.action === 'pr-update') {
            const item = await c.writer.getRecoveryPull(c.repo, request.number);
            // A later editor may have changed the PR again; absence is never permission to retry PATCH.
            if (
              item.marker === plan.marker &&
              item.bodyVersion === hash(githubOperationBody(request.body, plan.marker!)) &&
              item.value.title === request.title
            )
              result = { id: item.value.id, number: item.value.number };
          } else if (request.action === 'pr-state') {
            const item = await c.client.getPull(c.repo, request.number);
            if (item.state === request.state && item.head.sha === request.headSha)
              result = { id: item.id, number: item.number };
          } else if (request.action === 'pr-merge') {
            const item = await c.client.getPull(c.repo, request.number);
            if (item.state === 'merged' && item.head.sha === request.headSha)
              result = { id: item.id, number: item.number };
          }
          c.current();
          if (result)
            return this.settle(
              scope,
              request,
              this.receipt(request, 'accepted', '已核实远端符合原操作的结果；未重复写入', result),
            );
        }
      } catch (error) {
        if (error instanceof AppError) throw new AppError(error.status, error.message, false);
        throw new AppError(409, '原操作结果仍无法核实，请保留原编号', false);
      }
      return this.settle(
        scope,
        request,
        this.receipt(
          request,
          'unknown',
          '本次查询未能确认结果。可查看另一页或稍后手动核查；不会重复执行',
          undefined,
          prior.released,
        ),
      );
    });
  }
  async abandon(
    input: { request: GithubWriteAction },
    localProjectId?: string,
  ): Promise<GithubWriteReceipt> {
    const { request } = githubWriteAbandonSchema.parse(input);
    return this.host.serial(request.sessionId, async () => {
      const { scope } = this.lease(request, localProjectId);
      let record = this.lookup(scope, request);
      if (record) {
        const prior = this.prior(request, record);
        if (['accepted', 'rejected', 'abandoned'].includes(prior.phase) || prior.released)
          return prior;
      }
      if (!record) {
        assert(!this.host.store.forks.blocked(scope.sessionId), 409, '请先确认此会话的 Fork');
        this.stage(scope, request, { scope, requestVersion: hash(JSON.stringify(request)) });
        record = this.lookup(scope, request)!;
      }
      if (record.phase === 'github-write-prepared')
        return this.settle(
          scope,
          request,
          this.receipt(request, 'abandoned', '主机已停止原操作，迟到的同编号请求也不会执行'),
        );
      const plan = JSON.parse(record.approval!) as Plan;
      if (plan.commit) {
        assert(plan.writerSettled, 409, '原提交进程尚未确认收尾，不能仅关闭待确认记录');
        assert(this.idle(scope.sessionId), 409, '请先停止活动回合并确认结果');
        this.idleRoot(plan.commit.candidate.repository.rootPath);
        const current = () => {
          this.lease(request, localProjectId);
          assert(
            isDeepStrictEqual(
              this.host.executionLease(scope, localProjectId, true),
              plan.execution,
            ),
            409,
            '原提交工作目录已变化',
          );
        };
        const state = await this.git.inspectProjectCommit(plan.commit, { assertCurrent: current });
        current();
        assert(
          state.status === 'not-applied',
          409,
          '原提交的分支或暂存区尚未确认回到原基线，不能结束核查',
        );
        return this.settle(
          scope,
          request,
          this.receipt(
            request,
            'unknown',
            '已核实本机写入进程收尾，当前分支与暂存区符合原基线；按你的操作结束核查，不删除 Git 对象，也不会重跑原请求',
            undefined,
            true,
          ),
        );
      }
      return this.settle(
        scope,
        request,
        this.receipt(
          request,
          'unknown',
          '已结束本次核查，远端结果仍未知；这不表示撤销了已发出的操作。原编号不会再次执行',
          undefined,
          true,
        ),
      );
    });
  }
}
