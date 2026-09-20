import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticCollaboration } from '../fixtures/collaboration-host';
import { CollaborationReplica } from '@moor/session/collaboration-replica';
import { buildSessionTurn } from '@moor/session/session-operations';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test('invitation HTTP enrollment requires the original origin, consumes its token once and grants no shared access', async (t) => {
  const f = await syntheticCollaboration();
  t.after(f.close);
  const created = await f.ownerApi('/api/account-invitations', {});
  assert.equal(created.status, 200);
  const { invitation } = await created.json();
  const enroll = (origin: string) =>
    fetch(f.origin + '/api/account-invitations/redeem', {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: 'Bearer synthetic-not-authority',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        invitation,
        email: 'invited@synthetic.invalid',
        password: 'synthetic-password-only',
      }),
    });
  assert.equal((await enroll('https://foreign.invalid')).status, 403);
  const accepted = await enroll(f.origin);
  assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const shared = await fetch(f.origin + f.route + '/read', {
    headers: { Cookie: cookie.split(';')[0]! },
  });
  assert.equal(shared.status, 403);
  assert.equal((await enroll(f.origin)).status, 403);
});
test('collaboration routes authenticate distinct members and reject draft transmission and keep submitted task bodies on the Host', async (t) => {
  const f = await syntheticCollaboration();
  t.after(f.close);
  assert.equal((await f.memberApi(f.route + '/read')).status, 403);
  const opened = await f.ownerApi(f.route + '/enable', {});
  assert.equal(opened.status, 200, JSON.stringify(await opened.clone().json()));
  const read = await opened.json();
  assert.equal(read.role, 'owner');
  assert.equal(
    (await f.ownerApi(f.route + '/member', { accountId: f.memberId, role: 'editor' })).status,
    200,
  );
  const shared = await f.memberApi(f.route + '/read');
  assert.equal(shared.status, 200);
  assert.equal((await shared.json()).role, 'editor');
  const draft = {
    version: 1,
    kind: 'draft',
    operationId: 'member-draft',
    draftId: 'draft',
    parents: [],
    scope: read.scope,
    createdAt: 1000,
    author: {
      actor: { kind: 'relay', authorityId: f.accounts.authorityId, accountId: f.memberId },
      clientId: 'member-browser',
    },
    input: { prompt: 'Synthetic shared draft with no execution', selection: {} },
  };
  const request = { version: 3, scope: read.scope, after: 0, operations: [] };
  assert.equal(
    (await f.memberApi(f.route + '/sync', { ...request, operations: [draft] })).status,
    400,
  );
  assert.equal(
    (
      await f.memberApi(f.route + '/offer', {
        version: 3,
        scope: read.scope,
        operationId: draft.operationId,
        operations: [draft],
      })
    ).status,
    400,
  );
  assert.equal(f.prompts.length, 0);
  const own = await (await f.ownerApi(f.route + '/sync', request)).json();
  const replica = new CollaborationReplica(read.scope, own.document.update);
  assert.deepEqual(replica.view().operations, []);
  replica.close();
  assert.equal(
    f.accounts.db
      .prepare("SELECT name FROM sqlite_master WHERE name='collaboration_operation'")
      .get(),
    undefined,
  );
  assert.equal(
    f.runtime.journal.db.prepare('SELECT count(*) AS n FROM collaboration_document').get()!.n,
    1,
  );
  assert.equal(
    (await f.memberApi(f.route + '/member', { accountId: f.ownerId, role: 'viewer' })).status,
    403,
  );
  const submit = {
    ...draft,
    kind: 'submit',
    operationId: 'unauthorized-task',
    parents: undefined,
    draftId: undefined,
    target: read.target,
    authorization: { kind: 'execute', ordering: 'after-previous', expiresAt: Date.now() + 100000 },
  };
  assert.equal(
    (await f.memberApi(f.route + '/sync', { ...request, operations: [submit] })).status,
    403,
  );
  assert.equal(
    (await f.ownerApi(f.route + '/member', { accountId: f.memberId, role: 'operator' })).status,
    200,
  );
  assert.equal(
    (
      await f.memberApi(f.route + '/sync', {
        ...request,
        operations: [
          {
            ...submit,
            author: { ...submit.author, actor: { ...submit.author.actor, accountId: f.ownerId } },
          },
        ],
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.memberApi(f.route + '/sync', { ...request, operations: [submit] })).status,
    200,
  );
});

test('revocation while a shared read is in flight withholds the response and blocks subsequent access', async (t) => {
  const f = await syntheticCollaboration();
  t.after(f.close);
  await f.ownerApi(f.route + '/enable', {});
  await f.ownerApi(f.route + '/member', { accountId: f.memberId, role: 'viewer' });
  const entered = signal(),
    release = signal();
  f.hold(async () => {
    entered.resolve();
    await release.promise;
  });
  const reading = f.memberApi(f.route + '/read');
  await entered.promise;
  const spaceId = f.route.split('/')[3]!;
  f.accounts.catalog.grantCollaboration(f.ownerId, spaceId, f.memberId, null);
  release.resolve();
  assert.equal((await reading).status, 403);
  f.hold();
  assert.equal((await f.memberApi(f.route + '/read')).status, 403);
});

test(
  'Host idle signals dispatch an authorized queued task after an ordinary active turn without another client request',
  { timeout: 10000 },
  async (t) => {
    const f = await syntheticCollaboration();
    t.after(f.close);
    const response = await f.ownerApi(f.route + '/enable', {});
    assert.equal(response.status, 200);
    const read = await response.json(),
      hold = f.pauseNextPrompt();
    const command = buildSessionTurn({
      scope: read.target,
      read: read.session,
      agent: read.session.agent,
      prompt: 'ordinary held turn',
      selection: {},
      operationId: 'ordinary',
      turnId: 'ordinary-user',
      peerId: 'ordinary-peer',
      now: new Date(1000).toISOString(),
    });
    await f.host.mutate(command, read.target.localProjectId);
    await hold.started;
    const draft = {
      version: 1,
      kind: 'draft',
      operationId: 'queued-draft',
      draftId: 'draft',
      parents: [],
      scope: read.scope,
      createdAt: 1000,
      author: {
        actor: { kind: 'relay', authorityId: f.accounts.authorityId, accountId: f.ownerId },
        clientId: 'owner-browser',
      },
      input: { prompt: 'followup queued turn', selection: {} },
    };
    const { parents: _parents, draftId: _draftId, ...base } = draft;
    const task = {
      ...base,
      kind: 'submit',
      operationId: 'queued-task',
      target: read.target,
      authorization: {
        kind: 'execute',
        ordering: 'after-previous',
        expiresAt: Date.now() + 100000,
      },
    };
    const submitted = await f.ownerApi(f.route + '/sync', {
      version: 3,
      scope: read.scope,
      after: 0,
      operations: [task],
    });
    assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()));
    assert.equal(f.prompts.length, 1);
    const nextPrompt = f.waitForPrompts(2);
    hold.release();
    await nextPrompt;
    await f.host.active.get(read.target.sessionId)?.done;
    assert.equal(f.prompts.length, 2);
  },
);
