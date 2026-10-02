import type { HostCommand } from '@moor/protocol/host-command';
import type { WorkspaceRequest } from '@moor/protocol/workspace-client-protocol';
import type { WorkspaceScope } from '../../operations/workspace/compose';
import type { WorkspaceContextService } from './context';
import type { Context, WorkspaceClientState } from './model';

type ScopedCommand<Method extends HostCommand['method']> = Extract<HostCommand, { method: Method }>;
export type FeatureContext<
  Keys extends keyof WorkspaceContextService,
  Fields extends keyof WorkspaceClientState,
  Methods extends HostCommand['method'] = never,
  Actions extends WorkspaceRequest['action'] = never,
> = Omit<Pick<WorkspaceContextService, Keys>, 'value' | 'execute' | 'command' | 'request'> &
  ('value' extends Keys ? { value: Pick<WorkspaceClientState, Fields> } : {}) &
  ('execute' extends Keys
    ? { execute(context: Context, command: ScopedCommand<Methods>): Promise<unknown> }
    : {}) &
  ('command' extends Keys
    ? {
        command<M extends Methods>(
          scope: WorkspaceScope,
          method: M,
          params: unknown,
        ): ScopedCommand<M>;
      }
    : {}) &
  ('request' extends Keys
    ? {
        request(
          value: Extract<WorkspaceRequest, { action: Actions }>,
          current: () => void,
        ): Promise<unknown>;
      }
    : {});
