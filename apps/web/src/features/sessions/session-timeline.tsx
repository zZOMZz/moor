import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ChevronRight, Info, Terminal, X } from 'lucide-react';
import { markdown } from '../../components/content';
import { informationHtml, sessionInformation } from '../interactions/interactions';
import { sessionEventSchema } from '@moor/protocol/session-events';
import { projectDiffReferenceSchema } from '@moor/protocol/project-content-protocol';
import { agentCommandText } from '../skills/skills';

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
function runningItem(value: unknown, finished: boolean) {
  const item = itemObject(value);
  return (
    !finished &&
    item.type === 'tool_call' &&
    !item.permissionRequest &&
    ['pending', 'in_progress', 'running'].includes(String(item.status))
  );
}
function secondary(value: unknown, finished: boolean) {
  const item = itemObject(value);
  return (
    !['text', 'attachment', 'system_notice', 'question', 'steer'].includes(String(item.type)) &&
    !item.permissionRequest &&
    !runningItem(value, finished) &&
    !['failed', 'error'].includes(String(item.status))
  );
}

/** Shared rendering only: approval and content actions keep their transport-specific bindings. */
export function SessionTimeline({
  history,
  focusTurnId,
  live = true,
  renderItem,
  afterTurn,
  actions,
}: {
  history: TimelineTurn[];
  focusTurnId?: string;
  live?: boolean;
  renderItem(value: unknown, turn: TimelineTurn, index: number): ReactNode;
  afterTurn?(turn: TimelineTurn): ReactNode;
  actions?(turn: TimelineTurn): ReactNode;
}) {
  const variant = 'workspace';
  const container = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(!focusTurnId);
  const focused = useRef<string | undefined>(undefined);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const scrollToLatest = () => {
    const node = container.current;
    if (!node) return;
    following.current = true;
    node.scrollTop = node.scrollHeight;
    setAwayFromLatest(false);
  };
  useLayoutEffect(() => {
    if (!focusTurnId) focused.current = undefined;
    else if (focused.current !== focusTurnId) {
      const node = [
        ...(container.current?.querySelectorAll<HTMLElement>('[data-turn-id]') ?? []),
      ].find((node) => node.dataset.turnId === focusTurnId);
      if (node) {
        focused.current = focusTurnId;
        following.current = false;
        node.scrollIntoView?.({ block: 'center' });
        node.focus({ preventScroll: true });
      }
    }
    if (following.current) scrollToLatest();
  });
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToLatest();
    });
    observer.observe(content.current);
    // Composer growth and window resizing also change the scroll viewport.
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="session-timeline-shell" data-live={live}>
      <section
        ref={container}
        className={variant + '-history session-timeline'}
        aria-label="会话内容"
        onScroll={(event) => {
          const node = event.currentTarget;
          const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
          following.current = nearBottom;
          setAwayFromLatest(!nearBottom);
        }}
      >
        <div ref={content} className="session-timeline-content">
          {!history.length && <p className="workspace-empty-message">写下第一条指令开始。</p>}
          {history.map((turn) => {
            const entries = (turn.items ?? [])
              .map((value, index) => ({ value, index }))
              .filter(({ value }) => {
                const item = itemObject(value);
                return (
                  item.type !== 'agent_features' &&
                  !(
                    item.type === 'session_event' &&
                    sessionEventSchema.safeParse(item.event).success
                  )
                );
              });
            const render = ({ value, index }: (typeof entries)[number]) => {
              const item = itemObject(value);
              return (
                <div
                  key={index}
                  className={
                    'session-item' +
                    (runningItem(value, turn.finished) ? ' session-item-running' : '')
                  }
                >
                  {runningItem(value, turn.finished) && (
                    <span className="session-item-status">
                      <span className="session-running-dot" />
                      {item.status === 'pending'
                        ? live
                          ? '等待执行'
                          : '上次等待执行'
                        : live
                          ? '正在执行'
                          : '上次执行中'}
                    </span>
                  )}
                  {['failed', 'error'].includes(String(item.status)) && (
                    <span className="session-item-status session-item-error">执行失败</span>
                  )}
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
            // Collapse only adjacent operational entries. Moving every tool to the end
            // changes the meaning of messages written before and after an operation.
            const groups: { detail: boolean; entries: typeof entries }[] = [];
            for (const entry of entries) {
              const detail = secondary(entry.value, turn.finished);
              const previous = groups.at(-1);
              if (detail && previous?.detail) previous.entries.push(entry);
              else groups.push({ detail, entries: [entry] });
            }
            return (
              <article
                key={turn.id}
                data-turn-id={turn.id}
                tabIndex={-1}
                className={`${variant}-turn ${variant}-turn-${turn.role}${focusTurnId === turn.id ? ' workspace-search-focus' : ''}`}
              >
                <div className="session-turn-heading">
                  <small className="session-turn-label">
                    {turn.role === 'user' ? '你' : 'Agent'}
                  </small>
                  {!turn.finished && turn.role === 'assistant' && (
                    <span className="session-turn-progress">
                      <span className="session-running-dot" />
                      {live ? '进行中' : '缓存执行状态'}
                    </span>
                  )}
                </div>
                {groups.map((group) =>
                  group.detail ? (
                    <details key={group.entries[0]!.index} className="session-tool-details">
                      <summary>
                        <ChevronRight
                          size={14}
                          className="session-tool-chevron"
                          aria-hidden="true"
                        />
                        <Terminal size={14} aria-hidden="true" />
                        <span>工具与思考</span>
                        <span className="session-tool-count">{group.entries.length}</span>
                      </summary>
                      <div className="session-tool-content">{group.entries.map(render)}</div>
                    </details>
                  ) : (
                    group.entries.map(render)
                  ),
                )}
                {afterTurn?.(turn)}
                {turn.role === 'assistant' && (
                  <div className="session-turn-actions">{actions?.(turn)}</div>
                )}
              </article>
            );
          })}
        </div>
      </section>
      {awayFromLatest && (
        <button type="button" className="session-jump-latest" onClick={scrollToLatest}>
          <ArrowDown size={14} aria-hidden="true" />
          回到最新消息
        </button>
      )}
    </div>
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
                onClick={() => onCommand(agentCommandText(command.name))}
              >
                {agentCommandText(command.name)}
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
