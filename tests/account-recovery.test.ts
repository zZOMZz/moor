import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Store } from '../src/relay/accounts';
import {
  ACCOUNT_RECOVERY_FAILED,
  ACCOUNT_RECOVERY_MAX_BYTES,
  ACCOUNT_RECOVERY_SUCCESS,
  acquireRelayAccountLock,
  recoverAccount,
} from '../src/relay/account-recovery';
import { AppError } from '../src/protocol';

const identity = {
  issuer: 'https://accounts.google.com' as const,
  subject: 'SyntheticGoogleSubject',
  email: 'google@synthetic.invalid',
  emailVerified: true as const,
};
const password = 'synthetic-recovered-password',
  email = 'recovered@synthetic.invalid';
const body = JSON.stringify({ email, password });
const boundaryEmail = 'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.invalid';
const children = new Map<
  string,
  Set<{ child: ReturnType<typeof spawn>; closed: Promise<unknown> }>
>();
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-account-recovery-'))),
    data = join(root, 'data'),
    file = join(data, 'accounts.sqlite');
  mkdirSync(data);
  const store = new Store(file),
    secret = store.setupGoogle(identity, 'synthetic-owner');
  const device = store.redeem(
    store.pair('synthetic-owner'),
    'Synthetic device',
    'synthetic-device',
  );
  const pair = store.pair('synthetic-owner');
  store.close();
  t.after(async () => {
    for (const { child, closed } of children.get(data) ?? []) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    children.delete(data);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, data, file, secret, device, pair };
}
async function run(
  dataDirectory: string,
  stdin: AsyncIterable<Uint8Array | string> = Readable.from([body]),
) {
  let stdout = '',
    stderr = '';
  const code = await recoverAccount({
    dataDirectory,
    stdin,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
  });
  return { code, stdout, stderr };
}
const failed = { code: 1, stdout: '', stderr: ACCOUNT_RECOVERY_FAILED + '\n' };
function state(file: string) {
  const store = new Store(file);
  try {
    return Object.fromEntries(
      ['account', 'external_identity', 'login', 'pair', 'device'].map((table) => [
        table,
        store.db.prepare('SELECT * FROM ' + table).all(),
      ]),
    );
  } finally {
    store.close();
  }
}
function unauthorized(error: unknown) {
  return error instanceof AppError && error.status === 401;
}

test('operator recovery accepts only bounded stdin, preserves Google and devices, and revokes old credentials atomically', async (t) => {
  const f = fixture(t),
    before = state(f.file);
  const padded = Buffer.from(body.padEnd(ACCOUNT_RECOVERY_MAX_BYTES, ' '));
  const result = await run(f.data, Readable.from([padded.subarray(0, 100), padded.subarray(100)]));
  assert.deepEqual(result, { code: 0, stdout: ACCOUNT_RECOVERY_SUCCESS + '\n', stderr: '' });
  assert.ok(!JSON.stringify(result).includes(password));
  assert.ok(!JSON.stringify(result).includes(email));
  const store = new Store(f.file);
  try {
    assert.equal(store.owner(await store.login(email, password)), 'synthetic-owner');
    assert.deepEqual(store.googleIdentity('synthetic-owner'), { email: identity.email });
    assert.equal(store.deviceToken(f.device.token).owner, 'synthetic-owner');
    assert.throws(() => store.owner(f.secret), unauthorized);
    assert.throws(() => store.redeem(f.pair, 'Unexpected device'), unauthorized);
    assert.deepEqual(store.db.prepare('SELECT * FROM device').all(), before.device);
    assert.deepEqual(
      store.db.prepare('SELECT * FROM external_identity').all(),
      before.external_identity,
    );
  } finally {
    store.close();
  }
  assert.equal(
    existsSync(join(f.data, 'setup-token')),
    false,
    'recovery never creates setup material',
  );
});

test('bad, oversized, malformed UTF-8 or interrupted stdin never changes the account or echoes supplied values', async (t) => {
  const f = fixture(t),
    before = state(f.file);
  for (const input of [
    '',
    '{',
    JSON.stringify({ email, password: 'short' }),
    JSON.stringify({ email, password, owner: 'another' }),
    JSON.stringify({ email, password: 'x'.repeat(1025) }),
    body.padEnd(4097, ' '),
    JSON.stringify({ email, password: '字'.repeat(1024), padding: '字'.repeat(500) }),
  ])
    assert.deepEqual(await run(f.data, Readable.from([input])), failed);
  assert.deepEqual(
    await run(
      f.data,
      Readable.from([
        Buffer.concat([
          Buffer.from('{"email":"'),
          Buffer.from([0xff]),
          Buffer.from('@synthetic.invalid","password":"' + password + '"}'),
        ]),
      ]),
    ),
    failed,
  );
  async function* broken() {
    yield body;
    throw new Error(password + email);
  }
  assert.deepEqual(await run(f.data, broken()), failed);
  assert.deepEqual(state(f.file), before);
});

