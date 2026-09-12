import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../protocol';
import {
  createGitHubClient,
  GitHubClientError,
  GITHUB_API_VERSION,
  GITHUB_CLIENT_LIMITS,
  type GitHubClientOptions,
  type GitHubClientErrorCode,
  type GitHubRepositoryTarget,
} from './github-client';
import {
  githubRepositoryRefSchema,
  githubNumberSchema,
  githubPageNumberSchema,
  githubCommentSchema,
  githubItemSummarySchema,
  githubPullSchema,
  type GithubPage,
  type GithubComment,
  type GithubPull,
} from '../github-protocol';
import { gitBranchSchema, gitOidSchema } from '../git-protocol';
import { projectFilePathSchema } from '../content-protocol';
import {
  githubPullFileSchema,
  githubReviewCommentSchema,
  githubWriteOutcomeSchema,
  type GithubPullFile,
  type GithubReviewComment,
  type GithubWriteOutcome,
} from '../github-write-protocol';

export const GITHUB_WRITE_CLIENT_LIMITS = {
  responseBytes: GITHUB_CLIENT_LIMITS.responseBytes,
  requestBytes: 64 * 1024,
  timeoutMs: 10_000,
  pageSize: 20,
  maxPage: 100,
} as const;
export type GitHubWriteClientOptions = GitHubClientOptions & {
  // Local durable-dispatch checkpoint. No callback or operation id is sent to GitHub.
  beforeDispatch?: () => void | Promise<void>;
  onResult?: (result: GithubWriteOutcome) => void | Promise<void>;
};
export class GitHubWriteClientError extends AppError {
  constructor(
    public code: GitHubClientErrorCode,
    status: number,
    message: string,
    rejected: boolean,
    public retryAfterSeconds?: number,
    public rateLimitResetAt?: number,
    public knownResult?: GithubWriteOutcome,
  ) {
    super(status, message, rejected);
  }
}
type Attempt = { dispatched: boolean; knownResult?: GithubWriteOutcome };
export type GitHubRecovery<T> = {
  value: T;
  authorId: number | null;
  marker?: string;
  // Hashes the complete raw body, including the operation marker, before display truncation.
  bodyVersion: string;
};
const requestBody = z
  .string()
  .max(12500)
  .refine((s) => !s.includes('\0'));
const commentBody = requestBody.refine((s) => s.trim().length > 0);
const branch = gitBranchSchema.refine(
  (s) =>
    !/[~^:?*\[\\]/.test(s) &&
    !s.startsWith('-') &&
    !s.startsWith('/') &&
    !s.endsWith('/') &&
    !s.endsWith('.') &&
    !s.includes('..') &&
    !s.includes('//') &&
    !s.includes('@{') &&
    s !== '@' &&
    !s.split('/').some((v) => v.startsWith('.') || v.endsWith('.lock')),
);
const title = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[^\r\n\u0000-\u001f\u007f]+$/);
const side = z.enum(['LEFT', 'RIGHT']);
const line = z.number().int().positive().max(10000000);
const reviewInput = z
  .object({
    body: commentBody,
    commitSha: gitOidSchema,
    path: projectFilePathSchema,
    side,
    line,
    startLine: line.optional(),
    startSide: side.optional(),
  })
  .strict()
  .refine((v) => (v.startLine === undefined) === (v.startSide === undefined));
const createInput = z
  .object({ headBranch: branch, baseBranch: branch, title, body: requestBody, draft: z.boolean() })
  .strict();
const updateInput = z
  .object({
    title: title.optional(),
    body: requestBody.optional(),
    state: z.enum(['open', 'closed']).optional(),
    baseBranch: branch.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined));
const mergeInput = z
  .object({
    headSha: gitOidSchema,
    method: z.enum(['merge', 'squash', 'rebase']),
    commitTitle: title.optional(),
    commitMessage: requestBody.optional(),
  })
  .strict();
