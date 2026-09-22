import { z } from 'zod';
import { actorSchema } from './attention';
import { agentSchema, id, runtimeWorkspaceSchema } from './protocol';
import { workspaceTargetSchema } from './workspace-target';

export const workspaceCatalogSchema = z
  .array(
    z.object({
      id,
      name: z.string(),
      hosts: z.array(
        z.object({
          id,
          deviceId: id,
          machineId: id,
          runtimeWorkspaceId: id,
          name: z.string(),
          online: z.boolean(),
          agents: z.array(agentSchema),
        }),
      ),
      projects: z.array(z.object({ id, name: z.string() })),
      replicas: z.array(
        z.object({
          id,
          projectId: id,
          hostId: id,
          localProjectId: id,
          available: z.boolean(),
          rootPath: z.string().optional(),
        }),
      ),
    }),
  )
  .max(1000);

export const workspaceDevicesSchema = z
  .array(
    z.object({
      id,
      name: z.string(),
      online: z.boolean(),
      workspaces: z.array(runtimeWorkspaceSchema),
    }),
  )
  .max(1000);

const identitySchema = z
  .object({ owner: z.string().min(1).max(1000), actor: actorSchema })
  .strict()
  .refine((value) => value.actor.accountId === value.owner);

/** One authenticated snapshot, never assembled from independent HTTP responses. */
export const workspaceCatalogSnapshotSchema = z
  .object({
    version: z.literal(1),
    identity: identitySchema,
    workspaces: workspaceCatalogSchema,
    devices: workspaceDevicesSchema,
  })
  .strict();

/** A selected replica's current routing context; its digest is not an authorization. */
export const workspaceReplicaContextSchema = z
  .object({
    version: z.literal(1),
    identity: identitySchema,
    target: workspaceTargetSchema
      .omit({ serverKey: true, sessionId: true })
      .extend({ catalogProjectId: id })
      .strict(),
    mappingVersion: z.string().regex(/^[a-f0-9]{64}$/),
    runtime: runtimeWorkspaceSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.target.owner === value.identity.owner &&
      value.target.workspaceId === value.runtime.id &&
      value.target.machineId === value.runtime.machineId &&
      value.target.userId === value.runtime.userId &&
      value.runtime.projects.length === 1 &&
      value.runtime.projects[0]?.id === value.target.localProjectId,
  );
