import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { type TestContext } from 'node:test';
import {
  DesktopAccount,
  ACCOUNT_ERROR,
  ACCOUNT_LIMITS,
} from '../../apps/desktop/src/main/account.cjs';
import { CLIENT_URL, CLIENT_ORIGIN } from '../../apps/desktop/src/main/client-assets.cjs';
import * as accountManagement from '../../packages/protocol/src/account-management';

const origin = 'https://relay.synthetic.invalid';
const token = (value: number) => Buffer.alloc(32, value).toString('base64url');
const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json', ...headers },
  });
function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve)),
    waiting = new Promise<void>((resolve) => (release = resolve));
  return { enter, release, entered, waiting };
}
function account(owner: string | null = 'synthetic-owner') {
  return {
    owner,
    actor: owner ? { kind: 'relay', authorityId: 'relay', accountId: owner } : null,
    needsSetup: false,
    localOnly: false,
    attentionFeatures: ['attention-v1'],
    google: {
      enabled: true,
      ...(owner ? { linked: { email: 'synthetic@example.invalid' }, hasPassword: false } : {}),
    },
  };
}
function fixture(t: TestContext, loggedIn = true) {
  const state = {
    origin,
    now: 1800000000000,
    values: [] as any[],
    cookieRead: undefined as ReturnType<typeof gate> | undefined,
    removing: undefined as ReturnType<typeof gate> | undefined,
    drain: undefined as ReturnType<typeof gate> | undefined,
    response: undefined as
      | ((call: { url: string; init: RequestInit }) => Promise<Response>)
      | undefined,
    afterRead: undefined as (() => void) | undefined,
    reads: 0,
  };
  const record = (value = token(1)) => ({
    name: 'personal',
    value,
    domain: new URL(origin).hostname,
    hostOnly: true,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    session: false,
    expirationDate: state.now / 1000 + 600,
  });
  if (loggedIn) state.values = [record()];
  const calls: Array<{ url: string; init: RequestInit }> = [],
    removals: unknown[] = [],
    invalidations: unknown[] = [],
    deadlines: AbortController[] = [];
  const cookies = Object.assign(new EventEmitter(), {
    async get(filter: unknown) {
      assert.deepEqual(filter, { url: origin, name: 'personal' });
      state.reads++;
      if (state.cookieRead) {
        state.cookieRead.enter();
        await state.cookieRead.waiting;
      }
      const values = structuredClone(state.values);
      state.afterRead?.();
      return values;
    },
    async remove(url: string, name: string) {
      assert.equal(url, origin);
      assert.equal(name, 'personal');
      removals.push({ url, name });
      if (state.removing) {
        state.removing.enter();
        await state.removing.waiting;
      }
      const old = state.values;
      state.values = [];
      for (const cookie of old) cookies.emit('changed', {}, cookie, 'explicit', true);
    },
  });
  const frame = { url: CLIENT_URL, origin: CLIENT_ORIGIN },
    contents = {
      mainFrame: frame,
      session: { cookies },
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
    },
    window = {
      webContents: contents,
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
    };
  const registered: any = { window, origin, trustedClient: true },
    registry = new Map([[contents, registered]]);
  let remote = window;
  const bridge = new DesktopAccount({
    registry,
    remoteWindow: () => remote,
    origin: () => state.origin,
    now: () => state.now,
    loadManagement: async () => accountManagement,
    onInvalidate(value: unknown) {
      invalidations.push(value);
      assert.equal(bridge.isLoggingOut(contents), true);
      if (state.drain) {
        state.drain.enter();
        return state.drain.waiting;
      }
    },
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return state.response
        ? state.response(call)
        : url.endsWith('/api/me')
          ? json(account(new Headers(init.headers).has('Cookie') ? 'synthetic-owner' : null))
          : json({ ok: true }, { 'Set-Cookie': 'personal=; Path=/; Max-Age=0' });
    }) as typeof fetch,
    deadline: (ms: number) => {
      assert.equal(ms, ACCOUNT_LIMITS.deadlineMs);
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    },
  });
  t.after(() => bridge.close());
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
  const change = (cookie: any = record(token(2)), removed = false) => {
    state.values = removed ? [] : [cookie];
    cookies.emit('changed', {}, cookie, 'explicit', removed);
  };
  return {
    bridge,
    state,
    record,
    calls,
    cookies,
    contents,
    window,
    frame,
    registered,
    registry,
    event,
    change,
    removals,
    invalidations,
    deadlines,
    replaceWindow() {
      remote = { ...window };
    },
  };
}
function ok(result: any) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
function failed(result: any) {
  assert.deepEqual(result, ACCOUNT_ERROR);
}

