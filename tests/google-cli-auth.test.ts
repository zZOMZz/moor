import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliState } from '../src/cli/state';
import { CliGoogleAuth, CLI_GOOGLE_FAILED, CLI_GOOGLE_FLOW_KEY } from '../src/cli/google-auth';
import { Store, token } from '../src/relay/accounts';
import { createApp } from '../src/relay/http';
import type { GoogleIdentity, GoogleOidcProvider } from '../src/relay/google-oidc';

const NOW = 1_900_000_000_000;
const identity: GoogleIdentity = {
  issuer: 'https://accounts.google.com',
  subject: 'synthetic-google-cli',
  email: 'cli@synthetic.invalid',
  emailVerified: true,
};
type SavedFlow = {
  phase: string;
  revision: number;
  expiresAt: number;
  proof?: { flowId: string; secret: string };
  cookie?: string;
};
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, CLI_GOOGLE_FAILED);
  assert.equal(error.cause, undefined);
  return true;
};
async function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-google-cli-')));
  let state = new CliState(directory),
    now = NOW;
  const store = new Store(':memory:', () => now);
  store.setupGoogle(identity, 'synthetic-owner');
  const provider: GoogleOidcProvider = {
    authorizationUrl(input) {
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(input);
    },
    async exchangeAndVerify() {
      return identity;
    },
  };
  const app = createApp(store, {
    origin: 'http://127.0.0.1:0',
    setupToken: 'synthetic-setup',
    googleProvider: provider,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = 'http://127.0.0.1:' + (app.server.address() as { port: number }).port;
  app.setOrigin(origin);
  const calls: { url: string; headers: Headers; body: unknown }[] = [];
  let intercept: ((url: string, init: RequestInit) => Promise<Response | void>) | undefined;
  const request = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      headers: new Headers(init.headers),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    return (await intercept?.(url, init)) ?? fetch(input, init);
  }) as typeof fetch;
  const client = () => new CliGoogleAuth({ state, fetch: request, now: () => now });
  t.after(async () => {
    await app.close();
    store.close();
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function authorize(browserUrl: string) {
    const response = await fetch(browserUrl, { redirect: 'manual' });
    assert.equal(response.status, 303);
    const browserCookie = response.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    const url = new URL(response.headers.get('location')!);
    const callback = await fetch(
      origin +
        '/api/auth/google/callback?' +
        new URLSearchParams({
          state: url.searchParams.get('state')!,
          code: 'synthetic-authorization',
          iss: identity.issuer,
        }),
      { redirect: 'manual', headers: { Cookie: browserCookie } },
    );
    assert.equal(callback.status, 303);
    const headers = { Cookie: browserCookie, Origin: origin, 'Content-Type': 'application/json' };
    const review = await (await fetch(origin + '/api/auth/google/review', { headers })).json();
    const confirm = await fetch(origin + '/api/auth/google/confirm', {
      method: 'POST',
      headers,
      body: JSON.stringify({ flowId: review.flowId }),
    });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.headers.get('set-cookie'), null);
  }
  async function ready() {
    const started = await client().begin({ origin });
    await authorize(started.browserUrl);
    await client().review();
    return { started, input: { expectedEmail: identity.email, expectedCode: started.code } };
  }
  return {
    app,
    origin,
    store,
    calls,
    client,
    authorize,
    ready,
    directory,
    get state() {
      return state;
    },
    saved: () => state.get<SavedFlow>(CLI_GOOGLE_FLOW_KEY),
    reopen() {
      state.close();
      state = new CliState(directory);
    },
    advance(ms: number) {
      now += ms;
    },
    intercept(fn: typeof intercept) {
      intercept = fn;
    },
  };
}

