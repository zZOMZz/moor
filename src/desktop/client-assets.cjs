const filesystem = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const CLIENT_SCHEME = 'moor-client';
const CLIENT_ORIGIN = 'moor-client://app';
const CLIENT_URL = CLIENT_ORIGIN + '/remote/';
// Register before app.ready; install the returned handler on the window's own
// session.protocol after ready. No CSP bypass, Node worker access or SW cache.
const CLIENT_PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  bypassCSP: false,
  allowServiceWorkers: false,
  allowExtensions: false,
  codeCache: false,
  stream: false,
});
const CLIENT_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
  "connect-src 'self'; worker-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const fixed = Object.freeze({
  'index.html': 'text/html; charset=utf-8',
  'startup.js': 'text/javascript; charset=utf-8',
  'notification-worker.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'manifest.webmanifest': 'application/manifest+json',
  'THIRD_PARTY_NOTICES.txt': 'text/plain; charset=utf-8',
  'moor-logo.png': 'image/png',
  'icon-192.png': 'image/png',
  'icon-512.png': 'image/png',
  'apple-touch-icon.png': 'image/png',
  'favicon.ico': 'image/x-icon',
});
const hashed = /^[A-Za-z0-9_-]{1,100}-[A-Z0-9]{8}\.(js|wasm)$/;
const MAX_FILE = 32 * 1024 * 1024,
  MAX_TOTAL = 96 * 1024 * 1024,
  MAX_FILES = 256,
  MAX_ENTRIES = 4096;
const unavailable = 'Moor 客户端资源不可用';
function check(value) {
  if (!value) throw new Error(unavailable);
}
function clientPath(value) {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !/^moor-client:\/\/app\/[A-Za-z0-9_./-]*$/.test(value)
  )
    return undefined;
  try {
    const url = new URL(value);
    // Node returns origin === 'null' for custom schemes. Never trust that field.
    if (
      url.protocol !== CLIENT_SCHEME + ':' ||
      url.hostname !== 'app' ||
      url.host !== 'app' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== value
    )
      return undefined;
    return url.pathname;
  } catch {
    return undefined;
  }
}
function isTrustedClientUrl(value) {
  return value === CLIENT_URL && clientPath(value) === '/remote/';
}
function sameFile(a, b) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.nlink === b.nlink
  );
}
function headers(type, size) {
  return {
    'Content-Type': type,
    'Content-Length': String(size),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CLIENT_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Accept-Ranges': 'none',
  };
}
function requestHeaders(input) {
  const result = new Headers(input);
  let count = 0,
    size = 0;
  for (const [name, value] of result) {
    check(++count <= 64 && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value));
    size += name.length + value.length;
    check(size <= 32768);
  }
  for (const name of [
    'authorization',
    'proxy-authorization',
    'cookie',
    'content-length',
    'transfer-encoding',
    'if-range',
  ])
    check(!result.has(name));
  const origin = result.get('origin'),
    referer = result.get('referer'),
    site = result.get('sec-fetch-site');
  check(origin === null || origin === CLIENT_ORIGIN);
  check(referer === null || clientPath(referer) !== undefined);
  check(site === null || site === 'same-origin' || site === 'none');
  return result;
}

/**
 * Immutable program assets only. publicRoot is a main-process packaging path,
 * never renderer input. Snapshotting prevents later URL requests from selecting
 * or reopening filesystem paths. The injected fs/Response are for synthetic tests.
 * @param {{publicRoot: string, fs?: typeof filesystem, Response?: typeof globalThis.Response}} options
 */
