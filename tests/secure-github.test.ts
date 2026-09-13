import test from 'node:test';
import assert from 'node:assert/strict';
import { readSecureGithubExecutionBlock } from '../src/web/secure-github';
import type { GithubWriteDraft } from '../src/web/github-write';
import { githubWriteKey } from '../src/web/github-write';
import { secureGitTarget } from '../src/web/secure-scoped-storage';
import { fixture, target, head, base, version, signal } from './support/secure-github-fixture';
const current = () => {};
const writes = (f: ReturnType<typeof fixture>) =>
  f.calls.filter((call) => call.method === 'github-write-action');
const common = { number: 2, headSha: head, baseSha: base, expectedVersion: version };
async function comment(f: ReturnType<typeof fixture>, body = 'Manual comment') {
  const c = f.controller;
  await c.open(target, 'write');
  return c.createDraft(c.state!.review, 'issue-comment', { ...common, subject: 'pull', body });
}

test('complete finite read, bind, unbind and explicitly reviewed context append never execute Agent or persist provider content', async () => {
  const f = fixture(),
    c = f.controller;
  await c.open(target);
  await c.branches(c.state!.review, 1);
  await c.branches(c.state!.review, 2);
  await c.list(c.state!.review, 'pulls', 'all', 1);
  await c.item(c.state!.review, 'pull', 2);
  await c.comments(c.state!.review, 2);
  await c.checks(c.state!.review, 2);
  const displayed = c.state!;
  assert.equal(displayed.read.detail!.item.body, f.item.body);
  assert.equal(f.memory.values.size, 0);
  await c.add(displayed.review);
  assert.match(f.state.appended, /Unsent local draft/);
  assert.ok(f.state.appended.includes(f.item.body));
  await c.bind(c.state!.review, 'topic');
  assert.equal(c.state!.read.binding!.revision, 1);
  await c.unbind(c.state!.review);
  assert.equal(c.state!.read.binding!.revision, 2);
  assert.equal(f.state.beforeWriteCount, 2);
  assert.doesNotMatch(
    JSON.stringify([...f.memory.values]),
    /Synthetic provider body|Synthetic private PR title|Synthetic remote thread/,
  );
  assert.ok(
    f.calls.every(
      (call) =>
        !call.method.includes('/') && JSON.stringify(call.target) === JSON.stringify(target),
    ),
  );
  assert.equal(writes(f).length, 0);
});

test('all nine write actions require a saved manual draft, current review and explicit original-operation confirmation', async () => {
  const f = fixture(),
    c = f.controller;
  await c.open(target, 'write');
  const drafts: [GithubWriteDraft['kind'], GithubWriteDraft['values']][] = [
    ['issue-comment', { ...common, subject: 'pull', body: 'Manual comment' }],
    [
      'review-comment',
      {
        ...common,
        filePage: 1,
        path: 'README.md',
        fileVersion: version,
        side: 'RIGHT',
        line: 2,
        body: 'Manual line comment',
      },
    ],
    [
      'review-reply',
      { ...common, commentId: 71, commentPage: 1, commentVersion: version, body: 'Manual reply' },
    ],
    [
      'pr-create',
      {
        headBranch: 'topic',
        baseBranch: 'main',
        headSha: head,
        baseSha: base,
        headPage: 1,
        basePage: 1,
        title: 'Manual PR',
        body: 'Manual PR body',
        draft: true,
      },
    ],
    ['pr-update', { ...common, title: 'Manual title', body: 'Manual updated body' }],
    ['pr-state', { ...common, state: 'closed' }],
    ['pr-merge', { ...common, method: 'squash' }],
    [
      'commit',
      {
        paths: ['README.md'],
        message: 'Manual commit',
        authorName: 'Synthetic',
        authorEmail: 'synthetic@example.invalid',
      },
    ],
    ['push', { branch: 'topic', headOid: head, expectedRemoteOid: base }],
  ];
  for (const [kind, values] of drafts) {
    if (!c.state!.write.overview) await c.refresh(c.state!.review);
    const before = writes(f).length,
      id = await c.createDraft(c.state!.review, kind, values);
    await c.prepare(c.state!.review, id);
    const reviewed = c.state!;
    assert.equal(reviewed.write.review!.request.action, kind);
    assert.equal(writes(f).length, before);
    await c.confirm(reviewed.review);
    assert.equal(c.state!.write.receipt!.phase, 'accepted');
    assert.equal(c.state!.write.pending, undefined);
    assert.deepEqual(writes(f).at(-1)!.params, reviewed.write.review!.request);
  }
  assert.equal(writes(f).length, 9);
  assert.equal(f.state.beforeWriteCount, 9);
  assert.doesNotMatch(
    JSON.stringify([...f.memory.values]),
    /Synthetic provider body|Synthetic private PR title|Synthetic remote thread/,
  );
});

