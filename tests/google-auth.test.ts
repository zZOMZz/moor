import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Store, token } from '../src/relay/accounts';
import { createApp } from '../src/relay/http';
import type { GoogleIdentity, GoogleOidcProvider } from '../src/relay/google-oidc';

const prefix = '/api/auth/google';
const identity: GoogleIdentity = {
  issuer: 'https://accounts.google.com',
  subject: 'synthetic-subject',
  email: 'google@synthetic.invalid',
  emailVerified: true,
};
async function fixture(t: TestContext, config: { enabled?: boolean; localOnly?: boolean } = {}) {
  let now = 1_800_000_000_000;
  const store = new Store(':memory:', () => now);
  const exchanges: Parameters<GoogleOidcProvider['exchangeAndVerify']>[0][] = [];
  let exchange = async (
    _input: Parameters<GoogleOidcProvider['exchangeAndVerify']>[0],
  ): Promise<GoogleIdentity> => identity;
  const provider: GoogleOidcProvider = {
    authorizationUrl(input) {
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(input);
    },
    exchangeAndVerify(input) {
      exchanges.push(input);
      return exchange(input);
    },
  };
  const app = createApp(store, {
    origin: 'http://127.0.0.1:0',
    setupToken: 'synthetic-setup-token',
    ...(config.enabled === false ? {} : { googleProvider: provider }),
    localOnly: config.localOnly,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
  app.setOrigin(origin);
  t.after(async () => {
    await app.close();
    store.close();
  });
  const jar = new Map<string, string>();
  const cookies = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
  async function request(
    path: string,
    body?: unknown,
    overrides: { cookie?: string; origin?: string; bearer?: string; saveCookies?: boolean } = {},
  ) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: {
        Cookie: overrides.cookie ?? cookies(),
        ...(body === undefined
          ? {}
          : { 'Content-Type': 'application/json', Origin: overrides.origin ?? origin }),
        ...(overrides.bearer ? { Authorization: 'Bearer ' + overrides.bearer } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (overrides.saveCookies !== false)
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0]!,
          index = pair.indexOf('=');
        jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
    return response;
  }
  async function begin(
    input: Record<string, unknown> = { mode: 'setup', setupToken: 'synthetic-setup-token' },
  ) {
    const response = await request(prefix + '/start', input);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<{
      flowId: string;
      secret?: string;
      code: string;
      launchPath: string;
    }>;
  }
  async function authorize(flow: { launchPath: string }, query = '') {
    const response = await request(flow.launchPath);
    assert.equal(response.status, 303);
    const url = new URL(response.headers.get('location')!);
    const code = 'synthetic-authorization-code';
    const callback =
      prefix +
      '/callback?' +
      new URLSearchParams({ state: url.searchParams.get('state')!, code, iss: identity.issuer }) +
      query;
    // Simulate the cross-site top-level callback: only the Lax cookie is sent.
    return {
      callback,
      url,
      result: await request(callback, undefined, {
        cookie: 'moor_google_browser=' + jar.get('moor_google_browser'),
      }),
    };
  }
  async function passwordOwner() {
    const secret = await store.setup('owner@synthetic.invalid', 'synthetic-password-long', 'owner');
    jar.set('personal', secret);
    return secret;
  }
  return {
    app,
    store,
    origin,
    jar,
    request,
    begin,
    authorize,
    exchanges,
    passwordOwner,
    advance(ms: number) {
      now += ms;
    },
    setExchange(value: typeof exchange) {
      exchange = value;
    },
  };
}

test('Google browser setup verifies, reviews and explicitly confirms once before any account is created', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.request(prefix + '/start', { mode: 'setup', setupToken: 'wrong' })).status,
    403,
  );
  const flow = await f.begin();
  assert.equal(flow.secret, undefined);
  assert.match(flow.code, /^[A-F0-9]{4}-[A-F0-9]{4}$/);
  const { result, url } = await f.authorize(flow);
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), '/auth/google/complete');
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(f.store.hasAccount(), false);
  assert.equal(
    createHash('sha256').update(f.exchanges[0]!.codeVerifier).digest('base64url'),
    url.searchParams.get('codeChallenge'),
  );
  assert.equal(f.exchanges[0]!.nonce, url.searchParams.get('nonce'));
  const review = await (await f.request(prefix + '/review')).json();
  assert.deepEqual(review, {
    flowId: flow.flowId,
    mode: 'setup',
    desktop: false,
    code: flow.code,
    email: identity.email,
  });
  const finish = await f.request(prefix + '/confirm', { flowId: flow.flowId });
  assert.equal(finish.status, 200);
  assert.match(finish.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  const me = await (await f.request('/api/me')).json();
  assert.equal(me.google.enabled, true);
  assert.deepEqual(me.google.linked, { email: identity.email });
  assert.equal(me.google.hasPassword, false);
  assert.equal((await f.request(prefix + '/confirm', { flowId: flow.flowId })).status, 401);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM login').get()!.n, 1);
});