export type GitHubReviewCommentInput = z.infer<typeof reviewInput>;
export type GitHubCreatePullInput = z.infer<typeof createInput>;
export type GitHubUpdatePullInput = z.infer<typeof updateInput>;
export type GitHubMergePullInput = z.infer<typeof mergeInput>;
type ResponseData = { data: unknown; hasNext: boolean };
const origin = 'https://api.github.com';
function fail(code: GitHubClientErrorCode, status: number, message: string) {
  return new GitHubWriteClientError(code, status, message, true);
}
function malformed() {
  return fail('invalid-response', 502, 'GitHub 返回的数据格式无效。');
}
function input<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw fail('invalid-request', 400, 'GitHub 操作参数无效。');
  return result.data;
}
function output<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw malformed();
  return result.data;
}
function repoPath(target: GitHubRepositoryTarget) {
  input(githubRepositoryRefSchema, {
    id: target.repositoryId,
    owner: target.owner,
    name: target.repo,
  });
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}
function repoUrl(target: GitHubRepositoryTarget) {
  repoPath(target);
  return `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}
function headerNumber(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  return value && /^\d{1,12}$/.test(value) ? Number(value) : undefined;
}
function version(value: unknown) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw malformed();
  return value as Record<string, unknown>;
}
function rawText(value: unknown, max = GITHUB_CLIENT_LIMITS.responseBytes) {
  return output(
    z
      .string()
      .max(max)
      .refine((s) => !s.includes('\0')),
    value,
  );
}
function truncate(value: string, max: number) {
  let end = Math.min(value.length, max);
  if (
    end < value.length &&
    /[\ud800-\udbff]/.test(value[end - 1]) &&
    /[\udc00-\udfff]/.test(value[end])
  )
    end--;
  return value.slice(0, end);
}
export function githubOperationBody(body: string, marker: string): string {
  input(z.string().regex(/^sha256:[a-f0-9]{64}$/), marker);
  return input(requestBody, body + `\n\n<!-- moor-operation:${marker} -->`);
}
function bodyData(row: Record<string, unknown>) {
  const raw = row.body === null ? '' : rawText(row.body);
  const match = /\n\n<!-- moor-operation:(sha256:[a-f0-9]{64}) -->$/.exec(raw);
  const display = match ? raw.slice(0, match.index) : raw;
  return {
    body: truncate(display, GITHUB_CLIENT_LIMITS.bodyCharacters),
    bodyTruncated: display.length > GITHUB_CLIENT_LIMITS.bodyCharacters,
    raw,
    marker: match?.[1],
    bodyVersion: 'sha256:' + createHash('sha256').update(raw).digest('hex'),
  };
}
function recovery<T>(row: Record<string, unknown>, value: T): GitHubRecovery<T> {
  const data = bodyData(row);
  return {
    value,
    authorId: row.user === null ? null : output(githubNumberSchema, object(row.user).id),
    ...(data.marker ? { marker: data.marker } : {}),
    bodyVersion: data.bodyVersion,
  };
}
function relationship(row: Record<string, unknown>, field: string, path: string) {
  // The URL is evidence only; never follow a response-provided URL.
  if (rawText(row[field], 1000).toLowerCase() !== `${origin}${path}`.toLowerCase())
    throw malformed();
}
function comment(
  row: Record<string, unknown>,
  target: GitHubRepositoryTarget,
  number: number,
): GithubComment {
  const data = bodyData(row),
    id = output(githubNumberSchema, row.id);
  return output(githubCommentSchema, {
    id,
    body: data.body,
    bodyTruncated: data.bodyTruncated,
    author: row.user === null ? '[deleted]' : rawText(object(row.user).login, 100),
    updatedAt: row.updated_at,
    url: `${repoUrl(target)}/issues/${number}#issuecomment-${id}`,
  });
}
function review(
  row: Record<string, unknown>,
  target: GitHubRepositoryTarget,
  number: number,
): GithubReviewComment {
  relationship(row, 'pull_request_url', `${repoPath(target)}/pulls/${number}`);
  const common = comment(row, target, number);
  const data = {
    ...common,
    url: `${repoUrl(target)}/pull/${number}#discussion_r${common.id}`,
    path: row.path,
    commitSha: row.commit_id,
    originalCommitSha: row.original_commit_id,
    side: row.side,
    line: row.line,
    originalLine: row.original_line,
    ...(row.start_line === undefined ? {} : { startLine: row.start_line }),
    ...(row.start_side === undefined ? {} : { startSide: row.start_side }),
    ...(row.in_reply_to_id === undefined ? {} : { replyTo: row.in_reply_to_id }),
  };
  return output(githubReviewCommentSchema, {
    ...data,
    version: version({ ...data, body: row.body, originalStartLine: row.original_start_line }),
  });
}
function pull(row: Record<string, unknown>, target: GitHubRepositoryTarget): GithubPull {
  const ref = (value: unknown) => {
    const r = object(value),
      repo = r.repo === null ? null : object(r.repo);
    return {
      branch: r.ref,
      sha: r.sha,
      repository: repo
        ? output(githubRepositoryRefSchema, {
            id: repo.id,
            owner: object(repo.owner).login,
            name: repo.name,
          })
        : null,
    };
  };
  const base = ref(row.base),
    head = ref(row.head);
  if (
    base.repository?.id !== target.repositoryId ||
    base.repository.owner.toLowerCase() !== target.owner.toLowerCase() ||
    base.repository.name.toLowerCase() !== target.repo.toLowerCase()
  )
    throw fail('stale', 409, 'GitHub PR 所属仓库已变化。');
  const number = output(githubNumberSchema, row.number),
    b = bodyData(row);
  const labels = output(
    z.array(z.union([z.string().max(100), z.object({ name: z.string().max(100) })])).max(50),
    row.labels,
  ).map((v) => (typeof v === 'string' ? v : v.name));
  const summary = output(githubItemSummarySchema, {
    id: row.id,
    number,
    kind: 'pull' as const,
    title: row.title,
    state: row.merged === true || typeof row.merged_at === 'string' ? 'merged' : row.state,
    author: row.user === null ? '[deleted]' : rawText(object(row.user).login, 100),
    updatedAt: row.updated_at,
    url: `${repoUrl(target)}/pull/${number}`,
    ...(row.draft === undefined ? {} : { draft: row.draft }),
  });
  const data = {
    ...summary,
    body: b.body,
    bodyTruncated: b.bodyTruncated,
    labels,
    head,
    base,
    mergeable: row.mergeable ?? null,
  };
  return output(githubPullSchema, { ...data, version: version({ ...data, body: row.body }) });
}
function pagination(options: { page?: number } = {}) {
  const parsed = input(z.object({ page: githubPageNumberSchema.optional() }).strict(), options),
    page = parsed.page ?? 1;
  return { page, query: `per_page=20&page=${page}` };
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > GITHUB_WRITE_CLIENT_LIMITS.pageSize)
    throw malformed();
  return value.map(object);
}
function pageResult<T>(items: T[], page: number, hasNext: boolean, partial = false): GithubPage<T> {
  return { items, page, hasNext, partial: partial || hasNext || page > 1 };
}

