import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { PROTOCOL } from '../src/protocol';
import { GITHUB_FEATURE } from '../src/github-protocol';
import type { Workspace } from '../src/catalog';
import { syntheticRelay } from './support/synthetic-relay';

const version = 'sha256:' + 'a'.repeat(64),
  sha = 'b'.repeat(40),
  at = '2026-09-12T00:00:00Z';
const repository = {
  id: 123,
  owner: 'synthetic',
  name: 'project',
  defaultBranch: 'main',
  private: true,
  url: 'https://github.com/synthetic/project',
};
const repositoryRef = { id: 123, owner: 'synthetic', name: 'project' };
const issue = {
  kind: 'issue',
  id: 101,
  number: 1,
  title: 'synthetic-private-gh-title',
  state: 'open',
  author: 'synthetic',
  url: repository.url + '/issues/1',
  updatedAt: at,
  body: 'synthetic-private-gh-body',
  bodyTruncated: false,
  labels: [],
  version,
};
const pull = {
  ...issue,
  kind: 'pull',
  url: repository.url + '/pull/1',
  head: { sha, branch: 'feature/synthetic', repository: repositoryRef },
  base: { sha: 'c'.repeat(40), branch: 'main', repository: repositoryRef },
  mergeable: null,
};
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
async function fixture() {
  const relay = await syntheticRelay();
  const controls: {
    hold?: (m: any) => Promise<void>;
    transform?: (value: any) => any;
    error?: { status: number; message: string; rejected: boolean };
  } = {};
  for (const h of relay.hosts) {
    h.runtime.features!.push(GITHUB_FEATURE);
    for (const method of ['github-read', 'github-action', 'github-abandon'])
      h.responses.set(method, async (m) => {
        const p = m.params;
        const scope = {
          githubVersion: 1,
          workspaceId: p.workspaceId,
          localProjectId: p.localProjectId,
          sessionId: p.sessionId,
          confirmed: true,
        };
        let result: any;
        if (method !== 'github-read')
          result = {
            ...scope,
            operationId: p.operationId,
            binding: {
              revision: p.expectedRevision + 1,
              ...(p.action === 'bind'
                ? {
                    context: {
                      repository: repositoryRef,
                      branch: p.branch,
                      subject: p.subject,
                      updatedAt: at,
                    },
                  }
                : {}),
            },
          };
        else {
          const base = {
            ...scope,
            view: p.view,
            repository,
            configVersion: version,
            binding: { revision: 0 },
            readAt: at,
          };
          const page = (items: any[]) => ({
            items,
            page: p.page,
            hasNext: false,
            partial: p.page > 1,
          });
          const summary = ({
            body,
            bodyTruncated,
            labels,
            version,
            head,
            base,
            mergeable,
            ...item
          }: any) => item;
          switch (p.view) {
            case 'overview':
              result = {
                ...base,
                status: 'available',
                localBranch: 'main',
                localHeadSha: sha,
                execution: { mode: 'shared', status: 'ready', revision: 0 },
              };
              break;
            case 'branches':
              result = { ...base, result: page([{ name: 'main', sha, protected: false }]) };
              break;
            case 'issues':
              result = { ...base, state: p.state, result: page([summary(issue)]) };
              break;
            case 'pulls':
              result = { ...base, state: p.state, result: page([summary(pull)]) };
              break;
            case 'issue':
              result = { ...base, item: issue };
              break;
            case 'pull':
              result = { ...base, item: pull };
              break;
            case 'comments':
              result = {
                ...base,
                number: p.number,
                subject: p.subject,
                result: page([
                  {
                    id: 9,
                    author: 'synthetic',
                    body: issue.body,
                    bodyTruncated: false,
                    url: issue.url + '#issuecomment-9',
                    updatedAt: at,
                  },
                ]),
              };
              break;
            case 'checks':
              result = {
                ...base,
                number: p.number,
                headSha: p.headSha,
                checks: page([]),
                statuses: { ...page([]), state: 'pending', totalCount: 0 },
              };
              break;
          }
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
    githubVersion: 1,
    workspaceId: host.runtimeWorkspaceId,
    localProjectId: replica.localProjectId,
    sessionId: 'same-session-id',
  };
  const action = {
    ...scope,
    action: 'bind',
    operationId: 'synthetic-gh-operation',
    expectedRevision: 0,
    repositoryId: 123,
    configVersion: version,
    branch: 'main',
    subject: null,
  };
  const read = (view: string, extra: object = {}) => ({
    ...scope,
    view,
    ...(view === 'overview' ? {} : { repositoryId: 123, configVersion: version }),
    ...extra,
  });
  const path = (kind: string) =>
    `/api/workspaces/${space.id}/replicas/${replica.id}/github/${kind}`;
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

test('GitHub reads and local binding actions use the exact replica without persisting external content at the relay', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const [kind, input] of [
    ['read', f.read('overview')],
    ['read', f.read('branches', { page: 1 })],
    ['read', f.read('issues', { page: 1, state: 'all' })],
    ['read', f.read('pulls', { page: 1, state: 'open' })],
    ['read', f.read('issue', { number: 1 })],
    ['read', f.read('pull', { number: 1 })],
    ['read', f.read('comments', { number: 1, subject: 'issue', page: 2 })],
    ['read', f.read('checks', { number: 1, headSha: sha, page: 1 })],
    ['action', f.action],
    [
      'action',
      { ...f.scope, action: 'unbind', operationId: 'synthetic-gh-unbind', expectedRevision: 1 },
    ],
  ] as const) {
    const r = await f.api(f.path(kind), input);
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal((await r.json()).confirmed, true);
  }
  assert.equal(f.synthetic.messages.filter((m) => m.method?.startsWith('github-')).length, 10);
  assert.equal(
    f.hosts.find((h) => h !== f.synthetic)!.messages.filter((m) => m.method?.startsWith('github-'))
      .length,
    0,
  );
  for (const row of f.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all())
    assert.doesNotMatch(
      JSON.stringify(f.store.db.prepare(`SELECT * FROM ${row.name}`).all()),
      /synthetic-private-gh|synthetic-gh-operation/,
    );
});

test('GitHub rejects credentials, arbitrary URLs and mismatched scopes before host dispatch', async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const extra of [
    { token: 'synthetic-secret' },
    { url: 'https://example.invalid/private' },
    { method: 'POST' },
    { workspaceId: 'other' },
    { localProjectId: 'other' },
    { branch: ' ' },
    { subject: { kind: 'pull', number: 1, version, headSha: 'moving-branch' } },
  ]) {
    const r = await f.api(f.path('action'), { ...f.action, ...extra });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).rejected, true);
  }
  assert.equal(
    (await f.api(f.path('action'), { ...f.action, padding: 'x'.repeat(16384) })).status,
    413,
  );
  assert.equal(
    (await f.api(f.path('config'), { action: 'credential-save', token: 'synthetic-secret' }))
      .status,
    404,
  );
  const unauthorized = await fetch(f.origin + f.path('action'), {
    method: 'POST',
    headers: { Origin: f.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(f.action),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).rejected, true);
  const pong = once(f.synthetic.socket, 'pong');
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
  await pong;
  const missing = await f.api(f.path('action'), f.action);
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).rejected, true);
  assert.equal(
    f.synthetic.messages.some((m) => m.method?.startsWith('github-')),
    false,
  );
});

