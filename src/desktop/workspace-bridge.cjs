const { snapshotSecureInput } = require('./secure-input.cjs');
const { CLIENT_ORIGIN, isTrustedClientUrl } = require('./client-assets.cjs');

const ERROR = Object.freeze({
  ok: false,
  error: {
    code: 'unavailable',
    status: null,
    rejected: false,
    message: '连接或原操作结果未确认，请重新读取目标并手动核查原操作。',
  },
});
const LIMITS = Object.freeze({
  pending: 16,
  requestBytes: 48 * 1024 * 1024,
  pendingBytes: 96 * 1024 * 1024,
});
const check = (value) => {
  if (!value) throw Error('Workspace connection unavailable');
};
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
function remoteCookie(values, target, now) {
  check(Array.isArray(values) && values.length === 1);
  const value = values[0];
  check(
    value.name === 'personal' &&
      value.path === '/' &&
      value.httpOnly === true &&
      value.hostOnly === true &&
      value.domain === new URL(target).hostname &&
      value.sameSite === 'strict' &&
      (!target.startsWith('https:') || value.secure === true) &&
      typeof value.value === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(value.value) &&
      Buffer.from(value.value, 'base64url').toString('base64url') === value.value &&
      (value.session === true ||
        (Number.isFinite(value.expirationDate) && value.expirationDate > now / 1000)),
  );
  return {
    cookie: 'personal=' + value.value,
    expiresAt: value.session ? Infinity : value.expirationDate * 1000,
  };
}

/** A packaged main frame can select only native-owned local/remote connections. */
class DesktopWorkspaceBridge {
  constructor(options) {
    this.options = options;
    this.slots = new Map();
    this.active = 0;
    this.bytes = 0;
    this.closed = false;
  }
  context(event) {
    const contents = event?.sender,
      frame = event?.senderFrame;
    const registered = this.options.registry.get(contents);
    check(
      !this.closed &&
        registered?.trustedClient === true &&
        registered.window === this.options.window() &&
        !registered.window.isDestroyed() &&
        !contents.isDestroyed() &&
        registered.window.webContents === contents &&
        frame === contents.mainFrame &&
        frame.origin === CLIENT_ORIGIN &&
        isTrustedClientUrl(frame.url),
    );
    return { contents, frame, registered };
  }
  current(slot) {
    check(!slot.invalid && this.slots.get(slot.source) === slot);
    const context = this.context({
      sender: slot.context.contents,
      senderFrame: slot.context.frame,
    });
    check(context.registered === slot.context.registered);
    if (slot.source === 'local') check(slot.local && this.options.local() === slot.local);
    else
      check(
        this.options.origin() === slot.origin &&
          context.registered.origin === slot.origin &&
          (this.options.now ?? Date.now)() < slot.expiresAt,
      );
  }
  invalidate(contents, source) {
    for (const [key, slot] of this.slots) {
      if ((contents && slot.context.contents !== contents) || (source && key !== source)) continue;
      this.slots.delete(key);
      slot.invalid = true;
      if (slot.changed)
        slot.context.contents.session.cookies.removeListener('changed', slot.changed);
      try {
        slot.client?.close();
      } catch {}
    }
  }
  close() {
    this.closed = true;
    this.invalidate();
  }
  slot(context, source) {
    const prior = this.slots.get(source);
    if (prior) {
      try {
        this.current(prior);
        check(prior.context.contents === context.contents && prior.context.frame === context.frame);
        return prior;
      } catch {
        this.invalidate(undefined, source);
      }
    }
    const slot = { source, context, invalid: false, expiresAt: Infinity };
    if (source === 'local') {
      slot.local = this.options.local();
      check(slot.local);
      slot.origin = origin(slot.local.origin);
    } else {
      slot.origin = origin(this.options.origin());
      check(context.registered.origin === slot.origin);
      slot.changed = (_event, cookie) => {
        if (
          cookie?.name === 'personal' &&
          cookie.domain?.replace(/^\./, '') === new URL(slot.origin).hostname
        )
          this.invalidate(undefined, 'remote');
      };
      context.contents.session.cookies.on('changed', slot.changed);
    }
    this.slots.set(source, slot);
    slot.ready = (async () => {
      try {
        const runtime = await this.options.loadRuntime();
        this.current(slot);
        let cookie;
        if (source === 'local') cookie = slot.local.cookie;
        else {
          const credentials = remoteCookie(
            await context.contents.session.cookies.get({ url: slot.origin, name: 'personal' }),
            slot.origin,
            (this.options.now ?? Date.now)(),
          );
          this.current(slot);
          cookie = credentials.cookie;
          slot.expiresAt = credentials.expiresAt;
        }
        this.current(slot);
        slot.client = new runtime.DesktopWorkspaceClient({
          source,
          origin: slot.origin,
          cookie,
          ...(source === 'local' ? { localIdentity: slot.local.identity } : {}),
          current: () => this.current(slot),
        });
        return slot.client;
      } catch (error) {
        if (this.slots.get(source) === slot) this.invalidate(undefined, source);
        throw error;
      }
    })();
    return slot;
  }
  async request(event, input) {
    let reservation;
    try {
      const context = this.context(event);
      check(this.active < LIMITS.pending);
      reservation = snapshotSecureInput(input, LIMITS.requestBytes);
      check(this.bytes + reservation.bytes <= LIMITS.pendingBytes);
      const value = reservation.value;
      check(
        value &&
          ['catalog', 'execute', 'attention'].includes(value.action) &&
          ['local', 'remote'].includes(value.source),
      );
      const keys =
        value.action === 'catalog'
          ? ['action', 'source']
          : value.action === 'attention'
            ? ['action', 'source', 'connectionId', 'target', 'actor', 'command']
            : ['action', 'source', 'connectionId', 'target', 'command'];
      check(
        Object.keys(value).length === keys.length &&
          Object.keys(value).every((key) => keys.includes(key)),
      );
      this.active++;
      this.bytes += reservation.bytes;
      reservation.admitted = true;
      const slot = this.slot(context, value.source),
        client = await slot.ready;
      this.current(slot);
      const result = await client.request(value);
      this.current(slot);
      return snapshotSecureInput(result, LIMITS.requestBytes).value;
    } catch {
      return structuredClone(ERROR);
    } finally {
      if (reservation?.admitted) {
        this.active--;
        this.bytes -= reservation.bytes;
      }
    }
  }
}
module.exports = {
  DesktopWorkspaceBridge,
  WORKSPACE_CLIENT_ERROR: ERROR,
  WORKSPACE_CLIENT_LIMITS: LIMITS,
};
