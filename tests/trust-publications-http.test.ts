import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest, type ServerResponse } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK } from 'jose';
import { Store, hash } from '../src/relay/accounts';
import { createApp } from '../src/relay/http';
import { RelayTrustPublications, TRUST_PUBLICATION_FAILED } from '../src/relay/trust-publications';
import { generateDeviceEncryptionKey, exportDevicePrivateJwk } from '../src/security/e2ee-crypto';
import {
  encryptionKeyId,
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
  type TrustManifest,
  type TrustPin,
} from '../src/security/e2ee-trust';
import {
  TRUST_PUBLICATION_LIMITS,
  trustPageSchema,
  trustPublishReceiptSchema,
  type PublicTrustEntry,
} from '../src/security/trust-publication';

const publishPath = '/api/security/trust/publish',
  readPath = '/api/security/trust/read';
const copy = <T>(value: T): T => structuredClone(value);
const owner = 'synthetic-owner';
const digest = (value: number) => Buffer.alloc(32, value).toString('base64url');
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext, options: { localOnly?: boolean } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-trust-http-')));
  const file = join(directory, 'relay.sqlite');
  let now = 1_800_000_000_000;
  let store = new Store(file, () => now);
  const secret = await store.setup('owner@synthetic.invalid', 'synthetic-password-long', owner);
  store.db
    .prepare('INSERT INTO account(id,email,salt,password) VALUES(?,?,NULL,NULL)')
    .run('other-owner', 'other@synthetic.invalid');
  const otherSecret = store.createLogin('other-owner');
  let app = createApp(store, {
    origin: 'http://127.0.0.1:0',
    setupToken: 'synthetic-setup',
    localOnly: options.localOnly,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = (app.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  app.setOrigin(origin);
  let closePromise: Promise<void> | undefined;
  const cleanup = new Set<() => void>();
  const stop = () => (closePromise ??= app.close());
  t.after(async () => {
    for (const release of cleanup) release();
    await stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const root = await generateTrustRoot(),
    deviceKey = await generateDeviceEncryptionKey();
  const pin: TrustPin = { accountId: owner, serverOrigin: origin, rootKeyId: root.keyId };
  const device = {
    deviceId: 'synthetic-mac',
    keyId: await encryptionKeyId(deviceKey.publicKey),
    publicKey: deviceKey.publicKey,
    roles: ['client', 'host'] as ('client' | 'host')[],
  };
  async function entries(count: number, targetPin = pin) {
    const result: PublicTrustEntry[] = [];
    for (let epoch = 1; epoch <= count; epoch++) {
      const manifest: TrustManifest = {
        ...targetPin,
        version: 1,
        epoch,
        previous: result.at(-1)?.checkpoint.digest ?? null,
        devices: [copy(device)],
      };
      const signedManifest = await signTrustManifest({
        manifest,
        rootPublicKey: root.publicKey,
        rootPrivateKey: root.privateKey,
      });
      const trust = await VerifiedTrust.verify({
        signed: signedManifest,
        rootPublicKey: root.publicKey,
        pin: targetPin,
        previous: result.at(-1)?.checkpoint,
      });
      result.push({
        pin: copy(targetPin),
        rootPublicKey: copy(root.publicKey),
        checkpoint: copy(trust.checkpoint),
        signedManifest,
      });
    }
    return result;
  }
  const versions = await entries(4);
  const post = (
    path: string,
    input: unknown,
    overrides: {
      cookie?: string | null;
      origin?: string | null;
      bearer?: string;
      method?: string;
      raw?: string | Buffer;
      contentType?: string;
      keepAlive?: boolean;
    } = {},
  ) =>
    fetch(origin + path, {
      method: overrides.method ?? 'POST',
      redirect: 'manual',
      headers: {
        ...(overrides.keepAlive ? {} : { Connection: 'close' }),
        ...(overrides.cookie === null ? {} : { Cookie: overrides.cookie ?? `personal=${secret}` }),
        ...(overrides.origin === null ? {} : { Origin: overrides.origin ?? origin }),
        'Content-Type': overrides.contentType ?? 'application/json',
        ...(overrides.bearer ? { Authorization: `Bearer ${overrides.bearer}` } : {}),
      },
      ...((overrides.method ?? 'POST') === 'GET'
        ? {}
        : {
            body:
              overrides.raw instanceof Uint8Array
                ? new Uint8Array(overrides.raw)
                : (overrides.raw ?? JSON.stringify(input)),
          }),
    });
  const publish = (selected = versions) => ({ publicationVersion: 1, entries: selected });
  const read = (after: PublicTrustEntry['checkpoint'] | null = null, limit = 16) => ({
    publicationVersion: 1,
    pin: copy(pin),
    after,
    limit,
  });
  const rows = () =>
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => {
        const table = String(row.name);
        assert.match(table, /^[a-z_]+$/);
        return { table, rows: store.db.prepare(`SELECT * FROM ${table}`).all() };
      });
  return {
    get app() {
      return app;
    },
    get store() {
      return store;
    },
    origin,
    secret,
    otherSecret,
    root,
    deviceKey,
    pin,
    versions,
    entries,
    post,
    publish,
    read,
    rows,
    stop,
    onCleanup(release: () => void) {
      cleanup.add(release);
    },
    advance(ms: number) {
      now += ms;
    },
    async restart() {
      await stop();
      store.close();
      store = new Store(file, () => now);
      app = createApp(store, {
        origin,
        setupToken: 'synthetic-setup',
        localOnly: options.localOnly,
      });
      closePromise = undefined;
      app.server.listen(port, '127.0.0.1');
      await once(app.server, 'listening');
    },
  };
}
async function safeError(response: Response, status?: number) {
  if (status !== undefined) assert.equal(response.status, status);
  else assert.ok(response.status >= 400 && response.status < 600);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { error: TRUST_PUBLICATION_FAILED });
}
async function pausedBody(f: Awaited<ReturnType<typeof fixture>>, path: string, input: unknown) {
  const entered = once(f.app.server, 'request');
  const bytes = Buffer.from(JSON.stringify(input));
  const request = httpRequest(f.origin + path, {
    method: 'POST',
    agent: false,
    headers: {
      Cookie: `personal=${f.secret}`,
      Origin: f.origin,
      'Content-Type': 'application/json',
    },
  });
  const response = new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    request.on('error', reject);
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () =>
        resolve({
          status: response.statusCode!,
          data: JSON.parse(Buffer.concat(chunks).toString()),
        }),
      );
    });
  });
  // Keep the JSON incomplete so authorization is captured while the body remains outstanding.
  request.write(bytes.subarray(0, 1));
  await entered;
  return { response, finish: () => request.end(bytes.subarray(1)) };
}
function gateVerification(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const entered = signal(),
    release = signal();
  const original = crypto.subtle.verify.bind(crypto.subtle);
  let first = true;
  t.mock.method(crypto.subtle, 'verify', async (...args: Parameters<typeof original>) => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return original(...args);
  });
  f.onCleanup(release.resolve);
  return { entered, release };
}
async function beforeResponse(entered: ReturnType<typeof signal>, response: Promise<Response>) {
  await Promise.race([
    entered.promise,
    response.then(() => {
      throw Error('Request completed without the expected verification boundary');
    }),
  ]);
}

