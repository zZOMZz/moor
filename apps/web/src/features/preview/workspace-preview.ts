import type { GitTarget } from '../git/git-workspace';
import { productCanonicalJson as canonical } from '@moor/client/encrypted-product';
import { workspaceFeatureTarget } from '../mcp/workspace-mcp';
import {
  previewAnnotationsStoredSchema,
  previewStoredSchema,
  snapshotVersion,
} from './project-preview';

export function validateWorkspacePreview(input: unknown, target: GitTarget) {
  const value = previewStoredSchema.parse(input);
  if (
    canonical(value.target) !== canonical(workspaceFeatureTarget(target)) ||
    [value.open, value.pending, value.receipt].some(
      (item) =>
        item &&
        (item.workspaceId !== target.workspaceId ||
          item.localProjectId !== target.localProjectId ||
          item.sessionId !== target.sessionId),
    ) ||
    (value.pending && (!value.open || value.pending.clientId !== value.open.clientId)) ||
    (value.open && value.receipt && value.open.clientId !== value.receipt.clientId) ||
    value.receipt?.frame
  )
    throw Error('预览记录与原账号、电脑和会话不匹配。');
  return value;
}

export async function validateWorkspaceAnnotations(input: unknown, target: GitTarget) {
  const value = previewAnnotationsStoredSchema.parse(input);
  if (canonical(value.target) !== canonical(workspaceFeatureTarget(target)))
    throw Error('标注草稿与原账号、电脑和会话不匹配。');
  for (const item of value.annotations)
    if ((await snapshotVersion(item.snapshot)) !== item.version)
      throw Error('标注内容与保存的版本不匹配。');
  return value;
}