test('account management uses only fixed owner-bound routes and rechecks the cookie and identity', async (t) => {
  const f = fixture(t);
  f.state.response = async ({ url }) =>
    url.endsWith('/api/me') ? json(account()) : json({ code: 'a'.repeat(16), expiresIn: 300 });
  const result = await f.bridge.request(f.event(), {
    action: 'pair',
    owner: 'synthetic-owner',
    workspaceId: 'workspace',
  });
  assert.deepEqual(ok(result), { action: 'pair', code: 'a'.repeat(16), expiresIn: 300 });
  assert.deepEqual(
    f.calls.map((call) => [call.url, call.init.method]),
    [
      [origin + '/api/me', 'GET'],
      [origin + '/api/pair?expectedAccount=synthetic-owner', 'POST'],
      [origin + '/api/me', 'GET'],
    ],
  );
  assert.deepEqual(JSON.parse(String(f.calls[1]!.init.body)), { workspaceId: 'workspace' });
  assert.equal(f.removals.length, 0);
});

test('a stale reviewed owner and arbitrary management parameters never dispatch writes', async (t) => {
  const f = fixture(t);
  for (const input of [
    { action: 'create-workspace', owner: 'different-owner', name: 'Synthetic' },
    {
      action: 'revoke',
      owner: 'synthetic-owner',
      deviceId: 'device',
      url: 'https://foreign.invalid/',
    },
    { action: 'fetch', owner: 'synthetic-owner', path: '/api/me' },
  ])
    failed(await f.bridge.request(f.event(), input));
  assert.equal(f.calls.filter((call) => call.init.method === 'POST').length, 0);
});

test('a cookie change after management dispatch keeps its outcome unknown without retry or cookie removal', async (t) => {
  const f = fixture(t);
  f.state.response = async ({ url }) => {
    if (url.endsWith('/api/me')) return json(account());
    f.change();
    return json({ ok: true });
  };
  failed(
    await f.bridge.request(f.event(), {
      action: 'revoke',
      owner: 'synthetic-owner',
      deviceId: 'device',
    }),
  );
  assert.equal(f.calls.filter((call) => call.init.method === 'POST').length, 1);
  assert.equal(f.removals.length, 0);
});

