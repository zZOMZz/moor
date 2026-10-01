import { attentionContinueInput } from '@moor/protocol/attention';
import { attentionDetailSchema, attentionPageSchema } from '@moor/protocol/attention-response';
import { productCanonicalJson as canonical } from '@moor/protocol/canonical-json';
import { id } from '@moor/protocol/protocol';
import type { WorkspaceProjectTarget } from '@moor/protocol/workspace-client-protocol';
import { z } from 'zod';
import {
  attentionDraftSchema,
  attentionItemKey,
  attentionPendingKey,
  attentionRouteSchema,
  attentionScopeKey,
  pendingAttentionSchema,
  type AttentionRoute,
  type PendingAttention,
} from './attention';

export const workspaceAttentionBucketSchema = z
  .object({
    route: attentionRouteSchema,
    entries: z.record(z.unknown()),
  })
  .strict()
  .refine((value) => Object.keys(value.entries).length <= 2000);
export type WorkspaceAttentionBucket = z.infer<typeof workspaceAttentionBucketSchema>;
export function workspaceAttentionKey(route: AttentionRoute, key: string) {
  const scope = attentionScopeKey(route);
  if (key === scope + '/page/pending' || key === scope + '/page/processed')
    return { kind: 'page' as const };
  const end = key.lastIndexOf(']/');
  if (end < 0 || key.length > 16000) throw Error('待办缓存键无效。');
  const [originalScope, sessionId, itemId] = z
    .tuple([z.string(), id, z.string().min(1).max(1024)])
    .parse(JSON.parse(key.slice(0, end + 1)));
  if (originalScope !== scope) throw Error('待办缓存不属于原账号和项目。');
  const base = attentionItemKey(route, sessionId, itemId);
  if (key === base + '/detail') return { kind: 'detail' as const, sessionId, itemId };
  if (key === base + '/draft') return { kind: 'draft' as const, sessionId, itemId };
  if (key === attentionPendingKey({ route, sessionId, itemId }))
    return { kind: 'pending' as const, seen: false, sessionId, itemId };
  if (
    key ===
    attentionPendingKey({
      route,
      sessionId,
      itemId,
      operation: { kind: 'seen', body: { operationId: 'key', eventRevision: 0 } },
    })
  )
    return { kind: 'pending' as const, seen: true, sessionId, itemId };
  throw Error('不支持的待办缓存键。');
}
export function validateWorkspaceAttentionEntry(
  route: AttentionRoute,
  key: string,
  input: unknown,
) {
  const kind = workspaceAttentionKey(route, key);
  if (input === undefined) return undefined;
  if (kind.kind === 'page') {
    const value = z
      .object({ page: attentionPageSchema, syncedAt: z.number().finite() })
      .strict()
      .parse(input);
    for (const group of value.page.sessions)
      for (const item of group.items)
        if (item.localProjectId !== route.localProjectId || item.sessionId !== group.sessionId)
          throw Error('待办缓存分组范围不匹配。');
    return value;
  }
  if (kind.kind === 'draft') return attentionDraftSchema.parse(input);
  if (kind.kind === 'detail') {
    const value = attentionDetailSchema.parse(input);
    if (
      value.item.sessionId !== kind.sessionId ||
      value.item.itemId !== kind.itemId ||
      value.item.localProjectId !== route.localProjectId
    )
      throw Error('待办详情缓存不属于原事项。');
    return value;
  }
  const value = pendingAttentionSchema.parse(input);
  if (
    canonical(value.route) !== canonical(route) ||
    value.sessionId !== kind.sessionId ||
    value.itemId !== kind.itemId ||
    (value.operation.kind === 'seen') !== kind.seen ||
    (value.operation.kind === 'continue' &&
      (attentionContinueInput(value.operation.body).workspaceId !== route.runtimeWorkspaceId ||
        attentionContinueInput(value.operation.body).sessionId !== value.sessionId))
  )
    throw Error('待办原操作范围不匹配。');
  if (
    value.operation.kind === 'continue' &&
    'turn' in value.operation.body &&
    (value.operation.body.turn.machineId !== route.machineId ||
      value.operation.body.turn.localProjectId !== route.localProjectId)
  )
    throw Error('待办原指令不属于原执行身份。');
  return value;
}
export function validateWorkspaceAttentionBucket(
  input: unknown,
  target: Omit<WorkspaceProjectTarget, 'sessionId'>,
) {
  const value = workspaceAttentionBucketSchema.parse(input),
    route = value.route;
  if (
    route.actor.accountId !== target.owner ||
    route.executionDeviceId !== target.deviceId ||
    route.machineId !== target.machineId ||
    route.runtimeWorkspaceId !== target.workspaceId ||
    route.localProjectId !== target.localProjectId ||
    route.catalogWorkspaceId !== target.catalogWorkspaceId ||
    route.projectId !== target.catalogProjectId ||
    route.replicaId !== target.replicaId
  )
    throw Error('待办存储与原账号、电脑或项目不匹配。');
  const origin = new URL(route.origin);
  if (origin.origin !== route.origin || origin.username || origin.password)
    throw Error('待办来源无效。');
  for (const [key, entry] of Object.entries(value.entries))
    validateWorkspaceAttentionEntry(route, key, entry);
  return value;
}
export function workspaceAttentionPending(
  buckets: Record<string, WorkspaceAttentionBucket> | undefined,
  sessionId: string,
) {
  return Object.values(buckets ?? {})
    .flatMap((bucket) =>
      Object.entries(bucket.entries).flatMap(([key, value]) =>
        workspaceAttentionKey(bucket.route, key).kind === 'pending'
          ? [pendingAttentionSchema.parse(value)]
          : [],
      ),
    )
    .filter((value): value is PendingAttention => value.sessionId === sessionId);
}
