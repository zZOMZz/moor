import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { AppError, assert } from '../protocol';
import { metas } from '../model';
import {
  githubActionSchema,
  githubBindingSchema,
  githubReadSchema,
  githubReadResultSchema,
  githubReceiptSchema,
  type GithubAction,
  type GithubBinding,
  type GithubRead,
  type GithubReadResult,
  type GithubReceipt,
  type GithubRepository,
  type GithubPull,
} from '../github-protocol';
import type { AttachmentScope, RuntimeStore } from './store';
import type { ContentScope } from '../content-protocol';
import type { GitHubConfig, GitHubProjectConfig } from './github-config';
import { createGitHubClient } from './github-client';
import type { SessionExecutionManager } from './session-execution';

const key = (scope: AttachmentScope) =>
  JSON.stringify([
    scope.workspaceId,
    scope.userId,
    scope.machineId,
    scope.localProjectId,
    scope.sessionId,
  ]);
export class SessionGithubStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS session_github(session_id TEXT PRIMARY KEY,scope TEXT NOT NULL,binding TEXT NOT NULL)',
    );
  }
  get(scope: AttachmentScope): GithubBinding {
    const row = this.db
      .prepare('SELECT scope,binding FROM session_github WHERE session_id=?')
      .get(scope.sessionId);
    if (!row) return { revision: 0 };
    assert(row.scope === key(scope), 409, 'GitHub 会话绑定属于另一执行范围');
    return githubBindingSchema.parse(JSON.parse(String(row.binding)));
  }
  put(scope: AttachmentScope, binding: GithubBinding) {
    this.get(scope);
    this.db
      .prepare(
        'INSERT INTO session_github VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET binding=excluded.binding',
      )
      .run(scope.sessionId, key(scope), JSON.stringify(githubBindingSchema.parse(binding)));
  }
}
type Host = {
  store: RuntimeStore;
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
  serial<T>(id: string, work: () => Promise<T>): Promise<T>;
};
export type SessionGithubOptions = {
  config?: Pick<GitHubConfig, 'getProject' | 'isCurrent'>;
  client?: typeof createGitHubClient;
  now?: () => number;
  signal?: () => AbortSignal;
};
export class SessionGithubManager {
  constructor(
    private host: Host,
    private options: SessionGithubOptions = {},
  ) {}
  private lease(input: ContentScope, localProjectId?: string) {
    this.host.ensureConnected();
    const store = this.host.store;
    const lease =
      metas(store.meta)['session-' + input.sessionId] ||
      store.searchSource(input.sessionId) ||
      store.hasNativeSession(input.sessionId)
        ? this.host.projectLease(input, localProjectId)
        : this.host.projectRootLease(input, localProjectId);
    const { rootPath, ...scope } = lease;
    store.github.get(scope);
    return { ...scope, rootPath };
  }
  private scope(lease: AttachmentScope & { rootPath: string }) {
    const { rootPath: _, ...scope } = lease;
    return scope;
  }
  private config(scope: ContentScope) {
    const value = this.options.config?.getProject(scope.localProjectId);
    assert(value, 409, '请在执行电脑的本机设置中登记并验证此项目的 GitHub 仓库');
    return value;
  }
  private context(input: ContentScope, localProjectId?: string) {
    const lease = this.lease(input, localProjectId),
      scope = this.scope(lease),
      config = this.config(scope),
      signal = this.options.signal?.() ?? AbortSignal.timeout(25_000);
    const current = () => {
      assert(!signal.aborted, 504, 'GitHub 本次读取已超时或取消，请手动重试');
      assert(
        isDeepStrictEqual(this.lease(input, localProjectId), lease),
        409,
        'GitHub 请求的项目执行范围已变化',
      );
      assert(
        this.options.config?.isCurrent(config),
        409,
        'GitHub 本机授权或项目登记已变化，请重新读取',
      );
    };
    current();
    const client = (this.options.client ?? createGitHubClient)({
      token: config.token,
      assertCurrent: current,
      signal,
    });
    return {
      scope,
      config,
      current,
      client,
      repo: { owner: config.owner, repo: config.repo, repositoryId: config.repositoryId },
    };
  }
  private envelope(scope: ContentScope) {
    return {
      githubVersion: 1 as const,
      workspaceId: scope.workspaceId,
      localProjectId: scope.localProjectId,
      sessionId: scope.sessionId,
    };
  }
  private readAt() {
    return new Date((this.options.now ?? Date.now)()).toISOString();
  }
  private pinned(repository: GithubRepository, config: GitHubProjectConfig) {
    assert(
      repository.id === config.repositoryId &&
        repository.owner.toLowerCase() === config.owner.toLowerCase() &&
        repository.name.toLowerCase() === config.repo.toLowerCase(),
      409,
      'GitHub 仓库身份已变化，请在执行电脑重新确认',
    );
  }
  private pullCurrent(before: GithubPull, after: GithubPull) {
    assert(
      before.number === after.number &&
        isDeepStrictEqual(before.head, after.head) &&
        isDeepStrictEqual(before.base, after.base),
      409,
      'PR 的提交已变化，请重新读取后查看 CI',
    );
  }
  async read(input: GithubRead, localProjectId?: string): Promise<GithubReadResult> {
    const request = githubReadSchema.parse(input),
      lease = this.lease(request, localProjectId),
      scope = this.scope(lease);
    const initialBinding = this.host.store.github.get(scope);
    if (request.view === 'overview') {
      let unavailable: string | undefined;
      try {
        if (!this.options.config?.getProject(scope.localProjectId))
          unavailable = '请在执行电脑的本机设置中登记并验证 GitHub 仓库';
      } catch (error) {
        unavailable =
          error instanceof AppError ? error.message : 'GitHub 本机设置不可读取，请在执行电脑检查';
      }
      if (unavailable)
        return githubReadResultSchema.parse({
          ...this.envelope(scope),
          view: 'overview',
          confirmed: true,
          status: 'unavailable',
          binding: { revision: initialBinding.revision },
          reason: unavailable,
          readAt: this.readAt(),
        });
    }
    const c = this.context(request, localProjectId);
    if (request.view !== 'overview')
      assert(
        request.repositoryId === c.config.repositoryId &&
          request.configVersion === c.config.version,
        409,
        'GitHub 仓库或本机授权已变化，请重新读取',
      );
    const repository = await c.client.getRepository(c.repo);
    c.current();
    this.pinned(repository, c.config);
    const base = {
      ...this.envelope(scope),
      confirmed: true as const,
      repository,
      configVersion: c.config.version,
      binding:
        initialBinding.context &&
        (initialBinding.context.repository.id !== repository.id ||
          initialBinding.context.repository.owner.toLowerCase() !==
            repository.owner.toLowerCase() ||
          initialBinding.context.repository.name.toLowerCase() !== repository.name.toLowerCase())
          ? { revision: initialBinding.revision }
          : initialBinding,
      readAt: this.readAt(),
    };
    let result: unknown;
    switch (request.view) {
      case 'overview': {
        let localBranch: string | undefined, localHeadSha: string | undefined;
        try {
          const git = await this.host.executionManager.read({ gitVersion: 1, ...scope });
          localBranch = git.repository.branch;
          localHeadSha = git.repository.headOid;
        } catch {
          /* GitHub context can be read even when live Git is unavailable. */
        }
        result = {
          ...base,
          view: 'overview',
          status: 'available',
          localBranch,
          localHeadSha,
          execution: this.host.store.executions.info(scope),
        };
        break;
      }
      case 'branches':
        result = {
          ...base,
          view: request.view,
          result: await c.client.listBranches(c.repo, { page: request.page }),
        };
        break;
      case 'issues':
        result = {
          ...base,
          view: request.view,
          state: request.state,
          result: await c.client.listIssues(c.repo, { page: request.page, state: request.state }),
        };
        break;
      case 'pulls':
        result = {
          ...base,
          view: request.view,
          state: request.state,
          result: await c.client.listPulls(c.repo, { page: request.page, state: request.state }),
        };
        break;
      case 'issue':
        result = {
          ...base,
          view: request.view,
          item: await c.client.getIssue(c.repo, request.number),
        };
        break;
      case 'pull':
        result = {
          ...base,
          view: request.view,
          item: await c.client.getPull(c.repo, request.number),
        };
        break;
      case 'comments': {
        // Verify the kind as well as the issue number; PR and Issue share GitHub's number space.
        if (request.subject === 'pull') await c.client.getPull(c.repo, request.number);
        else await c.client.getIssue(c.repo, request.number);
        result = {
          ...base,
          view: request.view,
          number: request.number,
          subject: request.subject,
          result: await c.client.listComments(c.repo, request.number, { page: request.page }),
        };
        break;
      }
      case 'checks': {
        const before = await c.client.getPull(c.repo, request.number);
        assert(before.head.sha === request.headSha, 409, 'PR 提交已变化，请重新读取');
        const [checkResult, statusResult] = await Promise.allSettled([
          c.client.listChecks(c.repo, request.headSha, { page: request.page }),
          c.client.getCombinedStatus(c.repo, request.headSha, { page: request.page }),
        ]);
        if (checkResult.status === 'rejected') throw checkResult.reason;
        if (statusResult.status === 'rejected') throw statusResult.reason;
        const checks = checkResult.value,
          statuses = statusResult.value;
        const after = await c.client.getPull(c.repo, request.number);
        this.pullCurrent(before, after);
        result = {
          ...base,
          view: request.view,
          number: request.number,
          headSha: request.headSha,
          checks,
          statuses,
        };
        break;
      }
    }
    c.current();
    assert(
      isDeepStrictEqual(initialBinding, this.host.store.github.get(scope)),
      409,
      '会话的 GitHub 绑定已变化，请重新读取',
    );
    return githubReadResultSchema.parse(result);
  }
  async action(input: GithubAction, localProjectId?: string): Promise<GithubReceipt> {
    const request = githubActionSchema.parse(input);
    try {
      return await this.host.serial(request.sessionId, async () => {
        const scope = this.scope(this.lease(request, localProjectId)),
          store = this.host.store;
        const prior = this.prior(scope, request);
        if (prior) return prior;
        assert(
          !this.host.forkManager.busy.has(scope.sessionId) && !store.forks.blocked(scope.sessionId),
          409,
          '请先确认此会话的 Fork 操作',
        );
        const current = store.github.get(scope);
        let repository: GithubRepository | undefined,
          c: ReturnType<SessionGithubManager['context']> | undefined;
        if (request.action === 'bind') {
          c = this.context(request, localProjectId);
          assert(request.repositoryId === c.config.repositoryId, 409, 'GitHub 仓库登记已变化');
          repository = await c.client.getRepository(c.repo);
          c.current();
          this.pinned(repository, c.config);
        }
        assert(
          current.revision === request.expectedRevision,
          409,
          'GitHub 会话绑定已变化，请重新读取',
        );
        let context: GithubBinding['context'];
        if (request.action === 'bind') {
          assert(
            request.configVersion === c!.config.version,
            409,
            'GitHub 本机授权已变化，请重新读取',
          );
          let pull: GithubPull | undefined;
          if (request.subject) {
            const subject = request.subject;
            const item =
              subject.kind === 'pull'
                ? await c!.client.getPull(c!.repo, subject.number)
                : await c!.client.getIssue(c!.repo, subject.number);
            assert(item.version === subject.version, 409, '所选 GitHub 上下文已变化，请重新读取');
            if (subject.kind === 'pull') {
              assert(
                item.kind === 'pull' &&
                  item.head.sha === subject.headSha &&
                  item.head.branch === request.branch,
                409,
                'PR 的来源分支或提交已变化',
              );
              pull = item;
            }
          }
          if (!pull) await c!.client.getBranch(c!.repo, request.branch);
          c!.current();
          context = {
            repository: { id: repository!.id, owner: repository!.owner, name: repository!.name },
            branch: request.branch,
            subject: request.subject,
            updatedAt: this.readAt(),
            ...(pull
              ? {
                  headRepository: pull.head.repository,
                  baseBranch: pull.base.branch,
                  baseSha: pull.base.sha,
                }
              : {}),
          };
        }
        const binding: GithubBinding = {
          revision: current.revision + 1,
          ...(context ? { context } : {}),
        };
        const result = githubReceiptSchema.parse({
          ...this.envelope(scope),
          operationId: request.operationId,
          confirmed: true,
          binding,
        });
        this.lease(request, localProjectId);
        c?.current();
        assert(
          !this.host.forkManager.busy.has(scope.sessionId) && !store.forks.blocked(scope.sessionId),
          409,
          '请先确认此会话的 Fork 操作',
        );
        return store.transaction(() => {
          assert(
            store.github.get(scope).revision === current.revision,
            409,
            'GitHub 会话绑定已变化',
          );
          store.reserveAttachmentScope(scope);
          store.github.put(scope, binding);
          return store.journal.acceptGithub(key(scope), request, result);
        });
      });
    } catch (error) {
      if (this.host.store.journal.has(request.operationId)) {
        if (error instanceof AppError) throw new AppError(error.status, error.message, false);
        throw new AppError(409, 'GitHub 原操作结果尚未确认，请恢复访问后手动检查', false);
      }
      if (error instanceof AppError) throw new AppError(error.status, error.message, true);
      throw new AppError(409, 'GitHub 绑定尚未保存，请重新读取执行电脑状态', true);
    }
  }
  private prior(scope: AttachmentScope, request: GithubAction): GithubReceipt | undefined {
    const prior = this.host.store.journal.lookup(key(scope), request);
    if (!prior) return;
    assert(
      prior.phase === 'github-accepted' || prior.phase === 'github-abandoned',
      409,
      'GitHub 操作编号已用于其他操作',
    );
    const receipt = githubReceiptSchema.parse(JSON.parse(prior.result));
    // These receipts describe the original operation, never the current binding.
    // An abandoned operation keeps its exact fingerprint so a late action cannot run.
    if (prior.phase === 'github-abandoned' || request.action === 'unbind') return receipt;
    return githubReceiptSchema.parse({
      ...receipt,
      redacted: true,
      binding: { revision: receipt.binding.revision },
    });
  }
  async abandon(input: GithubAction, localProjectId?: string): Promise<GithubReceipt> {
    const request = githubActionSchema.parse(input);
    try {
      return await this.host.serial(request.sessionId, async () => {
        const scope = this.scope(this.lease(request, localProjectId)),
          store = this.host.store;
        const prior = this.prior(scope, request);
        if (prior) return prior;
        assert(
          !this.host.forkManager.busy.has(scope.sessionId) && !store.forks.blocked(scope.sessionId),
          409,
          '请先确认此会话的 Fork 操作',
        );
        const receipt = githubReceiptSchema.parse({
          ...this.envelope(scope),
          operationId: request.operationId,
          confirmed: true,
          abandoned: true,
          binding: { revision: request.expectedRevision },
        });
        return store.transaction(() => {
          this.lease(request, localProjectId);
          const existing = this.prior(scope, request);
          if (existing) return existing;
          store.reserveAttachmentScope(scope);
          return store.journal.abandonGithub(key(scope), request, receipt);
        });
      });
    } catch (error) {
      // A failed abandonment never proves whether the original action ran, including
      // when the terminal record exists but a scope change prevents its disclosure.
      if (error instanceof AppError) throw new AppError(error.status, error.message, false);
      throw new AppError(409, 'GitHub 原请求尚未确认停止，请手动重试原编号', false);
    }
  }
}
