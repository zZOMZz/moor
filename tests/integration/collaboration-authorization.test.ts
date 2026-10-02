import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { CollaborationPage } from '@moor/client/features/collaboration/page';
import type { CollaborationStorage } from '@moor/client/features/collaboration/client';
import { collaborationReadResponseSchema } from '@moor/protocol/collaboration-protocol';
import { browserCollaborationAccess } from '../../apps/web/src/platform/browser/collaboration';
import { syntheticCollaboration } from '../fixtures/collaboration-host';
class Memory implements CollaborationStorage {
  values = new Map<string, unknown>();
  async read(key: string) {
    return structuredClone(this.values.get(key));
  }
  async exclusive<T>(_key: string, current: () => void, task: () => Promise<T>) {
    current();
    return task();
  }
  async compareAndSet(key: string, previous: unknown, value: unknown, current: () => void) {
    current();
    assert.deepEqual(this.values.get(key) ?? null, previous);
    this.values.set(key, structuredClone(value));
  }
}
test('collaboration browser operations bind original owner even when the cookie changes after identity validation', async (t) => {
  const f = await syntheticCollaboration();
  t.after(f.close);
  const initial = collaborationReadResponseSchema.parse(
    await (await f.ownerApi(f.route + '/enable', {})).json(),
  );
  const url = new URL(f.url),
    actor = { kind: 'relay' as const, authorityId: f.accounts.authorityId, accountId: f.ownerId };
  const ownerSecret = f.accounts.createLogin(f.ownerId),
    memberSecret = f.accounts.createLogin(f.memberId);
  let secret = ownerSecret,
    swapAtInvite = false;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async (input, options) => {
    const target = new URL(String(input), f.origin);
    if (swapAtInvite && target.pathname === '/api/account-invitations') secret = memberSecret;
    const headers = new Headers(options?.headers);
    headers.set('Cookie', 'personal=' + secret);
    headers.set('Origin', f.origin);
    return nativeFetch(target, { ...options, headers });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });
  const access = browserCollaborationAccess({
    owner: f.ownerId,
    workspace: initial.scope.workspaceId,
    replica: url.searchParams.get('replica')!,
    session: initial.scope.sessionId,
  });
  const storage = new Memory();
  let closed = 0;
  const page = new CollaborationPage({
    owner: f.ownerId,
    origin: f.origin,
    workspace: initial.scope.workspaceId,
    replica: url.searchParams.get('replica')!,
    session: initial.scope.sessionId,
    storage,
    access,
    uuid: () => 'client-id',
    now: () => 1000,
    closeStorage: () => {
      closed++;
    },
  });
  await page.open(Promise.resolve({ owner: f.ownerId, actor }));
  const invitations = () =>
    Number(f.accounts.database.prepare('SELECT COUNT(*) AS n FROM account_invitation').get()!.n);
  const before = invitations();
  swapAtInvite = true;
  await assert.rejects(page.invite(), /账号已改变/);
  assert.equal(invitations(), before);
  assert.equal(closed, 1);
  assert.throws(page.current, /页面已关闭/);
  const request = { version: 3 as const, scope: initial.scope, after: 0, operations: [] };
  for (const attempt of [
    () => access.read(),
    () => access.enable(),
    () => access.member(f.memberId, 'viewer'),
    () => access.sync(request),
    () =>
      access.offer!({ version: 3, scope: initial.scope, operationId: 'original', operations: [] }),
    () => access.invite(),
  ])
    await assert.rejects(attempt(), /账号已改变/);
  assert.equal(invitations(), before);
  assert.equal(f.prompts.length, 0);
  const originalCache = structuredClone([...storage.values]);
  let identityCalls = 0,
    closedLogout = 0;
  const offline = {
    ...access,
    identity: async () => {
      identityCalls++;
      throw Error('synthetic offline');
    },
  };
  const logoutPage = new CollaborationPage({
    owner: f.ownerId,
    origin: f.origin,
    workspace: initial.scope.workspaceId,
    replica: url.searchParams.get('replica')!,
    session: initial.scope.sessionId,
    storage,
    access: offline,
    uuid: () => 'client-id',
    now: () => 1000,
    closeStorage: () => {
      closedLogout++;
    },
  });
  await assert.rejects(logoutPage.open(Promise.resolve({ owner: null })), /账号已退出/);
  assert.equal(identityCalls, 0);
  assert.equal(closedLogout, 1);
  assert.deepEqual([...storage.values], originalCache);
  const unknownPage = new CollaborationPage({
    owner: f.ownerId,
    origin: f.origin,
    workspace: initial.scope.workspaceId,
    replica: url.searchParams.get('replica')!,
    session: initial.scope.sessionId,
    storage,
    access: offline,
    uuid: () => 'client-id',
    now: () => 1000,
    closeStorage: () => {},
  });
  const recovered = await unknownPage.open(Promise.resolve(null));
  assert.equal(recovered.actor.accountId, f.ownerId);
  assert.doesNotThrow(unknownPage.current);
  assert.deepEqual(recovered.client.state.snapshot().pending, []);
  unknownPage.close();
});
test('Gateway invitation creation rechecks login after a deterministically paused request body', async (t) => {
  const f = await syntheticCollaboration();
  t.after(f.close);
  const secret = f.accounts.createLogin(f.ownerId),
    originalOwner = f.accounts.owner.bind(f.accounts);
  let authenticated!: () => void;
  const readOwner = new Promise<void>((resolve) => {
    authenticated = resolve;
  });
  f.accounts.owner = (value) => {
    const owner = originalOwner(value);
    if (value === secret) authenticated();
    return owner;
  };
  t.after(() => {
    f.accounts.owner = originalOwner;
  });
  const before = Number(
    f.accounts.database.prepare('SELECT COUNT(*) AS n FROM account_invitation').get()!.n,
  );
  let req!: ReturnType<typeof httpRequest>;
  const response = new Promise<number>((resolve, reject) => {
    req = httpRequest(
      f.origin + '/api/account-invitations?expectedAccount=' + encodeURIComponent(f.ownerId),
      {
        method: 'POST',
        headers: {
          Cookie: 'personal=' + secret,
          Origin: f.origin,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    req.on('error', reject);
  });
  t.after(() => req.destroy());
  req.write('{');
  await readOwner;
  f.accounts.logout(secret);
  req.end('}');
  assert.equal(await response, 401);
  assert.equal(
    Number(f.accounts.database.prepare('SELECT COUNT(*) AS n FROM account_invitation').get()!.n),
    before,
  );
});