test('anonymous status sends only the fixed metadata request and exposes the minimal public view', async (t) => {
  const f = fixture(t, false),
    result = await f.bridge.request(f.event(), { action: 'status' });
  assert.deepEqual(ok(result), {
    origin,
    owner: null,
    needsSetup: false,
    google: { enabled: true },
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, origin + '/api/me');
  assert.deepEqual(f.calls[0]!.init, {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal: f.calls[0]!.init.signal,
    headers: { Accept: 'application/json', Origin: origin },
  });
  assert.equal(f.invalidations.length, 0);
  assert.equal(f.cookies.listenerCount('changed'), 0);
});

test('authenticated status uses only main-held credentials and strips actor and Google identity details', async (t) => {
  const f = fixture(t),
    result = await f.bridge.request(f.event(), { action: 'status' });
  assert.deepEqual(ok(result), {
    origin,
    owner: 'synthetic-owner',
    needsSetup: false,
    google: { enabled: true },
  });
  assert.equal(new Headers(f.calls[0]!.init.headers).get('Cookie'), 'personal=' + token(1));
  for (const secret of [token(1), 'synthetic@example.invalid', 'authorityId', 'hasPassword'])
    assert(!JSON.stringify(result).includes(secret));
});

test('expired cookies are not sent, while expiration during an active request invalidates its result', async (t) => {
  const expired = fixture(t);
  expired.state.values[0].expirationDate = expired.state.now / 1000 - 1;
  assert.equal(ok(await expired.bridge.request(expired.event(), { action: 'status' })).owner, null);
  assert.equal(new Headers(expired.calls[0]!.init.headers).has('Cookie'), false);
  const active = fixture(t),
    held = gate();
  active.state.response = async () => {
    held.enter();
    await held.waiting;
    return json(account());
  };
  const pending = active.bridge.request(active.event(), { action: 'status' });
  await held.entered;
  active.state.now += 601000;
  held.release();
  failed(await pending);
});

test('account actions reject extra parameters and non-JSON input before reading cookies', async (t) => {
  const f = fixture(t);
  let getters = 0;
  const accessor = Object.defineProperty({}, 'action', {
    enumerable: true,
    get() {
      getters++;
      return 'status';
    },
  });
  for (const input of [
    { action: 'connect' },
    { action: 'status', owner: 'injected' },
    { action: 'status', cookie: token(9) },
    { action: 'logout' },
    { action: 'logout', path: '/other' },
    { action: 'status', hidden: new ArrayBuffer(4096) },
    accessor,
    undefined,
    [],
  ])
    failed(await f.bridge.request(f.event(), input));
  assert.equal(f.state.reads, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(getters, 0);
});

test('only the registered canonical trusted main document can access account metadata', async (t) => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => {
      f.registered.trustedClient = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.frame.url = origin + '/remote/';
      f.frame.origin = origin;
    },
    (f: ReturnType<typeof fixture>) => {
      f.frame.url = CLIENT_URL + '?foreign=1';
    },
    (f: ReturnType<typeof fixture>) => {
      f.frame.origin = 'null';
    },
    (f: ReturnType<typeof fixture>) => {
      f.contents.destroyed = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.window.destroyed = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.origin = 'https://other.example.invalid';
    },
    (f: ReturnType<typeof fixture>) => {
      f.replaceWindow();
    },
  ]) {
    const f = fixture(t);
    alter(f);
    failed(await f.bridge.request(f.event(), { action: 'status' }));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(t);
  failed(
    await f.bridge.request(
      { sender: f.contents, senderFrame: { ...f.frame } },
      { action: 'status' },
    ),
  );
});

