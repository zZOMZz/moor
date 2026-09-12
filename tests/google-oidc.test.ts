import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import {
  createGoogleOidcProvider,
  GOOGLE_ISSUER,
  GOOGLE_OIDC_FAILED,
  type GoogleOidcConfig,
} from '../src/relay/google-oidc';

const NOW = 1_800_000_000_000;
const config: GoogleOidcConfig = {
  clientId: 'synthetic-client.apps.googleusercontent.com',
  clientSecret: 'synthetic-server-only-secret',
  redirectUri: 'https://moor.example/api/auth/google/callback',
};
const verifier = 'v'.repeat(43);
const nonce = 'n'.repeat(43);
const state = 's'.repeat(43);
const code = 'synthetic-one-use-code';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const first = await generateKeyPair('RS256');
const second = await generateKeyPair('RS256');
const ec = await generateKeyPair('ES256');
const jwkA = { ...(await exportJWK(first.publicKey)), kid: 'first', alg: 'RS256', use: 'sig' };
const jwkB = { ...(await exportJWK(second.publicKey)), kid: 'second', alg: 'RS256', use: 'sig' };
const baseClaims = {
  iss: GOOGLE_ISSUER,
  sub: 'Synthetic-Google-Subject',
  aud: config.clientId,
  iat: NOW / 1000,
  exp: NOW / 1000 + 3600,
  nonce,
  email: 'synthetic@example.test',
  email_verified: true,
};
async function signed(
  changes: JWTPayload = {},
  key = first.privateKey,
  header: { alg: string; kid?: string; [name: string]: unknown } = { alg: 'RS256', kid: 'first' },
) {
  return new SignJWT({ ...baseClaims, ...changes }).setProtectedHeader(header).sign(key);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
const safeFailure = (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, GOOGLE_OIDC_FAILED);
  assert.equal(error.cause, undefined);
  assert.ok(!String(error.stack).includes(config.clientSecret));
  return true;
};

async function fixture() {
  const calls: { url: string; init: RequestInit }[] = [];
  const timers = new Set<() => void>();
  const f = {
    now: NOW,
    idToken: await signed(),
    jwks: { keys: [jwkA] },
    jwksHeaders: { 'cache-control': 'public, max-age=3600' } as Record<string, string>,
    respond: undefined as
      | undefined
      | ((url: string, init: RequestInit) => Response | Promise<Response> | undefined),
    calls,
    timers,
  };
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    const override = f.respond?.(url, init);
    if (override !== undefined) return override;
    if (url === 'https://oauth2.googleapis.com/token')
      return json({ id_token: f.idToken, access_token: 'synthetic-discarded-access-token' });
    assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs');
    return json(f.jwks, f.jwksHeaders);
  };
  const provider = createGoogleOidcProvider(config, {
    fetch,
    now: () => f.now,
    scheduleTimeout(callback, ms) {
      assert.equal(ms, 10_000);
      timers.add(callback);
      return () => timers.delete(callback);
    },
  });
  return {
    ...f,
    state: f,
    provider,
    exchange: (input = { code, codeVerifier: verifier, nonce }) =>
      provider.exchangeAndVerify(input),
    keyRequests: () => calls.filter((call) => call.url.endsWith('/certs')).length,
  };
}

test('Google authorization uses only the fixed code endpoint, minimal scope, nonce and S256', () => {
  const source = { ...config };
  const provider = createGoogleOidcProvider(source);
  source.clientSecret = 'changed-secret';
  source.clientId = 'changed-client';
  source.redirectUri = 'https://elsewhere.example/';
  const url = new URL(provider.authorizationUrl({ state, nonce, codeChallenge: challenge }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  assert.ok(!url.href.includes(config.clientSecret));
  for (const input of [
    { state: 'weak', nonce, codeChallenge: challenge },
    { state, nonce: 'invalid&nonce', codeChallenge: challenge },
    { state, nonce, codeChallenge: 'plain-pkce' },
  ])
    assert.throws(() => provider.authorizationUrl(input), safeFailure);
});

test('Google configuration rejects insecure or noncanonical redirects without exposing values', () => {
  for (const value of [
    { clientId: '' },
    { clientSecret: 'a\nsecret' },
    { redirectUri: 'http://moor.example/callback' },
    { redirectUri: 'https://user:secret@moor.example/callback' },
    { redirectUri: 'https://moor.example/callback?secret=value' },
    { redirectUri: 'https://moor.example/callback#token' },
    { redirectUri: 'https://MOOR.example/callback' },
    { redirectUri: 'http://192.168.1.10/callback' },
    { redirectUri: 'http://localhost.attacker.example/callback' },
    { redirectUri: 'http://127.1/callback' },
    { redirectUri: 'http://localhost/callback?secret=value' },
    { redirectUri: 'http://localhost/callback#token' },
    { redirectUri: 'http://user:secret@127.0.0.1/callback' },
  ])
    assert.throws(() => createGoogleOidcProvider({ ...config, ...value }), safeFailure);
});

test('Google local testing allows canonical loopback HTTP redirects only', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const redirectUri = `http://${host}:8080/api/auth/google/callback`;
    const provider = createGoogleOidcProvider({ ...config, redirectUri });
    const url = new URL(provider.authorizationUrl({ state, nonce, codeChallenge: challenge }));
    assert.equal(url.searchParams.get('redirect_uri'), redirectUri);
  }
});

