import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore } from '../src/runtime/store';
import { createGitHubClient } from '../src/runtime/github-client';
import { createGitHubWriteClient } from '../src/runtime/github-write-client';
import { type GitHubProjectConfig } from '../src/runtime/github-config';
import * as gitActions from '../src/runtime/project-git-actions';
import { readProjectGit } from '../src/runtime/project-git';
import type { SessionGithubWriteOptions } from '../src/runtime/session-github-write';
import { AppError } from '../src/protocol';
import {
  githubWriteActionSchema,
  githubWriteReceiptSchema,
  githubPatchLines,
  type GithubWriteAction,
  type GithubWriteRead,
  type GithubPullFile,
} from '../src/github-write-protocol';

const hash = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
const headSha = 'a'.repeat(40),
  baseSha = 'b'.repeat(40),
  date = '2026-09-12T00:00:00Z';
const repo = {
  id: 42,
  owner: { login: 'synthetic' },
  name: 'test',
  full_name: 'synthetic/test',
  default_branch: 'main',
  private: true,
  archived: false,
};
const issue = {
  id: 101,
  number: 1,
  title: 'Synthetic issue',
  body: 'EPHEMERAL_EXTERNAL_BODY',
  state: 'open',
  user: { login: 'reader', id: 9 },
  updated_at: date,
  labels: [],
};
const pull = {
  ...issue,
  id: 202,
  number: 2,
  title: 'Synthetic PR',
  draft: false,
  merged: false,
  mergeable: true,
  head: { ref: 'topic', sha: headSha, repo },
  base: { ref: 'main', sha: baseSha, repo },
};
const file = {
  sha: headSha,
  filename: 'file.txt',
  status: 'modified',
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: '@@ -1,2 +1,2 @@\n same\n-old\n+new',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture(
  t: { after(fn: () => unknown): void },
  gitOptions: Partial<NonNullable<SessionGithubWriteOptions['git']>> = {},
) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'moor-github-write-'))),
    root = join(temporary, 'project'),
    path = join(temporary, 'runtime.sqlite');
  mkdirSync(root);
  const localGit = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Synthetic',
        GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
        GIT_COMMITTER_NAME: 'Synthetic',
        GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
      },
    }).trim();
  localGit('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'file.txt'), 'before\n');
  localGit('add', 'file.txt');
  localGit('commit', '-qm', 'initial synthetic commit');
  let store = new RuntimeStore(path);
  Object.assign(store.workspace, {
    id: 'workspace',
    machineId: 'machine',
    userId: 'local:synthetic',
  });
  store.save('identity', Buffer.from(JSON.stringify(store.workspace)));
  store.machine.set(['localProject', 'project'], {
    id: 'project',
    name: 'Synthetic',
    rootPath: root,
  });
  store.saveMachine();
  const state: {
    config: GitHubProjectConfig | undefined;
    before?: (url: URL, init: RequestInit) => void | Promise<void>;
    respond?: (url: URL, init: RequestInit) => Response | undefined;
    lose: boolean;
    calls: { url: URL; method: string; body?: unknown }[];
    comments: any[];
    reviews: any[];
    pull: any;
  } = {
    config: {
      localProjectId: 'project',
      owner: 'synthetic',
      repo: 'test',
      token: 'SYNTHETIC_PRIVATE_TOKEN',
      credentialId: 'credential',
      repositoryId: 42,
      version: hash('config'),
      writesEnabled: true,
    },
    lose: false,
    calls: [],
    comments: [],
    reviews: [],
    pull: structuredClone(pull),
  };
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)),
      method = init.method ?? 'GET';
    state.calls.push({
      url,
      method,
      ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    await state.before?.(url, init);
    const override = state.respond?.(url, init);
    if (override) return override;
    if (url.pathname === '/repos/synthetic/test') return json(repo);
    if (url.pathname === '/user') return json({ id: 9, login: 'reader' });
    if (url.pathname === '/repos/synthetic/test/issues/1') return json(issue);
    if (url.pathname === '/repos/synthetic/test/pulls/2') {
      if (method === 'PATCH') {
        Object.assign(state.pull, JSON.parse(String(init.body)));
        return json(state.pull);
      }
      return json(state.pull);
    }
    if (url.pathname === '/repos/synthetic/test/pulls/2/merge')
      return json({ sha: headSha, merged: true, message: 'merged' });
    if (url.pathname === '/repos/synthetic/test/pulls/2/files') return json([file]);
    if (url.pathname === '/repos/synthetic/test/issues/1/comments') {
      if (method === 'POST') {
        const item = {
          id: 303 + state.comments.length,
          ...JSON.parse(String(init.body)),
          user: { id: 9, login: 'reader' },
          updated_at: date,
          issue_url: 'https://api.github.com/repos/synthetic/test/issues/1',
        };
        state.comments.push(item);
        if (state.lose) throw new Error('synthetic lost response');
        return json(item, 201);
      }
      return json(state.comments);
    }
    if (url.pathname === '/repos/synthetic/test/pulls/2/comments') {
      if (method === 'POST') {
        const body = JSON.parse(String(init.body));
        const item = {
          id: 403 + state.reviews.length,
          ...body,
          commit_id: body.commit_id,
          original_commit_id: body.commit_id,
          original_line: body.line,
          user: { id: 9, login: 'reader' },
          updated_at: date,
          pull_request_url: 'https://api.github.com/repos/synthetic/test/pulls/2',
        };
        state.reviews.push(item);
        if (state.lose) throw new Error('synthetic lost response');
        return json(item, 201);
      }
      return json(state.reviews);
    }
    if (url.pathname.startsWith('/repos/synthetic/test/branches/')) {
      const name = url.pathname.split('/').at(-1);
      return json({ name, commit: { sha: name === 'main' ? baseSha : headSha }, protected: false });
    }
    if (url.pathname === '/repos/synthetic/test/pulls') {
      if (method === 'POST') {
        const body = JSON.parse(String(init.body));
        state.pull = { ...pull, title: body.title, body: body.body };
        return json(state.pull, 201);
      }
      return json([state.pull]);
    }
    return new Response('synthetic missing route', { status: 404 });
  };
  const config = {
    getProject: () => state.config,
    isCurrent: (value: GitHubProjectConfig) =>
      JSON.stringify(value) === JSON.stringify(state.config),
  };
  const client: typeof createGitHubClient = (options) => createGitHubClient({ ...options, fetch });
  const writer: typeof createGitHubWriteClient = (options) =>
    createGitHubWriteClient({ ...options, fetch });
  const makeHost = () =>
    new HostWorkspace(
      store,
      {
        async open() {
          throw new Error('No real Agent');
        },
      },
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      { config: config as any, client },
      {
        config: config as any,
        client,
        writer,
        git: { ...gitActions, readProjectGit, ...gitOptions },
        now: () => Date.parse(date),
      },
    );
  let host = makeHost();
  t.after(() => {
    host.close();
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  });
  const scope = (sessionId = 'draft') => ({
    githubWriteVersion: 1 as const,
    workspaceId: 'workspace',
    localProjectId: 'project',
    sessionId,
  });
  const remote = { repositoryId: 42, configVersion: hash('config'), expectedBindingRevision: 0 };
  async function read(view: GithubWriteRead['view'], extra: object = {}, sessionId = 'draft') {
    return host.readGithubWrite({
      ...scope(sessionId),
      ...(view === 'overview' || view === 'commit-preview'
        ? {}
        : { repositoryId: 42, configVersion: state.config!.version }),
      view,
      ...extra,
    } as GithubWriteRead);
  }
  async function action(
    kind: GithubWriteAction['action'] = 'issue-comment',
    extra: object = {},
  ): Promise<GithubWriteAction> {
    let expectedVersion = '';
    if (kind === 'issue-comment' || kind.startsWith('pr-')) {
      const result = await host.readGithub({
        githubVersion: 1,
        workspaceId: 'workspace',
        localProjectId: 'project',
        sessionId: 'draft',
        repositoryId: 42,
        configVersion: hash('config'),
        view: kind === 'issue-comment' ? 'issue' : 'pull',
        number: kind === 'issue-comment' ? 1 : 2,
      });
      if (result.view === 'issue' || result.view === 'pull') expectedVersion = result.item.version;
    }
    return githubWriteActionSchema.parse({
      ...scope(),
      ...remote,
      operationId: randomUUID(),
      confirmed: true,
      action: kind,
      ...(kind === 'issue-comment'
        ? { subject: 'issue', number: 1, expectedVersion, body: 'User-authored exact comment' }
        : { number: 2, expectedVersion, headSha }),
      ...extra,
    });
  }
  return {
    state,
    root,
    read,
    action,
    scope,
    localGit,
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    restart() {
      host.close();
      store.close();
      store = new RuntimeStore(path);
      host = makeHost();
    },
  };
}

