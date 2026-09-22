import { z } from 'zod';
import { id } from './protocol';
import { projectSourceSchema } from './catalog';
import { workspaceCatalogSchema } from './workspace-catalog';

const base = z.object({ owner: id });
const name = z.string().trim().min(1).max(100);
export const accountManagementRequestSchema = z.discriminatedUnion('action', [
  base.extend({ action: z.literal('devices') }).strict(),
  base.extend({ action: z.literal('catalog') }).strict(),
  base.extend({ action: z.literal('pair'), workspaceId: id.optional() }).strict(),
  base.extend({ action: z.literal('revoke'), deviceId: id }).strict(),
  base.extend({ action: z.literal('create-workspace'), name }).strict(),
  base.extend({ action: z.literal('rename-workspace'), workspaceId: id, name }).strict(),
  base
    .extend({
      action: z.literal('create-project'),
      workspaceId: id,
      name: z.string().trim().min(1).max(200),
      source: projectSourceSchema.optional(),
    })
    .strict(),
  base
    .extend({ action: z.literal('move-host'), workspaceId: id, hostId: id, targetWorkspaceId: id })
    .strict(),
  base
    .extend({ action: z.literal('assign-replica'), workspaceId: id, replicaId: id, projectId: id })
    .strict(),
]);
export type AccountManagementRequest = z.infer<typeof accountManagementRequestSchema>;
const devices = z
  .array(z.object({ id, name: z.string().max(1000), online: z.boolean() }))
  .max(1000);
export type AccountManagementValue =
  | { action: 'devices'; devices: z.infer<typeof devices> }
  | { action: 'catalog'; workspaces: z.infer<typeof workspaceCatalogSchema> }
  | { action: 'pair'; code: string; expiresIn: number }
  | { action: 'create-workspace' | 'create-project'; id: string }
  | { action: 'revoke' | 'rename-workspace' | 'move-host' | 'assign-replica'; ok: true };

/** A closed set of organization actions. No caller-controlled path, method or headers. */
export function accountManagementPlan(raw: unknown) {
  const request = accountManagementRequestSchema.parse(raw);
  const part = encodeURIComponent;
  let path: string;
  let body: Record<string, unknown> | undefined;
  switch (request.action) {
    case 'devices':
      path = '/api/devices';
      break;
    case 'catalog':
      path = '/api/workspaces';
      break;
    case 'pair':
      path = '/api/pair';
      body = request.workspaceId ? { workspaceId: request.workspaceId } : {};
      break;
    case 'revoke':
      path = '/api/devices/' + part(request.deviceId) + '/revoke';
      body = {};
      break;
    case 'create-workspace':
      path = '/api/workspaces';
      body = { name: request.name };
      break;
    case 'rename-workspace':
      path = '/api/workspaces/' + part(request.workspaceId) + '/rename';
      body = { name: request.name };
      break;
    case 'create-project':
      path = '/api/workspaces/' + part(request.workspaceId) + '/projects';
      body = { name: request.name, source: request.source ?? { kind: 'local' } };
      break;
    case 'move-host':
      path =
        '/api/workspaces/' + part(request.workspaceId) + '/hosts/' + part(request.hostId) + '/move';
      body = { workspaceId: request.targetWorkspaceId };
      break;
    case 'assign-replica':
      path =
        '/api/workspaces/' +
        part(request.workspaceId) +
        '/replicas/' +
        part(request.replicaId) +
        '/assign';
      body = { projectId: request.projectId };
      break;
  }
  return {
    request,
    path: path + '?expectedAccount=' + encodeURIComponent(request.owner),
    body,
    method: body === undefined ? 'GET' : 'POST',
    responseBytes: body === undefined ? 8 * 1024 * 1024 : 4096,
    changesCatalog: body !== undefined && request.action !== 'pair',
  };
}

export function validateAccountManagementResult(
  rawRequest: AccountManagementRequest,
  raw: unknown,
): AccountManagementValue {
  const request = accountManagementRequestSchema.parse(rawRequest);
  switch (request.action) {
    case 'devices': {
      const result = devices.parse(raw);
      if (new Set(result.map((device) => device.id)).size !== result.length)
        throw Error('电脑列表包含重复身份。');
      return { action: 'devices', devices: result };
    }
    case 'catalog': {
      const result = workspaceCatalogSchema.parse(raw);
      if (new Set(result.map((workspace) => workspace.id)).size !== result.length)
        throw Error('工作区列表包含重复身份。');
      for (const workspace of result) {
        const hosts = new Set(workspace.hosts.map((host) => host.id));
        const projects = new Set(workspace.projects.map((project) => project.id));
        if (
          hosts.size !== workspace.hosts.length ||
          projects.size !== workspace.projects.length ||
          new Set(workspace.replicas.map((replica) => replica.id)).size !==
            workspace.replicas.length ||
          workspace.replicas.some(
            (replica) => !hosts.has(replica.hostId) || !projects.has(replica.projectId),
          )
        )
          throw Error('目录中的项目与电脑关联不可验证。');
      }
      return { action: 'catalog', workspaces: result };
    }
    case 'pair':
      return {
        action: 'pair',
        ...z
          .object({
            code: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
            expiresIn: z.number().int().positive().max(3600),
          })
          .strict()
          .parse(raw),
      };
    case 'create-project':
    case 'create-workspace':
      return { action: request.action, id: z.object({ id }).parse(raw).id };
    default:
      return {
        action: request.action,
        ...z
          .object({ ok: z.literal(true) })
          .strict()
          .parse(raw),
      };
  }
}