test('existing password account requires explicit binding; same Google email never auto-links', async (t) => {
  const f = await fixture(t);
  const secret = await f.passwordOwner();
  const device = f.store.redeem(f.store.pair('owner'), 'synthetic Mac');
  assert.equal(
    (await f.request(prefix + '/start', { mode: 'link', password: 'wrong' })).status,
    401,
  );
  const flow = await f.begin({ mode: 'link', password: 'synthetic-password-long' });
  await f.authorize(flow);
  assert.equal(f.store.googleIdentity('owner'), null);
  const confirm = await f.request(prefix + '/confirm', { flowId: flow.flowId });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.headers.get('set-cookie'), null);
  assert.equal(f.store.owner(secret), 'owner');
  assert.equal(f.store.deviceToken(device.token).owner, 'owner');
  f.jar.delete('personal');
  f.setExchange(async () => ({ ...identity, subject: 'same-email-different-sub' }));
  const wrong = await f.begin({ mode: 'login' });
  await f.authorize(wrong);
  assert.equal((await f.request(prefix + '/confirm', { flowId: wrong.flowId })).status, 401);
  assert.equal(f.jar.has('personal'), false);
  f.setExchange(async () => identity);
  const login = await f.begin({ mode: 'login' });
  await f.authorize(login);
  assert.equal((await f.request(prefix + '/confirm', { flowId: login.flowId })).status, 200);
  assert.equal((await (await f.request('/api/me')).json()).owner, 'owner');
});

test('desktop handoff needs browser confirmation and private proof; public launch ID cannot obtain a login', async (t) => {
  const f = await fixture(t);
  f.store.setupGoogle(identity, 'owner');
  const flow = await f.begin({ mode: 'login', desktop: true });
  assert.match(flow.secret!, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!flow.launchPath.includes(flow.secret!));
  const proof = { flowId: flow.flowId, secret: flow.secret };
  assert.equal((await f.request(prefix + '/desktop/finish', proof)).status, 409);
  const callback = await f.authorize(flow);
  assert.equal(callback.result.headers.get('set-cookie'), null);
  assert.equal(
    (await (await f.request(prefix + '/desktop/review', proof)).json()).status,
    'pending',
  );
  assert.equal(
    (await f.request(prefix + '/desktop/review', { flowId: flow.flowId, secret: token() })).status,
    401,
  );
  assert.equal((await f.request(prefix + '/confirm', { flowId: flow.flowId })).status, 200);
  assert.equal(f.jar.has('personal'), false);
  assert.deepEqual(await (await f.request(prefix + '/desktop/review', proof)).json(), {
    status: 'ready',
    mode: 'login',
    email: identity.email,
  });
  assert.equal((await f.request(prefix + '/desktop/finish', proof, { cookie: '' })).status, 200);
  assert.equal((await f.request(prefix + '/desktop/finish', proof, { cookie: '' })).status, 401);
});

test('desktop linking preserves originating cookie and rejects sign-out or replacement before final claim', async (t) => {
  const f = await fixture(t);
  const original = await f.passwordOwner();
  const flow = await f.begin({ mode: 'link', desktop: true, password: 'synthetic-password-long' });
  await f.authorize(flow);
  f.jar.delete('personal'); // System browser has a separate session.
  assert.equal((await f.request(prefix + '/confirm', { flowId: flow.flowId })).status, 200);
  const proof = { flowId: flow.flowId, secret: flow.secret };
  const another = f.store.createLogin('owner');
  assert.equal(
    (await f.request(prefix + '/desktop/finish', proof, { cookie: 'personal=' + another })).status,
    401,
  );
  assert.equal(f.store.googleIdentity('owner'), null);
  const finish = await f.request(prefix + '/desktop/finish', proof, {
    cookie: 'personal=' + original,
  });
  assert.equal(finish.status, 200);
  assert.equal(finish.headers.get('set-cookie'), null);
  assert.equal(f.store.owner(original), 'owner');
});

