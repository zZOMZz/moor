import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DeviceManager } from '../src/security/device-manager';
import { DesktopSecureClient } from '../src/security/desktop-client';
import {
  desktopSecureRequestSchema,
  desktopSecureStatusSchema,
  type DesktopSecureResult,
  type DesktopSecureStatus,
} from '../src/security/desktop-client-protocol';
import { E2EE_PAIRING_LIMITS, fingerprintRequest } from '../src/security/e2ee-pairing';
import { generateRecoveryKey } from '../src/security/e2ee-recovery';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
function status(result: DesktopSecureResult): DesktopSecureStatus {
  assert(result.ok, JSON.stringify(result));
  return desktopSecureStatusSchema.parse(result.value);
}
function pending(result: DesktopSecureResult) {
  const value = status(result).device;
  assert('pending' in value && value.pending);
  return { ...value, pending: value.pending };
}
function failed(result: DesktopSecureResult) {
  assert(!result.ok);
  assert.equal(result.error.rejected, false);
}
async function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'moor-desktop-device-')));
  const endpointPath = join(directory, 'client', 'endpoint.json');
  mkdirSync(join(directory, 'client'), { mode: 0o700 });
  mkdirSync(join(directory, 'host'), { mode: 0o700 });
  let now = 1000000;
  const open = DeviceManager.open.bind(DeviceManager);
  t.mock.method(DeviceManager, 'open', (path: string) => open(path, { now: () => now }));
  const host = await DeviceManager.open(join(directory, 'host', 'endpoint.json'));
  const recoveryKey = generateRecoveryKey();
  await host.initialize(
    {
      accountId: 'synthetic-account',
      serverOrigin: 'https://synthetic.example.test',
      deviceId: 'host',
      roles: ['host'],
    },
    recoveryKey,
  );
  const hostState = host.status();
  assert('device' in hostState);
  const pin = hostState.pin;
  let current = true;
  let owner = pin.accountId;
  let origin = pin.serverOrigin;
  let authenticates = 0;
  let gate: ReturnType<typeof deferred> | undefined;
  let entered: ReturnType<typeof deferred> | undefined;
  let sockets = 0;
  const makeService = () =>
    new DesktopSecureClient({
      endpointPath,
      authenticate: async () => {
        authenticates++;
        const account = {
          origin,
          owner,
          cookie: 'personal=' + Buffer.alloc(32, 47).toString('base64url'),
          current: () => {
            if (!current) throw new Error('SYNTHETIC_PRIVATE_ACCOUNT_FAILURE');
          },
        };
        entered?.resolve(undefined);
        await gate?.promise;
        return account;
      },
      socket: () => {
        sockets++;
        throw new Error('unexpected connection');
      },
      deadline: () => new AbortController().signal,
    });
  const services: DesktopSecureClient[] = [];
  const service = makeService();
  services.push(service);
  t.after(() => {
    for (const item of services) item.close();
    host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const approve = async (request: ReturnType<typeof pending>['pending']['request']) => {
    const state = host.status();
    assert('device' in state);
    return host.approvePairing({
      expectedRevision: state.revision,
      request,
      expectedFingerprint: await fingerprintRequest(request),
      expectedDeviceKeyId:
        host
          .current()!
          .manifest.devices.find((device) => device.deviceId === request.device.deviceId)?.keyId ??
        null,
      recoveryKey,
    });
  };
  return {
    service,
    host,
    pin,
    endpointPath,
    approve,
    pair: (expectedRevision: number | null = null) =>
      service.request({ action: 'device-pair', expectedRevision, pin }),
    accept: (revision: number, receipt: Awaited<ReturnType<typeof approve>>) =>
      service.request({
        action: 'device-accept',
        expectedRevision: revision,
        approval: receipt.approval,
        rootPublicKey: receipt.trust.rootPublicKey,
        signedManifest: receipt.trust.signedManifest,
      }),
    counts: () => ({ authenticates, sockets }),
    account: (value: { owner?: string; origin?: string; current?: boolean }) => {
      owner = value.owner ?? owner;
      origin = value.origin ?? origin;
      current = value.current ?? current;
    },
    advance: (ms: number) => {
      now += ms;
    },
    gate: () => {
      gate = deferred();
      entered = deferred();
      return {
        entered: entered.promise,
        release: () => {
          gate!.resolve(undefined);
          gate = undefined;
        },
      };
    },
    reopen: () => {
      service.close();
      const next = makeService();
      services.push(next);
      return next;
    },
  };
}

test('device requests forbid caller identity, roles, private JWK and unbounded approvals', async (t) => {
  const f = await fixture(t);
  const hostState = f.host.status();
  assert('device' in hostState && hostState.trust);
  for (const input of [
    { action: 'device-pair', expectedRevision: null, pin: f.pin, deviceId: 'caller-choice' },
    { action: 'device-pair', expectedRevision: null, pin: f.pin, roles: ['host'] },
    { action: 'device-pair', expectedRevision: 0, pin: f.pin },
    { action: 'device-renew', expectedRevision: null },
    { action: 'device-cancel', expectedRevision: -1 },
    {
      action: 'device-accept',
      expectedRevision: 1,
      approval: 'a',
      rootPublicKey: {
        ...hostState.trust.rootPublicKey,
        d: 'PRIVATE',
      },
      signedManifest: 'a',
    },
    {
      action: 'device-accept',
      expectedRevision: 1,
      approval: 'a'.repeat(E2EE_PAIRING_LIMITS.approvalCharacters + 1),
      rootPublicKey: {},
      signedManifest: 'a',
    },
  ]) {
    assert.equal(desktopSecureRequestSchema.safeParse(input).success, false);
    const result = await f.service.request(input);
    assert(!result.ok && result.error.code === 'invalid-request');
  }
  assert.deepEqual(f.counts(), { authenticates: 0, sockets: 0 });
  assert(!existsSync(f.endpointPath));
});

test('desktop pairing completes a real synthetic approval with public status and no automatic connection', async (t) => {
  const f = await fixture(t);
  const request = pending(await f.pair());
  assert.match(request.deviceId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(request.roles, ['client']);
  assert.equal(request.trust, null);
  assert.deepEqual(request.devices, []);
  assert.equal(request.pending.fingerprint, await fingerprintRequest(request.pending.request));
  assert.equal(request.pending.expired, false);
  const receipt = await f.approve(request.pending.request);
  const accepted = status(await f.accept(request.revision, receipt));
  assert.equal(accepted.device.phase, 'active');
  assert('pending' in accepted.device);
  assert.equal(accepted.device.pending, null);
  assert.equal(accepted.device.trust?.signedManifest, receipt.trust.signedManifest);
  assert.deepEqual(
    accepted.device.devices.map((device) => device.deviceId).sort(),
    ['host', request.deviceId].sort(),
  );
  assert.equal(accepted.connection, null);
  assert.equal(accepted.connecting, false);
  assert.deepEqual(f.counts(), { authenticates: 2, sockets: 0 });
  for (const secret of [
    'privateKey',
    'recoveryCapsule',
    'recoveryKey',
    'personal=',
    f.endpointPath,
  ])
    assert(!JSON.stringify(accepted).includes(secret));
  await assert.rejects(DeviceManager.open(f.endpointPath));
  assert.deepEqual(status(await f.reopen().request({ action: 'status' })), accepted);
});

test('cancel keeps its revision across restart, deletes pending keys, and never revives an old approval', async (t) => {
  const f = await fixture(t);
  const first = pending(await f.pair());
  const oldApproval = await f.approve(first.pending.request);
  const cancelled = status(
    await f.service.request({ action: 'device-cancel', expectedRevision: first.revision }),
  );
  assert.deepEqual(cancelled.device, {
    phase: 'cancelled',
    revision: first.revision + 1,
    pin: f.pin,
  });
  const bytes = readFileSync(f.endpointPath, 'utf8');
  for (const old of ['privateKey', 'request', first.deviceId, first.pending.request.pairingId])
    assert(!bytes.includes(old));
  const reopened = f.reopen();
  assert.deepEqual(status(await reopened.request({ action: 'status' })), cancelled);
  failed(await reopened.request({ action: 'device-pair', expectedRevision: null, pin: f.pin }));
  failed(
    await reopened.request({ action: 'device-pair', expectedRevision: first.revision, pin: f.pin }),
  );
  const second = pending(
    await reopened.request({
      action: 'device-pair',
      expectedRevision: cancelled.device.revision,
      pin: f.pin,
    }),
  );
  assert.equal(second.revision, first.revision + 2);
  assert.notEqual(second.deviceId, first.deviceId);
  const accept = (receipt: typeof oldApproval) =>
    reopened.request({
      action: 'device-accept',
      expectedRevision: second.revision,
      approval: receipt.approval,
      rootPublicKey: receipt.trust.rootPublicKey,
      signedManifest: receipt.trust.signedManifest,
    });
  failed(await accept(oldApproval));
  assert.equal(
    status(await reopened.request({ action: 'status' })).device.revision,
    second.revision,
  );
  const accepted = status(await accept(await f.approve(second.pending.request)));
  assert.equal(accepted.device.phase, 'active');
  failed(
    await reopened.request({ action: 'device-cancel', expectedRevision: accepted.device.revision }),
  );
  assert.deepEqual(status(await reopened.request({ action: 'status' })), accepted);
});

test('expired pairing renews its public challenge explicitly without rotating the device key', async (t) => {
  const f = await fixture(t);
  const before = pending(await f.pair());
  const oldApproval = await f.approve(before.pending.request);
  f.advance(E2EE_PAIRING_LIMITS.lifetimeMs);
  assert.equal(pending(await f.service.request({ action: 'status' })).pending.expired, true);
  failed(await f.accept(before.revision, oldApproval));
  const renewed = pending(
    await f.service.request({ action: 'device-renew', expectedRevision: before.revision }),
  );
  assert.equal(renewed.revision, before.revision + 1);
  assert.equal(renewed.pending.expired, false);
  assert.deepEqual(renewed.pending.request.device, before.pending.request.device);
  assert.notEqual(renewed.pending.request.pairingId, before.pending.request.pairingId);
  failed(await f.accept(renewed.revision, oldApproval));
  assert.equal(
    status(await f.accept(renewed.revision, await f.approve(renewed.pending.request))).device.phase,
    'active',
  );
});

test('authenticated account and origin must match the out-of-band root pin before pairing', async (t) => {
  const f = await fixture(t);
  for (const identity of [
    { owner: 'other-account' },
    { owner: f.pin.accountId, origin: 'https://other.example.test' },
  ]) {
    f.account(identity);
    failed(await f.pair());
    assert(!existsSync(f.endpointPath));
  }
  f.account({ origin: f.pin.serverOrigin });
  const requested = pending(await f.pair());
  assert.equal(requested.trust, null);
  failed(await f.service.request({ action: 'connect' }));
  assert.equal(status(await f.service.request({ action: 'status' })).device.phase, 'pending');
  assert.equal(f.counts().sockets, 0);
});

test('device requests snapshot before authentication and exclude concurrent changes and connections', async (t) => {
  const f = await fixture(t);
  const gate = f.gate();
  const input = { action: 'device-pair', expectedRevision: null, pin: { ...f.pin } };
  const operation = f.service.request(input);
  await gate.entered;
  input.pin.accountId = 'mutated-after-send';
  failed(await f.service.request({ action: 'connect' }));
  failed(await f.pair());
  gate.release();
  assert.deepEqual(pending(await operation).pin, f.pin);
  assert.equal(f.counts().authenticates, 1);
});

test('closing or changing identity during authentication leaves no pairing record', async (t) => {
  const f = await fixture(t);
  const gate = f.gate();
  const operation = f.pair();
  await gate.entered;
  f.service.invalidate();
  gate.release();
  failed(await operation);
  assert(!existsSync(f.endpointPath));
  assert.deepEqual(status(await f.service.request({ action: 'status' })).device, {
    phase: 'empty',
    revision: null,
  });
});

for (const action of ['device-pair', 'device-renew', 'device-accept'] as const) {
  test(`${action} refuses persistence when the account changes during cryptographic work`, async (t) => {
    const f = await fixture(t);
    const before = action === 'device-pair' ? undefined : pending(await f.pair());
    const receipt =
      action === 'device-accept' ? await f.approve(before!.pending.request) : undefined;
    const bytes = existsSync(f.endpointPath) ? readFileSync(f.endpointPath) : undefined;
    const entered = deferred(),
      release = deferred();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let paused = false;
    const mock = t.mock.method(
      crypto.subtle,
      'digest',
      async (...args: Parameters<typeof digest>) => {
        if (!paused) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return digest(...args);
      },
    );
    const operation =
      action === 'device-pair'
        ? f.pair()
        : action === 'device-renew'
          ? f.service.request({ action, expectedRevision: before!.revision })
          : f.accept(before!.revision, receipt!);
    await entered.promise;
    f.account({ current: false });
    release.resolve();
    failed(await operation);
    mock.mock.restore();
    if (bytes) assert.deepEqual(readFileSync(f.endpointPath), bytes);
    else assert(!existsSync(f.endpointPath));
    f.account({ current: true });
    const after = status(await f.service.request({ action: 'status' })).device;
    assert.equal(after.revision, before?.revision ?? null);
  });
}
