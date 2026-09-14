import {
  desktopWorkspaceTargetSchema,
  type DesktopWorkspaceSource,
} from '../desktop/workspace-protocol';
import { ScopedProjectContentCache } from './scoped-project-content-cache';
import type { SecureStorageBackend } from './secure-store';

export const workspaceContentTargetSchema = desktopWorkspaceTargetSchema.required({
  sessionId: true,
});
export function workspaceContentCache(
  source: DesktopWorkspaceSource,
  backend: SecureStorageBackend,
) {
  return new ScopedProjectContentCache(
    {
      namespace: 'moor-workspace-project-content-v1',
      parseTarget: (input) => workspaceContentTargetSchema.parse(input),
      authority: ({ serverKey, owner, deviceId }) => ({ source, serverKey, owner, deviceId }),
    },
    backend,
  );
}
