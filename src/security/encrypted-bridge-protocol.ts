import { z } from 'zod';
import { agentSchema, id, localProjectSchema, runtimeWorkspaceSchema } from '../protocol';
import { hostCommandSchema, type HostCommand } from '../bridge/host-command';
import { E2EE_RECORD_LIMITS, encryptedRecordSchema } from './e2ee-channel';
import { e2eeDigestSchema } from './e2ee-trust';

export const ENCRYPTED_BRIDGE_PROTOCOL = 4;
export const ENCRYPTED_BRIDGE_PATHS = Object.freeze({
  host: '/bridge/v4/host',
  client: '/bridge/v4/client',
});
export const ENCRYPTED_BRIDGE_LIMITS = Object.freeze({
  handshakeBytes: 16 * 1024,
  readyBytes: 64 * 1024,
  wireBytes: E2EE_RECORD_LIMITS.wireBytes + 2048,
  hosts: 64,
  clients: 64,
  sockets: 256,
  pending: 64,
  pendingBytes: 2 * E2EE_RECORD_LIMITS.wireBytes,
  channels: 64,
  channelHistory: 256,
  handshakeMs: 10000,
  requestMs: 30000,
  heartbeatMs: 20000,
});
export const ENCRYPTED_BRIDGE_FAILED = '加密连接未确认完成；原操作不会自动重发，请核对后手动继续。';
const principal = {
  deviceId: id,
  keyId: e2eeDigestSchema,
  rootKeyId: e2eeDigestSchema,
  trustEpoch: z.number().int().positive().safe(),
  trustDigest: e2eeDigestSchema,
};
export const encryptedBridgeHostDescriptorSchema = z
  .object({ ...principal, hostChallenge: e2eeDigestSchema })
  .strict();
export type EncryptedBridgeHostDescriptor = z.infer<typeof encryptedBridgeHostDescriptorSchema>;
export const encryptedBridgeHelloSchema = z.discriminatedUnion('side', [
  z
    .object({
      protocol: z.literal(4),
      type: z.literal('hello'),
      side: z.literal('host'),
      ...principal,
      hostChallenge: e2eeDigestSchema,
    })
    .strict(),
  z
    .object({
      protocol: z.literal(4),
      type: z.literal('hello'),
      side: z.literal('client'),
      ...principal,
    })
    .strict(),
]);
export type EncryptedBridgeHello = z.infer<typeof encryptedBridgeHelloSchema>;
export const encryptedBridgeClientRecordSchema = z
  .object({ protocol: z.literal(4), type: z.literal('record'), record: encryptedRecordSchema })
  .strict();
export const encryptedBridgeHostRecordSchema = encryptedBridgeClientRecordSchema
  .extend({ clientConnectionId: e2eeDigestSchema })
  .strict();
export const encryptedBridgeHostReadySchema = z
  .object({
    protocol: z.literal(4),
    type: z.literal('ready'),
    side: z.literal('host'),
    host: encryptedBridgeHostDescriptorSchema,
  })
  .strict();
export const encryptedBridgeClientReadySchema = z
  .object({
    protocol: z.literal(4),
    type: z.literal('ready'),
    side: z.literal('client'),
    clientConnectionId: e2eeDigestSchema,
    hosts: z.array(encryptedBridgeHostDescriptorSchema).max(ENCRYPTED_BRIDGE_LIMITS.hosts),
  })
  .strict()
  .refine((value) => new Set(value.hosts.map((host) => host.deviceId)).size === value.hosts.length);
export const encryptedBridgeClientClosedSchema = z
  .object({
    protocol: z.literal(4),
    type: z.literal('client-closed'),
    clientConnectionId: e2eeDigestSchema,
  })
  .strict();
export const encryptedBridgeUnavailableSchema = z
  .object({
    protocol: z.literal(4),
    type: z.literal('unavailable'),
    requestId: e2eeDigestSchema.optional(),
    code: z.literal('unavailable'),
  })
  .strict();
export const encryptedBridgeHostMessageSchema = z.union([
  encryptedBridgeHostReadySchema,
  encryptedBridgeHostRecordSchema,
  encryptedBridgeClientClosedSchema,
  encryptedBridgeUnavailableSchema,
]);
export const encryptedBridgeClientMessageSchema = z.union([
  encryptedBridgeClientReadySchema,
  encryptedBridgeClientRecordSchema,
  encryptedBridgeUnavailableSchema,
]);

const projectSchema = localProjectSchema.strict();
const publicAgentSchema = agentSchema
  .extend({ cliType: z.string().max(200), agentType: z.string().max(200) })
  .strict();
const workspaceSchema = runtimeWorkspaceSchema
  .extend({
    name: z.string().max(200),
    userId: z.string().min(1).max(160),
    projects: z.array(projectSchema).max(500),
    agents: z.array(publicAgentSchema).max(100),
  })
  .strict()
  .superRefine((workspace, context) => {
    for (const key of ['projects', 'agents'] as const)
      if (new Set(workspace[key].map((item) => item.id)).size !== workspace[key].length)
        context.addIssue({ code: 'custom', message: 'Duplicate catalogue identity', path: [key] });
    if (workspace.features && new Set(workspace.features).size !== workspace.features.length)
      context.addIssue({
        code: 'custom',
        message: 'Duplicate catalogue feature',
        path: ['features'],
      });
  });
/** Names, filesystem paths, Agent configuration and all execution catalogues stay inside ciphertext. */
export const encryptedCatalogSchema = z
  .object({
    catalogVersion: z.literal(1),
    machineId: id,
    workspaces: z.array(workspaceSchema).max(20),
  })
  .strict()
  .superRefine((catalog, context) => {
    if (
      new Set(catalog.workspaces.map((workspace) => workspace.id)).size !==
        catalog.workspaces.length ||
      catalog.workspaces.some((workspace) => workspace.machineId !== catalog.machineId)
    )
      context.addIssue({ code: 'custom', message: 'Invalid catalogue identity' });
  });
export type EncryptedCatalog = z.infer<typeof encryptedCatalogSchema>;
export const encryptedCatalogRequestSchema = z
  .object({ method: z.literal('catalog'), params: z.object({}).strict() })
  .strict();
export const encryptedHostRequestSchema = z.union([
  encryptedCatalogRequestSchema,
  hostCommandSchema,
]);
export type EncryptedHostRequest = z.infer<typeof encryptedCatalogRequestSchema> | HostCommand;
export const encryptedHostResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          status: z.number().int().min(400).max(599),
          message: z.string().min(1).max(2000),
          rejected: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);

/** The transport envelope bound includes framing around the fixed encrypted record. */
export function parseEncryptedBridgeMessage(text: string, handshake = false): unknown {
  const limit = handshake
    ? ENCRYPTED_BRIDGE_LIMITS.handshakeBytes
    : ENCRYPTED_BRIDGE_LIMITS.wireBytes;
  if (
    typeof text !== 'string' ||
    text.length > limit ||
    new TextEncoder().encode(text).byteLength > limit
  )
    throw Error(ENCRYPTED_BRIDGE_FAILED);
  try {
    return JSON.parse(text);
  } catch {
    throw Error(ENCRYPTED_BRIDGE_FAILED);
  }
}
