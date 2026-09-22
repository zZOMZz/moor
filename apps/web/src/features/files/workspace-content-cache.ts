import {
  desktopWorkspaceTargetSchema,
  type DesktopWorkspaceSource,
} from '@moor/client/workspace-protocol';
import { ScopedProjectContentCache } from './scoped-project-content-cache';
import type { StorageBackend } from '../../platform/indexed-storage';

export const workspaceContentTargetSchema = desktopWorkspaceTargetSchema.required({
  sessionId: true,
});
export function workspaceContentCache(source: DesktopWorkspaceSource, backend: StorageBackend) {
  return new ScopedProjectContentCache(
    {
      namespace: 'moor-workspace-project-content-v1',
      parseTarget: (input) => workspaceContentTargetSchema.parse(input),
      authority: ({ serverKey, owner, deviceId }) => ({ source, serverKey, owner, deviceId }),
    },
    backend,
  );
}
