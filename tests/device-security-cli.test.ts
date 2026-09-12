import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEVICE_SECURITY_FAILED,
  DEVICE_SECURITY_MAX_BYTES,
  type DeviceSecurityResult,
} from '../src/security/commands';
import type { DeviceManager, DevicePairingReceipt } from '../src/security/device-manager';
import { generateRecoveryKey } from '../src/security/e2ee-recovery';
import { VerifiedTrust } from '../src/security/e2ee-trust';
import { PrivateEndpointFile } from '../src/security/private-endpoint-file';

const identity = {
  accountId: 'synthetic-account',
  serverOrigin: 'https://synthetic-relay.invalid',
  deviceId: 'synthetic-admin',
  roles: ['client', 'host'],
};
const failed = { code: 1, stdout: '', stderr: DEVICE_SECURITY_FAILED + '\n' };
const packagedEntry = process.env.MOOR_DEVICE_SECURITY_ENTRY;
const packagedNode = process.env.MOOR_DEVICE_SECURITY_NODE;
if (packagedEntry) assert.ok(isAbsolute(packagedEntry), 'security test entry must be absolute');
if (packagedNode) assert.ok(isAbsolute(packagedNode), 'security test runtime must be absolute');
type ProcessResult = { code: number | null; stdout: string; stderr: string };
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'moor-device-security-cli-')));
  chmodSync(root, 0o700);
  const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const file = join(root, 'endpoint.json');
  return {
    root,
    file,
    code: join(root, 'recovery-code.json'),
    capsule: join(root, 'recovery-capsule.json'),
    joining: join(root, 'joining-endpoint.json'),
    recovered: join(root, 'recovered-endpoint.json'),
    async run(
      input: unknown,
      options: {
        file?: string;
        args?: string[];
        raw?: string | Buffer;
        preload?: string;
      } = {},
    ): Promise<ProcessResult> {
      const child = spawn(
        packagedNode ?? process.execPath,
        [
          ...(packagedEntry ? [] : ['--import', 'tsx']),
          ...(options.preload ? ['--import', pathToFileURL(options.preload).href] : []),
          packagedEntry ?? resolve('src/security/main.ts'),
          ...(options.args ?? ['--data-file', options.file ?? file]),
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          // No account, agent, relay or security credential is needed by this entrypoint.
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
      child.stdout.on('data', (bytes) => {
        stdout += bytes;
      });
      child.stderr.on('data', (bytes) => {
        stderr += bytes;
      });
      child.stdin.on('error', () => {});
      child.stdin.end(options.raw ?? JSON.stringify(input));
      const [code, signal] = await closed;
      assert.equal(signal, null);
      return { code, stdout, stderr };
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function result(process: ProcessResult, action: string) {
  assert.equal(process.code, 0, process.stderr);
  assert.equal(process.stderr, '');
  const value = JSON.parse(process.stdout) as DeviceSecurityResult;
  assert.deepEqual(Object.keys(value).sort(), ['action', 'data', 'ok', 'securityVersion']);
  assert.equal(value.securityVersion, 1);
  assert.equal(value.ok, true);
  assert.equal(value.action, action);
  return value.data;
}
function active(value: unknown) {
  const state = structuredClone(value) as ReturnType<DeviceManager['status']>;
  assert.ok('device' in state);
  assert.ok(state.revision);
  Reflect.deleteProperty(state, 'fingerprint');
  return state;
}
function stored(file: string) {
  const opened = PrivateEndpointFile.open(file);
  try {
    return opened.load();
  } finally {
    opened.close();
  }
}
function save(file: string, value: unknown) {
  const opened = PrivateEndpointFile.open(file);
  try {
    opened.save(null, value);
  } finally {
    opened.close();
  }
}
function code(f: Fixture): string {
  const value = stored(f.code)?.value as { kind: string; code: string };
  assert.equal(value.kind, 'moor-e2ee-recovery-code');
  assert.equal(value.code.length, 43);
  return value.code;
}
function noSecrets(output: string, ...files: string[]) {
  for (const file of files) {
    const value = stored(file)?.value as {
      code?: string;
      capsule?: string;
      recoveryCapsule?: string;
      privateKey?: { d: string };
      pending?: { privateKey: { d: string } };
    };
    for (const secret of [
      value.code,
      value.capsule,
      value.recoveryCapsule,
      value.privateKey?.d,
      value.pending?.privateKey.d,
    ])
      if (secret)
        assert.ok(!output.includes(secret), 'public output excludes private file material');
  }
  assert.doesNotMatch(
    output,
    /"(?:privateKey|rootPrivateKey|recoveryKey|recoveryCapsule|capsule|code|d)":/,
  );
}
async function initialize(f: Fixture) {
  const process = await f.run({ action: 'initialize', identity, recoveryCodeFile: f.code });
  const state = active(result(process, 'initialize'));
  assert.equal(state.phase, 'active');
  assert.equal(state.revision, 1);
  assert.equal(state.canUnlockRoot, true);
  noSecrets(process.stdout + process.stderr, f.file, f.code);
  return state;
}

test(
  'real CLI initializes private state, manually pairs, rotates, cancels, renews and revokes a synthetic endpoint',
  { timeout: 30000 },
  async (t) => {
    const f = fixture(t),
      initial = await initialize(f);
    assert.equal(statSync(f.root).mode & 0o777, 0o700);
    for (const file of [f.file, f.code]) assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(result(await f.run({ action: 'read' }), 'read'), initial);
    const begin = await f.run(
      {
        action: 'begin-pairing',
        pin: initial.pin,
        deviceId: 'synthetic-client',
        roles: ['client'],
      },
      { file: f.joining },
    );
    const pending = active(result(begin, 'begin-pairing'));
    assert.equal(pending.phase, 'pending');
    assert.equal(pending.trust, null);
    assert.equal(pending.canUnlockRoot, false);
    assert.ok(pending.pending);
    const fingerprint = (result(begin, 'begin-pairing') as { fingerprint: string }).fingerprint;
    const approve = {
      action: 'approve-pairing',
      expectedRevision: initial.revision,
      request: pending.pending.request,
      expectedFingerprint: fingerprint,
      expectedDeviceKeyId: null,
      recoveryCodeFile: f.code,
    };
    assert.deepEqual(await f.run({ ...approve, expectedFingerprint: 'A'.repeat(43) }), failed);
    const missingCode = join(f.root, 'missing-approval-code.json');
    assert.deepEqual(await f.run({ ...approve, recoveryCodeFile: missingCode }), failed);
    assert.equal(existsSync(missingCode), false, 'approval never generates a recovery code');
    assert.deepEqual(result(await f.run({ action: 'read' }), 'read'), initial);
    const reopenedPending = result(await f.run({ action: 'read' }, { file: f.joining }), 'read');
    assert.deepEqual(active(reopenedPending), pending);
    assert.equal((reopenedPending as { fingerprint: string }).fingerprint, fingerprint);
    const approval = await f.run(approve);
    const receipt = result(approval, 'approve-pairing') as DevicePairingReceipt;
    assert.equal(receipt.fingerprint, fingerprint);
    assert.equal(receipt.request.device.keyId, pending.device.keyId);
    const accepted = await f.run(
      {
        action: 'accept-pairing',
        expectedRevision: pending.revision,
        approval: receipt.approval,
        rootPublicKey: receipt.trust.rootPublicKey,
        signedManifest: receipt.trust.signedManifest,
      },
      { file: f.joining },
    );
    const joined = active(result(accepted, 'accept-pairing'));
    assert.equal(joined.phase, 'active');
    assert.equal(joined.pending, null);
    assert.equal(joined.canUnlockRoot, false);
    assert.deepEqual(joined.trust, receipt.trust);
    assert.deepEqual(result(await f.run({ action: 'read' }, { file: f.joining }), 'read'), joined);
    noSecrets(begin.stdout + approval.stdout + accepted.stdout, f.file, f.code, f.joining);

    const rotation = active(
      result(
        await f.run(
          { action: 'rotate-key', expectedRevision: joined.revision },
          { file: f.joining },
        ),
        'rotate-key',
      ),
    );
    assert.ok(rotation.pending);
    assert.equal(rotation.device.keyId, joined.device.keyId);
    assert.notEqual(rotation.pending.request.device.keyId, joined.device.keyId);
    assert.deepEqual(
      await f.run(
        { action: 'cancel-rotation', expectedRevision: joined.revision },
        { file: f.joining },
      ),
      failed,
    );
    const cancelled = active(
      result(
        await f.run(
          { action: 'cancel-rotation', expectedRevision: rotation.revision },
          { file: f.joining },
        ),
        'cancel-rotation',
      ),
    );
    assert.equal(cancelled.pending, null);
    assert.equal(cancelled.device.keyId, joined.device.keyId);
    const rotating = active(
      result(
        await f.run(
          { action: 'rotate-key', expectedRevision: cancelled.revision },
          { file: f.joining },
        ),
        'rotate-key',
      ),
    );
    const renewal = await f.run(
      { action: 'renew-pairing', expectedRevision: rotating.revision },
      { file: f.joining },
    );
    const renewed = active(result(renewal, 'renew-pairing'));
    assert.ok(renewed.pending && rotating.pending);
    assert.notEqual(renewed.pending.request.pairingId, rotating.pending.request.pairingId);
    assert.equal(renewed.pending.request.device.keyId, rotating.pending.request.device.keyId);
    const reopenedRenewal = result(await f.run({ action: 'read' }, { file: f.joining }), 'read');
    assert.deepEqual(active(reopenedRenewal), renewed);
    assert.equal(
      (reopenedRenewal as { fingerprint: string }).fingerprint,
      (result(renewal, 'renew-pairing') as { fingerprint: string }).fingerprint,
    );
    const admin = active(result(await f.run({ action: 'read' }), 'read'));
    const rotationReceipt = result(
      await f.run({
        action: 'approve-pairing',
        expectedRevision: admin.revision,
        request: renewed.pending.request,
        expectedFingerprint: (result(renewal, 'renew-pairing') as { fingerprint: string })
          .fingerprint,
        expectedDeviceKeyId: joined.device.keyId,
        recoveryCodeFile: f.code,
      }),
      'approve-pairing',
    ) as DevicePairingReceipt;
    const rotated = active(
      result(
        await f.run(
          {
            action: 'accept-pairing',
            expectedRevision: renewed.revision,
            approval: rotationReceipt.approval,
            rootPublicKey: rotationReceipt.trust.rootPublicKey,
            signedManifest: rotationReceipt.trust.signedManifest,
          },
          { file: f.joining },
        ),
        'accept-pairing',
      ),
    );
    assert.equal(rotated.device.keyId, renewed.pending.request.device.keyId);
    assert.equal(rotated.pending, null);
    const beforeRevocation = active(result(await f.run({ action: 'read' }), 'read'));
    const revoked = active(
      result(
        await f.run({
          action: 'revoke-device',
          expectedRevision: beforeRevocation.revision,
          deviceId: rotated.device.deviceId,
          expectedKeyId: rotated.device.keyId,
          recoveryCodeFile: f.code,
        }),
        'revoke-device',
      ),
    );
    const installed = active(
      result(
        await f.run(
          {
            action: 'install-trust',
            expectedRevision: rotated.revision,
            signedManifest: revoked.trust!.signedManifest,
          },
          { file: f.joining },
        ),
        'install-trust',
      ),
    );
    assert.equal(installed.phase, 'revoked');
    assert.deepEqual(installed.trust, revoked.trust);
    assert.deepEqual(
      await f.run(
        { action: 'rotate-key', expectedRevision: installed.revision },
        { file: f.joining },
      ),
      failed,
    );
  },
);

test(
  'recovery export is a new private file and recovery requires explicit pin, base trust and exact revocations',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t),
      initial = await initialize(f);
    const exportResult = await f.run({
      action: 'export-recovery',
      recoveryCodeFile: f.code,
      outputFile: f.capsule,
    });
    assert.deepEqual(result(exportResult, 'export-recovery'), { outputFile: f.capsule });
    assert.equal(statSync(f.capsule).mode & 0o777, 0o600);
    noSecrets(exportResult.stdout, f.file, f.code, f.capsule);
    const originalCapsule = readFileSync(f.capsule),
      originalCode = readFileSync(f.code);
    assert.deepEqual(
      await f.run({ action: 'export-recovery', recoveryCodeFile: f.code, outputFile: f.capsule }),
      failed,
    );
    assert.deepEqual(readFileSync(f.capsule), originalCapsule);
    const request = {
      action: 'recover',
      recoveryCodeFile: f.code,
      capsuleFile: f.capsule,
      expectedPin: initial.pin,
      baseTrust: initial.trust,
      deviceId: 'synthetic-recovered-admin',
      roles: ['host'],
      revokeDevices: [{ deviceId: initial.device.deviceId, keyId: initial.device.keyId }],
    };
    assert.deepEqual(
      await f.run(
        { ...request, expectedPin: { ...initial.pin, accountId: 'different-account' } },
        { file: f.recovered },
      ),
      failed,
    );
    assert.equal(existsSync(f.recovered), false);
    assert.deepEqual(
      await f.run(
        {
          ...request,
          revokeDevices: [{ deviceId: initial.device.deviceId, keyId: 'A'.repeat(43) }],
        },
        { file: f.recovered },
      ),
      failed,
    );
    assert.equal(existsSync(f.recovered), false);
    const recoveredResult = await f.run(request, { file: f.recovered });
    const recovered = active(result(recoveredResult, 'recover'));
    assert.equal(recovered.phase, 'active');
    assert.equal(recovered.device.deviceId, request.deviceId);
    assert.notEqual(recovered.device.keyId, initial.device.keyId);
    assert.equal(recovered.canUnlockRoot, true);
    const trust = await VerifiedTrust.verify({
      signed: recovered.trust!.signedManifest,
      rootPublicKey: recovered.trust!.rootPublicKey,
      pin: initial.pin,
      previous: initial.trust!.checkpoint,
    });
    assert.deepEqual(
      trust.manifest.devices.map((device) => device.deviceId),
      [request.deviceId],
    );
    assert.deepEqual(await f.run(request, { file: f.recovered }), failed);
    assert.deepEqual(
      result(await f.run({ action: 'read' }, { file: f.recovered }), 'read'),
      recovered,
    );
    assert.deepEqual(readFileSync(f.capsule), originalCapsule);
    assert.deepEqual(readFileSync(f.code), originalCode);
    noSecrets(recoveredResult.stdout, f.file, f.code, f.capsule, f.recovered);
  },
);

test(
  'a persisted recovery code survives initialization failure and is reused only by a later manual action',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      fault = join(f.root, 'synthetic-fault.mjs');
    writeFileSync(
      fault,
      `crypto.subtle.generateKey = async () => { throw new Error('synthetic-private-error-sentinel'); };`,
      { mode: 0o600 },
    );
    const initializeCommand = { action: 'initialize', identity, recoveryCodeFile: f.code };
    assert.deepEqual(await f.run(initializeCommand, { preload: fault }), failed);
    assert.equal(existsSync(f.file), false);
    const savedCode = code(f),
      before = readFileSync(f.code),
      inode = statSync(f.code).ino;
    assert.deepEqual(result(await f.run({ action: 'read' }), 'read'), {
      revision: null,
      phase: 'empty',
    });
    assert.equal(existsSync(f.file), false, 'read never retries an initialization');
    await initialize(f);
    assert.equal(code(f), savedCode);
    assert.deepEqual(readFileSync(f.code), before);
    assert.equal(statSync(f.code).ino, inode);
    const anotherCode = join(f.root, 'unexpected-code.json');
    assert.deepEqual(await f.run({ ...initializeCommand, recoveryCodeFile: anotherCode }), failed);
    assert.equal(existsSync(anotherCode), false);
    assert.equal(existsSync(anotherCode + '.lock'), false);
  },
);

test(
  'stdin is one strict, bounded UTF-8 action and CLI arguments never accept secret values',
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const padded = JSON.stringify({ action: 'read' }).padEnd(DEVICE_SECURITY_MAX_BYTES, ' ');
    assert.deepEqual(result(await f.run(null, { raw: padded }), 'read'), {
      revision: null,
      phase: 'empty',
    });
    for (const raw of [
      '',
      '{',
      '{"action":"read"}\n{"action":"read"}',
      JSON.stringify({ action: 'read', recoveryKey: 'synthetic-secret-sentinel' }),
      JSON.stringify({ action: 'unknown-private-sentinel' }),
      JSON.stringify({
        action: 'initialize',
        identity: { ...identity, password: 'synthetic-secret-sentinel' },
        recoveryCodeFile: f.code,
      }),
      JSON.stringify({ action: 'rotate-key', expectedRevision: 0 }),
      padded + ' ',
      Buffer.from([0xff]),
    ])
      assert.deepEqual(await f.run(null, { raw }), failed);
    for (const args of [
      [],
      ['--data-file', 'relative.json'],
      ['--data-file', f.file, '--data-file', f.file],
      ['--data-file', f.file, '--recovery-key', 'synthetic-secret-sentinel'],
    ])
      assert.deepEqual(await f.run({ action: 'read' }, { args }), failed);
    assert.equal(existsSync(f.file), false);
    assert.equal(existsSync(f.code), false);
  },
);

