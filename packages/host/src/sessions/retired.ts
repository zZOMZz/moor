import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { assert, id } from '@moor/protocol/protocol';
import { RETIRED_SESSION_FEATURE } from '@moor/protocol/connection-authority';
import {
  ROLE_LIMITS,
  roleSchema,
  rolesReadSchema,
  rolesInspectSchema,
  validateRolesRead,
  validateRoleReceipt,
  validateRolesInspect,
} from '@moor/protocol/role-protocol';
import { previewInspectSchema, previewReceiptSchema } from '@moor/protocol/preview-protocol';
import {
  TASK_LIMITS,
  taskReadSchema,
  taskActionSchema,
  validateTaskReadResult,
  validateTaskActionResult,
} from '@moor/protocol/task-protocol';
import { mcpReadSchema, mcpServerViewSchema, validateMcpRead } from '@moor/protocol/mcp-protocol';
import type { ContentScope } from '@moor/protocol/content-protocol';
import type { HostWorkspace } from './workspace';
import type { AttachmentScope } from '../persistence/store';

type Host = Pick<HostWorkspace, 'store' | 'ensureConnected' | 'projectRootLease' | 'checkProject'>;
const scopeKey = (scope: AttachmentScope) =>
  JSON.stringify([
    scope.workspaceId,
    scope.userId,
    scope.machineId,
    scope.localProjectId,
    scope.sessionId,
  ]);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = (host: Host, input: ContentScope, project?: string) => {
  host.ensureConnected();
  const { rootPath: _, ...value } = host.projectRootLease(input, project);
  return value;
};
const table = (host: Host, name: string) =>
  !!host.store.journal.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
function boundedJson(raw: unknown, limit: number) {
  assert(
    typeof raw === 'string' && Buffer.byteLength(raw) <= limit,
    409,
    '旧记录不可验证或超过只读限制',
  );
  return JSON.parse(raw);
}

export function readRetiredRoles(host: Host, input: unknown, project?: string) {
  const request = rolesReadSchema.parse(input),
    context = scope(host, request, project);
  const row = table(host, 'project_role_catalog')
    ? host.store.journal.db
        .prepare('SELECT revision,roles FROM project_role_catalog WHERE scope=?')
        .get(
          JSON.stringify([
            context.workspaceId,
            context.userId,
            context.machineId,
            context.localProjectId,
          ]),
        )
    : undefined;
  const roles = row
    ? z
        .array(roleSchema)
        .max(ROLE_LIMITS.items)
        .parse(boundedJson(row.roles, ROLE_LIMITS.catalogBytes))
    : [];
  return validateRolesRead(
    {
      ...request,
      confirmed: true,
      catalogRevision: row?.revision ?? 0,
      roles: roles.map((role) => ({
        ...role,
        available: false,
        unavailableReason: RETIRED_SESSION_FEATURE,
      })),
    },
    request,
  );
}
export function inspectRetiredRole(host: Host, input: unknown, project?: string) {
  const { request } = rolesInspectSchema.parse(input),
    context = scope(host, request, project);
  const row = host.store.journal.db
    .prepare('SELECT fingerprint,phase,result FROM operation WHERE id=?')
    .get(request.operationId);
  let receipt;
  if (row) {
    assert(
      row.fingerprint === hash(JSON.stringify([scopeKey(context), request])) &&
        ['role-accepted', 'role-abandoned'].includes(String(row.phase)),
      409,
      '原角色编号或执行范围不匹配',
    );
    receipt = validateRoleReceipt(boundedJson(row.result, ROLE_LIMITS.responseBytes), request);
    assert(receipt.accepted === (row.phase === 'role-accepted'), 409, '原角色状态不可验证');
  }
  return validateRolesInspect(
    {
      rolesVersion: 1,
      workspaceId: request.workspaceId,
      localProjectId: request.localProjectId,
      sessionId: request.sessionId,
      confirmed: true,
      operationId: request.operationId,
      action: 'inspect',
      found: !!receipt,
      ...(receipt ? { receipt } : {}),
    },
    request,
  );
}
export function inspectRetiredPreview(host: Host, input: unknown, project?: string) {
  const { request } = previewInspectSchema.parse(input),
    context = scope(host, request, project);
  const row = host.store.journal.lookup(scopeKey(context), request);
  assert(!row || String(row.phase).startsWith('preview-'), 409, '原编号不属于网页预览');
  if (row?.result) {
    const saved = previewReceiptSchema.parse(boundedJson(row.result, 6 * 1024 * 1024));
    assert(
      row.phase === 'preview-' + saved.phase &&
        saved.operationId === request.operationId &&
        saved.requestVersion === 'sha256:' + hash(JSON.stringify(request)) &&
        saved.workspaceId === context.workspaceId &&
        saved.localProjectId === context.localProjectId &&
        saved.sessionId === context.sessionId &&
        saved.clientId === request.clientId &&
        saved.action === request.action,
      409,
      '原预览回执范围不匹配',
    );
    const { frame: _frame, ...receipt } = saved;
    return { ...receipt, closed: true };
  }
  // Absence of a saved result remains unknown. Runtime shutdown is not a receipt
  // for a page action and never updates the journal to an invented terminal phase.
  return previewReceiptSchema.parse({
    previewVersion: 1,
    workspaceId: context.workspaceId,
    localProjectId: context.localProjectId,
    sessionId: context.sessionId,
    clientId: request.clientId,
    operationId: request.operationId,
    requestVersion: 'sha256:' + hash(JSON.stringify(request)),
    action: request.action,
    phase: 'unknown',
    message: RETIRED_SESSION_FEATURE,
    closed: true,
    checkedAt: new Date().toISOString(),
  });
}
function taskContext(host: Host, request: ContentScope, project?: string) {
  const context = scope(host, request, project);
  host.checkProject(request.sessionId, project);
  return context;
}
function taskSessionExists(host: Host, context: AttachmentScope, sessionId: string) {
  const key = 'session-' + sessionId;
  const project = host.store.meta.get(['m', key, 'project']) as
    | { localProjectId?: string }
    | undefined;
  return (
    host.store.meta.get(['m', key, 'id']) === sessionId &&
    host.store.meta.get(['m', key, 'userId']) === context.userId &&
    host.store.meta.get(['m', key, 'machineId']) === context.machineId &&
    project?.localProjectId === context.localProjectId &&
    host.store.attachmentScopeMatches({ ...context, sessionId })
  );
}
export function readRetiredTasks(host: Host, input: unknown, project?: string) {
  const request = taskReadSchema.parse(input),
    context = taskContext(host, request, project);
  const records = host.store.tasks;
  const grants = request.grantId
    ? [records.grant(context, request.grantId)]
    : records.list(context);
  const values = [];
  for (const grant of grants.slice(0, 20)) {
    const value = records.view(grant, (sessionId) => taskSessionExists(host, context, sessionId));
    if (Buffer.byteLength(JSON.stringify([...values, value])) > TASK_LIMITS.responseBytes - 2048)
      break;
    values.push(value);
  }
  return validateTaskReadResult(
    { ...request, confirmed: true, grants: values, truncated: values.length < grants.length },
    request,
  );
}
export function inspectRetiredTask(host: Host, input: unknown, project?: string) {
  const request = taskActionSchema.parse(input);
  assert(request.action === 'inspect', 410, RETIRED_SESSION_FEATURE);
  const context = taskContext(host, request, project),
    records = host.store.tasks,
    grant = records.grant(context, request.grantId);
  const operation = records.operation(grant, request.operationId);
  assert(
    operation || records.hasRevocation(grant, request),
    404,
    '没有找到这个旧任务原操作；状态保持不变',
  );
  const result = {
    ...request,
    confirmed: true,
    grant: records.view(grant, (sessionId) => taskSessionExists(host, context, sessionId)),
    ...(operation ? { operation: records.operationView(operation) } : {}),
  };
  assert(
    Buffer.byteLength(JSON.stringify(result)) <= TASK_LIMITS.responseBytes,
    413,
    '旧任务响应超过只读限制',
  );
  return validateTaskActionResult(result, request);
}

