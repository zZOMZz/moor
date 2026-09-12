import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import {
  DesktopGoogleAuth,
  beginInput,
  startResult,
  sessionCookie,
} from '../src/desktop/google-auth.cjs';

const relay = 'https://relay.synthetic.invalid';
const token = (number: number) => Buffer.alloc(32, number).toString('base64url');
const safeError = 'Google 登录尚未完成，请重新发起登录。';
const cookieHeader = (value = token(200)) =>
  `personal=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure`;
const json = (body: unknown, cookie?: string) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...(cookie ? { 'Set-Cookie': cookie } : {}) },
  });
function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const waiting = new Promise<void>((resolve) => (release = resolve));
  return { enter, release, entered, waiting };
}
type Call = { path: string; input: any; options: RequestInit; url: string };
function fixture(t: TestContext, initialCookie = '') {
  const calls: Call[] = [],
    launches: string[] = [],
    confirmations: any[] = [],
    writes: any[] = [],
    removals: string[] = [],
    timers = new Map<number, { callback: () => void; delay: number }>();
  let currentOrigin = relay,
    now = 1800000000000,
    counter = 0,
    flowCounter = 0,
    cookie = initialCookie;
  const flows = new Map<string, string>();
  const state = {
    response: undefined as undefined | ((call: Call) => Promise<Response>),
    confirm: undefined as undefined | (() => Promise<{ response: number }>),
    write: undefined as undefined | ((details: any) => Promise<void>),
    open: undefined as undefined | (() => Promise<void>),
    read: undefined as undefined | (() => Promise<void>),
  };
  const record = (value: string, target = relay) => ({
    name: 'personal',
    value,
    path: '/',
    domain: new URL(target).hostname,
    hostOnly: true,
    httpOnly: true,
    sameSite: 'strict',
    secure: target.startsWith('https:'),
    session: false,
    expirationDate: now / 1000 + 12345,
  });
  const cookies = Object.assign(new EventEmitter(), {
    async get(filter: any) {
      assert.deepEqual(filter, { url: relay, name: 'personal' });
      await state.read?.();
      return cookie ? [record(cookie)] : [];
    },
    async set(details: any) {
      writes.push(details);
      await state.write?.(details);
      const previous = cookie;
      cookie = details.value;
      if (previous)
        cookies.emit(
          'changed',
          {},
          { ...record(previous, details.url), ...details, value: previous },
          'overwrite',
          true,
        );
      cookies.emit(
        'changed',
        {},
        { ...record(details.value, details.url), ...details },
        'explicit',
        false,
      );
    },
    async remove(url: string, name: string) {
      assert.equal(name, 'personal');
      removals.push(url);
      const previous = cookie;
      cookie = '';
      cookies.emit(
        'changed',
        {},
        { name, value: previous, path: '/', domain: new URL(url).hostname },
        'explicit',
        true,
      );
    },
  });
  const contents = {
    mainFrame: { url: relay + '/login' },
    session: { cookies },
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  const window = {
    webContents: contents,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
  };
  let remoteWindow = window;
  const registry = new Map([[contents, { window, origin: relay }]]);
  const defaultResponse = async (call: Call) => {
    if (call.path.endsWith('/start')) {
      const flowId = token(++flowCounter);
      flows.set(flowId, call.input.mode);
      return json({
        flowId,
        secret: token(100 + flowCounter),
        code: 'ABCD-1234',
        expiresAt: now + 600000,
        launchPath: '/auth/google/start?flow=' + flowId,
      });
    }
    if (call.path.endsWith('/review'))
      return json({
        status: 'ready',
        mode: flows.get(call.input.flowId),
        email: 'synthetic@example.invalid',
      });
    if (call.path.endsWith('/finish'))
      return json(
        { ok: true },
        flows.get(call.input.flowId) === 'link' ? undefined : cookieHeader(),
      );
    assert.equal(call.path, '/api/auth/google/cancel');
    return json({ ok: true });
  };
  const auth = new DesktopGoogleAuth({
    registry,
    remoteWindow: () => remoteWindow,
    origin: () => currentOrigin,
    request: (async (url: string, options: RequestInit) => {
      const call = {
        url,
        path: new URL(url).pathname,
        input: JSON.parse(String(options.body)),
        options,
      };
      calls.push(call);
      return state.response ? state.response(call) : defaultResponse(call);
    }) as typeof fetch,
    openExternal: async (url: string) => {
      launches.push(url);
      await state.open?.();
    },
    confirm: async (parent: any, options: any) => {
      assert.equal(parent, window);
      confirmations.push(options);
      return state.confirm ? state.confirm() : { response: 0 };
    },
    now: () => now,
    schedule(callback: () => void, delay: number) {
      timers.set(++counter, { callback, delay });
      return counter;
    },
    unschedule(id: number) {
      timers.delete(id);
    },
  });
  t.after(() => auth.close());
  return {
    auth,
    calls,
    launches,
    confirmations,
    writes,
    removals,
    timers,
    cookies,
    contents,
    window,
    registry,
    state,
    defaultResponse,
    event: () => ({ sender: contents, senderFrame: contents.mainFrame }),
    get cookie() {
      return cookie;
    },
    setCookie(value: string, notify = true, details: Record<string, unknown> = {}) {
      cookie = value;
      if (notify)
        cookies.emit(
          'changed',
          {},
          { ...record(value, currentOrigin), ...details },
          'explicit',
          !value,
        );
    },
    setOrigin(value: string) {
      currentOrigin = value;
    },
    setRemote(value: typeof window) {
      remoteWindow = value;
    },
    advance(milliseconds: number) {
      now += milliseconds;
    },
    fire(delay: number) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `expected a ${delay} ms timer`);
      timers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

test('desktop Google begin opens only the fixed relay handoff and returns public confirmation fields', async (t) => {
  const f = fixture(t);
  const result = await f.auth.begin(f.event(), {
    mode: 'setup',
    setupToken: 'synthetic-init-private',
  });
  assert.deepEqual(result, { flowId: token(1), code: 'ABCD-1234' });
  assert.deepEqual(f.launches, [relay + '/auth/google/start?flow=' + token(1)]);
  assert.equal(f.calls.length, 1, 'no polling or direct Google request');
  assert.deepEqual(f.calls[0].input, {
    mode: 'setup',
    desktop: true,
    setupToken: 'synthetic-init-private',
  });
  assert.deepEqual(f.calls[0].options.headers, {
    'Content-Type': 'application/json',
    Origin: relay,
  });
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(f.calls[0].options.credentials, 'omit');
  assert.equal(
    JSON.stringify({ result, launches: f.launches }).includes('synthetic-init-private'),
    false,
  );
  assert.equal(JSON.stringify(result).includes(token(101)), false);
  assert.equal(f.writes.length, 0);
});

test('desktop Google login completes only after a native confirmation and installs the exact private cookie', async (t) => {
  const f = fixture(t);
  await f.auth.begin(f.event(), { mode: 'login' });
  assert.deepEqual(await f.auth.complete(f.event()), { completed: true });
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0].message, /synthetic@example.invalid/);
  assert.match(f.confirmations[0].detail, /https:\/\/relay\.synthetic\.invalid/);
  assert.match(f.confirmations[0].detail, /ABCD-1234/);
  assert.equal(f.confirmations[0].cancelId, 1);
  assert.equal(f.confirmations[0].defaultId, 1);
  assert.deepEqual(f.writes, [
    {
      url: relay,
      name: 'personal',
      value: token(200),
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: true,
      expirationDate: 1800000000 + 2592000,
    },
  ]);
  assert.equal(f.cookie, token(200));
  assert.deepEqual(
    f.calls.map((call) => call.path),
    [
      '/api/auth/google/start',
      '/api/auth/google/desktop/review',
      '/api/auth/google/desktop/finish',
    ],
  );
  assert.equal(f.timers.size, 0);
  await assert.rejects(f.auth.complete(f.event()), { message: safeError });
});