test('lost receipts reload without replay, original mapping recovery never adopts a new target, body or id', async () => {
  const f = fixture(),
    c = f.controller,
    id = await comment(f);
  await c.prepare(c.state!.review, id);
  const original = structuredClone(c.state!.write.review!.request);
  f.state.lost = true;
  await assert.rejects(c.confirm(c.state!.review), /lost receipt/);
  c.close();
  f.state.context.target = {
    ...target,
    product: { ...target.product!, replicaId: 'new-replica', revision: 2 },
  };
  f.state.context.generation++;
  const before = f.calls.length;
  await c.open(f.state.context.target!, 'recovery');
  assert.equal(f.calls.length, before);
  assert.equal(c.state!.write.pending, undefined);
  assert.deepEqual(c.state!.recoveries[0].pending!.request, original);
  f.state.lost = false;
  f.state.phase = 'unknown';
  const recovery = c.state!.recoveries[0];
  await c.recover(c.state!.review, recovery.id, 'inspect', 2);
  assert.deepEqual(f.calls.at(-1), {
    target,
    method: 'github-write-inspect',
    params: { request: original, page: 2 },
  });
  assert.ok(c.state!.recoveries[0].pending);
  f.state.released = true;
  await c.recover(c.state!.review, recovery.id, 'abandon');
  assert.deepEqual(f.calls.at(-1), {
    target,
    method: 'github-write-abandon',
    params: { request: original },
  });
  assert.equal(c.state!.recoveries[0].pending, undefined);
  assert.equal(c.state!.recoveries[0].drafts![id].values.body, 'Manual comment');
  assert.equal(writes(f).length, 1);
  assert.equal(f.state.beforeWriteCount, 1, 'recovery is not blocked by a pending turn');
});

test('old binding only exposes exact original abandon; it cannot execute a first bind through inspect', async () => {
  const f = fixture(),
    c = f.controller;
  await c.open(target);
  await c.branches(c.state!.review, 1);
  f.state.lost = true;
  await assert.rejects(c.bind(c.state!.review, 'topic'), /lost receipt/);
  const original = structuredClone(c.state!.read.pending!.request);
  assert.match((await readSecureGithubExecutionBlock(f.storage, target, current))!, /绑定待确认/);
  c.close();
  f.state.context.target = { ...target, product: { ...target.product!, revision: 2 } };
  f.state.context.generation++;
  await c.open(f.state.context.target, 'recovery');
  const id = c.state!.recoveries[0].id;
  await assert.rejects(c.recover(c.state!.review, id, 'inspect'), /只能封存/);
  f.state.lost = false;
  await c.recover(c.state!.review, id, 'abandon');
  assert.deepEqual(f.calls.at(-1), { target, method: 'github-abandon', params: original });
  assert.equal(f.calls.filter((call) => call.method === 'github-action').length, 1);
  assert.equal(
    await readSecureGithubExecutionBlock(f.storage, f.state.context.target!, current),
    null,
  );
});

test('persisted commit or push blocks ordinary send across unopened panels and changed product mappings until manual recovery', async () => {
  const f = fixture(),
    c = f.controller;
  await c.open(target, 'write');
  const id = await c.createDraft(c.state!.review, 'commit', {
    paths: ['README.md'],
    message: 'Manual commit',
    authorName: 'Synthetic',
    authorEmail: 'a@example.invalid',
  });
  await c.prepare(c.state!.review, id);
  f.state.lost = true;
  await assert.rejects(c.confirm(c.state!.review), /lost receipt/);
  c.close();
  const moved = { ...target, product: { ...target.product!, revision: 3 } };
  assert.match((await readSecureGithubExecutionBlock(f.storage, moved, current))!, /待确认/);
  f.state.context.target = moved;
  f.state.context.generation++;
  await c.open(moved, 'recovery');
  f.state.lost = false;
  f.state.phase = 'unknown';
  f.state.released = true;
  await c.recover(c.state!.review, c.state!.recoveries[0].id, 'abandon');
  assert.equal(await readSecureGithubExecutionBlock(f.storage, moved, current), null);
});