test('recovery and the store reject login-incompatible email addresses without changing credentials or revocations', async (t) => {
  const f = fixture(t),
    before = state(f.file);
  assert.equal(boundaryEmail.length, 200);
  for (const invalidEmail of [
    boundaryEmail + 'x',
    'a@b',
    'not..valid@synthetic.invalid',
    'a@localhost',
  ]) {
    assert.deepEqual(
      await run(f.data, Readable.from([JSON.stringify({ email: invalidEmail, password })])),
      failed,
    );
    assert.deepEqual(state(f.file), before);
    const store = new Store(f.file);
    try {
      await assert.rejects(
        store.resetPassword(invalidEmail, password),
        (error: unknown) => error instanceof AppError && error.status === 400,
      );
    } finally {
      store.close();
    }
    assert.deepEqual(state(f.file), before);
  }
});

test(
  'a 200-character recovery email can log in through the actual relay HTTP API',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    assert.equal(boundaryEmail.length, 200);
    const recovered = launch(
      t,
      f.data,
      ['--recover-account'],
      {},
      JSON.stringify({ email: boundaryEmail, password }),
    );
    void recovered.ready.catch(() => {});
    assert.equal((await recovered.closed)[0], 0, recovered.output().stderr);
    assert.equal(recovered.output().stdout, ACCOUNT_RECOVERY_SUCCESS + '\n');
    const port = await freePort(),
      origin = 'http://127.0.0.1:' + port,
      host = launch(t, f.data, [], { PORT: String(port), MOOR_ORIGIN: origin });
    await host.ready;
    const loggedIn = await fetch(origin + '/api/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: boundaryEmail, password }),
    });
    assert.equal(loggedIn.status, 200);
    assert.deepEqual(await loggedIn.json(), { ok: true });
    const cookie = loggedIn.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const me = await fetch(origin + '/api/me', { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    const account = (await me.json()) as {
      owner: string;
      google: { linked: { email: string }; hasPassword: boolean };
    };
    assert.equal(account.owner, 'synthetic-owner');
    assert.deepEqual(account.google.linked, { email: identity.email });
    assert.equal(account.google.hasPassword, true);
    host.child.kill('SIGTERM');
    assert.equal((await host.closed)[0], 0);
  },
);

test('recovery refuses absent, linked, replaced or non-regular databases and unsafe SQLite lock/sidecars', async (t) => {
  const f = fixture(t),
    before = state(f.file),
    missing = join(f.root, 'missing');
  assert.deepEqual(await run(missing), failed);
  assert.equal(existsSync(missing), false);
  const empty = join(f.root, 'empty');
  mkdirSync(empty);
  assert.deepEqual(await run(empty), failed);
  assert.equal(existsSync(join(empty, 'accounts.sqlite')), false);
  const linked = join(f.root, 'linked');
  mkdirSync(linked);
  symlinkSync(f.file, join(linked, 'accounts.sqlite'));
  assert.deepEqual(await run(linked), failed);
  const linkedDirectory = join(f.root, 'linked-directory');
  symlinkSync(f.data, linkedDirectory);
  assert.deepEqual(await run(linkedDirectory), failed);
  rmSync(join(linked, 'accounts.sqlite'));
  mkdirSync(join(linked, 'accounts.sqlite'));
  assert.deepEqual(await run(linked), failed);
  for (const suffix of ['-wal', '-shm', '.relay-lock']) {
    symlinkSync(f.file, f.file + suffix);
    assert.deepEqual(await run(f.data), failed);
    rmSync(f.file + suffix);
  }
  assert.deepEqual(state(f.file), before);
  const otherFile = join(f.root, 'replacement.sqlite'),
    replacement = new Store(otherFile);
  replacement.setupGoogle({ ...identity, subject: 'ReplacementSubject' }, 'replacement-owner');
  replacement.close();
  const replacementBefore = state(otherFile);
  async function* changed() {
    renameSync(f.file, f.file + '.original');
    renameSync(otherFile, f.file);
    yield body;
  }
  assert.deepEqual(await run(f.data, changed()), failed);
  assert.deepEqual(state(f.file), replacementBefore);
  assert.deepEqual(state(f.file + '.original'), before);
});

test('a held relay lock or failed revocation refuses recovery without partial updates and releases recovery ownership', async (t) => {
  const f = fixture(t),
    before = state(f.file),
    release = acquireRelayAccountLock(f.data);
  assert.deepEqual(await run(f.data), failed);
  release();
  assert.deepEqual(state(f.file), before);
  const store = new Store(f.file);
  store.db.exec(
    "CREATE TRIGGER fail_pair BEFORE DELETE ON pair BEGIN SELECT RAISE(ABORT,'synthetic private failure'); END",
  );
  store.close();
  assert.deepEqual(await run(f.data), failed);
  assert.deepEqual(state(f.file), before);
  const unlocked = acquireRelayAccountLock(f.data);
  unlocked();
});