test('desktop Google link binds every authenticated request to the original owner and never replaces their cookie', async (t) => {
  const f = fixture(t, token(9));
  await f.auth.begin(f.event(), { mode: 'link', password: 'synthetic-password' });
  assert.deepEqual(await f.auth.complete(f.event()), { completed: true });
  for (const call of f.calls)
    assert.equal((call.options.headers as any).Cookie, 'personal=' + token(9));
  assert.equal(f.calls[0].input.password, 'synthetic-password');
  assert.equal(f.cookie, token(9));
  assert.equal(f.writes.length, 0);
});

test('desktop Google pending review requires another manual action; native rejection cancels without finishing', async (t) => {
  const f = fixture(t);
  f.state.response = async (call) =>
    call.path.endsWith('/review')
      ? json({ status: 'pending', mode: 'login' })
      : f.defaultResponse(call);
  await f.auth.begin(f.event(), { mode: 'login' });
  assert.deepEqual(await f.auth.complete(f.event()), { completed: false });
  assert.equal(f.calls.length, 2);
  assert.equal(f.confirmations.length, 0);
  f.state.response = undefined;
  f.state.confirm = async () => ({ response: 1 });
  assert.deepEqual(await f.auth.complete(f.event()), { completed: false });
  assert.equal(f.calls.filter((call) => call.path.endsWith('/cancel')).length, 1);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/finish')).length, 0);
  assert.equal(f.writes.length, 0);
});

