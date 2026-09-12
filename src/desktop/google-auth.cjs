const { timingSafeEqual } = require('node:crypto');

const message = 'Google 登录尚未完成，请重新发起登录。';
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const opaque = (v) =>
  typeof v === 'string' &&
  /^[A-Za-z0-9_-]{43}$/.test(v) &&
  Buffer.from(v, 'base64url').toString('base64url') === v;
const exact = (v, keys) => object(v) && Object.keys(v).every((key) => keys.includes(key));
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
function check(value) {
  if (!value) throw new Error(message);
}
function origin(value) {
  try {
    const url = new URL(value);
    check(
      url.origin === value &&
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))),
    );
    return value;
  } catch {
    throw new Error(message);
  }
}
function beginInput(value) {
  check(exact(value, ['mode', 'setupToken', 'password']));
  check(['login', 'setup', 'link'].includes(value.mode));
  if (value.mode === 'setup') check(text(value.setupToken, 1024) && value.password === undefined);
  else if (value.mode === 'link')
    check(
      value.setupToken === undefined &&
        (value.password === undefined ||
          (typeof value.password === 'string' &&
            value.password.length > 0 &&
            value.password.length <= 1024 &&
            !value.password.includes('\0'))),
    );
  else check(value.setupToken === undefined && value.password === undefined);
  return {
    mode: value.mode,
    desktop: true,
    ...(value.setupToken === undefined ? {} : { setupToken: value.setupToken }),
    ...(value.password === undefined ? {} : { password: value.password }),
  };
}
function startResult(value, now) {
  check(
    exact(value, ['flowId', 'secret', 'code', 'expiresAt', 'launchPath']) &&
      opaque(value.flowId) &&
      opaque(value.secret),
  );
  check(typeof value.code === 'string' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value.code));
  check(
    Number.isSafeInteger(value.expiresAt) &&
      value.expiresAt > now &&
      value.expiresAt <= now + 15 * 60 * 1000,
  );
  check(value.launchPath === '/auth/google/start?flow=' + value.flowId);
  return {
    flowId: value.flowId,
    secret: value.secret,
    code: value.code,
    expiresAt: value.expiresAt,
    launchPath: value.launchPath,
  };
}
function reviewResult(value, mode) {
  check(
    exact(value, ['status', 'email', 'mode']) &&
      value.mode === mode &&
      ['pending', 'ready'].includes(value.status),
  );
  if (value.status === 'ready') check(text(value.email, 320) && value.email.trim() === value.email);
  else check(value.email === undefined);
  return value;
}
function sessionCookie(headers, target, now) {
  const cookies =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean);
  check(cookies.length === 1);
  const [pair, ...parts] = cookies[0].split(';').map((s) => s.trim());
  check(pair.startsWith('personal=') && opaque(pair.slice(9)));
  const attributes = new Map();
  for (const part of parts) {
    const index = part.indexOf('='),
      key = (index < 0 ? part : part.slice(0, index)).toLowerCase(),
      value = index < 0 ? true : part.slice(index + 1);
    check(!attributes.has(key));
    attributes.set(key, value);
  }
  check(
    [...attributes.keys()].every((key) =>
      ['path', 'httponly', 'samesite', 'secure', 'max-age'].includes(key),
    ),
  );
  check(
    attributes.get('path') === '/' &&
      attributes.get('httponly') === true &&
      attributes.get('samesite')?.toLowerCase() === 'strict',
  );
  check(!attributes.has('secure') || attributes.get('secure') === true);
  check(!target.startsWith('https:') || attributes.get('secure') === true);
  const age = attributes.get('max-age');
  check(typeof age === 'string' && /^[1-9]\d{0,7}$/.test(age) && Number(age) <= 2592000);
  return {
    url: target,
    name: 'personal',
    value: pair.slice(9),
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: target.startsWith('https:'),
    expirationDate: Math.floor(now / 1000) + Number(age),
  };
}
function externalCookie(cookie, target, now) {
  // Only restore an observed host-only Moor login, preserving its actual expiry.
  // Invalid cookies and explicit removals both discard the previous snapshot.
  if (
    cookie.name !== 'personal' ||
    cookie.path !== '/' ||
    cookie.domain !== new URL(target).hostname ||
    cookie.hostOnly !== true ||
    cookie.httpOnly !== true ||
    cookie.sameSite !== 'strict' ||
    !opaque(cookie.value) ||
    (target.startsWith('https:') && cookie.secure !== true) ||
    (cookie.session !== true &&
      (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= now / 1000))
  )
    return null;
  return {
    url: target,
    name: 'personal',
    value: cookie.value,
    path: '/',
    httpOnly: true,
    secure: cookie.secure === true,
    sameSite: 'strict',
    ...(cookie.session === true ? {} : { expirationDate: cookie.expirationDate }),
  };
}

