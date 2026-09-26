import { z } from 'zod';
import { id, sessionActionSchema } from '@moor/protocol/protocol';

export const pendingSessionActionSchema = z
  .object({
    owner: z.string().min(1),
    deviceId: id,
    catalogWorkspaceId: id,
    replicaId: id,
    request: sessionActionSchema,
  })
  .strict();
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