test('desktop Google public actions reject arbitrary URLs, credentials in the wrong mode and renderer flow arguments', async (t) => {
  const f = fixture(t);
  for (const input of [
    undefined,
    null,
    [],
    {},
    { mode: 'other' },
    { mode: 'login', url: 'https://evil.invalid' },
    { mode: 'login', secret: token(1) },
    { mode: 'login', password: 'bad' },
    { mode: 'link', setupToken: 'bad' },
    { mode: 'setup' },
    { mode: 'setup', setupToken: 'x'.repeat(1025) },
    { mode: 'link', password: 'x'.repeat(1025) },
    { mode: 'setup', setupToken: '\nsecret' },
  ]) {
    await assert.rejects(f.auth.begin(f.event(), input), { message: safeError });
  }
  assert.deepEqual(beginInput({ mode: 'setup', setupToken: 'x'.repeat(1024) }), {
    mode: 'setup',
    setupToken: 'x'.repeat(1024),
    desktop: true,
  });
  assert.equal(f.calls.length, 0);
  await f.auth.begin(f.event(), { mode: 'login' });
  await assert.rejects(f.auth.complete(f.event(), { flowId: token(1) }), { message: safeError });
  await assert.rejects(f.auth.cancel(f.event(), { secret: token(101) }), { message: safeError });
  assert.equal(await f.auth.cancel(f.event()), undefined);
  assert.equal(f.calls.length, 2);
});

test('desktop Google accepts only the registered remote window and exact main frame at the configured origin', async (t) => {
  const f = fixture(t);
  const original = f.event();
  const cases = [
    { sender: f.contents, senderFrame: { url: relay + '/login' } },
    { sender: { ...f.contents }, senderFrame: f.contents.mainFrame },
    { sender: f.contents, senderFrame: undefined },
  ];
  for (const event of cases)
    await assert.rejects(f.auth.begin(event, { mode: 'login' }), { message: safeError });
  f.setRemote({ ...f.window });
  await assert.rejects(f.auth.begin(original, { mode: 'login' }), { message: safeError });
  f.setRemote(f.window);
  f.contents.mainFrame.url = 'https://different.synthetic.invalid/login';
  await assert.rejects(f.auth.begin(f.event(), { mode: 'login' }), { message: safeError });
  f.contents.mainFrame.url = relay + '/login';
  f.registry.delete(f.contents);
  await assert.rejects(f.auth.begin(f.event(), { mode: 'login' }), { message: safeError });
  assert.equal(f.calls.length, 0);
});

test('desktop Google rejects noncanonical service origins before dispatch', async (t) => {
  const f = fixture(t);
  for (const origin of [
    'http://relay.synthetic.invalid',
    relay + '/',
    relay + '?secret=private',
    'https://user:private@relay.synthetic.invalid',
    'file:///private',
    'javascript:alert(1)',
  ]) {
    f.setOrigin(origin);
    await assert.rejects(f.auth.begin(f.event(), { mode: 'login' }), { message: safeError });
  }
  assert.equal(f.calls.length, 0);
});

