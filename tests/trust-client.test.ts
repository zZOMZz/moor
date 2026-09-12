import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TrustClient,
  TRUST_CLIENT_FAILED,
  type TrustClientOptions,
} from '../src/security/trust-client';
import { generateDeviceEncryptionKey } from '../src/security/e2ee-crypto';
import {
  encryptionKeyId,
  generateTrustRoot,
  signTrustManifest,
  VerifiedTrust,
  type TrustManifest,
} from '../src/security/e2ee-trust';
import {
  TRUST_PUBLICATION_LIMITS,
  type PublicTrustEntry,
  type TrustRead,
} from '../src/security/trust-publication';

const origin = 'https://synthetic-trust.invalid',
  owner = 'synthetic-owner';
const connection = {
  kind: 'moor-trust-connection',
  origin,
  owner,
  cookie: 'personal=' + 'a'.repeat(43),
};
const copy = <T>(value: T): T => structuredClone(value);
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const safe = (error: unknown) =>
  error instanceof Error && error.message === TRUST_CLIENT_FAILED && !Object.hasOwn(error, 'cause');
async function fixture() {
  const root = await generateTrustRoot(),
    key = await generateDeviceEncryptionKey();
  const pin = { accountId: owner, serverOrigin: origin, rootKeyId: root.keyId };
  const device = {
    deviceId: 'synthetic-host',
    publicKey: key.publicKey,
    keyId: await encryptionKeyId(key.publicKey),
    roles: ['host'] as ('host' | 'client')[],
  };
  const entries: PublicTrustEntry[] = [];
  for (let epoch = 1; epoch <= 4; epoch++) {
    const signedManifest = await signTrustManifest({
      rootPublicKey: root.publicKey,
      rootPrivateKey: root.privateKey,
      manifest: {
        ...pin,
        version: 1,
        epoch,
        previous: entries.at(-1)?.checkpoint.digest ?? null,
        devices: [device],
      },
    });
    const trust = await VerifiedTrust.verify({
      signed: signedManifest,
      rootPublicKey: root.publicKey,
      pin,
      previous: entries.at(-1)?.checkpoint,
    });
    entries.push({
      pin: copy(pin),
      rootPublicKey: copy(root.publicKey),
      checkpoint: copy(trust.checkpoint),
      signedManifest,
    });
  }
  const publish = { pin, rootPublicKey: root.publicKey, entries };
  const request: TrustRead = { publicationVersion: 1, pin, after: entries[0].checkpoint, limit: 2 };
  const receipt = {
    publicationVersion: 1,
    pin,
    rootPublicKey: root.publicKey,
    stored: entries.map((entry) => entry.checkpoint),
    head: entries[3].checkpoint,
  };
  const page = {
    publicationVersion: 1,
    pin,
    rootPublicKey: root.publicKey,
    after: request.after,
    head: entries[3].checkpoint,
    entries: entries.slice(1, 3),
    complete: false,
  };
  const calls: { path: string; init?: RequestInit }[] = [];
  let respond: (path: string, init?: RequestInit) => Response | Promise<Response> = (path) =>
    Response.json(
      path === '/api/me'
        ? { owner, needsSetup: false, localOnly: false }
        : path.endsWith('/publish')
          ? receipt
          : page,
    );
  const fetcher = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, init });
    return respond(path, init);
  }) as typeof fetch;
  const client = (options: TrustClientOptions = {}, value: unknown = connection) =>
    new TrustClient(value, { fetch: fetcher, ...options });
  return {
    root,
    pin,
    device,
    entries,
    publish,
    request,
    receipt,
    page,
    calls,
    client,
    setRespond(value: typeof respond) {
      respond = value;
    },
  };
}

test('publishing verifies signed local entries and exact receipts, using only identity and the fixed public endpoint', async () => {
  const f = await fixture();
  assert.deepEqual(await f.client().publish(f.publish), f.receipt);
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ['/api/me', '/api/security/trust/publish'],
  );
  for (const call of f.calls) {
    assert.equal(call.init?.redirect, 'error');
    assert.equal(call.init?.credentials, 'omit');
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get('Origin'), origin);
    assert.equal(headers.get('Cookie'), connection.cookie);
    assert.equal(headers.get('Authorization'), null);
  }
  assert.deepEqual(JSON.parse(String(f.calls[1].init?.body)), {
    publicationVersion: 1,
    entries: f.entries,
  });
  assert.equal(f.calls[0].init?.method, 'GET');
  assert.equal(f.calls[1].init?.method, 'POST');
});

