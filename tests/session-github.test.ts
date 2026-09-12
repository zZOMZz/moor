import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostWorkspace } from '../src/bridge/host-workspace';
import { RuntimeStore, type AttachmentScope } from '../src/runtime/store';
import { createGitHubClient } from '../src/runtime/github-client';
import type { GitHubProjectConfig } from '../src/runtime/github-config';
import type { AgentDriver } from '../src/runtime/agent';
import { AppError } from '../src/protocol';
import { metas, putMeta } from '../src/model';
import {
  githubReadResultSchema,
  githubReceiptSchema,
  type GithubAction,
  type GithubRead,
} from '../src/github-protocol';

const hash = (letter: string) => 'sha256:' + letter.repeat(64);
const headSha = 'a'.repeat(40),
  baseSha = 'b'.repeat(40);
const date = '2026-09-12T00:00:00Z';
const repo = {
  id: 42,
  owner: { login: 'synthetic' },
  name: 'test',
  full_name: 'synthetic/test',
  default_branch: 'main',
  private: true,
  archived: false,
};
const issueData = {
  id: 101,
  number: 1,
  title: 'Synthetic Issue title must remain ephemeral',
  body: 'GitHub external body must never enter Moor session storage',
  state: 'open',
  user: { login: 'synthetic' },
  updated_at: date,
  labels: [{ name: 'example' }],
};
const pullData = {
  ...issueData,
  id: 202,
  number: 2,
  title: 'Synthetic PR',
  draft: false,
  merged: false,
  mergeable: null,
  head: {
    ref: 'feature/topic',
    sha: headSha,
    repo: { id: 84, owner: { login: 'contributor' }, name: 'fork' },
  },
  base: { ref: 'main', sha: baseSha, repo },
};
const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init });
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: { after(fn: () => unknown): void }) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'moor-session-github-'))),
    root = join(temporary, 'project'),
    otherRoot = join(temporary, 'other'),
    file = join(temporary, 'runtime.sqlite');
  mkdirSync(root);
  mkdirSync(otherRoot);
  let store = new RuntimeStore(file);
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
  store.machine.set(['localProject', 'other'], { id: 'other', name: 'Other', rootPath: otherRoot });
  store.saveMachine();
  const scope = (sessionId = 'draft') => ({
    githubVersion: 1 as const,
    workspaceId: 'workspace',
    localProjectId: 'project',
    sessionId,
  });
  const fullScope = (sessionId = 'draft'): AttachmentScope => ({
    workspaceId: 'workspace',
    localProjectId: 'project',
    sessionId,
    userId: 'local:synthetic',
    machineId: 'machine',
  });
  let config: GitHubProjectConfig | undefined = {
    localProjectId: 'project',
    owner: 'synthetic',
    repo: 'test',
    token: 'synthetic-private-token',
    credentialId: 'credential',
    repositoryId: 42,
    version: hash('c'),
  };
  let issue = structuredClone(issueData),
    pull = structuredClone(pullData),
    repository = structuredClone(repo);
  let beforeRequest: ((url: URL) => void | Promise<void>) | undefined;
  let respond: ((url: URL) => Response | undefined) | undefined;
  let changed: (() => void) | undefined;
  let requestSignal: AbortSignal | undefined;
  let agentStarts = 0;
  const requests: URL[] = [];
  const driver: AgentDriver = {
    async open() {
      agentStarts++;
      throw new Error('GitHub must not start an Agent');
    },
  };
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    await beforeRequest?.(url);
    const response = respond?.(url);
    if (response) return response;
    if (url.pathname === '/repos/synthetic/test') return json(repository);
    if (url.pathname === '/repos/synthetic/test/branches')
      return json([{ name: 'main', commit: { sha: baseSha }, protected: false }]);
    if (url.pathname === '/repos/synthetic/test/branches/main')
      return json({ name: 'main', commit: { sha: baseSha }, protected: false });
    if (url.pathname === '/repos/synthetic/test/issues')
      return json([issue, { ...pull, pull_request: {} }]);
    if (url.pathname === '/repos/synthetic/test/pulls') return json([pull]);
    if (url.pathname === '/repos/synthetic/test/issues/1') return json(issue);
    if (url.pathname === '/repos/synthetic/test/pulls/2') return json(pull);
    if (/\/issues\/[12]\/comments$/.test(url.pathname))
      return json([
        {
          id: 303,
          body: 'Synthetic discussion body',
          user: { login: 'commenter' },
          updated_at: date,
        },
      ]);
    if (url.pathname.endsWith('/check-runs'))
      return json({
        total_count: 1,
        check_runs: [
          {
            id: 4,
            head_sha: headSha,
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            started_at: date,
            completed_at: date,
          },
        ],
      });
    if (url.pathname.endsWith('/status'))
      return json({ repository, sha: headSha, state: 'success', total_count: 0, statuses: [] });
    return new Response('Synthetic missing resource', { status: 404 });
  };
  const makeHost = () =>
    new HostWorkspace(
      store,
      driver,
      () => {},
      () => changed?.(),
      undefined,
      undefined,
      undefined,
      {
        config: {
          getProject(id) {
            if (id !== 'project' || !config) throw new AppError(409, '项目尚未验证 GitHub 仓库');
            return { ...config };
          },
          isCurrent(snapshot) {
            return !!config && JSON.stringify(snapshot) === JSON.stringify(config);
          },
        },
        client: (options) => createGitHubClient({ ...options, fetch }),
        now: () => Date.parse(date),
        signal: () => requestSignal ?? AbortSignal.timeout(25_000),
      },
    );
  let host = makeHost();
  t.after(() => {
    host.close();
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  });
  return {
    root,
    otherRoot,
    requests,
    scope,
    fullScope,
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    get agentStarts() {
      return agentStarts;
    },
    get config() {
      return config;
    },
    set config(value) {
      config = value;
    },
    get issue() {
      return issue;
    },
    set issue(value) {
      issue = value;
    },
    get pull() {
      return pull;
    },
    set pull(value) {
      pull = value;
    },
    get repository() {
      return repository;
    },
    set repository(value) {
      repository = value;
    },
    set beforeRequest(value: typeof beforeRequest) {
      beforeRequest = value;
    },
    set respond(value: typeof respond) {
      respond = value;
    },
    set changed(value: typeof changed) {
      changed = value;
    },
    set signal(value: AbortSignal) {
      requestSignal = value;
    },
    read(view: GithubRead['view'], extra: object = {}, sessionId = 'draft') {
      return host.readGithub({
        ...scope(sessionId),
        ...(view !== 'overview'
          ? { repositoryId: 42, configVersion: config?.version ?? hash('c') }
          : {}),
        view,
        ...extra,
      } as GithubRead);
    },
    bind(extra: object = {}, sessionId = 'draft'): Extract<GithubAction, { action: 'bind' }> {
      return {
        ...scope(sessionId),
        action: 'bind',
        operationId: randomUUID(),
        expectedRevision: 0,
        repositoryId: 42,
        configVersion: config?.version ?? hash('c'),
        branch: 'main',
        subject: null,
        ...extra,
      };
    },
    unbind(revision: number, sessionId = 'draft'): Extract<GithubAction, { action: 'unbind' }> {
      return {
        ...scope(sessionId),
        action: 'unbind',
        operationId: randomUUID(),
        expectedRevision: revision,
      };
    },
    restart() {
      host.close();
      store.close();
      store = new RuntimeStore(file);
      host = makeHost();
    },
  };
}

