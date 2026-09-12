import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { GitPullRequest, X } from 'lucide-react';
import { paint } from './ui';
import { githubKey, safeGithubLink, type GithubController } from './github';
import type { GithubPage, GithubRepository } from '../github-protocol';

type PageInfo = Pick<GithubPage<unknown>, 'page' | 'hasNext' | 'partial'>;
function Pages({
  value,
  busy,
  onPage,
}: {
  value: PageInfo;
  busy: boolean;
  onPage(page: number): void;
}) {
  return (
    <div className="github-pagination">
      <span>
        第 {value.page} 页{value.partial ? ' · 部分内容未读取' : ''}
      </span>
      <button disabled={busy || value.page <= 1} onClick={() => onPage(value.page - 1)}>
        上一页
      </button>
      <button
        disabled={busy || !value.hasNext || value.page >= 100}
        onClick={() => onPage(value.page + 1)}
      >
        下一页
      </button>
      {value.page >= 100 && value.hasNext && <p>列表达到读取上限，请在 GitHub 查看其余内容。</p>}
    </div>
  );
}
function Link({
  url,
  repository,
  children,
}: {
  url: string;
  repository: Pick<GithubRepository, 'owner' | 'name'>;
  children: React.ReactNode;
}) {
  const href = safeGithubLink(url, repository);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}