/** A single-purpose system-browser handoff. It never returns URLs or credentials to a renderer. */
class DesktopGoogleAuth {
  /** @param {{registry: Map<any, any>, remoteWindow: () => any, origin: () => string, request?: typeof fetch, openExternal: (url: string) => Promise<unknown>, confirm: (window: any, options: any) => Promise<{response: number}>, now?: () => number, schedule?: (callback: () => void, delay: number) => any, unschedule?: (timer: any) => void}} options */
  constructor({
    registry,
    remoteWindow,
    origin: getOrigin,
    request = fetch,
    openExternal,
    confirm,
    now = Date.now,
    schedule = setTimeout,
    unschedule = clearTimeout,
  }) {
    this.registry = registry;
    this.remoteWindow = remoteWindow;
    this.getOrigin = getOrigin;
    this.request = request;
    this.openExternal = openExternal;
    this.confirm = confirm;
    this.now = now;
    this.schedule = schedule;
    this.unschedule = unschedule;
    this.generation = 0;
    this.closed = false;
    this.active = undefined;
    this.writing = undefined;
    this.cookieWrites = Promise.resolve();
  }
  context(event) {
    try {
      const contents = event.sender,
        frame = event.senderFrame,
        registered = this.registry.get(contents),
        target = origin(this.getOrigin());
      check(
        !this.closed &&
          registered &&
          registered.window === this.remoteWindow() &&
          !registered.window.isDestroyed() &&
          registered.window.webContents === contents &&
          !contents.isDestroyed() &&
          frame === contents.mainFrame &&
          new URL(frame.url).origin === target &&
          registered.origin === target,
      );
      return {
        contents,
        frame,
        window: registered.window,
        session: contents.session,
        origin: target,
      };
    } catch {
      throw new Error(message);
    }
  }
  current(attempt) {
    try {
      const ctx = this.context({ sender: attempt.ctx.contents, senderFrame: attempt.ctx.frame });
      return (
        this.active === attempt &&
        attempt.generation === this.generation &&
        ctx.origin === attempt.ctx.origin &&
        ctx.session === attempt.ctx.session &&
        (!attempt.flow || this.now() < attempt.flow.expiresAt)
      );
    } catch {
      return false;
    }
  }
  async cookie(ctx) {
    const cookies = await ctx.session.cookies.get({ url: ctx.origin, name: 'personal' });
    check(cookies.length <= 1);
    if (!cookies.length) return '';
    const value = cookies[0];
    check(
      value.name === 'personal' &&
        value.path === '/' &&
        value.httpOnly === true &&
        opaque(value.value),
    );
    return value.value;
  }
  async unchanged(attempt) {
    check(this.current(attempt));
    check(equal(await this.cookie(attempt.ctx), attempt.priorCookie));
    check(this.current(attempt));
  }
  recoveryCurrent(attempt) {
    try {
      const contents = attempt.ctx.contents,
        registered = this.registry.get(contents);
      return (
        !this.closed &&
        attempt.recoveryAllowed &&
        origin(this.getOrigin()) === attempt.ctx.origin &&
        registered?.origin === attempt.ctx.origin &&
        registered.window === attempt.ctx.window &&
        registered.window === this.remoteWindow() &&
        !registered.window.isDestroyed() &&
        !contents.isDestroyed() &&
        contents.session === attempt.ctx.session &&
        new URL(contents.mainFrame.url).origin === attempt.ctx.origin
      );
    } catch {
      return false;
    }
  }
  async recoverCookie(attempt, ownValue) {
    // Electron exposes no cookie CAS. Reconcile only a value written by this
    // attempt; a different current value always wins. Keep observing external
    // changes while a recovery write is pending, including an explicit logout.
    while (equal(await this.cookie(attempt.ctx), ownValue)) {
      const epoch = attempt.externalEpoch,
        snapshot = attempt.externalCookie;
      if (
        !this.recoveryCurrent(attempt) ||
        !snapshot ||
        (snapshot.expirationDate !== undefined && snapshot.expirationDate <= this.now() / 1000)
      ) {
        await attempt.ctx.session.cookies.remove(attempt.ctx.origin, 'personal');
        return;
      }
      attempt.installing = snapshot.value;
      await attempt.ctx.session.cookies.set(snapshot);
      ownValue = snapshot.value;
      const current = await this.cookie(attempt.ctx);
      if (!equal(current, ownValue)) return;
      if (this.recoveryCurrent(attempt) && epoch === attempt.externalEpoch) return;
    }
  }
  async post(target, path, value, attempt, cookie) {
    const controller = new AbortController();
    attempt?.controllers.add(controller);
    const timer = this.schedule(() => controller.abort(), 10000);
    try {
      const url = target + path;
      const response = await this.request(url, {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        headers: {
          'Content-Type': 'application/json',
          Origin: target,
          ...(cookie ? { Cookie: 'personal=' + cookie } : {}),
        },
        body: JSON.stringify(value),
        signal: controller.signal,
      });
      check(
        response.status === 200 &&
          !response.redirected &&
          (!response.url || response.url === url) &&
          response.headers.get('content-type')?.startsWith('application/json'),
      );
      const declared = response.headers.get('content-length');
      check(declared === null || (/^\d+$/.test(declared) && Number(declared) <= 16384));
      const reader = response.body?.getReader();
      check(reader);
      const chunks = [];
      let bytes = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 16384) {
          await reader.cancel();
          throw new Error(message);
        }
        chunks.push(Buffer.from(next.value));
      }
      return {
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        headers: response.headers,
      };
    } catch {
      throw new Error(message);
    } finally {
      controller.abort();
      attempt?.controllers.delete(controller);
      this.unschedule(timer);
    }
  }
  stop(attempt, remote = true) {
    if (this.active === attempt) {
      this.active = undefined;
      this.generation++;
    }
    for (const controller of attempt.controllers) controller.abort();
    if (attempt.timer !== undefined) this.unschedule(attempt.timer);
    if (attempt.onCookie && !attempt.installing)
      attempt.ctx.session.cookies.removeListener('changed', attempt.onCookie);
    const flow = attempt.flow;
    attempt.flow = undefined;
    if (remote && flow)
      void this.post(attempt.ctx.origin, '/api/auth/google/cancel', {
        flowId: flow.flowId,
        secret: flow.secret,
      }).catch(() => {});
  }
  async begin(event, input) {
    const payload = beginInput(input),
      ctx = this.context(event);
    if (this.active) this.stop(this.active);
    const attempt = {
      ctx,
      generation: ++this.generation,
      mode: payload.mode,
      priorCookie: '',
      controllers: new Set(),
      busy: false,
      flow: undefined,
      timer: undefined,
      onCookie: undefined,
      installing: undefined,
      recoveryAllowed: true,
      externalEpoch: 0,
      externalCookie: undefined,
    };
    this.active = attempt;
    try {
      await this.cookieWrites;
      check(this.current(attempt));
      attempt.priorCookie = await this.cookie(ctx);
      check(this.current(attempt) && (payload.mode !== 'link' || attempt.priorCookie));
      if (typeof ctx.session.cookies.on === 'function') {
        attempt.onCookie = (_event, cookie, cause, removed) => {
          if (
            cookie.name === 'personal' &&
            cookie.path === '/' &&
            (cookie.domain === new URL(ctx.origin).hostname ||
              cookie.domain === '.' + new URL(ctx.origin).hostname) &&
            !(removed && cause === 'overwrite') &&
            !(attempt.installing && !removed && equal(cookie.value, attempt.installing))
          ) {
            if (attempt.installing) {
              attempt.externalEpoch++;
              attempt.externalCookie = removed
                ? null
                : externalCookie(cookie, ctx.origin, this.now());
            }
            this.stop(attempt);
          }
        };
        ctx.session.cookies.on('changed', attempt.onCookie);
      }
      const result = await this.post(
        ctx.origin,
        '/api/auth/google/start',
        payload,
        attempt,
        payload.mode === 'link' ? attempt.priorCookie : undefined,
      );
      const flow = startResult(result.body, this.now());
      if (!this.current(attempt)) {
        attempt.flow = flow;
        this.stop(attempt);
        throw new Error(message);
      }
      attempt.flow = flow;
      attempt.timer = this.schedule(() => this.stop(attempt), flow.expiresAt - this.now());
      await this.unchanged(attempt);
      await this.openExternal(ctx.origin + flow.launchPath);
      await this.unchanged(attempt);
      return { flowId: flow.flowId, code: flow.code };
    } catch {
      this.stop(attempt);
      throw new Error(message);
    }
  }
  activeFor(event, input) {
    check(input === undefined);
    const ctx = this.context(event),
      attempt = this.active;
    check(
      attempt &&
        attempt.flow &&
        attempt.ctx.contents === ctx.contents &&
        attempt.ctx.frame === ctx.frame &&
        this.current(attempt),
    );
    return attempt;
  }
  async complete(event, input) {
    const attempt = this.activeFor(event, input);
    check(!attempt.busy);
    attempt.busy = true;
    try {
      await this.unchanged(attempt);
      const flow = attempt.flow;
      const result = reviewResult(
        (
          await this.post(
            attempt.ctx.origin,
            '/api/auth/google/desktop/review',
            { flowId: flow.flowId, secret: flow.secret },
            attempt,
            attempt.mode === 'link' ? attempt.priorCookie : undefined,
          )
        ).body,
        attempt.mode,
      );
      await this.unchanged(attempt);
      if (result.status === 'pending') return { completed: false };
      const confirmation = await this.confirm(attempt.ctx.window, {
        type: 'question',
        title: attempt.mode === 'link' ? '确认绑定 Google' : '确认 Google 登录',
        message: '继续使用 ' + result.email + '？',
        detail:
          '服务：' +
          attempt.ctx.origin +
          '\n验证代码：' +
          flow.code +
          '\n请确认浏览器显示的是同一账号与验证码。',
        buttons: ['确认继续', '取消'],
        defaultId: 1,
        cancelId: 1,
      });
      await this.unchanged(attempt);
      if (confirmation?.response !== 0) {
        this.stop(attempt);
        return { completed: false };
      }
      const finished = await this.post(
        attempt.ctx.origin,
        '/api/auth/google/desktop/finish',
        { flowId: flow.flowId, secret: flow.secret },
        attempt,
        attempt.mode === 'link' ? attempt.priorCookie : undefined,
      );
      check(exact(finished.body, ['ok']) && finished.body.ok === true);
      if (attempt.mode === 'link') {
        check(!finished.headers.get('set-cookie'));
        await this.unchanged(attempt);
        this.stop(attempt, false);
        return { completed: true };
      }
      const cookie = sessionCookie(finished.headers, attempt.ctx.origin, this.now());
      const installing = this.cookieWrites.then(async () => {
        await this.unchanged(attempt);
        attempt.installing = cookie.value;
        this.writing = attempt;
        try {
          await attempt.ctx.session.cookies.set(cookie);
          check(this.current(attempt));
          check(equal(await this.cookie(attempt.ctx), cookie.value));
          check(this.current(attempt));
        } catch {
          try {
            await this.recoverCookie(attempt, cookie.value);
          } catch {}
          throw new Error(message);
        } finally {
          attempt.installing = undefined;
          if (this.writing === attempt) this.writing = undefined;
          if (attempt.onCookie)
            attempt.ctx.session.cookies.removeListener('changed', attempt.onCookie);
        }
      });
      this.cookieWrites = installing.catch(() => {});
      await installing;
      this.stop(attempt, false);
      return { completed: true };
    } catch {
      this.stop(attempt);
      throw new Error(message);
    } finally {
      attempt.busy = false;
    }
  }
  async cancel(event, input) {
    check(input === undefined);
    const ctx = this.context(event),
      attempt = this.active;
    if (
      attempt &&
      attempt.ctx.contents === ctx.contents &&
      attempt.ctx.frame === ctx.frame &&
      attempt.ctx.origin === ctx.origin &&
      attempt.ctx.session === ctx.session
    )
      this.stop(attempt);
  }
  invalidate(contents) {
    // An unscoped invalidation is a service reconfiguration or application exit.
    if (!contents && this.writing) this.writing.recoveryAllowed = false;
    if (this.active && (!contents || this.active.ctx.contents === contents)) this.stop(this.active);
  }
  close() {
    this.closed = true;
    this.invalidate();
  }
}
module.exports = { DesktopGoogleAuth, beginInput, startResult, sessionCookie };
