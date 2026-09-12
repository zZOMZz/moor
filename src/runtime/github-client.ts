import { createHash } from 'node:crypto';
import { AppError } from '../protocol';
import {
  GITHUB_LIMITS,
  githubBranchSchema,
  githubRepositorySchema,
  githubItemSummarySchema,
  githubIssueSchema,
  githubPullSchema,
  githubCommentSchema,
  githubCheckSchema,
  githubStatusesPageSchema,
  type GithubRepository,
  type GithubPage,
  type GithubBranch,
  type GithubItemSummary,
  type GithubIssue,
  type GithubPull,
  type GithubComment,
  type GithubCheck,
  type GithubStatusesPage,
} from '../github-protocol';
import type { z } from 'zod';

export const GITHUB_API_VERSION = '2026-03-10';
export const GITHUB_CLIENT_LIMITS = {
  responseBytes: 2 * 1024 * 1024,
  timeoutMs: 10_000,
  pageSize: GITHUB_LIMITS.pageSize,
  maxPage: GITHUB_LIMITS.pages,
  bodyCharacters: GITHUB_LIMITS.bodyChars,
} as const;

export type GitHubRepositoryTarget = { owner: string; repo: string; repositoryId: number };
export type GitHubClientOptions = {
  token: string;
  fetch?: typeof globalThis.fetch;
  // Local host callbacks only. These never enter an HTTP request.
  assertCurrent?: () => void;
  signal?: AbortSignal;
  scheduleTimeout?: (callback: () => void, delay: number) => () => void;
};
export type GitHubClientErrorCode =
  | 'invalid-request'
  | 'credentials'
  | 'forbidden'
  | 'not-found'
  | 'rate-limit'
  | 'redirect'
  | 'stale'
  | 'timeout'
  | 'cancelled'
  | 'too-large'
  | 'invalid-response'
  | 'network'
  | 'unavailable';
