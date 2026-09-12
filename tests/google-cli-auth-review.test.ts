import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliState } from '../src/cli/state';
import { CLI_GOOGLE_FAILED, CLI_GOOGLE_FLOW_KEY, CliGoogleAuth } from '../src/cli/google-auth';

test('a relay clock two seconds ahead does not reject its normal ten-minute Google flow', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-google-clock-review-')));
  const state = new CliState(directory);
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = 1789230000000,
    origin = 'https://synthetic-google.example.test',
    flowId = 'B'.repeat(42) + 'A';
  const auth = new CliGoogleAuth({
    state,
    now: () => now,
    fetch: (async (url) => {
      assert.equal(String(url), origin + '/api/auth/google/start');
      return Response.json({
        flowId,
        secret: 'C'.repeat(42) + 'A',
        code: 'A1B2-C3D4',
        expiresAt: now + 2000 + 10 * 60 * 1000,
        launchPath: '/auth/google/start?flow=' + flowId,
      });
    }) as typeof fetch,
  });
  const result = await auth.begin({ origin });
  assert.equal(result.browserUrl, origin + '/auth/google/start?flow=' + flowId);
  assert.equal(result.expiresAt, now + 10 * 60 * 1000);
  assert.equal(state.get<any>(CLI_GOOGLE_FLOW_KEY).phase, 'awaiting');
  assert.equal(state.get<any>(CLI_GOOGLE_FLOW_KEY).expiresAt, result.expiresAt);
});

test('manual Google cancellation recovers when logout committed but its response was lost', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-google-cancel-review-')));
  const state = new CliState(directory);
  t.after(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const now = 1789230000000,
    origin = 'https://synthetic-google.example.test',
    flowId = 'B'.repeat(42) + 'A',
    secret = 'C'.repeat(42) + 'A',
    cookie = 'personal=' + 'D'.repeat(42) + 'A',
    email = 'synthetic@example.test',
    code = 'A1B2-C3D4';
  let finishCalls = 0,
    revoked = false,
    meAvailable = false,
    meOwner: string | null = 'synthetic-owner';
  const fetcher = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/auth/google/start')
      return Response.json({
        flowId,
        secret,
        code,
        expiresAt: now + 600000,
        launchPath: '/auth/google/start?flow=' + flowId,
      });
    if (path === '/api/auth/google/desktop/review')
      return Response.json({ status: 'ready', mode: 'login', email });
    if (path === '/api/auth/google/desktop/finish') {
      finishCalls++;
      return Response.json(
        { ok: true },
        {
          headers: {
            'Set-Cookie': cookie + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure',
          },
        },
      );
    }
    assert.equal(new Headers(init?.headers).get('Cookie'), cookie);
    if (path === '/api/me') {
      if (!meAvailable) throw new Error('synthetic lost verification response');
      assert.equal(revoked, true);
      return Response.json({
        owner: meOwner,
        needsSetup: false,
        localOnly: false,
        google: { enabled: true, ...(meOwner ? { linked: { email }, hasPassword: false } : {}) },
      });
    }
    if (path === '/api/logout') {
      if (revoked) return Response.json({ error: '登录凭据无效' }, { status: 401 });
      // The actual relay revokes the login before sending its success response.
      revoked = true;
      throw new Error('synthetic lost logout response');
    }
    throw new Error('Unexpected synthetic route');
  }) as typeof fetch;
  const auth = new CliGoogleAuth({ state, fetch: fetcher, now: () => now });
  await auth.begin({ origin });
  await auth.review();
  await assert.rejects(
    auth.finish({ expectedEmail: email, expectedCode: code }),
    (error: any) => error.message === CLI_GOOGLE_FAILED,
  );
  assert.equal(state.get<any>(CLI_GOOGLE_FLOW_KEY).phase, 'issued');
  try {
    await auth.cancel();
  } catch (error) {
    assert.equal((error as Error).message, CLI_GOOGLE_FAILED);
  }
  meAvailable = true;
  await assert.rejects(auth.cancel(), (error: any) => error.message === CLI_GOOGLE_FAILED);
  assert.equal(state.get<any>(CLI_GOOGLE_FLOW_KEY).phase, 'cancelling');
  assert.equal(state.get<any>(CLI_GOOGLE_FLOW_KEY).cookie, cookie);
  meOwner = null;
  const result = await auth.cancel();
  assert.equal(result.cancelled, true);
  assert.equal(state.get(CLI_GOOGLE_FLOW_KEY), undefined);
  assert.equal(state.get('auth'), undefined);
  assert.equal(finishCalls, 1);
});