export function readRetiredMcp(host: Host, input: unknown, project?: string) {
  const request = mcpReadSchema.parse(input),
    context = scope(host, request, project);
  const bytes = host.store.load('mcp-settings-v1');
  if (!bytes)
    return validateMcpRead(
      { ...request, confirmed: true, catalogRevision: 0, servers: [] },
      request,
    );
  assert(bytes.byteLength <= 40 * 1024 * 1024, 409, '旧MCP配置超过只读限制');
  const saved = z
    .object({
      version: z.literal(1),
      identity: z.object({ workspaceId: id, userId: z.string(), machineId: id }).strict(),
      revision: z.number().int().nonnegative(),
      presets: z
        .array(
          z.object({ id, versionId: id, enabled: z.boolean(), removed: z.boolean() }).passthrough(),
        )
        .max(500),
      versions: z
        .array(
          mcpServerViewSchema
            .omit({ transport: true })
            .extend({
              presetId: id,
              projects: z
                .array(z.object({ id, rootPath: z.string(), dev: z.string(), ino: z.string() }))
                .max(100),
              connection: z
                .object({ transport: mcpServerViewSchema.shape.transport })
                .passthrough(),
            })
            .passthrough(),
        )
        .max(500),
    })
    .strict()
    .parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  assert(
    saved.identity.workspaceId === context.workspaceId &&
      saved.identity.userId === context.userId &&
      saved.identity.machineId === context.machineId,
    409,
    '旧MCP设置属于另一执行身份',
  );
  const root = host.projectRootLease(request, project).rootPath,
    stat = lstatSync(root, { bigint: true });
  const servers = saved.presets.flatMap((preset) => {
    if (preset.removed || !preset.enabled) return [];
    const version = saved.versions.find(
      (version) => version.id === preset.versionId && version.presetId === preset.id,
    );
    assert(version, 409, '旧MCP版本不可验证');
    if (
      !version.projects.some(
        (entry) =>
          entry.id === context.localProjectId &&
          entry.rootPath === root &&
          entry.dev === String(stat.dev) &&
          entry.ino === String(stat.ino),
      )
    )
      return [];
    return [
      {
        id: version.id,
        name: version.name,
        description: version.description,
        transport: version.connection.transport,
      },
    ];
  });
  return validateMcpRead(
    { ...request, confirmed: true, catalogRevision: saved.revision, servers },
    request,
  );
}