test('HTTP publishes genesis and consecutive versions, retries the original batch and returns only signed public material', async (t) => {
  const f = await fixture(t);
  const first = await f.post(publishPath, f.publish(f.versions.slice(0, 1)));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  const receipt = trustPublishReceiptSchema.parse(await first.json());
  assert.deepEqual(receipt.stored, [f.versions[0].checkpoint]);
  assert.deepEqual(receipt.head, f.versions[0].checkpoint);
  const batch = f.publish(f.versions.slice(1));
  const second = await f.post(publishPath, batch);
  assert.equal(second.status, 200);
  const next = trustPublishReceiptSchema.parse(await second.json());
  assert.deepEqual(
    next.stored,
    f.versions.slice(1).map((entry) => entry.checkpoint),
  );
  assert.deepEqual(next.head, f.versions[3].checkpoint);
  assert.deepEqual(await (await f.post(publishPath, batch)).json(), next);
  const read = await f.post(readPath, f.read());
  assert.equal(read.status, 200);
  const page = trustPageSchema.parse(await read.json());
  assert.deepEqual(page.entries, f.versions);
  assert.equal(page.complete, true);
  assert.deepEqual(page.head, f.versions[3].checkpoint);
  assert.equal(f.app.online('synthetic-mac'), false);
  const material = JSON.stringify({ receipts: [receipt, next], page, database: f.rows() });
  const privateRoot = await exportJWK(f.root.privateKey),
    privateDevice = await exportDevicePrivateJwk(f.deviceKey.privateKey);
  for (const secret of [privateRoot.d!, privateDevice.d, 'synthetic-password-long', f.secret])
    assert.equal(material.includes(secret), false);
  for (const field of [
    'privateKey',
    'rootPrivateKey',
    'recoveryCapsule',
    'recoveryKey',
    'sessionBody',
  ])
    assert.equal(material.includes(`"${field}"`), false);
});

