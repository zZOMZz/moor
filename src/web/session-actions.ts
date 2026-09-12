import { z } from 'zod';
import { id, sessionActionSchema, type SessionAction } from '../protocol';
import { ApiError } from './api';

export const pendingSessionActionSchema = z
  .object({
    owner: z.string().min(1),
    deviceId: id,
    catalogWorkspaceId: id,
    replicaId: id,
    request: sessionActionSchema,
  })
  .strict();
export type PendingSessionAction = z.infer<typeof pendingSessionActionSchema>;
export type SessionActionScope = {
  owner: string;
  deviceId: string;
  workspaceId: string;
  localProjectId: string;
  sessionId: string;
};
export function sessionActionKey(scope: SessionActionScope) {
  return [
    scope.owner,
    scope.deviceId,
    scope.workspaceId,
    scope.localProjectId,
    scope.sessionId,
    'session-action',
  ].join('/');
}
export function actionScope(operation: PendingSessionAction): SessionActionScope {
  return { owner: operation.owner, deviceId: operation.deviceId, ...operation.request };
}
export function routeSessionAction(
  operation: PendingSessionAction,
  target: SessionActionScope & { catalogWorkspaceId: string; replicaId: string },
): PendingSessionAction {
  if (sessionActionKey(actionScope(operation)) !== sessionActionKey(target))
    throw new Error('会话操作的执行目标已改变，不能重试到其他项目或电脑。');
  // Organization can change while the execution identity remains the same. Only
  // an explicit retry may use its freshly verified mapping; the request is frozen.
  return {
    ...operation,
    catalogWorkspaceId: target.catalogWorkspaceId,
    replicaId: target.replicaId,
  };
}
const receiptSchema = z.object({
  accepted: z.literal(true),
  delivered: z.literal(true),
  operationId: id,
  meta: z.object({ id, metadataRevision: z.number().int().nonnegative() }).passthrough(),
});

// Persist the original target and request before transmission. Restoring a pending
// operation only reads it; the caller must request each delivery attempt manually.
export async function deliverSessionAction(
  operation: PendingSessionAction,
  dependencies: {
    write: (key: string, value: PendingSessionAction | undefined) => Promise<void>;
    request: (path: string, action: SessionAction) => Promise<unknown>;
    onPending: (operation: PendingSessionAction | undefined) => void;
  },
) {
  const original = pendingSessionActionSchema.parse(operation);
  const key = sessionActionKey(actionScope(original));
  await dependencies.write(key, original);
  dependencies.onPending(original);
  let response: unknown;
  try {
    response = await dependencies.request(
      `/api/workspaces/${original.catalogWorkspaceId}/replicas/${original.replicaId}/session-actions`,
      original.request,
    );
  } catch (error) {
    if (error instanceof ApiError && error.rejected) {
      await dependencies.write(key, undefined);
      dependencies.onPending(undefined);
    }
    throw error;
  }
  const receipt = receiptSchema.safeParse(response);
  if (
    !receipt.success ||
    receipt.data.operationId !== original.request.operationId ||
    receipt.data.meta.id !== original.request.sessionId
  )
    throw new Error('会话操作尚未获得有效的主机确认，请手动重试确认。');
  await dependencies.write(key, undefined);
  dependencies.onPending(undefined);
  return receipt.data.meta;
}
