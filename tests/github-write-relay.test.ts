import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { PROTOCOL } from '../src/protocol';
import { GITHUB_WRITE_FEATURE, githubWriteActionSchema } from '../src/github-write-protocol';
import type { Workspace } from '../src/catalog';
import { syntheticRelay } from './support/synthetic-relay';

const version = 'sha256:' + 'a'.repeat(64),
  headSha = 'b'.repeat(40),
  baseSha = 'c'.repeat(40),
  at = '2026-09-12T00:00:00Z';
const repository = {
  id: 123,
  owner: 'synthetic',
  name: 'project',
  defaultBranch: 'main',
  private: true,
  url: 'https://github.com/synthetic/project',
};
const file = {
  path: 'src/example.ts',
  sha: headSha,
  status: 'modified',
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: '@@ -1 +1 @@\n-old\n+synthetic-private-write-body',
  patchTruncated: false,
  version,
};
const comment = {
  id: 9,
  author: 'synthetic',
  body: 'synthetic-private-write-body',
  bodyTruncated: false,
  url: repository.url + '/pull/1#discussion_r9',
  updatedAt: at,
  path: file.path,
  commitSha: headSha,
  originalCommitSha: baseSha,
  side: 'RIGHT',
  line: 1,
  originalLine: 1,
  version,
};
const execution = { mode: 'shared', status: 'ready', revision: 0 };
const git = {
  kind: 'git',
  branch: 'main',
  headOid: headSha,
  branches: [{ name: 'main', oid: headSha }],
  changes: [],
  dirty: false,
  partial: false,
  outsideProjectChanges: false,
  version,
  issues: [],
  writeSupported: true,
};
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const relay = await syntheticRelay();
  const controls: {
    hold?: (m: any) => Promise<void>;
    transform?: (v: any) => any;
    error?: { status: number; message: string; rejected: boolean };
  } = {};
  for (const h of relay.hosts) {
    h.runtime.features!.push(GITHUB_WRITE_FEATURE);
    for (const method of [
      'github-write-read',
      'github-write-action',
      'github-write-inspect',
      'github-write-abandon',
    ])
      h.responses.set(method, async (m) => {
        const p = m.params.request ?? m.params;
        const scope = {
          githubWriteVersion: 1,
          workspaceId: p.workspaceId,
          localProjectId: p.localProjectId,
          sessionId: p.sessionId,
        };
        let result: any;
        if (method !== 'github-write-read') {
          const original = githubWriteActionSchema.parse(p);
          result = {
            ...scope,
            operationId: p.operationId,
            action: p.action,
            requestVersion:
              'sha256:' + createHash('sha256').update(JSON.stringify(original)).digest('hex'),
            confirmed: method !== 'github-write-abandon',
            phase: method === 'github-write-abandon' ? 'abandoned' : 'accepted',
            message: '原操作已确认',
            checkedAt: at,
            ...(method === 'github-write-abandon' ? {} : { result: { id: 9, number: 1 } }),
          };
        } else {
          const base = { ...scope, confirmed: true, readAt: at, view: p.view };
          const remote = {
            ...base,
            repository,
            configVersion: version,
            writesEnabled: true,
            bindingRevision: 0,
          };
          const page = (items: any[]) => ({
            items,
            page: p.page,
            hasNext: false,
            partial: p.page > 1,
          });
          if (p.view === 'overview') result = { ...remote, git, execution, canCommit: true };
          else if (p.view === 'commit-preview')
            result = {
              ...base,
              candidateVersion: version,
              branch: 'main',
              parentOid: headSha,
              indexVersion: version,
              execution,
              files: p.paths.map((path: string) => ({
                path,
                kind: 'modify',
                version,
                byteLength: 4,
                mode: '100644',
                beforeText: 'old',
                afterText: 'synthetic-private-write-body',
                binary: false,
                truncated: false,
              })),
            };
          else if (p.view === 'branches')
            result = {
              ...remote,
              result: page([{ name: 'main', sha: headSha, protected: false }]),
            };
          else if (p.view === 'files' || p.view === 'review-comments')
            result = {
              ...remote,
              number: p.number,
              headSha: p.headSha,
              baseSha: p.baseSha,
              result: page([p.view === 'files' ? file : comment]),
            };
          else if (p.view === 'push-preview')
            result = {
              ...remote,
              branch: p.branch,
              headOid: p.headOid,
              expectedRemoteOid: null,
              canPush: true,
              execution,
            };
        }
        await controls.hold?.(m);
        if (controls.error) {
          h.socket.send(
            JSON.stringify({ type: 'response', requestId: m.requestId, error: controls.error }),
          );
          return;
        }
        return controls.transform?.(result) ?? result;
      });
    const pong = once(h.socket, 'pong');
    h.socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        machineId: h.runtime.machineId,
        workspaces: [h.runtime],
      }),
    );
    h.socket.ping();
    await pong;
  }
  const [space]: Workspace[] = await (await relay.api('/api/workspaces')).json();
  const host = space.hosts[0]!,
    replica = space.replicas.find(
      (r) => r.hostId === host.id && r.localProjectId === 'local-moor',
    )!;
  const scope = {
    githubWriteVersion: 1,
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'same-session-id',
  };
  const action = {
    ...scope,
    operationId: 'synthetic-github-write-operation',
    confirmed: true,
    action: 'issue-comment',
    repositoryId: 123,
    configVersion: version,
    expectedBindingRevision: 0,
    subject: 'issue',
    number: 1,
    expectedVersion: version,
    body: 'synthetic-private-write-body',
  };
  const read = (view: string, extra: object = {}) => ({
    ...scope,
    view,
    ...(['overview', 'commit-preview'].includes(view)
      ? {}
      : { repositoryId: 123, configVersion: version }),
    ...extra,
  });
  const path = (kind: string) =>
    `/api/workspaces/${space.id}/replicas/${replica.id}/github-write/${kind}`;
  return {
    ...relay,
    controls,
    space,
    host,
    replica,
    scope,
    action,
    read,
    path,
    synthetic: relay.hosts.find((h) => h.device.id === host.deviceId)!,
  };
}