test('Google CLI uses a real synthetic browser handoff, explicit review and confirmation, and private atomic credentials', async (t) => {
  const f = await fixture(t),
    begin = await f.client().begin({ origin: f.origin });
  assert.deepEqual(Object.keys(begin).sort(), ['browserUrl', 'code', 'expiresAt', 'origin']);
  assert.ok(f.saved()?.proof?.secret);
  assert.ok(!JSON.stringify(begin).includes(f.saved()!.proof!.secret));
  assert.equal(f.state.get('auth'), undefined);
  assert.equal((await f.client().review()).status, 'pending');
  await f.authorize(begin.browserUrl);
  f.reopen();
  // Browser confirmation alone cannot replace the explicit terminal review/confirmation.
  await assert.rejects(
    f.client().finish({ expectedEmail: identity.email, expectedCode: begin.code }),
    safeFailure,
  );
  const reviewed = await f.client().review();
  assert.equal(reviewed.status, 'ready');
  await assert.rejects(
    f.client().finish({ expectedEmail: 'other@synthetic.invalid', expectedCode: begin.code }),
    safeFailure,
  );
  await assert.rejects(
    f.client().finish({
      expectedEmail: identity.email,
      expectedCode: 'FFFF-FFFF' === begin.code ? '0000-0000' : 'FFFF-FFFF',
    }),
    safeFailure,
  );
  const result = await f
    .client()
    .finish({ expectedEmail: identity.email, expectedCode: begin.code });
  assert.deepEqual(result, {
    origin: f.origin,
    owner: 'synthetic-owner',
    email: identity.email,
    authenticated: true,
  });
  assert.equal(f.saved(), undefined);
  const auth = f.state.get<{
    kind: string;
    connection: { cookie: string; owner: string; origin: string };
  }>('auth')!;
  assert.equal(auth.kind, 'remote');
  assert.equal(f.store.owner(auth.connection.cookie.slice(9)), 'synthetic-owner');
  assert.ok(!JSON.stringify(result).includes(auth.connection.cookie));
  f.reopen();
  assert.deepEqual(f.state.get('auth'), auth);
  assert.equal(statSync(join(f.directory, 'moor-cli-v1.sqlite')).mode & 0o777, 0o600);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/desktop/finish')).length, 1);
  for (const call of f.calls) {
    assert.equal(call.headers.get('Origin'), f.origin);
    if (call.url.endsWith('/api/me'))
      assert.equal(call.headers.get('Cookie'), auth.connection.cookie);
    else assert.equal(call.headers.get('Cookie'), null);
    assert.ok(!call.url.includes('secret='));
  }
});

test('lost finish response is durable and no subsequent confirm resends it', async (t) => {
  const f = await fixture(t),
    { input } = await f.ready();
  f.intercept(async (url, init) => {
    if (!url.endsWith('/desktop/finish')) return;
    const res = await fetch(url, init);
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    throw Error('synthetic-secret-network');
  });
  await assert.rejects(f.client().finish(input), safeFailure);
  assert.equal(f.saved()?.phase, 'finishing');
  assert.equal(f.state.get('auth'), undefined);
  f.reopen();
  await assert.rejects(f.client().finish(input), safeFailure);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/desktop/finish')).length, 1);
  f.intercept(undefined);
  assert.deepEqual(await f.client().cancel(), { cancelled: true, serverConfirmed: false });
  assert.equal(f.saved(), undefined);
});

test('received cookie is private and manual retry only resumes identity validation', async (t) => {
  const f = await fixture(t),
    { input } = await f.ready();
  f.intercept(async (url) => {
    if (url.endsWith('/api/me')) throw Error('synthetic-me-offline');
  });
  await assert.rejects(f.client().finish(input), safeFailure);
  assert.equal(f.saved()?.phase, 'issued');
  const cookie = f.saved()!.cookie;
  assert.ok(cookie);
  assert.equal(f.state.get('auth'), undefined);
  f.reopen();
  f.intercept(undefined);
  await f.client().finish(input);
  assert.equal(f.calls.filter((c) => c.url.endsWith('/desktop/finish')).length, 1);
  assert.equal(f.state.get<{ connection: { cookie: string } }>('auth')?.connection.cookie, cookie);
});

test('cancelling a received but uninstalled cookie revokes it before clearing private state', async (t) => {
  const f = await fixture(t),
    { input } = await f.ready();
  f.intercept(async (url) => {
    if (url.endsWith('/api/me')) throw Error('synthetic-me-offline');
  });
  await assert.rejects(f.client().finish(input), safeFailure);
  const cookie = f.saved()!.cookie!;
  f.intercept(async (url) => {
    if (url.endsWith('/api/logout')) throw Error('synthetic-logout-offline');
  });
  await assert.rejects(f.client().cancel(), safeFailure);
  assert.equal(f.saved()?.phase, 'cancelling');
  assert.equal(f.saved()?.cookie, cookie);
  f.intercept(undefined);
  assert.deepEqual(await f.client().cancel(), { cancelled: true, serverConfirmed: true });
  assert.equal(f.saved(), undefined);
  assert.throws(() => f.store.owner(cookie.slice(9)));
  assert.equal(f.state.get('auth'), undefined);
});