test('desktop Google strictly validates private start responses and never follows a relay-supplied arbitrary URL', async (t) => {
  const base = {
    flowId: token(1),
    secret: token(101),
    code: 'ABCD-1234',
    expiresAt: 1800000600000,
    launchPath: '/auth/google/start?flow=' + token(1),
  };
  for (const patch of [
    { launchPath: 'https://evil.invalid/' },
    { launchPath: '//evil.invalid/' },
    { launchPath: base.launchPath + '&secret=' + token(101) },
    { flowId: 'A'.repeat(42) + 'B' },
    { secret: 'private' },
    { code: 'private\nsecret' },
    { expiresAt: 1800000000000 },
    { expiresAt: 1800001000000 },
    { unexpected: 'private' },
  ]) {
    const f = fixture(t);
    f.state.response = async () => json({ ...base, ...patch });
    await assert.rejects(f.auth.begin(f.event(), { mode: 'login' }), { message: safeError });
    assert.equal(f.launches.length, 0);
    assert.equal(f.writes.length, 0);
  }
  assert.equal(startResult(base, 1800000000000).secret, token(101));
});

test('desktop Google rejects redirects, malformed and oversized responses with a credential-free error', async (t) => {
  const responses = [
    () =>
      new Response('private-google-token', {
        status: 302,
        headers: { Location: 'https://evil.invalid' },
      }),
    () => new Response('private-google-token', { status: 500 }),
    () => new Response('private-google-token', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
    () =>
      new Response('{}', {
        headers: { 'Content-Type': 'application/json', 'Content-Length': '16385' },
      }),
    () => new Response('x'.repeat(16385), { headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const make of responses) {
    const f = fixture(t);
    f.state.response = async () => make();
    await assert.rejects(f.auth.begin(f.event(), { mode: 'login' }), { message: safeError });
    assert.equal(f.calls.length, 1);
    assert.equal(f.launches.length, 0);
  }
  const f = fixture(t);
  f.state.response = async () => {
    const response = json({});
    Object.defineProperty(response, 'url', { value: 'https://evil.invalid' });
    return response;
  };
  await assert.rejects(f.auth.begin(f.event(), { mode: 'login' }), { message: safeError });
  f.state.response = async () => {
    const response = json({});
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  };
  await assert.rejects(f.auth.begin(f.event(), { mode: 'login' }), { message: safeError });
});

test('desktop Google validates every cookie attribute before installation', async (t) => {
  const invalid = [
    undefined,
    cookieHeader().replace('personal=', 'other='),
    cookieHeader().replace(token(200), 'private'),
    cookieHeader() + '; Domain=relay.synthetic.invalid',
    cookieHeader() + '; Secure',
    cookieHeader().replace('; HttpOnly', ''),
    cookieHeader().replace('SameSite=Strict', 'SameSite=Lax'),
    cookieHeader().replace('Path=/', 'Path=/auth'),
    cookieHeader().replace('; Secure', ''),
    cookieHeader().replace('2592000', '2592001'),
    cookieHeader() + ', ' + cookieHeader(token(201)),
  ];
  for (const cookie of invalid) {
    const f = fixture(t);
    f.state.response = async (call) =>
      call.path.endsWith('/finish') ? json({ ok: true }, cookie) : f.defaultResponse(call);
    await f.auth.begin(f.event(), { mode: 'login' });
    await assert.rejects(f.auth.complete(f.event()), { message: safeError });
    assert.equal(f.writes.length, 0);
  }
  assert.equal(
    sessionCookie(
      new Headers({ 'Set-Cookie': cookieHeader().replace('; Secure', '') }),
      'http://127.0.0.1:8787',
      1800000000000,
    ).secure,
    false,
  );
});

test('desktop Google link rejects a replacement session cookie', async (t) => {
  const f = fixture(t, token(9));
  f.state.response = async (call) =>
    call.path.endsWith('/finish') ? json({ ok: true }, cookieHeader()) : f.defaultResponse(call);
  await f.auth.begin(f.event(), { mode: 'link', password: 'synthetic-password' });
  await assert.rejects(f.auth.complete(f.event()), { message: safeError });
  assert.equal(f.writes.length, 0);
  assert.equal(f.cookie, token(9));
});

test('desktop Google validates ready identity and mode before presenting native confirmation', async (t) => {
  for (const review of [
    { status: 'ready', mode: 'setup', email: 'synthetic@example.invalid' },
    { status: 'ready', mode: 'login', email: 'private\nspoof' },
    { status: 'ready', mode: 'login', email: 'x'.repeat(321) },
    { status: 'ready', mode: 'login' },
    { status: 'pending', mode: 'login', email: 'synthetic@example.invalid' },
    { status: 'ready', mode: 'login', email: 'synthetic@example.invalid', secret: token(1) },
  ]) {
    const f = fixture(t);
    f.state.response = async (call) =>
      call.path.endsWith('/review') ? json(review) : f.defaultResponse(call);
    await f.auth.begin(f.event(), { mode: 'login' });
    await assert.rejects(f.auth.complete(f.event()), { message: safeError });
    assert.equal(f.confirmations.length, 0);
    assert.equal(f.writes.length, 0);
  }
});

test('desktop Google replaces a pending start without opening its stale browser flow', async (t) => {
  const f = fixture(t),
    hold = gate();
  let first = true;
  f.state.response = async (call) => {
    const result = await f.defaultResponse(call);
    if (call.path.endsWith('/start') && first) {
      first = false;
      hold.enter();
      await hold.waiting;
    }
    return result;
  };
  const old = f.auth.begin(f.event(), { mode: 'login' });
  const oldFailed = assert.rejects(old, { message: safeError });
  await hold.entered;
  const next = await f.auth.begin(f.event(), { mode: 'login' });
  hold.release();
  await oldFailed;
  assert.deepEqual(f.launches, [relay + '/auth/google/start?flow=' + next.flowId]);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith('/cancel') && call.input.flowId === token(1))
      .length,
    1,
  );
  assert.deepEqual(await f.auth.complete(f.event()), { completed: true });
});

test('desktop Google invalidation while opening the system browser cannot leave a usable flow', async (t) => {
  const f = fixture(t),
    hold = gate();
  f.state.open = async () => {
    hold.enter();
    await hold.waiting;
  };
  const pending = f.auth.begin(f.event(), { mode: 'login' });
  const failed = assert.rejects(pending, { message: safeError });
  await hold.entered;
  f.auth.invalidate(f.contents);
  hold.release();
  await failed;
  assert.equal(f.writes.length, 0);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/cancel')).length, 1);
});

test('desktop Google prevents duplicate completion and invalidates native confirmation on a new document', async (t) => {
  const f = fixture(t),
    hold = gate();
  f.state.confirm = async () => {
    hold.enter();
    await hold.waiting;
    return { response: 0 };
  };
  await f.auth.begin(f.event(), { mode: 'login' });
  const completing = f.auth.complete(f.event());
  const failed = assert.rejects(completing, { message: safeError });
  await hold.entered;
  await assert.rejects(f.auth.complete(f.event()), { message: safeError });
  f.contents.mainFrame = { url: relay + '/new-document' };
  hold.release();
  await failed;
  assert.equal(f.calls.filter((call) => call.path.endsWith('/finish')).length, 0);
  assert.equal(f.writes.length, 0);
});

test('desktop Google rejects stale finish after navigation, window close, service change or restart', async (t) => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.auth.invalidate(f.contents),
    (f: ReturnType<typeof fixture>) => {
      f.window.destroyed = true;
    },
    (f: ReturnType<typeof fixture>) => f.setOrigin('https://other.synthetic.invalid'),
    (f: ReturnType<typeof fixture>) => f.auth.close(),
  ]) {
    const f = fixture(t),
      hold = gate();
    f.state.response = async (call) => {
      if (call.path.endsWith('/finish')) {
        hold.enter();
        await hold.waiting;
      }
      return f.defaultResponse(call);
    };
    await f.auth.begin(f.event(), { mode: 'login' });
    const completing = f.auth.complete(f.event());
    const failed = assert.rejects(completing, { message: safeError });
    await hold.entered;
    invalidate(f);
    hold.release();
    await failed;
    assert.equal(f.writes.length, 0);
  }
});

