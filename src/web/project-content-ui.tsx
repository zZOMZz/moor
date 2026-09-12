import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import {
  ArrowLeft,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  GitCompareArrows,
  RefreshCw,
  X,
} from 'lucide-react';
import { CONTENT_LIMITS } from '../content-protocol';
import type {
  ProjectContentIssue,
  ProjectDiffChange,
  ProjectDiffFileResult,
  ProjectDiffReference,
  ProjectTreeResult,
  ProjectTurnDiffResult,
} from '../project-content-protocol';
import type { FileContentView } from './file-content';
import { compareTextLines, type ProjectContentView } from './project-content';
import { formatAttachmentSize } from './attachments';
import { markdown } from './content';
import { paint } from './ui';

export type ProjectTurnChoice = { id: string; label: string; reference?: ProjectDiffReference };
export type ProjectContentPanelProps = {
  title: string;
  mode: 'tree' | 'changes';
  busy?: boolean;
  error?: string;
  tree?: ProjectContentView<ProjectTreeResult>;
  currentFile?: FileContentView;
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
function ContentText({
  text,
  path,
  plain = false,
}: {
  text: string;
  path: string;
  plain?: boolean;
}) {
  const [raw, setRaw] = useState(plain);
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
    setRaw(plain);
  }, [path, plain]);
  const visible = expanded ? text : text.slice(0, 120_000);
  return (
    <>
      {isMarkdown && !plain && (
        <div className="project-file-format">
          <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
            Markdown
          </button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
            源文本
          </button>
        </div>
      )}
      {isMarkdown && !raw ? (
        <div className="project-markdown" dangerouslySetInnerHTML={{ __html: markdown(visible) }} />
      ) : (
        <pre className="project-file-text">{visible || '（空文件）'}</pre>
      )}
      {!expanded && visible.length < text.length && (
        <button type="button" onClick={() => setExpanded(true)}>
          预览已截断，显示完整文本
        </button>
      )}
    </>
  );
}
function FrozenFile({ value, label }: { value: ProjectDiffFileResult['before']; label: string }) {
  return (
    <section className="project-frozen-file">
      <h4>{label}</h4>
      {!value ? (
        <p className="subtle">该侧文件不存在。</p>
      ) : (
        <>
          <p className="project-file-descriptor">
            {value.path} · {formatAttachmentSize(value.size)}
            {value.version ? ` · ${value.version.slice(7, 19)}` : ''}
          </p>
          {value.state === 'text' && value.text !== undefined ? (
            <ContentText path={value.path} text={value.text} plain />
          ) : (
            <p className="subtle">
              {value.state === 'binary'
                ? '二进制文件，已保存内容摘要，不提供文本预览。'
                : value.state === 'oversize'
                  ? '文件超过 1 MiB，未保存文本基线。'
                  : '该文件基线不可读取，不能推断内容未变化。'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
function DiffPreview({ value }: { value: ProjectContentView<ProjectDiffFileResult> }) {
  const [format, setFormat] = useState<'diff' | 'sides'>('diff');
  const { before, after } = value.result;
  const textOnly = (!before || before.state === 'text') && (!after || after.state === 'text');
  const lines = useMemo(
    () => (textOnly ? compareTextLines(before?.text ?? '', after?.text ?? '') : undefined),
    [before, after, textOnly],
  );
  return (
    <div className="project-diff-preview">
      <h3>{value.result.path}</h3>
      <p className="project-file-descriptor">
        已保存的回合前后版本{value.source === 'cache' ? ' · 离线缓存' : ' · 主机已确认'} ·{' '}
        {value.result.reference.version?.slice(7, 19)}
      </p>
      {textOnly && lines && (
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
      {format === 'diff' && lines ? (
        <div className="project-lines" aria-label="已保存文件的逐行变更">
          {lines.map((line, index) => (
            <div key={index} className={`project-diff-line ${line.kind}`}>
              <span className="project-line-number">{line.before ?? ''}</span>
              <span className="project-line-number">{line.after ?? ''}</span>
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
          {textOnly && !lines && <p className="subtle">文本较长，直接展示已保存的前后版本。</p>}
          <div className="project-diff-sides">
            <FrozenFile value={before} label="修改前" />
            <FrozenFile value={after} label="修改后" />
          </div>
        </>
      )}
      {value.result.partial && (
        <p className="project-partial">此文件所在回合的基线不完整，显示范围以已保存内容为准。</p>
      )}
      <Issues values={value.result.issues} />
    </div>
  );
}
const changeLabels = { added: '新增', deleted: '删除', modified: '修改', renamed: '重命名' };
export function ProjectContentPanel(props: ProjectContentPanelProps) {
  const [directory, setDirectory] = useState('');
  const tree = props.tree?.result;
  useEffect(() => {
    if (
      directory &&
      tree &&
      !tree.entries.some((entry) => entry.type === 'directory' && entry.path === directory)
    )
      setDirectory('');
  }, [tree?.version]);
  const children =
    tree?.entries
      .filter((entry) => {
        const parent = entry.path.includes('/')
          ? entry.path.slice(0, entry.path.lastIndexOf('/'))
          : '';
        return parent === directory;
      })
      .sort((a, b) =>
        a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'directory' ? -1 : 1,
      ) ?? [];
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog project-content-panel">
          <div className="project-panel-heading">
            <div>
              <Dialog.Title>{props.mode === 'tree' ? '项目文件' : '会话变更'}</Dialog.Title>
              <Dialog.Description>{props.title}</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="关闭文件与变更">
              <X />
            </Dialog.Close>
          </div>
          <div className="project-panel-tabs">
            <button
              type="button"
              aria-pressed={props.mode === 'tree'}
              onClick={() => props.onMode('tree')}
            >
              <FolderOpen />
              当前项目文件
            </button>
            <button
              type="button"
              aria-pressed={props.mode === 'changes'}
              onClick={() => props.onMode('changes')}
            >
              <GitCompareArrows />
              历史变更
            </button>
            <button
              type="button"
              disabled={props.busy}
              onClick={props.onRefresh}
              aria-label="重新读取文件或变更"
            >
              <RefreshCw />
            </button>
          </div>
          <p className="project-attribution">
            扫描可能包含外部编辑器或其他会话的修改，不表示仅由当前 Agent 产生。
          </p>
          {props.error && (
            <p className="list-error" role="alert">
              {props.error}
            </p>
          )}
          {props.busy && (
            <p className="project-loading" role="status">
              正在读取…
            </p>
          )}
          <div className="project-panel-body">
            {props.mode === 'tree' ? (
              <>
                <nav className="project-file-list" aria-label="项目文件树">
                  {tree && (
                    <>
                      <p className="project-source">
                        {props.tree?.source === 'cache' ? '上次读取的目录缓存' : '主机当前目录'} ·
                        已载入 {tree.entries.length}/{tree.total} 项
                      </p>
                      {(tree.partial || !tree.enumerationComplete) && (
                        <p className="project-partial">
                          当前目录列表经过筛选或未完整扫描，未列出不表示文件不存在。
                        </p>
                      )}
                      <Issues values={tree.issues} />
                      <div className="project-breadcrumb">
                        <button
                          type="button"
                          disabled={!directory}
                          onClick={() =>
                            setDirectory(
                              directory.includes('/')
                                ? directory.slice(0, directory.lastIndexOf('/'))
                                : '',
                            )
                          }
                          aria-label="返回上级目录"
                        >
                          <ArrowLeft />
                        </button>
                        <span>{directory || '项目根目录'}</span>
                      </div>
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
                      {!children.length && (
                        <p className="subtle">
                          此目录暂无已载入的文件。{tree.nextOffset ? '可继续载入目录。' : ''}
                        </p>
                      )}
                      {tree.nextOffset !== undefined && (
                        <button
                          type="button"
                          className="project-load-more"
                          disabled={props.busy}
                          onClick={props.onTreeMore}
                        >
                          继续载入目录
                        </button>
                      )}
                    </>
                  )}
                </nav>
                <section className="project-file-view" aria-label="文件预览">
                  {props.currentFile ? (
                    <>
                      <h3>{props.currentFile.result.path}</h3>
                      <p className="project-file-descriptor">
                        {props.currentFile.source === 'cache'
                          ? '已缓存文件版本 · 不代表当前主机内容'
                          : '当前主机文件 · 以本次读取为准'}{' '}
                        · {formatAttachmentSize(props.currentFile.result.content.byteLength)} ·{' '}
                        {props.currentFile.result.content.version.slice(7, 19)}
                      </p>
                      {props.currentFile.text !== undefined ? (
                        <ContentText
                          path={props.currentFile.result.path}
                          text={props.currentFile.text}
                        />
                      ) : (
                        <p className="subtle">二进制文件，不提供文本预览。</p>
                      )}
                    </>
                  ) : props.currentUnavailable ? (
                    <>
                      <h3>{props.currentUnavailable.path}</h3>
                      <p className="subtle">{props.currentUnavailable.message}</p>
                    </>
                  ) : (
                    <p className="empty">
                      选择一个文件查看内容。这里读取当前项目，不是历史回合的文件基线。
                    </p>
                  )}
                </section>
              </>
            ) : (
              <>
                <nav className="project-turn-list" aria-label="会话各回合变更">
                  <p className="project-source">按回合保存的项目变化</p>
                  <ul>
                    {props.turns.map((turn) => (
                      <li key={turn.id}>
                        <button
                          type="button"
                          aria-current={props.turnId === turn.id ? 'page' : undefined}
                          onClick={() => props.onTurn(turn.id)}
                        >
                          <span>{turn.label}</span>
                          <small>
                            {turn.reference
                              ? projectDiffStatus(turn.reference.state)
                              : '尚无基线记录'}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!props.turns.length && <p className="subtle">这个会话尚无 Agent 回合可查看。</p>}
                </nav>
                <section className="project-file-view" aria-label="回合变更">
                  {props.diff ? (
                    <>
                      <h3>
                        {projectDiffStatus(props.diff.result.state)}
                        {props.diff.source === 'cache' ? ' · 离线缓存' : ''}
                      </h3>
                      <p className="project-file-descriptor">
                        已保存的回合基线，不随后续项目文件变化。
                      </p>
                      {(props.diff.result.partial || props.diff.result.state !== 'ready') && (
                        <p className="project-partial">
                          {props.diff.result.state === 'pending'
                            ? '回合仍在采集基线；请稍后手动刷新，当前不能确定变更范围。'
                            : props.diff.result.state === 'not-recorded'
                              ? '此回合没有保存文件基线，不能据此判断是否修改过文件。'
                              : '基线不完整或不可用，未列出的文件不能视为没有变化。'}
                        </p>
                      )}
                      <Issues values={props.diff.result.issues} />
                      <ul className="project-change-list">
                        {props.diff.result.changes.map((change) => (
                          <li key={change.path}>
                            <button
                              type="button"
                              onClick={() => props.onDiffFile(change)}
                              disabled={!props.diff?.result.reference?.version}
                            >
                              <span className={`project-change-kind ${change.kind}`}>
                                {changeLabels[change.kind]}
                              </span>
                              <span>
                                {change.previousPath ? `${change.previousPath} → ` : ''}
                                {change.path}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                      {!props.diff.result.changes.length &&
                        props.diff.result.state === 'ready' &&
                        !props.diff.result.partial && (
                          <p className="subtle">在已记录的扫描范围内未检测到文件变化。</p>
                        )}
                      {props.diffFile && (
                        <DiffPreview key={props.diffFile.result.path} value={props.diffFile} />
                      )}
                    </>
                  ) : (
                    !props.busy && <p className="empty">选择一个回合，查看已经保存的文件变更。</p>
                  )}
                </section>
              </>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showProjectContentPanel(props?: ProjectContentPanelProps) {
  paint('#project-content-view', props ? <ProjectContentPanel {...props} /> : null);
}
export function showProjectContentControls(props?: {
  tree: boolean;
  changes: boolean;
  onTree(): void;
  onChanges(): void;
}) {
  paint(
    '#project-content-controls',
    props ? (
      <div className="project-content-controls">
        <button
          type="button"
          aria-label="项目文件"
          disabled={!props.tree}
          title={!props.tree ? '执行电脑需要报告文件树能力' : '查看当前项目文件'}
          onClick={props.onTree}
        >
          <FolderOpen />
          <span>项目文件</span>
        </button>
        <button
          type="button"
          aria-label="会话变更"
          disabled={!props.changes}
          title={!props.changes ? '执行电脑需要报告历史变更能力' : '查看按回合保存的变化'}
          onClick={props.onChanges}
        >
          <GitCompareArrows />
          <span>会话变更</span>
        </button>
      </div>
    ) : null,
  );
}
