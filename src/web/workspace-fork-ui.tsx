import { useEffect, useRef, useState, useImperativeHandle, type Ref } from 'react';
import { GitFork } from 'lucide-react';
import { SessionForkPanel } from './session-fork-ui';
import { GitWorkspacePanel } from './git-workspace-ui';
import { SESSION_FORK_FEATURE, SECURE_FORK_OPERATIONS_FEATURE } from '../fork-protocol';
import { GIT_WORKTREE_FEATURE, SECURE_GIT_OPERATIONS_FEATURE } from '../git-protocol';
import type { WorkspaceController, WorkspaceClientState } from './workspace-controller';

export type WorkspaceForkHandle = { open(turnId?: string): boolean };

export function WorkspaceForkUI({
  controller,
  state,
  busy,
  run,
  controlRef,
}: {
  controller: WorkspaceController;
  controlRef?: Ref<WorkspaceForkHandle>;
  state: WorkspaceClientState;
  busy: boolean;
  run(task: () => Promise<unknown>): boolean;
}) {
  const [, render] = useState(0),
    [consent, setConsent] = useState('');
  const panel = useRef<Awaited<ReturnType<WorkspaceController['openFork']>> | null>(null);
  const resource = useRef<{
    id: string;
    git: Awaited<ReturnType<WorkspaceController['openGit']>>;
  } | null>(null);
  const close = () => {
    panel.current?.close();
    resource.current?.git.close();
    panel.current = null;
    resource.current = null;
    setConsent('');
    render((n) => n + 1);
  };
  useEffect(() => close, [controller, controller.contextRevision]);
  const reason = state.offline
    ? '执行电脑离线，原 Fork 记录保留；连接后请手动读取。'
    : !state.project?.runtime.features?.includes(SESSION_FORK_FEATURE)
      ? '此执行电脑尚未提供原生 Fork 能力。'
      : '';
  const original = JSON.stringify(panel.current?.controller.pending);
  const gitReason = state.offline
    ? '执行电脑离线，请连接后手动读取工作目录。'
    : !state.project?.runtime.features?.includes(GIT_WORKTREE_FEATURE)
      ? '此执行电脑尚未提供 Git 工作目录能力。'
      : '';
  const canInspectGit = state.project?.runtime.features?.includes(SECURE_GIT_OPERATIONS_FEATURE);
  const back = () =>
    run(async () => {
      const value = resource.current!;
      try {
        if (
          value.git.controller.source === 'host' &&
          value.git.controller.state?.execution.status === 'removed'
        )
          await panel.current!.confirmCleanup(value.id);
      } finally {
        value.git.close();
        resource.current = null;
        render((n) => n + 1);
      }
    });
  const open = (turnId?: string) =>
    run(async () => {
      close();
      panel.current = await controller.openFork(() => render((n) => n + 1));
      render((n) => n + 1);
      if (!reason) await panel.current.refresh(turnId);
    });
  useImperativeHandle(controlRef, () => ({ open }));
  return (
    <>
      <button
        type="button"
        aria-label="创建会话副本"
        title="创建会话副本"
        disabled={busy}
        onClick={() => open()}
      >
        <GitFork size={16} />
      </button>
      {panel.current && !resource.current && (
        <SessionForkPanel
          controller={panel.current.controller}
          sourceTitle={state.session?.meta.title ?? '未命名会话'}
          reason={reason}
          working={busy}
          onClose={close}
          onRefresh={(turnId) => run(() => panel.current!.refresh(turnId))}
          onCreate={(cutoff, directory) => run(() => panel.current!.create(cutoff, directory))}
          onRetry={() => run(() => panel.current!.retry())}
          onOpenChild={() =>
            run(() => controller.openSession(panel.current!.controller.receipt!.childSessionId))
          }
          onOpenWorkspace={(id) =>
            run(async () => {
              const git = await controller.openGit(() => render((n) => n + 1), id);
              resource.current = { id, git };
              render((n) => n + 1);
              if (!gitReason) await git.refresh();
            })
          }
        >
          {panel.current.controller.pending &&
            state.project?.runtime.features?.includes(SECURE_FORK_OPERATIONS_FEATURE) && (
              <section>
                <button
                  disabled={busy || !!reason}
                  onClick={() => run(() => panel.current!.inspect())}
                >
                  核查原 Fork
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={consent === original}
                    disabled={busy}
                    onChange={(event) => setConsent(event.target.checked ? original : '')}
                  />
                  我确认封存原请求，已创建的副本或目录不会撤销
                </label>
                <button
                  disabled={busy || !!reason || consent !== original}
                  onClick={() => run(() => panel.current!.abandon())}
                >
                  封存原 Fork
                </button>
              </section>
            )}
        </SessionForkPanel>
      )}
      {resource.current && (
        <GitWorkspacePanel
          controller={resource.current.git.controller}
          newSession={false}
          reason={gitReason}
          navigationDisabled={busy}
          confirmationKey={JSON.stringify([
            resource.current.id,
            resource.current.git.controller.state?.execution,
            resource.current.git.controller.state?.repository.version,
          ])}
          onClose={back}
          onRefresh={() => run(() => resource.current!.git.refresh())}
          onRemove={() => run(() => resource.current!.git.remove())}
          onDetach={() => run(() => resource.current!.git.detach())}
          onRetry={() => run(() => resource.current!.git.retry())}
          onInspect={canInspectGit ? () => run(() => resource.current!.git.inspect()) : undefined}
          onAbandon={canInspectGit ? () => run(() => resource.current!.git.abandon()) : undefined}
          onPrepare={() => {}}
          onNewDraft={() => {}}
        />
      )}
    </>
  );
}