test('callback requires exact single state, issuer and browser binding; reused callback never re-exchanges', async (t) => {
  const f = await fixture(t);
  const flow = await f.begin();
  const launch = await f.request(flow.launchPath);
  const url = new URL(launch.headers.get('location')!);
  const query = new URLSearchParams({
    code: 'synthetic-code',
    state: url.searchParams.get('state')!,
    iss: identity.issuer,
  });
  assert.equal(
    (await f.request(prefix + '/callback?' + query, undefined, { cookie: '' })).status,
    401,
  );
  const result = await f.request(prefix + '/callback?' + query);
  assert.equal(result.status, 303);
  assert.equal((await f.request(prefix + '/callback?' + query)).status, 409);
  assert.equal(f.exchanges.length, 1);
  for (const suffix of ['&code=second-code', '&state=second-state', '&iss=https://evil.invalid']) {
    const another = await f.begin();
    await f.authorize(another, suffix);
    assert.equal((await f.request(prefix + '/review')).status, 401);
  }
  assert.equal(f.exchanges.length, 1);
});

test('provider errors, missing issuer and cancellation fail closed without leaking secrets', async (t) => {
  const f = await fixture(t);
  const flow = await f.begin();
  f.setExchange(async () => {
    throw new Error('synthetic-private-google-token');
  });
  const { result } = await f.authorize(flow);
  assert.equal(result.status, 303);
  assert.equal((await f.request(prefix + '/review')).status, 401);
  assert.ok(!(await (await f.request(prefix + '/review')).text()).includes('synthetic-private'));
  const another = await f.begin();
  const launch = await f.request(another.launchPath);
  const state = new URL(launch.headers.get('location')!).searchParams.get('state')!;
  assert.equal(
    (await f.request(prefix + '/callback?' + new URLSearchParams({ state, code: 'code' }))).status,
    303,
  );
  assert.equal(f.exchanges.length, 1);
  assert.equal((await f.request(prefix + '/review')).status, 401);
});

test('cancel during token exchange, expiry and replacing relay origin cannot complete a stale login', async (t) => {
  const f = await fixture(t);
  let resolve!: (value: GoogleIdentity) => void, entered!: () => void;
  const enteredPromise = new Promise<void>((r) => {
    entered = r;
  });
  f.setExchange(() => {
    entered();
    return new Promise((r) => {
      resolve = r;
    });
  });
  const flow = await f.begin();
  const pending = f.authorize(flow);
  await enteredPromise;
  assert.equal((await f.request(prefix + '/cancel', { flowId: flow.flowId })).status, 200);
  resolve(identity);
  await pending;
  assert.equal((await f.request(prefix + '/review')).status, 401);
  assert.equal(f.store.hasAccount(), false);
  f.setExchange(async () => identity);
  const expired = await f.begin();
  await f.authorize(expired);
  f.advance(600001);
  assert.equal((await f.request(prefix + '/confirm', { flowId: expired.flowId })).status, 401);
  const stale = await f.begin();
  await f.authorize(stale);
  f.app.setOrigin(f.origin);
  assert.equal((await f.request(prefix + '/confirm', { flowId: stale.flowId })).status, 401);
});

test('link rejects original session logout or same-owner cookie replacement', async (t) => {
  const f = await fixture(t);
  const original = await f.passwordOwner();
  const flow = await f.begin({ mode: 'link', password: 'synthetic-password-long' });
  await f.authorize(flow);
  f.jar.set('personal', f.store.createLogin('owner'));
  assert.equal((await f.request(prefix + '/confirm', { flowId: flow.flowId })).status, 401);
  f.jar.set('personal', original);
  f.store.logout(original);
  assert.equal((await f.request(prefix + '/confirm', { flowId: flow.flowId })).status, 401);
  assert.equal(f.store.googleIdentity('owner'), null);
});