test('Google exchange verifies a real synthetic signature and returns only a canonical identity', async () => {
  const f = await fixture();
  assert.deepEqual(await f.exchange(), {
    issuer: GOOGLE_ISSUER,
    subject: baseClaims.sub,
    email: baseClaims.email,
    emailVerified: true,
  });
  const request = f.calls[0];
  assert.equal(request.url, 'https://oauth2.googleapis.com/token');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request.init.body as string)), {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code,
    code_verifier: verifier,
  });
  assert.equal(
    new Headers(request.init.headers).get('content-type'),
    'application/x-www-form-urlencoded',
  );
  assert.equal(f.keyRequests(), 1);
  assert.equal(f.timers.size, 0);
  f.state.idToken = await signed({
    iss: 'accounts.google.com',
    aud: [config.clientId],
    azp: config.clientId,
  });
  assert.equal((await f.exchange()).issuer, GOOGLE_ISSUER);
  assert.equal(f.keyRequests(), 1);
});

test('Google exchange rejects invalid flow material before a network request', async () => {
  const f = await fixture();
  for (const input of [
    { code: '', codeVerifier: verifier, nonce },
    { code: 'x'.repeat(4097), codeVerifier: verifier, nonce },
    { code, codeVerifier: 'short', nonce },
    { code, codeVerifier: verifier, nonce: 'short' },
    { code: 'code\r\nsecret', codeVerifier: verifier, nonce },
  ])
    await assert.rejects(f.exchange(input), safeFailure);
  assert.equal(f.calls.length, 0);
});

test('Google exchange retains its original nonce while a request is pending', async () => {
  const f = await fixture();
  const started = deferred<void>();
  const response = deferred<Response>();
  f.state.respond = (url) => {
    if (!url.endsWith('/token')) return;
    started.resolve();
    return response.promise;
  };
  const input = { code, codeVerifier: verifier, nonce };
  const result = f.exchange(input);
  await started.promise;
  input.nonce = 'different'.repeat(8);
  response.resolve(json({ id_token: f.state.idToken }));
  assert.equal((await result).subject, baseClaims.sub);
});

test('Google signed claim validation rejects every identity and replay mismatch', async (t) => {
  const cases: [string, JWTPayload][] = [
    ['wrong issuer', { iss: 'https://attacker.example' }],
    ['missing issuer', { iss: undefined }],
    ['wrong audience', { aud: 'another-client' }],
    ['additional audience', { aud: [config.clientId, 'untrusted-client'] }],
    ['duplicate audience', { aud: [config.clientId, config.clientId] }],
    ['wrong authorized party', { azp: 'untrusted-client' }],
    ['non-string authorized party', { azp: [config.clientId] }],
    ['expired', { exp: NOW / 1000 - 1 }],
    ['expires now', { exp: NOW / 1000 }],
    ['fractional expiration', { exp: NOW / 1000 + 0.5 }],
    ['missing expiration', { exp: undefined }],
    ['future issued time', { iat: NOW / 1000 + 31 }],
    ['old issued time', { iat: NOW / 1000 - 631 }],
    ['fractional issued time', { iat: NOW / 1000 + 0.5 }],
    ['missing issued time', { iat: undefined }],
    ['not active', { nbf: NOW / 1000 + 31 }],
    ['wrong nonce', { nonce: 'm'.repeat(43) }],
    ['different nonce length', { nonce: 'm'.repeat(44) }],
    ['missing nonce', { nonce: undefined }],
    ['missing subject', { sub: undefined }],
    ['empty subject', { sub: '' }],
    ['long subject', { sub: 'x'.repeat(256) }],
    ['non-ASCII subject', { sub: '用户' }],
    ['email not verified', { email_verified: false }],
    ['email verified string is not boolean', { email_verified: 'true' }],
    ['missing verified flag', { email_verified: undefined }],
    ['missing email', { email: undefined }],
    ['malformed email', { email: 'user@@example.test' }],
    ['email with controls', { email: 'user\n@example.test' }],
  ];
  const f = await fixture();
  for (const [name, changes] of cases)
    await t.test(name, async () => {
      f.state.idToken = await signed(changes);
      await assert.rejects(f.exchange(), safeFailure);
      assert.equal(f.timers.size, 0);
    });
});

