import { z } from 'zod';
import { hostCommandSchema } from '../bridge/host-command';
import { e2eeIdSchema, trustPinSchema } from './e2ee-trust';
import {
  encryptedBridgeHostDescriptorSchema,
  encryptedCatalogOperationSchema,
  ENCRYPTED_BRIDGE_LIMITS,
} from './encrypted-bridge-protocol';
import {
  encryptedProductActionSchema,
  encryptedProductTargetSchema,
} from './encrypted-product-catalog';

export const DESKTOP_SECURE_FAILED =
  '加密连接或原操作结果未确认；请重新核对连接，再手动核查原操作。';
export const DESKTOP_SECURE_INVALID = '加密桌面请求格式不受支持。';
export const DESKTOP_SECURE_LIMITS = Object.freeze({
  requestBytes: 48 * 1024 * 1024,
  pending: 64,
  pendingBytes: 96 * 1024 * 1024,
  identityBytes: 4096,
  identityChunks: 4096,
  deadlineMs: 30000,
});
const connectionId = z.string().uuid();
const connection = { connectionId };
const host = { ...connection, hostId: e2eeIdSchema };
const command = hostCommandSchema.refine((value) => !!value.localProjectId);
const legacyCommand = command.refine((value) => value.method === 'session-operations');

/** The renderer cannot choose a URL, endpoint file, cookie, key or general IPC operation. */
export const desktopSecureRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('connect') }).strict(),
  z.object({ action: z.literal('disconnect'), ...connection }).strict(),
  z.object({ action: z.literal('catalog'), ...host }).strict(),
  z
    .object({
      action: z.literal('execute'),
      ...host,
      target: encryptedProductTargetSchema,
      command,
    })
    .strict(),
  z.object({ action: z.literal('legacy-operation'), ...host, command: legacyCommand }).strict(),
  z
    .object({
      action: z.literal('catalog-action'),
      ...host,
      request: encryptedProductActionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('catalog-operation'),
      ...host,
      operation: encryptedCatalogOperationSchema,
    })
    .strict(),
]);
export type DesktopSecureRequest = z.infer<typeof desktopSecureRequestSchema>;

const configuredDevice = z
  .object({
    phase: z.enum(['pending', 'revoked', 'active']),
    revision: z.number().int().positive().safe(),
    pin: trustPinSchema,
    deviceId: e2eeIdSchema,
    roles: z
      .array(z.enum(['client', 'host']))
      .min(1)
      .max(2),
    trustEpoch: z.number().int().positive().safe().nullable(),
  })
  .strict();
export const desktopSecureStatusSchema = z
  .object({
    device: z.union([
      z.object({ phase: z.literal('empty'), revision: z.null() }).strict(),
      configuredDevice,
    ]),
    connecting: z.boolean(),
    connection: z
      .object({
        connectionId,
        phase: z.literal('connected'),
        hosts: z.array(encryptedBridgeHostDescriptorSchema).max(ENCRYPTED_BRIDGE_LIMITS.hosts),
        // Relay routing descriptors become authority only after encrypted Host confirmation.
        verified: z.literal(false),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type DesktopSecureStatus = z.infer<typeof desktopSecureStatusSchema>;
export const desktopSecureResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.enum(['invalid-request', 'unavailable', 'host']),
          message: z.string().min(1).max(200),
          status: z.number().int().min(400).max(599).nullable(),
          rejected: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);
export type DesktopSecureResult = z.infer<typeof desktopSecureResultSchema>;