test('render snapshots cannot bind, quote, choose a patch or confirm a newer unreviewed value', async () => {
  const f = fixture(),
    c = f.controller;
  await c.open(target);
  await c.item(c.state!.review, 'pull', 2);
  const read = c.state!;
  f.item.body = 'New provider body';
  f.item.version = 'sha256:' + 'd'.repeat(64);
  await c.item(c.state!.review, 'pull', 2);
  await assert.rejects(c.add(read.review), /已改变/);
  await assert.rejects(c.bind(read.review, 'topic'), /已改变/);
  assert.notEqual(read.read.detail!.item.body, c.state!.read.detail!.item.body);
  await c.show(c.state!.review, 'write');
  await c.pull(c.state!.review, 'files', 1);
  const patch = c.state!;
  f.file.patch = '@@ -1 +1 @@\n-old\n+newer';
  await c.pull(c.state!.review, 'files', 2);
  await assert.rejects(
    c.createDraft(patch.review, 'review-comment', {
      ...common,
      filePage: 1,
      fileVersion: version,
      path: 'README.md',
      side: 'RIGHT',
      line: 2,
      body: 'Unseen',
    }),
    /已改变/,
  );
  const id = await c.createDraft(c.state!.review, 'issue-comment', {
    number: 2,
    subject: 'pull',
    body: 'Original manual body',
  });
  await c.prepare(c.state!.review, id);
  const reviewed = c.state!;
  await c.saveDraft(reviewed.review, reviewed.write.drafts[id], {
    ...reviewed.write.drafts[id],
    values: { ...reviewed.write.drafts[id].values, body: 'New manual body' },
  });
  await c.prepare(c.state!.review, id);
  await assert.rejects(c.confirm(reviewed.review), /已改变/);
  assert.equal(writes(f).length, 0);
});

test('closing during beforeWrite or pending CAS cancels dispatch, and late receipt leaves the exact durable pending operation', async () => {
  for (const phase of ['beforeWrite', 'CAS', 'receipt'] as const) {
    const f = fixture(),
      c = f.controller,
      id = await comment(f),
      entered = signal(),
      release = signal();
    await c.prepare(c.state!.review, id);
    const wait = async () => {
      entered.resolve();
      await release.promise;
    };
    if (phase === 'beforeWrite') f.state.beforeWrite = wait;
    if (phase === 'CAS') f.memory.beforeWrite = wait;
    if (phase === 'receipt')
      f.state.beforeResponse = async (method) => {
        if (method === 'github-write-action') await wait();
      };
    const operation = c.confirm(c.state!.review),
      rejected = assert.rejects(operation, /已改变|已变化/);
    await entered.promise;
    c.close();
    release.resolve();
    await rejected;
    assert.equal(c.state, null);
    assert.equal(writes(f).length, phase === 'receipt' ? 1 : 0);
    const row = (await f.storage
      .forTarget(target, current)
      .read(githubWriteKey(secureGitTarget(target)))) as any;
    assert.equal(!!row.pending, phase === 'receipt');
  }
});

const changes: [string, (t: typeof target) => void][] = [
  [
    'origin',
    (t) => {
      t.origin = 'https://other.synthetic.invalid';
    },
  ],
  [
    'owner',
    (t) => {
      t.owner = 'other';
    },
  ],
  [
    'root',
    (t) => {
      t.rootKeyId = 'B'.repeat(43);
    },
  ],
  [
    'client',
    (t) => {
      t.clientDeviceId = 'other';
    },
  ],
  [
    'host',
    (t) => {
      t.hostDeviceId = 'other';
    },
  ],
  [
    'workspace',
    (t) => {
      t.workspaceId = 'other';
    },
  ],
  [
    'localProject',
    (t) => {
      t.localProjectId = 'other';
    },
  ],
  [
    'user',
    (t) => {
      t.userId = 'other';
    },
  ],
  [
    'machine',
    (t) => {
      t.machineId = 'other';
    },
  ],
  [
    'session',
    (t) => {
      t.sessionId = 'other';
    },
  ],
  [
    'catalog',
    (t) => {
      t.product!.catalogWorkspaceId = 'other';
    },
  ],
  [
    'project',
    (t) => {
      t.product!.projectId = 'other';
    },
  ],
  [
    'replica',
    (t) => {
      t.product!.replicaId = 'other';
    },
  ],
  [
    'revision',
    (t) => {
      t.product!.revision++;
    },
  ],
];
for (const [name, mutate] of changes)
  test(`full ${name} identity change hides content before sync and rejects old confirmation`, async () => {
    const f = fixture(),
      c = f.controller,
      id = await comment(f);
    await c.prepare(c.state!.review, id);
    const review = c.state!.review;
    mutate(f.state.context.target!);
    assert.equal(c.state, null);
    await assert.rejects(c.confirm(review), /已改变/);
    assert.equal(writes(f).length, 0);
  });

