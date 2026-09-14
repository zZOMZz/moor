import { z } from 'zod';
import type { GitTarget } from './git-workspace';
import { rolesStoredSchema, roleAppliedSchema } from './roles';
import { workspaceFeatureTarget } from './workspace-mcp';
import { productCanonicalJson as canonical } from '../security/encrypted-product-catalog';

export type WorkspaceRoles = z.infer<typeof rolesStoredSchema>;
export function validateWorkspaceRoles(input: unknown, target: GitTarget) {
  const value = rolesStoredSchema.parse(input);
  if (
    canonical(value.target) !== canonical(workspaceFeatureTarget(target)) ||
    (value.ending && !value.pending) ||
    (value.pending &&
      (value.pending.workspaceId !== target.workspaceId ||
        value.pending.localProjectId !== target.localProjectId ||
        value.pending.sessionId !== target.sessionId))
  )
    throw Error('角色原操作与原账号、电脑和会话不匹配。');
  return value;
}
export function validateWorkspaceRoleApplied(input: unknown, target: GitTarget) {
  const value = roleAppliedSchema.parse(input);
  if (
    canonical(value.target) !== canonical(workspaceFeatureTarget(target)) ||
    new Set(value.applied.map((item) => JSON.stringify([item.roleId, item.revision]))).size !==
      value.applied.length
  )
    throw Error('角色应用记录与原账号、电脑和会话不匹配。');
  return value;
}
