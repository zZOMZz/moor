import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Plug, X } from 'lucide-react';
import { MCP_LIMITS, type McpServerView } from '../mcp-protocol';
import { type McpController, mcpKey } from './mcp';
import { paint } from './ui';

export type McpPanelProps = {
  controller?: McpController;
  reason: string;
  sending: boolean;
  onClose(): void;
  onRefresh(): void;
  onApply(servers: McpServerView[]): Promise<void>;
};
export function McpPanel(p: McpPanelProps) {
  const c = p.controller;
  const [chosen, setChosen] = useState<McpServerView[]>(() => [...(c?.selected ?? [])]);
  const [error, setError] = useState('');
  const busy = p.sending || !!c?.busy;
  const blocked = busy || !c?.loaded || !!c?.loadError;
  const options = [
    ...(c?.list?.servers ?? []),
    ...chosen.filter((server) => !c?.list?.servers.some((item) => item.id === server.id)),
  ];
  return (
    <Dialog.Root open onOpenChange={(open) => !open && p.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog mcp-panel">
          <div className="attachment-preview-heading">
            <Dialog.Title>本回合额外 MCP</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="关闭额外 MCP">
              <X />
            </Dialog.Close>
          </div>
          <Dialog.Description>
            选择 Moor 为下一条手动指令附加的服务器，最多 {MCP_LIMITS.selected} 个。这里只控制 Moor
            附加项，Agent 自己的 MCP 设置不会因此关闭。
          </Dialog.Description>
          <p>
            读取目录和保存草稿不会连接服务器或启动
            Agent。发送前会重新核对原版本；不可用版本需要手动更改。
          </p>
          {(p.reason || c?.error || c?.loadError || error) && (
            <p role="status">{error || c?.loadError || c?.error || p.reason}</p>
          )}
          <button type="button" disabled={blocked || !!p.reason} onClick={p.onRefresh}>
            读取项目允许的 MCP
          </button>
          {!c?.list && <p>尚无当前目录。已有草稿保留原版本；连接后请手动读取。</p>}
          {c?.list && !c.list.servers.length && <p>此项目当前没有可用的额外 MCP。</p>}
          <ul aria-label="额外 MCP 服务器">
            {options.map((server) => {
              const selected = chosen.some((item) => item.id === server.id);
              const unavailable = c?.unavailable(server) !== false;
              return (
                <li key={server.id}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`选择 MCP：${server.name}`}
                      checked={selected}
                      disabled={
                        blocked ||
                        (!selected && (unavailable || chosen.length >= MCP_LIMITS.selected))
                      }
                      onChange={(event) => {
                        setError('');
                        setChosen(
                          event.target.checked
                            ? [...chosen, server]
                            : chosen.filter((item) => item.id !== server.id),
                        );
                      }}
                    />
                    {server.name}
                  </label>
                  <p>{server.description}</p>
                  <p>
                    版本：<code>{server.id}</code> · {server.transport}
                    {unavailable ? ' · 当前不可用或尚未重新核对' : ''}
                  </p>
                </li>
              );
            })}
          </ul>
          <p>
            已选择 {chosen.length} / {MCP_LIMITS.selected}{' '}
            个。确认收到指令后仅清除此份选择；会话副本和子任务不会自动继承。
          </p>
          {c?.delivery && <p>原指令结果待确认，原 MCP 选择已固定。此处修改只用于后续指令。</p>}
          <div className="session-dialog-actions">
            <button
              type="button"
              disabled={blocked}
              onClick={() => {
                setError('');
                void p.onApply(chosen).catch((e) => setError(e.message));
              }}
            >
              确认保存 MCP 选择到草稿
            </button>
            <button
              type="button"
              disabled={blocked}
              onClick={() => {
                setChosen([]);
                setError('');
              }}
            >
              清空待保存选择
            </button>
            <Dialog.Close>关闭</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showMcpPanel(props?: McpPanelProps) {
  paint(
    '#mcp-view',
    props ? (
      <McpPanel
        key={
          (props.controller ? mcpKey(props.controller.target) : '') +
          '/' +
          (props.controller?.review?.reviewId ?? '')
        }
        {...props}
      />
    ) : null,
  );
}
export function showMcpControl(props: { disabled: boolean; count: number; onOpen(): void }) {
  paint(
    '#mcp-control',
    <button
      type="button"
      className="icon-button"
      disabled={props.disabled}
      onClick={props.onOpen}
      aria-label="额外 MCP"
      title="本回合额外 MCP"
    >
      <Plug />
      <span className="sr-only">额外 MCP</span>
      {props.count > 0 && <span>{props.count}</span>}
    </button>,
  );
}
export function showMcpCard(props?: { controller: McpController; onOpen(): void }) {
  const c = props?.controller;
  paint(
    '#mcp-card',
    c?.selected.length ? (
      <section aria-label="已保存的 MCP 草稿" className="task-plan-card">
        <button type="button" onClick={props!.onOpen}>
          额外 MCP：{c.selected.map((server) => server.name).join('、')}
        </button>
        <p>
          {c.selected.some((server) => c.unavailable(server))
            ? '原版本尚未核对或已不可用；发送前将重新读取。'
            : '仅随下一条手动指令授权当前回合。'}
        </p>
      </section>
    ) : null,
  );
}
