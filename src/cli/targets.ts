import { z } from 'zod';
import { agentSchema, id, runtimeWorkspaceSchema } from '../protocol';
import { CliError } from './args';
import { CliHttp } from './http';
import { cliTargetSchema, type CliTarget } from './state';
const catalogSchema = z
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
const devicesSchema = z
  .array(
    z.object({
      id,
      name: z.string(),
      online: z.boolean(),
      workspaces: z.array(runtimeWorkspaceSchema),
    }),
  )
  .max(1000);
export type CliResolvedTarget = {
  target: CliTarget;
  workspaceName: string;
  projectName: string;
  hostName: string;
  online: boolean;
  agents: z.infer<typeof agentSchema>[];
  features: string[];
  rootPath?: string;
};
export function cliServerKey(http: CliHttp) {
  return http.options.local ? 'local:' + http.options.local.connection.machineId : http.origin;
}
export async function listTargets(
  http: CliHttp,
  onRoots?: (roots: string[]) => void,
): Promise<CliResolvedTarget[]> {
  const owner = await http.identity();
  const catalog = catalogSchema.parse(
      await http.json('/api/workspaces', undefined, 8 * 1024 * 1024),
    ),
    devices = devicesSchema.parse(await http.json('/api/devices', undefined, 8 * 1024 * 1024));
  const results: CliResolvedTarget[] = [];
  for (const workspace of catalog)
    for (const replica of workspace.replicas) {
      const host = workspace.hosts.find((h) => h.id === replica.hostId),
        project = workspace.projects.find((p) => p.id === replica.projectId);
      if (!host || !project) continue;
      const device = devices.find((d) => d.id === host.deviceId),
        runtime = device?.workspaces.find(
          (w) => w.id === host.runtimeWorkspaceId && w.machineId === host.machineId,
        ),
        local = runtime?.projects.find((p) => p.id === replica.localProjectId);
      if (!runtime || !local) continue;
      const descriptor = http.options.local?.connection;
      if (
        descriptor &&
        (descriptor.deviceId !== host.deviceId ||
          descriptor.runtimeWorkspaceId !== runtime.id ||
          descriptor.machineId !== runtime.machineId ||
          descriptor.userId !== runtime.userId ||
          descriptor.ownerId !== owner)
      )
        continue;
      results.push({
        target: cliTargetSchema.parse({
          serverKey: cliServerKey(http),
          owner,
          deviceId: host.deviceId,
          machineId: runtime.machineId,
          userId: runtime.userId,
          workspaceId: runtime.id,
          localProjectId: local.id,
          catalogWorkspaceId: workspace.id,
          replicaId: replica.id,
        }),
        workspaceName: workspace.name,
        projectName: project.name,
        hostName: host.name,
        online: !!device?.online && host.online && replica.available,
        agents: runtime.agents,
        features: runtime.features ?? [],
        rootPath: local.rootPath,
      });
    }
  if (http.options.local) onRoots?.(results.flatMap((row) => (row.rootPath ? [row.rootPath] : [])));
  return results;
}
export function replicaBase(target: CliTarget) {
  return '/api/workspaces/' + target.catalogWorkspaceId + '/replicas/' + target.replicaId;
}
export async function resolveTarget(
  http: CliHttp,
  target: CliTarget,
  onRoots?: (roots: string[]) => void,
) {
  if (target.serverKey !== cliServerKey(http) || target.owner !== http.owner)
    throw new CliError('scope', '原目标属于另一服务器或登录账号。', 5);
  const matches = (await listTargets(http, onRoots)).filter((row) =>
    [
      'serverKey',
      'owner',
      'deviceId',
      'machineId',
      'userId',
      'workspaceId',
      'localProjectId',
    ].every((k) => row.target[k as keyof CliTarget] === target[k as keyof CliTarget]),
  );
  if (matches.length !== 1)
    throw new CliError('scope', '原执行目标已不可用或归属不明确，未执行操作。', 5);
  const found = matches[0]!;
  if (!found.online) throw new CliError('offline', '执行电脑离线；不会自动重试。', 4);
  return {
    ...found,
    target: { ...found.target, ...(target.sessionId ? { sessionId: target.sessionId } : {}) },
  };
}
