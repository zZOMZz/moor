import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AppError, assert, type RuntimeWorkspace } from '../protocol';
import type { ContentScope } from '../content-protocol';
import {
  ROLE_LIMITS,
  roleSchema,
  rolesReadSchema,
  rolesActionRequestSchema,
  validateRolesRead,
  validateRoleReceipt,
  validateRolesInspect,
  type Role,
  type RoleAction,
  type RoleReceipt,
  type RolesActionRequest,
  type RolesInspectResult,
  type RolesRead,
  type RolesReadResult,
} from '../role-protocol';
import type { AttachmentScope, RuntimeStore } from './store';
import type { ExecutionLease } from './session-execution';

type Host = {
  store: RuntimeStore;
  workspace: RuntimeWorkspace;
  forkManager: { busy: ReadonlySet<string> };
  ensureConnected(): void;
  projectRootLease(input: ContentScope, project?: string): AttachmentScope & { rootPath: string };
  executionLease(input: ContentScope, project?: string, allowNew?: boolean): ExecutionLease;
  serial<T>(id: string, work: () => Promise<T>): Promise<T>;
};
const catalogSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    roles: z.array(roleSchema).max(ROLE_LIMITS.items),
  })
  .strict();
const projectKey = (scope: AttachmentScope) =>
  JSON.stringify([scope.workspaceId, scope.userId, scope.machineId, scope.localProjectId]);
const scopeKey = (scope: AttachmentScope) =>
  JSON.stringify([
    scope.workspaceId,
    scope.userId,
    scope.machineId,
    scope.localProjectId,
    scope.sessionId,
  ]);
const envelope = (request: RolesRead) => ({
  rolesVersion: 1 as const,
  workspaceId: request.workspaceId,
  localProjectId: request.localProjectId,
  sessionId: request.sessionId,
  confirmed: true as const,
});

