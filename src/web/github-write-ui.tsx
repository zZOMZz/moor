import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { paint } from './ui';
import { githubWriteKey, type GithubWriteController, type GithubWriteDraft } from './github-write';
import {
  githubPatchLines,
  GITHUB_WRITE_LIMITS,
  type GithubWriteAction,
} from '../github-write-protocol';
export type GithubWritePanelProps = {
  controller?: GithubWriteController;
  reason?: string;
  location?: string;
  onClose(): void;
  onRefresh(): void;
  onBranches(page: number): void;
  onPull(view: 'files' | 'review-comments', page: number): void;
  onCommit(paths: string[]): void;
  onPush(): void;
  onCreate(
    kind: GithubWriteDraft['kind'],
    values: GithubWriteDraft['values'],
  ): Promise<string | undefined>;
  onDraft(draft: GithubWriteDraft): void;
  onRemove(id: string): void;
  onPrepare(id: string): void;
  onConfirm(): void;
  onCancelReview(): void;
  onInspect(page: number): void;
  onAbandon(): void;
};
const labels: Record<GithubWriteDraft['kind'], string> = {
  'issue-comment': '发布会话评论',
  'review-comment': '发布行评论',
  'review-reply': '回复行评论',
  'pr-create': '创建 PR',
  'pr-update': '编辑 PR 标题与正文',
  'pr-state': '关闭或重开 PR',
  'pr-merge': '合并 PR',
  commit: '提交选中文件',
  push: '推送分支',
};
function Pager({
  value,
  disabled,
  onPage,
}: {
  value: { page: number; partial: boolean; hasNext: boolean };
  disabled: boolean;
  onPage(page: number): void;
}) {
  return (
    <div className="github-pagination">
      <span>
        第 {value.page} 页{value.partial ? ' · 仅返回部分内容' : ''}
      </span>
      <button disabled={disabled || value.page <= 1} onClick={() => onPage(value.page - 1)}>
        上一页
      </button>
      <button
        disabled={disabled || !value.hasNext || value.page >= 100}
        onClick={() => onPage(value.page + 1)}
      >
        下一页
      </button>
      {value.hasNext && value.page >= 100 && <span>达到读取上限，剩余内容未读取。</span>}
    </div>
  );
}
function DraftEditor({
  draft,
  disabled,
  onDraft,
  onReview,
  onRemove,
}: {
  draft: GithubWriteDraft;
  disabled: boolean;
  onDraft(d: GithubWriteDraft): void;
  onReview(): void;
  onRemove(): void;
}) {
  const [values, setValues] = useState(draft.values);
  const change = (name: string, value: string | boolean) => {
    const next = { ...values, [name]: value };
    setValues(next);
    onDraft({ ...draft, values: next });
  };
  const body = [
    'issue-comment',
    'review-comment',
    'review-reply',
    'pr-create',
    'pr-update',
  ].includes(draft.kind);
  return (
    <section className="github-write-editor">
      <h3>手工草稿 · {labels[draft.kind]}</h3>
      <p>编辑内容保存在这份会话的本机草稿中，离线不会发布。</p>
      {values.number && (
        <p>
          {values.subject === 'issue' ? 'Issue' : 'PR'} #{String(values.number)}
          {values.path
            ? ` · ${values.path} · ${values.side === 'LEFT' ? '原文件' : '新文件'} 第 ${values.line} 行`
            : ''}
          {values.commentId ? ` · 回复评论 ${values.commentId}` : ''}
        </p>
      )}
      {['pr-create', 'pr-update'].includes(draft.kind) && (
        <label>
          标题
          <input
            value={String(values.title ?? '')}
            maxLength={500}
            disabled={disabled}
            onChange={(e) => change('title', e.target.value)}
          />
        </label>
      )}
      {body && (
        <label>
          待发布正文
          <textarea
            value={String(values.body ?? '')}
            maxLength={12000}
            disabled={disabled}
            onChange={(e) => change('body', e.target.value)}
          />
        </label>
      )}
      {draft.kind === 'pr-create' && (
        <>
          <p>
            来源分支 {String(values.headBranch)} → 目标分支 {String(values.baseBranch)}
          </p>
          <label>
            <input
              type="checkbox"
              checked={values.draft === true}
              disabled={disabled}
              onChange={(e) => change('draft', e.target.checked)}
            />
            创建为 Draft PR
          </label>
        </>
      )}
      {draft.kind === 'pr-state' && (
        <p>
          将 PR #{String(values.number)} {values.state === 'open' ? '重新打开' : '关闭'}。
        </p>
      )}
      {draft.kind === 'pr-merge' && (
        <label>
          合并方式
          <select
            value={String(values.method ?? 'merge')}
            disabled={disabled}
            onChange={(e) => change('method', e.target.value)}
          >
            <option value="merge">Merge commit</option>
            <option value="squash">Squash</option>
            <option value="rebase">Rebase</option>
          </select>
        </label>
      )}
      {draft.kind === 'commit' && (
        <>
          <p>选中文件：{(values.paths as string[]).join('、')}</p>
          <label>
            提交说明
            <textarea
              value={String(values.message ?? '')}
              maxLength={8000}
              disabled={disabled}
              onChange={(e) => change('message', e.target.value)}
            />
          </label>
          <label>
            提交作者姓名
            <input
              value={String(values.authorName ?? '')}
              disabled={disabled}
              maxLength={100}
              onChange={(e) => change('authorName', e.target.value)}
            />
          </label>
          <label>
            提交作者邮箱
            <input
              type="email"
              value={String(values.authorEmail ?? '')}
              disabled={disabled}
              maxLength={200}
              onChange={(e) => change('authorEmail', e.target.value)}
            />
          </label>
        </>
      )}
      {draft.kind === 'push' && (
        <p>
          推送分支 {String(values.branch)}；提交 {String(values.headOid)}。
        </p>
      )}
      <button disabled={disabled} onClick={onReview}>
        审查本次操作
      </button>
      <button disabled={disabled} onClick={onRemove}>
        删除这份草稿
      </button>
    </section>
  );
}
function Review({
  request,
  controller,
  disabled,
  onConfirm,
  onCancel,
}: {
  request: GithubWriteAction;
  controller: GithubWriteController;
  disabled: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const verb =
    request.action === 'pr-state'
      ? request.state === 'open'
        ? '重新打开 PR'
        : '关闭 PR'
      : labels[request.action];
  return (
    <section className="github-write-confirm" role="region" aria-label="最终写入确认">
      <h3>确认{verb}</h3>
      {'repositoryId' in request && (
        <p>
          GitHub 仓库：{controller.overview?.repository?.owner}/
          {controller.overview?.repository?.name} · 编号 {request.repositoryId}
        </p>
      )}
      {'number' in request && (
        <p>
          {'subject' in request && request.subject === 'issue' ? 'Issue' : 'PR'} #{request.number}
        </p>
      )}
      {'headSha' in request && <code>来源提交 {request.headSha}</code>}
      {'baseSha' in request && <code>目标提交 {request.baseSha}</code>}
      {'path' in request && (
        <p>
          {request.path} · {request.side === 'LEFT' ? '原文件' : '新文件'} 第 {request.line} 行
        </p>
      )}
      {'commentId' in request && <p>回复评论编号 {request.commentId}</p>}
      {'title' in request && <h4>{request.title}</h4>}
      {'body' in request && <pre className="github-body">{request.body || '（空正文）'}</pre>}
      {request.action === 'pr-create' && (
        <p>
          {request.headBranch} → {request.baseBranch} · {request.draft ? 'Draft PR' : '普通 PR'}
        </p>
      )}
      {['pr-create', 'pr-update'].includes(request.action) && (
        <p>GitHub 不提供原子版本条件。提交和版本会在发送前检查，但发布期间仍可能发生其他编辑。</p>
      )}
      {request.action === 'pr-merge' && <p>合并方式：{request.method}。仅请求合并以上来源提交。</p>}
      {request.action === 'commit' && (
        <>
          <p>本地分支 {request.branch}</p>
          <code>父提交 {request.parentOid}</code>
          <p>
            作者 {request.author.name} &lt;{request.author.email}&gt;
          </p>
          <pre className="github-body">{request.message}</pre>
          <ul>
            {request.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          {controller.commitPreview?.files.map((file) => (
            <details key={file.path}>
              <summary>
                {file.path} · {file.kind} · {file.byteLength} B
              </summary>
              {file.binary ? (
                <p>二进制文件，无文本预览。</p>
              ) : (
                <>
                  <h4>提交前</h4>
                  <pre className="github-body">{file.beforeText ?? '（无文本）'}</pre>
                  <h4>提交后</h4>
                  <pre className="github-body">{file.afterText ?? '（无文本）'}</pre>
                </>
              )}
              {file.truncated && <p>文本预览已截断，提交会包含该文件的全部已选版本。</p>}
            </details>
          ))}
        </>
      )}
      {request.action === 'push' && (
        <>
          <p>本地分支 {request.branch} → 同名远端分支</p>
          <code>推送提交 {request.headOid}</code>
          <code>预期远端 {request.expectedRemoteOid ?? '分支尚不存在'}</code>
          <p>不会强制覆盖远端历史。</p>
        </>
      )}
      <button disabled={disabled} onClick={onConfirm}>
        确认{verb}
      </button>
      <button disabled={disabled} onClick={onCancel}>
        返回修改
      </button>
    </section>
  );
}
export function GithubWritePanel(p: GithubWritePanelProps) {
  const c = p.controller,
    [draftId, setDraftId] = useState(''),
    [paths, setPaths] = useState<string[]>([]),
    [head, setHead] = useState(''),
    [base, setBase] = useState(''),
    [inspectPage, setInspectPage] = useState(1),
    [openFile, setOpenFile] = useState(''),
    [diffPage, setDiffPage] = useState(1),
    [endConfirmed, setEndConfirmed] = useState('');
  const busy = !!(p.reason || !c?.loaded || c.busy || c.loadError),
    blocked = busy || !!c?.pending,
    detail = c?.detail,
    overview = c?.overview,
    remote = !!overview?.writesEnabled;
  const create = async (kind: GithubWriteDraft['kind'], values: GithubWriteDraft['values']) => {
    const id = await p.onCreate(kind, values);
    if (id) setDraftId(id);
  };
  const target = detail
    ? {
        number: detail.item.number,
        expectedVersion: detail.item.version,
        ...(detail.view === 'pull'
          ? { headSha: detail.item.head.sha, baseSha: detail.item.base.sha }
          : {}),
      }
    : {};
  return (
    <Dialog.Root open onOpenChange={(open) => !open && p.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog github-write-panel">
          <div className="github-heading">
            <Dialog.Title>审查、评论与代码发布</Dialog.Title>
            <button aria-label="关闭写入面板" onClick={p.onClose}>
              <X size={18} />
            </button>
          </div>
          <Dialog.Description>
            每次写入先保存草稿、审查具体目标，再由你明确确认。读取、同步和重新连接不会发布内容或运行
            Agent。
          </Dialog.Description>
          {p.location && <p>执行电脑：{p.location}</p>}
          {p.reason && <p role="status">{p.reason}</p>}
          {c?.loadError && <p role="alert">{c.loadError}</p>}
          {c?.error && <p role="alert">{c.error}</p>}
          {c?.pending && (
            <section className="github-write-pending">
              <h3>{labels[c.pending.request.action]} · 等待核查</h3>
              <p>原请求已保留。核查只查询结果，不会重新执行外部写入。</p>
              <label>
                核查页码
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={inspectPage}
                  disabled={busy}
                  onChange={(e) => setInspectPage(Number(e.target.value))}
                />
              </label>
              <button
                disabled={busy || inspectPage < 1 || inspectPage > 100}
                onClick={() => p.onInspect(inspectPage)}
              >
                核查原操作结果
              </button>
              <label>
                <input
                  type="checkbox"
                  checked={endConfirmed === c.pending.request.operationId}
                  disabled={busy}
                  onChange={(e) =>
                    setEndConfirmed(e.target.checked ? c.pending!.request.operationId : '')
                  }
                />
                结束核查；若远端已开始执行，其结果仍可能未知
              </label>
              <button
                disabled={busy || endConfirmed !== c.pending.request.operationId}
                onClick={p.onAbandon}
              >
                结束原操作核查
              </button>
            </section>
          )}
          {c?.receipt && (
            <p role="status">
              {c.receipt.phase === 'accepted'
                ? '主机已确认操作成功'
                : c.receipt.phase === 'abandoned'
                  ? '主机确认原请求未执行'
                  : c.receipt.phase === 'rejected'
                    ? '主机已拒绝原操作'
                    : '远端结果仍未知'}{' '}
              · {c.receipt.message}
              {c.receipt.result?.number ? ` · #${c.receipt.result.number}` : ''}
              {c.receipt.result?.sha && <code>{c.receipt.result.sha}</code>}
              {c.receipt.phase === 'accepted' &&
                c.receipt.action === 'commit' &&
                !overview &&
                ' · 目录摘要已过期，请手动重新读取目录。'}
              {c.receipt.phase === 'accepted' &&
                c.receipt.action === 'push' &&
                !c.pushPreview &&
                ' · 推送状态已过期，请手动重新读取推送状态。'}
            </p>
          )}
          <button disabled={busy} onClick={p.onRefresh}>
            重新读取发布能力与目录
          </button>
          {overview && (
            <>
              <p>
                {overview.repository
                  ? `${overview.repository.owner}/${overview.repository.name} · 仓库编号 ${overview.repository.id}`
                  : '未配置 GitHub 仓库'}{' '}
                · {remote ? '已启用远端写入' : '远端写入未启用'}
              </p>
              {overview.reason && <p>{overview.reason}</p>}
              <p>
                {overview.execution.mode === 'worktree' ? '独立工作目录' : '项目原目录'} · 本地分支{' '}
                {overview.git.branch || '不可用'}
                <code>{overview.git.headOid}</code>
              </p>
            </>
          )}
          {c?.review ? (
            <Review
              request={c.review.request}
              controller={c}
              disabled={blocked}
              onConfirm={p.onConfirm}
              onCancel={p.onCancelReview}
            />
          ) : (
            <>
              {detail && (
                <section>
                  <h3>
                    {detail.view === 'issue' ? 'Issue' : 'PR'} #{detail.item.number} ·{' '}
                    {detail.item.title}
                  </h3>
                  {detail.view === 'pull' && (
                    <>
                      <p>
                        来源{' '}
                        {detail.item.head.repository
                          ? `${detail.item.head.repository.owner}/${detail.item.head.repository.name}`
                          : '仓库不可用'}{' '}
                        / {detail.item.head.branch}
                        <code>{detail.item.head.sha}</code>
                      </p>
                      <p>
                        目标 {detail.item.base.repository.owner}/{detail.item.base.repository.name}{' '}
                        / {detail.item.base.branch}
                        <code>{detail.item.base.sha}</code>
                      </p>
                      <button disabled={busy} onClick={() => p.onPull('files', 1)}>
                        读取 PR 文件 Diff
                      </button>
                      <button disabled={busy} onClick={() => p.onPull('review-comments', 1)}>
                        手动同步行评论
                      </button>
                    </>
                  )}
                  <button
                    disabled={blocked || !remote}
                    onClick={() =>
                      void create('issue-comment', {
                        ...target,
                        subject: detail.item.kind,
                        body: '',
                      })
                    }
                  >
                    编写会话评论
                  </button>
                  {detail.view === 'pull' && (
                    <>
                      <button
                        disabled={
                          blocked ||
                          !remote ||
                          detail.item.bodyTruncated ||
                          detail.item.body.length > GITHUB_WRITE_LIMITS.body
                        }
                        onClick={() =>
                          void create('pr-update', {
                            ...target,
                            title: detail.item.title,
                            body: detail.item.body,
                          })
                        }
                      >
                        使用当前 PR 内容创建编辑草稿
                      </button>
                      {(detail.item.bodyTruncated ||
                        detail.item.body.length > GITHUB_WRITE_LIMITS.body) && (
                        <p>
                          PR 正文未完整读取，或超过 {GITHUB_WRITE_LIMITS.body}{' '}
                          字符写入上限，不能在此覆盖编辑。请在 GitHub 编辑完整正文。
                        </p>
                      )}
                      <button
                        disabled={blocked || !remote || detail.item.state === 'merged'}
                        onClick={() =>
                          void create('pr-state', {
                            ...target,
                            state: detail.item.state === 'open' ? 'closed' : 'open',
                          })
                        }
                      >
                        {detail.item.state === 'open' ? '准备关闭 PR' : '准备重新打开 PR'}
                      </button>
                      <button
                        disabled={
                          blocked ||
                          !remote ||
                          detail.item.state !== 'open' ||
                          detail.item.draft === true
                        }
                        onClick={() => void create('pr-merge', { ...target, method: 'merge' })}
                      >
                        准备合并 PR
                      </button>
                    </>
                  )}
                  {c?.files && (
                    <section>
                      <Pager
                        value={c.files.result}
                        disabled={busy}
                        onPage={(page) => p.onPull('files', page)}
                      />
                      {c.files.result.items.map((file) => {
                        const rows = openFile === file.path ? githubPatchLines(file) : [];
                        return (
                          <details
                            className="github-write-file"
                            key={file.path}
                            open={openFile === file.path}
                          >
                            <summary
                              onClick={(event) => {
                                event.preventDefault();
                                setOpenFile(openFile === file.path ? '' : file.path);
                                setDiffPage(1);
                              }}
                            >
                              {file.previousPath ? `${file.previousPath} → ` : ''}
                              {file.path} · +{file.additions} −{file.deletions}
                            </summary>
                            {openFile === file.path &&
                              (rows.length ? (
                                <div className="github-write-diff">
                                  {rows.length > 400 && (
                                    <nav>
                                      <span>
                                        Diff 第 {diffPage} 段 / {Math.ceil(rows.length / 400)}
                                      </span>
                                      <button
                                        disabled={diffPage <= 1}
                                        onClick={() => setDiffPage(diffPage - 1)}
                                      >
                                        上一段
                                      </button>
                                      <button
                                        disabled={diffPage * 400 >= rows.length}
                                        onClick={() => setDiffPage(diffPage + 1)}
                                      >
                                        下一段
                                      </button>
                                    </nav>
                                  )}
                                  {rows
                                    .slice((diffPage - 1) * 400, diffPage * 400)
                                    .map((row, index) => (
                                      <div className={`diff-${row.kind}`} key={index}>
                                        {row.oldLine ? (
                                          <button
                                            disabled={blocked || !remote}
                                            aria-label={`评论 ${file.path} 原文件第 ${row.oldLine} 行`}
                                            onClick={() =>
                                              void create('review-comment', {
                                                ...target,
                                                filePage: c.files!.result.page,
                                                path: file.path,
                                                fileVersion: file.version,
                                                side: 'LEFT',
                                                line: row.oldLine!,
                                                body: '',
                                              })
                                            }
                                          >
                                            {row.oldLine}
                                          </button>
                                        ) : (
                                          <span />
                                        )}
                                        {row.newLine ? (
                                          <button
                                            disabled={blocked || !remote}
                                            aria-label={`评论 ${file.path} 新文件第 ${row.newLine} 行`}
                                            onClick={() =>
                                              void create('review-comment', {
                                                ...target,
                                                filePage: c.files!.result.page,
                                                path: file.path,
                                                fileVersion: file.version,
                                                side: 'RIGHT',
                                                line: row.newLine!,
                                                body: '',
                                              })
                                            }
                                          >
                                            {row.newLine}
                                          </button>
                                        ) : (
                                          <span />
                                        )}
                                        <pre>{row.text}</pre>
                                      </div>
                                    ))}
                                </div>
                              ) : (
                                <p>
                                  {file.patchTruncated
                                    ? 'Diff 已截断。'
                                    : '未返回可验证的文本 Diff。'}
                                  不能选择评论行。
                                </p>
                              ))}
                          </details>
                        );
                      })}
                    </section>
                  )}
                  {c?.comments && (
                    <section>
                      <h3>行评论线程</h3>
                      <Pager
                        value={c.comments.result}
                        disabled={busy}
                        onPage={(page) => p.onPull('review-comments', page)}
                      />
                      {!c.comments.result.items.length && (
                        <p>本页未返回评论{c.comments.result.partial ? '，读取不完整' : ''}。</p>
                      )}
                      {c.comments.result.items.map((comment) => (
                        <article key={comment.id}>
                          <p>
                            {comment.author} · {comment.path} ·{' '}
                            {comment.line === null ? '旧版本评论' : `第 ${comment.line} 行`}
                            {comment.replyTo ? ` · 回复 ${comment.replyTo}` : ''}
                          </p>
                          <pre className="github-body">{comment.body}</pre>
                          {!comment.replyTo && (
                            <button
                              disabled={blocked || !remote}
                              onClick={() =>
                                void create('review-reply', {
                                  ...target,
                                  commentId: comment.id,
                                  commentVersion: comment.version,
                                  commentPage: c.comments!.result.page,
                                  body: '',
                                })
                              }
                            >
                              回复评论 {comment.id}
                            </button>
                          )}
                        </article>
                      ))}
                    </section>
                  )}
                </section>
              )}
              {overview?.repository && (
                <section>
                  <h3>创建 PR</h3>
                  <button disabled={busy} onClick={() => p.onBranches(1)}>
                    读取可用远端分支
                  </button>
                  {c?.branches && (
                    <Pager value={c.branches.result} disabled={busy} onPage={p.onBranches} />
                  )}
                  <label>
                    来源分支
                    <select
                      value={head}
                      disabled={blocked}
                      onChange={(e) => setHead(e.target.value)}
                    >
                      <option value="">明确选择来源</option>
                      {c?.branchChoices.map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name} · {v.sha.slice(0, 12)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    目标分支
                    <select
                      value={base}
                      disabled={blocked}
                      onChange={(e) => setBase(e.target.value)}
                    >
                      <option value="">明确选择目标</option>
                      {c?.branchChoices.map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name} · {v.sha.slice(0, 12)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={
                      blocked ||
                      !remote ||
                      !head ||
                      !base ||
                      head === base ||
                      !c?.branch(head) ||
                      !c?.branch(base)
                    }
                    onClick={() =>
                      void create('pr-create', {
                        headBranch: head,
                        baseBranch: base,
                        headSha: c!.branch(head)!.sha,
                        baseSha: c!.branch(base)!.sha,
                        headPage: c!.branch(head)!.page,
                        basePage: c!.branch(base)!.page,
                        title: '',
                        body: '',
                        draft: true,
                      })
                    }
                  >
                    编写新 PR 草稿
                  </button>
                </section>
              )}
              {overview && (
                <section>
                  <h3>本地提交与推送</h3>
                  <p>只提交明确选择的文件版本。选择文件和查看预览不会修改暂存区。</p>
                  {overview.git.partial && <p>目录状态仅部分读取，不能视为完整改动列表。</p>}
                  {overview.git.changes.map((file) => {
                    const selection = [
                      ...(file.previousPath ? [file.previousPath] : []),
                      file.path,
                    ];
                    return (
                      <label key={file.path}>
                        <input
                          type="checkbox"
                          disabled={blocked || !overview.canCommit}
                          checked={selection.every((path) => paths.includes(path))}
                          onChange={(e) =>
                            setPaths((old) =>
                              e.target.checked
                                ? [...new Set([...old, ...selection])]
                                : old.filter((path) => !selection.includes(path)),
                            )
                          }
                        />
                        {file.previousPath ? `${file.previousPath} → ` : ''}
                        {file.path} · {file.index}
                        {file.worktree}
                      </label>
                    );
                  })}
                  <button
                    disabled={blocked || !overview.canCommit || !paths.length}
                    onClick={() => p.onCommit(paths)}
                  >
                    预览选中文件
                  </button>
                  {c?.commitPreview && (
                    <>
                      <p>
                        已预览 {c.commitPreview.files.length} 个文件，父提交{' '}
                        {c.commitPreview.parentOid}
                      </p>
                      <button
                        disabled={blocked}
                        onClick={() =>
                          void create('commit', {
                            paths: c.commitPreview!.files.map((f) => f.path),
                            message: '',
                            authorName: '',
                            authorEmail: '',
                          })
                        }
                      >
                        编写提交说明
                      </button>
                    </>
                  )}
                  <button
                    disabled={blocked || !remote || !overview.git.branch || !overview.git.headOid}
                    onClick={p.onPush}
                  >
                    查看当前分支推送目标
                  </button>
                  {c?.pushPreview && (
                    <>
                      <p>
                        {c.pushPreview.branch} · 本地 {c.pushPreview.headOid} → 远端{' '}
                        {c.pushPreview.expectedRemoteOid ?? '尚不存在'}
                      </p>
                      {c.pushPreview.reason && <p>{c.pushPreview.reason}</p>}
                      <button
                        disabled={blocked || !c.pushPreview.canPush}
                        onClick={() =>
                          void create('push', {
                            branch: c.pushPreview!.branch,
                            headOid: c.pushPreview!.headOid,
                            expectedRemoteOid: c.pushPreview!.expectedRemoteOid,
                          })
                        }
                      >
                        准备推送这次提交
                      </button>
                    </>
                  )}
                </section>
              )}
            </>
          )}
          {!!c && Object.keys(c.drafts).length > 0 && (
            <section>
              <label>
                已保存的手工草稿
                <select
                  value={draftId}
                  onChange={(e) => {
                    setDraftId(e.target.value);
                    p.onCancelReview();
                  }}
                >
                  <option value="">选择草稿</option>
                  {Object.values(c.drafts).map((draft) => (
                    <option key={draft.id} value={draft.id}>
                      {labels[draft.kind]}
                      {draft.values.number ? ` #${draft.values.number}` : ''}
                      {draft.values.path ? ` · ${draft.values.path}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              {c.drafts[draftId] && !c.review && (
                <DraftEditor
                  key={draftId}
                  draft={c.drafts[draftId]}
                  disabled={!!c.pending || c.busy || !!c.loadError}
                  onDraft={p.onDraft}
                  onReview={() => p.onPrepare(draftId)}
                  onRemove={() => p.onRemove(draftId)}
                />
              )}
            </section>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showGithubWritePanel(props?: GithubWritePanelProps) {
  paint(
    '#github-write-view',
    props ? (
      <GithubWritePanel
        key={props.controller ? githubWriteKey(props.controller.target) : 'loading'}
        {...props}
      />
    ) : null,
  );
}
