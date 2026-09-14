import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Info, X } from 'lucide-react';
import { markdown } from './content';
import { informationHtml, sessionInformation } from './interactions';
import { sessionEventSchema } from '../runtime/session-events';
import { projectDiffReferenceSchema } from '../project-content-protocol';

export type TimelineTurn = {
  id: string;
  role: string;
  finished: boolean;
  items?: unknown[];
  fileDiff?: unknown;
  timestamp?: string;
};
const itemObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
export function turnFileChanges(turn: TimelineTurn) {
  const parsed = projectDiffReferenceSchema.safeParse(turn.fileDiff);
  if (!parsed.success || parsed.data.turnId !== turn.id) return undefined;
  return parsed.data;
}
export function hasTurnFileChanges(turn: TimelineTurn) {
  const reference = turnFileChanges(turn);
  return !!reference && ['ready', 'partial'].includes(reference.state) && reference.changeCount > 0;
}
function secondary(value: unknown) {
  const item = itemObject(value);
  return (
    !['text', 'attachment', 'system_notice', 'question', 'steer'].includes(String(item.type)) &&
    !item.permissionRequest &&
    !['failed', 'error'].includes(String(item.status))
  );
}

/** Shared rendering only: approval and content actions keep their transport-specific bindings. */
export function SessionTimeline({
  history,
  variant,
  focusTurnId,
  renderItem,
  afterTurn,
  actions,
}: {
  history: TimelineTurn[];
  variant: 'workspace' | 'secure';
  focusTurnId?: string;
  renderItem(value: unknown, turn: TimelineTurn, index: number): ReactNode;
  afterTurn?(turn: TimelineTurn): ReactNode;
  actions?(turn: TimelineTurn): ReactNode;
}) {
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = [
      ...(container.current?.querySelectorAll<HTMLElement>('[data-turn-id]') ?? []),
    ].find((node) => node.dataset.turnId === focusTurnId);
    node?.scrollIntoView?.({ block: 'center' });
    node?.focus({ preventScroll: true });
  }, [focusTurnId, history.length]);
  return (
    <section
      ref={container}
      className={variant + '-history session-timeline'}
      aria-label="会话内容"
    >
      {!history.length && <p className="workspace-empty-message">写下第一条指令开始。</p>}
      {history.map((turn) => {
        const entries = (turn.items ?? [])
          .map((value, index) => ({ value, index }))
          .filter(({ value }) => {
            const item = itemObject(value);
            return (
              item.type !== 'agent_features' &&
              !(item.type === 'session_event' && sessionEventSchema.safeParse(item.event).success)
            );
          });
        const render = ({ value, index }: (typeof entries)[number]) => {
          const item = itemObject(value);
          return (
            <div key={index} className="session-item">
              {item.type === 'text' ? (
                <div
                  className="session-message-text"
                  dangerouslySetInnerHTML={{
                    __html: markdown(typeof item.text === 'string' ? item.text : ''),
                  }}
                />
              ) : (
                renderItem(value, turn, index)
              )}
            </div>
          );
        };
        const details = entries.filter(({ value }) => secondary(value));
        return (
          <article
            key={turn.id}
            data-turn-id={turn.id}
            tabIndex={-1}
            className={`${variant}-turn ${variant}-turn-${turn.role}${focusTurnId === turn.id ? ' workspace-search-focus' : ''}`}
          >
            <small className="session-turn-label">
              {turn.role === 'user' ? '你' : 'Agent'}
              {!turn.finished ? ' · 进行中' : ''}
            </small>
            {entries.filter(({ value }) => !secondary(value)).map(render)}
            {!!details.length && (
              <details className="session-tool-details">
                <summary>工具与思考 · {details.length}</summary>
                {details.map(render)}
              </details>
            )}
            {afterTurn?.(turn)}
            {turn.role === 'assistant' && (
              <div className="session-turn-actions">{actions?.(turn)}</div>
            )}
          </article>
        );
      })}
    </section>
  );
}

export function SessionInformation({
  history,
  disabled,
  onCommand,
  onFiles,
}: {
  history: TimelineTurn[];
  disabled: boolean;
  onCommand(command: string): void;
  onFiles?(turnId: string): void;
}) {
  const [selected, select] = useState('latest');
  const turns = history.filter((turn) => turn.role === 'assistant');
  const chosen = turns.find((turn) => turn.id === selected);
  const included = chosen ? [chosen] : turns;
  const information = sessionInformation(included.flatMap((turn) => turn.items ?? []));
  const latest = included.at(-1);
  return (
    <details className="session-information">
      <summary aria-label="会话信息" title="会话信息">
        <Info size={18} />
        <span>会话信息</span>
      </summary>
      <aside className="session-information-panel" aria-label="会话信息面板">
        <header>
          <strong>会话信息</strong>
          <button
            type="button"
            aria-label="关闭会话信息"
            onClick={(event) => event.currentTarget.closest('details')?.removeAttribute('open')}
          >
            <X size={16} />
          </button>
        </header>
        <label>
          查看范围
          <select
            aria-label="信息回合"
            value={chosen ? chosen.id : 'latest'}
            onChange={(event) => select(event.target.value)}
          >
            <option value="latest">最近上报</option>
            {turns.map((turn, index) => (
              <option key={turn.id} value={turn.id}>
                第 {index + 1} 回合
              </option>
            ))}
          </select>
        </label>
        <p className="workspace-muted">
          {chosen
            ? '仅显示所选回合中的上报。'
            : '各项保留最近一次上报；未上报的项目可能来自较早回合。'}
          {latest?.timestamp ? `最近所选回合时间：${latest.timestamp}。` : '未记录回合时间。'}
          上报本身未记录独立时间。
        </p>
        <h3>Agent 命令</h3>
        {information.commands?.length ? (
          information.commands.map((command) => (
            <div key={command.name} className="session-command">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onCommand('/' + command.name.replace(/^\//, ''))}
              >
                {'/' + command.name.replace(/^\//, '')}
              </button>
              <p>{command.description}</p>
            </div>
          ))
        ) : (
          <p>{information.commands ? 'Agent 未提供可用命令。' : '尚未收到命令目录。'}</p>
        )}
        <p className="workspace-muted">点击命令仅加入草稿，请检查后手动发送。</p>
        <div dangerouslySetInnerHTML={{ __html: informationHtml(information) }} />
        <h3>文件变更状态</h3>
        {(chosen ? [chosen] : turns.slice(-1)).map((turn) => {
          const reference = turnFileChanges(turn);
          const labels = {
            pending: '采集中',
            ready: '已记录',
            partial: '部分可用',
            unavailable: '采集不可用',
            interrupted: '采集中断',
          };
          return (
            <div key={turn.id}>
              <p>
                {reference
                  ? `${labels[reference.state]} · ${reference.changeCount} 项已确认变化`
                  : '此回合未记录可验证的文件变更。'}
              </p>
              {onFiles && (
                <button type="button" disabled={disabled} onClick={() => onFiles(turn.id)}>
                  检查此回合文件状态
                </button>
              )}
            </div>
          );
        })}
      </aside>
    </details>
  );
}
