import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createECDH, createHmac, createDecipheriv, createPublicKey, verify } from 'node:crypto';
import type { NotificationEnvelope } from '../src/notification-protocol';
import {
  createWebPushTransport,
  sendPushRequest,
  validatePushEndpoint,
  validatePushSubscription,
} from '../src/relay/web-push';

function keys(value: number) {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.alloc(32, value));
  return {
    ecdh,
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}
const application = keys(1),
  browser = keys(2),
  now = 10000;
const environment = {
  MOOR_WEB_PUSH_PUBLIC_KEY: application.publicKey,
  MOOR_WEB_PUSH_PRIVATE_KEY: application.privateKey,
  MOOR_WEB_PUSH_SUBJECT: 'mailto:operator@synthetic.invalid',
};
const subscription = {
  endpoint: 'https://web.push.apple.com/opaque-synthetic-token',
  keys: { p256dh: browser.publicKey, auth: Buffer.alloc(16, 3).toString('base64url') },
};
const event: NotificationEnvelope = {
  notificationVersion: 1,
  eventId: 'notification_' + 'a'.repeat(64),
  owner: 'account',
  deviceId: 'device',
  userId: 'local-user',
  machineId: 'machine',
  catalogWorkspaceId: 'catalog-workspace',
  replicaId: 'replica',
  workspaceId: 'workspace',
  localProjectId: 'project',
  sessionId: 'session',
  turnId: 'turn',
  kind: 'completed',
  createdAt: now,
  expiresAt: now + 60000,
};
function wire() {
  let answer!: (response: any) => void;
  let expire!: () => void;
  let clearCount = 0,
    calls = 0,
    destroyed = 0;
  const request = new EventEmitter() as any;
  const captured: { url?: URL; options?: any; body?: Buffer } = {};
  request.end = (body: Buffer) => {
    captured.body = body;
  };
  request.destroy = () => {
    destroyed++;
    request.emit('error', new Error('synthetic abort'));
  };
  return {
    request,
    captured,
    get calls() {
      return calls;
    },
    get cleared() {
      return clearCount;
    },
    get destroyed() {
      return destroyed;
    },
    dependencies: {
      now: () => now,
      request(url: URL, options: any, callback: (response: any) => void) {
        calls++;
        captured.url = url;
        captured.options = options;
        answer = callback;
        return request;
      },
      schedule(callback: () => void, milliseconds: number) {
        assert.equal(milliseconds, 8000);
        expire = callback;
        return () => {
          clearCount++;
        };
      },
    },
    respond(statusCode: number) {
      let closed = false;
      answer({
        statusCode,
        destroy() {
          closed = true;
        },
      });
      assert.equal(closed, true);
    },
    timeout() {
      expire();
    },
  };
}

test('push egress accepts only known production HTTPS origins and validates canonical P-256/auth keys', () => {
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/opaque',
    'https://fcm.googleapis.com/wp/opaque',
    'https://updates.push.services.mozilla.com/wpush/v2/opaque',
    subscription.endpoint,
  ])
    assert.equal(validatePushEndpoint(endpoint), endpoint);
  for (const endpoint of [
    'http://web.push.apple.com/token',
    'https://127.0.0.1/token',
    'https://[::1]/token',
    'https://localhost/token',
    'https://fcm.googleapis.com.evil.invalid/token',
    'https://web.push.apple.com@evil.invalid/token',
    'https://user@web.push.apple.com/token',
    'https://web.push.apple.com:8443/token',
    'https://web.push.apple.com/token#fragment',
    'https://web.push.apple.com/',
    'https://evil.push.apple.com/token',
    'https://web.push.apple.com\\@evil.invalid/token',
  ])
    assert.throws(() => validatePushEndpoint(endpoint), endpoint);
  assert.deepEqual(validatePushSubscription(subscription), subscription);
  for (const input of [
    { ...subscription, extra: true },
    {
      ...subscription,
      keys: { ...subscription.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') },
    },
    {
      ...subscription,
      keys: {
        ...subscription.keys,
        p256dh: browser.ecdh.getPublicKey(undefined, 'compressed').toString('base64url'),
      },
    },
    { ...subscription, keys: { ...subscription.keys, auth: 'A'.repeat(21) + 'B' } },
  ])
    assert.throws(() => validatePushSubscription(input));
});

test('Web Push is disabled by default or invalid VAPID configuration without exposing secrets', async () => {
  for (const env of [
    {},
    { ...environment, MOOR_WEB_PUSH_PRIVATE_KEY: 'private-secret-marker' },
    { ...environment, MOOR_WEB_PUSH_PUBLIC_KEY: browser.publicKey },
    { ...environment, MOOR_WEB_PUSH_SUBJECT: 'http://localhost/contact' },
  ]) {
    const fake = wire(),
      transport = createWebPushTransport(env, fake.dependencies);
    assert.equal(transport.state.configured, false);
    assert.equal(JSON.stringify(transport.state).includes('private-secret-marker'), false);
    assert.equal((await transport.send(subscription, event)).status, 'failed');
    assert.equal(fake.calls, 0);
  }
});