test('private settings CAS is atomic, monotonic through ABA and shared across reopened connections', async (t) => {
  const f = await fixture(t),
    second = new CliState(f.directory);
  t.after(() => second.close());
  const old = f.state.settingsRevision();
  second.set('auth', { kind: 'synthetic' });
  second.set('auth', undefined);
  assert.equal(f.state.get('auth'), undefined);
  assert.equal(f.state.settingsRevision(), old + 2);
  assert.throws(() =>
    f.state.compareAndSetSettings(old, {
      auth: { bad: true },
      [CLI_GOOGLE_FLOW_KEY]: { bad: true },
    }),
  );
  assert.equal(f.state.get('auth'), undefined);
  assert.equal(f.saved(), undefined);
  const revision = f.state.settingsRevision();
  f.state.compareAndSetSettings(revision, {
    auth: { good: true },
    [CLI_GOOGLE_FLOW_KEY]: { good: true },
  });
  assert.deepEqual(second.get('auth'), { good: true });
  assert.deepEqual(second.get(CLI_GOOGLE_FLOW_KEY), { good: true });
});

test('real relay logout with a lost response is resolved by reading the same invalid cookie', async (t) => {
  const f = await fixture(t),
    { input } = await f.ready();
  f.intercept(async (url) => {
    if (url.endsWith('/api/me')) throw Error('synthetic-me-offline');
  });
  await assert.rejects(f.client().finish(input), safeFailure);
  const cookie = f.saved()!.cookie!;
  f.intercept(async (url, init) => {
    if (!url.endsWith('/api/logout')) return;
    const response = await fetch(url, init);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    throw Error('synthetic-logout-response-lost');
  });
  assert.deepEqual(await f.client().cancel(), { cancelled: true, serverConfirmed: true });
  assert.equal(f.saved(), undefined);
  assert.throws(() => f.store.owner(cookie.slice(9)));
  assert.equal(f.calls.filter((call) => call.url.endsWith('/desktop/finish')).length, 1);
  f.intercept(undefined);
  await f.client().begin({ origin: f.origin });
});

for (const stage of ['start', 'review', 'finish', 'identity'] as const)
  test(`concurrent auth change during ${stage} rejects the old login without overwriting current auth`, async (t) => {
    const f = await fixture(t);
    const alternate = {
      kind: 'remote',
      connection: { origin: f.origin, owner: 'synthetic-current', cookie: 'personal=' + token() },
    };
    const run =
      stage === 'start'
        ? () => f.client().begin({ origin: f.origin })
        : stage === 'review'
          ? (await f.ready(), () => f.client().review())
          : (() => undefined)();
    let input: { expectedEmail: string; expectedCode: string } | undefined;
    if (!run) ({ input } = await f.ready());
    const suffix =
      stage === 'start'
        ? '/start'
        : stage === 'review'
          ? '/desktop/review'
          : stage === 'finish'
            ? '/desktop/finish'
            : '/api/me';
    f.intercept(async (url, init) => {
      if (!url.endsWith(suffix)) return;
      const res = await fetch(url, init);
      f.state.set('auth', alternate);
      return res;
    });
    await assert.rejects(run ? run() : f.client().finish(input!), safeFailure);
    assert.deepEqual(f.state.get('auth'), alternate);
    const count = f.calls.length;
    await assert.rejects(f.client().review(), safeFailure);
    assert.equal(f.calls.length, count);
  });

test('Google begin sends no old credentials and binds a same-origin replacement to its previous owner', async (t) => {
  const f = await fixture(t);
  const old = {
    kind: 'remote',
    connection: {
      origin: f.origin,
      owner: 'different-synthetic-owner',
      cookie: 'personal=' + token(),
    },
  };
  f.state.set('auth', old);
  const { input } = await f.ready();
  await assert.rejects(f.client().finish(input), safeFailure);
  assert.deepEqual(f.state.get('auth'), old);
  assert.equal(f.saved()?.phase, 'issued');
  for (const call of f.calls.filter((c) => !c.url.endsWith('/api/me')))
    assert.equal(call.headers.get('Cookie'), null);
});

