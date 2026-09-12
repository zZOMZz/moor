import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHubClient,
  GitHubClientError,
  GITHUB_API_VERSION,
  GITHUB_CLIENT_LIMITS,
  type GitHubClientOptions,
} from '../src/runtime/github-client';
import {
  githubIssueSchema,
  githubPullSchema,
  githubStatusesPageSchema,
} from '../src/github-protocol';

const target = { owner: 'synthetic', repo: 'moor-test', repositoryId: 42 };
const headSha = 'a'.repeat(40),
  baseSha = 'b'.repeat(40);
const date = '2026-09-12T00:00:00Z';
const metadata = {
  id: 42,
  owner: { login: target.owner },
  name: target.repo,
  full_name: `${target.owner}/${target.repo}`,
  default_branch: 'main',
  private: true,
  archived: false,
  clone_url: 'https://secret.invalid/private',
  permissions: { admin: true },
};
const issue = {
  id: 100,
  number: 1,
  title: 'Synthetic issue',
  body: 'Synthetic context',
  state: 'open',
  user: { login: 'example' },
  updated_at: date,
  labels: [{ name: 'test' }],
  comments: 0,
  html_url: 'https://untrusted.invalid/ignore',
  private_metadata: 'not projected',
};
const pull = {
  ...issue,
  id: 200,
  number: 2,
  title: 'Synthetic pull',
  draft: false,
  merged: false,
  mergeable: null,
  head: {
    ref: 'feature/中文',
    sha: headSha,
    repo: {
      id: 84,
      name: 'fork',
      owner: { login: 'contributor' },
      url: 'http://localhost/private',
    },
  },
  base: { ref: 'main', sha: baseSha, repo: metadata },
};
function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}
function fixture(
  reply: (url: URL, count: number) => Response | Promise<Response>,
  options: Partial<GitHubClientOptions> = {},
) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init: init! });
    return reply(url, requests.length);
  };
  const client = createGitHubClient({ token: 'synthetic-token', fetch, ...options });
  return { client, requests };
}
function repositoryReply(url: URL, value: unknown): Response {
  return json(url.pathname === '/repos/synthetic/moor-test' ? metadata : value);
}
const code = (expected: string) => (error: unknown) =>
  error instanceof GitHubClientError && error.code === expected;

test('GitHub user and repository reads pin API version and project only safe identity metadata', async () => {
  const f = fixture((url) =>
    json(
      url.pathname === '/user'
        ? { id: 7, login: 'synthetic', token: 'hidden', email: 'hidden' }
        : metadata,
    ),
  );
  assert.deepEqual(await f.client.getUser(), { id: 7, login: 'synthetic' });
  assert.deepEqual(await f.client.getRepository(target), {
    id: 42,
    owner: 'synthetic',
    name: 'moor-test',
    defaultBranch: 'main',
    private: true,
    url: 'https://github.com/synthetic/moor-test',
  });
  assert.equal(JSON.stringify(f.client).includes('synthetic-token'), false);
  for (const { url, init } of f.requests) {
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.body, undefined);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), 'Bearer synthetic-token');
    assert.equal(headers.get('x-github-api-version'), GITHUB_API_VERSION);
  }
});

test('GitHub rejects arbitrary URLs, unsafe coordinates, non-SHA references and out-of-budget pages before HTTP', async () => {
  const f = fixture(() => {
    throw new Error('must not fetch');
  });
  for (const repo of ['../other', '%2e%2e', '.', '..', 'a?x', 'http://localhost'])
    await assert.rejects(f.client.getRepository({ ...target, repo }), code('invalid-request'));
  await assert.rejects(
    f.client.getRepository({ ...target, owner: 'x/y' }),
    code('invalid-request'),
  );
  await assert.rejects(f.client.listBranches(target, { page: 101 }), code('invalid-request'));
  await assert.rejects(f.client.listComments(target, 0), code('invalid-request'));
  await assert.rejects(f.client.listChecks(target, 'main'), code('invalid-request'));
  await assert.rejects(f.client.getBranch(target, '../../escape'), code('invalid-request'));
  assert.equal(f.requests.length, 0);
  assert.throws(() => createGitHubClient({ token: 'a\r\nInjected: token' }), code('credentials'));
});