/** Project templates live only in the execution host. Reading or saving never opens an Agent. */
export class SessionRolesManager {
  constructor(private host: Host) {
    host.store.journal.db.exec(
      'CREATE TABLE IF NOT EXISTS project_role_catalog(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,roles TEXT NOT NULL)',
    );
  }
  private context(request: RolesRead, project?: string, recovery = false) {
    this.host.ensureConnected();
    const resolveLease = () =>
      recovery
        ? this.host.projectRootLease(request, project)
        : this.host.executionLease(request, project, true);
    const lease = structuredClone(resolveLease());
    const scope: AttachmentScope = {
      workspaceId: lease.workspaceId,
      userId: lease.userId,
      machineId: lease.machineId,
      localProjectId: lease.localProjectId,
      sessionId: lease.sessionId,
    };
    const current = () => {
      this.host.ensureConnected();
      assert(isDeepStrictEqual(resolveLease(), lease), 409, '角色请求的执行范围已变化');
      if (!recovery)
        assert(
          !this.host.forkManager.busy.has(request.sessionId) &&
            !this.host.store.forks.blocked(request.sessionId),
          409,
          '请先确认此会话的 Fork 操作',
        );
    };
    current();
    return { scope, key: projectKey(scope), current };
  }
  private catalog(key: string) {
    const db = this.host.store.journal.db;
    const row = db
      .prepare(
        'SELECT revision,length(CAST(roles AS BLOB)) AS bytes FROM project_role_catalog WHERE scope=?',
      )
      .get(key);
    if (!row) return { revision: 0, roles: [] as Role[] };
    assert(Number(row.bytes) <= ROLE_LIMITS.catalogBytes, 409, '角色目录超过读取限制');
    const value = db.prepare('SELECT roles FROM project_role_catalog WHERE scope=?').get(key)!;
    const parsed = catalogSchema.safeParse({
      revision: row.revision,
      roles: JSON.parse(String(value.roles)),
    });
    assert(parsed.success, 409, '角色目录不可验证，请在执行电脑检查');
    assert(
      new Set(parsed.data.roles.map((role) => role.id)).size === parsed.data.roles.length &&
        parsed.data.roles.every((role) => role.revision <= parsed.data.revision),
      409,
      '角色目录版本不可验证',
    );
    return parsed.data;
  }
  private lookup(scope: AttachmentScope, request: RoleAction) {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([scopeKey(scope), request]))
      .digest('hex');
    const row = this.host.store.journal.db
      .prepare('SELECT fingerprint,phase,result FROM operation WHERE id=?')
      .get(request.operationId);
    if (!row) return { fingerprint };
    assert(
      row.fingerprint === fingerprint &&
        ['role-accepted', 'role-abandoned'].includes(String(row.phase)),
      409,
      '重复编号对应不同角色请求',
    );
    const receipt = validateRoleReceipt(JSON.parse(String(row.result)), request);
    assert(receipt.accepted === (row.phase === 'role-accepted'), 409, '原角色回执状态不可验证');
    return { fingerprint, receipt };
  }
  async read(input: RolesRead, project?: string): Promise<RolesReadResult> {
    const request = rolesReadSchema.parse(input),
      context = this.context(request, project);
    const result = await this.host.serial('roles/' + context.key, async () => {
      context.current();
      const catalog = this.catalog(context.key),
        binding = this.host.store.agents.binding(context.scope);
      const roles = catalog.roles.map((role) => {
        const available =
          this.host.workspace.agents.some((agent) => agent.id === role.agentId) ||
          binding?.id === role.agentId;
        return {
          ...role,
          available,
          ...(!available
            ? {
                unavailableReason:
                  '此角色固定的 Agent 版本已退出新会话列表；请编辑角色选择当前版本',
              }
            : {}),
        };
      });
      context.current();
      return validateRolesRead(
        { ...envelope(request), catalogRevision: catalog.revision, roles },
        request,
      );
    });
    context.current();
    return result;
  }
  async action(
    input: RolesActionRequest,
    project?: string,
  ): Promise<RoleReceipt | RolesInspectResult> {
    const parsed = rolesActionRequestSchema.parse(input),
      request =
        parsed.action === 'inspect' || parsed.action === 'abandon' ? parsed.request : parsed;
    let committed = false,
      wrote = false;
    try {
      const context = this.context(request, project, true);
      const known = this.lookup(context.scope, request);
      const execution =
        parsed.action === 'inspect' || parsed.action === 'abandon' || known.receipt
          ? undefined
          : this.context(request, project);
      const result = await this.host.serial('roles/' + context.key, async () => {
        context.current();
        const prior = this.lookup(context.scope, request);
        if (parsed.action === 'inspect')
          return validateRolesInspect(
            {
              ...envelope(request),
              action: 'inspect',
              operationId: request.operationId,
              found: !!prior.receipt,
              ...(prior.receipt ? { receipt: prior.receipt } : {}),
            },
            request,
          );
        if (prior.receipt) {
          committed = true;
          return prior.receipt;
        }
        if (parsed.action === 'abandon') {
          return this.host.store.transaction(() => {
            context.current();
            const receipt = validateRoleReceipt(
              {
                ...envelope(request),
                operationId: request.operationId,
                action: request.action,
                accepted: false,
                abandoned: true,
                catalogRevision: request.expectedRevision,
              },
              request,
            );
            this.host.store.reserveAttachmentScope(context.scope);
            this.host.store.journal.db
              .prepare(
                'INSERT INTO operation(id,fingerprint,phase,turn_id,result) VALUES(?,?,?,NULL,?)',
              )
              .run(
                request.operationId,
                prior.fingerprint,
                'role-abandoned',
                JSON.stringify(receipt),
              );
            context.current();
            return receipt;
          });
        }
        assert(execution, 409, '原角色回执不可用，请手动重新查询');
        const receipt = this.host.store.transaction(() => {
          execution.current();
          context.current();
          const catalog = this.catalog(context.key);
          assert(
            catalog.revision === request.expectedRevision,
            409,
            '角色目录已更新，请重新读取后保存',
          );
          assert(catalog.revision < Number.MAX_SAFE_INTEGER, 409, '角色目录版本已达上限');
          const index = request.id ? catalog.roles.findIndex((role) => role.id === request.id) : -1;
          if (request.id) assert(index >= 0, 404, '角色已移除，请重新读取');
          const nextRevision = catalog.revision + 1;
          let roleId: string;
          if (request.action === 'save') {
            assert(
              this.host.workspace.agents.some((agent) => agent.id === request.agentId),
              409,
              '保存角色需要选择当前可用的 Agent 版本',
            );
            const agent = this.host.store.agents.get(request.agentId);
            assert(
              agent?.machineId === context.scope.machineId,
              409,
              '角色 Agent 不属于当前执行电脑',
            );
            assert(
              index >= 0 || catalog.roles.length < ROLE_LIMITS.items,
              413,
              '项目角色数量已达上限',
            );
            const role = roleSchema.parse({
              id: request.id ?? 'role_' + randomUUID(),
              name: request.name,
              revision: nextRevision,
              agentId: request.agentId,
              selection: request.selection,
              instructions: request.instructions,
            });
            roleId = role.id;
            if (index >= 0) catalog.roles[index] = role;
            else catalog.roles.push(role);
          } else {
            roleId = request.id;
            catalog.roles.splice(index, 1);
          }
          const body = JSON.stringify(catalog.roles);
          assert(
            Buffer.byteLength(body) <= ROLE_LIMITS.catalogBytes,
            413,
            '项目角色目录超过 1 MiB',
          );
          const receipt = validateRoleReceipt(
            {
              ...envelope(request),
              accepted: true,
              operationId: request.operationId,
              action: request.action,
              catalogRevision: nextRevision,
              roleId,
            },
            request,
          );
          const db = this.host.store.journal.db;
          this.host.store.reserveAttachmentScope(context.scope);
          db.prepare(
            'INSERT INTO project_role_catalog VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,roles=excluded.roles',
          ).run(context.key, nextRevision, body);
          db.prepare(
            'INSERT INTO operation(id,fingerprint,phase,turn_id,result) VALUES(?,?,?,NULL,?)',
          ).run(request.operationId, prior.fingerprint, 'role-accepted', JSON.stringify(receipt));
          context.current();
          execution.current();
          return receipt;
        });
        wrote = true;
        return receipt;
      });
      if (parsed.action !== 'inspect') committed = true;
      context.current();
      if (wrote) execution?.current();
      return result;
    } catch (error) {
      // Local catalog and receipt commit together. A known operation can never be reported as unsent.
      const known =
        committed ||
        this.host.store.journal.db
          .prepare('SELECT 1 FROM operation WHERE id=?')
          .get(request.operationId);
      throw new AppError(
        error instanceof AppError ? error.status : 500,
        error instanceof AppError ? error.message : '角色操作未能确认，请手动查询原操作',
        (parsed.action === 'save' || parsed.action === 'remove') && !known,
      );
    }
  }
}