test('GitHub Host draft binding creates only scoped context and receipt without Agent or session-body creation', async (t) => {
  const f = fixture(t),
    beforeMeta = f.store.meta.exportFile();
  const overview = await f.read('overview');
  assert.equal(githubReadResultSchema.safeParse(overview).success, true);
  assert.equal(overview.view === 'overview' && overview.status, 'available');
  const detail = await f.read('issue', { number: 1 });
  assert.equal(detail.view, 'issue');
  if (detail.view !== 'issue') throw new Error('Expected issue');
  const action = f.bind({ subject: { kind: 'issue', number: 1, version: detail.item.version } });
  const result = await f.host.githubAction(action, 'project');
  assert.equal(githubReceiptSchema.safeParse(result).success, true);
  assert.equal(result.binding.revision, 1);
  assert.equal(result.binding.context?.subject?.kind, 'issue');
  assert.equal(f.agentStarts, 0);
  assert.equal(f.store.searchSource('draft'), undefined);
  assert.equal(f.store.nativeSession('draft'), undefined);
  assert.equal(metas(f.store.meta)['session-draft'], undefined);
  assert.deepEqual(f.store.meta.exportFile(), beforeMeta);
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM session').get()!.n, 0);
  const durable = JSON.stringify({
    binding: f.store.journal.db.prepare('SELECT * FROM session_github').all(),
    operation: f.store.journal.db.prepare('SELECT * FROM operation').all(),
  });
  assert.equal(durable.includes(issueData.body), false);
  assert.equal(durable.includes(issueData.title), false);
  assert.equal(durable.includes('synthetic-private-token'), false);
  assert.deepEqual(f.store.github.get(f.fullScope()), result.binding);
});