test('GitHub write previews/actions/recovery route through one exact replica without persisting bodies or operation receipts', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const [kind, input] of [
    ['read', f.read('overview')],
    ['read', f.read('commit-preview', { paths: [file.path] })],
    ['read', f.read('branches', { page: 1 })],
    ['read', f.read('files', { number: 1, headSha, baseSha, page: 1 })],
    ['read', f.read('review-comments', { number: 1, headSha, baseSha, page: 2 })],
    ['read', f.read('push-preview', { branch: 'main', headOid: headSha })],
    ['action', f.action],
    ['inspect', { request: f.action, page: 1 }],
    ['abandon', { request: f.action }],
  ] as const) {
    const r = await f.api(f.path(kind), input);
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.equal(f.synthetic.messages.filter((m) => m.method?.startsWith('github-write-')).length, 9);
  assert.equal(
    f.hosts
      .find((h) => h !== f.synthetic)!
      .messages.filter((m) => m.method?.startsWith('github-write-')).length,
    0,
  );
  const inspected = f.synthetic.messages.find((m) => m.method === 'github-write-inspect');
  assert.deepEqual(inspected.params.request, githubWriteActionSchema.parse(f.action));
  for (const row of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all())
    assert.doesNotMatch(
      JSON.stringify(f.store.db.prepare(`SELECT * FROM ${row.name}`).all()),
      /synthetic-private-write-body|synthetic-github-write-operation/,
    );
});

test('GitHub writes require explicit confirmation, current cookie, feature and full workspace/project scope', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const extra of [
    { confirmed: false },
    { confirmed: undefined },
    { token: 'secret' },
    { url: 'http://localhost/private' },
    { method: 'DELETE' },
    { workspaceId: 'other' },
    { localProjectId: 'other' },
    { userId: 'other' },
    { machineId: 'other' },
  ]) {
    const r = await f.api(f.path('action'), { ...f.action, ...extra });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).rejected, true);
  }
  const unauthorized = await fetch(f.origin + f.path('action'), {
    method: 'POST',
    headers: { Origin: f.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(f.action),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).rejected, true);
  const missing = once(f.synthetic.socket, 'pong');
  f.synthetic.runtime.features = [];
  f.synthetic.socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: f.synthetic.runtime.machineId,
      workspaces: [f.synthetic.runtime],
    }),
  );
  f.synthetic.socket.ping();
  await missing;
  const outdated = await f.api(f.path('action'), f.action);
  assert.equal(outdated.status, 409);
  assert.equal((await outdated.json()).rejected, true);
  assert.equal(
    f.synthetic.messages.some((m) => m.method?.startsWith('github-write-')),
    false,
  );
});

