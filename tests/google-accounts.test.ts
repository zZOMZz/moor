import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/relay/accounts';
import { AppError } from '../src/protocol';
import type { GoogleIdentity } from '../src/relay/google-oidc';

const owner = 'synthetic-existing-owner',
  password = 'synthetic-local-password',
  originalEmail = 'password@synthetic.invalid';
const identity: GoogleIdentity = {
  issuer: 'https://accounts.google.com',
  subject: 'SyntheticGoogleSubject',
  email: 'google@synthetic.invalid',
  emailVerified: true,
};
const status = (code: number) => (error: unknown) =>
  error instanceof AppError && error.status === code;
function fixture(t: TestContext, disk = false) {
  const directory = disk ? mkdtempSync(join(tmpdir(), 'moor-google-accounts-')) : undefined;
  const file = directory ? join(directory, 'relay.sqlite') : ':memory:';
  let store = new Store(file, () => 1000);
  t.after(() => {
    store.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new Store(file, () => 2000);
      return store;
    },
  };
}
const rows = (store: Store, table: string) => store.db.prepare('SELECT * FROM ' + table).all();
const snapshot = (store: Store) =>
  Object.fromEntries(
    ['account', 'external_identity', 'login', 'pair', 'device', 'workspace', 'project'].map(
      (table) => [table, rows(store, table)],
    ),
  );

test('explicit Google linking preserves the existing owner, password, devices and catalog; email never merges identities', async (t) => {
  const { store } = fixture(t);
  const originalLogin = await store.setup(originalEmail, password, owner);
  const workspace = store.catalog.create(owner, 'Synthetic workspace');
  store.catalog.createProject(owner, workspace.id, 'Synthetic project', { kind: 'local' });
  const paired = store.redeem(
    store.pair(owner, workspace.id),
    'Synthetic device',
    'synthetic-device',
  );
  const before = snapshot(store),
    loginCount = rows(store, 'login').length;
  await store.verifyPassword(owner, password);
  assert.equal(rows(store, 'login').length, loginCount, 'reauthentication creates no login');
  await assert.rejects(store.verifyPassword(owner, 'incorrect'), status(401));
  assert.equal(rows(store, 'login').length, loginCount);
  assert.equal(store.googleIdentity(owner), null);
  store.linkGoogle(owner, identity);
  assert.deepEqual(store.googleIdentity(owner), { email: identity.email });
  assert.equal(
    rows(store, 'login').length,
    loginCount,
    'linking does not replace the current login',
  );
  assert.equal(store.owner(originalLogin), owner);
  assert.equal(store.deviceToken(paired.token).owner, owner);
  for (const table of ['account', 'login', 'pair', 'device', 'workspace', 'project'])
    assert.deepEqual(rows(store, table), before[table]);
  assert.throws(() => store.linkGoogle(owner, identity), status(409));
  assert.throws(
    () => store.linkGoogle(owner, { ...identity, subject: 'AnotherSubject' }),
    status(409),
  );
  assert.throws(() => store.loginGoogle({ ...identity, subject: 'AnotherSubject' }), status(401));
  assert.throws(
    () => store.loginGoogle({ ...identity, subject: identity.subject.toLowerCase() }),
    status(401),
  );
  assert.throws(() => store.setupGoogle(identity, 'another-owner'), status(409));
  assert.equal(rows(store, 'account').length, 1);
  const googleLogin = store.loginGoogle({
    ...identity,
    email: 'new-google-email@synthetic.invalid',
  });
  assert.equal(store.owner(googleLogin), owner);
  assert.deepEqual(store.googleIdentity(owner), { email: 'new-google-email@synthetic.invalid' });
  assert.deepEqual(
    rows(store, 'account'),
    before.account,
    'Google email changes do not change password login identity',
  );
  assert.equal(store.owner(await store.login(originalEmail.toUpperCase(), password)), owner);
  await assert.rejects(store.login('new-google-email@synthetic.invalid', password), status(401));
});

