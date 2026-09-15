const { isCurrentContentDocument } = require('./content-authority.cjs');
const { snapshotSecureInput } = require('./secure-input.cjs');

const SECURE_ACCOUNT_LIMITS = Object.freeze({
  requests: 8,
  requestBytes: 128,
  pendingBytes: 1024,
  responseBytes: 4096,
  responseChunks: 4096,
  deadlineMs: 30000,
});
const SECURE_ACCOUNT_ERROR = Object.freeze({
  ok: false,
  error: {
    code: 'unavailable',
    message: '账号状态或退出结果未确认，请核对当前登录后手动继续。',
    status: null,
    rejected: false,
  },
});
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) =>
  object(value) && Object.keys(value).every((key) => keys.includes(key));
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value);
const opaque = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').toString('base64url') === value;
function check(value) {
  if (!value) throw new Error(SECURE_ACCOUNT_ERROR.error.message);
}
function origin(value) {
  const url = new URL(value);
  check(
    url.origin === value &&
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))),
  );
  return value;
}
function identity(value, hasCookie) {
  check(exact(value, ['owner', 'actor', 'attentionFeatures', 'needsSetup', 'localOnly', 'google']));
  check(
    (value.owner === null || id(value.owner)) &&
      typeof value.needsSetup === 'boolean' &&
      value.localOnly === false,
  );
  check(!value.owner || (hasCookie && !value.needsSetup));
  check(
    value.owner === null
      ? value.actor === null
      : exact(value.actor, ['kind', 'authorityId', 'accountId']) &&
          value.actor.kind === 'relay' &&
          id(value.actor.authorityId) &&
          value.actor.accountId === value.owner,
  );
  check(
    Array.isArray(value.attentionFeatures) &&
      value.attentionFeatures.length <= 64 &&
      value.attentionFeatures.every(id),
  );
  check(
    exact(value.google, ['enabled', 'linked', 'hasPassword']) &&
      typeof value.google.enabled === 'boolean',
  );
  check(value.google.hasPassword === undefined || typeof value.google.hasPassword === 'boolean');
  const linked = value.google.linked;
  check(
    linked === undefined ||
      linked === null ||
      (exact(linked, ['email']) && typeof linked.email === 'string' && linked.email.length <= 320),
  );
  return {
    owner: value.owner,
    needsSetup: value.needsSetup,
    google: { enabled: value.google.enabled },
  };
}
function cookieSnapshot(values, target, now) {
  check(Array.isArray(values) && values.length <= 1);
  if (!values.length) return null;
  const value = values[0];
  check(
    value &&
      value.name === 'personal' &&
      value.path === '/' &&
      value.hostOnly === true &&
      value.domain === new URL(target).hostname &&
      value.httpOnly === true &&
      value.sameSite === 'strict' &&
      (!target.startsWith('https:') || value.secure === true) &&
      opaque(value.value) &&
      (value.session === true ||
        (Number.isFinite(value.expirationDate) && value.expirationDate > 0)),
  );
  const expiresAt = value.session === true ? Infinity : value.expirationDate * 1000;
  return Object.freeze({ value: value.value, expiresAt, active: expiresAt > now });
}
function sameCookie(left, right) {
  return left === null
    ? right === null
    : right !== null && left.value === right.value && left.expiresAt === right.expiresAt;
}
function bounded(promise, signal) {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(new Error(SECURE_ACCOUNT_ERROR.error.message));
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error(SECURE_ACCOUNT_ERROR.error.message));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * The trusted document gets account metadata, never cookies or a general HTTP client.
 * Node fetch deliberately ignores response Set-Cookie; only this main-owned cookie API writes.
 * @param {{registry: Map<any, any>, remoteWindow: () => any, origin: () => string,
 * fetch?: typeof fetch, onInvalidate?: (contents: any) => unknown,
 * deadline?: (ms: number) => AbortSignal, now?: () => number}} options
 */
