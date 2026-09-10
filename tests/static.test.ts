import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { serveStatic } from '../src/relay/static';

test('static assets revalidate, compress and reuse content-addressed scripts without caching API data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'moor-static-'));
  await mkdir(join(root, 'assets'));
  const content = '/* synthetic application asset */'.repeat(100);
  for (const file of [
    'index.html',
    'startup.js',
    'assets/app-ABCDEFG2.js',
    'assets/engine-ABCDEFG2.wasm',
  ]) {
    await writeFile(join(root, file), content);
    await writeFile(join(root, file + '.gz'), gzipSync(content));
  }
  const server = createServer((req, res) => {
    void serveStatic(req, res, join(root, req.url === '/' ? 'index.html' : req.url!)).catch(() => {
      res.writeHead(404);
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const initial = await fetch(origin + '/assets/app-ABCDEFG2.js');
  assert.equal(initial.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(initial.headers.get('content-encoding'), 'gzip');
  assert.equal(initial.headers.get('vary'), 'Accept-Encoding');
  assert.equal(await initial.text(), content);
  const etag = initial.headers.get('etag')!;
  const wasm = await fetch(origin + '/assets/engine-ABCDEFG2.wasm');
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.equal(wasm.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(wasm.headers.get('content-encoding'), 'gzip');
  assert.equal(await wasm.text(), content);
  for (const validator of [etag, `"other", ${etag}`, etag.slice(2), '*']) {
    const cached = await fetch(origin + '/assets/app-ABCDEFG2.js', {
      headers: { 'If-None-Match': validator },
    });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), '');
  }
  for (const file of ['/', '/startup.js']) {
    const response = await fetch(origin + file);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    await response.arrayBuffer();
  }
  for (const encoding of ['identity', 'gzip;q=0, *;q=1']) {
    const plain = await fetch(origin + '/startup.js', {
      headers: { 'Accept-Encoding': encoding },
    });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(await plain.text(), content);
  }
  await writeFile(join(root, 'startup.js'), '/* new build */');
  const updated = await fetch(origin + '/startup.js', {
    headers: { 'If-None-Match': etag, 'Accept-Encoding': 'identity' },
  });
  assert.equal(updated.status, 200);
  assert.notEqual(updated.headers.get('etag'), etag);
  assert.equal(await updated.text(), '/* new build */');
  const missing = await fetch(origin + '/api/me');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), null);
});