test('connection ABA cancels late reads; offline restart restores editable original drafts with no RPC or auto publish', async () => {
  const f = fixture(),
    c = f.controller,
    id = await comment(f);
  c.close();
  f.state.context.online = false;
  f.state.context.generation++;
  const before = f.calls.length;
  await c.open(target, 'write');
  const view = c.state!,
    draft = view.write.drafts[id];
  await Promise.all(
    ['one', 'two', 'three'].map((body) =>
      c.saveDraft(view.review, draft, { ...draft, values: { ...draft.values, body } }),
    ),
  );
  assert.equal(c.state!.write.drafts[id].values.body, 'three');
  assert.equal(f.calls.length, before);
  await assert.rejects(
    c.saveDraft(c.state!.review, c.state!.write.drafts[id], {
      ...draft,
      values: { ...draft.values, number: 99 },
    }),
    /草稿目标/,
  );
  c.close();
  f.state.context.online = true;
  f.state.context.generation++;
  await c.open(target);
  const entered = signal(),
    release = signal();
  f.state.beforeResponse = async () => {
    entered.resolve();
    await release.promise;
  };
  const read = c.item(c.state!.review, 'pull', 2),
    rejected = assert.rejects(read, /已改变/);
  await entered.promise;
  f.state.context.online = false;
  f.state.context.generation++;
  f.state.context.online = true;
  f.state.context.generation++;
  assert.equal(c.state, null);
  release.resolve();
  await rejected;
  assert.equal(writes(f).length, 0);
});

test('two pages serialize final execution; competing stale saved drafts cannot publish, and receipt recovery never replays', async () => {
  const f = fixture(),
    a = f.controller,
    id = await comment(f),
    b = f.create();
  await b.open(target, 'write');
  await a.prepare(a.state!.review, id);
  await b.prepare(b.state!.review, id);
  const entered = signal(),
    release = signal(),
    queued = signal();
  f.state.beforeResponse = async (method) => {
    if (method === 'github-write-action') {
      entered.resolve();
      await release.promise;
    }
  };
  const first = a.confirm(a.state!.review);
  await entered.promise;
  f.memory.queued = (key) => {
    if (key.includes('"execution"')) queued.resolve();
  };
  const second = b.confirm(b.state!.review),
    rejected = assert.rejects(second, /其他页面更新/);
  await queued.promise;
  assert.equal(writes(f).length, 1);
  release.resolve();
  await first;
  await rejected;
  assert.equal(writes(f).length, 1);
});

test('Git branch names that resemble object properties remain exact frozen data', async () => {
  const f = fixture(),
    c = f.controller;
  f.branches.push({ name: '__proto__', sha: head, protected: false });
  await c.open(target);
  await c.branches(c.state!.review, 1);
  assert.deepEqual(c.state!.read.branch('__proto__'), {
    name: '__proto__',
    sha: head,
    protected: false,
  });
  assert.equal(c.state!.read.branch('constructor'), undefined);
  await c.bind(c.state!.review, '__proto__');
  assert.equal(c.state!.read.binding!.context!.branch, '__proto__');
});