export type GithubPanelProps = {
  controller?: GithubController;
  reason?: string;
  canAdd: boolean;
  adding?: boolean;
  onClose(): void;
  onRefresh(): void;
  onBranches(page: number): void;
  onList(view: 'issues' | 'pulls', state: 'open' | 'closed' | 'all', page: number): void;
  onItem(view: 'issue' | 'pull', number: number): void;
  onComments(page: number): void;
  onChecks(page: number): void;
  onClear(): void;
  onBind(branch: string): void;
  onUnbind(): void;
  onRetry(): void;
  onAbandon(): void;
  onAdd(): void;
  onWrite?(): void;
};
export function GithubPanel(p: GithubPanelProps) {
  const [branch, setBranch] = useState(''),
    [state, setState] = useState<'open' | 'closed' | 'all'>('open');
  const controller = p.controller,
    overview = controller?.overview,
    repository = overview?.repository,
    detail = controller?.detail,
    binding = controller?.binding,
    listing = controller?.listing;
  const busy = !!(
    p.reason ||
    !controller?.loaded ||
    controller?.busy ||
    controller?.loadError ||
    p.adding
  );
  const selectedBranch = detail?.view === 'pull' ? detail.item.head.branch : branch;
  const currentBranch = controller?.branch(branch);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && p.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog github-panel">
          <div className="github-heading">
            <Dialog.Title>GitHub 仓库与会话上下文</Dialog.Title>
            <button aria-label="关闭 GitHub 面板" onClick={p.onClose}>
              <X size={18} />
            </button>
          </div>
          <Dialog.Description>
            查看执行电脑授权仓库的 Issue、PR 和 CI。绑定保存在 Moor
            主机，不会推送代码、发表评论或发送指令。
          </Dialog.Description>
          {p.onWrite && (
            <button disabled={busy} onClick={p.onWrite}>
              审查、评论与发布
            </button>
          )}
          {p.reason && <p role="status">{p.reason}</p>}
          {controller?.loadError && <p role="alert">{controller.loadError}</p>}
          {controller?.error && <p role="alert">{controller.error}</p>}
          {controller?.pending && (
            <section role="status">
              <p>会话绑定结果待确认。刷新和重连不会发送；手动重试沿用原请求。</p>
              <button disabled={busy} onClick={p.onRetry}>
                {controller.pending.abandon ? '重试撤销待确认操作' : '重试确认 GitHub 绑定'}
              </button>
              {!controller.pending.abandon && (
                <>
                  <p>
                    也可撤销尚未执行的请求。主机若已保存绑定，会先确认原结果；解除绑定需另行操作。
                  </p>
                  <button disabled={busy} onClick={p.onAbandon}>
                    撤销待确认操作
                  </button>
                </>
              )}
            </section>
          )}
          <button disabled={busy} onClick={p.onRefresh}>
            重新读取 GitHub 授权
          </button>
          {overview?.status === 'unavailable' && (
            <p>
              {overview.reason || '此项目尚未配置可用的 GitHub 授权。请在执行电脑本机配置仓库。'}
            </p>
          )}
          {binding && (
            <section className="github-binding">
              <h3>主机确认的会话绑定</h3>
              {binding.context ? (
                <>
                  <p>
                    {binding.context.repository.owner}/{binding.context.repository.name} · 仓库编号{' '}
                    {binding.context.repository.id}
                  </p>
                  <p>
                    上下文分支：{binding.context.branch}
                    {binding.context.subject
                      ? ` · ${binding.context.subject.kind === 'pull' ? 'PR' : 'Issue'} #${binding.context.subject.number}`
                      : ''}
                  </p>
                  {binding.context.headRepository && (
                    <p>
                      PR 来源仓库：{binding.context.headRepository.owner}/
                      {binding.context.headRepository.name}
                    </p>
                  )}
                </>
              ) : (
                <p>未显示 GitHub 上下文。可重新读取授权，或解除保留的关联。</p>
              )}
              <button
                disabled={
                  busy || !!controller?.pending || (!binding.context && binding.revision === 0)
                }
                onClick={p.onUnbind}
              >
                解除会话绑定
              </button>
            </section>
          )}
          {repository && overview?.status === 'available' && (
            <>
              <section>
                <h3>主机授权仓库</h3>
                <p>
                  <Link url={repository.url} repository={repository}>
                    {repository.owner}/{repository.name}
                  </Link>{' '}
                  · 编号 {repository.id} · {repository.private ? '私有仓库' : '公开仓库'}
                </p>
                <p>
                  本地工作目录分支：{overview.localBranch || '未读取或分离提交'}
                  {overview.localHeadSha && (
                    <code className="git-oid">{overview.localHeadSha}</code>
                  )}
                </p>
                <p>以下分支用于会话上下文，不会切换本地工作目录。</p>
                <button disabled={busy} onClick={() => p.onBranches(1)}>
                  读取远端分支
                </button>
                <label>
                  上下文分支
                  <select
                    value={selectedBranch}
                    disabled={busy || detail?.view === 'pull'}
                    onChange={(event) => setBranch(event.target.value)}
                  >
                    <option value="">明确选择远端分支</option>
                    {detail?.view === 'pull' ? (
                      <option value={detail.item.head.branch}>
                        {detail.item.head.branch}（PR 来源分支）
                      </option>
                    ) : (
                      <>
                        {currentBranch &&
                          !controller?.branches?.result.items.some(
                            (item) => item.name === branch,
                          ) && <option value={branch}>{branch}（已选择）</option>}
                        {controller?.branches?.result.items.map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.name}
                            {item.protected ? ' · 受保护' : ''}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                </label>
                {controller?.branches && (
                  <Pages value={controller.branches.result} busy={busy} onPage={p.onBranches} />
                )}
                <button
                  disabled={
                    busy ||
                    !!controller?.pending ||
                    !selectedBranch ||
                    ((!detail || detail.view === 'issue') && !controller?.branch(selectedBranch))
                  }
                  onClick={() => p.onBind(selectedBranch)}
                >
                  确认绑定到此会话
                </button>
              </section>
              <section>
                <div className="github-list-controls">
                  <label>
                    列表状态
                    <select
                      value={state}
                      disabled={busy}
                      onChange={(event) => setState(event.target.value as typeof state)}
                    >
                      <option value="open">开放</option>
                      <option value="closed">已关闭</option>
                      <option value="all">全部</option>
                    </select>
                  </label>
                  <button disabled={busy} onClick={() => p.onList('issues', state, 1)}>
                    读取 Issues
                  </button>
                  <button disabled={busy} onClick={() => p.onList('pulls', state, 1)}>
                    读取 PRs
                  </button>
                </div>
                {listing && (
                  <>
                    <h3>
                      {listing.view === 'issues' ? 'Issues' : 'Pull requests'} ·{' '}
                      {listing.state === 'all'
                        ? '全部'
                        : listing.state === 'open'
                          ? '开放'
                          : '已关闭'}
                    </h3>
                    {listing.result.items.length === 0 && (
                      <p>
                        本页没有条目
                        {listing.result.partial ? '；读取不完整，不能据此判断仓库为空' : ''}。
                      </p>
                    )}
                    <ul className="github-items">
                      {listing.result.items.map((item) => (
                        <li key={item.id}>
                          <button disabled={busy} onClick={() => p.onItem(item.kind, item.number)}>
                            <strong>
                              #{item.number} {item.title}
                            </strong>
                            <span>
                              {item.state} · {item.author}
                              {item.draft ? ' · Draft' : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <Pages
                      value={listing.result}
                      busy={busy}
                      onPage={(page) => p.onList(listing.view, listing.state, page)}
                    />
                  </>
                )}
              </section>
              {detail && (
                <section>
                  <div className="github-heading">
                    <h3>
                      {detail.item.kind === 'pull' ? 'PR' : 'Issue'} #{detail.item.number} ·{' '}
                      {detail.item.title}
                    </h3>
                    <button disabled={busy} onClick={p.onClear}>
                      清除条目选择
                    </button>
                  </div>
                  <p>
                    {detail.item.state} · {detail.item.author} ·{' '}
                    <Link url={detail.item.url} repository={repository}>
                      在 GitHub 查看
                    </Link>
                  </p>
                  {detail.view === 'pull' && (
                    <div className="github-pr-branches">
                      <p>
                        来源：
                        {detail.item.head.repository
                          ? `${detail.item.head.repository.owner}/${detail.item.head.repository.name}`
                          : '来源仓库不可用'}{' '}
                        · {detail.item.head.branch}
                      </p>
                      <code className="git-oid">{detail.item.head.sha}</code>
                      <p>
                        目标：{detail.item.base.repository.owner}/{detail.item.base.repository.name}{' '}
                        · {detail.item.base.branch}
                      </p>
                      <p>
                        可合并状态：
                        {detail.item.mergeable === null
                          ? '尚不可确定'
                          : detail.item.mergeable
                            ? '可合并'
                            : '当前不可合并'}
                      </p>
                    </div>
                  )}
                  <pre className="github-body">{detail.item.body || '（正文为空）'}</pre>
                  {detail.item.bodyTruncated && <p>正文已截断，当前只显示部分内容。</p>}
                  <p>
                    GitHub 正文只在当前面板内存中展示。主动加入后会随 Moor
                    本地草稿保存，仍需另行点击发送。
                  </p>
                  <button disabled={busy || !p.canAdd} onClick={p.onAdd}>
                    {p.adding ? '正在加入草稿…' : '将正文加入草稿'}
                  </button>
                  <button disabled={busy} onClick={() => p.onComments(1)}>
                    读取评论
                  </button>
                  {detail.view === 'pull' && (
                    <button disabled={busy} onClick={() => p.onChecks(1)}>
                      读取此提交的 CI 状态
                    </button>
                  )}
                  {controller?.comments && (
                    <section>
                      <h3>评论</h3>
                      {controller.comments.result.items.map((comment) => (
                        <article key={comment.id}>
                          <p>
                            {comment.author} ·{' '}
                            <Link url={comment.url} repository={repository}>
                              在 GitHub 查看
                            </Link>
                          </p>
                          <pre className="github-body">{comment.body}</pre>
                          {comment.bodyTruncated && <p>评论正文已截断。</p>}
                        </article>
                      ))}
                      <Pages value={controller.comments.result} busy={busy} onPage={p.onComments} />
                    </section>
                  )}
                  {controller?.checks && (
                    <section>
                      <h3>CI 与提交状态</h3>
                      <code className="git-oid">检查提交 {controller.checks.headSha}</code>
                      {controller.checks.checks.items.length === 0 &&
                        controller.checks.statuses.totalCount === 0 && (
                          <p>当前未返回检查结果，不能据此判断已通过。</p>
                        )}
                      <ul>
                        {controller.checks.checks.items.map((check) => (
                          <li key={check.id}>
                            <strong>{check.name}</strong> · {check.status} ·{' '}
                            {check.conclusion ?? '尚无结论'}
                            {check.url && (
                              <>
                                {' '}
                                ·{' '}
                                <Link url={check.url} repository={repository}>
                                  查看检查
                                </Link>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                      <Pages value={controller.checks.checks} busy={busy} onPage={p.onChecks} />
                      {controller.checks.statuses.totalCount > 0 && (
                        <p>
                          GitHub 提交状态：{controller.checks.statuses.state} · 共{' '}
                          {controller.checks.statuses.totalCount} 项
                        </p>
                      )}
                      <ul>
                        {controller.checks.statuses.items.map((status) => (
                          <li key={status.id}>
                            {status.context} · {status.state}
                            {status.description ? ` · ${status.description}` : ''}
                            {status.url && (
                              <>
                                {' '}
                                ·{' '}
                                <Link url={status.url} repository={repository}>
                                  查看状态
                                </Link>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                      <Pages value={controller.checks.statuses} busy={busy} onPage={p.onChecks} />
                    </section>
                  )}
                </section>
              )}
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showGithubPanel(props?: GithubPanelProps) {
  paint(
    '#github-view',
    props ? (
      <GithubPanel
        key={props.controller ? githubKey(props.controller.target) : 'loading'}
        {...props}
      />
    ) : null,
  );
}
export function showGithubControl(props?: {
  onOpen(): void;
  disabled?: boolean;
  pending?: boolean;
}) {
  paint(
    '#github-control',
    props ? (
      <button
        aria-label="GitHub 仓库与会话上下文"
        title="GitHub 仓库与会话上下文"
        disabled={props.disabled}
        onClick={props.onOpen}
      >
        <GitPullRequest size={16} />
        <span>{props.pending ? 'GitHub · 待确认' : 'GitHub'}</span>
      </button>
    ) : null,
  );
}