test('GitHub Host verifies branch existence and exact Issue/PR version, head commit and source branch', async (t) => {
  const f = fixture(t),
    issue = await f.read('issue', { number: 1 }),
    pull = await f.read('pull', { number: 2 });
  if (issue.view !== 'issue' || pull.view !== 'pull') throw new Error('Expected details');
  for (const action of [
    f.bind({ branch: 'missing' }),
    f.bind({ subject: { kind: 'issue', number: 1, version: hash('d') } }),
    f.bind({
      branch: 'main',
      subject: { kind: 'pull', number: 2, version: pull.item.version, headSha },
    }),
    f.bind({
      branch: 'feature/topic',
      subject: { kind: 'pull', number: 2, version: pull.item.version, headSha: baseSha },
    }),
  ]) {
    await assert.rejects(
      f.host.githubAction(action),
      (error) => error instanceof AppError && error.rejected,
    );
    assert.equal(f.store.journal.has(action.operationId), false);
  }
  const request = f.bind({
    branch: pull.item.head.branch,
    subject: { kind: 'pull', number: 2, version: pull.item.version, headSha },
  });
  const result = await f.host.githubAction(request);
  assert.equal(result.binding.context?.branch, 'feature/topic');
  assert.deepEqual(result.binding.context?.headRepository, {
    id: 84,
    owner: 'contributor',
    name: 'fork',
  });
  assert.equal(result.binding.context?.repository.id, 42);
  assert.equal(result.binding.context?.baseBranch, 'main');
  assert.equal(
    f.requests.some((url) => url.pathname.includes('/branches/feature')),
    false,
  );
  assert.equal(
    f.requests.every((url) => url.pathname.startsWith('/repos/synthetic/test')),
    true,
  );
});

test('GitHub Host list and discussion pages preserve kind and bounded coverage', async (t) => {
  const f = fixture(t);
  f.respond = (url) =>
    url.pathname.endsWith('/issues')
      ? json(
          [
            { ...issueData, number: 20 },
            { ...pullData, pull_request: {} },
          ],
          { headers: { link: '<https://arbitrary.invalid/never-follow>; rel="next"' } },
        )
      : undefined;
  const issues = await f.read('issues', { page: 2, state: 'all' });
  if (issues.view !== 'issues') throw new Error('Expected issues');
  assert.deepEqual(
    issues.result.items.map((i) => i.kind),
    ['issue'],
  );
  assert.equal(issues.result.page, 2);
  assert.equal(issues.result.partial, true);
  assert.equal(issues.result.hasNext, true);
  const pulls = await f.read('pulls', { page: 1, state: 'open' });
  if (pulls.view !== 'pulls') throw new Error('Expected pulls');
  assert.deepEqual(
    pulls.result.items.map((i) => i.kind),
    ['pull'],
  );
  const comments = await f.read('comments', { number: 2, subject: 'pull', page: 1 });
  if (comments.view !== 'comments') throw new Error('Expected comments');
  assert.equal(comments.result.items[0].body, 'Synthetic discussion body');
  await assert.rejects(f.read('comments', { number: 2, subject: 'issue', page: 1 }));
  assert.equal(
    f.requests.every((url) => url.origin === 'https://api.github.com'),
    true,
  );
});

