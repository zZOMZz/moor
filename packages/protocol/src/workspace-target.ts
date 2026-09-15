import { z } from 'zod';
import { id } from './protocol';

/** Durable execution identity shared by the CLI and desktop; never a connection credential. */
export const workspaceTargetSchema = z
  .object({
    serverKey: z.string().min(1).max(2048),
    owner: z.string().min(1).max(1000),
    deviceId: id,
    userId: z.string().min(1).max(1000),
    machineId: id,
    workspaceId: id,
    localProjectId: id,
    catalogWorkspaceId: id,
    replicaId: id,
    sessionId: id.optional(),
  })
  .strict();
export type WorkspaceTarget = z.infer<typeof workspaceTargetSchema>;
