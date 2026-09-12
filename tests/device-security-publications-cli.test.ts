import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { CliState } from '../src/cli/state';
import { CliClient } from '../src/cli/client';
import { parseCliArgs } from '../src/cli/args';
import { Store } from '../src/relay/accounts';
import { createApp } from '../src/relay/http';
import { PrivateEndpointFile } from '../src/security/private-endpoint-file';
import { DEVICE_SECURITY_FAILED, runDeviceSecurityCommand } from '../src/security/commands';
import type { DeviceManager, DevicePairingReceipt } from '../src/security/device-manager';
import type { PublicTrustEntry } from '../src/security/trust-publication';
import { CLI_GOOGLE_FLOW_KEY } from '../src/cli/google-auth';
import { VerifiedTrust } from '../src/security/e2ee-trust';

const owner = 'synthetic-google-owner';
const failed = { code: 1, stdout: '', stderr: DEVICE_SECURITY_FAILED + '\n' };
// Existing Flock WASM initialization emits this fixed upstream notice in the general CLI.
const cliStartupNotice =
  'using deprecated parameters for the initialization function; pass a single object instead\n';
const packagedEntry = process.env.MOOR_DEVICE_SECURITY_ENTRY;
const packagedNode = process.env.MOOR_DEVICE_SECURITY_NODE;
const cliEntry = process.env.MOOR_CLI_ENTRY;
for (const path of [packagedEntry, packagedNode, cliEntry]) if (path) assert.ok(isAbsolute(path));
type ProcessResult = { code: number | null; stdout: string; stderr: string };
function stored(path: string) {
  const file = PrivateEndpointFile.open(path);
  try {
    return file.load();
  } finally {
    file.close();
  }
}
function privateSave(path: string, value: unknown) {
  const file = PrivateEndpointFile.open(path);
  try {
    file.save(null, value);
  } finally {
    file.close();
  }
}
function result(process: ProcessResult, action: string): unknown {
  assert.equal(process.code, 0, process.stderr);
  assert.equal(process.stderr, '');
  const value = JSON.parse(process.stdout);
  assert.equal(value.securityVersion, 1);
  assert.equal(value.ok, true);
  assert.equal(value.action, action);
  return value.data;
}
function active(value: unknown) {
  const state = value as ReturnType<DeviceManager['status']>;
  assert.ok('device' in state);
  assert.ok(state.revision);
  return { ...state, revision: state.revision };
}
async function fixture(t: TestContext, options: { googleLogin?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-trust-cli-')));
  chmodSync(root, 0o700);
  const store = new Store(join(root, 'relay.sqlite'));
  const identity = {
    issuer: 'https://accounts.google.com',
    subject: 'synthetic-google-subject',
    email: 'synthetic@google.invalid',
    emailVerified: true,
  } as const;
  const secret = store.setupGoogle(identity, owner);
  const app = createApp(store, {
    origin: 'http://127.0.0.1:0',
    setupToken: 'synthetic-setup',
    googleProvider: {
      authorizationUrl: (input) =>
        'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(input),
      exchangeAndVerify: async () => identity,
    },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  app.setOrigin(origin);
  const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const stateDirectory = join(root, 'cli');
  const connection = { origin, owner, cookie: 'personal=' + secret };
  const state = new CliState(stateDirectory);
  if (!options.googleLogin) state.set('auth', { kind: 'remote', connection });
  state.close();
  const requests: { path: string; body: string }[] = [];
  const fault: { publish?: 'lost' | 'changed' } = {};
  app.server.prependListener('request', (request, response) => {
    const record = { path: request.url!, body: '' };
    requests.push(record);
    if (request.url?.startsWith('/api/security/trust/'))
      request.on('data', (chunk) => (record.body += chunk));
    if (request.url === '/api/security/trust/publish' && fault.publish) {
      const mode = fault.publish;
      const end = response.end.bind(response);
      response.end = ((chunk?: unknown, ...args: unknown[]) => {
        if (response.statusCode === 200) {
          if (mode === 'lost') {
            response.destroy();
            return response;
          }
          const body = JSON.parse(String(chunk));
          body.stored[0].digest = 'A'.repeat(43);
          chunk = JSON.stringify(body);
        }
        return Reflect.apply(end, response, [chunk, ...args]);
      }) as typeof response.end;
    }
  });
  async function child(entry: string, args: string[], input = '', bundled = false) {
    const child = spawn(
      packagedNode ?? process.execPath,
      [...(bundled ? [] : ['--import', 'tsx']), entry, ...args],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
          ...(packagedNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
      },
    );
    const closed = once(child, 'close');
    children.push({ child, closed });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const [code, signal] = await closed;
    assert.equal(signal, null);
    assert.ok(!(stdout + stderr).includes(secret), 'session credential never reaches output');
    return { code, stdout, stderr } as ProcessResult;
  }
  const file = join(root, 'admin.json');
  const connectionFile = join(root, 'trust-connection.json');
  function cliData(process: ProcessResult) {
    assert.equal(process.code, 0, process.stderr);
    assert.equal(process.stderr, cliStartupNotice);
    const value = JSON.parse(process.stdout);
    assert.equal(value.ok, true);
    assert.equal(value.cliVersion, 1);
    return value.data;
  }
  return {
    root,
    file,
    peer: join(root, 'peer.json'),
    recoveryCodeFile: join(root, 'recovery-code.json'),
    connectionFile,
    stateDirectory,
    connection,
    requests,
    fault,
    run: (input: unknown, path = file) =>
      child(
        packagedEntry ?? resolve('src/security/main.ts'),
        ['--data-file', path],
        JSON.stringify(input),
        !!packagedEntry,
      ),
    cli: (args: string[], input = '') =>
      child(
        cliEntry ?? resolve('src/cli/main.ts'),
        [...args, '--state-dir', stateDirectory, '--json'],
        input,
        !!cliEntry,
      ),
    async initialize() {
      return active(
        result(
          await this.run({
            action: 'initialize',
            identity: {
              accountId: owner,
              serverOrigin: origin,
              deviceId: 'admin',
              roles: ['host', 'client'],
            },
            recoveryCodeFile: this.recoveryCodeFile,
          }),
          'initialize',
        ),
      );
    },
    async export() {
      const exported = await this.cli(['auth', 'export-trust', '--output', connectionFile]);
      cliData(exported);
      assert.deepEqual(JSON.parse(exported.stdout), {
        cliVersion: 1,
        ok: true,
        command: 'auth export-trust',
        data: { outputFile: connectionFile },
      });
      return exported;
    },
    async loginGoogle() {
      // Every command is a distinct actual CLI process. The fake identity provider stays local.
      cliData(await this.cli(['auth', 'google-start', '--server', origin]));
      assert.equal(cliData(await this.cli(['auth', 'google-cancel'])).cancelled, true);
      const startedOutput = await this.cli(['auth', 'google-start', '--server', origin]);
      const started = cliData(startedOutput) as {
        browserUrl: string;
        code: string;
        origin: string;
      };
      assert.equal(started.origin, origin);
      const privateState = new CliState(stateDirectory);
      const flow = privateState.get<{ proof: { secret: string } }>(CLI_GOOGLE_FLOW_KEY)!;
      assert.equal(privateState.get('auth'), undefined);
      privateState.close();
      assert.ok(!startedOutput.stdout.includes(flow.proof.secret));
      assert.equal(cliData(await this.cli(['auth', 'google-review'])).status, 'pending');
      const launch = await fetch(started.browserUrl, { redirect: 'manual' });
      assert.equal(launch.status, 303);
      const browserCookie = launch.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const authorization = new URL(launch.headers.get('location')!);
      const callback = await fetch(
        origin +
          '/api/auth/google/callback?' +
          new URLSearchParams({
            state: authorization.searchParams.get('state')!,
            code: 'synthetic-authorization',
            iss: identity.issuer,
          }),
        { redirect: 'manual', headers: { Cookie: browserCookie } },
      );
      assert.equal(callback.status, 303);
      const headers = { Cookie: browserCookie, Origin: origin, 'Content-Type': 'application/json' };
      const browserReview = await (
        await fetch(origin + '/api/auth/google/review', { headers })
      ).json();
      const browserConfirm = await fetch(origin + '/api/auth/google/confirm', {
        method: 'POST',
        headers,
        body: JSON.stringify({ flowId: browserReview.flowId }),
      });
      assert.equal(browserConfirm.status, 200);
      assert.equal(browserConfirm.headers.get('set-cookie'), null);
      const reviewed = cliData(await this.cli(['auth', 'google-review']));
      assert.equal(reviewed.status, 'ready');
      assert.equal(reviewed.email, identity.email);
      assert.equal(reviewed.code, started.code);
      const finishCount = () =>
        requests.filter((request) => request.path.endsWith('/desktop/finish')).length;
      assert.equal(finishCount(), 0);
      assert.notEqual(
        (
          await this.cli(
            ['auth', 'google-confirm', '--stdin'],
            JSON.stringify({
              expectedEmail: 'other@google.invalid',
              expectedCode: started.code,
            }),
          )
        ).code,
        0,
      );
      assert.equal(finishCount(), 0);
      const confirmed = cliData(
        await this.cli(
          ['auth', 'google-confirm', '--stdin'],
          JSON.stringify({
            expectedEmail: identity.email,
            expectedCode: started.code,
          }),
        ),
      );
      assert.equal(confirmed.owner, owner);
      assert.equal(confirmed.authenticated, true);
      assert.equal(finishCount(), 1);
      const reopened = new CliState(stateDirectory);
      const auth = reopened.get<{ connection: typeof connection }>('auth')!;
      assert.equal(reopened.get(CLI_GOOGLE_FLOW_KEY), undefined);
      reopened.close();
      assert.equal(store.owner(auth.connection.cookie.slice(9)), owner);
      connection.cookie = auth.connection.cookie;
      assert.equal(
        store.hasPassword(owner),
        false,
        'Google-only login never adds a local password',
      );
    },
  };
}

test('real CLI exports only the selected remote login to a new private connection file', async (t) => {
  const f = await fixture(t);
  await f.export();
  assert.deepEqual(stored(f.connectionFile), {
    revision: 1,
    value: { kind: 'moor-trust-connection', ...f.connection },
  });
  assert.equal(statSync(f.connectionFile).mode & 0o777, 0o600);
  const original = readFileSync(f.connectionFile);
  assert.equal((await f.cli(['auth', 'export-trust', '--output', f.connectionFile])).code, 1);
  assert.deepEqual(readFileSync(f.connectionFile), original);
  for (const args of [
    [
      'auth',
      'export-trust',
      '--output',
      join(f.root, 'wrong-origin.json'),
      '--server',
      'https://other.invalid',
    ],
    ['auth', 'export-trust', '--output', 'relative.json'],
    [
      'auth',
      'export-trust',
      '--output',
      join(f.root, 'injected.json'),
      '--connection',
      '/synthetic',
    ],
  ])
    assert.notEqual((await f.cli(args)).code, 0);
  const localState = new CliState(f.stateDirectory);
  localState.set('auth', { kind: 'local', file: '/synthetic/local-connection.json' });
  localState.close();
  const target = join(f.root, 'local.json');
  assert.equal((await f.cli(['auth', 'export-trust', '--output', target])).code, 1);
  assert.equal(existsSync(target), false);
  assert.deepEqual(f.requests, [], 'export copies an existing session without network access');
});

test(
  'real Relay publication preserves exact signed outbox across a lost or changed receipt until manual retry',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      initial = await f.initialize();
    await f.export();
    const before = stored(f.file);
    const pending = result(
      await f.run({ action: 'read-publications' }),
      'read-publications',
    ) as ReturnType<DeviceManager['publications']>;
    assert.equal(pending.entries.length, 1);
    assert.equal(f.requests.length, 0);
    const publish = {
      action: 'publish-trust',
      expectedRevision: initial.revision,
      connectionFile: f.connectionFile,
    };
    for (const mode of ['lost', 'changed'] as const) {
      f.fault.publish = mode;
      assert.deepEqual(await f.run(publish), failed);
      assert.deepEqual(stored(f.file), before);
      assert.deepEqual(
        result(await f.run({ action: 'read-publications' }), 'read-publications'),
        pending,
      );
      assert.equal(
        f.requests.filter((r) => r.path.endsWith('/publish')).length,
        mode === 'lost' ? 1 : 2,
      );
    }
    delete f.fault.publish;
    const published = result(await f.run(publish), 'publish-trust') as {
      status: { revision: number };
      stored: unknown[];
      pending: number;
      relayHead: { verified: boolean };
    };
    assert.equal(published.status.revision, initial.revision + 1);
    assert.deepEqual(
      published.stored,
      pending.entries.map((entry) => entry.checkpoint),
    );
    assert.equal(published.pending, 0);
    assert.equal(published.relayHead.verified, false);
    const bodies = f.requests.filter((r) => r.path.endsWith('/publish')).map((r) => r.body);
    assert.equal(bodies.length, 3);
    assert.equal(
      new Set(bodies).size,
      1,
      'all three manual attempts use the original exact signatures',
    );
    const count = f.requests.length;
    assert.deepEqual(
      await f.run(publish),
      failed,
      'stale local revision is rejected before sending',
    );
    const empty = result(
      await f.run({ ...publish, expectedRevision: published.status.revision }),
      'publish-trust',
    ) as { pending: number };
    assert.equal(empty.pending, 0);
    assert.equal(f.requests.length, count, 'an empty publication queue never contacts the server');
  },
);

test(
  'real Google-only CLI handoff exports a session, publishes paired trust and syncs only consecutive verified versions',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, { googleLogin: true });
    await f.loginGoogle();
    const trustRequestStart = f.requests.length;
    const initial = await f.initialize();
    await f.export();
    const begun = result(
      await f.run(
        { action: 'begin-pairing', pin: initial.pin, deviceId: 'peer', roles: ['client'] },
        f.peer,
      ),
      'begin-pairing',
    );
    const pending = active(begun);
    assert.ok(pending.pending);
    const receipt = result(
      await f.run({
        action: 'approve-pairing',
        expectedRevision: initial.revision,
        request: pending.pending.request,
        expectedFingerprint: (begun as { fingerprint: string }).fingerprint,
        expectedDeviceKeyId: null,
        recoveryCodeFile: f.recoveryCodeFile,
      }),
      'approve-pairing',
    ) as DevicePairingReceipt;
    const peer = active(
      result(
        await f.run(
          {
            action: 'accept-pairing',
            expectedRevision: pending.revision,
            approval: receipt.approval,
            rootPublicKey: receipt.trust.rootPublicKey,
            signedManifest: receipt.trust.signedManifest,
          },
          f.peer,
        ),
        'accept-pairing',
      ),
    );
    assert.equal(peer.trust?.checkpoint.epoch, 2);
    let admin = active(result(await f.run({ action: 'read' }), 'read'));
    for (const device of [peer.device, admin.device])
      admin = active(
        result(
          await f.run({
            action: 'revoke-device',
            expectedRevision: admin.revision,
            deviceId: device.deviceId,
            expectedKeyId: device.keyId,
            recoveryCodeFile: f.recoveryCodeFile,
          }),
          'revoke-device',
        ),
      );
    assert.equal(admin.trust?.checkpoint.epoch, 4);
    result(
      await f.run({
        action: 'publish-trust',
        expectedRevision: admin.revision,
        connectionFile: f.connectionFile,
      }),
      'publish-trust',
    );
    const sync = {
      action: 'sync-trust',
      expectedRevision: peer.revision,
      connectionFile: f.connectionFile,
      limit: 1,
    };
    // The network deadline also covers the manager's second signature verification before CAS.
    const beforeSync = stored(f.peer),
      deadline = new AbortController();
    let readDelivered = false,
      verificationsAfterRead = 0;
    const verify = VerifiedTrust.verify;
    const verification = t.mock.method(
      VerifiedTrust,
      'verify',
      async (input: Parameters<typeof verify>[0]) => {
        const trust = await verify(input);
        if (readDelivered && ++verificationsAfterRead === 2) deadline.abort();
        return trust;
      },
    );
    try {
      await assert.rejects(
        runDeviceSecurityCommand(sync, {
          dataFile: f.peer,
          trust: {
            deadline: () => deadline.signal,
            fetch: async (url, init) => {
              const response = await fetch(url, init);
              if (String(url).endsWith('/read')) readDelivered = true;
              return response;
            },
          },
        }),
        { message: DEVICE_SECURITY_FAILED },
      );
      assert.equal(verificationsAfterRead, 2);
      assert.deepEqual(stored(f.peer), beforeSync);
    } finally {
      verification.mock.restore();
    }
    const first = result(await f.run(sync, f.peer), 'sync-trust') as {
      status: ReturnType<DeviceManager['status']>;
      installed: number;
      complete: boolean;
      relayHead: { checkpoint: { epoch: number }; verified: boolean };
    };
    assert.equal(first.installed, 1);
    assert.equal(first.complete, false);
    assert.deepEqual(first.relayHead, { checkpoint: admin.trust!.checkpoint, verified: false });
    assert.equal(active(first.status).trust?.checkpoint.epoch, 3);
    assert.equal(active(first.status).phase, 'revoked');
    const count = f.requests.length;
    assert.deepEqual(await f.run(sync, f.peer), failed);
    assert.equal(f.requests.length, count);
    const second = result(
      await f.run({ ...sync, expectedRevision: first.status.revision }, f.peer),
      'sync-trust',
    ) as typeof first;
    assert.equal(second.complete, true);
    assert.equal(second.relayHead.verified, true);
    assert.deepEqual(active(second.status).trust, admin.trust);
    const publications = result(
      await f.run({ action: 'read-publications' }, f.peer),
      'read-publications',
    ) as { entries: PublicTrustEntry[] };
    assert.deepEqual(
      publications.entries,
      [],
      'received versions are not re-enqueued as local publications',
    );
    const terminal = result(
      await f.run({ ...sync, expectedRevision: second.status.revision }, f.peer),
      'sync-trust',
    ) as typeof first;
    assert.equal(terminal.installed, 0);
    assert.deepEqual(terminal.status, second.status);
    assert.ok(
      f.requests
        .slice(trustRequestStart)
        .every((r) =>
          ['/api/me', '/api/security/trust/publish', '/api/security/trust/read'].includes(r.path),
        ),
    );
  },
);

