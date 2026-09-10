import { z } from 'zod';
import { id, agentSchema } from './protocol';

// Product identity is independent of a host's Lody workspace and filesystem.
export const projectSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({
    kind: z.literal('git'),
    provider: z.enum(['github', 'gitlab', 'other']),
    url: z
      .string()
      .max(2048)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        );
      }, '仓库地址必须为不含凭据、查询参数或片段的 HTTPS 地址'),
  }),
]);
export type ProjectSource = z.infer<typeof projectSourceSchema>;
export const projectInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  source: projectSourceSchema.default({ kind: 'local' }),
});
export const workspaceInputSchema = z.object({ name: z.string().trim().min(1).max(100) });
export type Project = { id: string; name: string; source: ProjectSource };
export type HostBinding = {
  id: string;
  deviceId: string;
  machineId: string;
  runtimeWorkspaceId: string;
  name: string;
  online: boolean;
  agents: z.infer<typeof agentSchema>[];
};
export type ProjectReplica = {
  id: string;
  projectId: string;
  hostId: string;
  localProjectId: string;
  // The live host supplies this path. It is never the identity of a logical project.
  rootPath?: string;
  available: boolean;
};
export type Workspace = {
  id: string;
  name: string;
  hosts: HostBinding[];
  projects: Project[];
  replicas: ProjectReplica[];
};
export const replicaAssignmentSchema = z.object({ projectId: id });
