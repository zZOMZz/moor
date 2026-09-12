import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGitHubClient, GITHUB_API_VERSION } from '../src/runtime/github-client';
import {
  createGitHubWriteClient,
  GitHubWriteClientError,
  githubOperationBody,
  GITHUB_WRITE_CLIENT_LIMITS,
  type GitHubWriteClientOptions,
} from '../src/runtime/github-write-client';

const target = { owner: 'synthetic', repo: 'moor-test', repositoryId: 42 };
const path = '/repos/synthetic/moor-test';
const headSha = 'a'.repeat(40),
  baseSha = 'b'.repeat(40),
  mergeSha = 'c'.repeat(40);
const marker = 'sha256:' + 'd'.repeat(64);
const date = '2026-09-12T00:00:00Z';
const metadata = {
  id: 42,
  owner: { login: target.owner },
  name: target.repo,
  full_name: `${target.owner}/${target.repo}`,
  default_branch: 'main',
  private: true,
};
const issueComment = {
  id: 300,
  body: githubOperationBody('Synthetic comment', marker),
  user: { id: 7, login: 'synthetic' },
  updated_at: date,
  issue_url: `https://api.github.com${path}/issues/2`,
  html_url: 'https://evil.invalid/private',
};
const reviewComment = {
  ...issueComment,
  path: 'src/中文.ts',
  commit_id: headSha,
  original_commit_id: baseSha,
  side: 'RIGHT',
  line: 4,
  original_line: 3,
  start_line: null,
  start_side: null,
  original_start_line: null,
  pull_request_url: `https://api.github.com${path}/pulls/2`,
};
const pull = {
  id: 200,
  number: 2,
  title: 'Synthetic pull',
  body: githubOperationBody('PR body', marker),
  state: 'open',
  user: { id: 7, login: 'synthetic' },
  updated_at: date,
  draft: false,
  merged: false,
  mergeable: null,
  labels: [],
  head: { sha: headSha, ref: 'feature/中文', repo: metadata },
  base: { sha: baseSha, ref: 'main', repo: metadata },
};
const file = {
  filename: 'src/中文.ts',
  sha: headSha,
  status: 'modified',
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: '@@ -3 +4 @@\n-old\n+new',
  raw_url: 'http://localhost/secret',
};
function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers });
}
function fixture(
  reply: (url: URL, init: RequestInit) => Response | Promise<Response>,
  options: Partial<GitHubWriteClientOptions> = {},
) {
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (value, init) => {
    const url = new URL(String(value));
    requests.push({ url, init: init! });
    return reply(url, init!);
  };
  const client = createGitHubWriteClient({ token: 'synthetic-token', fetch, ...options });
  return { client, requests, fetch, writes: () => requests.filter((r) => r.init.method !== 'GET') };
}
function ordinary(value: unknown, status = 200) {
  return (url: URL) =>
    json(url.pathname === path ? metadata : value, url.pathname === path ? 200 : status);
}
function error(expected: string, rejected: boolean) {
  return (e: unknown) =>
    e instanceof GitHubWriteClientError && e.code === expected && e.rejected === rejected;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('PR files project relative paths and frozen raw patch versions with conservative coverage', async () => {
  const f = fixture(
    ordinary([
      file,
      { ...file, filename: 'image.png', patch: undefined },
      { ...file, filename: 'renamed.ts', previous_filename: 'old.ts', status: 'renamed' },
    ]),
  );
  const result = await f.client.listPullFiles(target, 2);
  assert.equal(result.partial, true);
  assert.equal(result.items[1].patch, undefined);
  assert.equal(result.items[1].patchTruncated, false);
  assert.equal(result.items[2].previousPath, 'old.ts');
  assert.equal(result.items[0].path, 'src/中文.ts');
  assert.equal(JSON.stringify(result).includes('localhost'), false);
  assert.equal(f.requests.length, 3);
  for (const r of f.requests) {
    assert.equal(r.url.origin, 'https://api.github.com');
    assert.equal(r.init.redirect, 'manual');
    assert.equal(new Headers(r.init.headers).get('x-github-api-version'), GITHUB_API_VERSION);
  }
  const long = 'a'.repeat(65536);
  const a = await fixture(ordinary([{ ...file, patch: long + 'x' }])).client.listPullFiles(
    target,
    2,
  );
  const b = await fixture(ordinary([{ ...file, patch: long + 'y' }])).client.listPullFiles(
    target,
    2,
  );
  assert.equal(a.items[0].patch, b.items[0].patch);
  assert.equal(a.items[0].patchTruncated, true);
  assert.notEqual(a.items[0].version, b.items[0].version);
  await assert.rejects(
    fixture(ordinary([{ ...file, filename: '../escape' }])).client.listPullFiles(target, 2),
    error('invalid-response', true),
  );
});

test('review read carries exact anchors and private recovery metadata while display strips marker', async () => {
  const f = fixture(ordinary([reviewComment]));
  const publicPage = await f.client.listReviewComments(target, 2);
  const privatePage = await f.client.listRecoveryReviewComments(target, 2);
  assert.equal(publicPage.items[0].body, 'Synthetic comment');
  assert.equal(publicPage.items[0].commitSha, headSha);
  assert.equal(publicPage.items[0].originalCommitSha, baseSha);
  assert.equal(publicPage.items[0].originalLine, 3);
  assert.equal(privatePage.items[0].marker, marker);
  assert.equal(privatePage.items[0].authorId, 7);
  assert.equal(
    privatePage.items[0].bodyVersion,
    'sha256:' + createHash('sha256').update(issueComment.body).digest('hex'),
  );
  assert.equal(JSON.stringify(publicPage).includes('moor-operation'), false);
  assert.equal(JSON.stringify(publicPage).includes('authorId'), false);
  const updated = fixture(
    ordinary([{ ...reviewComment, body: 'a'.repeat(16000) + 'x', line: null }]),
  );
  const other = fixture(
    ordinary([{ ...reviewComment, body: 'a'.repeat(16000) + 'y', line: null }]),
  );
  const a = (await updated.client.listReviewComments(target, 2)).items[0];
  const b = (await other.client.listReviewComments(target, 2)).items[0];
  assert.equal(a.body, b.body);
  assert.notEqual(a.version, b.version);
  assert.equal(a.line, null);
});

test('recovery exact comment ID checks original issue/PR relationship without following response URLs', async () => {
  const f = fixture((url) =>
    json(
      url.pathname === path
        ? metadata
        : url.pathname.includes('/issues/')
          ? issueComment
          : reviewComment,
    ),
  );
  assert.equal((await f.client.getIssueComment(target, 2, 300)).value.id, 300);
  assert.equal((await f.client.getReviewComment(target, 2, 300)).value.id, 300);
  await assert.rejects(f.client.getIssueComment(target, 3, 300), error('invalid-response', true));
  await assert.rejects(f.client.getReviewComment(target, 3, 300), error('invalid-response', true));
  await assert.rejects(f.client.getReviewComment(target, 2, 301), error('invalid-response', true));
  assert.ok(f.requests.every((r) => r.url.origin === 'https://api.github.com'));
});

test('recovery PR lists require exact same-repository head/base and never auto paginate', async () => {
  const f = fixture((url) =>
    json(
      url.pathname === path
        ? metadata
        : [
            pull,
            { ...pull, id: 201, head: { ...pull.head, repo: { ...metadata, id: 84 } } },
            { ...pull, id: 202, base: { ...pull.base, ref: 'else' } },
          ],
      200,
      { link: '<http://localhost/private>; rel="next"' },
    ),
  );
  const result = await f.client.listRecoveryPulls(target, {
    headBranch: 'feature/中文',
    baseBranch: 'main',
    page: 2,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.hasNext, true);
  assert.equal(result.partial, true);
  assert.equal(result.items[0].marker, marker);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[1].url.searchParams.get('head'), 'synthetic:feature/中文');
  assert.equal(f.requests[1].url.searchParams.get('base'), 'main');
  const noRequests = fixture(ordinary([]));
  await assert.rejects(
    noRequests.client.listRecoveryPulls(target, { headBranch: '--evil', baseBranch: 'main' }),
    error('invalid-request', true),
  );
  await assert.rejects(
    noRequests.client.listPullFiles(target, 2, { page: 101 }),
    error('invalid-request', true),
  );
  assert.equal(noRequests.requests.length, 0);
});

test('read client and recovery PR projections preserve same raw version without exposing markers', async () => {
  const f = fixture(ordinary(pull));
  const recovery = await f.client.getRecoveryPull(target, 2);
  const reader = createGitHubClient({ token: 'synthetic-token', fetch: f.fetch });
  const normal = await reader.getPull(target, 2);
  assert.deepEqual(normal, recovery.value);
  assert.equal(normal.body, 'PR body');
  assert.equal(recovery.marker, marker);
  const comments = fixture(ordinary([issueComment]));
  const publicComments = await createGitHubClient({
    token: 'synthetic-token',
    fetch: comments.fetch,
  }).listComments(target, 2);
  assert.equal(publicComments.items[0].body, 'Synthetic comment');
  assert.equal(
    (await comments.client.listRecoveryIssueComments(target, 2)).items[0].marker,
    marker,
  );
});

test('Issue comment dispatch uses fixed POST and checkpoints minimal known result before postflight', async () => {
  const events: string[] = [];
  const f = fixture(
    (url, init) => {
      events.push(init.method === 'GET' ? 'pin' : 'post');
      return json(
        url.pathname === path ? metadata : issueComment,
        url.pathname === path ? 200 : 201,
      );
    },
    {
      beforeDispatch: () => {
        events.push('stage');
      },
      onResult: (value) => {
        events.push('result');
        assert.deepEqual(value, { id: 300, number: 2 });
      },
    },
  );
  assert.deepEqual(await f.client.createIssueComment(target, 2, { body: issueComment.body }), {
    id: 300,
    number: 2,
  });
  assert.deepEqual(events, ['pin', 'stage', 'post', 'result', 'pin']);
  assert.equal(f.writes().length, 1);
  assert.deepEqual(JSON.parse(String(f.writes()[0].init.body)), { body: issueComment.body });
  assert.equal(f.writes()[0].url.pathname, `${path}/issues/2/comments`);
});

test('review create uses line+side+commit SHA and validates returned anchor', async () => {
  const args = {
    body: issueComment.body,
    commitSha: headSha,
    path: reviewComment.path,
    side: 'RIGHT' as const,
    line: 4,
  };
  const f = fixture(ordinary(reviewComment, 201));
  await f.client.createReviewComment(target, 2, args);
  const body = JSON.parse(String(f.writes()[0].init.body));
  assert.deepEqual(body, {
    body: issueComment.body,
    commit_id: headSha,
    path: reviewComment.path,
    side: 'RIGHT',
    line: 4,
  });
  assert.equal('position' in body, false);
  const bad = fixture(ordinary({ ...reviewComment, commit_id: baseSha }, 201));
  await assert.rejects(
    bad.client.createReviewComment(target, 2, args),
    error('invalid-response', false),
  );
  assert.equal(bad.writes().length, 1);
});

test('review replies check top-level parent and send only body to dedicated reply route', async () => {
  const f = fixture((url, init) =>
    json(
      url.pathname === path
        ? metadata
        : init.method === 'GET'
          ? reviewComment
          : { ...reviewComment, id: 301, in_reply_to_id: 300 },
      init.method === 'POST' ? 201 : 200,
    ),
  );
  await f.client.replyReviewComment(target, 2, 300, { body: 'reply' });
  assert.equal(f.writes()[0].url.pathname, `${path}/pulls/2/comments/300/replies`);
  assert.deepEqual(JSON.parse(String(f.writes()[0].init.body)), { body: 'reply' });
  const child = fixture(ordinary({ ...reviewComment, in_reply_to_id: 299 }));
  await assert.rejects(
    child.client.replyReviewComment(target, 2, 300, { body: 'reply' }),
    error('invalid-request', true),
  );
  assert.equal(child.writes().length, 0);
});

test('PR create/update/merge have bounded typed bodies and merge requires exact head SHA', async () => {
  const f = fixture((url, init) =>
    json(
      url.pathname === path
        ? metadata
        : url.pathname.endsWith('/merge')
          ? { sha: mergeSha, merged: true, message: 'ignored' }
          : pull,
      init.method === 'POST' ? 201 : 200,
    ),
  );
  await f.client.createPull(target, {
    headBranch: 'feature/中文',
    baseBranch: 'main',
    title: pull.title,
    body: pull.body,
    draft: false,
  });
  await f.client.updatePull(target, 2, { title: 'Updated', body: '', state: 'closed' });
  assert.deepEqual(await f.client.mergePull(target, 2, { headSha, method: 'squash' }), {
    number: 2,
    sha: mergeSha,
  });
  assert.deepEqual(
    f.writes().map((r) => r.init.method),
    ['POST', 'PATCH', 'PUT'],
  );
  assert.deepEqual(JSON.parse(String(f.writes()[2].init.body)), {
    sha: headSha,
    merge_method: 'squash',
  });
  assert.equal(new Headers(f.writes()[1].init.headers).has('if-match'), false);
  await assert.rejects(f.client.updatePull(target, 2, {}), error('invalid-request', true));
  await assert.rejects(
    f.client.mergePull(target, 2, { headSha: 'main', method: 'merge' }),
    error('invalid-request', true),
  );
  assert.equal(f.writes().length, 3);
});

test('all transport failures after dispatch are unknown and never retried or expose upstream errors', async () => {
  for (const status of [302, 401, 403, 404, 409, 422, 429, 500]) {
    const f = fixture((url) =>
      url.pathname === path
        ? json(metadata)
        : json({ message: 'PRIVATE_TOKEN_BODY' }, status, {
            location: 'http://localhost/proxy',
            'retry-after': '10',
          }),
    );
    await assert.rejects(f.client.createIssueComment(target, 2, { body: 'test' }), (e: unknown) => {
      assert.ok(e instanceof GitHubWriteClientError);
      assert.equal(e.rejected, false);
      assert.equal(JSON.stringify(e).includes('PRIVATE_TOKEN_BODY'), false);
      return true;
    });
    assert.equal(f.writes().length, 1);
    assert.equal(f.requests.length, 2);
  }
  const network = fixture((url) => {
    if (url.pathname === path) return json(metadata);
    throw new Error('synthetic-token private response');
  });
  await assert.rejects(
    network.client.createIssueComment(target, 2, { body: 'test' }),
    (e: unknown) =>
      e instanceof GitHubWriteClientError &&
      !e.rejected &&
      !JSON.stringify(e).includes('synthetic-token'),
  );
  assert.equal(network.writes().length, 1);
});

test('preflight repository replacement, revoked lease and failed durable stage do not dispatch', async () => {
  const bad = fixture(() => json({ ...metadata, id: 99 }));
  await assert.rejects(
    bad.client.createIssueComment(target, 2, { body: 'test' }),
    error('stale', true),
  );
  assert.equal(bad.writes().length, 0);
  let current = true;
  const revoked = fixture(ordinary(issueComment, 201), {
    beforeDispatch: () => {
      current = false;
    },
    assertCurrent: () => {
      if (!current) throw new Error('private scope');
    },
  });
  await assert.rejects(
    revoked.client.createIssueComment(target, 2, { body: 'test' }),
    error('stale', true),
  );
  assert.equal(revoked.writes().length, 0);
  const stage = fixture(ordinary(issueComment, 201), {
    beforeDispatch: () => {
      throw new Error('db fault');
    },
  });
  await assert.rejects(
    stage.client.createIssueComment(target, 2, { body: 'test' }),
    error('unavailable', true),
  );
  assert.equal(stage.writes().length, 0);
});

test('known IDs survive result checkpoint failure, postflight repository changes and revoked lease', async () => {
  for (const mode of ['checkpoint', 'repository', 'lease']) {
    let pins = 0,
      current = true;
    const known: unknown[] = [];
    const f = fixture(
      (url) => {
        if (url.pathname === path)
          return json({ ...metadata, id: ++pins > 1 && mode === 'repository' ? 99 : 42 });
        if (mode === 'lease') current = false;
        return json(issueComment, 201);
      },
      {
        assertCurrent: () => {
          if (!current) throw new Error('revoked');
        },
        onResult: (value) => {
          known.push(value);
          if (mode === 'checkpoint') throw new Error('db fail');
        },
      },
    );
    await assert.rejects(f.client.createIssueComment(target, 2, { body: 'test' }), (e: unknown) => {
      assert.ok(e instanceof GitHubWriteClientError);
      assert.equal(e.rejected, false);
      assert.deepEqual(e.knownResult, { id: 300, number: 2 });
      return true;
    });
    assert.deepEqual(known, [{ id: 300, number: 2 }]);
    assert.equal(f.writes().length, 1);
  }
});

test('timeouts distinguish durable checkpoint from already-dispatched non-cooperating fetch', async () => {
  for (const dispatched of [false, true]) {
    const started = deferred<void>(),
      never = deferred<Response>();
    let fire!: () => void;
    const f = fixture(
      (url) => {
        if (url.pathname === path) return json(metadata);
        started.resolve();
        return never.promise;
      },
      {
        scheduleTimeout: (callback) => {
          fire = callback;
          return () => {};
        },
        ...(dispatched
          ? {}
          : {
              beforeDispatch: () => {
                started.resolve();
                return new Promise<void>(() => {});
              },
            }),
      },
    );
    const promise = f.client.createIssueComment(target, 2, { body: 'test' });
    await started.promise;
    fire();
    await assert.rejects(promise, error('timeout', !dispatched));
    assert.equal(f.writes().length, Number(dispatched));
  }
});

test('bounded malformed responses remain unknown after mutation and read revocation discards results', async () => {
  for (const response of [
    new Response('{broken', { status: 201 }),
    json(issueComment, 201, {
      'content-length': String(GITHUB_WRITE_CLIENT_LIMITS.responseBytes + 1),
    }),
    json({ ...issueComment, issue_url: `https://api.github.com${path}/issues/9` }, 201),
  ]) {
    const f = fixture((url) => (url.pathname === path ? json(metadata) : response));
    await assert.rejects(
      f.client.createIssueComment(target, 2, { body: 'test' }),
      (e: unknown) => e instanceof GitHubWriteClientError && !e.rejected && !e.knownResult,
    );
    assert.equal(f.writes().length, 1);
  }
  let current = true;
  const f = fixture(
    (url) => {
      if (url.pathname === path) return json(metadata);
      current = false;
      return json([reviewComment]);
    },
    {
      assertCurrent: () => {
        if (!current) throw new Error('revoked');
      },
    },
  );
  await assert.rejects(f.client.listReviewComments(target, 2), error('stale', true));
  assert.equal(f.requests.length, 2);
});

test('streamed size ceilings and oversized pages cannot become confirmed writes or unbounded reads', async () => {
  const oversized = fixture((url) =>
    url.pathname === path
      ? json(metadata)
      : new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(GITHUB_WRITE_CLIENT_LIMITS.responseBytes + 1));
              controller.close();
            },
          }),
          { status: 201 },
        ),
  );
  await assert.rejects(
    oversized.client.createIssueComment(target, 2, { body: 'test' }),
    error('too-large', false),
  );
  assert.equal(oversized.writes().length, 1);
  const list = fixture(ordinary(Array.from({ length: 21 }, () => file)));
  await assert.rejects(list.client.listPullFiles(target, 2), error('invalid-response', true));
  assert.equal(list.requests.length, 2);
});