test('Google-first creates no usable password and cannot remove the last login method; unverified or foreign identities are rejected', async (t) => {
  const { store } = fixture(t);
  const login = store.setupGoogle(identity, owner);
  assert.equal(store.owner(login), owner);
  assert.equal(store.hasPassword(owner), false);
  assert.equal(store.hasPassword('missing'), false);
  assert.deepEqual(
    rows(store, 'account').map((row) => ({ salt: row.salt, password: row.password })),
    [{ salt: null, password: null }],
  );
  const before = snapshot(store);
  for (const input of ['', 'incorrect', 'x'.repeat(1025)]) {
    await assert.rejects(store.login(identity.email, input), status(401));
    await assert.rejects(store.verifyPassword(owner, input), status(401));
  }
  await assert.rejects(store.verifyPassword('missing', password), status(401));
  assert.throws(() => store.unlinkGoogle(owner), status(409));
  assert.deepEqual(snapshot(store), before);
  for (const invalid of [
    { ...identity, issuer: 'https://other.synthetic.invalid' },
    { ...identity, issuer: 'accounts.google.com' },
    { ...identity, emailVerified: false },
    { ...identity, emailVerified: 'true' },
    { ...identity, subject: '' },
    { ...identity, subject: 'x'.repeat(256) },
    { ...identity, subject: 'contains space' },
    { ...identity, email: 'invalid\n@synthetic.invalid' },
    { ...identity, email: 'two@@synthetic.invalid' },
  ]) {
    for (const call of [
      () => store.setupGoogle(invalid as GoogleIdentity),
      () => store.linkGoogle(owner, invalid as GoogleIdentity),
      () => store.loginGoogle(invalid as GoogleIdentity),
    ])
      assert.throws(call, status(401));
  }
  assert.deepEqual(snapshot(store), before);
});

test('external identity schema enforces issuer/subject uniqueness, one Google per owner and the owner foreign key', async (t) => {
  const { store } = fixture(t);
  await store.setup(originalEmail, password, owner);
  store.linkGoogle(owner, identity);
  store.db
    .prepare('INSERT INTO account(id,email,salt,password) VALUES(?,?,NULL,NULL)')
    .run('second-synthetic-owner', 'second@synthetic.invalid');
  assert.throws(() => store.linkGoogle('second-synthetic-owner', identity), status(409));
  assert.throws(
    () => store.linkGoogle('missing-owner', { ...identity, subject: 'DistinctSubject' }),
    status(404),
  );
  const insert = store.db.prepare('INSERT INTO external_identity VALUES(?,?,?,?,?,?)');
  assert.throws(
    () =>
      insert.run(identity.issuer, identity.subject, 'second-synthetic-owner', identity.email, 1, 1),
    /UNIQUE/,
  );
  assert.throws(
    () => insert.run(identity.issuer, 'DistinctSubject', owner, identity.email, 1, 1),
    /UNIQUE/,
  );
  assert.throws(
    () => insert.run(identity.issuer, 'DistinctSubject', 'missing-owner', identity.email, 1, 1),
    /FOREIGN KEY/,
  );
  assert.throws(
    () =>
      insert.run(
        'https://other.synthetic.invalid',
        'DistinctSubject',
        'second-synthetic-owner',
        identity.email,
        1,
        1,
      ),
    /CHECK/,
  );
  assert.equal(rows(store, 'external_identity').length, 1);
});

test('Google setup, linking, login email refresh and unlink roll back on durable write failures', async (t) => {
  for (const table of ['external_identity', 'login']) {
    const { store } = fixture(t);
    store.db.exec(
      `CREATE TRIGGER fail_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END`,
    );
    assert.throws(() => store.setupGoogle(identity, owner), /synthetic write failure/);
    for (const name of ['account', 'external_identity', 'login'])
      assert.deepEqual(rows(store, name), []);
  }
  const { store } = fixture(t);
  await store.setup(originalEmail, password, owner);
  const beforeLink = snapshot(store);
  store.db.exec(
    "CREATE TRIGGER fail_identity BEFORE INSERT ON external_identity BEGIN SELECT RAISE(ABORT,'synthetic identity failure'); END",
  );
  assert.throws(() => store.linkGoogle(owner, identity), /synthetic identity failure/);
  assert.deepEqual(snapshot(store), beforeLink);
  store.db.exec('DROP TRIGGER fail_identity');
  store.linkGoogle(owner, identity);
  const beforeLogin = snapshot(store);
  store.db.exec(
    "CREATE TRIGGER fail_login BEFORE INSERT ON login BEGIN SELECT RAISE(ABORT,'synthetic login failure'); END",
  );
  assert.throws(
    () => store.loginGoogle({ ...identity, email: 'changed@synthetic.invalid' }),
    /synthetic login failure/,
  );
  assert.deepEqual(snapshot(store), beforeLogin);
  store.db.exec('DROP TRIGGER fail_login');
  store.db.exec(
    "CREATE TRIGGER fail_unlink BEFORE DELETE ON external_identity BEGIN SELECT RAISE(ABORT,'synthetic unlink failure'); END",
  );
  assert.throws(() => store.unlinkGoogle(owner), /synthetic unlink failure/);
  assert.deepEqual(snapshot(store), beforeLogin);
});