test('malformed, ambiguous and foreign cookies fail before network access', async (t) => {
  for (const patch of [
    { value: 'bad' },
    { domain: '.synthetic.invalid' },
    { hostOnly: false },
    { httpOnly: false },
    { secure: false },
    { sameSite: 'lax' },
    { path: '/api' },
    { expirationDate: NaN },
  ]) {
    const f = fixture(t);
    Object.assign(f.state.values[0], patch);
    failed(await f.bridge.request(f.event(), { action: 'status' }));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(t);
  f.state.values.push(f.record(token(2)));
  failed(await f.bridge.request(f.event(), { action: 'status' }));
  assert.equal(f.calls.length, 0);
});

test('identity must match the actual remote schema and anonymous requests cannot acquire an owner', async (t) => {
  for (const body of [
    { ...account(), localOnly: true },
    { ...account(), actor: { ...account().actor, kind: 'local' } },
    { ...account(), actor: { ...account().actor, accountId: 'other' } },
    { ...account(), needsSetup: true },
    { ...account(), extra: 'SYNTHETIC_PRIVATE' },
    { ...account(), owner: 'owner/invalid' },
    { ...account(), google: { enabled: true, token: 'SYNTHETIC_PRIVATE' } },
    { ...account(), attentionFeatures: 'invalid' },
  ]) {
    const f = fixture(t);
    f.state.response = async () => json(body);
    failed(await f.bridge.request(f.event(), { action: 'status' }));
  }
  const anonymous = fixture(t, false);
  anonymous.state.response = async () => json(account());
  failed(await anonymous.bridge.request(anonymous.event(), { action: 'status' }));
  const setup = fixture(t, false);
  setup.state.response = async () => json({ ...account(null), needsSetup: true });
  assert.equal(
    ok(await setup.bridge.request(setup.event(), { action: 'status' })).needsSetup,
    true,
  );
});

test('HTTP identity rejects redirects, changed URLs, bad types, status codes, UTF8 and byte excess', async (t) => {
  const redirected = json(account()),
    changed = json(account());
  Object.defineProperty(redirected, 'redirected', { value: true });
  Object.defineProperty(changed, 'url', { value: origin + '/other' });
  for (const response of [
    redirected,
    changed,
    new Response('SYNTHETIC_PRIVATE', { status: 401 }),
    json(account(), { 'Content-Type': 'text/plain' }),
    json(account(), { 'Content-Length': '4097' }),
    json(account(), { 'Content-Length': '-1' }),
    new Response(' '.repeat(4097), { headers: { 'Content-Type': 'application/json' } }),
    new Response(new Uint8Array([0xc0, 0x80]), { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const f = fixture(t);
    f.state.response = async () => response;
    failed(await f.bridge.request(f.event(), { action: 'status' }));
  }
});

test('HTTP stream chunks are separately bounded and canceled even if all chunks are empty', async (t) => {
  const f = fixture(t);
  let chunks = 0,
    canceled = false;
  f.state.response = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          chunks++;
          controller.enqueue(new Uint8Array());
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  failed(await f.bridge.request(f.event(), { action: 'status' }));
  assert(canceled);
  assert(chunks <= ACCOUNT_LIMITS.responseChunks + 2);
});

test('configuration, registry, frame, cookie and session changes suppress late account responses', async (t) => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => {
      f.state.origin = 'https://other.example.invalid';
    },
    (f: ReturnType<typeof fixture>) => {
      f.registry.set(f.contents, { ...f.registered });
    },
    (f: ReturnType<typeof fixture>) => {
      f.contents.mainFrame = { ...f.frame };
    },
    (f: ReturnType<typeof fixture>) => {
      f.contents.session = { ...f.contents.session };
    },
    (f: ReturnType<typeof fixture>) => {
      f.change();
    },
    (f: ReturnType<typeof fixture>) => {
      f.bridge.invalidate(f.contents);
    },
  ]) {
    const f = fixture(t),
      held = gate();
    f.state.response = async () => {
      held.enter();
      await held.waiting;
      return json(account());
    };
    const pending = f.bridge.request(f.event(), { action: 'status' });
    await held.entered;
    alter(f);
    held.release();
    failed(await pending);
  }
});

test('a cookie swap without a changed event is caught by the final exact snapshot read', async (t) => {
  const f = fixture(t);
  f.state.response = async () => {
    f.state.values = [f.record(token(2))];
    return json(account());
  };
  failed(await f.bridge.request(f.event(), { action: 'status' }));
  assert.equal(f.removals.length, 0);
});

test('logout invalidates workspace work synchronously and waits for existing Google writes before reading', async (t) => {
  const f = fixture(t),
    drain = gate();
  f.state.drain = drain;
  const pending = f.bridge.request(f.event(), { action: 'logout', owner: 'synthetic-owner' });
  assert.deepEqual(f.invalidations, [f.contents]);
  assert.equal(f.bridge.isLoggingOut(f.contents), true);
  assert.equal(f.state.reads, 0);
  await drain.entered;
  failed(await f.bridge.request(f.event(), { action: 'status' }));
  failed(await f.bridge.request(f.event(), { action: 'logout', owner: 'synthetic-owner' }));
  // This is the already-running Google write that main invalidated and is draining.
  f.change(f.record(token(2)));
  drain.release();
  assert.deepEqual(ok(await pending), { loggedOut: true });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.url, origin + '/api/me');
  assert.equal(f.calls[1]!.url, origin + '/api/logout?expectedAccount=synthetic-owner');
  assert.equal(f.calls[1]!.init.method, 'POST');
  assert.equal(f.calls[1]!.init.redirect, 'error');
  assert.equal(new Headers(f.calls[1]!.init.headers).get('Cookie'), 'personal=' + token(2));
  assert.equal(new Headers(f.calls[1]!.init.headers).get('Origin'), origin);
  assert.equal(f.calls[1]!.init.credentials, 'omit');
  assert.equal(f.state.values.length, 0);
  assert.equal(f.bridge.isLoggingOut(f.contents), false);
});