test(
  'strict recovery file formats fail without creating vaults or generating replacement codes',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    for (const [index, value] of [
      { kind: 'moor-e2ee-recovery-capsule', capsule: 'synthetic-private-sentinel' },
      { kind: 'moor-e2ee-recovery-code', code: 'synthetic-private-sentinel' },
      {
        kind: 'moor-e2ee-recovery-code',
        code: generateRecoveryKey(),
        extra: 'synthetic-private-sentinel',
      },
    ].entries()) {
      const file = join(f.root, `bad-code-${index}.json`);
      save(file, value);
      const bytes = readFileSync(file);
      assert.deepEqual(
        await f.run({ action: 'initialize', identity, recoveryCodeFile: file }),
        failed,
      );
      assert.deepEqual(readFileSync(file), bytes);
      assert.equal(existsSync(f.file), false);
    }
    const initial = await initialize(f),
      absent = join(f.root, 'absent-code.json');
    assert.deepEqual(
      await f.run({
        action: 'revoke-device',
        expectedRevision: initial.revision,
        deviceId: initial.device.deviceId,
        expectedKeyId: initial.device.keyId,
        recoveryCodeFile: absent,
      }),
      failed,
    );
    assert.equal(existsSync(absent), false);
    assert.deepEqual(result(await f.run({ action: 'read' }), 'read'), initial);
    const wrongCapsule = join(f.root, 'wrong-capsule.json');
    save(wrongCapsule, {
      kind: 'moor-e2ee-recovery-capsule',
      capsule: 'synthetic-private-sentinel',
      extra: true,
    });
    assert.deepEqual(
      await f.run(
        {
          action: 'recover',
          recoveryCodeFile: f.code,
          capsuleFile: wrongCapsule,
          expectedPin: initial.pin,
          baseTrust: initial.trust,
          deviceId: 'synthetic-recovered',
          roles: ['host'],
          revokeDevices: [],
        },
        { file: f.recovered },
      ),
      failed,
    );
    assert.equal(existsSync(f.recovered), false);
  },
);

