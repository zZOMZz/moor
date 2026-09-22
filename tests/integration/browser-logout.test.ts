import test from 'node:test';
import assert from 'node:assert/strict';
import { logoutBrowserAccount } from '../../apps/web/src/platform/browser-logout';

const origin = 'https://synthetic.invalid';
const identity = async () => ({ owner: 'account-a' });
const current = () => {};
test('browser logout rejects a stale reviewed account before dispatch', async () => {
  let requests = 0;
  await assert.rejects(
    logoutBrowserAccount({
      origin,
      owner: 'account-a',
      current,
      identity: async () => ({ owner: 'account-b' }),
      fetch: async () => {
        requests++;
        return Response.json({ ok: true });
      },
    }),
    /账号已改变/,
  );
  assert.equal(requests, 0);
});

test('browser logout sends only the owner-bound route and requires anonymous confirmation before clearing local hints', async () => {
  const requests: string[] = [];
  await logoutBrowserAccount({
    origin,
    owner: 'account-a',
    identity,
    current,
    fetch: async (url, options) => {
      requests.push(String(url));
      assert.equal(options?.credentials, 'same-origin');
      assert.equal(options?.redirect, 'error');
      return Response.json(String(url).endsWith('/api/me') ? { owner: null } : { ok: true });
    },
  });
  assert.deepEqual(requests, [
    origin + '/api/logout?expectedAccount=account-a',
    origin + '/api/me',
  ]);
});

test('a new login observed after a delayed logout reply cannot be reported as logged out', async () => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let owner: string | null = 'account-a',
    completed = false;
  const pending = logoutBrowserAccount({
    origin,
    owner: 'account-a',
    identity,
    current,
    fetch: async (url) => {
      if (String(url).endsWith('/api/me')) return Response.json({ owner });
      entered();
      await held;
      return Response.json({ ok: true });
    },
  }).then(() => {
    completed = true;
  });
  const rejected = assert.rejects(pending, /登录已改变/);
  await ready;
  owner = 'account-b';
  release();
  await rejected;
  assert.equal(completed, false);
  assert.equal(owner, 'account-b');
});