function launch(
  t: TestContext,
  data: string,
  args: string[],
  env: Record<string, string> = {},
  input = '',
) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('src/relay/main.ts'), ...args],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MOOR_DATA_DIR: data,
        MOOR_SETUP_TOKEN: 'synthetic-startup-token',
        MOOR_GOOGLE_CLIENT_ID: '',
        MOOR_GOOGLE_CLIENT_SECRET: '',
        MOOR_ORIGIN: 'http://127.0.0.1:0',
        MOOR_PUBLIC_DIR: resolve('src/web/public'),
        HOST: '127.0.0.1',
        PORT: '0',
        NODE_NO_WARNINGS: '1',
        ...env,
      },
    },
  );
  const closed = once(child, 'close');
  if (!children.has(data)) children.set(data, new Set());
  children.get(data)!.add({ child, closed });
  let stdout = '',
    stderr = '',
    ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  child.stdout.on('data', (bytes) => {
    stdout += bytes;
    if (stdout.includes('Moor:')) ready();
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes;
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  return {
    child,
    closed,
    output: () => ({ stdout, stderr }),
    ready: Promise.race([
      started,
      closed.then(() => {
        throw Error('Synthetic relay closed before readiness: ' + stderr);
      }),
    ]),
  };
}

test(
  'actual server recovery mode bypasses HTTP startup and Google configuration, rejects argument/env passwords and respects live relay ownership',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const invalid = launch(t, f.data, ['--recover-account', '--password', password], {}, body);
    void invalid.ready.catch(() => {});
    assert.equal((await invalid.closed)[0], 1);
    assert.equal(invalid.output().stdout, '');
    assert.equal(invalid.output().stderr.includes(password), false);
    const environmentPassword = launch(t, f.data, ['--recover-account'], {
      MOOR_PASSWORD: password,
      PASSWORD: password,
    });
    void environmentPassword.ready.catch(() => {});
    assert.equal((await environmentPassword.closed)[0], 1);
    assert.match(environmentPassword.output().stderr, /账号恢复未完成/);
    const host = launch(t, f.data, []);
    await host.ready;
    const blocked = launch(t, f.data, ['--recover-account'], {}, body);
    void blocked.ready.catch(() => {});
    assert.equal((await blocked.closed)[0], 1);
    assert.match(blocked.output().stderr, /账号恢复未完成/);
    host.child.kill('SIGTERM');
    assert.equal((await host.closed)[0], 0);
    const recovered = launch(
      t,
      f.data,
      ['--recover-account'],
      { MOOR_GOOGLE_CLIENT_ID: 'partial-config', MOOR_ORIGIN: 'invalid-config' },
      body,
    );
    void recovered.ready.catch(() => {});
    assert.equal((await recovered.closed)[0], 0, recovered.output().stderr);
    assert.equal(recovered.output().stdout, ACCOUNT_RECOVERY_SUCCESS + '\n');
    assert.equal(recovered.output().stderr, '');
    const store = new Store(f.file);
    try {
      assert.equal(store.owner(await store.login(email, password)), 'synthetic-owner');
    } finally {
      store.close();
    }
  },
);

async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}
test(
  'actual relay startup disables Google when blank, wires enabled loopback configuration, and rejects partial credentials or unsafe origins without echo',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const port = await freePort(),
      origin = 'http://127.0.0.1:' + port;
    const enabled = launch(t, f.data, [], {
      PORT: String(port),
      MOOR_ORIGIN: origin,
      MOOR_GOOGLE_CLIENT_ID: 'synthetic-client-id',
      MOOR_GOOGLE_CLIENT_SECRET: 'synthetic-google-client-secret',
    });
    await enabled.ready;
    const me = await fetch(origin + '/api/me');
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as any).google.enabled, true);
    assert.equal(
      JSON.stringify(enabled.output()).includes('synthetic-google-client-secret'),
      false,
    );
    enabled.child.kill('SIGTERM');
    assert.equal((await enabled.closed)[0], 0);
    const disabled = launch(t, f.data, [], { PORT: String(port), MOOR_ORIGIN: origin });
    await disabled.ready;
    assert.equal(((await (await fetch(origin + '/api/me')).json()) as any).google.enabled, false);
    disabled.child.kill('SIGTERM');
    assert.equal((await disabled.closed)[0], 0);
    const invalidSettings: Record<string, string>[] = [
      { MOOR_GOOGLE_CLIENT_ID: 'synthetic-client-id' },
      { MOOR_GOOGLE_CLIENT_SECRET: 'synthetic-google-client-secret' },
      {
        MOOR_GOOGLE_CLIENT_ID: 'synthetic-client-id',
        MOOR_GOOGLE_CLIENT_SECRET: 'synthetic secret with space',
      },
      { MOOR_ORIGIN: 'http://remote.synthetic.invalid' },
      { MOOR_ORIGIN: 'https://secret@synthetic.invalid' },
      { MOOR_ORIGIN: 'https://synthetic.invalid/private?token=synthetic-secret' },
      { MOOR_ORIGIN: 'http://localhost.synthetic.invalid' },
    ];
    for (const env of invalidSettings) {
      const rejected = launch(t, f.data, [], env);
      void rejected.ready.catch(() => {});
      assert.equal((await rejected.closed)[0], 1);
      assert.equal(rejected.output().stdout, '');
      for (const value of Object.values(env))
        assert.equal(rejected.output().stderr.includes(value), false);
    }
  },
);
