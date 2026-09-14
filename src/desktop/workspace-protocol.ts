import { actorSchema, workspaceAttentionCommandSchema } from './workspace-attention';
import { z } from 'zod';
import { hostCommandSchema } from '../bridge/host-command';
import { workspaceTargetSchema } from '../workspace-target';
import { id, runtimeWorkspaceSchema } from '../protocol';
import { hostNotificationEventSchema } from '../notification-protocol';

export const desktopWorkspaceContextSchema = z
  .object({
    localReady: z.boolean(),
    view: z.enum(['local', 'remote']),
    notification: hostNotificationEventSchema.nullable(),
    revision: z.number().int().nonnegative().safe(),
  })
  .strict();

export const DESKTOP_WORKSPACE_LIMITS = Object.freeze({
  requestBytes: 48 * 1024 * 1024,
  responseBytes: 48 * 1024 * 1024,
  pending: 16,
  pendingBytes: 96 * 1024 * 1024,
});
export const desktopWorkspaceSourceSchema = z.enum(['local', 'remote']);
export type DesktopWorkspaceSource = z.infer<typeof desktopWorkspaceSourceSchema>;
export const desktopWorkspaceTargetSchema = workspaceTargetSchema.extend({ catalogProjectId: id });
export type DesktopWorkspaceTarget = z.infer<typeof desktopWorkspaceTargetSchema>;
export const desktopWorkspaceRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('catalog'), source: desktopWorkspaceSourceSchema }).strict(),
  z
    .object({
      action: z.literal('attention'),
      source: desktopWorkspaceSourceSchema,
      connectionId: z.string().uuid(),
      target: desktopWorkspaceTargetSchema,
      actor: actorSchema,
      command: workspaceAttentionCommandSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('execute'),
      source: desktopWorkspaceSourceSchema,
      connectionId: z.string().uuid(),
      target: desktopWorkspaceTargetSchema,
      command: hostCommandSchema,
    })
    .strict(),
]);
export type DesktopWorkspaceRequest = z.infer<typeof desktopWorkspaceRequestSchema>;
export const desktopWorkspaceCatalogSchema = z
  .object({
    connectionId: z.string().uuid(),
    source: desktopWorkspaceSourceSchema,
    origin: z.string().url().max(2048),
    owner: z.string().min(1).max(1000),
    actor: actorSchema.optional(),
    targets: z
      .array(
        z
          .object({
            target: desktopWorkspaceTargetSchema,
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
export type DesktopWorkspaceCatalog = z.infer<typeof desktopWorkspaceCatalogSchema>;
