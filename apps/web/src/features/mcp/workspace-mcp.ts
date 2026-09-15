import { gitTargetSchema, type GitTarget } from '../git/git-workspace';
import { mcpStoredSchema } from './mcp';
import { mcpServerIdsSchema } from '@moor/protocol/mcp-protocol';
import { productCanonicalJson as canonical } from '@moor/client/encrypted-product';

export function workspaceFeatureTarget(target: GitTarget): GitTarget {
  const {
    owner,
    deviceId,
    userId,
    machineId,
    workspaceId,
    localProjectId,
    catalogWorkspaceId,
    replicaId,
    sessionId,
  } = target;
  return gitTargetSchema.parse({
    owner,
    deviceId,
    userId,
    machineId,
    workspaceId,
    localProjectId,
    catalogWorkspaceId,
    replicaId,
    sessionId,
  });
}

export function validateWorkspaceMcp(input: unknown, target: GitTarget) {
  const value = mcpStoredSchema.parse(input);
  if (canonical(value.target) !== canonical(workspaceFeatureTarget(target)))
    throw Error('MCP 草稿与原账号、电脑和项目不匹配。');
  for (const review of [value.review, value.delivery?.review])
    if (review) mcpServerIdsSchema.parse(review.servers.map((server) => server.id));
  if (
    value.review &&
    value.delivery?.review.reviewId === value.review.reviewId &&
    canonical(value.review) !== canonical(value.delivery.review)
  )
    throw Error('同一 MCP 审阅编号的内容已改变。');
  return value;
}
