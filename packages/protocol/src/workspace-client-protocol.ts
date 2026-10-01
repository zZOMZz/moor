import { actorSchema, workspaceAttentionCommandSchema } from './workspace-attention';
import { z } from 'zod';
import { hostCommandSchema } from '@moor/protocol/host-command';
import { workspaceTargetSchema } from '@moor/protocol/workspace-target';
import { id, runtimeWorkspaceSchema } from '@moor/protocol/protocol';
import { hostNotificationEventSchema } from '@moor/protocol/notification-protocol';

export const workspaceContextSchema = z
  .object({
    localReady: z.boolean(),
    view: z.enum(['local', 'remote']),
    notification: hostNotificationEventSchema.nullable(),
    revision: z.number().int().nonnegative().safe(),
  })
  .strict();

export const WORKSPACE_LIMITS = Object.freeze({
  requestBytes: 48 * 1024 * 1024,
  responseBytes: 48 * 1024 * 1024,
  pending: 16,
  pendingBytes: 96 * 1024 * 1024,
});
export const workspaceSourceSchema = z.enum(['local', 'remote']);
export type WorkspaceSource = z.infer<typeof workspaceSourceSchema>;
export const workspaceProjectTargetSchema = workspaceTargetSchema.extend({ catalogProjectId: id });
export type WorkspaceProjectTarget = z.infer<typeof workspaceProjectTargetSchema>;
// Invalidation only. Session bodies are read through the authenticated host boundary.
export const workspaceChangeSchema = z
  .object({
    source: workspaceSourceSchema,
    connectionId: z.string().uuid(),
    owner: z.string().min(1).max(1000),
    kind: z.enum(['connected', 'disconnected', 'changed']),
    deviceId: id.optional(),
    workspaceId: id.optional(),
    sessionId: id.optional(),
  })
  .strict();
export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>;
export const workspaceRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('catalog'), source: workspaceSourceSchema }).strict(),
  z
    .object({
      action: z.literal('attention'),
      source: workspaceSourceSchema,
      connectionId: z.string().uuid(),
      target: workspaceProjectTargetSchema,
      actor: actorSchema,
      command: workspaceAttentionCommandSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('execute'),
      source: workspaceSourceSchema,
      connectionId: z.string().uuid(),
      target: workspaceProjectTargetSchema,
      command: hostCommandSchema,
    })
    .strict(),
]);
export type WorkspaceRequest = z.infer<typeof workspaceRequestSchema>;
export const workspaceCatalogSchema = z
  .object({
    connectionId: z.string().uuid(),
    source: workspaceSourceSchema,
    origin: z.string().url().max(2048),
    owner: z.string().min(1).max(1000),
    actor: actorSchema.optional(),
    targets: z
      .array(
        z
          .object({
            target: workspaceProjectTargetSchema,
            workspaceName: z.string().max(1000),
            projectName: z.string().max(1000),
            hostName: z.string().max(1000),
            online: z.boolean(),
            runtime: runtimeWorkspaceSchema,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type WorkspaceCatalog = z.infer<typeof workspaceCatalogSchema>;

export const addProjectResultSchema = z.discriminatedUnion('canceled', [
  z.object({ canceled: z.literal(true) }).strict(),
  z
    .object({
      canceled: z.literal(false),
      projectId: id,
      settingsSaved: z.boolean(),
      identity: z
        .object({
          owner: z.string().min(1).max(1000),
          deviceId: id,
          workspaceId: id,
          machineId: id,
          userId: z.string().min(1).max(1000),
        })
        .strict(),
    })
    .strict(),
]);
