import { z } from 'zod';
import { agentSchema, id, localProjectSchema, runtimeWorkspaceSchema } from '../protocol';
import { hostCommandSchema } from '../bridge/host-command';
import { E2EE_RECORD_LIMITS, encryptedRecordSchema } from './e2ee-channel';
import { e2eeDigestSchema } from './e2ee-trust';
import {
  encryptedProductActionSchema,
  encryptedProductCatalogSchema,
  encryptedProductTargetSchema,
} from './encrypted-product-catalog';

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
  ingressBytes: 2 * (E2EE_RECORD_LIMITS.wireBytes + 2048),
  ingressFragments: 1024,
  ingressMessageMs: 30000,
  queuedFrames: 1024,
  queuedFramesPerSocket: 128,
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
const encryptedCatalogV1Schema = z
  .object({
    catalogVersion: z.literal(1),
    machineId: id,
    workspaces: z.array(workspaceSchema).max(20),
  })
  .strict();
const encryptedCatalogV2Schema = encryptedCatalogV1Schema
  .extend({ catalogVersion: z.literal(2), products: encryptedProductCatalogSchema })
  .strict();
export const encryptedCatalogSchema = z
  .discriminatedUnion('catalogVersion', [encryptedCatalogV1Schema, encryptedCatalogV2Schema])
  .superRefine((catalog, context) => {
    if (
      new Set(catalog.workspaces.map((workspace) => workspace.id)).size !==
        catalog.workspaces.length ||
      catalog.workspaces.some((workspace) => workspace.machineId !== catalog.machineId)
    )
      context.addIssue({ code: 'custom', message: 'Invalid catalogue identity' });
    if (catalog.catalogVersion !== 2) return;
    const workspaces = new Map(catalog.workspaces.map((workspace) => [workspace.id, workspace]));
    const counts = new Map<string, number>();
    for (const replica of catalog.products.replicas) {
      if (!replica.available) continue;
      const workspace = workspaces.get(replica.runtimeWorkspaceId);
      if (
        !workspace ||
        workspace.userId !== replica.userId ||
        workspace.machineId !== replica.machineId ||
        !workspace.projects.some((project) => project.id === replica.localProjectId)
      )
        context.addIssue({ code: 'custom', message: 'Invalid available product replica' });
      const key = JSON.stringify([replica.runtimeWorkspaceId, replica.localProjectId]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const workspace of catalog.workspaces)
      for (const project of workspace.projects)
        if (counts.get(JSON.stringify([workspace.id, project.id])) !== 1)
          context.addIssue({ code: 'custom', message: 'Missing unique product replica' });
  });
export type EncryptedCatalog = z.infer<typeof encryptedCatalogSchema>;
export const encryptedCatalogRequestSchema = z
  .object({ method: z.literal('catalog'), params: z.object({}).strict() })
  .strict();
export const encryptedMappedCommandSchema = z
  .object({
    method: z.literal('mapped-command'),
    target: encryptedProductTargetSchema,
    command: hostCommandSchema,
  })
  .strict();
export const encryptedCatalogActionRequestSchema = z
  .object({ method: z.literal('catalog-action'), params: encryptedProductActionSchema })
  .strict();
export const encryptedCatalogOperationSchema = z
  .object({ action: z.enum(['inspect', 'abandon']), request: encryptedProductActionSchema })
  .strict();
export type EncryptedCatalogOperation = z.infer<typeof encryptedCatalogOperationSchema>;
export const encryptedCatalogOperationRequestSchema = z
  .object({ method: z.literal('catalog-operation'), params: encryptedCatalogOperationSchema })
  .strict();
export const encryptedHostRequestSchema = z.union([
  encryptedCatalogRequestSchema,
  encryptedMappedCommandSchema,
  encryptedCatalogActionRequestSchema,
  encryptedCatalogOperationRequestSchema,
  hostCommandSchema,
]);
export type EncryptedHostRequest = z.infer<typeof encryptedHostRequestSchema>;
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