test('external cancellation after dispatch stops noncooperating fetch with original operation unknown', async () => {
  const controller = new AbortController(),
    started = deferred<void>();
  const f = fixture(
    (url) => {
      if (url.pathname === path) return json(metadata);
      started.resolve();
      return new Promise<Response>(() => {});
    },
    { signal: controller.signal },
  );
  const promise = f.client.createIssueComment(target, 2, { body: 'test' });
  await started.promise;
  controller.abort();
  await assert.rejects(promise, error('cancelled', false));
  assert.equal(f.writes().length, 1);
  await assert.rejects(
    f.client.createIssueComment(target, 2, { body: 'test' }),
    error('cancelled', true),
  );
  assert.equal(f.writes().length, 1);
});

test('typed inputs reject alternate destinations and unknown write fields before any HTTP', async () => {
  const f = fixture(ordinary(issueComment, 201));
  await assert.rejects(
    f.client.createIssueComment({ ...target, owner: 'user@127.0.0.1' }, 2, { body: 'test' }),
    error('invalid-request', true),
  );
  await assert.rejects(
    f.client.createIssueComment(target, 2, { body: 'test', url: 'http://localhost/private' } as {
      body: string;
    }),
    error('invalid-request', true),
  );
  await assert.rejects(
    f.client.updatePull(target, 2, { body: 'test', method: 'DELETE' } as { body: string }),
    error('invalid-request', true),
  );
  assert.equal(f.requests.length, 0);
  assert.throws(() => githubOperationBody('test', 'invalid'), error('invalid-request', true));
  assert.throws(
    () => githubOperationBody('x'.repeat(12500), marker),
    error('invalid-request', true),
  );
});