test('Google JWT rejects wrong signatures, algorithms and token-provided key endpoints', async () => {
  const f = await fixture();
  const tokens = [
    await signed({}, second.privateKey),
    await signed({}, ec.privateKey, { alg: 'ES256', kid: 'first' }),
    await signed({}, first.privateKey, { alg: 'RS256' }),
    await signed({}, first.privateKey, {
      alg: 'RS256',
      kid: 'first',
      jku: 'https://attacker.example/keys',
    }),
    await signed({}, first.privateKey, {
      alg: 'RS256',
      kid: 'first',
      x5u: 'https://attacker.example/cert',
    }),
    await signed({}, first.privateKey, { alg: 'RS256', kid: 'first', jwk: jwkA }),
    Buffer.from('{"alg":"none","kid":"first"}').toString('base64url') +
      '.' +
      Buffer.from(JSON.stringify(baseClaims)).toString('base64url') +
      '.',
    'x'.repeat(16_385),
    'invalid.jwt.value',
  ];
  for (const token of tokens) {
    f.state.idToken = token;
    await assert.rejects(f.exchange(), safeFailure);
  }
  assert.ok(
    f.calls.every((call) =>
      [
        'https://oauth2.googleapis.com/token',
        'https://www.googleapis.com/oauth2/v3/certs',
      ].includes(call.url),
    ),
  );
});

test('Google key rotation refreshes a fresh set once and unknown kids cannot flood JWKS', async () => {
  const f = await fixture();
  await f.exchange();
  f.state.idToken = await signed({}, second.privateKey, { alg: 'RS256', kid: 'second' });
  f.state.jwks = { keys: [jwkB] };
  await assert.rejects(f.exchange(), safeFailure);
  assert.equal(f.keyRequests(), 1, 'unknown kid refresh has a short cooldown');
  f.state.now += 30_000;
  assert.equal((await f.exchange()).subject, baseClaims.sub);
  assert.equal(f.keyRequests(), 2);
  f.state.idToken = await signed({}, first.privateKey, { alg: 'RS256', kid: 'absent' });
  await Promise.all([
    assert.rejects(f.exchange(), safeFailure),
    assert.rejects(f.exchange(), safeFailure),
  ]);
  assert.equal(f.keyRequests(), 2);
  f.state.now += 30_000;
  await assert.rejects(f.exchange(), safeFailure);
  assert.equal(f.keyRequests(), 3, 'a refreshed set missing the key is not fetched twice');
  await assert.rejects(f.exchange(), safeFailure);
  assert.equal(f.keyRequests(), 3);
});

test('Google concurrent exchanges share one JWKS request', async () => {
  const f = await fixture();
  const started = deferred<void>();
  const response = deferred<Response>();
  f.state.respond = (url) => {
    if (!url.endsWith('/certs')) return;
    started.resolve();
    return response.promise;
  };
  const firstLogin = f.exchange();
  const secondLogin = f.exchange();
  await started.promise;
  response.resolve(json(f.state.jwks, f.state.jwksHeaders));
  const identities = await Promise.all([firstLogin, secondLogin]);
  assert.equal(identities.length, 2);
  assert.equal(f.keyRequests(), 1);
});

