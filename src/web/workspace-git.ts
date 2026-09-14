import { gitStoredSchema, type GitTarget } from './git-workspace';
import { workspaceFeatureTarget } from './workspace-mcp';
import { productCanonicalJson as canonical } from '../security/encrypted-product-catalog';

export function validateWorkspaceGit(input: unknown, target: GitTarget) {
  const value = gitStoredSchema.parse(input);
  if (
    canonical(value.target) !== canonical(workspaceFeatureTarget(target)) ||
    (value.pending && canonical(value.pending.target) !== canonical(value.target))
  )
    throw Error('Git 记录与原账号、电脑和项目不匹配。');
  for (const record of [value.state, value.receipt, value.pending?.request])
    if (
      record &&
      (record.workspaceId !== target.workspaceId ||
        record.localProjectId !== target.localProjectId ||
        record.sessionId !== target.sessionId)
    )
      throw Error('Git 状态或原操作不属于当前会话。');
  return value;
}
