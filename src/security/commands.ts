import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { DeviceManager, deviceIdentitySchema, devicePublicTrustSchema } from './device-manager';
import { E2EE_PAIRING_LIMITS, fingerprintRequest, pairingRequestSchema } from './e2ee-pairing';
import { E2EE_RECOVERY_MAX_BYTES, generateRecoveryKey } from './e2ee-recovery';
import {
  E2EE_TRUST_LIMITS,
  e2eeDigestSchema,
  e2eeIdSchema,
  rootPublicJwkSchema,
  trustPinSchema,
} from './e2ee-trust';
import { PrivateEndpointFile } from './private-endpoint-file';

export const DEVICE_SECURITY_MAX_BYTES = 1024 * 1024;
export const DEVICE_SECURITY_FAILED =
  '本机设备安全操作未确认完成；请先执行 read 核对本机状态，再决定下一步。不会自动重试。';
const pathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolute)
  .refine((value) => !value.includes('\0'));
const revisionSchema = z.number().int().positive().safe();
const rolesSchema = deviceIdentitySchema.shape.roles;
const manifestSchema = z.string().min(1).max(E2EE_TRUST_LIMITS.signedCharacters);
const recoveryCodeSchema = z
  .object({ kind: z.literal('moor-e2ee-recovery-code'), code: e2eeDigestSchema })
  .strict();
const recoveryCapsuleSchema = z
  .object({
    kind: z.literal('moor-e2ee-recovery-capsule'),
    capsule: z.string().min(1).max(E2EE_RECOVERY_MAX_BYTES),
  })
  .strict();

/** Local operator input only. Credentials are read from private files, never command arguments. */
export const deviceSecurityCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({
      action: z.literal('initialize'),
      identity: deviceIdentitySchema,
      recoveryCodeFile: pathSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('begin-pairing'),
      pin: trustPinSchema,
      deviceId: e2eeIdSchema,
      roles: rolesSchema,
    })
    .strict(),
  z.object({ action: z.literal('renew-pairing'), expectedRevision: revisionSchema }).strict(),
  z.object({ action: z.literal('rotate-key'), expectedRevision: revisionSchema }).strict(),
  z.object({ action: z.literal('cancel-rotation'), expectedRevision: revisionSchema }).strict(),
  z
    .object({
      action: z.literal('approve-pairing'),
      expectedRevision: revisionSchema,
      request: pairingRequestSchema,
      expectedFingerprint: e2eeDigestSchema,
      expectedDeviceKeyId: e2eeDigestSchema.nullable(),
      recoveryCodeFile: pathSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('accept-pairing'),
      expectedRevision: revisionSchema,
      approval: z.string().min(1).max(E2EE_PAIRING_LIMITS.approvalCharacters),
      rootPublicKey: rootPublicJwkSchema,
      signedManifest: manifestSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('revoke-device'),
      expectedRevision: revisionSchema,
      deviceId: e2eeIdSchema,
      expectedKeyId: e2eeDigestSchema,
      recoveryCodeFile: pathSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('install-trust'),
      expectedRevision: revisionSchema,
      signedManifest: manifestSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('export-recovery'),
      recoveryCodeFile: pathSchema,
      outputFile: pathSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('recover'),
      recoveryCodeFile: pathSchema,
      capsuleFile: pathSchema,
      expectedPin: trustPinSchema,
      baseTrust: devicePublicTrustSchema,
      deviceId: e2eeIdSchema,
      roles: rolesSchema,
      revokeDevices: z
        .array(z.object({ deviceId: e2eeIdSchema, keyId: e2eeDigestSchema }).strict())
        .max(E2EE_TRUST_LIMITS.devices)
        .refine((items) => new Set(items.map((item) => item.deviceId)).size === items.length),
    })
    .strict(),
]);
export type DeviceSecurityCommand = z.infer<typeof deviceSecurityCommandSchema>;
export type DeviceSecurityResult = {
  securityVersion: 1;
  ok: true;
  action: DeviceSecurityCommand['action'];
  data: unknown;
};

