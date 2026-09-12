import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIENT_SCHEME,
  CLIENT_ORIGIN,
  CLIENT_URL,
  CLIENT_PRIVILEGES,
  CLIENT_CSP,
  isTrustedClientUrl,
  createClientAssetHandler,
} from '../src/desktop/client-assets.cjs';

const unavailable = 'Moor 客户端资源不可用';
const files: Record<string, Buffer> = {
  'index.html': Buffer.from(
    '<!doctype html><html><script type="module" src="/startup.js"></script></html>',
  ),
  'startup.js': Buffer.from("import('/assets/entry-ABCDEFG1.js');"),
  'notification-worker.js': Buffer.from("self.onmessage = () => postMessage('synthetic');"),
  'style.css': Buffer.from('body { color: black }'),
  'manifest.webmanifest': Buffer.from('{"name":"Synthetic Moor","start_url":"/"}'),
  'THIRD_PARTY_NOTICES.txt': Buffer.from('Synthetic license notice'),
  'moor-logo.png': Buffer.from('synthetic png logo'),
  'icon-192.png': Buffer.from('synthetic png 192'),
  'icon-512.png': Buffer.from('synthetic png 512'),
  'apple-touch-icon.png': Buffer.from('synthetic apple icon'),
  'favicon.ico': Buffer.from('synthetic icon'),
  'assets/entry-ABCDEFG1.js': Buffer.from(
    "import './chunk-ABCDEFG2.js'; export const source = 'packaged';",
  ),
  'assets/chunk-ABCDEFG2.js': Buffer.from('export const synthetic = true;'),
  'assets/flock_wasm_bg-ABCDEFG3.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
};
async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'moor-client-assets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const publicRoot = join(directory, 'public');
  await fs.mkdir(join(publicRoot, 'assets'), { recursive: true });
  for (const [filename, bytes] of Object.entries(files))
    await fs.writeFile(join(publicRoot, filename), bytes);
  return { directory, publicRoot };
}
const req = (pathname: string, init: Record<string, unknown> = {}) => ({
  url: CLIENT_ORIGIN + pathname,
  method: 'GET',
  headers: new Headers(),
  body: null,
  ...init,
});

test('trusted client document has one canonical scheme and host even though Node reports a null origin', () => {
  assert.equal(new URL(CLIENT_URL).origin, 'null');
  assert.equal(isTrustedClientUrl(CLIENT_URL), true);
  assert.equal(CLIENT_SCHEME, 'moor-client');
  for (const url of [
    'null',
    new URL(CLIENT_URL),
    'moor-client://evil/remote/',
    'https://app/remote/',
    'moor-client://app/',
    'moor-client://app/remote',
    'moor-client://app/index.html',
    'moor-client://app/assets/entry-ABCDEFG1.js',
    'moor-client://app/remote/?',
    'moor-client://app/remote/#',
    'moor-client://app/remote/?flow=secret',
    'moor-client://app:443/remote/',
    'moor-client://user:secret@app/remote/',
    'moor-client://app.evil/remote/',
    'moor-client://APP/remote/',
    'MOOR-CLIENT://app/remote/',
    'moor-client://app/remote/../remote/',
    'moor-client://app/%72emote/',
  ])
    assert.equal(isTrustedClientUrl(url), false, String(url));
  assert.equal(new URL('/startup.js', CLIENT_URL).href, CLIENT_ORIGIN + '/startup.js');
  assert.deepEqual(CLIENT_PRIVILEGES, {
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
  assert.equal(Object.isFrozen(CLIENT_PRIVILEGES), true);
});

test('trusted client handler serves original packaged bytes, fixed MIME and complete HEAD metadata', async (t) => {
  const { publicRoot } = await fixture(t);
  const handler = await createClientAssetHandler({ publicRoot });
  for (const [filename, bytes] of Object.entries(files)) {
    const pathname = filename === 'index.html' ? '/remote/' : '/' + filename;
    const response = handler(req(pathname));
    assert.equal(response.status, 200, filename);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(response.headers.get('content-length'), String(bytes.byteLength));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('content-security-policy'), CLIENT_CSP);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('content-encoding'), null);
    const head = handler(req(pathname, { method: 'HEAD' }));
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.deepEqual([...head.headers], [...response.headers]);
  }
  const types = {
    '/remote/': 'text/html; charset=utf-8',
    '/startup.js': 'text/javascript; charset=utf-8',
    '/notification-worker.js': 'text/javascript; charset=utf-8',
    '/style.css': 'text/css; charset=utf-8',
    '/manifest.webmanifest': 'application/manifest+json',
    '/favicon.ico': 'image/x-icon',
    '/icon-192.png': 'image/png',
    '/THIRD_PARTY_NOTICES.txt': 'text/plain; charset=utf-8',
    '/assets/flock_wasm_bg-ABCDEFG3.wasm': 'application/wasm',
  };
  for (const [pathname, type] of Object.entries(types))
    assert.equal(handler(req(pathname)).headers.get('content-type'), type);
  assert.ok(
    await WebAssembly.compileStreaming(handler(req('/assets/flock_wasm_bg-ABCDEFG3.wasm'))),
  );
});