test('input snapshots remain fixed across identity and crypto awaits', async () => {
  const f = await fixture(),
    entered = signal(),
    release = signal(),
    input = copy(f.publish);
  f.setRespond(async (path) => {
    if (path === '/api/me') {
      entered.resolve();
      await release.promise;
      return Response.json({ owner, needsSetup: false });
    }
    return Response.json(f.receipt);
  });
  const published = f.client().publish(input);
  await entered.promise;
  input.pin.accountId = 'changed';
  input.entries[0].signedManifest = 'changed';
  input.rootPublicKey.x = 'A'.repeat(43);
  release.resolve();
  assert.deepEqual(await published, f.receipt);
  assert.deepEqual(JSON.parse(String(f.calls[1].init?.body)), {
    publicationVersion: 1,
    entries: f.entries,
  });
});

test('wrong local scope sends no credential, and changed server identity never publishes', async () => {
  const f = await fixture();
  for (const value of [
    { ...connection, owner: 'other' },
    { ...connection, origin: 'https://other.invalid' },
  ])
    await assert.rejects(f.client({}, value).publish(f.publish), safe);
  assert.equal(f.calls.length, 0);
  for (const identity of [
    { owner: 'other', needsSetup: false },
    { owner: null, needsSetup: false },
    { owner, needsSetup: true },
    { owner, needsSetup: false, localOnly: true },
    { owner, needsSetup: false, secret: 'private-sentinel' },
  ]) {
    f.calls.length = 0;
    f.setRespond(() => Response.json(identity));
    await assert.rejects(f.client().publish(f.publish), safe);
    assert.deepEqual(
      f.calls.map((call) => call.path),
      ['/api/me'],
    );
  }
});

test('publication refuses missing, changed, reordered or cross-root storage receipts without retry', async () => {
  const f = await fixture();
  for (const receipt of [
    { ...f.receipt, stored: f.receipt.stored.slice(1) },
    { ...f.receipt, stored: copy(f.receipt.stored).reverse() },
    {
      ...f.receipt,
      stored: [{ ...f.receipt.stored[0], digest: 'A'.repeat(43) }, ...f.receipt.stored.slice(1)],
    },
    { ...f.receipt, pin: { ...f.pin, accountId: 'other' } },
    { ...f.receipt, rootPublicKey: { ...f.root.publicKey, x: 'A'.repeat(43) } },
    { ...f.receipt, extra: 'private-sentinel' },
  ]) {
    f.calls.length = 0;
    f.setRespond((path) =>
      Response.json(path === '/api/me' ? { owner, needsSetup: false } : receipt),
    );
    await assert.rejects(f.client().publish(f.publish), safe);
    assert.equal(f.calls.length, 2);
  }
});

test('read authenticates one contiguous page while an unreached relay head stays only a hint', async () => {
  const f = await fixture();
  const page = await f.client().read({ request: f.request, rootPublicKey: f.root.publicKey });
  assert.deepEqual(page, f.page);
  assert.equal(page.complete, false);
  assert.equal(page.entries.at(-1)!.checkpoint.epoch, 3);
  assert.equal(page.head.epoch, 4);
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ['/api/me', '/api/security/trust/read'],
  );
  const unverifiedHead = { ...f.entries[3].checkpoint, epoch: 1000, digest: 'A'.repeat(43) };
  f.setRespond((path) =>
    Response.json(
      path === '/api/me' ? { owner, needsSetup: false } : { ...f.page, head: unverifiedHead },
    ),
  );
  const hinted = await f.client().read({ request: f.request, rootPublicKey: f.root.publicKey });
  assert.equal(hinted.complete, false);
  assert.deepEqual(hinted.entries, f.page.entries);
  assert.deepEqual(hinted.head, unverifiedHead);
});

test('read rejects substituted scope, after, explicit head, page limits and false completion', async () => {
  const f = await fixture();
  for (const page of [
    { ...f.page, after: null },
    { ...f.page, pin: { ...f.pin, accountId: 'other' } },
    { ...f.page, rootPublicKey: { ...f.root.publicKey, y: 'A'.repeat(43) } },
    { ...f.page, complete: true },
    { ...f.page, entries: f.entries.slice(1) },
    { ...f.page, entries: f.entries.slice(2, 3) },
    { ...f.page, head: { ...f.page.head, digest: 'A'.repeat(43) } },
  ]) {
    f.calls.length = 0;
    f.setRespond((path) => Response.json(path === '/api/me' ? { owner, needsSetup: false } : page));
    await assert.rejects(
      f
        .client()
        .read({ request: { ...f.request, head: f.page.head }, rootPublicKey: f.root.publicKey }),
      safe,
    );
    assert.equal(f.calls.length, 2);
  }
});