test('GitHub branch selection encodes a single Unicode branch segment and never fetches commit URLs', async () => {
  const value = {
    name: 'feature/中文',
    commit: { sha: headSha, url: 'http://127.0.0.1/private' },
    protected: false,
  };
  const f = fixture((url) => repositoryReply(url, value));
  assert.deepEqual(await f.client.getBranch(target, value.name), {
    name: value.name,
    sha: headSha,
    protected: false,
  });
  assert.equal(f.requests.length, 3);
  assert.equal(
    f.requests[1].url.pathname,
    '/repos/synthetic/moor-test/branches/feature%2F%E4%B8%AD%E6%96%87',
  );
});

test('GitHub Issues filter PRs without hiding incomplete upstream pagination or following Link destinations', async () => {
  const f = fixture((url) =>
    url.pathname === '/repos/synthetic/moor-test'
      ? json(metadata)
      : json([issue, { ...pull, pull_request: { url: 'http://localhost/private' } }], {
          headers: { link: '<http://127.0.0.1/private>; rel="next"' },
        }),
  );
  const result = await f.client.listIssues(target);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, 'issue');
  assert.equal(result.hasNext, true);
  assert.equal(result.partial, true);
  assert.equal(result.page, 1);
  assert.equal('body' in result.items[0], false);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[1].url.searchParams.get('per_page'), '20');
  assert.equal(f.requests[1].url.searchParams.get('sort'), 'updated');
  const allPr = fixture((url) => repositoryReply(url, [{ ...pull, pull_request: {} }]));
  assert.deepEqual(await allPr.client.listIssues(target), {
    items: [],
    page: 1,
    hasNext: false,
    partial: true,
  });
});

test('GitHub bounds explicit pagination and marks full or later pages as incomplete', async () => {
  const branches = Array.from({ length: 20 }, (_, i) => ({
    name: `branch-${i}`,
    commit: { sha: headSha },
    protected: false,
  }));
  const f = fixture((url) => repositoryReply(url, branches));
  const result = await f.client.listBranches(target, { page: 100 });
  assert.equal(result.items.length, 20);
  assert.equal(result.hasNext, true);
  assert.equal(result.partial, true);
  assert.equal(f.requests.length, 3);
  const excessive = fixture((url) => repositoryReply(url, [...branches, branches[0]]));
  await assert.rejects(excessive.client.listBranches(target), code('invalid-response'));
});

test('GitHub detail versions include untruncated body while published details match the shared schema', async () => {
  let suffix = 'first';
  const f = fixture((url) => repositoryReply(url, { ...issue, body: 'x'.repeat(16000) + suffix }));
  const first = await f.client.getIssue(target, 1);
  suffix = 'second';
  const second = await f.client.getIssue(target, 1);
  assert.equal(first.body.length, 16000);
  assert.equal(first.bodyTruncated, true);
  assert.equal(first.body, second.body);
  assert.notEqual(first.version, second.version);
  assert.equal(githubIssueSchema.safeParse(first).success, true);
  assert.equal(JSON.stringify(first).includes('not projected'), false);
  const unicode = fixture((url) =>
    repositoryReply(url, { ...issue, body: 'x'.repeat(15999) + '😀' }),
  );
  const shortened = await unicode.client.getIssue(target, 1);
  assert.equal(shortened.body.length, 15999);
  assert.equal(shortened.bodyTruncated, true);
  const wrongKind = fixture((url) => repositoryReply(url, { ...issue, pull_request: {} }));
  await assert.rejects(wrongKind.client.getIssue(target, 1), code('invalid-request'));
});

test('GitHub fork PR keeps distinct head/base repository identity and generates safe links', async () => {
  const f = fixture((url) => repositoryReply(url, url.pathname.endsWith('/pulls') ? [pull] : pull));
  const result = await f.client.getPull(target, 2);
  assert.equal(githubPullSchema.safeParse(result).success, true);
  assert.deepEqual(result.head.repository, { id: 84, owner: 'contributor', name: 'fork' });
  assert.equal(result.head.branch, 'feature/中文');
  assert.equal(result.base.repository.id, 42);
  assert.equal(result.base.branch, 'main');
  assert.equal(result.head.sha, headSha);
  assert.equal(result.url, 'https://github.com/synthetic/moor-test/pull/2');
  assert.equal(JSON.stringify(result).includes('localhost'), false);
  const list = await f.client.listPulls(target);
  assert.equal(list.items[0].kind, 'pull');
  assert.equal('head' in list.items[0], false);
  assert.equal(
    f.requests.every((r) => r.url.pathname.startsWith('/repos/synthetic/moor-test')),
    true,
  );
  const deleted = fixture((url) =>
    repositoryReply(url, { ...pull, head: { ...pull.head, repo: null } }),
  );
  assert.equal((await deleted.client.getPull(target, 2)).head.repository, null);
});