test('trusted client CSP allows only packaged scripts, workers and WASM without granting remote script or broad network access', async (t) => {
  const { publicRoot } = await fixture(t);
  const handler = await createClientAssetHandler({ publicRoot });
  const csp = handler(req('/remote/')).headers.get('content-security-policy')!;
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.equal(/https?:|wss?:|'unsafe-inline'|'unsafe-eval'|blob:|\*/.test(csp), false);
  assert.equal(handler(req('/sw.js')).status, 404);
});

test('trusted client protocol rejects raw traversal, escaping, noncanonical origins, queries and fragments', async (t) => {
  const { publicRoot } = await fixture(t);
  const handler = await createClientAssetHandler({ publicRoot });
  for (const url of [
    CLIENT_ORIGIN + '/assets/../startup.js',
    CLIENT_ORIGIN + '/../startup.js',
    CLIENT_ORIGIN + '/%2e%2e/startup.js',
    CLIENT_ORIGIN + '/assets%2fentry-ABCDEFG1.js',
    CLIENT_ORIGIN + '/assets%5centry-ABCDEFG1.js',
    CLIENT_ORIGIN + '/%252e%252e/private',
    CLIENT_ORIGIN + '/assets\\entry-ABCDEFG1.js',
    CLIENT_ORIGIN + '/startup.js?',
    CLIENT_ORIGIN + '/startup.js?type=text/html',
    CLIENT_ORIGIN + '/startup.js#private',
    CLIENT_ORIGIN + '/startup.js\n',
    CLIENT_ORIGIN + '/startup.js%00',
    'moor-client://app:1234/startup.js',
    'moor-client://secret@app/startup.js',
    'moor-client://app.evil/startup.js',
    'moor-client://app%2eevil/startup.js',
    'https://relay.synthetic.invalid/startup.js',
    'file:///private/synthetic-secret',
    'data:text/html,private',
    'moor-client://app/秘密.js',
    'moor-client://APP/startup.js',
  ]) {
    const response = handler(req('/remote/', { url }));
    assert.equal(response.status, 400, url);
    assert.equal(await response.text(), 'Invalid request');
  }
});

test('trusted client paths are an immutable allowlist, excluding directories, APIs, source maps, gzip and operator files', async (t) => {
  const { publicRoot } = await fixture(t);
  for (const filename of [
    'secrets.json',
    '.env',
    'unexpected.js',
    'assets/entry-ABCDEFG1.js.map',
    'assets/entry-ABCDEFG1.js.gz',
    'assets/draft.js',
  ])
    await fs.writeFile(join(publicRoot, filename), 'synthetic-private');
  const handler = await createClientAssetHandler({ publicRoot });
  for (const pathname of [
    '/',
    '/remote',
    '/index.html',
    '/assets/',
    '/assets',
    '/api/me',
    '/sw.js',
    '/secrets.json',
    '/.env',
    '/unexpected.js',
    '/assets/entry-ABCDEFG1.js.map',
    '/assets/entry-ABCDEFG1.js.gz',
    '/assets/draft.js',
    '/assets/missing-ABCDEFG4.js',
    '/style.css/',
  ]) {
    const response = handler(req(pathname));
    assert.equal(response.status, 404, pathname);
    assert.equal(await response.text(), 'Not found');
  }
  await fs.writeFile(join(publicRoot, 'assets/late-ABCDEFG4.js'), 'synthetic-private');
  assert.equal(handler(req('/assets/late-ABCDEFG4.js')).status, 404);
});