test('desktop Google rechecks the original owner even if cookie events are unavailable', async (t) => {
  const f = fixture(t, token(9));
  await f.auth.begin(f.event(), { mode: 'link', password: 'synthetic-password' });
  f.setCookie(token(10), false);
  await assert.rejects(f.auth.complete(f.event()), { message: safeError });
  assert.equal(f.calls.filter((call) => call.path.endsWith('/review')).length, 0);
  assert.equal(f.writes.length, 0);
});

test('desktop Google explicit account changes cancel the old flow, while its expected cookie overwrite succeeds', async (t) => {
  const f = fixture(t, token(9));
  await f.auth.begin(f.event(), { mode: 'login' });
  assert.deepEqual(await f.auth.complete(f.event()), { completed: true });
  assert.equal(f.cookie, token(200));
  await f.auth.begin(f.event(), { mode: 'link', password: 'synthetic-password' });
  f.setCookie(token(10));
  await assert.rejects(f.auth.complete(f.event()), { message: safeError });
  assert.equal(f.calls.filter((call) => call.path.endsWith('/cancel')).length, 1);
  assert.equal(f.cookie, token(10));
});

test('desktop Google serializes cookie writes and removes a stale installation before a new begin can start', async (t) => {
  const f = fixture(t),
    hold = gate();
  f.state.write = async () => {
    hold.enter();
    await hold.waiting;
  };
  await f.auth.begin(f.event(), { mode: 'login' });
  const completing = f.auth.complete(f.event());
  const failed = assert.rejects(completing, { message: safeError });
  await hold.entered;
  const next = f.auth.begin(f.event(), { mode: 'login' });
  assert.equal(f.calls.filter((call) => call.path.endsWith('/start')).length, 1);
  hold.release();
  await failed;
  await next;
  assert.equal(f.cookie, '');
  assert.deepEqual(f.removals, [relay]);
  f.state.write = undefined;
  assert.deepEqual(await f.auth.complete(f.event()), { completed: true });
  assert.equal(f.cookie, token(200));
});

