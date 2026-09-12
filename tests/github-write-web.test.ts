import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GithubWriteController,
  githubWriteKey,
  githubWriteRequestVersion,
  type GithubWriteTarget,
} from '../src/web/github-write';
import type { GithubWriteAction, GithubWriteReceipt } from '../src/github-write-protocol';
const target: GithubWriteTarget = {
  owner: 'owner',
  deviceId: 'device',
  userId: 'user',
  machineId: 'machine',
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'session',
  catalogWorkspaceId: 'catalog',
  replicaId: 'replica',
};
const version = 'sha256:' + 'a'.repeat(64),
  head = 'b'.repeat(40),
  base = 'c'.repeat(40),
  date = '2026-09-12T00:00:00Z';
const repository = {
  id: 42,
  owner: 'example',
  name: 'private',
  private: true,
  defaultBranch: 'main',
  url: 'https://github.com/example/private',
};
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { resolve, promise };
}
function fixture() {
  const cache = new Map<string, any>(),
    calls: { path: string; body: any }[] = [];
  let counter = 0;
  const controls = {
    online: true,
    repositoryId: 42,
    writes: true,
    phase: 'accepted' as GithubWriteReceipt['phase'],
    released: false,
    wrong: false,
    failWrite: false,
    lost: false,
    wait: undefined as undefined | (() => Promise<void>),
  };
  const item = {
    id: 99,
    number: 2,
    title: 'Private PR title',
    state: 'open',
    author: 'synthetic',
    url: repository.url + '/pull/2',
    updatedAt: date,
    body: 'Private remote body',
    bodyTruncated: false,
    labels: [],
    version,
    kind: 'pull',
    head: {
      sha: head,
      branch: 'topic',
      repository: { id: 43, owner: 'contributor', name: 'fork' },
    },
    base: { sha: base, branch: 'main', repository: { id: 42, owner: 'example', name: 'private' } },
    mergeable: null,
  };
  const git = {
    kind: 'git',
    branch: 'topic',
    headOid: head,
    branches: [{ name: 'topic', oid: head }],
    changes: [{ path: 'README.md', index: ' ', worktree: 'M' }],
    dirty: true,
    partial: false,
    outsideProjectChanges: false,
    version,
    issues: [],
    writeSupported: true,
  };
  const file = {
    path: 'README.md',
    sha: head,
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: '@@ -1,2 +1,2 @@\n kept\n-old\n+new',
    patchTruncated: false,
    version,
  };
  const comment = {
    id: 71,
    author: 'reviewer',
    body: 'Remote thread',
    bodyTruncated: false,
    url: repository.url + '/pull/2#discussion_r71',
    updatedAt: date,
    path: 'README.md',
    commitSha: head,
    originalCommitSha: head,
    side: 'RIGHT',
    line: 2,
    originalLine: 2,
    version,
  };
  const create = (t = target, current = () => true) =>
    new GithubWriteController(t, {
      read: async (key) => structuredClone(cache.get(key)),
      compareWrite: async (key, revision, value, guard) => {
        if (!guard()) throw new Error('scope changed');
        if (controls.failWrite) throw new Error('storage failed');
        if ((cache.get(key)?.cacheRevision ?? 0) !== revision) return false;
        cache.set(key, structuredClone(value));
        return true;
      },
      current,
      online: () => controls.online,
      changed() {},
      uuid: () => `operation-${++counter}`,
      request: async (path, body) => {
        calls.push({ path, body: structuredClone(body) });
        const r = body as any;
        const scope = {
          workspaceId: t.workspaceId,
          localProjectId: t.localProjectId,
          sessionId: t.sessionId,
          confirmed: true,
        };
        if (path.endsWith('/github/read'))
          return {
            ...scope,
            githubVersion: 1,
            view: 'pull',
            readAt: date,
            repository,
            configVersion: version,
            binding: { revision: 0 },
            item,
          };
        if (path.endsWith('/read')) {
          const common = { ...scope, githubWriteVersion: 1, view: r.view, readAt: date };
          if (r.view === 'overview')
            return {
              ...common,
              repository: { ...repository, id: controls.repositoryId },
              configVersion: version,
              writesEnabled: controls.writes,
              bindingRevision: 0,
              git,
              execution: { mode: 'shared', status: 'ready', revision: 0 },
              canCommit: true,
            };
          if (r.view === 'commit-preview')
            return {
              ...common,
              candidateVersion: version,
              branch: 'topic',
              parentOid: head,
              indexVersion: version,
              files: r.paths.map((path: string) => ({
                path,
                kind: 'modify',
                version,
                byteLength: 3,
                mode: '100644',
                beforeText: 'old',
                afterText: 'new',
                binary: false,
                truncated: false,
              })),
              execution: { mode: 'shared', status: 'ready', revision: 0 },
            };
          const remote = {
            ...common,
            repository,
            configVersion: version,
            writesEnabled: controls.writes,
            bindingRevision: 0,
          };
          if (r.view === 'branches')
            return {
              ...remote,
              result: {
                page: r.page,
                hasNext: false,
                partial: false,
                items: [
                  { name: 'topic', sha: head, protected: false },
                  { name: 'main', sha: base, protected: true },
                ],
              },
            };
          if (r.view === 'push-preview')
            return {
              ...remote,
              branch: r.branch,
              headOid: r.headOid,
              expectedRemoteOid: base,
              canPush: true,
              execution: { mode: 'shared', status: 'ready', revision: 0 },
            };
          return {
            ...remote,
            number: r.number,
            headSha: r.headSha,
            baseSha: r.baseSha,
            result: {
              page: r.page,
              hasNext: false,
              partial: false,
              items: r.view === 'files' ? [file] : [comment],
            },
          };
        }
        const action: GithubWriteAction = r.request ?? r;
        assert.deepEqual(cache.get(githubWriteKey(t)).pending.request, action);
        await controls.wait?.();
        if (controls.lost) throw new Error('network lost');
        return {
          ...scope,
          githubWriteVersion: 1,
          operationId: action.operationId,
          action: action.action,
          requestVersion: controls.wrong
            ? 'sha256:' + 'd'.repeat(64)
            : await githubWriteRequestVersion(action),
          phase: controls.phase,
          confirmed: controls.phase === 'accepted',
          ...(controls.phase === 'accepted'
            ? {
                result:
                  action.action === 'commit' || action.action === 'push'
                    ? { sha: head }
                    : action.action === 'pr-merge'
                      ? { number: action.number }
                      : { id: 901, number: 'number' in action ? action.number : 3 },
              }
            : {}),
          ...(controls.released ? { released: true } : {}),
          message: 'Synthetic outcome',
          checkedAt: date,
        };
      },
    });
  return { create, cache, calls, controls, item, file, comment };
}
test('write drafts and review are durable but never execute until confirmation; unknown only inspects the original request', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  await c.openDetail('pull', 2);
  assert.equal(f.cache.size, 0);
  const id = await c.createDraft('issue-comment', {
    subject: 'pull',
    number: 2,
    expectedVersion: version,
    body: 'My manually authored comment',
  });
  assert.doesNotMatch(
    JSON.stringify([...f.cache.values()]),
    /Private remote body|Private PR title/,
  );
  await c.prepare(id);
  assert.equal(f.calls.filter((v) => !v.path.endsWith('/read')).length, 0);
  const original = structuredClone(c.review!.request);
  f.controls.lost = true;
  await assert.rejects(c.confirm(), /network lost/);
  assert.deepEqual(c.pending!.request, original);
  const count = f.calls.length,
    moved = f.create({ ...target, catalogWorkspaceId: 'moved', replicaId: 'new-route' });
  await moved.load();
  assert.equal(f.calls.length, count);
  assert.equal(moved.blocksExecution, false);
  f.controls.lost = false;
  f.controls.phase = 'unknown';
  await moved.inspect(2);
  assert.deepEqual(f.calls.at(-1)!.body, { request: original, page: 2 });
  assert.match(f.calls.at(-1)!.path, /moved\/replicas\/new-route\/github-write\/inspect/);
  assert.ok(moved.pending);
  f.controls.wrong = true;
  await assert.rejects(moved.inspect(), /匹配的主机确认/);
  assert.ok(moved.pending);
  f.controls.wrong = false;
  f.controls.released = true;
  await moved.abandon();
  assert.equal(moved.pending, undefined);
  assert.match(moved.error, /不表示远端操作已取消/);
  assert.equal(f.calls.filter((v) => v.path.endsWith('/action')).length, 1);
  assert.equal(moved.drafts[id].values.body, 'My manually authored comment');
});
test('comment targets use actual complete patch lines and exact review threads, and changed heads cannot silently retarget drafts', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  await c.openDetail('pull', 2);
  await c.loadPull('files');
  const common = { number: 2, headSha: head, baseSha: base, body: 'Comment' };
  const id = await c.createDraft('review-comment', {
    ...common,
    path: f.file.path,
    fileVersion: version,
    filePage: 1,
    side: 'RIGHT',
    line: 2,
  });
  await c.prepare(id);
  assert.equal(c.review!.request.action, 'review-comment');
  await c.confirm();
  assert.equal(c.pending, undefined);
  const wrong = await c.createDraft('review-comment', {
    ...common,
    path: f.file.path,
    fileVersion: version,
    filePage: 1,
    side: 'RIGHT',
    line: 90,
  });
  await assert.rejects(c.prepare(wrong), /所选评论行/);
  f.file.patchTruncated = true;
  await assert.rejects(c.prepare(id), /所选评论行/);
  f.file.patchTruncated = false;
  await c.refresh();
  const reply = await c.createDraft('review-reply', {
    ...common,
    commentId: 71,
    commentVersion: version,
    commentPage: 1,
  });
  await c.prepare(reply);
  assert.equal(c.review!.request.action, 'review-reply');
  f.item.head.sha = 'e'.repeat(40);
  await assert.rejects(c.prepare(reply), /提交已变化/);
  assert.equal(f.calls.filter((v) => v.path.endsWith('/action')).length, 1);
});
test('all PR operations show concrete reviewed values and only final confirmation stages external writes', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  await c.loadBranches();
  const inputs: [any, any][] = [
    [
      'pr-create',
      {
        headBranch: 'topic',
        baseBranch: 'main',
        headSha: head,
        baseSha: base,
        headPage: 1,
        basePage: 1,
        title: 'New PR',
        body: 'Manual PR body',
        draft: true,
      },
    ],
    [
      'pr-update',
      {
        number: 2,
        headSha: head,
        expectedVersion: version,
        title: 'Updated PR',
        body: 'Updated body',
      },
    ],
    ['pr-state', { number: 2, headSha: head, expectedVersion: version, state: 'closed' }],
    ['pr-merge', { number: 2, headSha: head, expectedVersion: version, method: 'squash' }],
  ];
  for (const [kind, values] of inputs) {
    const id = await c.createDraft(kind, values),
      before = f.calls.filter((v) => v.path.endsWith('/action')).length;
    await c.prepare(id);
    assert.equal(f.calls.filter((v) => v.path.endsWith('/action')).length, before);
    assert.equal(c.review!.request.action, kind);
    await c.confirm();
    assert.equal(c.receipt?.phase, 'accepted');
  }
  assert.equal(f.calls.filter((v) => v.path.endsWith('/action')).length, 4);
  f.controls.writes = false;
  const id = await c.createDraft('pr-state', {
    number: 2,
    headSha: head,
    expectedVersion: version,
    state: 'open',
  });
  await assert.rejects(c.prepare(id), /外部写入/);
  assert.equal(f.calls.filter((v) => v.path.endsWith('/action')).length, 4);
});
test('local commits need no GitHub permission; unknown commit blocks execution, while push pins the reviewed remote OID', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  f.controls.writes = false;
  const id = await c.createDraft('commit', {
    paths: ['README.md'],
    message: 'test: synthetic commit',
    authorName: 'Synthetic',
    authorEmail: 'synthetic@example.invalid',
  });
  await c.prepare(id);
  assert.equal(c.review!.request.action, 'commit');
  assert.deepEqual(c.review!.request.action === 'commit' && c.review!.request.paths, ['README.md']);
  f.controls.phase = 'unknown';
  await c.confirm();
  assert.equal(c.blocksExecution, true);
  const restored = f.create();
  await restored.load();
  assert.equal(restored.blocksExecution, true);
  await restored.refresh();
  await restored.previewCommit(['README.md']);
  await restored.previewPush();
  assert.ok(restored.overview && restored.commitPreview && restored.pushPreview);
  const callsBeforeInspect = f.calls.length;
  f.controls.phase = 'accepted';
  await restored.inspect();
  assert.equal(restored.blocksExecution, false);
  assert.equal(restored.overview, undefined);
  assert.equal(restored.commitPreview, undefined);
  assert.equal(restored.pushPreview, undefined);
  assert.deepEqual(
    f.calls.slice(callsBeforeInspect).map((call) => call.path.split('/').at(-1)),
    ['inspect'],
  );
  f.controls.writes = true;
  await restored.refresh();
  await restored.previewPush();
  const push = await restored.createDraft('push', {
    branch: 'topic',
    headOid: head,
    expectedRemoteOid: base,
  });
  await restored.prepare(push);
  assert.ok(restored.pushPreview);
  await restored.confirm();
  assert.equal(restored.pushPreview, undefined);
  const request = f.calls.filter((v) => v.path.endsWith('/action')).at(-1)!.body;
  assert.equal(request.action, 'push');
  assert.equal(request.headOid, head);
  assert.equal(request.expectedRemoteOid, base);
});
test('CAS conflict and failed persistence prevent dispatch, stale confirmations cannot clear an existing outbox', async () => {
  const f = fixture(),
    a = f.create(),
    b = f.create();
  await a.load();
  await b.load();
  await a.createDraft('commit', {
    paths: ['README.md'],
    message: 'a',
    authorName: 'Synthetic',
    authorEmail: 'synthetic@example.invalid',
  });
  await assert.rejects(b.createDraft('commit', { paths: ['README.md'], message: 'b' }), /其他页面/);
  assert.equal(b.blocksExecution, true);
  const c = f.create();
  await c.load();
  const id = Object.keys(c.drafts)[0];
  await c.prepare(id);
  f.controls.failWrite = true;
  await assert.rejects(c.confirm(), /storage failed/);
  assert.equal(f.calls.filter((v) => v.path.endsWith('/action')).length, 0);
  f.controls.failWrite = false;
  let current = true;
  const d = f.create(target, () => current);
  await d.load();
  await d.prepare(id);
  const entered = signal(),
    release = signal();
  f.controls.wait = async () => {
    entered.resolve();
    await release.promise;
  };
  const action = d.confirm();
  await entered.promise;
  current = false;
  release.resolve();
  await assert.rejects(action, /目标已变化/);
  const reload = f.create();
  await reload.load();
  assert.ok(reload.pending);
  assert.equal(reload.receipt, undefined);
});

test('a refreshed repository change clears provider content without adopting existing hand-authored drafts', async () => {
  const f = fixture(),
    c = f.create();
  await c.load();
  await c.refresh();
  await c.openDetail('pull', 2);
  await c.loadPull('files');
  const id = await c.createDraft('issue-comment', {
    subject: 'pull',
    number: 2,
    expectedVersion: version,
    body: 'Keep my authored draft',
  });
  f.controls.repositoryId = 43;
  await c.refresh();
  assert.equal(c.detail, undefined);
  assert.equal(c.files, undefined);
  assert.equal(c.drafts[id].values.repositoryId, 42);
  assert.equal(c.drafts[id].values.body, 'Keep my authored draft');
  await assert.rejects(c.prepare(id), /草稿的 GitHub 仓库已变化/);
  assert.equal(f.calls.filter((v) => v.path.endsWith('/action')).length, 0);
});
