import type { GitTarget } from './git-workspace';
import { tasksStoredSchema } from './tasks';
import { taskPlanSchema } from '../task-protocol';
import { workspaceFeatureTarget } from './workspace-mcp';
import { productCanonicalJson as canonical } from '../security/encrypted-product-catalog';
export function validateWorkspaceTasks(input: unknown, target: GitTarget) {
  const value = tasksStoredSchema.parse(input);
  if (
    canonical(value.target) !== canonical(workspaceFeatureTarget(target)) ||
    (value.pending &&
      (value.pending.workspaceId !== target.workspaceId ||
        value.pending.localProjectId !== target.localProjectId ||
        value.pending.sessionId !== target.sessionId))
  )
    throw Error('任务草稿与原账号、电脑和会话不匹配。');
  if (
    value.enabled &&
    canonical(value.enabled.plan) !== canonical(taskPlanSchema.parse(value.draft))
  )
    throw Error('任务计划与已审阅草稿不匹配。');
  if (
    value.enabled &&
    value.delivery?.review.reviewId === value.enabled.reviewId &&
    canonical(value.enabled) !== canonical(value.delivery.review)
  )
    throw Error('同一任务审阅编号的内容已改变。');
  return value;
}
