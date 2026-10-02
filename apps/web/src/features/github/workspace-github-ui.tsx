import type { WorkspaceClientState, WorkspaceGraph } from '@moor/client/features/workspace/compose';
import { GitPullRequest } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { bindWorkspacePort, type WorkspacePort } from '../../app/workspace-port';
import { GithubSessionPanel } from './github-session-ui';
const workspaceGithubUiPortSelection = {
  view: ['contextRevision'],
  github: ['openGithub'],
} as const;
export type WorkspaceGithubUiPort = WorkspacePort<typeof workspaceGithubUiPortSelection>;
export const bindWorkspaceGithubUiPort = (graph: WorkspaceGithubUiPort) =>
  bindWorkspacePort(graph, workspaceGithubUiPortSelection);

export function WorkspaceGithubUI({
  controller,
  state,
  busy,
  run,
}: {
  controller: WorkspaceGithubUiPort;
  state: WorkspaceClientState;
  busy: boolean;
  run(task: () => Promise<unknown>): boolean;
}) {
  const [, render] = useState(0);
  type Panel = Awaited<ReturnType<WorkspaceGraph['github']['openGithub']>>;
  const panel = useRef<Panel | null>(null);
  useEffect(
    () => () => {
      panel.current?.dispose();
      panel.current = null;
    },
    [controller, controller.view.contextRevision],
  );
  const value = panel.current?.state;
  return (
    <>
      <button
        type="button"
        aria-label="GitHub"
        title="GitHub 仓库与提交"
        disabled={busy}
        onClick={() =>
          run(async () => {
            panel.current?.dispose();
            panel.current = null;
            panel.current = await controller.github.openGithub(() => render((n) => n + 1));
            render((n) => n + 1);
          })
        }
      >
        <GitPullRequest size={16} />
        <span>GitHub · 提交与 PR</span>
      </button>
      {value && panel.current && (
        <GithubSessionPanel
          state={value}
          controller={panel.current}
          location={state.scope?.target.machineId ?? ''}
        />
      )}
    </>
  );
}