class DesktopSecureAccount {
  constructor(options) {
    this.options = options;
    this.closed = false;
    this.attempts = new Set();
    this.bytes = 0;
    this.logout = undefined;
  }
  context(event) {
    const contents = event?.sender,
      frame = event?.senderFrame,
      registered = this.options.registry.get(contents),
      target = origin(this.options.origin());
    check(
      !this.closed &&
        registered?.trustedClient === true &&
        registered.window === this.options.remoteWindow() &&
        registered.origin === target &&
        isCurrentContentDocument(registered, contents, frame),
    );
    return {
      contents,
      frame,
      registered,
      origin: target,
      session: contents.session,
      documentUrl: frame.url,
    };
  }
  current(attempt) {
    check(!attempt.invalid && !attempt.signal.aborted);
    const fresh = this.context({
      sender: attempt.context.contents,
      senderFrame: attempt.context.frame,
    });
    check(
      fresh.registered === attempt.context.registered &&
        fresh.origin === attempt.context.origin &&
        fresh.session === attempt.context.session &&
        fresh.documentUrl === attempt.context.documentUrl,
    );
    if (attempt.cookie?.active) check((this.options.now ?? Date.now)() < attempt.cookie.expiresAt);
  }
  isLoggingOut(contents) {
    // There is one trusted account partition. A replacement window cannot
    // bypass an older, non-cancelable cookie write that still owns this barrier.
    return !!this.logout;
  }
  invalidate(contents) {
    for (const attempt of this.attempts) {
      if (contents && attempt.context.contents !== contents) continue;
      attempt.invalid = true;
      attempt.abort.abort();
    }
  }
  close() {
    this.closed = true;
    this.invalidate();
  }
  watch(attempt) {
    attempt.changed = (_event, value, _cause, removed) => {
      if (value?.name !== 'personal') return;
      const domain = String(value.domain ?? '').replace(/^\./, ''),
        host = new URL(attempt.context.origin).hostname;
      if (domain && host !== domain && !host.endsWith('.' + domain)) return;
      if (
        attempt.removing &&
        removed &&
        value.value === attempt.cookie?.value &&
        value.path === '/'
      ) {
        attempt.removed = true;
        return;
      }
      attempt.invalid = true;
      attempt.abort.abort();
    };
    attempt.context.session.cookies.on('changed', attempt.changed);
  }
  async readCookie(attempt) {
    this.current(attempt);
    const values = await attempt.context.session.cookies.get({
      url: attempt.context.origin,
      name: 'personal',
    });
    this.current(attempt);
    return cookieSnapshot(values, attempt.context.origin, (this.options.now ?? Date.now)());
  }
  async unchanged(attempt) {
    check(sameCookie(attempt.cookie, await this.readCookie(attempt)));
    this.current(attempt);
  }
  async json(attempt, path, method) {
    let response, reader;
    try {
      this.current(attempt);
      const url = attempt.context.origin + path,
        fetching = (this.options.fetch ?? fetch)(url, {
          method,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          signal: attempt.signal,
          headers: {
            Accept: 'application/json',
            Origin: attempt.context.origin,
            ...(attempt.cookie?.active ? { Cookie: 'personal=' + attempt.cookie.value } : {}),
          },
        }).then((value) => {
          try {
            this.current(attempt);
            return value;
          } catch {
            void value.body?.cancel().catch(() => {});
            throw Error(SECURE_ACCOUNT_ERROR.error.message);
          }
        });
      response = await bounded(fetching, attempt.signal);
      this.current(attempt);
      const length = response.headers.get('content-length');
      check(
        response.status === 200 &&
          !response.redirected &&
          (!response.url || response.url === url) &&
          /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') &&
          (length === null ||
            (/^\d+$/.test(length) && Number(length) <= SECURE_ACCOUNT_LIMITS.responseBytes)),
      );
      reader = response.body?.getReader();
      check(reader);
      const chunks = [];
      let bytes = 0;
      while (true) {
        const part = await bounded(reader.read(), attempt.signal);
        this.current(attempt);
        if (part.done) break;
        bytes += part.value.byteLength;
        check(
          bytes <= SECURE_ACCOUNT_LIMITS.responseBytes &&
            chunks.length < SECURE_ACCOUNT_LIMITS.responseChunks,
        );
        chunks.push(Buffer.from(part.value));
      }
      this.current(attempt);
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      if (reader) void reader.cancel().catch(() => {});
      else void response?.body?.cancel().catch(() => {});
      throw Error(SECURE_ACCOUNT_ERROR.error.message);
    } finally {
      reader?.releaseLock();
    }
  }
  async run(attempt, action, draining) {
    if (action === 'logout') {
      await draining;
      this.current(attempt);
    }
    this.watch(attempt);
    attempt.cookie = await this.readCookie(attempt);
    this.current(attempt);
    if (action === 'status') {
      const body = identity(await this.json(attempt, '/api/me', 'GET'), !!attempt.cookie?.active);
      await this.unchanged(attempt);
      return { origin: attempt.context.origin, ...body };
    }
    if (attempt.cookie?.active) {
      const body = await this.json(attempt, '/api/logout', 'POST');
      check(exact(body, ['ok']) && body.ok === true);
      this.current(attempt);
    }
    await this.unchanged(attempt);
    if (attempt.cookie) {
      // Main blocks new Google writes while isLoggingOut is true. Existing
      // writes were drained before this snapshot; a changed snapshot never deletes.
      attempt.removing = true;
      await attempt.context.session.cookies.remove(attempt.context.origin, 'personal');
      this.current(attempt);
      const remaining = await this.readCookie(attempt);
      check(remaining === null);
      this.current(attempt);
    }
    return { loggedOut: true };
  }
  async request(event, input) {
    let attempt, work;
    try {
      const context = this.context(event);
      check(
        this.attempts.size < SECURE_ACCOUNT_LIMITS.requests && !this.isLoggingOut(context.contents),
      );
      const { value, bytes } = snapshotSecureInput(
        input,
        Math.min(
          SECURE_ACCOUNT_LIMITS.requestBytes,
          SECURE_ACCOUNT_LIMITS.pendingBytes - this.bytes,
        ),
      );
      check(exact(value, ['action']) && ['status', 'logout'].includes(value.action));
      const abort = new AbortController(),
        signal = AbortSignal.any([
          abort.signal,
          (this.options.deadline ?? AbortSignal.timeout)(SECURE_ACCOUNT_LIMITS.deadlineMs),
        ]);
      attempt = {
        context,
        bytes,
        abort,
        signal,
        invalid: false,
        cookie: undefined,
        changed: undefined,
        removing: false,
        removed: false,
      };
      this.attempts.add(attempt);
      this.bytes += bytes;
      let draining;
      if (value.action === 'logout') {
        // Set the main-process write barrier and invalidate encrypted work before our first await.
        this.logout = attempt;
        for (const prior of this.attempts)
          if (prior !== attempt && prior.context.session === context.session) {
            prior.invalid = true;
            prior.abort.abort();
          }
        draining = this.options.onInvalidate?.(context.contents);
      }
      work = this.run(attempt, value.action, draining);
      const result = await bounded(work, signal);
      this.current(attempt);
      return { ok: true, value: result };
    } catch {
      return structuredClone(SECURE_ACCOUNT_ERROR);
    } finally {
      if (attempt) {
        const cleanup = () => {
          attempt.abort.abort();
          if (attempt.changed)
            attempt.context.session.cookies.removeListener('changed', attempt.changed);
          this.attempts.delete(attempt);
          this.bytes -= attempt.bytes;
          if (this.logout === attempt) this.logout = undefined;
        };
        // Electron cookie calls are not cancelable. Keep the write barrier and
        // finite reservation until an outstanding call has actually settled.
        if (work) void work.then(cleanup, cleanup);
        else cleanup();
      }
    }
  }
}

module.exports = { DesktopSecureAccount, SECURE_ACCOUNT_ERROR, SECURE_ACCOUNT_LIMITS };