test('GitHub writes require local opt-in and exact confirmed scope/config/binding/item version', async (t) => {
  const f = fixture(t),
    request = await f.action();
  const overview = await f.read('overview');
  assert.equal(overview.view, 'overview');
  if (overview.view !== 'overview') throw new Error('overview');
  assert.equal(overview.canCommit, true);
  assert.equal(overview.writesEnabled, true);
  assert.equal(overview.git.branch, 'main');
  f.state.config!.writesEnabled = false;
  await assert.rejects(f.host.githubWriteAction(request), /启用/);
  f.state.config!.writesEnabled = true;
  for (const extra of [
    { confirmed: false },
    { localProjectId: 'elsewhere' },
    { repositoryId: 84 },
    { configVersion: hash('stale') },
    { expectedBindingRevision: 1 },
    { expectedVersion: hash('stale') },
  ])
    await assert.rejects(f.host.githubWriteAction({ ...request, ...extra } as any));
  assert.equal(f.state.calls.filter((c) => c.method !== 'GET').length, 0);
  assert.equal(f.store.journal.has(request.operationId), false);
});

test('one confirmed comment dispatch persists a scoped receipt across restart with no provider body/token in journal', async (t) => {
  const f = fixture(t),
    request = await f.action(),
    receipt = await f.host.githubWriteAction(request);
  assert.equal(receipt.phase, 'accepted');
  assert.equal(githubWriteReceiptSchema.safeParse(receipt).success, true);
  assert.deepEqual(receipt.result, { id: 303, number: 1 });
  assert.match(f.state.comments[0].body, /\n\n<!-- moor-operation:sha256:[a-f0-9]{64} -->$/);
  f.restart();
  assert.deepEqual(await f.host.githubWriteAction(request), receipt);
  await assert.rejects(
    f.host.githubWriteAction({ ...request, body: 'different' } as any),
    /不同请求/,
  );
  await assert.rejects(f.host.githubWriteAction({ ...request, sessionId: 'another' }), /不同请求/);
  const record = JSON.stringify(f.store.journal.db.prepare('SELECT * FROM operation').all());
  assert.equal(record.includes('EPHEMERAL_EXTERNAL_BODY'), false);
  assert.equal(record.includes('SYNTHETIC_PRIVATE_TOKEN'), false);
  assert.equal(f.state.calls.filter((c) => c.method === 'POST').length, 1);
});