test('GitHub results bind repository, page, kind, item, PR commit and the exact local binding request', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const cases: [string, any, (v: any) => any][] = [
    ['read', f.read('issue', { number: 1 }), (v) => ({ ...v, token: 'synthetic-secret' })],
    ['read', f.read('issue', { number: 1 }), (v) => ({ ...v, sessionId: 'other' })],
    [
      'read',
      f.read('overview'),
      (v) => ({
        ...v,
        binding: {
          revision: 1,
          context: {
            repository: { ...repositoryRef, id: 999 },
            branch: 'private-old',
            subject: null,
            updatedAt: at,
          },
        },
      }),
    ],
    [
      'read',
      f.read('issue', { number: 1 }),
      (v) => ({ ...v, repository: { ...v.repository, id: 999 } }),
    ],
    [
      'read',
      f.read('issue', { number: 1 }),
      (v) => ({ ...v, configVersion: 'sha256:' + 'c'.repeat(64) }),
    ],
    ['read', f.read('issue', { number: 1 }), (v) => ({ ...v, item: { ...v.item, number: 2 } })],
    [
      'read',
      f.read('pull', { number: 1 }),
      (v) => ({
        ...v,
        item: { ...v.item, base: { ...v.item.base, repository: { ...repositoryRef, id: 999 } } },
      }),
    ],
    ['read', f.read('issues', { state: 'open', page: 1 }), (v) => ({ ...v, state: 'closed' })],
    [
      'read',
      f.read('issues', { state: 'open', page: 1 }),
      (v) => ({
        ...v,
        result: { ...v.result, items: v.result.items.map((i: any) => ({ ...i, kind: 'pull' })) },
      }),
    ],
    ['read', f.read('branches', { page: 1 }), (v) => ({ ...v, result: { ...v.result, page: 2 } })],
    [
      'read',
      f.read('checks', { number: 1, headSha: sha, page: 1 }),
      (v) => ({ ...v, headSha: 'c'.repeat(40) }),
    ],
    [
      'read',
      f.read('comments', { number: 1, subject: 'issue', page: 1 }),
      (v) => ({ ...v, subject: 'pull' }),
    ],
    ['action', f.action, (v) => ({ ...v, operationId: 'other' })],
    ['action', f.action, (v) => ({ ...v, redacted: true })],
    ['action', f.action, (v) => ({ ...v, binding: { revision: 1 } })],
    ['action', f.action, (v) => ({ ...v, binding: { ...v.binding, revision: 2 } })],
    [
      'action',
      f.action,
      (v) => ({
        ...v,
        binding: { ...v.binding, context: { ...v.binding.context, branch: 'other' } },
      }),
    ],
    [
      'action',
      f.action,
      (v) => ({
        ...v,
        binding: {
          ...v.binding,
          context: { ...v.binding.context, repository: { ...repositoryRef, id: 999 } },
        },
      }),
    ],
    [
      'action',
      f.action,
      (v) => ({
        ...v,
        binding: {
          ...v.binding,
          context: { ...v.binding.context, subject: { kind: 'issue', number: 1, version } },
        },
      }),
    ],
  ];
  for (const [kind, input, transform] of cases) {
    f.controls.transform = transform;
    const r = await f.api(f.path(kind), input);
    assert.equal(r.status, 502);
    assert.equal((await r.json()).rejected, false);
  }
});

