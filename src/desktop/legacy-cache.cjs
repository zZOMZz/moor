const filesystem = require('node:fs/promises');
const { isDeepStrictEqual } = require('node:util');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { snapshotSecureInput } = require('./secure-input.cjs');
const {
  legacyCachePrefixes,
  legacyReadSelection,
  legacyInventory,
} = require('./legacy-cache-keys.cjs');
const FAILURE = Object.freeze({
  ok: false,
  error: { message: '旧缓存尚未恢复。请核对原账号和电脑；原分区中的数据保持不变。' },
});
const check = (value) => {
  if (!value) throw Error('Legacy cache unavailable');
};
const same = (left, right) => {
  const keys = Object.keys(left).sort(),
    other = Object.keys(right).sort();
  return (
    JSON.stringify(keys) === JSON.stringify(other) && keys.every((key) => left[key] === right[key])
  );
};

function legacyOrigin(name) {
  const match = /^(https?)_([^/\\]+)_(0|[1-9][0-9]{0,4})\.indexeddb\.leveldb$/.exec(name);
  if (!match || Number(match[3]) > 65535) return;
  try {
    const url = new URL(match[1] + '://' + match[2] + (match[3] === '0' ? '' : ':' + match[3]));
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      name !== `${url.protocol.slice(0, -1)}_${url.hostname}_${url.port || '0'}.indexeddb.leveldb`
    )
      return;
    return url.origin;
  } catch {
    return;
  }
}