test('password setup and Google-first setup race without leaving a second account or partial login', async (t) => {
  const { store } = fixture(t);
  const passwordSetup = store.setup(originalEmail, password, owner);
  const googleLogin = store.setupGoogle(identity, 'synthetic-google-first-owner');
  await assert.rejects(passwordSetup, status(409));
  assert.equal(store.owner(googleLogin), 'synthetic-google-first-owner');
  assert.equal(rows(store, 'account').length, 1);
  assert.equal(rows(store, 'external_identity').length, 1);
  assert.equal(rows(store, 'login').length, 1);
  const fresh = fixture(t).store;
  fresh.db.exec(
    "CREATE TRIGGER fail_login BEFORE INSERT ON login BEGIN SELECT RAISE(ABORT,'synthetic login failure'); END",
  );
  await assert.rejects(fresh.setup(originalEmail, password, owner), /synthetic login failure/);
  assert.deepEqual(rows(fresh, 'account'), []);
});

test('password verification and login cannot accept a password snapshot changed during derivation', async (t) => {
  const { store } = fixture(t);
  await store.setup(originalEmail, password, owner);
  const account = rows(store, 'account')[0]!,
    beforeLogins = rows(store, 'login');
  const verifying = store.verifyPassword(owner, password);
  store.db.prepare('UPDATE account SET salt=? WHERE id=?').run('synthetic-changed-salt', owner);
  await assert.rejects(verifying, status(401));
  store.db.prepare('UPDATE account SET salt=? WHERE id=?').run(account.salt!, owner);
  const loggingIn = store.login(originalEmail, password);
  store.db
    .prepare('UPDATE account SET email=? WHERE id=?')
    .run('recovered@synthetic.invalid', owner);
  await assert.rejects(loggingIn, status(401));
  assert.deepEqual(rows(store, 'login'), beforeLogins);
});

test('malformed stored password records fail safely and never authorize removing Google, but operator recovery can repair them', async (t) => {
  const { store } = fixture(t);
  store.setupGoogle(identity, owner);
  const beforeLogins = rows(store, 'login');
  for (const storedPassword of [Buffer.alloc(0), Buffer.alloc(1), 'synthetic-malformed-hash']) {
    store.db
      .prepare('UPDATE account SET salt=?,password=? WHERE id=?')
      .run('synthetic-salt', storedPassword, owner);
    assert.equal(store.hasPassword(owner), false);
    await assert.rejects(store.login(identity.email, password), status(401));
    await assert.rejects(store.verifyPassword(owner, password), status(401));
    assert.throws(() => store.unlinkGoogle(owner), status(409));
  }
  assert.deepEqual(rows(store, 'login'), beforeLogins);
  await store.resetPassword(originalEmail, password);
  assert.equal(store.hasPassword(owner), true);
  assert.equal(store.owner(await store.login(originalEmail, password)), owner);
  assert.deepEqual(store.googleIdentity(owner), { email: identity.email });
});