test('late quote append cannot write after close, and provider version change requires another explicit review', async () => {
  const f = fixture(),
    c = f.controller;
  await c.open(target);
  await c.item(c.state!.review, 'pull', 2);
  const before = f.state.appended;
  f.item.version = 'sha256:' + 'f'.repeat(64);
  f.item.body = 'Newer provider version';
  await assert.rejects(c.add(c.state!.review), /已经更新/);
  assert.equal(f.state.appended, before);
  await c.refresh(c.state!.review);
  await c.item(c.state!.review, 'pull', 2);
  const entered = signal(),
    release = signal();
  f.state.beforeAppend = async () => {
    entered.resolve();
    await release.promise;
  };
  const append = c.add(c.state!.review),
    rejected = assert.rejects(append, /已改变/);
  await entered.promise;
  c.close();
  release.resolve();
  await rejected;
  assert.equal(f.state.appended, before);
});

test('a corrupt persisted write record cannot be treated as permission to send', async () => {
  const f = fixture();
  const row = {
    version: 1,
    cacheRevision: 1,
    target: secureGitTarget(target),
    drafts: { wrong: { id: 'different', kind: 'commit', values: {} } },
  };
  await f.storage
    .forTarget(target, current)
    .compareWrite(githubWriteKey(secureGitTarget(target)), 0, row, () => true);
  await assert.rejects(readSecureGithubExecutionBlock(f.storage, target, current), /草稿编号/);
  assert.equal(f.calls.length, 0);
});

test('an original binding retry and competing seal are serialized across pages using the original operation', async () => {
  const f = fixture(),
    a = f.controller;
  await a.open(target);
  await a.branches(a.state!.review, 1);
  f.state.lost = true;
  await assert.rejects(a.bind(a.state!.review, 'topic'), /lost/);
  const original = structuredClone(a.state!.read.pending!.request),
    b = f.create();
  await b.open(target);
  f.state.lost = false;
  const entered = signal(),
    release = signal(),
    queued = signal();
  f.state.beforeResponse = async (method) => {
    if (method === 'github-action') {
      entered.resolve();
      await release.promise;
    }
  };
  const retry = a.retryBinding(a.state!.review);
  await entered.promise;
  f.memory.queued = (key) => {
    if (key.includes('"execution"')) queued.resolve();
  };
  const seal = b.abandonBinding(b.state!.review),
    rejected = assert.rejects(seal, /其他页面更新/);
  await queued.promise;
  assert.equal(f.calls.filter((call) => call.method === 'github-abandon').length, 0);
  release.resolve();
  await retry;
  await rejected;
  assert.deepEqual(
    f.calls.filter((call) => call.method === 'github-action').map((call) => call.params),
    [original, original],
  );
});

test('a fresh Host observation timestamp permits quoting, but reused item versions cannot hide changed content', async () => {
  const f = fixture(),
    c = f.controller;
  await c.open(target);
  await c.item(c.state!.review, 'pull', 2);
  const original = c.state!.read.detail!;
  f.state.readAt = '2026-09-13T00:00:01Z';
  await c.add(c.state!.review);
  assert.ok(f.state.appended.includes(original.item.body));
  assert.notEqual(c.state!.read.detail!.readAt, original.readAt);
  const appended = f.state.appended,
    priorVersion = f.item.version;
  f.state.readAt = '2026-09-13T00:00:02Z';
  f.item.body = 'Different unreviewed body despite an unchanged provider version';
  assert.equal(f.item.version, priorVersion);
  await assert.rejects(c.add(c.state!.review), /正文已改变/);
  assert.equal(f.state.appended, appended);
});

test('closing an initializing panel cannot clear the next panel initialization guard when the old load settles', async () => {
  const f = fixture(),
    c = f.controller,
    firstRead = signal(),
    firstRelease = signal(),
    secondRead = signal(),
    secondRelease = signal();
  let count = 0;
  f.memory.beforeRead = async () => {
    if (++count === 1) {
      firstRead.resolve();
      await firstRelease.promise;
    } else if (count === 3) {
      secondRead.resolve();
      await secondRelease.promise;
    }
  };
  const first = c.open(target),
    rejected = assert.rejects(first, /已改变/);
  await firstRead.promise;
  c.close();
  const second = c.open(target);
  await secondRead.promise;
  assert.equal(c.state!.opening, true);
  firstRelease.resolve();
  await rejected;
  assert.equal(c.state!.opening, true);
  assert.equal(c.state!.read.busy, true);
  await assert.rejects(c.show(c.state!.review, 'write'), /正在保存或核对/);
  secondRelease.resolve();
  await second;
  assert.equal(c.state!.opening, false);
  await c.show(c.state!.review, 'write');
  assert.equal(c.state!.mode, 'write');
});
