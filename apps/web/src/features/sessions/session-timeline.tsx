import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowDown, ChevronRight, Info, Terminal, X } from 'lucide-react';
import { StreamingMarkdown } from './streaming-markdown';
import { informationHtml, sessionInformation } from '../interactions/interactions';
import { sessionEventSchema } from '@moor/protocol/session-events';
import { projectDiffReferenceSchema } from '@moor/protocol/project-content-protocol';
import { agentCommandText } from '../skills/skills';

export type TimelineTurn = {
  id: string;
  role: string;
  finished: boolean;
  status?: string;
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

type TimelineRenderers = {
  renderItem(value: unknown, index: number): ReactNode;
  afterTurn?(turn: TimelineTurn): ReactNode;
  actions?(turn: TimelineTurn): ReactNode;
};
type TimelineEntry = { value: unknown; index: number; text?: string };
type TimelineGroup = { detail: boolean; entries: TimelineEntry[] };

const TimelineItem = memo(function TimelineItem({
  value,
  index,
  finished,
  live,
  text,
  renderItem,
}: {
  value: unknown;
  index: number;
  finished: boolean;
  live: boolean;
  text?: string;
  renderItem: TimelineRenderers['renderItem'];
}) {
  const item = itemObject(value);
  const running = runningItem(value, finished);
  return (
    <div className={'session-item' + (running ? ' session-item-running' : '')}>
      {running && (
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
      {item.type === 'text' ? <StreamingMarkdown text={text ?? ''} /> : renderItem(value, index)}
    </div>
  );
});

function ToolDisclosure({
  entries,
  renderEntry,
}: {
  entries: TimelineEntry[];
  renderEntry(entry: TimelineEntry): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="session-tool-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight size={14} className="session-tool-chevron" aria-hidden="true" />
        <Terminal size={14} aria-hidden="true" />
        <span>工具与思考</span>
        <span className="session-tool-count">{entries.length}</span>
      </summary>
      {open && <div className="session-tool-content">{entries.map(renderEntry)}</div>}
    </details>
  );
}

const TimelineTurnRow = memo(function TimelineTurnRow({
  turn,
  focused,
  live,
  confirmed,
  renderItem,
  afterTurn,
  actions,
}: TimelineRenderers & {
  turn: TimelineTurn;
  focused: boolean;
  live: boolean;
  confirmed: boolean;
}) {
  const groups = useMemo(() => {
    const entries: TimelineEntry[] = [];
    let hidden = false;
    for (const [index, value] of (turn.items ?? []).entries()) {
      const item = itemObject(value);
      if (
        item.type === 'agent_features' ||
        (item.type === 'session_event' && sessionEventSchema.safeParse(item.event).success)
      ) {
        hidden = true;
        continue;
      }
      const text =
        item.type === 'text' ? (typeof item.text === 'string' ? item.text : '') : undefined;
      const previous = entries.at(-1);
      // Telemetry can split one Host message into multiple stored text items.
      // Join only across hidden observations, keeping the first item's key so
      // completed Markdown blocks, selection and copy state stay mounted.
      if (hidden && text !== undefined && previous?.text !== undefined) previous.text += text;
      else entries.push({ value, index, text });
      hidden = false;
    }
    // Collapse only adjacent operational entries. Moving every tool to the end
    // changes the meaning of messages written before and after an operation.
    const result: TimelineGroup[] = [];
    for (const entry of entries) {
      const detail = secondary(entry.value, turn.finished);
      const previous = result.at(-1);
      if (detail && previous?.detail) previous.entries.push(entry);
      else result.push({ detail, entries: [entry] });
    }
    return result;
  }, [turn.items, turn.finished]);
  const renderEntry = ({ value, index, text }: TimelineEntry) => {
    return (
      <TimelineItem
        key={index}
        value={value}
        index={index}
        finished={turn.finished}
        live={live}
        text={text}
        renderItem={renderItem}
      />
    );
  };
  return (
    <article
      data-turn-id={turn.id}
      tabIndex={-1}
      className={`workspace-turn workspace-turn-${turn.role}${focused ? ' workspace-search-focus' : ''}`}
    >
      <div className="session-turn-heading">
        <small className="session-turn-label">{turn.role === 'user' ? '你' : 'Agent'}</small>
        {!turn.finished && turn.role === 'assistant' && (
          <span className="session-turn-progress">
            <span className="session-running-dot" />
            {live ? '进行中' : '缓存执行状态'}
          </span>
        )}
        {confirmed &&
          turn.finished &&
          turn.role === 'assistant' &&
          (turn.status === 'canceled' || turn.status === 'failed') && (
            <span
              className={`session-turn-terminal${turn.status === 'failed' ? ' session-item-error' : ''}`}
              data-terminal={turn.status}
            >
              {turn.status === 'canceled' ? '已停止' : '执行失败'}
            </span>
          )}
      </div>
      {groups.map((group) =>
        group.detail ? (
          <ToolDisclosure
            key={group.entries[0]!.index}
            entries={group.entries}
            renderEntry={renderEntry}
          />
        ) : (
          group.entries.map(renderEntry)
        ),
      )}
      {afterTurn?.(turn)}
      {turn.role === 'assistant' && <div className="session-turn-actions">{actions?.(turn)}</div>}
    </article>
  );
});

/** Shared rendering only: approval and content actions keep their transport-specific bindings. */
export const SessionTimeline = memo(function SessionTimeline({
  history,
  focusTurnId,
  live = true,
  confirmed = true,
  renderItem,
  afterTurn,
  actions,
}: TimelineRenderers & {
  history: TimelineTurn[];
  focusTurnId?: string;
  live?: boolean;
  confirmed?: boolean;
}) {
  const container = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(!focusTurnId);
  const lastScrollTop = useRef(0);
  const focused = useRef<string | undefined>(undefined);
  const scrollFrame = useRef<number | undefined>(undefined);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const scheduleFollow = useCallback(() => {
    if (scrollFrame.current !== undefined || typeof requestAnimationFrame === 'undefined') return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined;
      const node = container.current;
      if (node && following.current) {
        node.scrollTop = node.scrollHeight;
        lastScrollTop.current = node.scrollTop;
      }
    });
  }, []);
  const scrollToLatest = useCallback(() => {
    following.current = true;
    setAwayFromLatest(false);
    scheduleFollow();
  }, [scheduleFollow]);
  useEffect(
    () => () => {
      if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = undefined;
    },
    [],
  );
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
    if (following.current) scheduleFollow();
  }, [history, focusTurnId, scheduleFollow]);
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (following.current) scheduleFollow();
    });
    observer.observe(content.current);
    // Composer growth and window resizing also change the scroll viewport.
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, [scheduleFollow]);
  return (
    <div className="session-timeline-shell" data-live={live}>
      <section
        ref={container}
        className="workspace-history session-timeline"
        aria-label="会话内容"
        onScroll={(event) => {
          const node = event.currentTarget;
          const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
          const movedUp = node.scrollTop < lastScrollTop.current;
          lastScrollTop.current = node.scrollTop;
          // A delayed event from our last scroll may arrive after more output
          // increased the height. Content growth alone must not stop following.
          if (nearBottom) following.current = true;
          else if (movedUp) following.current = false;
          setAwayFromLatest(!following.current);
        }}
      >
        <div ref={content} className="session-timeline-content">
          {!history.length && <p className="workspace-empty-message">写下第一条指令开始。</p>}
          {history.map((turn) => (
            <TimelineTurnRow
              key={turn.id}
              turn={turn}
              focused={focusTurnId === turn.id}
              live={live}
              confirmed={confirmed}
              renderItem={renderItem}
              afterTurn={afterTurn}
              actions={actions}
            />
          ))}
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
});

type SessionInformationProps = {
  history: TimelineTurn[];
  disabled: boolean;
  onCommand(command: string): void;
  onFiles?(turnId: string): void;
};

export function SessionInformation(props: SessionInformationProps) {
  const [open, setOpen] = useState(false);
  const [selected, select] = useState('latest');
  return (
    <details
      className="session-information"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label="会话信息" title="会话信息">
        <Info size={18} />
        <span>会话信息</span>
      </summary>
      {open && <SessionInformationBody {...props} selected={selected} select={select} />}
    </details>
  );
}

function SessionInformationBody({
  history,
  disabled,
  onCommand,
  onFiles,
  selected,
  select,
}: SessionInformationProps & {
  selected: string;
  select(value: string): void;
}) {
  const turns = history.filter((turn) => turn.role === 'assistant');
  const chosen = turns.find((turn) => turn.id === selected);
  const included = chosen ? [chosen] : turns;
  const information = sessionInformation(included.flatMap((turn) => turn.items ?? []));
  const latest = included.at(-1);
  return (
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
  );
}