test(
  'all private paths and their lock namespaces are distinct and existing exports are never overwritten',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    for (const recoveryCodeFile of [
      f.file,
      f.file + '.lock',
      f.file + '.lock-journal',
      join(f.root, '.', 'endpoint.json'),
    ]) {
      assert.deepEqual(await f.run({ action: 'initialize', identity, recoveryCodeFile }), failed);
      assert.equal(existsSync(f.file), false);
      assert.equal(existsSync(f.file + '.lock'), false);
    }
    const initial = await initialize(f),
      bytes = readFileSync(f.file),
      codeBytes = readFileSync(f.code);
    for (const outputFile of [f.file, f.code, f.file + '.lock', f.code + '.lock'])
      assert.deepEqual(
        await f.run({ action: 'export-recovery', recoveryCodeFile: f.code, outputFile }),
        failed,
      );
    assert.deepEqual(
      await f.run(
        {
          action: 'recover',
          recoveryCodeFile: f.code,
          capsuleFile: f.code,
          expectedPin: initial.pin,
          baseTrust: initial.trust,
          deviceId: 'synthetic-recovered',
          roles: ['host'],
          revokeDevices: [],
        },
        { file: f.recovered },
      ),
      failed,
    );
    assert.deepEqual(readFileSync(f.file), bytes);
    assert.deepEqual(readFileSync(f.code), codeBytes);
    const operator = join(f.root, 'operator.json');
    writeFileSync(operator, 'operator-owned-private-sentinel', { mode: 0o600 });
    assert.deepEqual(
      await f.run({ action: 'export-recovery', recoveryCodeFile: f.code, outputFile: operator }),
      failed,
    );
    assert.equal(readFileSync(operator, 'utf8'), 'operator-owned-private-sentinel');
  },
);