test('GitHub historical confirmations reveal no context and still match the exact original bind', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.controls.transform = (v) => ({ ...v, redacted: true, binding: { revision: 1 } });
  const confirmed = await f.api(f.path('action'), f.action);
  assert.equal(confirmed.status, 200);
  const receipt = await confirmed.json();
  assert.equal(receipt.redacted, true);
  assert.deepEqual(receipt.binding, { revision: 1 });
  assert.doesNotMatch(JSON.stringify(receipt), /repository|branch|subject|private-gh/);
  for (const changed of [{ operationId: 'wrong' }, { binding: { revision: 2 } }]) {
    f.controls.transform = (v) => ({ ...v, redacted: true, binding: { revision: 1 }, ...changed });
    const invalid = await f.api(f.path('action'), f.action);
    assert.equal(invalid.status, 502);
    assert.equal((await invalid.json()).rejected, false);
  }
});

test('GitHub abandonment uses the original scoped request and validates terminal nonexecution receipts', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.controls.transform = (v) => ({ ...v, abandoned: true, binding: { revision: 0 } });
  for (const kind of ['abandon', 'action']) {
    const result = await f.api(f.path(kind), f.action);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const receipt = await result.json();
    assert.equal(receipt.abandoned, true);
    assert.deepEqual(receipt.binding, { revision: 0 });
  }
  const sent = f.synthetic.messages.find((m) => m.method === 'github-abandon')!;
  assert.deepEqual(sent.params, f.action);
  for (const changed of [
    { operationId: 'wrong' },
    { binding: { revision: 1 } },
    { redacted: true },
  ]) {
    f.controls.transform = (v) => ({ ...v, abandoned: true, binding: { revision: 0 }, ...changed });
    const r = await f.api(f.path('abandon'), f.action);
    assert.equal(r.status, 502);
    assert.equal((await r.json()).rejected, false);
  }
  const before = f.synthetic.messages.length;
  const invalid = await f.api(f.path('abandon'), { ...f.action, localProjectId: 'other' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).rejected, true);
  assert.equal(f.synthetic.messages.length, before);
});

