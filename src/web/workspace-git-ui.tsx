import { useEffect, useRef, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { GitWorkspacePanel } from './git-workspace-ui';
import { GIT_WORKTREE_FEATURE, SECURE_GIT_OPERATIONS_FEATURE } from '../git-protocol';
import type { WorkspaceController, WorkspaceClientState } from './workspace-controller';

export function WorkspaceGitUI({
  controller,
  state,
  busy,
  run,
}: {
  controller: WorkspaceController;
  state: WorkspaceClientState;
  busy: boolean;
  run(task: () => Promise<unknown>): boolean;
}) {
  const [, render] = useState(0);
  const panel = useRef<Awaited<ReturnType<WorkspaceController['openGit']>> | null>(null);
  const close = () => {
    panel.current?.close();
    panel.current = null;
    render((n) => n + 1);
  };
  useEffect(() => close, [controller, controller.contextRevision]);
  const reason = state.offline
    ? '执行电脑离线，原 Git 记录保留；连接后请手动读取。'
    : !state.project?.runtime.features?.includes(GIT_WORKTREE_FEATURE)
      ? '此执行电脑尚未提供 Git 工作目录能力。'
      : '';
  return (
    <>
      <button
        type="button"
        aria-label="Git 与工作目录"
        title="Git 与工作目录"
        disabled={busy}
        onClick={() =>
          run(async () => {
            panel.current?.close();
            panel.current = await controller.openGit(() => render((n) => n + 1));
            render((n) => n + 1);
            if (!reason) await panel.current.refresh();
          })
        }
      >
        <GitBranch size={16} />
      </button>
      {panel.current && (
        <GitWorkspacePanel
          controller={panel.current.controller}
          newSession={!state.session?.history.length}
          reason={reason}
          navigationDisabled={busy}
          confirmationKey={JSON.stringify([
            panel.current.controller.state?.execution,
            panel.current.controller.state?.repository.version,
          ])}
          onClose={close}
          onRefresh={() => run(() => panel.current!.refresh())}
          onRetry={() => run(() => panel.current!.retry())}
          onInspect={
            state.project?.runtime.features?.includes(SECURE_GIT_OPERATIONS_FEATURE)
              ? () => run(() => panel.current!.inspect())
              : undefined
          }
          onAbandon={
            state.project?.runtime.features?.includes(SECURE_GIT_OPERATIONS_FEATURE)
              ? () => run(() => panel.current!.abandon())
              : undefined
          }
          onPrepare={(branch, oid, name) => run(() => panel.current!.prepare(branch, oid, name))}
          onRemove={() => run(() => panel.current!.remove())}
          onDetach={() => run(() => panel.current!.detach())}
          onNewDraft={() =>
            run(async () => {
              const id = await controller.createSession(state.session!.meta.agentConfigId);
              await controller.openSession(id);
            })
          }
        />
      )}
    </>
  );
}