test('actual pinned web-push encrypts a metadata-only RFC 8291 payload and signs valid RFC 8292 VAPID', async () => {
  const fake = wire(),
    transport = createWebPushTransport(environment, fake.dependencies);
  assert.deepEqual(transport.state, { configured: true, publicKey: application.publicKey });
  const delivery = transport.send(subscription, event);
  assert.equal(fake.calls, 1);
  const { options, body } = fake.captured;
  assert.equal(options.method, 'POST');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.headers.TTL, 60);
  assert.equal(options.headers.Urgency, 'normal');
  assert.equal(options.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(body!.length < 4096);
  // Independently decrypt the actual library output using the RFC 8291 key schedule.
  const salt = body!.subarray(0, 16),
    publicLength = body![20]!;
  assert.equal(publicLength, 65);
  const senderPublic = body!.subarray(21, 21 + publicLength),
    encrypted = body!.subarray(21 + publicLength);
  const hmac = (key: Buffer, input: Buffer) => createHmac('sha256', key).update(input).digest();
  const shared = browser.ecdh.computeSecret(senderPublic);
  const authPrk = hmac(Buffer.from(subscription.keys.auth, 'base64url'), shared);
  const ikm = hmac(
    authPrk,
    Buffer.concat([
      Buffer.from('WebPush: info\0'),
      browser.ecdh.getPublicKey(),
      senderPublic,
      Buffer.from([1]),
    ]),
  );
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2);
  assert.deepEqual(JSON.parse(plain.subarray(0, -1).toString()), event);
  const authorization = String(options.headers.Authorization);
  const matched = /^vapid t=([^,]+), k=(.+)$/.exec(authorization)!;
  assert.equal(matched[2], application.publicKey);
  const [header, claims, signature] = matched[1]!.split('.');
  assert.equal(
    JSON.parse(Buffer.from(claims!, 'base64url').toString()).aud,
    'https://web.push.apple.com',
  );
  const pub = application.ecdh.getPublicKey();
  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
  assert.equal(
    verify(
      'sha256',
      Buffer.from(header + '.' + claims),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature!, 'base64url'),
    ),
    true,
  );
  fake.respond(201);
  assert.deepEqual(await delivery, { status: 'sent', statusCode: 201 });
  assert.equal(fake.cleared, 1);
});

test('transport rejects extra task content, oversized identities and expired events before network', async () => {
  const fake = wire(),
    transport = createWebPushTransport(environment, fake.dependencies);
  for (const input of [
    { ...event, body: 'task-body-marker' },
    {
      ...event,
      owner: 'x'.repeat(1000),
      userId: 'y'.repeat(1000),
      sessionId: 'z'.repeat(128),
      machineId: 'a'.repeat(128),
      localProjectId: 'b'.repeat(128),
      workspaceId: 'c'.repeat(128),
      turnId: 'd'.repeat(128),
      deviceId: 'e'.repeat(128),
      replicaId: 'f'.repeat(128),
      catalogWorkspaceId: 'g'.repeat(128),
    },
    { ...event, createdAt: 0, expiresAt: now },
  ])
    assert.equal((await transport.send(subscription, input as any)).status, 'failed');
  assert.equal(fake.calls, 0);
});

test('HTTP status handling never follows redirects and ambiguous transport failures never retry', async () => {
  const details = {
    endpoint: subscription.endpoint,
    method: 'POST',
    headers: {},
    body: Buffer.from('synthetic encrypted payload'),
  };
  for (const [code, status] of [
    [201, 'sent'],
    [404, 'expired'],
    [410, 'expired'],
    [302, 'failed'],
    [429, 'failed'],
    [503, 'unknown'],
  ] as const) {
    const fake = wire(),
      result = sendPushRequest(details, fake.dependencies);
    fake.respond(code);
    assert.deepEqual(await result, { status, statusCode: code });
    assert.equal(fake.calls, 1);
  }
  for (const mode of ['timeout', 'error']) {
    const fake = wire(),
      result = sendPushRequest(details, fake.dependencies);
    if (mode === 'timeout') fake.timeout();
    else fake.request.emit('error', new Error('synthetic private endpoint error'));
    assert.deepEqual(await result, { status: 'unknown' });
    assert.equal(fake.calls, 1);
    assert.equal(fake.cleared, 1);
  }
});

test('transport close aborts its own pending request and does not create a subsequent network request', async () => {
  const fake = wire(),
    transport = createWebPushTransport(environment, fake.dependencies);
  const pending = transport.send(subscription, event);
  transport.close!();
  assert.deepEqual(await pending, { status: 'unknown' });
  assert.equal(fake.destroyed, 1);
  assert.equal(fake.cleared, 1);
  assert.equal((await transport.send(subscription, event)).status, 'failed');
  assert.equal(fake.calls, 1);
});