test('read responses bind exact PR SHA/base/page, config, selected commit files and push head', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const cases: [any, (v: any) => any][] = [
    [f.read('overview'), (v) => ({ ...v, sessionId: 'other' })],
    [f.read('overview'), (v) => ({ ...v, token: 'private' })],
    [f.read('files', { number: 1, headSha, baseSha, page: 1 }), (v) => ({ ...v, number: 2 })],
    [
      f.read('files', { number: 1, headSha, baseSha, page: 1 }),
      (v) => ({ ...v, headSha: baseSha }),
    ],
    [
      f.read('review-comments', { number: 1, headSha, baseSha, page: 1 }),
      (v) => ({ ...v, baseSha: headSha }),
    ],
    [f.read('branches', { page: 1 }), (v) => ({ ...v, configVersion: 'sha256:' + 'd'.repeat(64) })],
    [f.read('branches', { page: 1 }), (v) => ({ ...v, repository: { ...v.repository, id: 999 } })],
    [f.read('branches', { page: 1 }), (v) => ({ ...v, result: { ...v.result, page: 2 } })],
    [
      f.read('commit-preview', { paths: [file.path] }),
      (v) => ({ ...v, files: [{ ...v.files[0], path: 'unselected.txt' }] }),
    ],
    [
      f.read('commit-preview', { paths: [file.path, 'other.ts'] }),
      (v) => ({ ...v, files: [v.files[0], v.files[0]] }),
    ],
    [
      f.read('push-preview', { branch: 'main', headOid: headSha }),
      (v) => ({ ...v, branch: 'other' }),
    ],
    [
      f.read('push-preview', { branch: 'main', headOid: headSha }),
      (v) => ({ ...v, headOid: baseSha }),
    ],
  ];
  for (const [input, transform] of cases) {
    f.controls.transform = transform;
    const r = await f.api(f.path('read'), input);
    assert.equal(r.status, 502);
  }
});

test('action and nested recovery receipts require exact original action fingerprint, operation ID and scope', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const kind of ['action', 'inspect', 'abandon'])
    for (const transform of [
      (v: any) => ({ ...v, requestVersion: 'sha256:' + 'e'.repeat(64) }),
      (v: any) => ({ ...v, operationId: 'other' }),
      (v: any) => ({ ...v, sessionId: 'other' }),
      (v: any) => ({ ...v, action: 'pr-create' }),
      (v: any) => ({ ...v, result: { number: 9 } }),
      (v: any) => ({ ...v, body: 'leaked' }),
      (v: any) => ({ ...v, confirmed: true, phase: 'unknown' }),
    ]) {
      f.controls.transform = transform;
      const r = await f.api(
        f.path(kind),
        kind === 'action'
          ? f.action
          : { request: f.action, ...(kind === 'inspect' ? { page: 1 } : {}) },
      );
      assert.equal(r.status, 502);
      assert.equal((await r.json()).rejected, false);
    }
});

test('historical unknown and released receipts remain unconfirmed without inventing successful writes', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.controls.transform = (v) => ({
    ...v,
    phase: 'unknown',
    confirmed: false,
    released: true,
    result: undefined,
  });
  for (const kind of ['action', 'inspect', 'abandon']) {
    const r = await f.api(
      f.path(kind),
      kind === 'action'
        ? f.action
        : { request: f.action, ...(kind === 'inspect' ? { page: 2 } : {}) },
    );
    assert.equal(r.status, 200);
    const receipt = await r.json();
    assert.equal(receipt.confirmed, false);
    assert.equal(receipt.released, true);
  }
});

test('recovery HTTP errors never claim the original operation did not run', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const kind of ['inspect', 'abandon']) {
    const malformed = await f.api(f.path(kind), {
      request: { ...f.action, confirmed: false },
      ...(kind === 'inspect' ? { page: 1 } : {}),
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).rejected, false);
    const unauthorized = await fetch(f.origin + f.path(kind), {
      method: 'POST',
      headers: { Origin: f.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: f.action, ...(kind === 'inspect' ? { page: 1 } : {}) }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).rejected, false);
    f.controls.error = { status: 409, message: 'host synthetic preflight', rejected: true };
    const failed = await f.api(f.path(kind), {
      request: f.action,
      ...(kind === 'inspect' ? { page: 1 } : {}),
    });
    assert.equal(failed.status, 409);
    assert.equal((await failed.json()).rejected, false);
  }
});