test('Google cache respects Age, no-store and expiry without accepting stale keys on failure', async () => {
  const f = await fixture();
  f.state.jwksHeaders = { 'cache-control': 'public, max-age=10', age: '9' };
  await f.exchange();
  f.state.now += 999;
  await f.exchange();
  assert.equal(f.keyRequests(), 1);
  f.state.now += 1;
  f.state.respond = (url) =>
    url.endsWith('/certs') ? new Response('private diagnostic', { status: 500 }) : undefined;
  await assert.rejects(f.exchange(), safeFailure);
  assert.equal(f.keyRequests(), 2);
  f.state.respond = undefined;
  f.state.jwksHeaders = { 'cache-control': 'no-store, max-age=1000' };
  await f.exchange();
  await f.exchange();
  assert.equal(f.keyRequests(), 4);
  f.state.jwksHeaders = { 'cache-control': 'no-cache="set-cookie", max-age=1000' };
  await f.exchange();
  await f.exchange();
  assert.equal(f.keyRequests(), 6);
});

test('Google rejects malformed, duplicate or excessive public keys', async () => {
  for (const keys of [
    [],
    [jwkA, jwkA],
    Array.from({ length: 33 }, (_, index) => ({ ...jwkA, kid: String(index) })),
    [{ ...jwkA, kty: 'oct', k: 'private' }],
    [{ ...jwkA, use: 'enc' }],
    [{ ...jwkA, alg: 'RS512' }],
    [{ ...jwkA, d: 'private-value' }],
    [{ ...jwkA, n: 'short' }],
  ]) {
    const f = await fixture();
    f.state.respond = (url) => (url.endsWith('/certs') ? json({ keys }) : undefined);
    await assert.rejects(f.exchange(), safeFailure);
    assert.equal(f.keyRequests(), 1);
  }
});

test('Google token and JWKS responses are byte-bounded and never return upstream diagnostics', async () => {
  const cases: [string, () => Response][] = [
    ['token', () => json({ error: 'invalid_grant', error_description: config.clientSecret })],
    ['token', () => new Response(config.clientSecret, { status: 400 })],
    [
      'token',
      () => new Response('', { status: 302, headers: { location: 'https://attacker.example' } }),
    ],
    [
      'token',
      () =>
        new Response(JSON.stringify({ id_token: 'secret' }), {
          headers: { 'content-type': 'text/plain' },
        }),
    ],
    [
      'token',
      () =>
        new Response('{invalid:' + config.clientSecret, {
          headers: { 'content-type': 'application/json' },
        }),
    ],
    ['token', () => json({ padding: 'x'.repeat(65_536) })],
    ['token', () => json({}, { 'content-length': '65537' })],
    ['certs', () => json({ padding: 'x'.repeat(262_144) })],
    ['certs', () => json({}, { 'content-length': '262145' })],
    [
      'certs',
      () =>
        new Response('secret', { status: 307, headers: { location: 'https://attacker.example' } }),
    ],
  ];
  for (const [endpoint, response] of cases) {
    const f = await fixture();
    f.state.respond = (url) => (url.endsWith('/' + endpoint) ? response() : undefined);
    await assert.rejects(f.exchange(), safeFailure);
    assert.equal(f.timers.size, 0);
    assert.ok(f.calls.length <= 2, 'errors and redirects are not retried');
  }
  const f = await fixture();
  f.state.respond = () => {
    throw new Error('URL secret=' + config.clientSecret);
  };
  await assert.rejects(f.exchange(), safeFailure);
});

test('Google injected request deadline aborts a fetch and clears timers without sleeping', async () => {
  for (const endpoint of ['token', 'certs']) {
    const f = await fixture();
    const started = deferred<void>();
    const response = deferred<Response>();
    let signal: AbortSignal | undefined;
    f.state.respond = (url, init) => {
      if (!url.endsWith('/' + endpoint)) return;
      signal = init.signal ?? undefined;
      started.resolve();
      return response.promise;
    };
    const rejected = assert.rejects(f.exchange(), safeFailure);
    await started.promise;
    for (const expire of [...f.timers]) expire();
    await rejected;
    assert.equal(signal?.aborted, true);
    assert.equal(f.timers.size, 0);
    response.resolve(json({ secret: config.clientSecret }));
  }
});

test('Google deadline covers a stalled response body and cancels the reader', async () => {
  const f = await fixture();
  const started = deferred<void>();
  const cancelled = deferred<void>();
  f.state.respond = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id_token":"'));
          started.resolve();
        },
        cancel() {
          cancelled.resolve();
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  const rejected = assert.rejects(f.exchange(), safeFailure);
  await started.promise;
  for (const expire of [...f.timers]) expire();
  await rejected;
  await cancelled.promise;
  assert.equal(f.timers.size, 0);
});