test('public history survives relay restart and paginates against an explicit pinned head', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(publishPath, f.publish(f.versions.slice(0, 3)))).status, 200);
  const first = trustPageSchema.parse(await (await f.post(readPath, f.read(null, 1))).json());
  assert.deepEqual(first.entries, [f.versions[0]]);
  assert.equal(first.complete, false);
  await f.restart();
  assert.equal((await f.post(publishPath, f.publish(f.versions.slice(3)))).status, 200);
  const bounded = trustPageSchema.parse(
    await (
      await f.post(readPath, { ...f.read(first.entries[0].checkpoint), head: first.head })
    ).json(),
  );
  assert.deepEqual(bounded.entries, f.versions.slice(1, 3));
  assert.deepEqual(bounded.head, first.head);
  assert.equal(bounded.complete, true);
  const newer = trustPageSchema.parse(await (await f.post(readPath, f.read(first.head))).json());
  assert.deepEqual(newer.entries, [f.versions[3]]);
  const empty = trustPageSchema.parse(
    await (await f.post(readPath, { ...f.read(newer.head), head: newer.head })).json(),
  );
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.complete, true);
  assert.equal((await f.post(publishPath, f.publish(f.versions.slice(1, 3)))).status, 200);
});

test('both routes require the exact configured Origin and a personal login cookie even with arbitrary bearer credentials', async (t) => {
  const f = await fixture(t);
  for (const [path, input] of [
    [publishPath, f.publish()],
    [readPath, f.read()],
  ] as const) {
    for (const overrides of [
      { cookie: null },
      { cookie: 'personal=wrong' },
      { cookie: null, bearer: f.secret },
    ])
      await safeError(await f.post(path, input, overrides), 401);
    for (const overrides of [
      { origin: null },
      { origin: 'null' },
      { origin: 'https://foreign.example.test' },
      { origin: 'https://foreign.example.test', bearer: 'synthetic-bypass' },
      { origin: null, bearer: f.secret },
    ])
      await safeError(await f.post(path, input, overrides), 403);
  }
  await safeError(await f.post(readPath, f.read()), 404);
});

test('local-only hosts expose neither publication route regardless of cookies, Origin or method', async (t) => {
  const f = await fixture(t, { localOnly: true });
  for (const path of [publishPath, readPath])
    for (const overrides of [
      {},
      { cookie: null, origin: null, bearer: 'synthetic-bypass' },
      { method: 'GET' },
    ])
      await safeError(await f.post(path, {}, overrides), 404);
  assert.equal(JSON.stringify(f.rows()).includes(f.root.keyId), false);
});

test('account, root and server pins isolate public history and cannot be substituted by another login', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(publishPath, f.publish())).status, 200);
  await safeError(await f.post(readPath, f.read(), { cookie: `personal=${f.otherSecret}` }), 403);
  await safeError(
    await f.post(publishPath, f.publish(), { cookie: `personal=${f.otherSecret}` }),
    403,
  );
  for (const pin of [
    { ...f.pin, accountId: 'other-owner' },
    { ...f.pin, serverOrigin: 'https://foreign.example.test' },
  ]) {
    await safeError(await f.post(readPath, { ...f.read(), pin }), 403);
    const entries = await f.entries(1, pin);
    await safeError(await f.post(publishPath, f.publish(entries)), 403);
  }
  await safeError(
    await f.post(readPath, { ...f.read(), pin: { ...f.pin, rootKeyId: digest(42) } }),
    409,
  );
  const otherRoot = await generateTrustRoot(),
    changed = copy(f.versions[0]);
  changed.rootPublicKey = otherRoot.publicKey;
  await safeError(await f.post(publishPath, f.publish([changed])));
  const response = trustPageSchema.parse(await (await f.post(readPath, f.read())).json());
  assert.deepEqual(response.entries, f.versions);
});