/** Reads only an old Moor partition through Chromium's own readonly IDB API. */
class DesktopLegacyCache {
  constructor(options) {
    this.options = options;
    this.busy = false;
    this.closed = false;
  }
  close() {
    this.closed = true;
    this.cancel?.();
  }
  async authority(event, value) {
    const workspace = this.options.workspace,
      context = workspace.context(event),
      slot = workspace.slot(context, value.source);
    const current = () => {
      check(!this.closed);
      workspace.current(slot);
      check(workspace.context(event).registered === context.registered);
    };
    const client = await slot.ready;
    current();
    let identity;
    const confirm = async () => {
      current();
      const result = await client.request({ action: 'catalog', source: value.source });
      current();
      check(
        result?.ok === true &&
          result.value.connectionId === value.connectionId &&
          result.value.source === value.source,
      );
      const found = result.value.targets.find((entry) => same(entry.target, value.target));
      check(found && found.target.owner === result.value.owner);
      const verified = { target: found.target, actor: result.value.actor ?? null };
      if (identity) check(isDeepStrictEqual(identity, verified));
      else identity = structuredClone(verified);
      return found.target;
    };
    const target = await confirm();
    return { current, confirm, target, actor: identity.actor };
  }
  async origins(source, target, current) {
    const fs = this.options.fs ?? filesystem,
      session = this.options.sessionFor(source);
    const storage = session.getStoragePath();
    check(typeof storage === 'string' && path.isAbsolute(storage));
    const root = await fs.realpath(storage),
      directory = path.join(root, 'IndexedDB');
    current();
    let info;
    try {
      info = await fs.lstat(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    check(
      info.isDirectory() && !info.isSymbolicLink() && (await fs.realpath(directory)) === directory,
    );
    const names = await fs.readdir(directory);
    check(names.length <= 4096);
    const origins = [];
    for (const name of names) {
      const origin = legacyOrigin(name);
      if (
        !origin ||
        (source === 'remote' ? origin !== target.serverKey : !origin.startsWith('http://127.0.0.1'))
      )
        continue;
      if (source === 'local' && new URL(origin).hostname !== '127.0.0.1') continue;
      const entry = await fs.lstat(path.join(directory, name));
      check(entry.isDirectory() && !entry.isSymbolicLink());
      origins.push(origin);
    }
    check(origins.length <= 256);
    current();
    return origins.sort();
  }
  async read(origin, source, target, current, actor, selection, keysOnly = false) {
    const readLimit = selection ? 256 * 1024 * 1024 : 96 * 1024 * 1024;
    const session = this.options.sessionFor(source),
      protocol = new URL(origin).protocol.slice(0, -1);
    const url = origin + '/__moor_read_legacy_cache__',
      nonce = (this.options.uuid ?? randomUUID)();
    let registered = false,
      window,
      readerId;
    try {
      current();
      session.webRequest.onBeforeRequest((details, callback) =>
        callback({
          cancel:
            details.url !== url ||
            details.resourceType !== 'mainFrame' ||
            details.webContentsId !== readerId,
        }),
      );
      session.protocol.handle(protocol, (request) => {
        check(request.url === url && request.method === 'GET');
        return new Response('<!doctype html><title>Moor cache recovery</title>', {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        });
      });
      registered = true;
      window = new this.options.BrowserWindow({
        show: false,
        webPreferences: {
          session,
          preload: this.options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          javascript: false,
        },
      });
      const contents = window.webContents;
      readerId = contents.id;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      for (const event of ['will-navigate', 'will-redirect'])
        contents.on(event, (event, next) => {
          if (next !== url) event.preventDefault();
        });
      contents.on('will-frame-navigate', (event) => {
        if (!event.isMainFrame || event.url !== url) event.preventDefault();
      });
      contents.on('will-attach-webview', (event) => event.preventDefault());
      const records = await new Promise((resolve, reject) => {
        let finished = false,
          timer;
        const finish = (error, records) => {
          if (finished) return;
          finished = true;
          (this.options.cancelTimer ?? clearTimeout)(timer);
          this.options.ipcMain.removeListener('moor:legacy-cache-result', receive);
          contents.removeListener('render-process-gone', gone);
          window.removeListener('closed', gone);
          this.cancel = undefined;
          error ? reject(error) : resolve(records);
        };
        const gone = () => finish(Error('Reader closed'));
        const receive = (event, input) => {
          if (event.sender !== contents) return;
          try {
            current();
            check(
              !contents.isDestroyed() &&
                event.senderFrame === contents.mainFrame &&
                event.senderFrame.url === url &&
                event.senderFrame.origin === origin,
            );
            const reply = snapshotSecureInput(input, keysOnly ? 40 * 1024 * 1024 : readLimit).value;
            const values = keysOnly ? reply.keys : reply.records;
            check(
              reply.nonce === nonce &&
                reply.ok === true &&
                Array.isArray(values) &&
                values.length <= (keysOnly ? 100000 : 10000) &&
                Object.keys(reply).sort().join(',') ===
                  (keysOnly ? 'keys,nonce,ok' : 'nonce,ok,records'),
            );
            finish(null, values);
          } catch (error) {
            finish(error);
          }
        };
        this.cancel = gone;
        timer = (this.options.schedule ?? setTimeout)(
          () => finish(Error('Reader deadline')),
          15000,
        );
        this.options.ipcMain.on('moor:legacy-cache-result', receive);
        contents.on('render-process-gone', gone);
        window.on('closed', gone);
        contents.once('dom-ready', () => {
          try {
            current();
            check(contents.mainFrame.url === url && contents.mainFrame.origin === origin);
            contents.send('moor:legacy-cache-read', {
              nonce,
              url,
              ...(keysOnly
                ? { prefixes: legacyCachePrefixes(target, origin, actor), keysOnly: true }
                : {
                    ...legacyReadSelection(target, origin, actor, selection),
                    ...(selection ? { scoped: true } : {}),
                  }),
            });
          } catch (error) {
            finish(error);
          }
        });
        void window.loadURL(url).catch((error) => finish(error));
      });
      current();
      return records;
    } finally {
      if (window && !window.isDestroyed()) window.close();
      session.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
      if (registered) session.protocol.unhandle(protocol);
    }
  }
  async request(event, raw) {
    let admitted = false;
    try {
      check(!this.closed && !this.busy);
      const input = snapshotSecureInput(raw, 16384).value;
      check(
        input &&
          ['list', 'index', 'read'].includes(input.action) &&
          ['local', 'remote'].includes(input.source),
      );
      const keys = [
        'action',
        'connectionId',
        'source',
        'target',
        ...(input.action !== 'list' ? ['origin'] : []),
        ...(input.action === 'index' && input.cursor !== undefined ? ['cursor'] : []),
        ...(input.action === 'read' && input.selection !== undefined ? ['selection'] : []),
      ].sort();
      check(
        Object.keys(input).sort().join(',') === keys.join(',') &&
          input.target &&
          typeof input.target === 'object',
      );
      if (input.selection !== undefined)
        check(
          input.selection &&
            (input.selection.kind === 'new'
              ? Object.keys(input.selection).join(',') === 'kind'
              : input.selection.kind === 'session' &&
                Object.keys(input.selection).sort().join(',') === 'kind,sessionId' &&
                typeof input.selection.sessionId === 'string' &&
                /^[A-Za-z0-9_-]{1,160}$/.test(input.selection.sessionId)),
        );
      if (input.cursor !== undefined)
        check(
          input.cursor &&
            Object.keys(input.cursor).sort().join(',') === 'after,version' &&
            typeof input.cursor.after === 'string' &&
            /^[A-Za-z0-9_-]{1,160}$/.test(input.cursor.after) &&
            typeof input.cursor.version === 'string' &&
            /^sha256:[a-f0-9]{64}$/.test(input.cursor.version),
        );
      this.busy = admitted = true;
      const authority = await this.authority(event, input);
      const origins = await this.origins(input.source, authority.target, authority.current);
      if (input.action === 'list') {
        await authority.confirm();
        return { ok: true, value: { origins } };
      }
      check(origins.includes(input.origin));
      const records = await this.read(
        input.origin,
        input.source,
        authority.target,
        authority.current,
        authority.actor,
        input.selection,
        input.action === 'index',
      );
      if (input.action === 'index') {
        check(
          records.every((key) => typeof key === 'string' && key.length <= 4096) &&
            new Set(records).size === records.length,
        );
        const keys = [...records].sort();
        const version =
          'sha256:' +
          createHash('sha256')
            .update(
              JSON.stringify({
                target: authority.target,
                origin: input.origin,
                actor: authority.actor,
                keys,
              }),
            )
            .digest('hex');
        const inventory = legacyInventory(authority.target, input.origin, authority.actor, keys);
        if (input.cursor && input.cursor.version !== version) {
          await authority.confirm();
          return {
            ok: false,
            error: { code: 'index-changed', message: '旧缓存目录已变化，请从第一页重新读取。' },
          };
        }
        if (input.cursor) check(inventory.sessionIds.includes(input.cursor.after));
        const start = input.cursor ? inventory.sessionIds.indexOf(input.cursor.after) + 1 : 0;
        const sessionIds = inventory.sessionIds.slice(start, start + 100);
        await authority.confirm();
        return {
          ok: true,
          value: {
            scope: { source: input.source, origin: input.origin, target: authority.target },
            version,
            sessionIds,
            total: inventory.sessionIds.length,
            hasNew: inventory.hasNew,
            ...(start + sessionIds.length < inventory.sessionIds.length
              ? { nextCursor: { version, after: sessionIds.at(-1) } }
              : {}),
          },
        };
      }
      const runtime = await this.options.loadRuntime();
      authority.current();
      const value = runtime.normalizeLegacyCache({
        source: input.source,
        origin: input.origin,
        target: authority.target,
        records,
        actor: authority.actor ?? undefined,
        ...(input.selection ? { selection: input.selection } : {}),
      });
      await authority.confirm();
      return snapshotSecureInput(
        { ok: true, value },
        input.selection ? 256 * 1024 * 1024 : 96 * 1024 * 1024,
      ).value;
    } catch {
      return structuredClone(FAILURE);
    } finally {
      if (admitted) this.busy = false;
    }
  }
}
module.exports = { DesktopLegacyCache, legacyOrigin };