test('anonymous logout closes live work without inventing an authenticated HTTP request', async (t) => {
  const f = fixture(t, false);
  assert.deepEqual(
    ok(await f.bridge.request(f.event(), { action: 'logout', owner: 'synthetic-owner' })),
    {
      loggedOut: true,
    },
  );
  assert.equal(f.invalidations.length, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.removals.length, 0);
});

test('logout from an older account page cannot revoke or remove a replacement account cookie', async (t) => {
  for (const duringDrain of [false, true]) {
    const f = fixture(t),
      draining = gate();
    if (duringDrain) f.state.drain = draining;
    f.state.response = async () => json(account('replacement-owner'));
    const pending = f.bridge.request(f.event(), { action: 'logout', owner: 'synthetic-owner' });
    if (duringDrain) {
      await draining.entered;
      f.change(f.record(token(2)));
      draining.release();
    }
    failed(await pending);
    assert.deepEqual(
      f.calls.map((call) => call.init.method),
      ['GET'],
    );
    assert.equal(f.removals.length, 0);
    assert.equal(f.state.values[0].value, token(duringDrain ? 2 : 1));
    assert.equal(f.bridge.isLoggingOut(f.contents), false);
  }
});

test('logout failure retains the exact old cookie and ignores server Set-Cookie headers', async (t) => {
  for (const response of [
    json({ ok: false }),
    json({ ok: true, extra: true }),
    new Response('SYNTHETIC_PRIVATE', { status: 500 }),
  ]) {
    const f = fixture(t);
    f.state.response = async ({ url }) => (url.endsWith('/api/me') ? json(account()) : response);
    failed(await f.bridge.request(f.event(), { action: 'logout', owner: 'synthetic-owner' }));
    assert.equal(f.state.values[0].value, token(1));
    assert.equal(f.removals.length, 0);
  }
  const f = fixture(t);
  f.state.response = async () => json(account(), { 'Set-Cookie': 'personal=' + token(9) });
  ok(await f.bridge.request(f.event(), { action: 'status' }));
  assert.equal(f.state.values[0].value, token(1));
});

test('cookie changes before logout deletion cannot delete a replacement account', async (t) => {
  for (const event of [true, false]) {
    const f = fixture(t),
      held = gate();
    f.state.response = async ({ url }) => {
      if (url.endsWith('/api/me')) return json(account());
      held.enter();
      await held.waiting;
      return json({ ok: true });
    };
    const pending = f.bridge.request(f.event(), { action: 'logout', owner: 'synthetic-owner' });
    await held.entered;
    if (event) f.change(f.record(token(2)));
    else f.state.values = [f.record(token(2))];
    held.release();
    failed(await pending);
    assert.equal(f.removals.length, 0);
    assert.equal(f.state.values[0].value, token(2));
  }
});

test('logout does not remove a cookie after its exact document or configuration changed', async (t) => {
  for (const alter of [
    (f: ReturnType<typeof fixture>) => {
      f.contents.mainFrame = { ...f.frame };
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.origin = 'https://other.example.invalid';
    },
    (f: ReturnType<typeof fixture>) => {
      f.registry.set(f.contents, { ...f.registered });
    },
  ]) {
    const f = fixture(t),
      held = gate();
    f.state.response = async ({ url }) => {
      if (url.endsWith('/api/me')) return json(account());
      held.enter();
      await held.waiting;
      return json({ ok: true });
    };
    const pending = f.bridge.request(f.event(), { action: 'logout', owner: 'synthetic-owner' });
    await held.entered;
    alter(f);
    held.release();
    failed(await pending);
    assert.equal(f.removals.length, 0);
  }
});