test('connection scope, a held private connection lock and invalid network-command input cannot mutate or send', async (t) => {
  const f = await fixture(t),
    initial = await f.initialize();
  await f.export();
  const before = stored(f.file);
  const publish = {
    action: 'publish-trust',
    expectedRevision: initial.revision,
    connectionFile: f.connectionFile,
  };
  const held = PrivateEndpointFile.open(f.connectionFile);
  try {
    assert.deepEqual(await f.run(publish), failed);
  } finally {
    held.close();
  }
  const wrong = join(f.root, 'wrong-account.json');
  privateSave(wrong, { kind: 'moor-trust-connection', ...f.connection, owner: 'other-owner' });
  for (const input of [
    { ...publish, connectionFile: wrong },
    { ...publish, connectionFile: f.file },
    { ...publish, cookie: f.connection.cookie },
    { ...publish, action: 'sync-trust', limit: 17 },
    { ...publish, expectedRevision: 999 },
  ])
    assert.deepEqual(await f.run(input), failed);
  assert.deepEqual(stored(f.file), before);
  assert.deepEqual(f.requests, []);
});

test('a replaced connection during a valid real receipt leaves local signed publications untouched', async (t) => {
  const f = await fixture(t),
    initial = await f.initialize();
  await f.export();
  const before = stored(f.file);
  await assert.rejects(
    runDeviceSecurityCommand(
      {
        action: 'publish-trust',
        expectedRevision: initial.revision,
        connectionFile: f.connectionFile,
      },
      {
        dataFile: f.file,
        trust: {
          fetch: async (url, init) => {
            const response = await fetch(url, init);
            if (String(url).endsWith('/publish')) chmodSync(f.connectionFile, 0o640);
            return response;
          },
        },
      },
    ),
    { message: DEVICE_SECURITY_FAILED },
  );
  chmodSync(f.connectionFile, 0o600);
  assert.deepEqual(stored(f.file), before);
  assert.deepEqual(
    f.requests.map((r) => r.path),
    ['/api/me', '/api/security/trust/publish'],
  );
});