test('desktop Google stale write cleanup preserves a different newer account cookie', async (t) => {
  const f = fixture(t),
    hold = gate();
  f.state.write = async () => {
    hold.enter();
    await hold.waiting;
  };
  await f.auth.begin(f.event(), { mode: 'login' });
  const completing = f.auth.complete(f.event());
  const failed = assert.rejects(completing, { message: safeError });
  await hold.entered;
  f.auth.invalidate();
  f.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (!removed && cookie.value === token(200)) f.setCookie(token(201), false);
  });
  hold.release();
  await failed;
  assert.equal(f.cookie, token(201));
  assert.deepEqual(f.removals, []);
});

test('desktop Google preserves a newer external login that arrives before an older pending write lands', async (t) => {
  const f = fixture(t),
    hold = gate();
  f.state.write = async () => {
    hold.enter();
    await hold.waiting;
  };
  await f.auth.begin(f.event(), { mode: 'login' });
  const completing = f.auth.complete(f.event());
  const failed = assert.rejects(completing, { message: safeError });
  await hold.entered;
  f.setCookie(token(201));
  hold.release();
  await failed;
  assert.equal(f.cookie, token(201));
  assert.deepEqual(f.writes[1], {
    url: relay,
    name: 'personal',
    value: token(201),
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    expirationDate: 1800000000 + 12345,
  });
  assert.equal(f.cookies.listenerCount('changed'), 0);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/finish')).length, 1);
});