test('close and replacement windows cannot release the logout barrier before cookie removal settles', async (t) => {
  const f = fixture(t),
    removing = gate();
  f.state.removing = removing;
  const pending = f.bridge.request(f.event(), { action: 'logout', owner: 'synthetic-owner' });
  await removing.entered;
  f.bridge.close();
  failed(await pending);
  assert.equal(f.bridge.isLoggingOut({ session: f.contents.session }), true);
  assert.equal(f.bridge.isLoggingOut({ session: {} }), true);
  const finished = gate(),
    removeAttempt = f.bridge.attempts.delete.bind(f.bridge.attempts);
  t.mock.method(f.bridge.attempts, 'delete', (attempt: unknown) => {
    const removed = removeAttempt(attempt);
    finished.enter();
    return removed;
  });
  removing.release();
  await finished.entered;
  assert.equal(f.bridge.isLoggingOut(f.contents), false);
  assert.equal(f.removals.length, 1);
});

test('an external cookie change during non-cancelable removal stays unknown and never restores credentials', async (t) => {
  const f = fixture(t),
    removing = gate();
  f.state.removing = removing;
  const pending = f.bridge.request(f.event(), { action: 'logout', owner: 'synthetic-owner' });
  await removing.entered;
  f.change(f.record(token(2)));
  failed(await pending);
  assert.equal(f.bridge.isLoggingOut(f.contents), true);
  const finished = gate(),
    removeAttempt = f.bridge.attempts.delete.bind(f.bridge.attempts);
  t.mock.method(f.bridge.attempts, 'delete', (attempt: unknown) => {
    const removed = removeAttempt(attempt);
    finished.enter();
    return removed;
  });
  removing.release();
  await finished.entered;
  assert.equal(f.bridge.isLoggingOut(f.contents), false);
  assert.equal(f.removals.length, 1);
  // Electron has no value-CAS. This test asserts the truthful outcome and lack of
  // restoration; preservation is guaranteed for main-owned serialized writers only.
});

test('account request reservations remain bounded while an uncancelable cookie read is pending', async (t) => {
  const f = fixture(t),
    reading = gate();
  f.state.cookieRead = reading;
  const pending = Array.from({ length: ACCOUNT_LIMITS.requests }, () =>
    f.bridge.request(f.event(), { action: 'status' }),
  );
  await reading.entered;
  failed(await f.bridge.request(f.event(), { action: 'status' }));
  f.bridge.invalidate(f.contents);
  for (const result of await Promise.all(pending)) failed(result);
  assert.equal(f.bridge.attempts.size, ACCOUNT_LIMITS.requests);
  failed(await f.bridge.request(f.event(), { action: 'status' }));
  const finished = gate(),
    removeAttempt = f.bridge.attempts.delete.bind(f.bridge.attempts);
  t.mock.method(f.bridge.attempts, 'delete', (attempt: unknown) => {
    const removed = removeAttempt(attempt);
    if (!f.bridge.attempts.size) finished.enter();
    return removed;
  });
  reading.release();
  await finished.entered;
  assert.equal(f.bridge.attempts.size, 0);
  f.state.cookieRead = undefined;
  ok(await f.bridge.request(f.event(), { action: 'status' }));
});

test('deadline cancellation rejects promptly and cancels a delayed HTTP response body', async (t) => {
  const f = fixture(t),
    held = gate(),
    canceled = gate();
  f.state.response = async () => {
    held.enter();
    await held.waiting;
    return new Response(
      new ReadableStream({
        cancel() {
          canceled.enter();
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  const pending = f.bridge.request(f.event(), { action: 'status' });
  await held.entered;
  f.deadlines[0]!.abort();
  failed(await pending);
  held.release();
  await canceled.entered;
});
