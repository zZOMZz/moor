import { useEffect, useRef, useState } from 'react';
import { Plug } from 'lucide-react';
import { McpPanel } from './mcp-ui';
import { MCP_FEATURE } from '../mcp-protocol';
import type { WorkspaceController, WorkspaceClientState } from './workspace-controller';

export function WorkspaceMcpUI({
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
  const panel = useRef<Awaited<ReturnType<WorkspaceController['openMcp']>> | null>(null);
  useEffect(
    () => () => {
      panel.current?.close();
      panel.current = null;
      render((n) => n + 1);
    },
    [controller, controller.contextRevision],
  );
  const close = () => {
    panel.current?.close();
    panel.current = null;
    render((n) => n + 1);
  };
  const reason = state.offline
    ? '执行电脑离线，选择保留，重连不会自动发送。'
    : !state.project?.runtime.features?.includes(MCP_FEATURE)
      ? '此执行电脑尚未提供额外 MCP 能力。'
      : '';
  const saved = state.ledger?.mcp?.[state.sessionId ?? ''];
  return (
    <>
      <button
        type="button"
        aria-label="额外 MCP"
        title="额外 MCP"
        disabled={busy}
        onClick={() =>
          run(async () => {
            panel.current?.close();
            panel.current = await controller.openMcp(() => render((n) => n + 1));
            render((n) => n + 1);
          })
        }
      >
        <Plug size={16} />
        {saved?.review?.servers.length || ''}
      </button>
      {panel.current && (
        <McpPanel
          controller={panel.current.controller}
          reason={reason}
          sending={busy}
          onClose={close}
          onRefresh={() => run(() => panel.current!.controller.refresh())}
          onApply={(servers) =>
            new Promise<void>((resolve, reject) => {
              const current = panel.current;
              if (!current) {
                reject(Error('MCP 面板已关闭。'));
                return;
              }
              if (
                !run(async () => {
                  try {
                    await current.controller.apply(servers);
                    resolve();
                  } catch (error) {
                    reject(error);
                  }
                })
              )
                reject(Error('另一项操作尚未结束。'));
            })
          }
        />
      )}
    </>
  );
}