test('Google CLI command boundaries permit only a manual start, review, strict stdin confirmation and cancellation', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['auth', 'google-start'],
    ['auth', 'google-start', '--server', f.connection.origin, '--stdin'],
    ['auth', 'google-review', '--server', f.connection.origin],
    ['auth', 'google-confirm'],
    ['auth', 'google-confirm', '--file', '/synthetic'],
    ['auth', 'google-cancel', '--connection', '/synthetic'],
  ])
    assert.throws(() => parseCliArgs(args));
  for (const command of ['google-start', 'google-review', 'google-confirm', 'google-cancel']) {
    const args = [
      'auth',
      command,
      ...(command === 'google-start'
        ? ['--server', f.connection.origin]
        : command === 'google-confirm'
          ? ['--stdin']
          : []),
    ];
    assert.equal(parseCliArgs(args).command, command);
  }
  for (const input of [
    {
      expectedEmail: 'synthetic@google.invalid',
      expectedCode: 'ABCD-1234',
      secret: 'PRIVATE_UNSUPPORTED',
    },
    { expectedEmail: 'synthetic@google.invalid', expectedCode: 'invalid' },
    { email: 'synthetic@google.invalid', code: 'ABCD-1234' },
  ]) {
    const denied = await f.cli(['auth', 'google-confirm', '--stdin'], JSON.stringify(input));
    assert.notEqual(denied.code, 0);
    assert.equal(denied.stdout, '');
    assert.doesNotMatch(denied.stderr, /PRIVATE_UNSUPPORTED|synthetic@google/);
  }
  assert.deepEqual(f.requests, []);
});

