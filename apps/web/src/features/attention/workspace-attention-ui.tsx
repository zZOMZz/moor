import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Inbox } from 'lucide-react';
import { AttentionWorkbench } from './attention-ui';
import type { WorkspaceController, WorkspaceClientState } from '../workspace/workspace-controller';

export function WorkspaceAttentionUI({
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
  type Panel = Awaited<ReturnType<WorkspaceController['openAttention']>>;
  const panel = useRef<Panel | null>(null),
    [, render] = useState(0);
  const close = () => {
    panel.current?.close();
    panel.current = null;
    render((n) => n + 1);
  };
  useEffect(() => {
    // A context change cleans up the old handle after render. Refresh the view
    // as well so the closed workbench cannot remain visible over another project.
    render((n) => n + 1);
    return () => {
      panel.current?.close();
      panel.current = null;
    };
  }, [controller, controller.contextRevision]);
  useEffect(() => {
    const value = panel.current,
      context = value?.controller.state.context;
    if (value && context) {
      value.controller.configure({ ...context, connected: !state.offline });
      render((n) => n + 1);
    }
  }, [state.offline]);
  const actor = state.scope && state.catalogs[state.scope.source]?.actor;
  return (
    <>
      <button
        type="button"
        aria-label="待我处理"
        title={actor ? '待我处理' : '选择提供待办账号身份的项目后可查看'}
        disabled={busy || !state.project || !actor}
        onClick={() =>
          run(async () => {
            close();
            panel.current = await controller.openAttention(() => render((n) => n + 1));
            render((n) => n + 1);
          })
        }
      >
        <Inbox size={16} />
        <span>待我处理</span>
      </button>
      {panel.current && (
        <Dialog.Root open onOpenChange={(open) => !open && close()}>
          <Dialog.Portal>
            <Dialog.Backdrop className="session-dialog-backdrop" />
            <Dialog.Popup className="session-dialog workspace-attention-panel">
              <div className="workspace-attention-heading">
                <Dialog.Title>待我处理</Dialog.Title>
                <button onClick={close}>关闭待办</button>
              </div>
              <Dialog.Description>
                待办按原账号和执行电脑保存；后续指令只发送此处文本，主输入框的附件、标注和授权保留。
              </Dialog.Description>
              <AttentionWorkbench
                controller={panel.current.controller}
                onOpenSession={async (route, sessionId, turnId) => {
                  const value = panel.current;
                  if (value) {
                    await value.openSession(route, sessionId, turnId);
                    close();
                  }
                }}
              />
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}