export function createGitHubWriteClient(options: GitHubWriteClientOptions) {
  return new GitHubWriteClient(options);
}
export class GitHubWriteClient {
  readonly #options: GitHubWriteClientOptions;
  readonly #reader: ReturnType<typeof createGitHubClient>;
  constructor(options: GitHubWriteClientOptions) {
    // The existing read client validates local credentials and keeps them non-enumerable.
    this.#reader = createGitHubClient(options);
    this.#options = { ...options };
  }
  private current() {
    if (this.#options.signal?.aborted) throw fail('cancelled', 409, 'GitHub 操作已取消。');
    try {
      this.#options.assertCurrent?.();
    } catch {
      throw fail('stale', 409, 'GitHub 授权或项目范围已变化。');
    }
  }
  private normalize(error: unknown, attempt?: Attempt): GitHubWriteClientError {
    if (error instanceof GitHubWriteClientError || error instanceof GitHubClientError)
      return new GitHubWriteClientError(
        error.code,
        error.status,
        error.message,
        !attempt?.dispatched,
        error.retryAfterSeconds,
        error.rateLimitResetAt,
        attempt?.knownResult ??
          (error instanceof GitHubWriteClientError ? error.knownResult : undefined),
      );
    return new GitHubWriteClientError(
      'unavailable',
      502,
      attempt?.dispatched
        ? 'GitHub 写入结果未知，请手动确认原操作，不能直接重发。'
        : 'GitHub 操作尚未发出，请重新读取后确认。',
      !attempt?.dispatched,
      undefined,
      undefined,
      attempt?.knownResult,
    );
  }
  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    body?: unknown,
    attempt?: Attempt,
  ): Promise<ResponseData> {
    const controller = new AbortController();
    let timedOut = false;
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        'abort',
        () =>
          reject(
            fail(
              timedOut ? 'timeout' : 'cancelled',
              timedOut ? 504 : 409,
              timedOut
                ? 'GitHub 操作超时，需确认原操作结果。'
                : 'GitHub 操作已取消，需确认原操作结果。',
            ),
          ),
        { once: true },
      ),
    );
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
    }, GITHUB_WRITE_CLIENT_LIMITS.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      stream: ReadableStream<Uint8Array> | null = null;
    try {
      this.current();
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      if (
        serialized !== undefined &&
        Buffer.byteLength(serialized) > GITHUB_WRITE_CLIENT_LIMITS.requestBytes
      )
        throw fail('too-large', 413, 'GitHub 操作内容超过大小限制。');
      const fetcher = this.#options.fetch ?? globalThis.fetch;
      const init: RequestInit = {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.#options.token}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': 'Moor',
          ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        ...(serialized === undefined ? {} : { body: serialized }),
      };
      if (method !== 'GET') {
        if (!attempt) throw fail('invalid-request', 400, 'GitHub 写入缺少本机操作边界。');
        await wait(Promise.resolve(this.#options.beforeDispatch?.()));
        this.current();
        if (controller.signal.aborted) throw fail('timeout', 504, 'GitHub 操作在发出前已超时。');
        // No await or mutable argument construction between this flag and the sole dispatch.
        attempt.dispatched = true;
      }
      const response = await wait(fetcher(`${origin}${path}`, init));
      stream = response.body;
      // Once a mutation has returned, first preserve its bounded, validated result. A
      // revoked lease still prevents every subsequent request and the final acceptance.
      if (!attempt?.dispatched) this.current();
      if (timedOut) throw fail('timeout', 504, 'GitHub 操作超时，需确认原操作结果。');
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw fail('redirect', 409, 'GitHub 资源地址已变化，请重新确认本机仓库登记。');
      if (response.url && response.url !== `${origin}${path}`) throw malformed();
      const expected = method === 'POST' ? 201 : 200;
      if (response.status !== expected) {
        const retry = headerNumber(response.headers, 'retry-after'),
          reset = headerNumber(response.headers, 'x-ratelimit-reset');
        if (
          response.status === 429 ||
          (response.status === 403 &&
            (retry !== undefined || response.headers.get('x-ratelimit-remaining') === '0'))
        )
          throw new GitHubWriteClientError(
            'rate-limit',
            429,
            '已达到 GitHub 请求限额，请手动确认原操作结果。',
            true,
            retry,
            reset,
          );
        if (response.status === 401) throw fail('credentials', 401, 'GitHub 令牌无效或已过期。');
        if (response.status === 403)
          throw fail('forbidden', 403, 'GitHub 拒绝访问，请检查权限和请求限额。');
        if (response.status === 404)
          throw fail('not-found', 404, 'GitHub 资源不可用，或当前令牌无权访问。');
        if (response.status === 409)
          throw fail('stale', 409, 'GitHub 远端状态发生冲突，请确认原操作结果。');
        throw fail('unavailable', 502, 'GitHub 未返回可确认的操作结果。');
      }
      const length = headerNumber(response.headers, 'content-length');
      if (length !== undefined && length > GITHUB_WRITE_CLIENT_LIMITS.responseBytes)
        throw fail('too-large', 502, 'GitHub 返回的数据超过读取大小限制。');
      if (!response.body) throw malformed();
      reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const result = await wait(reader.read());
        if (!attempt?.dispatched) this.current();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > GITHUB_WRITE_CLIENT_LIMITS.responseBytes)
          throw fail('too-large', 502, 'GitHub 返回的数据超过读取大小限制。');
        chunks.push(result.value);
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      } catch {
        throw malformed();
      }
      const link = response.headers.get('link') ?? '';
      if (link.length > 8192) throw malformed();
      if (!attempt?.dispatched) this.current();
      return { data, hasNext: /(?:^|[,;])\s*rel\s*=\s*"next"(?:\s*[,;]|\s*$)/i.test(link) };
    } catch (error) {
      throw this.normalize(error, attempt);
    } finally {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
      else if (stream) void stream.cancel().catch(() => {});
      cancelTimeout();
      this.#options.signal?.removeEventListener('abort', abort);
    }
  }
  private async readScoped<T>(target: GitHubRepositoryTarget, work: () => Promise<T>): Promise<T> {
    try {
      repoPath(target);
      this.current();
      await this.#reader.getRepository(target);
      const result = await work();
      await this.#reader.getRepository(target);
      this.current();
      return result;
    } catch (error) {
      throw this.normalize(error);
    }
  }
  private async writeScoped<T>(
    target: GitHubRepositoryTarget,
    work: (attempt: Attempt) => Promise<T>,
  ): Promise<T> {
    const attempt: Attempt = { dispatched: false };
    try {
      repoPath(target);
      this.current();
      await this.#reader.getRepository(target);
      const result = await work(attempt);
      await this.#reader.getRepository(target);
      this.current();
      return result;
    } catch (error) {
      throw this.normalize(error, attempt);
    }
  }
  private async known(attempt: Attempt, result: GithubWriteOutcome) {
    attempt.knownResult = output(githubWriteOutcomeSchema, result);
    await this.#options.onResult?.({ ...attempt.knownResult });
    this.current();
    return { ...attempt.knownResult };
  }
  async listPullFiles(
    target: GitHubRepositoryTarget,
    number: number,
    options: { page?: number } = {},
  ): Promise<GithubPage<GithubPullFile>> {
    input(githubNumberSchema, number);
    const { page, query } = pagination(options);
    return this.readScoped(target, async () => {
      const response = await this.request(
        `${repoPath(target)}/pulls/${number}/files?${query}`,
        'GET',
      );
      const items = rows(response.data).map((row) => {
        const patch = row.patch === undefined ? undefined : rawText(row.patch);
        const data = {
          path: row.filename,
          ...(row.previous_filename === undefined ? {} : { previousPath: row.previous_filename }),
          sha: row.sha,
          status: row.status,
          additions: row.additions,
          deletions: row.deletions,
          changes: row.changes,
          ...(patch === undefined ? {} : { patch: truncate(patch, 65536) }),
          patchTruncated: patch !== undefined && patch.length > 65536,
        };
        return output(githubPullFileSchema, { ...data, version: version({ ...data, patch }) });
      });
      return pageResult(
        items,
        page,
        response.hasNext || items.length === 20,
        items.some((v) => v.patch === undefined || v.patchTruncated),
      );
    });
  }
  async listRecoveryReviewComments(
    target: GitHubRepositoryTarget,
    number: number,
    options: { page?: number } = {},
  ): Promise<GithubPage<GitHubRecovery<GithubReviewComment>>> {
    input(githubNumberSchema, number);
    const { page, query } = pagination(options);
    return this.readScoped(target, async () => {
      const response = await this.request(
        `${repoPath(target)}/pulls/${number}/comments?${query}&sort=created&direction=asc`,
        'GET',
      );
      const items = rows(response.data).map((row) => recovery(row, review(row, target, number)));
      return pageResult(
        items,
        page,
        response.hasNext || items.length === 20,
        items.some((v) => v.value.bodyTruncated),
      );
    });
  }
  async listReviewComments(
    target: GitHubRepositoryTarget,
    number: number,
    options: { page?: number } = {},
  ): Promise<GithubPage<GithubReviewComment>> {
    const result = await this.listRecoveryReviewComments(target, number, options);
    return { ...result, items: result.items.map((v) => v.value) };
  }
  async listRecoveryIssueComments(
    target: GitHubRepositoryTarget,
    number: number,
    options: { page?: number } = {},
  ): Promise<GithubPage<GitHubRecovery<GithubComment>>> {
    input(githubNumberSchema, number);
    const { page, query } = pagination(options);
    return this.readScoped(target, async () => {
      const response = await this.request(
        `${repoPath(target)}/issues/${number}/comments?${query}`,
        'GET',
      );
      const items = rows(response.data).map((row) => {
        relationship(row, 'issue_url', `${repoPath(target)}/issues/${number}`);
        return recovery(row, comment(row, target, number));
      });
      return pageResult(
        items,
        page,
        response.hasNext || items.length === 20,
        items.some((v) => v.value.bodyTruncated),
      );
    });
  }
  async getIssueComment(
    target: GitHubRepositoryTarget,
    number: number,
    commentId: number,
  ): Promise<GitHubRecovery<GithubComment>> {
    input(githubNumberSchema, number);
    input(githubNumberSchema, commentId);
    return this.readScoped(target, async () => {
      const row = object(
        (await this.request(`${repoPath(target)}/issues/comments/${commentId}`, 'GET')).data,
      );
      relationship(row, 'issue_url', `${repoPath(target)}/issues/${number}`);
      const value = comment(row, target, number);
      if (value.id !== commentId) throw malformed();
      return recovery(row, value);
    });
  }
  async getReviewComment(
    target: GitHubRepositoryTarget,
    number: number,
    commentId: number,
  ): Promise<GitHubRecovery<GithubReviewComment>> {
    input(githubNumberSchema, number);
    input(githubNumberSchema, commentId);
    return this.readScoped(target, async () => {
      const row = object(
          (await this.request(`${repoPath(target)}/pulls/comments/${commentId}`, 'GET')).data,
        ),
        value = review(row, target, number);
      if (value.id !== commentId) throw malformed();
      return recovery(row, value);
    });
  }
  async getRecoveryPull(
    target: GitHubRepositoryTarget,
    number: number,
  ): Promise<GitHubRecovery<GithubPull>> {
    input(githubNumberSchema, number);
    return this.readScoped(target, async () => {
      const row = object((await this.request(`${repoPath(target)}/pulls/${number}`, 'GET')).data),
        value = pull(row, target);
      if (value.number !== number) throw malformed();
      return recovery(row, value);
    });
  }
  async getPull(target: GitHubRepositoryTarget, number: number): Promise<GithubPull> {
    return (await this.getRecoveryPull(target, number)).value;
  }
  async listRecoveryPulls(
    target: GitHubRepositoryTarget,
    options: { headBranch: string; baseBranch: string; page?: number },
  ): Promise<GithubPage<GitHubRecovery<GithubPull>>> {
    const args = input(
      z
        .object({ headBranch: branch, baseBranch: branch, page: githubPageNumberSchema.optional() })
        .strict(),
      options,
    );
    const { page, query } = pagination({ page: args.page });
    return this.readScoped(target, async () => {
      const params = new URLSearchParams({
        state: 'all',
        head: `${target.owner}:${args.headBranch}`,
        base: args.baseBranch,
        sort: 'created',
        direction: 'desc',
      });
      const response = await this.request(`${repoPath(target)}/pulls?${query}&${params}`, 'GET');
      const all = rows(response.data).map((row) => recovery(row, pull(row, target)));
      const items = all.filter(
        ({ value }) =>
          value.head.repository?.id === target.repositoryId &&
          value.head.repository.owner.toLowerCase() === target.owner.toLowerCase() &&
          value.head.repository.name.toLowerCase() === target.repo.toLowerCase() &&
          value.head.branch === args.headBranch &&
          value.base.branch === args.baseBranch,
      );
      return pageResult(
        items,
        page,
        response.hasNext || all.length === 20,
        items.length !== all.length || items.some((v) => v.value.bodyTruncated),
      );
    });
  }
  async createIssueComment(
    target: GitHubRepositoryTarget,
    number: number,
    options: { body: string },
  ): Promise<GithubWriteOutcome> {
    input(githubNumberSchema, number);
    const args = input(z.object({ body: commentBody }).strict(), options);
    return this.writeScoped(target, async (attempt) => {
      const row = object(
        (await this.request(`${repoPath(target)}/issues/${number}/comments`, 'POST', args, attempt))
          .data,
      );
      relationship(row, 'issue_url', `${repoPath(target)}/issues/${number}`);
      const value = comment(row, target, number);
      return this.known(attempt, { id: value.id, number });
    });
  }
  async createReviewComment(
    target: GitHubRepositoryTarget,
    number: number,
    options: GitHubReviewCommentInput,
  ): Promise<GithubWriteOutcome> {
    input(githubNumberSchema, number);
    const args = input(reviewInput, options);
    return this.writeScoped(target, async (attempt) => {
      const body = {
        body: args.body,
        commit_id: args.commitSha,
        path: args.path,
        side: args.side,
        line: args.line,
        ...(args.startLine === undefined
          ? {}
          : { start_line: args.startLine, start_side: args.startSide }),
      };
      const row = object(
          (
            await this.request(
              `${repoPath(target)}/pulls/${number}/comments`,
              'POST',
              body,
              attempt,
            )
          ).data,
        ),
        value = review(row, target, number);
      if (
        value.commitSha !== args.commitSha ||
        value.path !== args.path ||
        value.side !== args.side ||
        value.line !== args.line ||
        value.replyTo !== undefined ||
        (value.startLine ?? undefined) !== args.startLine ||
        (value.startSide ?? undefined) !== args.startSide
      )
        throw malformed();
      return this.known(attempt, { id: value.id, number });
    });
  }
  async replyReviewComment(
    target: GitHubRepositoryTarget,
    number: number,
    commentId: number,
    options: { body: string },
  ): Promise<GithubWriteOutcome> {
    input(githubNumberSchema, number);
    input(githubNumberSchema, commentId);
    const args = input(z.object({ body: commentBody }).strict(), options);
    return this.writeScoped(target, async (attempt) => {
      const parent = await this.getReviewComment(target, number, commentId);
      if (parent.value.replyTo !== undefined)
        throw fail('invalid-request', 409, 'GitHub 仅允许回复顶层审阅评论。');
      const row = object(
          (
            await this.request(
              `${repoPath(target)}/pulls/${number}/comments/${commentId}/replies`,
              'POST',
              args,
              attempt,
            )
          ).data,
        ),
        value = review(row, target, number);
      if (
        value.replyTo !== commentId ||
        value.path !== parent.value.path ||
        value.commitSha !== parent.value.commitSha
      )
        throw malformed();
      return this.known(attempt, { id: value.id, number });
    });
  }
  async createPull(
    target: GitHubRepositoryTarget,
    options: GitHubCreatePullInput,
  ): Promise<GithubWriteOutcome> {
    const args = input(createInput, options);
    return this.writeScoped(target, async (attempt) => {
      const row = object(
          (
            await this.request(
              `${repoPath(target)}/pulls`,
              'POST',
              {
                head: args.headBranch,
                base: args.baseBranch,
                title: args.title,
                body: args.body,
                draft: args.draft,
              },
              attempt,
            )
          ).data,
        ),
        value = pull(row, target);
      if (
        value.head.repository?.id !== target.repositoryId ||
        value.head.repository.owner.toLowerCase() !== target.owner.toLowerCase() ||
        value.head.repository.name.toLowerCase() !== target.repo.toLowerCase() ||
        value.head.branch !== args.headBranch ||
        value.base.branch !== args.baseBranch
      )
        throw malformed();
      return this.known(attempt, { id: value.id, number: value.number, sha: value.head.sha });
    });
  }
  async updatePull(
    target: GitHubRepositoryTarget,
    number: number,
    options: GitHubUpdatePullInput,
  ): Promise<GithubWriteOutcome> {
    input(githubNumberSchema, number);
    const args = input(updateInput, options);
    return this.writeScoped(target, async (attempt) => {
      const body = {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.state === undefined ? {} : { state: args.state }),
        ...(args.baseBranch === undefined ? {} : { base: args.baseBranch }),
      };
      const value = pull(
        object(
          (await this.request(`${repoPath(target)}/pulls/${number}`, 'PATCH', body, attempt)).data,
        ),
        target,
      );
      if (value.number !== number) throw malformed();
      return this.known(attempt, { id: value.id, number, sha: value.head.sha });
    });
  }
  async mergePull(
    target: GitHubRepositoryTarget,
    number: number,
    options: GitHubMergePullInput,
  ): Promise<GithubWriteOutcome> {
    input(githubNumberSchema, number);
    const args = input(mergeInput, options);
    return this.writeScoped(target, async (attempt) => {
      const body = {
        sha: args.headSha,
        merge_method: args.method,
        ...(args.commitTitle === undefined ? {} : { commit_title: args.commitTitle }),
        ...(args.commitMessage === undefined ? {} : { commit_message: args.commitMessage }),
      };
      const result = output(
        z.object({ sha: gitOidSchema, merged: z.literal(true) }),
        (await this.request(`${repoPath(target)}/pulls/${number}/merge`, 'PUT', body, attempt))
          .data,
      );
      return this.known(attempt, { number, sha: result.sha });
    });
  }
}
