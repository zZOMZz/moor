import type { Workspace, WorkspaceClientState } from '@moor/client/features/workspace/compose';
import { GitPullRequest } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { GithubSessionPanel } from './github-session-ui';

export function WorkspaceGithubUI({
  controller,
  state,
  busy,
  run,
}: {
  controller: Workspace;
  state: WorkspaceClientState;
  busy: boolean;
  run(task: () => Promise<unknown>): boolean;
}) {
  const [, render] = useState(0);
  type Panel = Awaited<ReturnType<Workspace['openGithub']>>;
  const panel = useRef<Panel | null>(null);
  useEffect(
    () => () => {
      panel.current?.dispose();
      panel.current = null;
    },
    [controller, controller.contextRevision],
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
            panel.current = await controller.openGithub(() => render((n) => n + 1));
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
