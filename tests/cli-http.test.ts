import test from 'node:test';
import assert from 'node:assert/strict';
import { CliHttp, serverOrigin } from '../src/cli/http';
import { localCliProof, type LocalCliConnectionLease } from '../src/bridge/local-cli-connection';
const local: LocalCliConnectionLease = {
  connection: {
    version: 1,
    instanceId: 'instance',
    origin: 'http://127.0.0.1:12345',
    secret: 'a'.repeat(32),
    ownerId: 'owner',
    deviceId: 'device',
    runtimeWorkspaceId: 'runtime',
    machineId: 'machine',
    userId: 'user',
  },
  assertCurrent() {},
};
test('CLI HTTP rejects unsafe origins, redirects and limits responses without forwarding server errors', async () => {
  for (const origin of [
    'http://localhost:1',
    'http://example.com',
    'https://x.invalid/path',
    'https://name:secret@x.invalid',
    'https://x.invalid/#fragment',
  ])
    assert.throws(() => serverOrigin(origin));
  let called = 0;
  const http = new CliHttp(
    { origin: 'https://synthetic.invalid', cookie: 'personal=' + 'a'.repeat(32), owner: 'owner' },
    {
      fetch: (async (_url, init) => {
        called++;
        assert.equal(init?.redirect, 'error');
        return new Response(JSON.stringify({ error: 'PRIVATE_SECRET_DIAGNOSTIC' }), {
          status: 502,
        });
      }) as typeof fetch,
    },
  );
  await assert.rejects(
    http.json('/api/me'),
    (error) => error instanceof Error && !error.message.includes('PRIVATE_SECRET'),
  );
  assert.equal(called, 1);
  const huge = new CliHttp(
    { origin: 'https://synthetic.invalid' },
    { fetch: (async () => new Response('"' + 'x'.repeat(100) + '"')) as typeof fetch },
  );
  await assert.rejects(huge.request('/api/me', undefined, 10), /超过/);
});
test('descriptor preflight sends no credential to changed instance and rechecks local lease after response', async () => {
  const calls: RequestInit[] = [];
  let instance = 'other',
    revoked = false;
  const http = new CliHttp(
    {
      origin: local.connection.origin,
      cookie: 'personal=' + local.connection.secret,
      owner: 'owner',
    },
    {
      local: {
        ...local,
        assertCurrent() {
          if (revoked) throw new Error('private descriptor');
        },
      },
      fetch: (async (url, init) => {
        calls.push(init ?? {});
        if (new URL(String(url)).pathname === '/api/local-instance') {
          const challenge = new URL(String(url)).searchParams.get('challenge')!;
          return Response.json({
            instanceId: instance,
            challenge,
            proof: localCliProof(instance, challenge, local.connection.secret),
          });
        }
        assert.equal(new Headers(init?.headers).get('X-Moor-Instance'), 'instance');
        revoked = true;
        return Response.json({ owner: 'owner' });
      }) as typeof fetch,
    },
  );
  await assert.rejects(http.identity(), /实例/);
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0]!.headers).get('Cookie'), null);
  instance = 'instance';
  await assert.rejects(http.identity(), /实例/);
  assert.equal(calls.length, 3);
});

test('HTTP and streaming response deadlines are injected and terminate without a retry', async () => {
  const deadline = new AbortController();
  let calls = 0;
  const http = new CliHttp(
    { origin: 'https://synthetic.invalid' },
    {
      deadline: () => deadline.signal,
      fetch: (async () => {
        calls++;
        return new Promise<Response>(() => {});
      }) as typeof fetch,
    },
  );
  const request = http.json('/api/me');
  deadline.abort();
  await assert.rejects(request);
  assert.equal(calls, 1);
  const streamDeadline = new AbortController();
  let streamStarted!: () => void;
  const entered = new Promise<void>((r) => {
    streamStarted = r;
  });
  const stream = new CliHttp(
    { origin: 'https://synthetic.invalid' },
    {
      deadline: () => streamDeadline.signal,
      fetch: (async () => {
        return new Response(
          new ReadableStream({
            pull() {
              streamStarted();
              return new Promise(() => {});
            },
          }),
        );
      }) as typeof fetch,
    },
  );
  const reading = stream.json('/api/me');
  await entered;
  streamDeadline.abort();
  await assert.rejects(reading);
});
