import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { syntheticRelay } from '../fixtures/synthetic-relay';
import {
  accountManagementPlan,
  validateAccountManagementResult,
} from '@moor/protocol/account-management';

test('finite account actions retain pairing and directory management without executing an Agent', async (t) => {
  const relay = await syntheticRelay();
  t.after(() => relay.close());
  const perform = async (input: unknown) => {
    const plan = accountManagementPlan(input);
    const response = await relay.api(plan.path, plan.body);
    assert.equal(response.status, 200);
    return validateAccountManagementResult(plan.request, await response.json());
  };
  const created = await perform({
    action: 'create-workspace',
    owner: relay.owner,
    name: 'Synthetic space',
  });
  assert.equal(created.action, 'create-workspace');
  assert.ok('id' in created);
  await perform({
    action: 'rename-workspace',
    owner: relay.owner,
    workspaceId: created.id,
    name: 'Synthetic renamed',
  });
  const project = await perform({
    action: 'create-project',
    owner: relay.owner,
    workspaceId: created.id,
    name: 'Synthetic project',
  });
  assert.equal(project.action, 'create-project');
  const paired = await perform({ action: 'pair', owner: relay.owner, workspaceId: created.id });
  assert.equal(paired.action, 'pair');
  const listed = await perform({ action: 'catalog', owner: relay.owner });
  assert.ok(
    listed.action === 'catalog' &&
      listed.workspaces.some(
        (space) => space.id === created.id && space.name === 'Synthetic renamed',
      ),
  );
  const devices = await perform({ action: 'devices', owner: relay.owner });
  assert.ok(devices.action === 'devices' && devices.devices.length === 2);
  await perform({ action: 'revoke', owner: relay.owner, deviceId: relay.hosts[0]!.device.id });
  assert.equal(
    relay.hosts.some((host) => host.messages.some((message) => message.method === 'mutate')),
    false,
  );
});

test('the reviewed account binding refuses a switched browser cookie before creating metadata', async (t) => {
  const relay = await syntheticRelay();
  t.after(() => relay.close());
  const invitation = relay.store.inviteAccount(relay.owner);
  const otherSecret = await relay.store.redeemAccountInvitation(
    invitation.invitation,
    'other@synthetic.invalid',
    'synthetic-password-only',
  );
  const otherOwner = relay.store.owner(otherSecret);
  const plan = accountManagementPlan({
    action: 'create-workspace',
    owner: relay.owner,
    name: 'Must not exist',
  });
  const response = await fetch(relay.origin + plan.path, {
    method: 'POST',
    headers: {
      Cookie: 'personal=' + otherSecret,
      Origin: relay.origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(plan.body),
  });
  assert.equal(response.status, 403);
  assert.equal(
    relay.store.db.prepare('SELECT COUNT(*) AS count FROM workspace WHERE owner=?').get(otherOwner)!
      .count,
    0,
  );
});

test('revocation while a directory request body is pending prevents the subsequent write', async (t) => {
  const relay = await syntheticRelay();
  t.after(() => relay.close());
  let reached!: () => void;
  const readingBody = new Promise<void>((resolve) => (reached = resolve));
  const owner = relay.store.owner.bind(relay.store);
  let reads = 0;
  t.mock.method(relay.store, 'owner', (secret: string) => {
    const value = owner(secret);
    if (secret === relay.secret && ++reads === 2) reached();
    return value;
  });
  const before = relay.store.db.prepare('SELECT COUNT(*) AS count FROM workspace').get()!.count;
  const plan = accountManagementPlan({
    action: 'create-workspace',
    owner: relay.owner,
    name: 'Must not exist',
  });
  let send!: ReturnType<typeof request>;
  const finished = new Promise<number | undefined>((resolve, reject) => {
    send = request(
      relay.origin + plan.path,
      {
        method: 'POST',
        headers: {
          Cookie: 'personal=' + relay.secret,
          Origin: relay.origin,
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    send.once('error', reject);
    send.flushHeaders();
  });
  await readingBody;
  relay.store.logout(relay.secret);
  send.end(JSON.stringify(plan.body));
  assert.equal(await finished, 401);
  assert.equal(
    relay.store.db.prepare('SELECT COUNT(*) AS count FROM workspace').get()!.count,
    before,
  );
});

test('logout binds the reviewed account before revoking a switched browser cookie', async (t) => {
  const relay = await syntheticRelay();
  t.after(() => relay.close());
  const invitation = relay.store.inviteAccount(relay.owner);
  const otherSecret = await relay.store.redeemAccountInvitation(
    invitation.invitation,
    'logout-other@synthetic.invalid',
    'synthetic-password-only',
  );
  const otherOwner = relay.store.owner(otherSecret);
  const response = await fetch(relay.origin + '/api/logout?expectedAccount=' + relay.owner, {
    method: 'POST',
    headers: { Cookie: 'personal=' + otherSecret, Origin: relay.origin },
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(relay.store.owner(otherSecret), otherOwner);
  assert.equal(relay.store.owner(relay.secret), relay.owner);
});

test('a logout response delivered after a new login cannot clear the newer browser cookie', async (t) => {
  const relay = await syntheticRelay();
  let release: (() => void) | undefined;
  t.after(async () => {
    release?.();
    await relay.close();
  });
  const invitation = relay.store.inviteAccount(relay.owner);
  const email = 'late-login@synthetic.invalid',
    password = 'synthetic-password-only';
  const otherSecret = await relay.store.redeemAccountInvitation(
    invitation.invitation,
    email,
    password,
  );
  const otherOwner = relay.store.owner(otherSecret);
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  relay.app.server.prependListener('request', (request, response) => {
    if (!request.url?.startsWith('/api/logout')) return;
    const writeHead = response.writeHead.bind(response),
      end = response.end.bind(response);
    let headers: unknown[] = [];
    response.writeHead = ((...args: unknown[]) => {
      headers = args;
      return response;
    }) as typeof response.writeHead;
    response.end = ((...args: unknown[]) => {
      release = () => {
        release = undefined;
        Reflect.apply(writeHead, response, headers);
        Reflect.apply(end, response, args);
      };
      reached();
      return response;
    }) as typeof response.end;
  });
  const oldReply = fetch(relay.origin + '/api/logout?expectedAccount=' + relay.owner, {
    method: 'POST',
    headers: { Cookie: 'personal=' + relay.secret, Origin: relay.origin },
  });
  await waiting;
  assert.throws(() => relay.store.owner(relay.secret));
  const login = await fetch(relay.origin + '/api/login', {
    method: 'POST',
    headers: { Origin: relay.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  const browserCookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
  assert.equal(relay.store.owner(browserCookie.slice('personal='.length)), otherOwner);
  release!();
  const logout = await oldReply;
  assert.equal(logout.status, 200);
  assert.deepEqual(
    logout.headers.getSetCookie(),
    [],
    'the late response cannot overwrite the newer login',
  );
  const me = await fetch(relay.origin + '/api/me', { headers: { Cookie: browserCookie } });
  assert.equal((await me.json()).owner, otherOwner);
  const expired = await fetch(relay.origin + '/api/me', {
    headers: { Cookie: 'personal=' + relay.secret },
  });
  assert.equal((await expired.json()).owner, null, 'retaining a revoked cookie grants no identity');
});