test('private password recovery preserves owner, devices and Google identity while revoking every login and pairing code', async (t) => {
  const { store } = fixture(t);
  const oldGoogleLogin = store.setupGoogle(identity, owner);
  const paired = store.redeem(store.pair(owner), 'Synthetic device', 'synthetic-device');
  const unusedPair = store.pair(owner),
    beforeDevice = rows(store, 'device'),
    beforeIdentity = rows(store, 'external_identity');
  const newPassword = 'synthetic-recovered-password';
  await store.resetPassword('RECOVERED@synthetic.invalid', newPassword);
  assert.equal(store.hasPassword(owner), true);
  assert.equal(rows(store, 'account')[0]!.id, owner);
  assert.equal(rows(store, 'account')[0]!.email, 'recovered@synthetic.invalid');
  assert.deepEqual(rows(store, 'device'), beforeDevice);
  assert.deepEqual(rows(store, 'external_identity'), beforeIdentity);
  assert.deepEqual(rows(store, 'login'), []);
  assert.deepEqual(rows(store, 'pair'), []);
  assert.throws(() => store.owner(oldGoogleLogin), status(401));
  assert.throws(() => store.redeem(unusedPair, 'Unwanted device'), status(401));
  assert.equal(store.deviceToken(paired.token).owner, owner);
  assert.equal(store.owner(await store.login('recovered@synthetic.invalid', newPassword)), owner);
  assert.equal(store.owner(store.loginGoogle(identity)), owner);
  await assert.rejects(store.login(identity.email, newPassword), status(401));
  store.unlinkGoogle(owner);
  assert.equal(store.googleIdentity(owner), null);
  assert.throws(() => store.loginGoogle(identity), status(401));
  assert.equal(store.owner(await store.login('recovered@synthetic.invalid', newPassword)), owner);
});

test('operator recovery rolls back password and revocations on failure and refuses missing, ambiguous or changed owners', async (t) => {
  const { store } = fixture(t);
  const oldLogin = await store.setup(originalEmail, password, owner);
  store.linkGoogle(owner, identity);
  const code = store.pair(owner),
    before = snapshot(store);
  store.db.exec(
    "CREATE TRIGGER fail_pair_revoke BEFORE DELETE ON pair BEGIN SELECT RAISE(ABORT,'synthetic revocation failure'); END",
  );
  await assert.rejects(
    store.resetPassword('recovered@synthetic.invalid', 'synthetic-recovered-password'),
    /synthetic revocation failure/,
  );
  assert.deepEqual(snapshot(store), before);
  assert.equal(store.owner(oldLogin), owner);
  store.db.exec('DROP TRIGGER fail_pair_revoke');
  assert.ok(store.redeem(code, 'Synthetic device'));
  const recovering = store.resetPassword(
    'recovered@synthetic.invalid',
    'synthetic-recovered-password',
  );
  store.db.prepare('UPDATE account SET email=? WHERE id=?').run('changed@synthetic.invalid', owner);
  await assert.rejects(recovering, status(409));
  assert.equal(store.owner(oldLogin), owner);
  const empty = fixture(t).store;
  await assert.rejects(empty.resetPassword(originalEmail, password), status(409));
  for (const value of ['short', 'x'.repeat(1025)])
    await assert.rejects(store.resetPassword(originalEmail, value), status(400));
  store.db
    .prepare('INSERT INTO account(id,email,salt,password) VALUES(?,?,NULL,NULL)')
    .run('second', 'second@synthetic.invalid');
  await assert.rejects(store.resetPassword(originalEmail, password), status(409));
});

test('existing relay databases gain external identities without changing local credentials and restore Google links after reopen', async (t) => {
  const f = fixture(t, true),
    store = f.store;
  const secret = await store.setup(originalEmail, password, owner),
    account = rows(store, 'account');
  store.db.exec('DROP TABLE external_identity');
  const migrated = f.reopen();
  assert.deepEqual(rows(migrated, 'account'), account);
  assert.equal(migrated.owner(secret), owner);
  migrated.linkGoogle(owner, identity);
  const googleLogin = migrated.loginGoogle({ ...identity, email: 'LATEST@synthetic.invalid' });
  const reopened = f.reopen();
  assert.equal(reopened.owner(googleLogin), owner);
  assert.deepEqual(reopened.googleIdentity(owner), { email: 'LATEST@synthetic.invalid' });
  assert.equal(reopened.hasPassword(owner), true);
  assert.equal(reopened.owner(await reopened.login(originalEmail, password)), owner);
  assert.deepEqual(rows(reopened, 'account'), account);
});