test('valid signatures with the wrong previous digest cannot splice a page into local trust', async () => {
  const f = await fixture();
  const manifest: TrustManifest = {
    ...f.pin,
    version: 1,
    epoch: 2,
    previous: 'A'.repeat(43),
    devices: [f.device],
  };
  const signed = await signTrustManifest({
    manifest,
    rootPublicKey: f.root.publicKey,
    rootPrivateKey: f.root.privateKey,
  });
  // A forged page can lie about its checkpoint as well as its previous digest.
  const wrong = { ...f.entries[1], signedManifest: signed };
  f.setRespond((path) =>
    Response.json(
      path === '/api/me'
        ? { owner, needsSetup: false }
        : { ...f.page, entries: [wrong], head: f.entries[1].checkpoint, complete: true },
    ),
  );
  await assert.rejects(
    f.client().read({ request: f.request, rootPublicKey: f.root.publicKey }),
    safe,
  );
});

test('empty pages are accepted only at the exact authenticated local checkpoint', async () => {
  const f = await fixture(),
    after = f.entries[3].checkpoint;
  const page = { ...f.page, after, head: after, entries: [], complete: true };
  f.setRespond((path) => Response.json(path === '/api/me' ? { owner, needsSetup: false } : page));
  assert.deepEqual(
    await f.client().read({ request: { ...f.request, after }, rootPublicKey: f.root.publicKey }),
    page,
  );
  f.setRespond((path) =>
    Response.json(
      path === '/api/me'
        ? { owner, needsSetup: false }
        : { ...page, head: { ...after, digest: 'A'.repeat(43) } },
    ),
  );
  await assert.rejects(
    f.client().read({ request: { ...f.request, after }, rootPublicKey: f.root.publicKey }),
    safe,
  );
});

test('malformed, oversized, non-JSON, redirect and error responses stay fixed and never echo private data', async () => {
  const f = await fixture();
  const responses = [
    () => new Response(Buffer.from([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    () =>
      new Response('{"private":"private-sentinel"}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    () =>
      new Response('{"private":"private-sentinel"}', { headers: { 'Content-Type': 'text/html' } }),
    () =>
      new Response('{}', {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(TRUST_PUBLICATION_LIMITS.wireBytes + 1),
        },
      }),
    () =>
      new Response(' '.repeat(TRUST_PUBLICATION_LIMITS.wireBytes + 1), {
        headers: { 'Content-Type': 'application/json' },
      }),
    () =>
      new Response('{}', {
        status: 302,
        headers: {
          'Content-Type': 'application/json',
          Location: 'https://private-sentinel.invalid',
        },
      }),
  ];
  for (const response of responses) {
    f.calls.length = 0;
    f.setRespond((path) =>
      path === '/api/me' ? Response.json({ owner, needsSetup: false }) : response(),
    );
    await assert.rejects(f.client().publish(f.publish), safe);
    assert.equal(f.calls.length, 2);
  }
  f.setRespond(() => {
    throw new Error(connection.cookie + ' private-sentinel');
  });
  await assert.rejects(f.client().publish(f.publish), safe);
});

test('abort, deadline and current lease failures stop at the pending request without any automatic retry', async () => {
  for (const kind of ['signal', 'deadline', 'current'] as const) {
    const f = await fixture(),
      entered = signal(),
      release = signal(),
      controller = new AbortController();
    let current = true;
    f.setRespond(async (path) => {
      entered.resolve();
      await release.promise;
      return Response.json(path === '/api/me' ? { owner, needsSetup: false } : f.receipt);
    });
    const work = f
      .client({
        ...(kind === 'signal'
          ? { signal: controller.signal }
          : kind === 'deadline'
            ? { deadline: () => controller.signal }
            : {}),
        current: () => {
          if (!current) throw Error('private-sentinel');
        },
      })
      .publish(f.publish);
    await entered.promise;
    if (kind === 'current') current = false;
    else controller.abort();
    release.resolve();
    await assert.rejects(work, safe);
    assert.equal(f.calls.length, 1);
  }
});

test('lease invalidation during streamed publish response prevents a storage acknowledgment', async () => {
  const f = await fixture(),
    entered = signal(),
    release = signal();
  let current = true;
  f.setRespond((path) =>
    path === '/api/me'
      ? Response.json({ owner, needsSetup: false })
      : new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
              entered.resolve();
              await release.promise;
              controller.enqueue(new TextEncoder().encode(JSON.stringify(f.receipt).slice(1)));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
  );
  const work = f
    .client({
      current: () => {
        if (!current) throw Error('private-sentinel');
      },
    })
    .publish(f.publish);
  await entered.promise;
  current = false;
  release.resolve();
  await assert.rejects(work, safe);
  assert.equal(f.calls.length, 2);
});