test('Google routes keep same-origin checks even with bearer; disabled and local-only hosts expose no login', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request(
        prefix + '/start',
        { mode: 'setup', setupToken: 'synthetic-setup-token' },
        { origin: 'https://evil.invalid', bearer: 'synthetic-bearer' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(prefix + '/start', {
        mode: 'setup',
        setupToken: 'synthetic-setup-token',
        arbitraryUrl: 'https://evil.invalid',
      })
    ).status,
    400,
  );
  for (const config of [{ enabled: false }, { localOnly: true }]) {
    const other = await fixture(t, config);
    assert.equal((await (await other.request('/api/me')).json()).google.enabled, false);
    assert.equal((await other.request(prefix + '/start', { mode: 'setup' })).status, 404);
  }
});

test('start and unlink share bounded attempt quota and injected time releases it', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await f.request(prefix + '/start', { mode: 'setup', setupToken: 'wrong' })).status,
      403,
    );
  assert.equal((await f.request(prefix + '/start', { mode: 'setup' })).status, 429);
  assert.equal((await f.request(prefix + '/unlink', { password: 'guess' })).status, 429);
  f.advance(60000);
  await f.begin();
});

test('concurrent expensive verification is bounded and logout while deriving cannot create a link attempt', async (t) => {
  const f = await fixture(t);
  const original = await f.passwordOwner();
  const resumes: (() => void)[] = [];
  let entered!: () => void;
  const enteredPromise = new Promise<void>((r) => {
    entered = r;
  });
  f.store.verifyPassword = async () => {
    await new Promise<void>((r) => {
      resumes.push(r);
      if (resumes.length === 4) entered();
    });
  };
  const pending = Array.from({ length: 4 }, () =>
    f.request(prefix + '/start', { mode: 'link', password: 'synthetic-password-long' }),
  );
  await enteredPromise;
  assert.equal(
    (await f.request(prefix + '/start', { mode: 'link', password: 'guess' })).status,
    429,
  );
  f.store.logout(original);
  resumes.forEach((r) => r());
  assert.deepEqual(
    (await Promise.all(pending)).map((r) => r.status),
    [401, 401, 401, 401],
  );
});

test('unlink requires password, preserves the current login and invalidates pending Google attempts', async (t) => {
  const f = await fixture(t);
  await f.passwordOwner();
  f.store.linkGoogle('owner', identity);
  const cookie = f.jar.get('personal')!;
  f.jar.delete('personal');
  const flow = await f.begin({ mode: 'login' });
  await f.authorize(flow);
  f.jar.set('personal', cookie);
  assert.equal((await f.request(prefix + '/unlink', { password: 'wrong' })).status, 401);
  assert.equal(
    (await f.request(prefix + '/unlink', { password: 'synthetic-password-long' })).status,
    200,
  );
  assert.equal((await f.request(prefix + '/confirm', { flowId: flow.flowId })).status, 401);
  assert.equal(f.store.owner(cookie), 'owner');
  assert.equal(f.store.googleIdentity('owner'), null);
});

test('simultaneous starts cannot exceed the live flow capacity after asynchronous reads', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 63; i++) {
    if (i && i % 8 === 0) f.advance(60000);
    await f.begin();
  }
  f.advance(60000);
  const requests = Array.from({ length: 4 }, () =>
    f.request(prefix + '/start', { mode: 'setup', setupToken: 'synthetic-setup-token' }),
  );
  const statuses = (await Promise.all(requests)).map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 429, 429, 429]);
});

test('changing the configured origin while password verification is pending invalidates the attempt', async (t) => {
  const f = await fixture(t);
  await f.passwordOwner();
  let resume!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  f.store.verifyPassword = async () => {
    entered();
    await new Promise<void>((r) => {
      resume = r;
    });
  };
  const pending = f.request(prefix + '/start', {
    mode: 'link',
    password: 'synthetic-password-long',
  });
  await ready;
  f.app.setOrigin(f.origin);
  resume();
  assert.equal((await pending).status, 503);
  assert.equal(f.store.googleIdentity('owner'), null);
});