export class GitHubClientError extends AppError {
  constructor(
    public code: GitHubClientErrorCode,
    status: number,
    message: string,
    public retryAfterSeconds?: number,
    public rateLimitResetAt?: number,
  ) {
    super(status, message, true);
  }
}
type JsonObject = Record<string, unknown>;
type JsonResult = { data: unknown; hasNext: boolean };
type ListOptions = { page?: number; state?: 'open' | 'closed' | 'all' };
const origin = 'https://api.github.com';
const invalidResponse = () =>
  new GitHubClientError('invalid-response', 502, 'GitHub 返回的数据格式无效。');
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as JsonObject;
}
function text(value: unknown, max = 500): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    throw invalidResponse();
  return value;
}
function integer(value: unknown, zero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (zero ? 0 : 1)) throw invalidResponse();
  return value as number;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalidResponse();
  return value;
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw invalidResponse();
  return value as T;
}
function nullableText(value: unknown, max = 500): string | null {
  return value === null ? null : text(value, max);
}
function sha(value: unknown): string {
  const result = text(value, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(result)) throw invalidResponse();
  return result.toLowerCase();
}
function coordinate(owner: string, repo: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) ||
    repo === '.' ||
    repo === '..'
  )
    throw new GitHubClientError('invalid-request', 400, 'GitHub 仓库名称无效。');
}
function repositoryPath(repository: Pick<GitHubRepositoryTarget, 'owner' | 'repo'>): string {
  coordinate(repository.owner, repository.repo);
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}
function browserUrl(repository: Pick<GitHubRepositoryTarget, 'owner' | 'repo'>): string {
  coordinate(repository.owner, repository.repo);
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}
function requestNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new GitHubClientError('invalid-request', 400, 'GitHub 条目编号无效。');
  return value;
}
function requestSha(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value))
    throw new GitHubClientError('invalid-request', 400, '需要提供完整的 GitHub 提交 SHA。');
  return value.toLowerCase();
}
function requestBranch(value: string): string {
  if (
    !value ||
    value.length > 255 ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(value) ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value === '@' ||
    value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))
  )
    throw new GitHubClientError('invalid-request', 400, 'GitHub 分支名称无效。');
  return value;
}
function pageNumber(value = 1): number {
  if (!Number.isInteger(value) || value < 1 || value > GITHUB_CLIENT_LIMITS.maxPage)
    throw new GitHubClientError('invalid-request', 400, 'GitHub 页码必须介于 1 和 100 之间。');
  return value;
}
function listQuery(options: ListOptions, includeState = false): { page: number; query: string } {
  const page = pageNumber(options.page);
  const params = new URLSearchParams({
    per_page: String(GITHUB_CLIENT_LIMITS.pageSize),
    page: String(page),
  });
  if (includeState) {
    if (options.state !== undefined && !['open', 'closed', 'all'].includes(options.state))
      throw new GitHubClientError('invalid-request', 400, 'GitHub 列表状态无效。');
    params.set('state', options.state ?? 'open');
    params.set('sort', 'updated');
    params.set('direction', 'desc');
  }
  return { page, query: params.toString() };
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > GITHUB_CLIENT_LIMITS.pageSize)
    throw invalidResponse();
  return value;
}
function body(value: unknown): { body: string; bodyTruncated: boolean } {
  const full = value === null ? '' : text(value, GITHUB_CLIENT_LIMITS.responseBytes);
  // This exact trailing marker is host recovery metadata. Detail versions still hash
  // the unmodified upstream body; it never appears in the public display projection.
  const raw = full.replace(/\n\n<!-- moor-operation:sha256:[a-f0-9]{64} -->$/, '');
  let end = Math.min(raw.length, GITHUB_CLIENT_LIMITS.bodyCharacters);
  if (end < raw.length && /[\ud800-\udbff]/.test(raw[end - 1]) && /[\udc00-\udfff]/.test(raw[end]))
    end--;
  return {
    body: raw.slice(0, end),
    bodyTruncated: raw.length > GITHUB_CLIENT_LIMITS.bodyCharacters,
  };
}
function author(value: unknown): string {
  return value === null ? '[deleted]' : text(object(value).login, 100);
}
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidResponse();
  return result.data;
}
function version(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function pageResult<T>(items: T[], page: number, hasNext: boolean, partial = false): GithubPage<T> {
  // hasNext describes the upstream page even when the local page ceiling prevents further reads.
  return { items, page, hasNext, partial: partial || hasNext || page > 1 };
}
function safeHeaderNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (!raw || !/^\d{1,12}$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  return new GitHubClient(options);
}

export class GitHubClient {
  readonly #options: GitHubClientOptions;
  constructor(options: GitHubClientOptions) {
    if (!/^[\x21-\x7e]{1,4096}$/.test(options.token))
      throw new GitHubClientError('credentials', 401, '请在执行电脑上配置有效的 GitHub 令牌。');
    this.#options = { ...options };
  }
  private current(): void {
    if (this.#options.signal?.aborted)
      throw new GitHubClientError('cancelled', 409, 'GitHub 读取已取消。');
    try {
      this.#options.assertCurrent?.();
    } catch {
      throw new GitHubClientError('stale', 409, 'GitHub 授权或项目登记已变化，请重新读取。');
    }
  }
  private async request(path: string): Promise<JsonResult> {
    this.current();
    const controller = new AbortController();
    let timedOut = false;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () =>
          reject(
            new GitHubClientError(
              timedOut ? 'timeout' : 'cancelled',
              timedOut ? 504 : 409,
              timedOut ? 'GitHub 读取超时，请手动重试。' : 'GitHub 读取已取消。',
            ),
          ),
        { once: true },
      );
    });
    void aborted.catch(() => {});
    const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, aborted]);
    const abort = () => controller.abort();
    this.#options.signal?.addEventListener('abort', abort, { once: true });
    const schedule =
      this.#options.scheduleTimeout ??
      ((callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      });
    const cancelTimeout = schedule(() => {
      timedOut = true;
      controller.abort();
    }, GITHUB_CLIENT_LIMITS.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    try {
      this.current();
      const response = await wait(
        (this.#options.fetch ?? globalThis.fetch)(`${origin}${path}`, {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${this.#options.token}`,
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
            'User-Agent': 'Moor',
          },
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal,
        }),
      );
      responseBody = response.body;
      this.current();
      if (timedOut) throw new GitHubClientError('timeout', 504, 'GitHub 读取超时，请手动重试。');
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw new GitHubClientError(
          'redirect',
          409,
          'GitHub 资源地址已变化，请在执行电脑上重新确认仓库登记。',
        );
      if (response.url && response.url !== `${origin}${path}`) throw invalidResponse();
      if (response.status !== 200) {
        const retry = safeHeaderNumber(response.headers, 'retry-after');
        const reset = safeHeaderNumber(response.headers, 'x-ratelimit-reset');
        if (
          response.status === 429 ||
          (response.status === 403 &&
            (retry !== undefined || response.headers.get('x-ratelimit-remaining') === '0'))
        )
          throw new GitHubClientError(
            'rate-limit',
            429,
            '已达到 GitHub 请求限额，请在限额恢复后手动重试。',
            retry,
            reset,
          );
        if (response.status === 401)
          throw new GitHubClientError('credentials', 401, 'GitHub 令牌无效或已过期。');
        if (response.status === 403)
          throw new GitHubClientError(
            'forbidden',
            403,
            'GitHub 拒绝访问，请检查令牌权限和请求限额。',
          );
        if (response.status === 404)
          throw new GitHubClientError('not-found', 404, 'GitHub 资源不可用，或当前令牌无权访问。');
        throw new GitHubClientError(
          'unavailable',
          502,
          'GitHub 暂时无法完成读取，请稍后手动重试。',
        );
      }
      const length = safeHeaderNumber(response.headers, 'content-length');
      if (length !== undefined && length > GITHUB_CLIENT_LIMITS.responseBytes)
        throw new GitHubClientError('too-large', 502, 'GitHub 返回的数据超过读取大小限制。');
      if (!response.body) throw invalidResponse();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const result = await wait(reader.read());
        this.current();
        if (timedOut) throw new GitHubClientError('timeout', 504, 'GitHub 读取超时，请手动重试。');
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > GITHUB_CLIENT_LIMITS.responseBytes)
          throw new GitHubClientError('too-large', 502, 'GitHub 返回的数据超过读取大小限制。');
        chunks.push(result.value);
      }
      const raw = Buffer.concat(chunks, bytes).toString('utf8');
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw invalidResponse();
      }
      const link = response.headers.get('link') ?? '';
      if (link.length > 8192) throw invalidResponse();
      // Link destinations are never requested. Only a bounded relation marker is read.
      const hasNext = /(?:^|[,;])\s*rel\s*=\s*"next"(?:\s*[,;]|\s*$)/i.test(link);
      this.current();
      return { data, hasNext };
    } catch (error) {
      if (error instanceof GitHubClientError) throw error;
      this.current();
      if (timedOut) throw new GitHubClientError('timeout', 504, 'GitHub 读取超时，请手动重试。');
      throw new GitHubClientError('network', 502, '无法连接 GitHub，请检查网络后手动重试。');
    } finally {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      else if (responseBody) void responseBody.cancel().catch(() => {});
      cancelTimeout();
      this.#options.signal?.removeEventListener('abort', abort);
    }
  }

  async getUser(): Promise<{ id: number; login: string }> {
    const value = object((await this.request('/user')).data);
    return { id: integer(value.id), login: text(value.login, 100) };
  }
  async getRepository(target: {
    owner: string;
    repo: string;
    repositoryId?: number;
  }): Promise<GithubRepository> {
    const value = object((await this.request(repositoryPath(target))).data);
    const owner = text(object(value.owner).login, 39),
      repo = text(value.name, 100);
    const id = integer(value.id),
      fullName = text(value.full_name, 140);
    coordinate(owner, repo);
    if (
      fullName !== `${owner}/${repo}` ||
      owner.toLowerCase() !== target.owner.toLowerCase() ||
      repo.toLowerCase() !== target.repo.toLowerCase() ||
      (target.repositoryId !== undefined && id !== target.repositoryId)
    )
      throw new GitHubClientError('stale', 409, 'GitHub 仓库身份已变化，请在执行电脑上重新登记。');
    return parse(githubRepositorySchema, {
      id,
      owner,
      name: repo,
      defaultBranch: text(value.default_branch, 255),
      private: boolean(value.private),
      url: browserUrl({ owner, repo }),
    });
  }
  private async scoped<T>(target: GitHubRepositoryTarget, read: () => Promise<T>): Promise<T> {
    requestNumber(target.repositoryId);
    await this.getRepository(target);
    const result = await read();
    await this.getRepository(target);
    this.current();
    return result;
  }
  private branch(value: unknown): GithubBranch {
    const row = object(value);
    return parse(githubBranchSchema, {
      name: text(row.name, 255),
      sha: sha(object(row.commit).sha),
      protected: boolean(row.protected),
    });
  }
  async getBranch(target: GitHubRepositoryTarget, branch: string): Promise<GithubBranch> {
    const path = `${repositoryPath(target)}/branches/${encodeURIComponent(requestBranch(branch))}`;
    return this.scoped(target, async () => {
      const result = this.branch((await this.request(path)).data);
      if (result.name !== branch)
        throw new GitHubClientError('stale', 409, 'GitHub 分支已变化，请重新读取。');
      return result;
    });
  }
  async listBranches(
    target: GitHubRepositoryTarget,
    options: { page?: number } = {},
  ): Promise<GithubPage<GithubBranch>> {
    const { page, query } = listQuery(options);
    return this.scoped(target, async () => {
      const result = await this.request(`${repositoryPath(target)}/branches?${query}`);
      return pageResult(
        array(result.data).map((row) => this.branch(row)),
        page,
        result.hasNext || array(result.data).length === GITHUB_CLIENT_LIMITS.pageSize,
      );
    });
  }
  private summary(value: unknown, target: GitHubRepositoryTarget, pull = false): GithubItemSummary {
    const row = object(value),
      number = integer(row.number);
    const kind = pull || row.pull_request !== undefined ? 'pull' : 'issue';
    const merged =
      kind === 'pull' &&
      (row.merged === true ||
        typeof row.merged_at === 'string' ||
        (row.pull_request && object(row.pull_request).merged_at != null));
    return parse(githubItemSummarySchema, {
      id: integer(row.id),
      number,
      kind,
      title: text(row.title, GITHUB_LIMITS.title),
      state: merged ? 'merged' : enumeration(row.state, ['open', 'closed']),
      author: author(row.user),
      updatedAt: text(row.updated_at, 100),
      url: `${browserUrl(target)}/${kind === 'pull' ? 'pull' : 'issues'}/${number}`,
      ...(kind === 'pull' && row.draft !== undefined ? { draft: boolean(row.draft) } : {}),
    });
  }
  private detail(value: unknown, target: GitHubRepositoryTarget, pull = false) {
    const row = object(value),
      summary = this.summary(row, target, pull);
    if (!Array.isArray(row.labels) || row.labels.length > 50) throw invalidResponse();
    const labels = row.labels.map((value) =>
      text(typeof value === 'string' ? value : object(value).name, 100),
    );
    return { ...summary, ...body(row.body), labels };
  }
  private pull(value: unknown, target: GitHubRepositoryTarget): GithubPull {
    const row = object(value);
    const ref = (value: unknown) => {
      const row = object(value),
        repo = row.repo === null ? null : object(row.repo);
      const owner = repo ? text(object(repo.owner).login, 39) : null,
        name = repo ? text(repo.name, 100) : null;
      if (owner !== null && name !== null) coordinate(owner, name);
      return {
        branch: text(row.ref, 255),
        sha: sha(row.sha),
        repository: repo ? { id: integer(repo.id), owner: owner!, name: name! } : null,
      };
    };
    const base = ref(row.base),
      head = ref(row.head);
    if (
      base.repository?.id !== target.repositoryId ||
      base.repository.owner.toLowerCase() !== target.owner.toLowerCase() ||
      base.repository.name.toLowerCase() !== target.repo.toLowerCase()
    )
      throw new GitHubClientError('stale', 409, 'GitHub PR 所属仓库已变化，请重新读取。');
    const detail = {
      ...this.detail(value, target, true),
      kind: 'pull' as const,
      head,
      base: { ...base, repository: base.repository },
      mergeable:
        row.mergeable === undefined || row.mergeable === null ? null : boolean(row.mergeable),
    };
    return parse(githubPullSchema, { ...detail, version: version({ ...detail, body: row.body }) });
  }
  async listIssues(
    target: GitHubRepositoryTarget,
    options: ListOptions = {},
  ): Promise<GithubPage<GithubItemSummary>> {
    const { page, query } = listQuery(options, true);
    return this.scoped(target, async () => {
      const result = await this.request(`${repositoryPath(target)}/issues?${query}`);
      const rows = array(result.data);
      const items = rows
        .filter((row) => object(row).pull_request === undefined)
        .map((row) => this.summary(row, target));
      return pageResult(
        items,
        page,
        result.hasNext || rows.length === GITHUB_CLIENT_LIMITS.pageSize,
        items.length !== rows.length,
      );
    });
  }
  async getIssue(target: GitHubRepositoryTarget, number: number): Promise<GithubIssue> {
    requestNumber(number);
    return this.scoped(target, async () => {
      const row = object((await this.request(`${repositoryPath(target)}/issues/${number}`)).data),
        detail = this.detail(row, target);
      if (detail.kind !== 'issue')
        throw new GitHubClientError(
          'invalid-request',
          409,
          '此条目是 GitHub PR，请打开对应的 PR 详情。',
        );
      if (detail.number !== number) throw invalidResponse();
      return parse(githubIssueSchema, {
        ...detail,
        version: version({ ...detail, body: row.body }),
      });
    });
  }
  async listPulls(
    target: GitHubRepositoryTarget,
    options: ListOptions = {},
  ): Promise<GithubPage<GithubItemSummary>> {
    const { page, query } = listQuery(options, true);
    return this.scoped(target, async () => {
      const result = await this.request(`${repositoryPath(target)}/pulls?${query}`);
      const items = array(result.data).map((row) => {
        // Even list responses carry the base repository; reject a foreign repository projection.
        this.pull(row, target);
        return this.summary(row, target, true);
      });
      return pageResult(
        items,
        page,
        result.hasNext || items.length === GITHUB_CLIENT_LIMITS.pageSize,
      );
    });
  }
  async getPull(target: GitHubRepositoryTarget, number: number): Promise<GithubPull> {
    requestNumber(number);
    return this.scoped(target, async () => {
      const result = this.pull(
        (await this.request(`${repositoryPath(target)}/pulls/${number}`)).data,
        target,
      );
      if (result.number !== number) throw invalidResponse();
      return result;
    });
  }
  async listComments(
    target: GitHubRepositoryTarget,
    number: number,
    options: { page?: number } = {},
  ): Promise<GithubPage<GithubComment>> {
    requestNumber(number);
    const { page, query } = listQuery(options);
    return this.scoped(target, async () => {
      const result = await this.request(
        `${repositoryPath(target)}/issues/${number}/comments?${query}`,
      );
      const items = array(result.data).map((value) => {
        const row = object(value),
          id = integer(row.id);
        return parse(githubCommentSchema, {
          id,
          ...body(row.body),
          author: author(row.user),
          updatedAt: text(row.updated_at, 100),
          url: `${browserUrl(target)}/issues/${number}#issuecomment-${id}`,
        });
      });
      return pageResult(
        items,
        page,
        result.hasNext || items.length === GITHUB_CLIENT_LIMITS.pageSize,
        items.some((row) => row.bodyTruncated),
      );
    });
  }
  async listChecks(
    target: GitHubRepositoryTarget,
    headSha: string,
    options: { page?: number } = {},
  ): Promise<GithubPage<GithubCheck>> {
    const pinnedSha = requestSha(headSha),
      { page, query } = listQuery(options);
    return this.scoped(target, async () => {
      const result = await this.request(
        `${repositoryPath(target)}/commits/${pinnedSha}/check-runs?${query}&filter=latest`,
      );
      const data = object(result.data),
        totalCount = integer(data.total_count, true);
      const items = array(data.check_runs).map((value) => {
        const row = object(value),
          id = integer(row.id),
          returnedSha = sha(row.head_sha);
        if (returnedSha !== pinnedSha)
          throw new GitHubClientError('stale', 409, 'GitHub 检查结果对应另一提交，请重新读取 PR。');
        return parse(githubCheckSchema, {
          id,
          name: text(row.name, 300),
          status: text(row.status, 100),
          conclusion: nullableText(row.conclusion, 100),
          startedAt: nullableText(row.started_at, 100),
          completedAt: nullableText(row.completed_at, 100),
          url: `${browserUrl(target)}/runs/${id}`,
        });
      });
      return pageResult(
        items,
        page,
        result.hasNext || totalCount > page * GITHUB_CLIENT_LIMITS.pageSize,
      );
    });
  }
  async getCombinedStatus(
    target: GitHubRepositoryTarget,
    headSha: string,
    options: { page?: number } = {},
  ): Promise<GithubStatusesPage> {
    const pinnedSha = requestSha(headSha),
      { page, query } = listQuery(options);
    return this.scoped(target, async () => {
      const result = await this.request(
        `${repositoryPath(target)}/commits/${pinnedSha}/status?${query}`,
      );
      const data = object(result.data),
        totalCount = integer(data.total_count, true);
      if (
        sha(data.sha) !== pinnedSha ||
        integer(object(data.repository).id) !== target.repositoryId
      )
        throw new GitHubClientError('stale', 409, 'GitHub 状态对应另一仓库或提交，请重新读取 PR。');
      const items = array(data.statuses).map((value) => {
        const row = object(value);
        return {
          id: integer(row.id),
          context: text(row.context, 300),
          state: enumeration(row.state, ['error', 'failure', 'pending', 'success']),
          description: nullableText(row.description, 1000),
          updatedAt: text(row.updated_at, 100),
        };
      });
      return parse(githubStatusesPageSchema, {
        ...pageResult(
          items,
          page,
          result.hasNext || totalCount > page * GITHUB_CLIENT_LIMITS.pageSize,
        ),
        state: enumeration(data.state, ['failure', 'pending', 'success']),
        totalCount,
      });
    });
  }
}
