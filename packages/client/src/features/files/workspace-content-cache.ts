import type { StorageBackend } from '@moor/client/operations/storage';
import {
  workspaceProjectTargetSchema,
  type WorkspaceSource,
} from '@moor/protocol/workspace-client-protocol';
import { ScopedProjectContentCache } from './scoped-project-content-cache';

export const workspaceContentTargetSchema = workspaceProjectTargetSchema.required({
  sessionId: true,
});
export function workspaceContentCache(source: WorkspaceSource, backend: StorageBackend) {
  return new ScopedProjectContentCache(
    {
      namespace: 'moor-workspace-project-content-v1',
      parseTarget: (input) => workspaceContentTargetSchema.parse(input),
      authority: ({ serverKey, owner, deviceId }) => ({ source, serverKey, owner, deviceId }),
    },
    backend,
  );
}
