const { isCurrentContentDocument } = require('./content-authority.cjs');
const { snapshotSecureInput } = require('./secure-input.cjs');

const SECURE_CLIENT_ERROR = Object.freeze({
  ok: false,
  error: {
    code: 'unavailable',
    message: '加密连接已失效或暂不可用，请核对原操作后手动继续。',
    status: null,
    rejected: false,
  },
});
const SECURE_CLIENT_IPC_LIMITS = Object.freeze({
  requests: 16,
  requestBytes: 48 * 1024 * 1024,
  pendingBytes: 96 * 1024 * 1024,
});
const actions = new Set([
  'status',
  'device-pair',
  'device-renew',
  'device-cancel',
  'device-accept',
  'connect',
  'disconnect',
  'catalog',
  'execute',
  'legacy-operation',
  'catalog-action',
  'catalog-operation',
]);
function check(value) {
  if (!value) throw new Error(SECURE_CLIENT_ERROR.error.message);
}
function serverOrigin(value) {
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
function cookieValue(cookies, target, now) {
  check(Array.isArray(cookies) && cookies.length === 1);
  const value = cookies[0];
  check(
    value.name === 'personal' &&
      value.path === '/' &&
      value.httpOnly === true &&
      value.hostOnly === true &&
      value.domain === new URL(target).hostname &&
      value.sameSite === 'strict' &&
      (target.startsWith('https:') ? value.secure === true : true) &&
      typeof value.value === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(value.value) &&
      Buffer.from(value.value, 'base64url').toString('base64url') === value.value &&
      (value.session === true ||
        (Number.isFinite(value.expirationDate) && value.expirationDate > now / 1000)),
  );
  return {
    cookie: 'personal=' + value.value,
    expiresAt: value.session === true ? Infinity : value.expirationDate * 1000,
  };
}

/**
 * Main-process bridge for one trusted client document. The registry and all
 * filesystem, authentication and runtime factories are owned by main, never IPC.
 * @param {{registry: Map<any, any>, remoteWindow: () => any, origin: () => string,
 * endpointPath: () => string, loadRuntime: () => Promise<any>, now?: () => number}} options
 */
class DesktopSecureBridge {
  constructor(options) {
    this.options = options;
    this.closed = false;
    this.slot = undefined;
    this.active = 0;
    this.bytes = 0;
  }
  context(event) {
    const contents = event?.sender,
      frame = event?.senderFrame;
    const registered = this.options.registry.get(contents),
      target = serverOrigin(this.options.origin());
    check(
      !this.closed &&
        registered?.trustedClient === true &&
        registered.window === this.options.remoteWindow() &&
        registered.origin === target &&
        isCurrentContentDocument(registered, contents, frame),
    );
    return { contents, frame, registered, origin: target, session: contents.session };
  }
  current(slot) {
    check(!slot.invalid && this.slot === slot);
    const fresh = this.context({ sender: slot.context.contents, senderFrame: slot.context.frame });
    check(
      fresh.registered === slot.context.registered &&
        fresh.origin === slot.context.origin &&
        fresh.session === slot.context.session,
    );
  }
  invalidate(contents) {
    const slot = this.slot;
    if (!slot || (contents && slot.context.contents !== contents)) return;
    this.slot = undefined;
    slot.invalid = true;
    slot.context.session.cookies.removeListener('changed', slot.cookieChanged);
    try {
      slot.service?.close();
    } catch {
      // The authority is already invalid. A shutdown diagnostic must not escape
      // a cookie/navigation callback or restore the old document's privileges.
    }
  }
  close() {
    this.closed = true;
    this.invalidate();
  }
  owned(context) {
    const prior = this.slot;
    if (prior) {
      try {
        this.current(prior);
        check(prior.context.contents === context.contents && prior.context.frame === context.frame);
        return prior;
      } catch {
        this.invalidate();
      }
    }
    const slot = {
      context,
      invalid: false,
      service: undefined,
      pending: undefined,
      cookieChanged: undefined,
    };
    slot.cookieChanged = (_event, cookie) => {
      if (cookie?.name !== 'personal') return;
      const domain = String(cookie.domain ?? '').replace(/^\./, ''),
        host = new URL(context.origin).hostname;
      if (!domain || host === domain || host.endsWith('.' + domain))
        this.invalidate(context.contents);
    };
    this.slot = slot;
    context.session.cookies.on('changed', slot.cookieChanged);
    return slot;
  }
  async service(slot) {
    if (!slot.pending) {
      const endpointPath = this.options.endpointPath();
      slot.pending = (async () => {
        const runtime = await this.options.loadRuntime();
        this.current(slot);
        const service = new runtime.DesktopSecureClient({
          endpointPath,
          authenticate: async () => {
            this.current(slot);
            const cookies = await slot.context.session.cookies.get({
              url: slot.context.origin,
              name: 'personal',
            });
            this.current(slot);
            const cookie = cookieValue(
              cookies,
              slot.context.origin,
              (this.options.now ?? Date.now)(),
            );
            const current = () => {
              this.current(slot);
              if ((this.options.now ?? Date.now)() >= cookie.expiresAt) {
                this.invalidate();
                check(false);
              }
            };
            const account = await runtime.authenticateDesktopAccount({
              origin: slot.context.origin,
              cookie: cookie.cookie,
              current,
            });
            current();
            return account;
          },
        });
        try {
          this.current(slot);
        } catch (error) {
          service.close();
          throw error;
        }
        slot.service = service;
        return service;
      })();
    }
    return slot.pending;
  }
  async request(event, input) {
    let reserved = 0;
    let slot;
    try {
      const context = this.context(event);
      check(this.active < SECURE_CLIENT_IPC_LIMITS.requests);
      const { value, bytes } = snapshotSecureInput(
        input,
        Math.min(
          SECURE_CLIENT_IPC_LIMITS.requestBytes,
          SECURE_CLIENT_IPC_LIMITS.pendingBytes - this.bytes,
        ),
      );
      check(
        value && typeof value === 'object' && !Array.isArray(value) && actions.has(value.action),
      );
      check(
        bytes <= SECURE_CLIENT_IPC_LIMITS.requestBytes &&
          this.bytes + bytes <= SECURE_CLIENT_IPC_LIMITS.pendingBytes,
      );
      this.active++;
      this.bytes += bytes;
      reserved = bytes;
      slot = this.owned(context);
      const service = await this.service(slot);
      this.current(slot);
      const result = await service.request(value);
      this.current(slot);
      return result;
    } catch {
      if (slot && this.slot === slot) {
        try {
          this.current(slot);
        } catch {
          this.invalidate();
        }
      }
      return structuredClone(SECURE_CLIENT_ERROR);
    } finally {
      if (reserved) {
        this.active--;
        this.bytes -= reserved;
      }
    }
  }
}

module.exports = { DesktopSecureBridge, SECURE_CLIENT_ERROR, SECURE_CLIENT_IPC_LIMITS };
