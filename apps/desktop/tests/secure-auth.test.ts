import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticateDesktopAccount } from '../src/main/desktop-client';
import { DESKTOP_SECURE_FAILED, DESKTOP_SECURE_LIMITS } from '@moor/client/desktop-secure-protocol';

const origin = 'https://synthetic.example.test',
  cookie = 'personal=' + 'a'.repeat(32);
const identity = {
  owner: 'synthetic-account',
  actor: { kind: 'relay', authorityId: 'relay', accountId: 'synthetic-account' },
  needsSetup: false,
  localOnly: false,
  attentionFeatures: [],
  google: { enabled: true, linked: { email: 'synthetic@example.test' }, hasPassword: false },
};
const response = (body: unknown = identity) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const safe = (error: unknown) => {
  assert(error instanceof Error);
  assert.equal(error.message, DESKTOP_SECURE_FAILED);
  assert.equal(error.cause, undefined);
  return true;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

test('desktop authentication checks a single fixed bounded identity route and returns main-only credentials', async () => {
  const calls: Array<{ url: unknown; init?: RequestInit }> = [],
    controller = new AbortController();
  let checks = 0;
  const current = () => {
      checks++;
    },
    result = await authenticateDesktopAccount(
      { origin, cookie, current },
      {
        deadline: (ms) => {
          assert.equal(ms, DESKTOP_SECURE_LIMITS.deadlineMs);
          return controller.signal;
        },
        request: async (url, init) => {
          calls.push({ url, init });
          return response();
        },
      },
    );
  assert.deepEqual(result, { origin, owner: identity.owner, cookie, current });
  assert(Object.isFrozen(result));
  assert(checks >= 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, origin + '/api/me');
  assert.deepEqual(calls[0]!.init, {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal: controller.signal,
    headers: { Accept: 'application/json', Origin: origin, Cookie: cookie },
  });
});

test('desktop authentication rejects noncanonical origins and cookie injection before network I/O', async () => {
  let requests = 0;
  const request: typeof fetch = async () => {
    requests++;
    return response();
  };
  for (const connection of [
    { origin: 'http://example.test', cookie },
    { origin: 'https://user:secret@example.test', cookie },
    { origin: origin + '/path', cookie },
    { origin: origin + '/', cookie },
    { origin, cookie: cookie + '; other=secret' },
    { origin, cookie: cookie + '\r\nX-Secret: secret' },
  ])
    await assert.rejects(
      authenticateDesktopAccount({ ...connection, current() {} }, { request }),
      safe,
    );
  assert.equal(requests, 0);
});

test('desktop authentication refuses missing, local, mismatched and additional identity authority', async () => {
  for (const body of [
    { ...identity, owner: null },
    { ...identity, owner: '' },
    { ...identity, needsSetup: true },
    { ...identity, localOnly: true },
    { ...identity, actor: { ...identity.actor, kind: 'local' } },
    { ...identity, actor: { ...identity.actor, accountId: 'other-account' } },
    { ...identity, secret: 'SYNTHETIC_PRIVATE_DETAIL' },
    { ...identity, google: { ...identity.google, accessToken: 'SYNTHETIC_PRIVATE_DETAIL' } },
  ])
    await assert.rejects(
      authenticateDesktopAccount(
        { origin, cookie, current() {} },
        { request: async () => response(body) },
      ),
      safe,
    );
});

test('desktop authentication rejects redirects, changed response URLs, non-JSON and oversized responses', async () => {
  const redirected = response(),
    changedUrl = response();
  Object.defineProperty(redirected, 'redirected', { value: true });
  Object.defineProperty(changedUrl, 'url', { value: 'https://other.example.test/api/me' });
  for (const result of [
    redirected,
    changedUrl,
    new Response('SYNTHETIC_PRIVATE_FAILURE', { status: 401 }),
    new Response(JSON.stringify(identity), { headers: { 'content-type': 'text/html' } }),
    new Response(JSON.stringify(identity), {
      headers: { 'content-type': 'application/json', 'content-length': '4097' },
    }),
    new Response(JSON.stringify(identity), {
      headers: { 'content-type': 'application/json', 'content-length': '-1' },
    }),
    new Response(' '.repeat(4097), { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([0xc0, 0x80]), { headers: { 'content-type': 'application/json' } }),
  ])
    await assert.rejects(
      authenticateDesktopAccount({ origin, cookie, current() {} }, { request: async () => result }),
      safe,
    );
});

test('account lease changes during response streaming suppress the entire identity', async () => {
  let current = true,
    canceled = false;
  const started = deferred<void>(),
    continueBody = deferred<void>();
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (reads++ === 0) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(identity).slice(0, 20)));
        started.resolve();
      } else {
        await continueBody.promise;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(identity).slice(20)));
        controller.close();
      }
    },
    cancel() {
      canceled = true;
    },
  });
  const authenticating = authenticateDesktopAccount(
    {
      origin,
      cookie,
      current() {
        if (!current) throw Error('SYNTHETIC_PRIVATE_COOKIE_CHANGED');
      },
    },
    {
      request: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    },
  );
  await started.promise;
  current = false;
  continueBody.resolve();
  await assert.rejects(authenticating, safe);
  // Cancel is permitted to be a no-op after a stream has already completed.
  assert(canceled || body.locked === false);
});

test('an injected deadline rejects immediately and cancels an identity response arriving later', async () => {
  const controller = new AbortController(),
    requestStarted = deferred<void>(),
    later = deferred<Response>(),
    canceled = deferred<void>();
  const authenticating = authenticateDesktopAccount(
    { origin, cookie, current() {} },
    {
      deadline: () => controller.signal,
      request: async () => {
        requestStarted.resolve();
        return later.promise;
      },
    },
  );
  await requestStarted.promise;
  controller.abort();
  await assert.rejects(authenticating, safe);
  later.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          canceled.resolve();
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
  await canceled.promise;
});

test('already expired deadlines and current lease failures do not send a request', async () => {
  let requests = 0;
  const request: typeof fetch = async () => {
    requests++;
    return response();
  };
  await assert.rejects(
    authenticateDesktopAccount(
      { origin, cookie, current() {} },
      { request, deadline: () => AbortSignal.abort() },
    ),
    safe,
  );
  await assert.rejects(
    authenticateDesktopAccount(
      {
        origin,
        cookie,
        current() {
          throw Error('SYNTHETIC_PRIVATE_ACCOUNT');
        },
      },
      { request },
    ),
    safe,
  );
  assert.equal(requests, 0);
});

test('identity reads also bound empty chunks independently of the byte allowance', async () => {
  let chunks = 0,
    canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array());
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(
    authenticateDesktopAccount(
      { origin, cookie, current() {} },
      {
        request: async () =>
          new Response(body, { headers: { 'content-type': 'application/json' } }),
      },
    ),
    safe,
  );
  assert(canceled);
  assert(chunks <= DESKTOP_SECURE_LIMITS.identityChunks + 2);
});