test('lost comment response remains unknown and manual original-id inspection recovers exactly once', async (t) => {
  const f = fixture(t),
    request = await f.action();
  f.state.lose = true;
  assert.equal((await f.host.githubWriteAction(request)).phase, 'unknown');
  f.restart();
  assert.equal((await f.host.githubWriteAction(request)).phase, 'unknown');
  assert.equal((await f.host.inspectGithubWrite({ request, page: 1 })).phase, 'accepted');
  assert.equal(f.state.calls.filter((c) => c.method === 'POST').length, 1);
});

test('recovery requires exact author, operation marker and complete original body; unknown may only release display', async (t) => {
  const f = fixture(t),
    request = await f.action();
  f.state.lose = true;
  await f.host.githubWriteAction(request);
  f.state.comments[0].body = 'altered\n' + f.state.comments[0].body;
  assert.equal((await f.host.inspectGithubWrite({ request, page: 2 })).phase, 'unknown');
  assert.equal(f.state.calls.at(-2)?.url.searchParams.get('page'), '2');
  const released = await f.host.abandonGithubWrite({ request });
  assert.equal(released.phase, 'unknown');
  assert.equal(released.released, true);
  assert.deepEqual(await f.host.githubWriteAction(request), released);
  assert.equal(f.state.calls.filter((c) => c.method === 'POST').length, 1);
});

test('inspection never first-dispatches and abandonment tombstones late original action', async (t) => {
  const f = fixture(t),
    request = await f.action();
  const count = f.state.calls.length;
  assert.equal((await f.host.inspectGithubWrite({ request, page: 1 })).phase, 'unknown');
  assert.equal((await f.host.abandonGithubWrite({ request })).phase, 'abandoned');
  f.restart();
  assert.equal((await f.host.githubWriteAction(request)).phase, 'abandoned');
  assert.equal(f.state.calls.length, count);
});

