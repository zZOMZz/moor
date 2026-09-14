import { useEffect, useRef, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { TasksPanel } from './tasks-ui';
import { SESSION_TASKS_FEATURE, type TaskPlan } from '../task-protocol';
import type { WorkspaceController, WorkspaceClientState } from './workspace-controller';

export function WorkspaceTasksUI({
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
  type Panel = Awaited<ReturnType<WorkspaceController['openTasks']>>;
  const panel = useRef<Panel | null>(null);
  const close = () => {
    panel.current?.close();
    panel.current = null;
    render((n) => n + 1);
  };
  useEffect(
    () => () => {
      close();
    },
    [controller, controller.contextRevision],
  );
  const reason = state.offline
    ? '执行电脑离线，任务草稿保留；重连不会执行。'
    : !state.project?.runtime.features?.includes(SESSION_TASKS_FEATURE)
      ? '此执行电脑尚未支持协作任务。'
      : '';
  const draftReason = state.session?.meta.taskOrigin
    ? '子任务会话不能再次授权协作任务。'
    : state.session?.meta.isArchived
      ? '请先恢复会话。'
      : state.ledger?.operations.some(
            (entry) =>
              entry.status === 'pending' && entry.original.value.sessionId === state.sessionId,
          )
        ? '请先确认原父指令，再启用下一份任务计划。'
        : '';
  const saved = state.ledger?.tasks?.[state.sessionId ?? ''],
    review = saved?.delivery?.review ?? saved?.enabled;
  const act = (task: (value: Panel) => Promise<unknown>) => {
    const value = panel.current;
    if (value) run(() => task(value));
  };
  return (
    <>
      <button
        type="button"
        aria-label="协作任务"
        title="协作任务"
        disabled={busy}
        onClick={() =>
          run(async () => {
            close();
            panel.current = await controller.openTasks(() => render((n) => n + 1));
            render((n) => n + 1);
          })
        }
      >
        <ListChecks size={16} />
        {review?.plan.tasks.length || ''}
      </button>
      {review && (
        <small className="workspace-task-status" role="status">
          {review.plan.tasks.length} 项协作任务 ·{' '}
          {saved?.delivery ? '原父指令待确认' : '已审查，随下次指令授权'}
        </small>
      )}
      {panel.current && (
        <TasksPanel
          controller={panel.current.controller}
          reason={reason}
          draftReason={draftReason}
          sending={busy}
          existing
          agents={state.project?.runtime.agents ?? []}
          branches={panel.current.repository?.branches ?? []}
          branchesPartial={!!panel.current.repository?.partial}
          onClose={close}
          onEdit={(draft) => act((value) => value.controller.edit(draft))}
          onReadBranches={() => act((value) => value.readBranches())}
          onRefreshAgent={(id) => act((value) => value.refreshAgent(id))}
          onReview={() =>
            new Promise<TaskPlan>((resolve, reject) => {
              const value = panel.current;
              if (!value) {
                reject(Error('任务面板已关闭。'));
                return;
              }
              if (
                !run(async () => {
                  try {
                    resolve(await value.review());
                  } catch (error) {
                    reject(error);
                  }
                })
              )
                reject(Error('另一项操作尚未结束。'));
            })
          }
          onEnable={(plan) => act((value) => value.enable(plan))}
          onDisable={() => act((value) => value.controller.disable())}
          onRefresh={() => act((value) => value.controller.refresh())}
          onAction={(action, grant, operation, cleanup) =>
            act((value) => value.action(action, grant, operation, cleanup))
          }
          onRetry={() => act((value) => value.action('retry'))}
          onOpenSession={(id) => act((value) => value.openSession(id))}
        />
      )}
    </>
  );
}