test('strict fields, query policy and JSON media types reject extra private parameters without exposing them', async (t) => {
  const f = await fixture(t);
  for (const input of [
    { ...f.publish(), privateKey: 'synthetic-private-sentinel' },
    f.publish([
      { ...f.versions[0], rootPrivateKey: 'synthetic-private-sentinel' } as PublicTrustEntry,
    ]),
    { ...f.publish(), publicationVersion: 2 },
    f.publish([]),
    { ...f.read(), command: 'synthetic-private-sentinel' },
    { ...f.read(), limit: 17 },
    { ...f.read(), limit: 0 },
    { ...f.read(), after: { ...f.versions[0].checkpoint, accountId: 'other-owner' } },
  ])
    await safeError(await f.post('entries' in input ? publishPath : readPath, input), 400);
  for (const path of [publishPath, readPath]) {
    await safeError(await f.post(path + '?secret=synthetic-private-sentinel', {}), 400);
    await safeError(await f.post(path, {}, { method: 'GET' }), 404);
    await safeError(await f.post(path, {}, { contentType: 'text/plain' }), 415);
    await safeError(await f.post(path, {}, { contentType: 'application/jsonp' }), 415);
    await safeError(
      await f.post(path, {}, { contentType: 'application/json; charset=utf-16' }),
      415,
    );
  }
});

test('a forged genesis signature or invalid starting checkpoint cannot create a public root', async (t) => {
  const f = await fixture(t),
    forged = copy(f.versions[0]);
  const parts = forged.signedManifest.split('.');
  const signature = Buffer.from(parts[2], 'base64url');
  signature[0] ^= 1;
  parts[2] = signature.toString('base64url');
  forged.signedManifest = parts.join('.');
  for (const entry of [
    forged,
    { ...copy(f.versions[0]), checkpoint: { ...f.versions[0].checkpoint, digest: digest(99) } },
    f.versions[1],
  ]) {
    await safeError(await f.post(publishPath, f.publish([entry])));
    await safeError(await f.post(readPath, f.read()), 404);
  }
  assert.equal((await f.post(publishPath, f.publish(f.versions.slice(0, 1)))).status, 200);
});

test('bodies are bounded by raw bytes and invalid UTF-8 cannot be normalized into a publication', async (t) => {
  const f = await fixture(t);
  for (const raw of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from('null')])
    await safeError(await f.post(publishPath, {}, { raw }), 400);
  const exact = JSON.stringify(f.publish(f.versions.slice(0, 1))).padEnd(
    TRUST_PUBLICATION_LIMITS.wireBytes,
    ' ',
  );
  assert.equal(
    (await f.post(publishPath, {}, { raw: exact, contentType: 'application/json; charset=utf-8' }))
      .status,
    200,
  );
  // Keep an oversized upload's connection open so its early 413 can be read while
  // the client is still writing. Restart fixtures use fresh connections separately.
  await safeError(await f.post(publishPath, {}, { raw: exact + ' ', keepAlive: true }), 413);
  await safeError(
    await f.post(
      publishPath,
      {},
      { raw: JSON.stringify({ padding: '密'.repeat(400_000) }), keepAlive: true },
    ),
    413,
  );
  const chunked = await pausedBody(f, publishPath, {
    ...f.publish(),
    padding: 'x'.repeat(TRUST_PUBLICATION_LIMITS.wireBytes),
  });
  chunked.finish();
  assert.deepEqual(await chunked.response, {
    status: 413,
    data: { error: TRUST_PUBLICATION_FAILED },
  });
  const response = trustPageSchema.parse(await (await f.post(readPath, f.read())).json());
  assert.deepEqual(response.entries, [f.versions[0]]);
});