test('trusted client request headers cannot change MIME, supply credentials, bypass origins or request ranges', async (t) => {
  const { publicRoot } = await fixture(t);
  const handler = await createClientAssetHandler({ publicRoot });
  for (const headers of [
    { Authorization: 'Bearer synthetic-secret' },
    { Cookie: 'personal=synthetic-secret' },
    { 'Proxy-Authorization': 'synthetic-secret' },
    { 'Content-Length': '0' },
    { 'Transfer-Encoding': 'chunked' },
    { 'If-Range': 'private' },
    { Origin: 'null' },
    { Origin: 'https://relay.synthetic.invalid' },
    { Referer: 'https://relay.synthetic.invalid/?private' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'X-Oversized': 'x'.repeat(8193) },
  ])
    assert.equal(handler(req('/startup.js', { headers })).status, 400);
  const injected = [['X-Test', 'private\r\nContent-Type: text/html']];
  assert.equal(handler(req('/startup.js', { headers: injected })).status, 400);
  const normal = handler(
    req('/assets/flock_wasm_bg-ABCDEFG3.wasm', {
      headers: {
        Accept: 'text/html',
        'Accept-Encoding': 'gzip',
        Origin: CLIENT_ORIGIN,
        Referer: CLIENT_URL,
        'Sec-Fetch-Site': 'same-origin',
      },
    }),
  );
  assert.equal(normal.status, 200);
  assert.equal(normal.headers.get('content-type'), 'application/wasm');
  assert.equal(normal.headers.get('content-encoding'), null);
  const ranged = handler(
    req('/assets/flock_wasm_bg-ABCDEFG3.wasm', { headers: { Range: 'bytes=0-1' } }),
  );
  assert.equal(ranged.status, 416);
  assert.equal(ranged.headers.get('content-range'), 'bytes */8');
  assert.equal(ranged.headers.get('accept-ranges'), 'none');
});

