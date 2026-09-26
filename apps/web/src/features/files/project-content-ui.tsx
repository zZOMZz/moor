import { Dialog } from '@base-ui/react/dialog';
import { CONTENT_LIMITS } from '@moor/protocol/content-protocol';
import type {
  ProjectContentIssue,
  ProjectDiffChange,
  ProjectDiffFileResult,
  ProjectDiffReference,
  ProjectTreeResult,
  ProjectTurnDiffResult,
} from '@moor/protocol/project-content-protocol';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  GitCompareArrows,
  Maximize2,
  Minimize2,
  Quote,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { markdown } from '../../components/content';
import { formatAttachmentSize } from '../attachments/attachments';
import type { FileContentView } from './file-content';
import { compareTextLines, type ProjectContentView } from './project-content';

export type ProjectTurnChoice = { id: string; label: string; reference?: ProjectDiffReference };
export type ProjectContentPanelProps = {
  docked?: boolean;
  expanded?: boolean;
  onToggleExpanded?(): void;
  onQuote?(text: string): void;
  returnFocus?: RefObject<HTMLElement | null>;
  quoteFocus?: RefObject<HTMLElement | null>;
  title: string;
  mode: 'tree' | 'changes';
  busy?: boolean;
  error?: string;
  tree?: ProjectContentView<ProjectTreeResult>;
  currentFile?: Omit<FileContentView, 'bytes'>;
  currentUnavailable?: { path: string; message: string };
  turns: ProjectTurnChoice[];
  turnId?: string;
  diff?: ProjectContentView<ProjectTurnDiffResult>;
  diffFile?: ProjectContentView<ProjectDiffFileResult>;
  onMode: (mode: 'tree' | 'changes') => void;
  onTreeMore: () => void;
  onFile: (path: string, size: number) => void;
  onTurn: (turnId: string) => void;
  onDiffFile: (change: ProjectDiffChange) => void;
  onRefresh: () => void;
  onClose: () => void;
};
const issueLabels: Record<ProjectContentIssue['reason'], string> = {
  'policy-excluded': '已排除忽略项、依赖目录或私有配置',
  'git-unavailable': 'Git 不可用',
  'git-failed': 'Git 枚举失败',
  'directory-ignore-unavailable': '普通目录扫描不应用 Git 忽略规则',
  'invalid-path': '文件路径不可用',
  symlink: '已跳过符号链接',
  nonregular: '已跳过非普通文件',
  unavailable: '部分文件不可读取',
  changed: '读取期间文件发生变化',
  'entry-limit': '达到目录条目上限',
  'depth-limit': '达到目录深度上限',
  oversize: '文件超过 1 MiB 预览上限',
  'read-budget': '达到本次读取总量上限',
  'change-limit': '达到变更记录上限',
  'incomplete-baseline': '部分文件缺少完整基线',
  'enumeration-changed': '前后扫描范围发生变化',
  'issue-limit': '其他未完整记录项',
  'capture-failed': '基线采集失败',
  'scope-changed': '项目范围发生变化',
  interrupted: '回合或采集过程已中断',
  'not-recorded': '此回合没有保存文件基线',
  'persistence-failed': '文件基线保存失败',
};
export function projectDiffStatus(state: ProjectTurnDiffResult['state']) {
  return {
    pending: '基线采集中',
    ready: '基线已保存',
    partial: '仅保存部分基线',
    unavailable: '基线不可用',
    interrupted: '采集已中断',
    'not-recorded': '未记录文件基线',
  }[state];
}
function Issues({ values }: { values: ProjectContentIssue[] }) {
  if (!values.length) return null;
  return (
    <details className="project-issues">
      <summary>扫描范围与限制 · {values.length} 项</summary>
      <ul>
        {values.map((issue, index) => (
          <li key={index}>
            {issueLabels[issue.reason]}
            {issue.path ? `：${issue.path}` : ''}
            {issue.count ? `（${issue.count}）` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}

type LineSide = 'current' | 'before' | 'after';
type LineSelection = { side: LineSide; anchor: number; start: number; end: number };
const sideLabel = { current: '本次读取', before: '修改前', after: '修改后' };
const QUOTE_BYTES = 16 * 1024;
function useLineSelection() {
  const [selection, setSelection] = useState<LineSelection>();
  return {
    selection,
    clear: () => setSelection(undefined),
    select: (side: LineSide, line: number, event: MouseEvent<HTMLButtonElement>) => {
      setSelection((previous) => {
        const anchor = event.shiftKey && previous?.side === side ? previous.anchor : line;
        return { side, anchor, start: Math.min(anchor, line), end: Math.max(anchor, line) };
      });
    },
  };
}
type LineControls = ReturnType<typeof useLineSelection>;
function selected(selection: LineSelection | undefined, side: LineSide, line: number) {
  return selection?.side === side && line >= selection.start && line <= selection.end;
}
function LineNumber({
  side,
  line,
  controls,
  disabled = false,
}: {
  side: LineSide;
  line: number;
  controls?: LineControls;
  disabled?: boolean;
}) {
  return controls ? (
    <button
      type="button"
      className="project-select-line"
      disabled={disabled}
      aria-label={`选择${sideLabel[side]}第 ${line} 行`}
      aria-pressed={selected(controls.selection, side, line)}
      title={disabled ? '展开完整文本后可引用此行' : '点击选择，按住 Shift 选择连续行'}
      onClick={(event) => controls.select(side, line, event)}
    >
      {line}
    </button>
  ) : (
    <span className="project-line-number">{line}</span>
  );
}
function quoteText(metadata: Record<string, unknown>, text?: string, selection?: LineSelection) {
  const excerpt =
    text !== undefined && selection
      ? text
          .split('\n')
          .slice(selection.start - 1, selection.end)
          .join('\n')
      : undefined;
  let fenceSize = 3;
  for (const match of (excerpt ?? '').matchAll(/`+/g))
    fenceSize = Math.max(fenceSize, match[0].length + 1);
  const fence = '`'.repeat(fenceSize);
  const reference = metadata.reference as ProjectDiffReference | undefined;
  type VersionSide = { path: string; version?: string; state: string };
  const sides = ['before', 'after'] as const;
  const source = metadata.source === 'cache' ? '离线缓存' : '主机已读取';
  return [
    `文件：${String(metadata.path)}`,
    ...(selection
      ? [
          `位置：${sideLabel[selection.side]} (${selection.side}) · L${selection.start}${selection.end !== selection.start ? `–L${selection.end}` : ''}`,
        ]
      : []),
    ...(metadata.version ? [`文件版本：${String(metadata.version)}`] : []),
    ...(!selection && reference
      ? sides.map((side) => {
          const file = metadata[side] as VersionSide | null;
          return `${sideLabel[side]} (${side})：${file ? `${file.path} · ${file.version ?? file.state}` : '该侧不存在'}`;
        })
      : []),
    ...(reference
      ? [
          `历史快照：回合 ${reference.turnId} · 差异 ${reference.diffId} · 项目快照 v${reference.contentVersion}`,
          `快照版本：${reference.version ?? '未记录'} · ${reference.state} · ${reference.changeCount} 项变更`,
          `来源：${source}；所选回合历史文件，可能包含其他会话或外部修改${metadata.partial ? '；快照不完整' : ''}。`,
        ]
      : [`来源：${source}的本次文件版本，不代表之后的工作区内容。`]),
    ...(excerpt === undefined ? [] : [fence + 'text', excerpt, fence]),
  ].join('\n');
}
function QuoteControl({
  controls,
  onQuote,
  build,
}: {
  controls: LineControls;
  onQuote?: (text: string) => void;
  build(): string;
}) {
  const [error, setError] = useState('');
  useEffect(() => setError(''), [controls.selection]);
  if (!onQuote) return null;
  const selection = controls.selection;
  return (
    <div className="project-quote-control">
      {selection && (
        <span>
          {sideLabel[selection.side]} L{selection.start}
          {selection.end !== selection.start ? `–${selection.end}` : ''}
        </span>
      )}
      {selection && (
        <button type="button" onClick={controls.clear} aria-label="清除已选行">
          清除
        </button>
      )}
      <button
        type="button"
        className="project-quote-button"
        onClick={() => {
          const quote = build();
          if (new TextEncoder().encode(quote).byteLength > QUOTE_BYTES) {
            setError('引用超过 16 KiB，请缩小选中范围。原文未截断，也未加入草稿。');
            return;
          }
          setError('');
          onQuote(quote);
        }}
      >
        <Quote size={13} />
        {selection ? '引用选中行' : '引用文件'}
      </button>
      {error && (
        <p className="list-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
function TextLines({
  text,
  side,
  controls,
}: {
  text: string;
  side: LineSide;
  controls?: LineControls;
}) {
  const [limit, setLimit] = useState({ characters: 120_000, lines: 1000 });
  const visible = text.slice(0, limit.characters);
  const visibleRows = useMemo(() => (visible ? visible.split('\n') : []), [visible]);
  const rows = visibleRows.slice(0, limit.lines);
  const truncated = visible.length < text.length || rows.length < visibleRows.length;
  return (
    <>
      {!rows.length ? (
        <p className="subtle">（空文件）</p>
      ) : (
        <div className="project-source-lines" aria-label={`${sideLabel[side]}文本行`}>
          {rows.map((line, index) => (
            <div
              key={index}
              className="project-source-line"
              data-selected={selected(controls?.selection, side, index + 1)}
            >
              <LineNumber
                side={side}
                line={index + 1}
                controls={controls}
                disabled={visible.length < text.length && index === visibleRows.length - 1}
              />
              <code>{line || ' '}</code>
            </div>
          ))}
        </div>
      )}
      {truncated && (
        <button
          type="button"
          className="project-preview-more"
          onClick={() =>
            setLimit((value) => ({
              characters: value.characters + 120_000,
              lines: value.lines + 1000,
            }))
          }
        >
          继续显示文本 · 已显示 {rows.length} 行
        </button>
      )}
    </>
  );
}
function CurrentFilePreview({
  value,
  onQuote,
}: {
  value: Omit<FileContentView, 'bytes'>;
  onQuote?: (text: string) => void;
}) {
  const controls = useLineSelection();
  const [raw, setRaw] = useState(false);
  const [full, setFull] = useState(false);
  const { result, text } = value;
  const isMarkdown = /\.(md|markdown)$/i.test(result.path);
  const visible = full ? text : text?.slice(0, 120_000);
  const html = useMemo(
    () => (isMarkdown && !raw ? markdown(visible ?? '') : ''),
    [isMarkdown, raw, visible],
  );
  return (
    <>
      <div className="project-preview-heading">
        <h3 title={result.path}>{result.path}</h3>
        <QuoteControl
          controls={controls}
          onQuote={onQuote}
          build={() =>
            quoteText(
              {
                kind: 'project-file',
                source: value.source,
                stale: value.stale,
                contentVersion: result.contentVersion,
                workspaceId: result.workspaceId,
                localProjectId: result.localProjectId,
                sessionId: result.sessionId,
                path: result.path,
                version: result.content.version,
              },
              text,
              controls.selection,
            )
          }
        />
      </div>
      {isMarkdown && text !== undefined && (
        <div className="project-file-format">
          <button
            type="button"
            aria-pressed={!raw}
            onClick={() => {
              setRaw(false);
              controls.clear();
            }}
          >
            Markdown
          </button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
            源文本 / 选行
          </button>
        </div>
      )}
      {text === undefined ? (
        <p className="subtle">二进制文件，不提供文本预览。可引用文件标识。</p>
      ) : isMarkdown && !raw ? (
        <>
          <div className="project-markdown" dangerouslySetInnerHTML={{ __html: html }} />
          {visible?.length !== text.length && (
            <button type="button" onClick={() => setFull(true)}>
              预览已截断，显示完整文本
            </button>
          )}
        </>
      ) : (
        <TextLines text={text} side="current" controls={onQuote ? controls : undefined} />
      )}
    </>
  );
}
function FrozenFile({
  value,
  side,
  controls,
}: {
  value: ProjectDiffFileResult['before'];
  side: 'before' | 'after';
  controls?: LineControls;
}) {
  return (
    <section className="project-frozen-file">
      <h4>
        {sideLabel[side]}
        {value && <span title={value.path}>{value.path}</span>}
      </h4>
      {!value ? (
        <p className="subtle">该侧文件不存在。</p>
      ) : value.state === 'text' && value.text !== undefined ? (
        <TextLines text={value.text} side={side} controls={controls} />
      ) : (
        <p className="project-partial">
          {value.state === 'binary'
            ? '二进制文件，已保存内容摘要，不提供文本预览。'
            : value.state === 'oversize'
              ? '文件超过 1 MiB，未保存文本基线。'
              : '该侧基线不可读取，不能推断内容未变化。'}
        </p>
      )}
    </section>
  );
}
function DiffPreview({
  value,
  expanded,
  onQuote,
}: {
  value: ProjectContentView<ProjectDiffFileResult>;
  expanded?: boolean;
  onQuote?: (text: string) => void;
}) {
  const [format, setFormat] = useState<'diff' | 'sides'>('diff');
  const controls = useLineSelection();
  const { before, after } = value.result;
  const textOnly =
    (!before || (before.state === 'text' && typeof before.text === 'string')) &&
    (!after || (after.state === 'text' && typeof after.text === 'string'));
  const lines = useMemo(
    () => (textOnly ? compareTextLines(before?.text ?? '', after?.text ?? '') : undefined),
    [before, after, textOnly],
  );
  const unified = !expanded || format === 'diff';
  const buildQuote = () => {
    const selection = controls.selection;
    const file =
      selection?.side === 'before' ? before : selection?.side === 'after' ? after : undefined;
    return quoteText(
      {
        kind: 'historical-project-snapshot',
        source: value.source,
        contentVersion: value.result.contentVersion,
        workspaceId: value.result.workspaceId,
        localProjectId: value.result.localProjectId,
        sessionId: value.result.sessionId,
        path: file?.path ?? value.result.path,
        reference: value.result.reference,
        partial: value.result.partial,
        attribution: value.result.attribution,
        ...(selection
          ? { version: file?.version }
          : {
              before: before
                ? { path: before.path, version: before.version, state: before.state }
                : null,
              after: after
                ? { path: after.path, version: after.version, state: after.state }
                : null,
            }),
      },
      file?.text,
      selection,
    );
  };
  return (
    <div className="project-diff-preview">
      <div className="project-preview-heading">
        <h3 title={value.result.path}>{value.result.path}</h3>
        <QuoteControl controls={controls} onQuote={onQuote} build={buildQuote} />
      </div>
      {expanded && textOnly && lines && (
        <div className="project-file-format">
          <button type="button" aria-pressed={format === 'diff'} onClick={() => setFormat('diff')}>
            逐行对比
          </button>
          <button
            type="button"
            aria-pressed={format === 'sides'}
            onClick={() => setFormat('sides')}
          >
            前后版本
          </button>
        </div>
      )}
      {unified && lines ? (
        <div className="project-lines" aria-label="已保存文件的逐行变更">
          <div className="project-diff-column-labels">
            <span>前</span>
            <span>后</span>
            <span />
            <span>历史快照</span>
          </div>
          {lines.map((line, index) => (
            <div
              key={index}
              className={`project-diff-line ${line.kind}`}
              data-selected={
                (line.before !== undefined &&
                  selected(controls.selection, 'before', line.before)) ||
                (line.after !== undefined && selected(controls.selection, 'after', line.after))
              }
            >
              {line.before !== undefined ? (
                <LineNumber
                  side="before"
                  line={line.before}
                  controls={onQuote ? controls : undefined}
                />
              ) : (
                <span className="project-line-number" aria-label="修改前无此行">
                  –
                </span>
              )}
              {line.after !== undefined ? (
                <LineNumber
                  side="after"
                  line={line.after}
                  controls={onQuote ? controls : undefined}
                />
              ) : (
                <span className="project-line-number" aria-label="修改后无此行">
                  –
                </span>
              )}
              <span
                className="project-line-sign"
                aria-label={
                  line.kind === 'added' ? '新增行' : line.kind === 'removed' ? '删除行' : '相同行'
                }
              >
                {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
              </span>
              <code>{line.text || ' '}</code>
            </div>
          ))}
        </div>
      ) : (
        <>
          {textOnly && !lines && (
            <p className="project-partial">文本较长，展示准确的前后原文；未计算逐行差异。</p>
          )}
          <div className="project-diff-sides" data-side-by-side={!!expanded}>
            <FrozenFile value={before} side="before" controls={onQuote ? controls : undefined} />
            <FrozenFile value={after} side="after" controls={onQuote ? controls : undefined} />
          </div>
        </>
      )}
      {value.result.partial && (
        <p className="project-partial">此回合快照不完整，显示范围以已保存内容为准。</p>
      )}
      <Issues values={value.result.issues} />
    </div>
  );
}
const changeLabels = { added: '新增', deleted: '删除', modified: '修改', renamed: '重命名' };
function ContentFrame({
  docked,
  expanded,
  onClose,
  finalFocus,
  children,
}: {
  docked?: boolean;
  expanded?: boolean;
  onClose(): void;
  finalFocus(): boolean | HTMLElement | null;
  children: ReactNode;
}) {
  if (docked)
    return (
      <aside
        className="project-content-panel project-content-docked project-content-focused"
        data-expanded={!!expanded}
        aria-label="文件与变更"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        {children}
      </aside>
    );
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup
          className="session-dialog project-content-panel project-content-focused"
          data-expanded={!!expanded}
          finalFocus={finalFocus}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function SourceDetails({ props }: { props: ProjectContentPanelProps }) {
  const current = props.currentFile;
  const historical = props.diffFile?.result ?? props.diff?.result;
  const source =
    props.mode === 'tree'
      ? (current?.source ?? props.tree?.source)
      : (props.diffFile?.source ?? props.diff?.source);
  const reference = historical?.reference;
  return (
    <details className="project-source-details">
      <summary>来源与版本</summary>
      <p>
        {props.mode === 'tree'
          ? '文件是本次读取的版本，之后可能已被修改。缓存不代表主机当前内容。'
          : '这里展示所选回合保存的历史快照，不随当前工作区文件变化。'}
      </p>
      <p>扫描可能包含外部编辑器或其他会话的修改，不表示仅由当前 Agent 产生。</p>
      <dl>
        <dt>项目</dt>
        <dd>{props.title}</dd>
        <dt>读取来源</dt>
        <dd>
          {source === 'cache' ? '离线缓存' : source === 'host' ? '主机已确认本次读取' : '尚未读取'}
        </dd>
        {props.mode === 'tree' ? (
          <>
            {props.tree && (
              <>
                <dt>目录载入</dt>
                <dd>
                  {props.tree.result.entries.length} / {props.tree.result.total} 项
                </dd>
                <dt>目录版本</dt>
                <dd>
                  <code>{props.tree.result.version}</code>
                </dd>
              </>
            )}
            {current && (
              <>
                <dt>文件</dt>
                <dd>
                  {current.result.path} · {formatAttachmentSize(current.result.content.byteLength)}
                </dd>
                <dt>文件版本</dt>
                <dd>
                  <code>{current.result.content.version}</code>
                </dd>
              </>
            )}
          </>
        ) : (
          <>
            {historical && (
              <>
                <dt>历史回合</dt>
                <dd>{historical.turnId}</dd>
              </>
            )}
            {reference && (
              <>
                <dt>快照编号</dt>
                <dd>{reference.diffId}</dd>
                <dt>快照版本</dt>
                <dd>
                  <code>{reference.version ?? '未记录'}</code>
                </dd>
                <dt>快照状态</dt>
                <dd>
                  {projectDiffStatus(reference.state)} · {reference.changeCount} 项变更
                </dd>
              </>
            )}
            {props.diffFile &&
              (['before', 'after'] as const).map((side) => {
                const file = props.diffFile!.result[side];
                return (
                  <div className="project-source-version" key={side}>
                    <dt>{sideLabel[side]}</dt>
                    <dd>
                      {file ? (
                        <>
                          {file.path} · {formatAttachmentSize(file.size)}
                          <br />
                          <code>{file.version ?? '未保存可用版本'}</code>
                        </>
                      ) : (
                        '该侧文件不存在'
                      )}
                    </dd>
                  </div>
                );
              })}
          </>
        )}
      </dl>
    </details>
  );
}
export const ProjectContentPanel = memo(function ProjectContentPanel(
  props: ProjectContentPanelProps,
) {
  const quoteClosing = useRef(false);
  const quote = useCallback(
    (text: string) => {
      // Modal quotes deliberately move focus into the draft, not back to the opener.
      quoteClosing.current = !props.docked;
      props.onQuote?.(text);
    },
    [props.docked, props.onQuote],
  );
  const onQuote = props.onQuote ? quote : undefined;
  const [directory, setDirectory] = useState('');
  const [listOpen, setListOpen] = useState(true);
  const tree = props.tree?.result;
  useEffect(() => {
    if (
      directory &&
      tree &&
      !tree.entries.some((entry) => entry.type === 'directory' && entry.path === directory)
    )
      setDirectory('');
  }, [tree?.version]);
  useEffect(() => setListOpen(true), [props.mode, props.turnId]);
  const children =
    tree?.entries
      .filter(
        (entry) =>
          (entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '') ===
          directory,
      )
      .sort((a, b) =>
        a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'directory' ? -1 : 1,
      ) ?? [];
  const diff = props.diff?.result;
  const source =
    props.mode === 'tree'
      ? (props.currentFile?.source ?? props.tree?.source)
      : (props.diffFile?.source ?? props.diff?.source);
  const cacheFailed = [
    props.mode === 'tree' ? props.tree : props.diff,
    props.mode === 'tree' ? props.currentFile : props.diffFile,
  ].some((view) => view?.cacheSaved === false);
  const currentKey = props.currentFile
    ? JSON.stringify([props.currentFile.result.path, props.currentFile.result.content.version])
    : '';
  const diffKey = props.diffFile
    ? JSON.stringify([props.diffFile.result.path, props.diffFile.result.reference])
    : '';
  return (
    <ContentFrame
      docked={props.docked}
      expanded={props.expanded}
      onClose={() => {
        quoteClosing.current = false;
        props.onClose();
      }}
      finalFocus={() =>
        quoteClosing.current
          ? props.quoteFocus?.current?.isConnected
            ? props.quoteFocus.current
            : false
          : props.returnFocus?.current?.isConnected
            ? props.returnFocus.current
            : true
      }
    >
      {props.docked ? (
        <h2 className="sr-only">文件与变更</h2>
      ) : (
        <>
          <Dialog.Title className="sr-only">文件与变更</Dialog.Title>
          <Dialog.Description className="sr-only">{props.title}</Dialog.Description>
        </>
      )}
      <div className="project-panel-heading project-focused-heading">
        <div className="project-panel-tabs" aria-label="内容视图">
          <button
            type="button"
            aria-label="历史变更"
            aria-pressed={props.mode === 'changes'}
            disabled={props.busy}
            onClick={() => props.onMode('changes')}
          >
            <GitCompareArrows />
            变更
          </button>
          <button
            type="button"
            aria-label="当前项目文件"
            aria-pressed={props.mode === 'tree'}
            disabled={props.busy}
            onClick={() => props.onMode('tree')}
          >
            <FolderOpen />
            文件
          </button>
        </div>
        <div className="project-panel-actions">
          <button
            type="button"
            className="icon-button"
            disabled={props.busy}
            onClick={props.onRefresh}
            aria-label="重新读取文件或变更"
            title="重新读取"
          >
            <RefreshCw size={15} />
          </button>
          {props.onToggleExpanded && (
            <button
              type="button"
              className="icon-button"
              onClick={props.onToggleExpanded}
              aria-label={props.expanded ? '缩小文件与变更' : '放大文件与变更'}
              title={props.expanded ? '缩小' : '放大'}
            >
              {props.expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="关闭文件与变更"
            onClick={props.onClose}
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="project-snapshot-context">
        {props.mode === 'changes' ? (
          <label>
            <span>历史快照</span>
            <select
              aria-label="选择历史回合"
              value={props.turnId ?? ''}
              disabled={!props.turns.length || props.busy}
              onChange={(event) => props.onTurn(event.target.value)}
            >
              {!props.turnId && <option value="">选择回合</option>}
              {props.turns.map((turn, index) => (
                <option key={turn.id} value={turn.id}>
                  {turn.label === turn.id ? `第 ${props.turns.length - index} 回合` : turn.label}
                  {turn.reference
                    ? ['ready', 'partial'].includes(turn.reference.state)
                      ? ` · ${turn.reference.changeCount} 项变更${turn.reference.state === 'partial' ? '（部分）' : ''}`
                      : ` · ${projectDiffStatus(turn.reference.state)}`
                    : ' · 未记录快照'}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span title={props.title}>当前项目文件</span>
        )}
        <span className="project-source-badge">
          {source === 'cache'
            ? '离线缓存'
            : source === 'host'
              ? '主机读取'
              : props.busy
                ? '读取中'
                : ''}
        </span>
      </div>
      {props.error && (
        <p className="list-error" role="alert">
          {props.error}
        </p>
      )}
      {cacheFailed && (
        <p className="project-partial" role="status">
          本次内容尚未保存到本机缓存。
        </p>
      )}
      {props.busy && (
        <p className="project-loading" role="status">
          正在读取…
        </p>
      )}
      {props.mode === 'tree' && tree && (tree.partial || !tree.enumerationComplete) && (
        <p className="project-partial">目录未完整载入，未列出不表示文件不存在。</p>
      )}
      {props.mode === 'changes' && diff && (diff.partial || diff.state !== 'ready') && (
        <p className="project-partial">
          {diff.state === 'pending'
            ? '回合快照仍在采集，请稍后刷新；当前不能确定变更范围。'
            : diff.state === 'not-recorded'
              ? '此回合未记录快照，不能据此判断是否修改过文件。'
              : `${projectDiffStatus(diff.state)}；未列出的文件不能视为没有变化。`}
        </p>
      )}
      <div className="project-panel-body">
        <details
          className="project-compact-files"
          open={listOpen}
          onToggle={(event) => setListOpen(event.currentTarget.open)}
        >
          <summary>
            <ChevronDown size={14} />
            <span>{props.mode === 'tree' ? directory || '项目根目录' : '变更文件'}</span>
            <small>{props.mode === 'tree' ? children.length : (diff?.changes.length ?? 0)}</small>
          </summary>
          {props.mode === 'tree' ? (
            <nav className="project-file-list" aria-label="项目文件树">
              {directory && (
                <div className="project-breadcrumb">
                  <button
                    type="button"
                    aria-label="返回上级目录"
                    onClick={() =>
                      setDirectory(
                        directory.includes('/')
                          ? directory.slice(0, directory.lastIndexOf('/'))
                          : '',
                      )
                    }
                  >
                    <ArrowLeft size={13} />
                    上级目录
                  </button>
                </div>
              )}
              <ul>
                {children.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      onClick={() =>
                        entry.type === 'directory'
                          ? setDirectory(entry.path)
                          : props.onFile(entry.path, entry.size)
                      }
                      aria-label={`${entry.type === 'directory' ? '打开目录' : '查看文件'}：${entry.path}`}
                      disabled={entry.type !== 'directory' && props.busy}
                      aria-current={
                        props.currentFile?.result.path === entry.path ? 'page' : undefined
                      }
                    >
                      {entry.type === 'directory' ? <Folder /> : <File />}
                      <span>{entry.path.split('/').at(-1)}</span>
                      {entry.type === 'directory' ? (
                        <ChevronRight />
                      ) : (
                        <small>
                          {formatAttachmentSize(entry.size)}
                          {entry.size > CONTENT_LIMITS.fileBytes ? ' · 超限' : ''}
                        </small>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {tree && !children.length && <p className="subtle">此目录暂无已载入的文件。</p>}
              {tree?.nextOffset !== undefined && (
                <button
                  type="button"
                  className="project-load-more"
                  disabled={props.busy}
                  onClick={props.onTreeMore}
                >
                  继续载入目录
                </button>
              )}
            </nav>
          ) : (
            <nav className="project-file-list" aria-label="变更文件列表">
              <ul className="project-change-list">
                {diff?.changes.map((change) => (
                  <li key={change.path}>
                    <button
                      type="button"
                      onClick={() => props.onDiffFile(change)}
                      disabled={props.busy || !diff.reference?.version}
                      aria-current={
                        props.diffFile?.result.path === change.path ? 'page' : undefined
                      }
                    >
                      <span className={`project-change-kind ${change.kind}`}>
                        {changeLabels[change.kind]}
                      </span>
                      <span title={change.path}>
                        {change.previousPath ? `${change.previousPath} → ` : ''}
                        {change.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {diff?.state === 'ready' && !diff.changes.length && !diff.partial && (
                <p className="subtle">已记录范围内没有文件变化。</p>
              )}
            </nav>
          )}
        </details>
        <section
          className="project-file-view"
          aria-label={props.mode === 'tree' ? '文件预览' : '回合变更'}
        >
          {props.mode === 'tree' ? (
            props.currentFile ? (
              <CurrentFilePreview key={currentKey} value={props.currentFile} onQuote={onQuote} />
            ) : props.currentUnavailable ? (
              <>
                <h3>{props.currentUnavailable.path}</h3>
                <p className="project-partial">{props.currentUnavailable.message}</p>
              </>
            ) : (
              <p className="empty">选择文件查看本次读取的内容。</p>
            )
          ) : props.diffFile ? (
            <DiffPreview
              key={diffKey}
              value={props.diffFile}
              expanded={props.expanded}
              onQuote={onQuote}
            />
          ) : (
            <p className="empty">
              {!props.turns.length
                ? '此会话尚无 Agent 回合。'
                : diff?.changes.length
                  ? '选择文件查看该回合的历史快照。'
                  : '选择历史回合，查看已保存的文件变更。'}
            </p>
          )}
          <Issues values={props.mode === 'tree' ? (tree?.issues ?? []) : (diff?.issues ?? [])} />
          <SourceDetails props={props} />
        </section>
      </div>
    </ContentFrame>
  );
});