test('desktop Google never restores an observed login after logout, service change, close or an invalid newer cookie', async (t) => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.setCookie(''),
    (f: ReturnType<typeof fixture>) => f.setOrigin('https://different.synthetic.invalid'),
    (f: ReturnType<typeof fixture>) => {
      f.auth.invalidate();
      f.setOrigin('https://different.synthetic.invalid');
      f.setOrigin(relay);
    },
    (f: ReturnType<typeof fixture>) => {
      f.window.destroyed = true;
      f.auth.invalidate(f.contents);
    },
    (f: ReturnType<typeof fixture>) => f.auth.close(),
    (f: ReturnType<typeof fixture>) =>
      f.setCookie(token(202), true, { expirationDate: 1799999999 }),
    (f: ReturnType<typeof fixture>) => f.setCookie(token(202), true, { httpOnly: false }),
  ]) {
    const f = fixture(t),
      hold = gate();
    f.state.write = async () => {
      hold.enter();
      await hold.waiting;
    };
    await f.auth.begin(f.event(), { mode: 'login' });
    const pending = f.auth.complete(f.event());
    const failed = assert.rejects(pending, { message: safeError });
    await hold.entered;
    f.setCookie(token(201));
    change(f);
    hold.release();
    await failed;
    assert.equal(f.cookie, '');
    assert.equal(f.writes.length, 1);
    assert.equal(f.cookies.listenerCount('changed'), 0);
    assert.equal(f.calls.filter((call) => call.path.endsWith('/finish')).length, 1);
  }
});

test('desktop Google rechecks external cookie epochs during recovery, including a logout or service change', async (t) => {
  for (const change of ['logout', 'origin', 'login']) {
    const f = fixture(t),
      original = gate(),
      recovery = gate();
    f.state.write = async () => {
      if (f.writes.length === 1) {
        original.enter();
        await original.waiting;
      }
      if (f.writes.length === 2) {
        recovery.enter();
        await recovery.waiting;
      }
    };
    await f.auth.begin(f.event(), { mode: 'login' });
    const pending = f.auth.complete(f.event());
    const failed = assert.rejects(pending, { message: safeError });
    await original.entered;
    f.setCookie(token(201));
    original.release();
    await recovery.entered;
    if (change === 'logout') f.setCookie('');
    else if (change === 'origin') f.setOrigin('https://different.synthetic.invalid');
    else f.setCookie(token(202));
    recovery.release();
    await failed;
    assert.equal(f.cookie, change === 'login' ? token(202) : '');
    assert.equal(f.cookies.listenerCount('changed'), 0);
    assert.equal(f.calls.filter((call) => call.path.endsWith('/finish')).length, 1);
    assert.equal(f.calls.filter((call) => call.path.endsWith('/cancel')).length, 1);
  }
});

test('desktop Google expiry and network timeout use injected timers without polling or retries', async (t) => {
  const f = fixture(t);
  await f.auth.begin(f.event(), { mode: 'login' });
  f.advance(600000);
  f.fire(600000);
  await assert.rejects(f.auth.complete(f.event()), { message: safeError });
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ['/api/auth/google/start', '/api/auth/google/cancel'],
  );
  const stalled = fixture(t),
    entered = gate();
  stalled.state.response = async (call) =>
    new Promise((_resolve, reject) => {
      call.options.signal!.addEventListener(
        'abort',
        () => reject(new Error('private-http-error-secret')),
        { once: true },
      );
      entered.enter();
    });
  const pending = stalled.auth.begin(stalled.event(), { mode: 'login' });
  const failed = assert.rejects(pending, { message: safeError });
  await entered.entered;
  stalled.fire(10000);
  await failed;
  assert.equal(stalled.calls.length, 1);
  assert.equal(stalled.launches.length, 0);
});

test('desktop Google preload offers only typed handoff methods and no generic browser or network proxy', async () => {
  const calls: unknown[][] = [];
  let exposed: any;
  runInNewContext(await readFile('src/desktop/web-preload.cjs', 'utf8'), {
    require(name: string) {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name: string, api: unknown) {
            assert.equal(name, 'moorDesktop');
            exposed = api;
          },
        },
        ipcRenderer: {
          invoke(...args: unknown[]) {
            calls.push(args);
            return Promise.resolve();
          },
        },
      };
    },
  });
  assert.deepEqual(Object.keys(exposed.googleAuth), ['begin', 'complete', 'cancel']);
  await exposed.googleAuth.begin({ mode: 'login' });
  await exposed.googleAuth.complete({ url: 'https://evil.invalid', secret: 'private' });
  await exposed.googleAuth.cancel({ flowId: 'private' });
  assert.deepEqual(calls, [
    ['moor:google-auth-begin', { mode: 'login' }],
    ['moor:google-auth-complete'],
    ['moor:google-auth-cancel'],
  ]);
  assert.equal(exposed.openExternal, undefined);
  assert.equal(exposed.fetch, undefined);
});

