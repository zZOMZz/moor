import {
  forkStoredSchema,
  validateForkReceipt,
  matchesResourceCleanup,
  type ForkSaved,
} from './session-fork';
import type { GitTarget } from './git-workspace';
import { workspaceFeatureTarget } from './workspace-mcp';
import { productCanonicalJson as canonical } from '../security/encrypted-product-catalog';

export function workspaceForkPending(value?: ForkSaved) {
  return value?.operation && (!value.receipt || value.receipt.phase === 'unknown')
    ? value.operation
    : undefined;
}
export function validateWorkspaceFork(input: unknown, target: GitTarget) {
  const value = forkStoredSchema.parse(input),
    expected = workspaceFeatureTarget(target);
  if (canonical(value.target) !== canonical(expected))
    throw Error('Fork 记录与原账号、电脑和项目不匹配。');
  for (const operation of [value.operation, ...value.resources.map((item) => item.operation)]) {
    if (
      operation &&
      (canonical(operation.target) !== canonical(expected) ||
        operation.request.workspaceId !== target.workspaceId ||
        operation.request.localProjectId !== target.localProjectId ||
        operation.request.sessionId !== target.sessionId)
    )
      throw Error('Fork 原请求不属于当前会话。');
  }
  if (
    value.options &&
    (value.options.workspaceId !== target.workspaceId ||
      value.options.localProjectId !== target.localProjectId ||
      value.options.sessionId !== target.sessionId)
  )
    throw Error('Fork 选项不属于原会话。');
  if (value.receipt) {
    if (!value.operation) throw Error('Fork 回执缺少原请求。');
    validateForkReceipt(value.receipt, value.operation);
  }
  for (const resource of value.resources) {
    validateForkReceipt(resource.receipt, resource.operation);
    if (
      !['rejected', 'abandoned'].includes(resource.receipt.phase) ||
      resource.receipt.execution?.mode !== 'worktree'
    )
      throw Error('Fork 资源记录无效。');
  }
  if (value.cleanup && !matchesResourceCleanup(value.receipt, value.cleanup))
    throw Error('Fork 清理记录不属于原工作目录。');
  return value;
}