test(
  'a different process holding a vault or auxiliary lock prevents the CLI from reading or mutating it',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t),
      initial = await initialize(f),
      bytes = readFileSync(f.file);
    const lock = PrivateEndpointFile.open(f.file);
    try {
      assert.deepEqual(await f.run({ action: 'read' }), failed);
      assert.deepEqual(
        await f.run({ action: 'rotate-key', expectedRevision: initial.revision }),
        failed,
      );
    } finally {
      lock.close();
    }
    const codeLock = PrivateEndpointFile.open(f.code);
    try {
      assert.deepEqual(
        await f.run({ action: 'export-recovery', recoveryCodeFile: f.code, outputFile: f.capsule }),
        failed,
      );
    } finally {
      codeLock.close();
    }
    assert.equal(existsSync(f.capsule), false);
    assert.deepEqual(readFileSync(f.file), bytes);
    assert.deepEqual(result(await f.run({ action: 'read' }), 'read'), initial);
  },
);

test(
  'the CLI refuses symlinks, public directories and relative auxiliary paths',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      publicDirectory = join(f.root, 'public');
    mkdirSync(publicDirectory, { mode: 0o755 });
    const publicFile = join(publicDirectory, 'endpoint.json');
    assert.deepEqual(await f.run({ action: 'read' }, { file: publicFile }), failed);
    assert.equal(existsSync(publicFile), false);
    const initial = await initialize(f),
      bytes = readFileSync(f.file),
      link = join(f.root, 'alias.json');
    symlinkSync(f.file, link);
    assert.deepEqual(await f.run({ action: 'read' }, { file: link }), failed);
    assert.deepEqual(
      await f.run({
        action: 'export-recovery',
        recoveryCodeFile: 'relative-code.json',
        outputFile: f.capsule,
      }),
      failed,
    );
    assert.deepEqual(readFileSync(f.file), bytes);
    assert.deepEqual(result(await f.run({ action: 'read' }), 'read'), initial);
  },
);

test(
  'standalone initialization and read complete with socket, server and agent-process creation disabled',
  { timeout: 10000 },
  async (t) => {
    const f = fixture(t),
      guard = join(f.root, 'synthetic-no-network.mjs');
    writeFileSync(
      guard,
      `
    import net from 'node:net';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const deny = () => { throw new Error('synthetic-unexpected-network-or-agent'); };
    net.Socket.prototype.connect = deny;
    net.Server.prototype.listen = deny;
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
      childProcess[method] = deny;
    globalThis.fetch = deny;
    syncBuiltinESMExports();
  `,
      { mode: 0o600 },
    );
    const initialized = await f.run(
      { action: 'initialize', identity, recoveryCodeFile: f.code },
      { preload: guard },
    );
    const state = active(result(initialized, 'initialize'));
    assert.equal(state.phase, 'active');
    const read = await f.run({ action: 'read' }, { preload: guard });
    assert.deepEqual(result(read, 'read'), state);
    noSecrets(initialized.stdout + read.stdout, f.file, f.code);
  },
);