test('GitHub Host CI results require the same PR head before and after independent checks/status reads', async (t) => {
  const f = fixture(t);
  const result = await f.read('checks', { number: 2, headSha, page: 1 });
  if (result.view !== 'checks') throw new Error('Expected checks');
  assert.equal(result.headSha, headSha);
  assert.equal(result.checks.items[0].conclusion, 'success');
  assert.equal(result.statuses.state, 'success');
  f.beforeRequest = (url) => {
    if (url.pathname.endsWith('/status'))
      f.pull = { ...f.pull, head: { ...f.pull.head, sha: 'c'.repeat(40) } };
  };
  await assert.rejects(f.read('checks', { number: 2, headSha, page: 1 }), /变化/);
  await assert.rejects(f.read('checks', { number: 2, headSha, page: 1 }), /变化/);
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM session_github').get()!.n, 0);
});

test('GitHub Host validates workspace, replica, account, device and session identity before returning context', async (t) => {
  const f = fixture(t),
    action = f.bind();
  await f.host.githubAction(action);
  for (const request of [
    { ...f.scope(), workspaceId: 'foreign', view: 'overview' },
    { ...f.scope(), localProjectId: 'other', view: 'overview' },
  ])
    await assert.rejects(f.host.readGithub(request as GithubRead));
  await assert.rejects(f.host.readGithub({ ...f.scope(), view: 'overview' }, 'other'));
  await assert.rejects(f.host.githubAction({ ...action, sessionId: 'other-session' }), /重复编号/);
  const calls = f.requests.length;
  for (const field of ['userId', 'machineId'] as const) {
    const prior = f.store.workspace[field];
    f.store.workspace[field] = 'foreign';
    await assert.rejects(f.read('overview'));
    f.store.workspace[field] = prior;
  }
  assert.equal(f.requests.length, calls);
  putMeta(f.store.meta, 'session-draft', {
    id: 'draft',
    userId: 'local:synthetic',
    machineId: 'machine',
    project: { kind: 'local', localProjectId: 'other' },
  });
  await assert.rejects(f.read('overview'));
});

test('GitHub Host drops late successful and failed reads after authorization, project or connection changes', async (t) => {
  for (const change of ['config', 'account', 'project', 'closed', 'upstream-error'] as const) {
    const f = fixture(t),
      entered = signal(),
      release = signal();
    f.beforeRequest = async (url) => {
      if (url.pathname.endsWith('/issues/1')) {
        entered.resolve();
        await release.promise;
      }
    };
    const pending = f.read('issue', { number: 1 }),
      rejected = assert.rejects(pending);
    await entered.promise;
    if (change === 'config' || change === 'upstream-error') f.config = undefined;
    if (change === 'account') f.store.workspace.userId = 'local:changed';
    if (change === 'project') {
      f.store.machine.set(['localProject', 'project'], {
        id: 'project',
        name: 'Replaced',
        rootPath: f.otherRoot,
      });
      f.store.saveMachine();
      f.host.updateCatalogue();
    }
    if (change === 'closed') f.host.close();
    if (change === 'upstream-error')
      f.respond = (url) =>
        url.pathname.endsWith('/issues/1')
          ? new Response('private upstream error', { status: 500 })
          : undefined;
    release.resolve();
    await rejected;
    assert.equal(
      f.store.journal.db.prepare('SELECT count(*) AS n FROM session_github').get()!.n,
      0,
    );
  }
});