test('configuration revoked after validated remote acceptance preserves receipt but scope reassignment exposes no response', async (t) => {
  const f = fixture(t),
    request = await f.action();
  f.state.before = (_url, init) => {
    if (init.method === 'POST') f.state.config = undefined;
  };
  assert.equal((await f.host.githubWriteAction(request)).phase, 'accepted');
  assert.equal(f.state.calls.filter((c) => c.method === 'POST').length, 1);
  f.state.config = {
    localProjectId: 'project',
    owner: 'synthetic',
    repo: 'test',
    token: 'SYNTHETIC_PRIVATE_TOKEN',
    credentialId: 'credential',
    repositoryId: 42,
    version: hash('config'),
    writesEnabled: true,
  };
  const second = await f.action();
  f.state.before = (_url, init) => {
    if (init.method === 'POST') f.store.workspace.userId = 'local:other';
  };
  await assert.rejects(
    f.host.githubWriteAction(second),
    (e: unknown) => e instanceof AppError && e.rejected === false,
  );
  f.store.workspace.userId = 'local:synthetic';
  assert.equal((await f.host.inspectGithubWrite({ request: second, page: 1 })).phase, 'accepted');
});

test('PR line comments require a current full patch line on the requested side and preserve anchors during recovery', async (t) => {
  const f = fixture(t),
    files = await f.read('files', { number: 2, headSha, baseSha, page: 1 });
  assert.equal(files.view, 'files');
  if (files.view !== 'files') return;
  const request = githubWriteActionSchema.parse({
    ...f.scope(),
    operationId: randomUUID(),
    confirmed: true,
    action: 'review-comment',
    repositoryId: 42,
    configVersion: hash('config'),
    expectedBindingRevision: 0,
    number: 2,
    headSha,
    baseSha,
    filePage: 1,
    path: 'file.txt',
    fileVersion: files.result.items[0]!.version,
    side: 'RIGHT',
    line: 2,
    body: 'Review this exact line',
  });
  await assert.rejects(f.host.githubWriteAction({ ...request, line: 3 } as any), /补丁/);
  await assert.rejects(
    f.host.githubWriteAction({ ...request, fileVersion: hash('stale') } as any),
    /文件版本/,
  );
  f.state.lose = true;
  assert.equal((await f.host.githubWriteAction(request)).phase, 'unknown');
  assert.equal((await f.host.inspectGithubWrite({ request, page: 1 })).phase, 'accepted');
  assert.equal(f.state.calls.filter((c) => c.method === 'POST').length, 1);
});

test('PR edit/state/merge preflight exact versions and never resend an accepted operation', async (t) => {
  const f = fixture(t);
  for (const [kind, extra] of [
    ['pr-update', { title: 'New title', body: 'User edit' }],
    ['pr-state', { state: 'closed' }],
    ['pr-state', { state: 'open' }],
    ['pr-merge', { method: 'squash' }],
  ] as const) {
    const request = await f.action(kind, extra),
      before = f.state.calls.filter((c) => c.method !== 'GET').length;
    assert.equal((await f.host.githubWriteAction(request)).phase, 'accepted');
    assert.equal((await f.host.githubWriteAction(request)).phase, 'accepted');
    assert.equal(f.state.calls.filter((c) => c.method !== 'GET').length, before + 1);
  }
  assert.deepEqual(f.state.calls.find((c) => c.method === 'PUT')?.body, {
    sha: headSha,
    merge_method: 'squash',
  });
});

test('local commit needs no remote credentials, binds selected bytes and preserves other staged content', async (t) => {
  const f = fixture(t);
  f.state.config = undefined;
  writeFileSync(join(f.root, 'file.txt'), 'selected\n');
  writeFileSync(join(f.root, 'other.txt'), 'unselected\n');
  f.localGit('add', 'other.txt');
  const preview = await f.read('commit-preview', { paths: ['file.txt'] });
  if (preview.view !== 'commit-preview') throw new Error('preview');
  const request = githubWriteActionSchema.parse({
    ...f.scope(),
    operationId: randomUUID(),
    confirmed: true,
    action: 'commit',
    paths: ['file.txt'],
    candidateVersion: preview.candidateVersion,
    branch: preview.branch,
    parentOid: preview.parentOid,
    indexVersion: preview.indexVersion,
    executionRevision: preview.execution.revision,
    message: 'synthetic selected change',
    author: { name: 'Synthetic', email: 'synthetic@example.invalid' },
  });
  writeFileSync(join(f.root, 'file.txt'), 'changed after review\n');
  await assert.rejects(f.host.githubWriteAction(request), /变化/);
  writeFileSync(join(f.root, 'file.txt'), 'selected\n');
  const receipt = await f.host.githubWriteAction(request);
  assert.equal(receipt.phase, 'accepted');
  assert.equal(f.localGit('show', 'HEAD:file.txt'), 'selected');
  assert.equal(f.localGit('show', '-s', '--format=%ct', 'HEAD'), String(Date.parse(date) / 1000));
  assert.equal(f.localGit('diff', '--cached', '--name-only'), 'other.txt');
  assert.equal(f.state.calls.length, 0);
  f.restart();
  assert.deepEqual(await f.host.githubWriteAction(request), receipt);
});