test('logout while receiving a GitHub binding prevents its first dispatch', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const started = signal();
  const response = new Promise<any>((resolve, reject) => {
    const req = httpRequest(
      f.origin + f.path('action'),
      {
        method: 'POST',
        headers: {
          Origin: f.origin,
          Cookie: 'personal=' + f.secret,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        const bytes: Buffer[] = [];
        res.on('data', (c) => bytes.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, ...JSON.parse(Buffer.concat(bytes).toString()) }),
        );
      },
    );
    req.on('error', reject);
    req.flushHeaders();
    req.write('{');
    started.resolve();
    void started.promise.then(async () => {
      await f.api('/api/logout', {});
      req.end(JSON.stringify(f.action).slice(1));
    });
  });
  const result = await response;
  assert.equal(result.status, 401);
  assert.equal(result.rejected, true);
  assert.equal(
    f.synthetic.messages.some((m) => m.method === 'github-action'),
    false,
  );
});

test('late GitHub success and failure responses recheck login and project membership', async (t) => {
  for (const mode of ['success', 'error'] as const)
    for (const kind of ['read', 'action', 'abandon'] as const)
      for (const change of ['logout', 'move'] as const)
        await t.test(`${mode} ${kind} ${change}`, async (t) => {
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
              message: 'synthetic-private-gh-error',
              rejected: true,
            };
          const pending = f.api(
            f.path(kind),
            kind === 'read' ? f.read('issue', { number: 1 }) : f.action,
          );
          await reached.promise;
          if (change === 'logout') await f.api('/api/logout', {});
          else {
            const newSpace = f.store.catalog.create(f.owner, 'Moved synthetic workspace');
            f.store.catalog.moveHost(f.owner, f.space.id, f.host.id, newSpace.id);
          }
          release.resolve();
          const r = await pending;
          assert.ok([401, 404].includes(r.status));
          const result = await r.json();
          assert.equal(result.rejected, false);
          assert.doesNotMatch(JSON.stringify(result), /synthetic-private-gh/);
        });
});

test('GitHub invalidation broadcasts only a scoped marker, never local credentials or paths', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const viewer = new WebSocket(f.origin.replace('http:', 'ws:') + '/events', {
    headers: { Cookie: 'personal=' + f.secret, Origin: f.origin },
  });
  await once(viewer, 'open');
  t.after(() => viewer.terminate());
  const message = once(viewer, 'message');
  f.synthetic.socket.send(
    JSON.stringify({ type: 'github-changed', workspaceId: f.scope.workspaceId }),
  );
  const [data] = await message;
  assert.deepEqual(JSON.parse(String(data)), {
    type: 'changed',
    deviceId: f.host.deviceId,
    workspaceId: f.scope.workspaceId,
    room: { scope: 'github' },
  });
});