function fail(): never {
  throw new Error(DEVICE_SECURITY_FAILED);
}
function distinctPaths(paths: string[]) {
  const resolved = paths.map((path) => resolve(pathSchema.parse(path)));
  if (new Set(resolved).size !== resolved.length) fail();
  // Lock databases and their sidecars must not overlap another operation's data file either.
  for (const path of resolved)
    for (const suffix of ['.lock', '.lock-journal', '.lock-wal', '.lock-shm'])
      if (resolved.includes(path + suffix)) fail();
}

/** One manual action. The caller owns input/output; this module never connects to a host or relay. */
export async function runDeviceSecurityCommand(
  input: unknown,
  options: { dataFile: string },
): Promise<DeviceSecurityResult> {
  let manager: DeviceManager | undefined;
  const opened: PrivateEndpointFile[] = [];
  try {
    const command = deviceSecurityCommandSchema.parse(input);
    const paths = [options.dataFile];
    if ('recoveryCodeFile' in command) paths.push(command.recoveryCodeFile);
    if ('capsuleFile' in command) paths.push(command.capsuleFile);
    if ('outputFile' in command) paths.push(command.outputFile);
    distinctPaths(paths);
    manager = await DeviceManager.open(options.dataFile);
    const open = (path: string) => {
      const file = PrivateEndpointFile.open(path);
      opened.push(file);
      return file;
    };
    const code = (path: string, create = false) => {
      const file = open(path),
        saved = file.load();
      if (saved) return recoveryCodeSchema.parse(saved.value).code;
      if (!create) fail();
      const value = recoveryCodeSchema.parse({
        kind: 'moor-e2ee-recovery-code',
        code: generateRecoveryKey(),
      });
      // Persist the only copy of the recovery code before initializing the vault. Keep it on failure.
      file.save(null, value);
      return value.code;
    };
    let data: unknown;
    switch (command.action) {
      case 'read': {
        const status = manager.status();
        if ('pending' in status && status.pending) {
          const fingerprint = await fingerprintRequest(status.pending.request);
          const current = manager.status();
          if (current.revision !== status.revision) fail();
          data = { ...current, fingerprint };
        } else data = status;
        break;
      }
      case 'initialize':
        if (manager.status().phase !== 'empty') fail();
        data = await manager.initialize(command.identity, code(command.recoveryCodeFile, true));
        break;
      case 'begin-pairing':
        data = await manager.beginPairing(command);
        break;
      case 'renew-pairing':
        data = await manager.renewPairing(command.expectedRevision);
        break;
      case 'rotate-key':
        data = await manager.requestKeyRotation(command.expectedRevision);
        break;
      case 'cancel-rotation':
        data = manager.cancelRotation(command.expectedRevision);
        break;
      case 'approve-pairing':
        data = await manager.approvePairing({
          ...command,
          recoveryKey: code(command.recoveryCodeFile),
        });
        break;
      case 'accept-pairing':
        data = await manager.acceptPairing(command);
        break;
      case 'revoke-device':
        data = await manager.revokeDevice({
          ...command,
          recoveryKey: code(command.recoveryCodeFile),
        });
        break;
      case 'install-trust':
        data = await manager.installTrust(command);
        break;
      case 'export-recovery': {
        const recoveryKey = code(command.recoveryCodeFile);
        const output = open(command.outputFile);
        if (output.load()) fail();
        const capsule = await manager.recoveryCapsule(recoveryKey);
        for (const file of opened) file.load();
        output.save(
          null,
          recoveryCapsuleSchema.parse({ kind: 'moor-e2ee-recovery-capsule', capsule }),
        );
        data = { outputFile: resolve(command.outputFile) };
        break;
      }
      case 'recover': {
        if (manager.status().phase !== 'empty') fail();
        const recoveryKey = code(command.recoveryCodeFile);
        const capsule = recoveryCapsuleSchema.parse(
          open(command.capsuleFile).load()?.value,
        ).capsule;
        data = await manager.recover({ ...command, recoveryKey, capsule });
        break;
      }
    }
    // A replaced or changed auxiliary file makes the result uncertain; never report success for it.
    for (const file of opened) file.load();
    return { securityVersion: 1, ok: true, action: command.action, data };
  } catch {
    return fail();
  } finally {
    for (const file of opened.reverse()) file.close();
    manager?.close();
  }
}