test('trusted client rejects unsupported methods, request bodies and cancelled requests without changing assets', async (t) => {
  const { publicRoot } = await fixture(t);
  const handler = await createClientAssetHandler({ publicRoot });
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'get', undefined]) {
    const response = handler(req('/remote/', { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  assert.equal(handler(req('/remote/', { body: 'synthetic-private' })).status, 400);
  assert.equal(handler(req('/remote/', { signal: AbortSignal.abort() })).status, 400);
  const missingHead = handler(req('/missing', { method: 'HEAD' }));
  assert.equal(missingHead.status, 404);
  assert.equal(await missingHead.text(), '');
  assert.equal(missingHead.headers.get('content-length'), String(Buffer.byteLength('Not found')));
});

test('trusted client snapshots only packaged regular files and performs no filesystem IO when responding', async (t) => {
  const { publicRoot } = await fixture(t);
  const opened: string[] = [];
  let reads = 0;
  const tracked: any = {
    ...fs,
    async open(filename: string, flags: number) {
      opened.push(filename);
      assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
      return fs.open(filename, flags);
    },
  };
  const handler = await createClientAssetHandler({ publicRoot, fs: tracked });
  assert.equal(opened.length, Object.keys(files).length);
  for (const key of Object.keys(tracked))
    tracked[key] = () => {
      reads++;
      throw new Error('synthetic private IO');
    };
  await fs.rm(publicRoot, { recursive: true, force: true });
  assert.equal(await handler(new Request(CLIENT_URL)).text(), files['index.html'].toString());
  assert.equal(handler(req('/api/me')).status, 404);
  const first = new Uint8Array(await handler(req('/startup.js')).arrayBuffer());
  first.fill(0);
  assert.equal(await handler(req('/startup.js')).text(), files['startup.js'].toString());
  assert.equal(reads, 0);
});

test('trusted client refuses source templates and missing entry assets before returning a handler', async (t) => {
  for (const [filename, contents] of [
    ['startup.js', "import('__ENTRY__')"],
    ['index.html', '<!-- __PRELOADS__ -->'],
  ]) {
    const { publicRoot } = await fixture(t);
    await fs.writeFile(join(publicRoot, filename), contents);
    await assert.rejects(createClientAssetHandler({ publicRoot }), { message: unavailable });
  }
  const { publicRoot } = await fixture(t);
  await fs.unlink(join(publicRoot, 'assets/entry-ABCDEFG1.js'));
  await assert.rejects(createClientAssetHandler({ publicRoot }), { message: unavailable });
});

test('trusted client rejects root, directory and file symlinks, hardlinks and non-regular program paths', async (t) => {
  for (const kind of ['root', 'assets', 'file', 'hardlink', 'directory']) {
    const { directory, publicRoot } = await fixture(t);
    const secret = join(directory, 'synthetic-secret');
    await fs.writeFile(secret, 'synthetic-secret-not-served');
    let input = publicRoot;
    if (kind === 'root') {
      input = join(directory, 'linked-public');
      await fs.symlink(publicRoot, input);
    } else if (kind === 'assets') {
      await fs.rename(join(publicRoot, 'assets'), join(directory, 'external-assets'));
      await fs.symlink(join(directory, 'external-assets'), join(publicRoot, 'assets'));
    } else {
      const destination = join(publicRoot, 'startup.js');
      await fs.unlink(destination);
      if (kind === 'file') await fs.symlink(secret, destination);
      if (kind === 'hardlink') await fs.link(secret, destination);
      if (kind === 'directory') await fs.mkdir(destination);
    }
    await assert.rejects(createClientAssetHandler({ publicRoot: input }), { message: unavailable });
  }
});

test('trusted client bounds file size, total bytes and file count before opening payloads', async (t) => {
  for (const kind of ['file', 'total', 'count']) {
    const { publicRoot } = await fixture(t);
    let opens = 0;
    const tracked: any = {
      ...fs,
      async open(...args: Parameters<typeof fs.open>) {
        opens++;
        return fs.open(...args);
      },
      async lstat(filename: string) {
        const result = await fs.lstat(filename);
        if (result.isFile() && kind === 'file')
          Object.defineProperty(result, 'size', { value: 32 * 1024 * 1024 + 1 });
        if (result.isFile() && kind === 'total')
          Object.defineProperty(result, 'size', { value: 32 * 1024 * 1024 });
        return result;
      },
      async readdir(filename: string) {
        return kind === 'count'
          ? Array.from({ length: 257 }, (_, n) =>
              n === 0 ? 'entry-ABCDEFG1.js' : `chunk${n}-ABCDEFG1.js`,
            )
          : fs.readdir(filename);
      },
    };
    await assert.rejects(createClientAssetHandler({ publicRoot, fs: tracked }), {
      message: unavailable,
    });
    assert.equal(opens, 0);
  }
});

test('trusted client detects replacement between inventory and open without reading the replacement', async (t) => {
  const { publicRoot } = await fixture(t);
  let reads = 0,
    closed = 0;
  const tracked: any = {
    ...fs,
    async open(filename: string, flags: number) {
      if (filename.endsWith('/index.html')) {
        await fs.unlink(filename);
        await fs.writeFile(filename, 'synthetic-replacement');
      }
      const handle = await fs.open(filename, flags);
      return {
        stat: () => handle.stat(),
        read(...args: any[]) {
          reads++;
          return (handle.read as any)(...args);
        },
        async close() {
          closed++;
          await handle.close();
        },
      };
    },
  };
  await assert.rejects(createClientAssetHandler({ publicRoot, fs: tracked }), {
    message: unavailable,
  });
  assert.equal(reads, 0);
  assert.equal(closed, 1);
});

test('trusted client handler directly adapts to protocol.handle with injectable Response and no fetch proxy', async (t) => {
  const { publicRoot } = await fixture(t);
  let responses = 0;
  class SyntheticResponse extends Response {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init);
      responses++;
    }
  }
  const handler = await createClientAssetHandler({ publicRoot, Response: SyntheticResponse });
  const registered = new Map<string, (request: Request) => Response>();
  const protocol = {
    handle(scheme: string, callback: (request: Request) => Response) {
      registered.set(scheme, callback);
    },
  };
  protocol.handle(CLIENT_SCHEME, handler);
  const response = registered.get(CLIENT_SCHEME)!(new Request(CLIENT_URL));
  assert.equal(response.status, 200);
  assert.equal(responses, 1);
  assert.equal(await response.text(), files['index.html'].toString());
});