test('logout, login expiry, owner replacement, origin generation and closing invalidate a partially read request', async (t) => {
  for (const change of ['logout', 'expiry', 'owner', 'origin-roundtrip', 'close'] as const)
    await t.test(change, async (t) => {
      const f = await fixture(t);
      const pending = await pausedBody(f, publishPath, f.publish());
      let closed: Promise<void> | undefined;
      if (change === 'logout') {
        assert.equal((await f.post('/api/logout', {})).status, 200);
        f.store.createLogin(owner); // A fresh same-owner login does not revive the original request.
      } else if (change === 'expiry') f.advance(31 * 86400000);
      else if (change === 'owner')
        f.store.db
          .prepare('UPDATE login SET owner=? WHERE token=?')
          .run('other-owner', hash(f.secret));
      else if (change === 'origin-roundtrip') {
        f.app.setOrigin('https://changed.example.test');
        f.app.setOrigin(f.origin);
      } else closed = f.stop();
      pending.finish();
      const response = await pending.response;
      assert.equal(
        response.status,
        change === 'close' ? 503 : change === 'origin-roundtrip' ? 403 : 401,
      );
      assert.deepEqual(response.data, { error: TRUST_PUBLICATION_FAILED });
      await closed;
      assert.equal(JSON.stringify(f.rows()).includes(f.versions[0].signedManifest), false);
    });
});

test('a session revoked during real signature verification cannot commit late public metadata', async (t) => {
  for (const change of ['logout', 'expiry', 'origin-roundtrip', 'close'] as const)
    await t.test(change, async (t) => {
      const f = await fixture(t),
        gate = gateVerification(t, f);
      const pending = f.post(publishPath, f.publish());
      await beforeResponse(gate.entered, pending);
      let closed: Promise<void> | undefined;
      if (change === 'logout') f.store.logout(f.secret);
      else if (change === 'expiry') f.advance(31 * 86400000);
      else if (change === 'origin-roundtrip') {
        f.app.setOrigin('https://changed.example.test');
        f.app.setOrigin(f.origin);
      } else closed = f.stop();
      gate.release.resolve();
      await safeError(await pending);
      await closed;
      assert.equal(JSON.stringify(f.rows()).includes(f.versions[0].signedManifest), false);
    });
});

test('the HTTP boundary rechecks the original login before returning an already verified public page', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(publishPath, f.publish())).status, 200);
  const entered = signal(),
    release = signal();
  const original = RelayTrustPublications.prototype.read;
  t.mock.method(
    RelayTrustPublications.prototype,
    'read',
    async function (this: RelayTrustPublications, ...args: Parameters<typeof original>) {
      const result = await original.apply(this, args);
      entered.resolve();
      await release.promise;
      return result;
    },
  );
  f.onCleanup(release.resolve);
  const pending = f.post(readPath, f.read());
  await beforeResponse(entered, pending);
  f.store.logout(f.secret);
  release.resolve();
  await safeError(await pending, 401);
});

test('client disconnect during verification cannot turn an abandoned request into a publication', async (t) => {
  const f = await fixture(t),
    gate = gateVerification(t, f);
  const finished = signal(),
    original = RelayTrustPublications.prototype.publish;
  t.mock.method(
    RelayTrustPublications.prototype,
    'publish',
    async function (this: RelayTrustPublications, ...args: Parameters<typeof original>) {
      try {
        return await original.apply(this, args);
      } finally {
        finished.resolve();
      }
    },
  );
  let response!: ServerResponse;
  f.app.server.once('request', (_request, outgoing) => {
    response = outgoing;
  });
  const controller = new AbortController();
  const pending = fetch(f.origin + publishPath, {
    method: 'POST',
    headers: {
      Cookie: `personal=${f.secret}`,
      Origin: f.origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(f.publish()),
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending);
  await beforeResponse(gate.entered, pending);
  const closed = once(response, 'close');
  controller.abort();
  await closed;
  gate.release.resolve();
  await rejected;
  await finished.promise;
  await safeError(await f.post(readPath, f.read()), 404);
});
