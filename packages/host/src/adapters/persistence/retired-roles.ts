import type { DatabaseSync } from 'node:sqlite';
import type { RolesActionRequest } from '@moor/protocol/role-protocol';
import type { AttachmentScope } from '../../features/attachments/model';
import type { RetiredRolePersistence } from '../../features/persistence/retired-roles';
export class SqliteRetiredRoles implements RetiredRolePersistence {
  constructor(private readonly database: DatabaseSync) {}
  catalog(scope: AttachmentScope) {
    if (
      !this.database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_role_catalog'")
        .get()
    )
      return;
    const row = this.database
      .prepare('SELECT revision,roles FROM project_role_catalog WHERE scope=?')
      .get(
        JSON.stringify([scope.workspaceId, scope.userId, scope.machineId, scope.localProjectId]),
      );
    return row ? { revision: Number(row.revision), roles: String(row.roles) } : undefined;
  }
  original(_scope: AttachmentScope, request: Extract<RolesActionRequest, { operationId: string }>) {
    const row = this.database
      .prepare('SELECT fingerprint,phase,result FROM operation WHERE id=?')
      .get(request.operationId);
    return row
      ? {
          fingerprint: String(row.fingerprint),
          phase: String(row.phase),
          result: String(row.result),
        }
      : undefined;
  }
}