test('uncertain commit holds execution until explicit release proves its finished writer left the original baseline', async (t) => {
  let dispatched = 0,
    inspected = 0,
    definitive = false;
  const f = fixture(t, {
    async commitProject(_plan, options) {
      await options?.onDispatched?.();
      dispatched++;
      throw new AppError(409, 'synthetic commit failure', definitive);
    },
    async inspectProjectCommit(plan) {
      inspected++;
      return { status: 'not-applied', oid: plan.oid, indexReady: false };
    },
  });
  writeFileSync(join(f.root, 'file.txt'), 'selected\n');
  const preview = await f.read('commit-preview', { paths: ['file.txt'] });
  if (preview.view !== 'commit-preview') throw new Error('preview');
  const request = githubWriteActionSchema.parse({
    ...f.scope(),
    operationId: randomUUID(),
    confirmed: true,
    action: 'commit',
    paths: ['file.txt'],
    candidateVersion: preview.candidateVersion,
    branch: preview.branch,
    parentOid: preview.parentOid,
    indexVersion: preview.indexVersion,
    executionRevision: 0,
    message: 'synthetic',
    author: { name: 'Synthetic', email: 'synthetic@example.invalid' },
  });
  assert.equal((await f.host.githubWriteAction(request)).phase, 'unknown');
  f.restart();
  assert.throws(
    () => f.host.githubWriteManager.assertExecutionAvailable({ rootPath: f.root }),
    /尚未确认/,
  );
  assert.equal((await f.host.inspectGithubWrite({ request, page: 1 })).phase, 'unknown');
  const row = f.store.journal.db
    .prepare('SELECT approval FROM operation WHERE id=?')
    .get(request.operationId)!;
  const plan = JSON.parse(String(row.approval));
  delete plan.writerSettled;
  f.store.journal.db
    .prepare('UPDATE operation SET approval=? WHERE id=?')
    .run(JSON.stringify(plan), request.operationId);
  await assert.rejects(f.host.abandonGithubWrite({ request }), /进程尚未确认收尾/);
  plan.writerSettled = true;
  f.store.journal.db
    .prepare('UPDATE operation SET approval=? WHERE id=?')
    .run(JSON.stringify(plan), request.operationId);
  const ended = await f.host.abandonGithubWrite({ request });
  assert.equal(ended.phase, 'unknown');
  assert.equal(ended.released, true);
  f.host.githubWriteManager.assertExecutionAvailable({ rootPath: f.root });
  assert.deepEqual(await f.host.abandonGithubWrite({ request }), ended);
  assert.equal((await f.host.githubWriteAction(request)).phase, 'unknown');
  assert.equal(dispatched, 1);
  assert.equal(inspected, 2);
  definitive = true;
  assert.equal(
    (await f.host.githubWriteAction({ ...request, operationId: randomUUID() })).phase,
    'rejected',
  );
  f.host.githubWriteManager.assertExecutionAvailable({ rootPath: f.root });
  assert.equal(dispatched, 2);
});