test('late password login and logout responses cannot overwrite or clear a newer auth setting, including ABA', async (t) => {
  const f = await fixture(t);
  const state = new CliState(f.stateDirectory);
  t.after(() => state.close());
  const original = { kind: 'remote', connection: f.connection };
  const newer = {
    kind: 'remote',
    connection: { ...f.connection, owner: 'new-owner', cookie: 'personal=' + 'N'.repeat(43) },
  };
  for (const command of ['login', 'logout'])
    for (const aba of [false, true]) {
      state.set('auth', original);
      let calls = 0;
      const client = new CliClient({
        state,
        stdin: (async function* () {
          yield JSON.stringify({
            email: 'synthetic@google.invalid',
            password: 'synthetic-password',
          });
        })(),
        fetch: async () => {
          calls++;
          state.set('auth', newer);
          if (aba) state.set('auth', original);
          return Response.json(
            { ok: true },
            { headers: { 'Set-Cookie': 'personal=' + 'L'.repeat(43) } },
          );
        },
      });
      await assert.rejects(
        client.run(
          parseCliArgs([
            'auth',
            command,
            ...(command === 'login' ? ['--server', f.connection.origin, '--stdin'] : []),
          ]),
        ),
      );
      assert.deepEqual(state.get('auth'), aba ? original : newer);
      assert.equal(calls, 1);
    }
});

