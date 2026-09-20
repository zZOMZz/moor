import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@moor/gateway/accounts';

test('account invitations are hashed, expiring, single-use and grant no workspace access', async (t) => {
  let now = 1000;
  const store = new Store(':memory:', () => now);
  t.after(() => store.close());
  const login = await store.setup('owner@synthetic.invalid', 'synthetic-password-only'),
    owner = store.owner(login);
  const workspace = store.catalog.defaultWorkspace(owner),
    invitation = store.inviteAccount(owner);
  assert.notEqual(
    store.db.prepare('SELECT token FROM account_invitation').get()!.token,
    invitation.invitation,
  );
  const results = await Promise.allSettled([
    store.redeemAccountInvitation(
      invitation.invitation,
      'first@synthetic.invalid',
      'synthetic-password-only',
    ),
    store.redeemAccountInvitation(
      invitation.invitation,
      'second@synthetic.invalid',
      'synthetic-password-only',
    ),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const accepted = results.find((result) => result.status === 'fulfilled');
  assert.ok(accepted?.status === 'fulfilled');
  const member = store.owner(accepted.value);
  assert.notEqual(member, owner);
  assert.throws(() => store.catalog.collaborationAccess(member, workspace), /权限/);
  const expired = store.inviteAccount(owner);
  now = expired.expiresAt;
  await assert.rejects(
    store.redeemAccountInvitation(
      expired.invitation,
      'late@synthetic.invalid',
      'synthetic-password-only',
    ),
    /过期/,
  );
});