test('commit preparation excludes concurrent worktree actions in overlapping project roots', async (t) => {
  const arrived = deferred(),
    release = deferred();
  const f = fixture(t, {
    async planProjectCommit(candidate, identity, options) {
      arrived.resolve();
      await release.promise;
      return gitActions.planProjectCommit(candidate, identity, options);
    },
  });
  writeFileSync(join(f.root, 'file.txt'), 'selected\n');
  const preview = await f.read('commit-preview', { paths: ['file.txt'] });
  if (preview.view !== 'commit-preview') throw new Error('preview');
  const request = githubWriteActionSchema.parse({
    ...f.scope(),
    operationId: randomUUID(),
    confirmed: true,
    action: 'commit',
    paths: ['file.txt'],
    candidateVersion: preview.candidateVersion,
    branch: preview.branch,
    parentOid: preview.parentOid,
    indexVersion: preview.indexVersion,
    executionRevision: 0,
    message: 'synthetic',
    author: { name: 'Synthetic', email: 'synthetic@example.invalid' },
  });
  const pending = f.host.githubWriteAction(request);
  await arrived.promise;
  try {
    await assert.rejects(
      f.host.githubWriteManager.withExecutionTask(
        { ...f.scope('another') },
        undefined,
        async () => {},
      ),
      /正在准备/,
    );
  } finally {
    release.resolve();
  }
  assert.equal((await pending).phase, 'accepted');
});

test('push preview never treats an unreadable remote as an absent branch; confirmed pushes freeze the remote CAS', async (t) => {
  let readable = false,
    pushed = 0;
  const f = fixture(t, {
    async inspectProjectPush() {
      return readable
        ? { status: 'not-applied', remoteOid: null }
        : { status: 'unknown', remoteOid: null };
    },
    async pushProject(plan, options) {
      assert.equal(plan.expectedRemoteOid, null);
      assert.equal(plan.remote.repositoryId, 42);
      options.assertCurrent?.();
      await options.onDispatched?.();
      pushed++;
      return { oid: plan.headOid };
    },
  });
  const headOid = f.localGit('rev-parse', 'HEAD');
  await assert.rejects(f.read('push-preview', { branch: 'main', headOid }), /远端分支状态尚未确认/);
  readable = true;
  const preview = await f.read('push-preview', { branch: 'main', headOid });
  assert.equal(preview.view, 'push-preview');
  const request = githubWriteActionSchema.parse({
    ...f.scope(),
    operationId: randomUUID(),
    confirmed: true,
    action: 'push',
    repositoryId: 42,
    configVersion: hash('config'),
    expectedBindingRevision: 0,
    branch: 'main',
    headOid,
    expectedRemoteOid: null,
    executionRevision: 0,
  });
  assert.equal((await f.host.githubWriteAction(request)).phase, 'accepted');
  f.restart();
  assert.equal((await f.host.githubWriteAction(request)).phase, 'accepted');
  assert.equal(pushed, 1);
});

test('created PR preserves the actual remote head and reports changes occurring after review', async (t) => {
  const f = fixture(t),
    actualSha = 'c'.repeat(40);
  f.state.respond = (url, init) =>
    url.pathname === '/repos/synthetic/test/pulls' && init.method === 'POST'
      ? json({ ...pull, head: { ...pull.head, sha: actualSha } }, 201)
      : undefined;
  const request = githubWriteActionSchema.parse({
    ...f.scope(),
    operationId: randomUUID(),
    confirmed: true,
    action: 'pr-create',
    repositoryId: 42,
    configVersion: hash('config'),
    expectedBindingRevision: 0,
    headBranch: 'topic',
    baseBranch: 'main',
    headSha,
    baseSha,
    title: 'Synthetic creation',
    body: 'User creation',
    draft: false,
  });
  const receipt = await f.host.githubWriteAction(request);
  assert.equal(receipt.phase, 'accepted');
  assert.equal(receipt.result?.sha, actualSha);
  assert.match(receipt.message, /来源分支已变化/);
  assert.deepEqual(await f.host.githubWriteAction(request), receipt);
  assert.equal(f.state.calls.filter((c) => c.method === 'POST').length, 1);
});

test('patch line projection rejects unavailable, truncated and incomplete hunk contents', () => {
  const base: GithubPullFile = {
    path: 'a',
    sha: headSha,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patchTruncated: false,
    version: hash('patch'),
    patch: file.patch,
  };
  assert.deepEqual(
    githubPatchLines(base)
      .filter((l) => l.kind !== 'header')
      .map((l) => [l.oldLine, l.newLine]),
    [
      [1, 1],
      [2, undefined],
      [undefined, 2],
    ],
  );
  for (const value of [
    { ...base, patch: undefined },
    { ...base, patchTruncated: true },
    { ...base, patch: '@@ -1,2 +1,2 @@\n-only one' },
  ])
    assert.deepEqual(githubPatchLines(value), []);
});