test('export refuses an auth ABA while opening its private destination and leaves the destination uncreated', async (t) => {
  const f = await fixture(t),
    state = new CliState(f.stateDirectory);
  t.after(() => state.close());
  const original = state.get('auth');
  const open = PrivateEndpointFile.open;
  const opening = t.mock.method(PrivateEndpointFile, 'open', (...args: Parameters<typeof open>) => {
    const file = open(...args);
    state.set('auth', undefined);
    state.set('auth', original);
    return file;
  });
  const client = new CliClient({ state, stdin: (async function* () {})() });
  try {
    await assert.rejects(
      client.run(parseCliArgs(['auth', 'export-trust', '--output', f.connectionFile])),
    );
    assert.equal(existsSync(f.connectionFile), false);
    assert.deepEqual(state.get('auth'), original);
    assert.equal(f.requests.length, 0);
  } finally {
    opening.mock.restore();
  }
});

test('Google confirmation remains bound to the state revision from before stdin was read', async (t) => {
  const f = await fixture(t),
    state = new CliState(f.stateDirectory);
  t.after(() => state.close());
  const original = state.get('auth');
  let calls = 0;
  const client = new CliClient({
    state,
    stdin: (async function* () {
      state.set('auth', undefined);
      state.set('auth', original);
      yield JSON.stringify({
        expectedEmail: 'synthetic@google.invalid',
        expectedCode: 'ABCD-1234',
      });
    })(),
    fetch: async () => {
      calls++;
      throw new Error('must not contact the relay');
    },
  });
  await assert.rejects(client.run(parseCliArgs(['auth', 'google-confirm', '--stdin'])), {
    code: 'authentication-conflict',
  });
  assert.equal(calls, 0);
  assert.deepEqual(state.get('auth'), original);
});