test('GitHub rejects a different repository ID before reading or after namespace replacement', async () => {
  const wrong = fixture(() => json({ ...metadata, id: 43 }));
  await assert.rejects(wrong.client.getIssue(target, 1), code('stale'));
  assert.equal(wrong.requests.length, 1);
  const replaced = fixture((url, count) =>
    url.pathname === '/repos/synthetic/moor-test'
      ? json({ ...metadata, id: count === 1 ? 42 : 43 })
      : json(issue),
  );
  await assert.rejects(replaced.client.getIssue(target, 1), code('stale'));
  assert.equal(replaced.requests.length, 3);
  const foreignBase = fixture((url) =>
    repositoryReply(url, { ...pull, base: { ...pull.base, repo: { ...metadata, id: 43 } } }),
  );
  await assert.rejects(foreignBase.client.getPull(target, 2), code('stale'));
});

test('GitHub issue and PR discussion comments are bounded, omit upstream links and support deleted authors', async () => {
  const f = fixture((url) =>
    repositoryReply(url, [
      {
        id: 9,
        body: 'a'.repeat(16001),
        user: null,
        updated_at: date,
        html_url: 'javascript:alert(1)',
      },
    ]),
  );
  const result = await f.client.listComments(target, 2, { page: 2 });
  assert.equal(result.partial, true);
  assert.equal(result.items[0].bodyTruncated, true);
  assert.equal(result.items[0].author, '[deleted]');
  assert.equal(
    result.items[0].url,
    'https://github.com/synthetic/moor-test/issues/2#issuecomment-9',
  );
  assert.equal(f.requests[1].url.pathname, '/repos/synthetic/moor-test/issues/2/comments');
});

test('GitHub checks and combined statuses read the exact SHA and never fetch provider links', async () => {
  const check = {
    id: 7,
    head_sha: headSha,
    name: 'test',
    status: 'completed',
    conclusion: 'success',
    started_at: date,
    completed_at: date,
    details_url: 'http://localhost/private',
  };
  const status = {
    id: 8,
    context: 'test',
    state: 'success',
    description: null,
    updated_at: date,
    target_url: 'http://localhost/private',
  };
  const f = fixture((url) =>
    repositoryReply(
      url,
      url.pathname.endsWith('check-runs')
        ? { total_count: 21, check_runs: [check] }
        : {
            repository: metadata,
            sha: headSha,
            total_count: 1,
            state: 'success',
            statuses: [status],
          },
    ),
  );
  const checks = await f.client.listChecks(target, headSha);
  const statuses = await f.client.getCombinedStatus(target, headSha);
  assert.equal(checks.hasNext, true);
  assert.equal(checks.partial, true);
  assert.equal(statuses.state, 'success');
  assert.equal(statuses.partial, false);
  assert.equal(githubStatusesPageSchema.safeParse(statuses).success, true);
  assert.equal(JSON.stringify([checks, statuses]).includes('localhost'), false);
  assert.equal(
    f.requests[1].url.pathname,
    `/repos/synthetic/moor-test/commits/${headSha}/check-runs`,
  );
  assert.equal(f.requests[1].url.searchParams.get('filter'), 'latest');
  assert.equal(f.requests[4].url.pathname, `/repos/synthetic/moor-test/commits/${headSha}/status`);
  const wrong = fixture((url) =>
    repositoryReply(url, { total_count: 1, check_runs: [{ ...check, head_sha: baseSha }] }),
  );
  await assert.rejects(wrong.client.listChecks(target, headSha), code('stale'));
  const wrongStatus = fixture((url) =>
    repositoryReply(url, {
      repository: metadata,
      sha: baseSha,
      total_count: 0,
      state: 'pending',
      statuses: [],
    }),
  );
  await assert.rejects(wrongStatus.client.getCombinedStatus(target, headSha), code('stale'));
});