async function createClientAssetHandler({
  publicRoot,
  fs = filesystem,
  Response: ResponseType = globalThis.Response,
}) {
  const assets = new Map();
  try {
    check(typeof publicRoot === 'string' && path.isAbsolute(publicRoot));
    const initial = await fs.lstat(publicRoot);
    check(initial.isDirectory() && !initial.isSymbolicLink());
    const root = await fs.realpath(publicRoot),
      rootInfo = await fs.lstat(root),
      directory = path.join(root, 'assets'),
      directoryInfo = await fs.lstat(directory);
    check(rootInfo.isDirectory() && initial.dev === rootInfo.dev && initial.ino === rootInfo.ino);
    check(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink());
    check((await fs.realpath(directory)) === directory);
    const entries = await fs.readdir(directory);
    check(entries.length <= MAX_ENTRIES);
    const names = entries.filter((name) => hashed.test(name)).sort();
    check(names.length > 0 && names.length + Object.keys(fixed).length <= MAX_FILES);
    check(names.some((name) => /^entry-[A-Z0-9]{8}\.js$/.test(name)));
    let total = 0;
    const inventory = [];
    async function directoriesCurrent() {
      const currentRoot = await fs.lstat(root),
        currentAssets = await fs.lstat(directory);
      check(
        currentRoot.isDirectory() &&
          currentRoot.dev === rootInfo.dev &&
          currentRoot.ino === rootInfo.ino &&
          currentAssets.isDirectory() &&
          currentAssets.dev === directoryInfo.dev &&
          currentAssets.ino === directoryInfo.ino &&
          (await fs.realpath(root)) === root &&
          (await fs.realpath(directory)) === directory,
      );
    }
    for (const filename of [...Object.keys(fixed), ...names.map((name) => 'assets/' + name)]) {
      await directoriesCurrent();
      const absolute = path.join(root, filename),
        before = await fs.lstat(absolute);
      check(
        before.isFile() &&
          !before.isSymbolicLink() &&
          before.nlink === 1 &&
          Number.isSafeInteger(before.size) &&
          before.size > 0 &&
          before.size <= MAX_FILE &&
          total + before.size <= MAX_TOTAL,
      );
      total += before.size;
      inventory.push({ filename, absolute, before });
    }
    for (const { filename, absolute, before } of inventory) {
      await directoriesCurrent();
      const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        const opened = await handle.stat();
        check(opened.isFile() && sameFile(before, opened));
        // One extra byte detects growth without an unbounded readFile allocation.
        const buffer = Buffer.alloc(before.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        check(offset === before.size && sameFile(before, await handle.stat()));
        check(sameFile(before, await fs.lstat(absolute)));
        await directoriesCurrent();
        bytes = Buffer.from(buffer.subarray(0, offset));
      } finally {
        await handle.close();
      }
      if (filename === 'index.html' || filename === 'startup.js')
        check(!/__ENTRY__|__PRELOADS__/.test(bytes.toString('utf8')));
      const pathname = filename === 'index.html' ? '/remote/' : '/' + filename;
      assets.set(pathname, {
        bytes,
        type:
          fixed[filename] ??
          (filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8'),
      });
    }
  } catch {
    throw new Error(unavailable);
  }
  return function clientAssets(request) {
    const head = request?.method === 'HEAD';
    function error(status, message, extra = {}) {
      const bytes = Buffer.from(message);
      return new ResponseType(head ? null : bytes, {
        status,
        headers: { ...headers('text/plain; charset=utf-8', bytes.byteLength), ...extra },
      });
    }
    try {
      if (!['GET', 'HEAD'].includes(request?.method))
        return error(405, 'Method not allowed', { Allow: 'GET, HEAD' });
      if (request.body != null) return error(400, 'Invalid request');
      const pathname = clientPath(request.url);
      if (pathname === undefined) return error(400, 'Invalid request');
      const inputHeaders = requestHeaders(request.headers);
      if (request.signal?.aborted) return error(400, 'Invalid request');
      const asset = assets.get(pathname);
      if (!asset) return error(404, 'Not found');
      if (inputHeaders.has('range'))
        return error(416, 'Range not supported', {
          'Content-Range': 'bytes */' + asset.bytes.byteLength,
        });
      return new ResponseType(head ? null : Buffer.from(asset.bytes), {
        status: 200,
        headers: headers(asset.type, asset.bytes.byteLength),
      });
    } catch {
      return error(400, 'Invalid request');
    }
  };
}

module.exports = {
  CLIENT_SCHEME,
  CLIENT_ORIGIN,
  CLIENT_URL,
  CLIENT_PRIVILEGES,
  CLIENT_CSP,
  isTrustedClientUrl,
  createClientAssetHandler,
};