test('GitHub Host in-flight bind cannot commit after token replacement or a concurrent binding change', async (t) => {
  const f = fixture(t),
    entered = signal(),
    release = signal(),
    request = f.bind();
  f.beforeRequest = async (url) => {
    if (url.pathname.endsWith('/branches/main')) {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = f.host.githubAction(request),
    rejected = assert.rejects(pending, (error) => error instanceof AppError && error.rejected);
  await entered.promise;
  f.config = { ...f.config!, token: 'replaced-token', version: hash('d') };
  release.resolve();
  await rejected;
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.deepEqual(f.store.github.get(f.fullScope()), { revision: 0 });
  f.beforeRequest = undefined;
  const requests = [f.bind(), f.bind()];
  const results = await Promise.allSettled(requests.map((action) => f.host.githubAction(action)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(f.store.github.get(f.fullScope()).revision, 1);
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM operation').get()!.n, 1);
});

test('GitHub Host unbind works after local credential revocation without new GitHub requests', async (t) => {
  const f = fixture(t);
  await f.host.githubAction(f.bind());
  const calls = f.requests.length;
  f.config = undefined;
  const overview = await f.read('overview');
  assert.equal(overview.view === 'overview' && overview.status, 'unavailable');
  assert.equal(overview.binding.context, undefined);
  assert.equal(overview.binding.revision, 1);
  const action = f.unbind(1),
    receipt = await f.host.githubAction(action);
  assert.deepEqual(receipt.binding, { revision: 2 });
  assert.deepEqual(await f.host.githubAction(action), receipt);
  assert.equal(f.requests.length, calls);
});

test('GitHub Host persists receipts across loss and restart and only replays the exact original operation', async (t) => {
  const f = fixture(t),
    request = f.bind();
  let lost = false;
  f.changed = () => {
    if (!lost) {
      lost = true;
      throw new Error('Synthetic receipt lost after durable commit');
    }
  };
  await assert.rejects(f.host.githubAction(request), /receipt lost/);
  assert.equal(f.store.journal.has(request.operationId), true);
  assert.equal(f.store.github.get(f.fullScope()).revision, 1);
  f.changed = undefined;
  f.restart();
  const receipt = await f.host.githubAction(request);
  assert.deepEqual(receipt.binding, { revision: 1 });
  assert.equal(receipt.redacted, true);
  assert.deepEqual(await f.host.githubAction(request), receipt);
  await assert.rejects(f.host.githubAction({ ...request, branch: 'changed' }), /重复编号/);
  await assert.rejects(f.host.githubAction({ ...request, operationId: randomUUID() }), /变化/);
  assert.equal(f.store.github.get(f.fullScope()).revision, 1);
  const savedConfig = f.config,
    calls = f.requests.length;
  f.config = undefined;
  assert.deepEqual(await f.host.githubAction(request), receipt);
  assert.equal(f.requests.length, calls);
  assert.equal(f.store.github.get(f.fullScope()).revision, 1);
  f.config = savedConfig;
  assert.deepEqual(await f.host.githubAction(request), receipt);
  assert.equal(f.requests.length, calls);
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM operation').get()!.n, 1);
});

test('GitHub Host transaction failure rolls back scope, binding and receipt before manual original-ID retry', async (t) => {
  const f = fixture(t),
    request = f.bind();
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_github_receipt BEFORE INSERT ON operation WHEN NEW.phase='github-accepted' BEGIN SELECT RAISE(ABORT,'Synthetic receipt write failed'); END",
  );
  await assert.rejects(
    f.host.githubAction(request),
    (error) => error instanceof AppError && error.rejected,
  );
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.deepEqual(f.store.github.get(f.fullScope()), { revision: 0 });
  assert.equal(
    f.store.journal.db.prepare('SELECT * FROM attachment_scope WHERE session_id=?').get('draft'),
    undefined,
  );
  f.store.journal.db.exec('DROP TRIGGER fail_github_receipt');
  assert.equal((await f.host.githubAction(request)).binding.revision, 1);
  const unbind = f.unbind(1);
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_github_update BEFORE UPDATE ON session_github BEGIN SELECT RAISE(ABORT,'Synthetic context update failed'); END",
  );
  await assert.rejects(f.host.githubAction(unbind));
  assert.equal(f.store.github.get(f.fullScope()).revision, 1);
  assert.equal(f.store.journal.has(unbind.operationId), false);
  f.store.journal.db.exec('DROP TRIGGER fail_github_update');
  assert.equal((await f.host.githubAction(unbind)).binding.revision, 2);
});

test('GitHub Host rechecks Fork reservations inside the session queue and after remote reads', async (t) => {
  const f = fixture(t),
    entered = signal(),
    release = signal();
  const queue = f.host.serial('draft', async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const action = f.bind(),
    pending = f.host.githubAction(action),
    rejected = assert.rejects(pending, /Fork/);
  f.host.forkManager.busy.add('draft');
  release.resolve();
  await queue;
  await rejected;
  assert.equal(f.requests.length, 0);
  f.host.forkManager.busy.delete('draft');
  const readEntered = signal(),
    readRelease = signal();
  f.beforeRequest = async (url) => {
    if (url.pathname.endsWith('/branches/main')) {
      readEntered.resolve();
      await readRelease.promise;
    }
  };
  const next = f.bind(),
    inFlight = f.host.githubAction(next),
    denied = assert.rejects(inFlight, /Fork/);
  await readEntered.promise;
  f.store.journal.db
    .prepare('INSERT INTO session_fork VALUES(?,?,?,?)')
    .run('synthetic-fork', 'draft', 'synthetic-only', JSON.stringify({ phase: 'dispatched' }));
  readRelease.resolve();
  await denied;
  assert.equal(f.store.journal.has(next.operationId), false);
  assert.equal(f.store.github.get(f.fullScope()).revision, 0);
});

test('GitHub Host read refuses a context snapshot superseded while its remote detail was loading', async (t) => {
  const f = fixture(t),
    entered = signal(),
    release = signal();
  await f.host.githubAction(f.bind());
  f.beforeRequest = async (url) => {
    if (url.pathname.endsWith('/issues/1')) {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = f.read('issue', { number: 1 }),
    denied = assert.rejects(pending, /变化/);
  await entered.promise;
  await f.host.githubAction(f.unbind(1));
  release.resolve();
  await denied;
  assert.deepEqual(f.store.github.get(f.fullScope()), { revision: 2 });
});

test('GitHub Host shares cancellation across concurrent CI reads without follow-up requests or persistence', async (t) => {
  const f = fixture(t),
    controller = new AbortController(),
    entered = signal(),
    release = signal();
  f.signal = controller.signal;
  let reads = 0;
  f.beforeRequest = async (url) => {
    if (url.pathname.endsWith('/status') || url.pathname.endsWith('/check-runs')) {
      if (++reads === 2) entered.resolve();
      await release.promise;
    }
  };
  const pending = f.read('checks', { number: 2, headSha, page: 1 }),
    rejected = assert.rejects(pending, /取消|超时/);
  await entered.promise;
  const count = f.requests.length;
  controller.abort();
  await rejected;
  release.resolve();
  assert.equal(reads, 2);
  assert.equal(f.requests.length, count);
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM operation').get()!.n, 0);
});

test('GitHub Host hides an old repository binding after the project is authorized for another repository', async (t) => {
  const f = fixture(t),
    original = f.bind();
  await f.host.githubAction(original);
  const replacement = {
    ...repo,
    id: 99,
    owner: { login: 'replacement' },
    name: 'newrepo',
    full_name: 'replacement/newrepo',
  };
  f.config = {
    ...f.config!,
    owner: 'replacement',
    repo: 'newrepo',
    repositoryId: 99,
    version: hash('d'),
  };
  f.respond = (url) =>
    url.pathname === '/repos/replacement/newrepo'
      ? json(replacement)
      : url.pathname === '/repos/replacement/newrepo/issues/1'
        ? json(issueData)
        : undefined;
  const overview = await f.read('overview');
  assert.equal(overview.repository?.id, 99);
  assert.deepEqual(overview.binding, { revision: 1 });
  const detail = await f.read('issue', { number: 1, repositoryId: 99 });
  assert.equal(detail.repository?.id, 99);
  assert.deepEqual(detail.binding, { revision: 1 });
  assert.equal(f.store.github.get(f.fullScope()).context?.repository.id, 42);
  const calls = f.requests.length;
  const historical = await f.host.githubAction(original);
  assert.equal(historical.redacted, true);
  assert.deepEqual(historical.binding, { revision: 1 });
  assert.equal(f.requests.length, calls);
  const unbound = await f.host.githubAction(f.unbind(1));
  assert.deepEqual(unbound.binding, { revision: 2 });
});

test('GitHub Host abandoning an undelivered bind survives restart and prevents every late same-ID action', async (t) => {
  const f = fixture(t),
    request = f.bind({ expectedRevision: 7 });
  f.config = undefined;
  const receipt = await f.host.abandonGithub(request);
  assert.equal(receipt.abandoned, true);
  assert.equal(receipt.redacted, undefined);
  assert.deepEqual(receipt.binding, { revision: 7 });
  assert.deepEqual(f.store.github.get(f.fullScope()), { revision: 0 });
  assert.equal(f.store.journal.db.prepare('SELECT * FROM session_github').get(), undefined);
  const terminal = f.store.journal.db
    .prepare('SELECT * FROM operation WHERE id=?')
    .get(request.operationId)!;
  assert.equal(terminal.phase, 'github-abandoned');
  assert.equal(JSON.stringify(terminal).includes('synthetic-private-token'), false);
  assert.equal(JSON.stringify(terminal).includes('synthetic/test'), false);
  assert.equal(JSON.stringify(terminal).includes(issueData.body), false);
  assert.deepEqual(await f.host.githubAction(request), receipt);
  f.restart();
  assert.deepEqual(await f.host.abandonGithub(request), receipt);
  assert.deepEqual(await f.host.githubAction(request), receipt);
  assert.equal(f.requests.length, 0);
  assert.equal(f.agentStarts, 0);
  assert.equal(f.store.searchSource('draft'), undefined);
  assert.equal(f.store.nativeSession('draft'), undefined);
});

test('GitHub Host abandon confirms accepted bind or unbind without reversing it or reading revoked context', async (t) => {
  const f = fixture(t),
    bind = f.bind();
  const accepted = await f.host.githubAction(bind),
    calls = f.requests.length;
  f.config = undefined;
  const confirmed = await f.host.abandonGithub(bind);
  assert.equal(confirmed.redacted, true);
  assert.equal(confirmed.abandoned, undefined);
  assert.deepEqual(confirmed.binding, { revision: 1 });
  assert.deepEqual(f.store.github.get(f.fullScope()), accepted.binding);
  const unbind = f.unbind(1),
    removed = await f.host.githubAction(unbind);
  assert.deepEqual(await f.host.abandonGithub(unbind), removed);
  assert.deepEqual(f.store.github.get(f.fullScope()), { revision: 2 });
  assert.equal(f.requests.length, calls);
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM operation').get()!.n, 2);
});

test('GitHub Host abandoning an unexecuted unbind preserves the actual current binding', async (t) => {
  const f = fixture(t),
    accepted = await f.host.githubAction(f.bind()),
    request = f.unbind(1);
  const calls = f.requests.length;
  f.config = undefined;
  const cancelled = await f.host.abandonGithub(request);
  assert.equal(cancelled.abandoned, true);
  assert.deepEqual(cancelled.binding, { revision: 1 });
  assert.deepEqual(await f.host.githubAction(request), cancelled);
  assert.deepEqual(f.store.github.get(f.fullScope()), accepted.binding);
  assert.equal(f.requests.length, calls);
});

test('GitHub Host cancellation queued before delivery wins without any GitHub request', async (t) => {
  const f = fixture(t),
    entered = signal(),
    release = signal(),
    request = f.bind();
  const gate = f.host.serial('draft', async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const cancellation = f.host.abandonGithub(request),
    delivery = f.host.githubAction(request);
  release.resolve();
  await gate;
  const [cancelled, late] = await Promise.all([cancellation, delivery]);
  assert.equal(cancelled.abandoned, true);
  assert.deepEqual(late, cancelled);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.store.github.get(f.fullScope()), { revision: 0 });
});

test('GitHub Host cancellation waits for an in-flight bind and confirms its accepted or unexecuted outcome', async (t) => {
  for (const revoke of [false, true]) {
    const f = fixture(t),
      entered = signal(),
      release = signal(),
      request = f.bind();
    f.beforeRequest = async (url) => {
      if (url.pathname.endsWith('/branches/main')) {
        entered.resolve();
        await release.promise;
      }
    };
    const delivery = f.host.githubAction(request);
    const outcome = delivery.then(
      (receipt) => ({ receipt }),
      (error) => ({ error }),
    );
    await entered.promise;
    const cancellation = f.host.abandonGithub(request);
    if (revoke) f.config = undefined;
    release.resolve();
    const before = await outcome,
      after = await cancellation;
    if (revoke) {
      assert.ok('error' in before);
      assert.equal(after.abandoned, true);
      assert.deepEqual(f.store.github.get(f.fullScope()), { revision: 0 });
    } else {
      assert.ok('receipt' in before);
      assert.equal(after.redacted, true);
      assert.deepEqual(f.store.github.get(f.fullScope()), before.receipt.binding);
    }
    assert.deepEqual(await f.host.githubAction(request), after);
  }
});

test('GitHub Host tombstones reject changed fingerprints and foreign identities without overwriting the original', async (t) => {
  const f = fixture(t),
    request = f.bind(),
    cancelled = await f.host.abandonGithub(request);
  for (const wrong of [
    { ...request, branch: 'other' },
    { ...request, expectedRevision: 1 },
    { ...request, sessionId: 'other' },
    { ...request, localProjectId: 'other' },
  ]) {
    await assert.rejects(f.host.githubAction(wrong));
    await assert.rejects(f.host.abandonGithub(wrong));
  }
  await assert.rejects(f.host.abandonGithub(request, 'other'));
  f.store.workspace.userId = 'local:foreign';
  await assert.rejects(f.host.abandonGithub(request));
  f.store.workspace.userId = 'local:synthetic';
  assert.deepEqual(await f.host.abandonGithub(request), cancelled);
  assert.equal(f.requests.length, 0);
  assert.equal(f.store.journal.db.prepare('SELECT count(*) AS n FROM operation').get()!.n, 1);
});

test('GitHub Host failed cancellation rolls back scope reservation and leaves the original action safely pending', async (t) => {
  const f = fixture(t),
    request = f.bind();
  f.store.journal.db.exec(
    "CREATE TRIGGER fail_github_abandon BEFORE INSERT ON operation WHEN NEW.phase='github-abandoned' BEGIN SELECT RAISE(ABORT,'Synthetic cancellation failure'); END",
  );
  await assert.rejects(
    f.host.abandonGithub(request),
    (error) => error instanceof AppError && !error.rejected,
  );
  assert.equal(f.store.journal.has(request.operationId), false);
  assert.equal(
    f.store.journal.db.prepare('SELECT * FROM attachment_scope WHERE session_id=?').get('draft'),
    undefined,
  );
  assert.deepEqual(f.store.github.get(f.fullScope()), { revision: 0 });
  f.store.journal.db.exec('DROP TRIGGER fail_github_abandon');
  assert.equal((await f.host.abandonGithub(request)).abandoned, true);
  assert.equal((await f.host.githubAction(request)).abandoned, true);
  assert.equal(f.requests.length, 0);
});