test('GitHub revocation before dispatch or during a response discards results with sanitized errors', async () => {
  let current = true;
  let release!: (response: Response) => void;
  const f = fixture(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    {
      assertCurrent: () => {
        if (!current) throw new Error('private token and path');
      },
    },
  );
  const pending = f.client.getUser();
  current = false;
  release(json({ id: 1, login: 'synthetic' }));
  await assert.rejects(
    pending,
    (error) => code('stale')(error) && !(error as Error).message.includes('private'),
  );
  await assert.rejects(f.client.getUser(), code('stale'));
  assert.equal(f.requests.length, 1);
});

test('GitHub streaming revocation drops partial bodies before any further scoped request', async () => {
  let current = true;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      current = false;
      controller.enqueue(new TextEncoder().encode('{"id":1'));
      controller.close();
    },
  });
  const f = fixture(() => new Response(stream), {
    assertCurrent: () => {
      if (!current) throw new Error('revoked');
    },
  });
  await assert.rejects(f.client.getUser(), code('stale'));
  assert.equal(f.requests.length, 1);
});

test('GitHub timeout and cancellation stop noncooperating injected fetches without sleeps or retries', async () => {
  let expire!: () => void,
    cancelled = false;
  const f = fixture(() => new Promise<Response>(() => {}), {
    scheduleTimeout: (callback) => {
      expire = callback;
      return () => {
        cancelled = true;
      };
    },
  });
  const pending = f.client.getUser();
  expire();
  await assert.rejects(pending, code('timeout'));
  assert.equal(cancelled, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].init.signal?.aborted, true);
  const controller = new AbortController();
  const aborted = fixture(() => new Promise<Response>(() => {}), { signal: controller.signal });
  const request = aborted.client.getUser();
  controller.abort();
  await assert.rejects(request, code('cancelled'));
});

test('GitHub rejects redirects and exposes only safe HTTP errors and bounded rate-limit headers', async () => {
  for (const [status, expected] of [
    [301, 'redirect'],
    [401, 'credentials'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [500, 'unavailable'],
  ] as const) {
    const f = fixture(
      () =>
        new Response('synthetic-token upstream private body', {
          status,
          headers: { location: 'http://localhost/private' },
        }),
    );
    await assert.rejects(
      f.client.getUser(),
      (error) =>
        code(expected)(error) &&
        !JSON.stringify(error).includes('synthetic-token') &&
        !(error as Error).message.includes('upstream'),
    );
    assert.equal(f.requests.length, 1);
  }
  const limited = fixture(
    () =>
      new Response('private', {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1800000000',
          'retry-after': '60',
        },
      }),
  );
  await assert.rejects(
    limited.client.getUser(),
    (error) =>
      error instanceof GitHubClientError &&
      error.code === 'rate-limit' &&
      error.retryAfterSeconds === 60 &&
      error.rateLimitResetAt === 1800000000,
  );
  const network = fixture(() => {
    throw new Error('synthetic-token in native fetch error');
  });
  await assert.rejects(
    network.client.getUser(),
    (error) => code('network')(error) && !(error as Error).message.includes('synthetic-token'),
  );
});

test('GitHub response budgets cover declared and streamed bytes and reject malformed projections', async () => {
  const declared = fixture(
    () =>
      new Response('{}', {
        headers: { 'content-length': String(GITHUB_CLIENT_LIMITS.responseBytes + 1) },
      }),
  );
  await assert.rejects(declared.client.getUser(), code('too-large'));
  let cancelled = false;
  const streamed = fixture(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array(GITHUB_CLIENT_LIMITS.responseBytes + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await assert.rejects(streamed.client.getUser(), code('too-large'));
  assert.equal(cancelled, true);
  const malformed = fixture(() => new Response('not JSON private body'));
  await assert.rejects(malformed.client.getUser(), code('invalid-response'));
  const unsafeId = fixture(() => json({ id: Number.MAX_SAFE_INTEGER + 1, login: 'user' }));
  await assert.rejects(unsafeId.client.getUser(), code('invalid-response'));
});