test('desktop Google cancellation is idempotent after expiry, native rejection and an already cancelled flow', async (t) => {
  const f = fixture(t);
  assert.equal(await f.auth.cancel(f.event()), undefined);
  assert.equal(f.calls.length, 0);
  await f.auth.begin(f.event(), { mode: 'login' });
  await f.auth.cancel(f.event());
  await f.auth.cancel(f.event());
  assert.equal(f.calls.filter((call) => call.path.endsWith('/cancel')).length, 1);
  await f.auth.begin(f.event(), { mode: 'login' });
  f.state.confirm = async () => ({ response: 1 });
  assert.deepEqual(await f.auth.complete(f.event()), { completed: false });
  await f.auth.cancel(f.event());
  await f.auth.begin(f.event(), { mode: 'login' });
  f.advance(600000);
  await f.auth.cancel(f.event());
  assert.equal(f.calls.filter((call) => call.path.endsWith('/cancel')).length, 3);
  await assert.rejects(f.auth.cancel({ ...f.event(), senderFrame: { url: relay } }), {
    message: safeError,
  });
  await assert.rejects(f.auth.cancel(f.event(), {}), { message: safeError });
});

test('desktop Google cancels oversized response streams and aborts a pending response read on timeout', async (t) => {
  const oversized = fixture(t);
  let cancelled = 0;
  oversized.state.response = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(16385));
        },
        cancel() {
          cancelled++;
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  await assert.rejects(oversized.auth.begin(oversized.event(), { mode: 'login' }), {
    message: safeError,
  });
  assert.equal(cancelled, 1);
  const stalled = fixture(t),
    entered = gate();
  stalled.state.response = async (call) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"flowId":"private'));
          call.options.signal!.addEventListener(
            'abort',
            () => controller.error(new Error('private stream failure')),
            { once: true },
          );
        },
        pull() {
          entered.enter();
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  const pending = stalled.auth.begin(stalled.event(), { mode: 'login' });
  const failed = assert.rejects(pending, { message: safeError });
  await entered.entered;
  stalled.fire(10000);
  await failed;
  assert.equal(stalled.calls.length, 1);
  assert.equal(stalled.launches.length, 0);
  assert.equal(stalled.timers.size, 0);
});

test('desktop Google stale review cannot prompt or finish after the current owner changes', async (t) => {
  const f = fixture(t, token(9)),
    hold = gate();
  f.state.response = async (call) => {
    if (call.path.endsWith('/review')) {
      hold.enter();
      await hold.waiting;
    }
    return f.defaultResponse(call);
  };
  await f.auth.begin(f.event(), { mode: 'link', password: 'synthetic-password' });
  const pending = f.auth.complete(f.event());
  const failed = assert.rejects(pending, { message: safeError });
  await hold.entered;
  f.setCookie(token(10));
  hold.release();
  await failed;
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/finish')).length, 0);
});

test('desktop Google rejects unsuccessful or overbroad finish responses without exposing relay content', async (t) => {
  for (const body of [{ ok: false }, { ok: true, personal: token(200) }, { ok: 'true' }, []]) {
    const f = fixture(t);
    f.state.response = async (call) =>
      call.path.endsWith('/finish') ? json(body, cookieHeader()) : f.defaultResponse(call);
    await f.auth.begin(f.event(), { mode: 'login' });
    await assert.rejects(f.auth.complete(f.event()), { message: safeError });
    assert.equal(f.writes.length, 0);
  }
  const f = fixture(t);
  f.state.open = async () => {
    throw new Error('private launch secret');
  };
  await assert.rejects(f.auth.begin(f.event(), { mode: 'login' }), { message: safeError });
  assert.equal(f.calls.filter((call) => call.path.endsWith('/cancel')).length, 1);
});