test('expiry, account removal and origin generation changes never silently resume a pending Google login', async (t) => {
  const f = await fixture(t);
  await f.client().begin({ origin: f.origin });
  f.advance(10 * 60 * 1000);
  const count = f.calls.length;
  await assert.rejects(f.client().review(), safeFailure);
  assert.equal(f.calls.length, count);
  await f.client().cancel();
  await f.client().begin({ origin: f.origin });
  f.app.setOrigin('https://other.synthetic.invalid');
  f.app.setOrigin(f.origin);
  await assert.rejects(f.client().review(), safeFailure);
  assert.equal(f.state.get('auth'), undefined);
});

for (const invalid of [
  'redirect',
  'content-type',
  'utf8',
  'size',
  'extra',
  'path',
  'expiry',
] as const)
  test(`Google start rejects ${invalid} responses with no credential exposure`, async (t) => {
    const f = await fixture(t);
    f.intercept(async (url, init) => {
      const res = await fetch(url, init);
      const body = await res.json();
      if (invalid === 'redirect')
        return new Response('', {
          status: 302,
          headers: { location: 'https://other.synthetic.invalid' },
        });
      if (invalid === 'content-type')
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'text/html' } });
      if (invalid === 'utf8')
        return new Response(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]), {
          headers: { 'content-type': 'application/json' },
        });
      if (invalid === 'size')
        return new Response(' '.repeat(4097), { headers: { 'content-type': 'application/json' } });
      if (invalid === 'extra') body.private = 'synthetic-secret';
      if (invalid === 'path') body.launchPath = '//other.synthetic.invalid';
      if (invalid === 'expiry') body.expiresAt = NOW + 15 * 60 * 1000 + 1;
      return Response.json(body);
    });
    await assert.rejects(f.client().begin({ origin: f.origin }), safeFailure);
    assert.equal(f.state.get('auth'), undefined);
    assert.equal(f.saved()?.phase, 'starting');
  });

for (const variant of [
  'domain',
  'duplicate',
  'missing-http-only',
  'two-cookies',
  'bad-value',
  'age',
] as const)
  test(`Google finish rejects ${variant} cookie attributes`, async (t) => {
    const f = await fixture(t),
      { input } = await f.ready();
    f.intercept(async (url, init) => {
      if (!url.endsWith('/desktop/finish')) return;
      const response = await fetch(url, init),
        body = await response.json();
      let cookie = response.headers.get('set-cookie')!;
      if (variant === 'domain') cookie += '; Domain=127.0.0.1';
      if (variant === 'duplicate') cookie += '; Path=/';
      if (variant === 'missing-http-only') cookie = cookie.replace('; HttpOnly', '');
      if (variant === 'bad-value')
        cookie = cookie.replace(/^personal=[^;]+/, 'personal=noncanonical');
      if (variant === 'age') cookie = cookie.replace(/Max-Age=\d+/, 'Max-Age=2592001');
      const headers = new Headers({ 'content-type': 'application/json', 'set-cookie': cookie });
      if (variant === 'two-cookies') headers.append('set-cookie', 'other=synthetic');
      return new Response(JSON.stringify(body), { headers });
    });
    await assert.rejects(f.client().finish(input), safeFailure);
    assert.equal(f.state.get('auth'), undefined);
    assert.equal(f.saved()?.phase, 'finishing');
  });

test('abort while a fetch ignores cancellation exits promptly and cannot publish a late result', async (t) => {
  const f = await fixture(t),
    aborted = new AbortController();
  let release: (response: Response) => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const client = new CliGoogleAuth({
    state: f.state,
    now: () => NOW,
    signal: aborted.signal,
    fetch: (() => {
      entered();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as typeof fetch,
  });
  const running = client.begin({ origin: f.origin });
  await started;
  aborted.abort();
  await assert.rejects(running, safeFailure);
  const before = f.state.settingsRevision();
  release(
    Response.json({
      flowId: token(),
      secret: token(),
      code: 'AAAA-BBBB',
      expiresAt: NOW + 1000,
      launchPath: '/untrusted',
    }),
  );
  await Promise.resolve();
  assert.equal(f.state.settingsRevision(), before);
  assert.equal(f.state.get('auth'), undefined);
});