test('late successes and errors discard private response after logout, route move or runtime identity change', async (t) => {
  for (const kind of ['read', 'action', 'inspect', 'abandon'])
    for (const mode of ['success', 'error'])
      await t.test(`${kind} ${mode}`, async (t) => {
        const f = await fixture();
        t.after(f.close);
        const reached = signal(),
          release = signal();
        f.controls.hold = async () => {
          reached.resolve();
          await release.promise;
        };
        if (mode === 'error')
          f.controls.error = {
            status: 409,
            message: 'synthetic-private-write-body',
            rejected: true,
          };
        const promise = f.api(
          f.path(kind),
          kind === 'read'
            ? f.read('files', { number: 1, headSha, baseSha, page: 1 })
            : kind === 'action'
              ? f.action
              : { request: f.action, ...(kind === 'inspect' ? { page: 1 } : {}) },
        );
        await reached.promise;
        if (kind === 'read') await f.api('/api/logout', {});
        else if (kind === 'action') {
          const next = f.store.catalog.create(f.owner, 'Moved synthetic');
          f.store.catalog.moveHost(f.owner, f.space.id, f.host.id, next.id);
        } else {
          const pong = once(f.synthetic.socket, 'pong');
          f.synthetic.runtime.userId = 'changed-runtime-user';
          f.synthetic.socket.send(
            JSON.stringify({
              type: 'hello',
              protocol: PROTOCOL,
              machineId: f.synthetic.runtime.machineId,
              workspaces: [f.synthetic.runtime],
            }),
          );
          f.synthetic.socket.ping();
          await pong;
        }
        release.resolve();
        const r = await promise;
        assert.ok([401, 404, 409].includes(r.status), String(r.status));
        const result = await r.json();
        assert.equal(result.rejected, false);
        assert.doesNotMatch(JSON.stringify(result), /synthetic-private-write-body/);
      });
});

test('commit preview JSON between 2 MiB and 3 MiB is accepted, larger typed projections are rejected', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const paths = Array.from({ length: 50 }, (_, i) => `file-${i}.txt`);
  f.controls.transform = (v) => ({
    ...v,
    files: v.files.map((x: any) => ({
      ...x,
      beforeText: '\\'.repeat(15000),
      afterText: '\\'.repeat(15000),
    })),
  });
  const okay = await f.api(f.path('read'), f.read('commit-preview', { paths }));
  assert.equal(okay.status, 200);
  const content = await okay.text();
  assert.ok(Buffer.byteLength(content) > 2 * 1024 * 1024);
  f.controls.transform = (v) => ({
    ...v,
    files: v.files.map((x: any) => ({
      ...x,
      beforeText: '\\'.repeat(16000),
      afterText: '\\'.repeat(16000),
    })),
  });
  assert.equal((await f.api(f.path('read'), f.read('commit-preview', { paths }))).status, 502);
});

test('another device cannot inject a receipt and a replaced connection cannot finish an old read', async (t) => {
  const f = await fixture();
  t.after(f.close);
  let requestId = '';
  const reached = signal(),
    release = signal();
  f.controls.hold = async (m) => {
    requestId = m.requestId;
    reached.resolve();
    await release.promise;
  };
  const pending = f.api(f.path('action'), f.action);
  await reached.promise;
  const other = f.hosts.find((h) => h !== f.synthetic)!,
    pong = once(other.socket, 'pong');
  other.socket.send(JSON.stringify({ type: 'response', requestId, result: { private: 'forged' } }));
  other.socket.ping();
  await pong;
  release.resolve();
  assert.equal((await pending).status, 200);
  const nextReached = signal(),
    nextRelease = signal();
  f.controls.hold = async () => {
    nextReached.resolve();
    await nextRelease.promise;
  };
  const reading = f.api(f.path('read'), f.read('files', { number: 1, headSha, baseSha, page: 1 }));
  await nextReached.promise;
  const replacement = new WebSocket(f.origin.replace('http:', 'ws:') + '/bridge', {
    headers: { Authorization: 'Bearer ' + f.synthetic.device.token },
  });
  t.after(() => replacement.terminate());
  await once(replacement, 'open');
  replacement.send(
    JSON.stringify({
      type: 'hello',
      protocol: PROTOCOL,
      machineId: f.synthetic.runtime.machineId,
      workspaces: [f.synthetic.runtime],
    }),
  );
  const result = await reading;
  assert.equal(result.status, 409);
  assert.doesNotMatch(await result.text(), /synthetic-private-write-body/);
  nextRelease.resolve();
});

test('accepted receipts require minimal result identity and rejected/abandoned receipts contain no result', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const transform of [
    (v: any) => ({ ...v, result: undefined }),
    (v: any) => ({ ...v, result: { id: 9 } }),
    (v: any) => ({ ...v, result: { number: 1 } }),
    (v: any) => ({ ...v, phase: 'rejected', confirmed: false }),
    (v: any) => ({ ...v, phase: 'abandoned', confirmed: false }),
  ]) {
    f.controls.transform = transform;
    const r = await f.api(f.path('action'), f.action);
    assert.equal(r.status, 502);
    assert.equal((await r.json()).rejected, false);
  }
});
