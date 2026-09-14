import { githubStoredSchema } from './github';
import { githubWriteStoredSchema } from './github-write';
import type { GitTarget } from './git-workspace';
import { workspaceFeatureTarget } from './workspace-mcp';
import { productCanonicalJson as canonical } from '../security/encrypted-product-catalog';

function validateTarget(
  value: {
    target: GitTarget;
    pending?: {
      target: GitTarget;
      request: { workspaceId: string; localProjectId: string; sessionId: string };
    };
  },
  target: GitTarget,
) {
  if (
    canonical(value.target) !== canonical(workspaceFeatureTarget(target)) ||
    (value.pending &&
      (canonical(value.pending.target) !== canonical(value.target) ||
        value.pending.request.workspaceId !== target.workspaceId ||
        value.pending.request.localProjectId !== target.localProjectId ||
        value.pending.request.sessionId !== target.sessionId))
  )
    throw Error('GitHub 记录与原账号、电脑和会话不匹配。');
}
export function validateWorkspaceGithub(input: unknown, target: GitTarget) {
  const value = githubStoredSchema.parse(input);
  validateTarget(value, target);
  return value;
}
export function validateWorkspaceGithubWrite(input: unknown, target: GitTarget) {
  const value = githubWriteStoredSchema.parse(input);
  validateTarget(value, target);
  if (
    Object.entries(value.drafts).some(([id, draft]) => id !== draft.id) ||
    (value.receipt &&
      (value.receipt.workspaceId !== target.workspaceId ||
        value.receipt.localProjectId !== target.localProjectId ||
        value.receipt.sessionId !== target.sessionId))
  )
    throw Error('GitHub 草稿或回执不属于原会话。');
  return value;
}
