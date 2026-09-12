import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { GitBranch, X } from 'lucide-react';
import { paint } from './ui';
import { gitWorkspaceKey, type GitWorkspaceController } from './git-workspace';
export type GitWorkspacePanelProps = {
  controller?: GitWorkspaceController;
  newSession: boolean;
  reason?: string;
  onClose(): void;
  onRefresh(): void;
  onPrepare(branch: string, oid: string, name: string): void;
  onRemove(): void;
  onRetry(): void;
  onNewDraft(): void;
};
export function GitWorkspacePanel(p: GitWorkspacePanelProps) {
  const [baseline, setBaseline] = useState(''),
    [newBranch, setNewBranch] = useState(''),
    [confirmRemove, setConfirmRemove] = useState(false);
  const controller = p.controller,
    state = controller?.state,
    execution = controller?.execution;
  const choice = state?.repository.branches.find(
    (branch) => JSON.stringify([branch.name, branch.oid]) === baseline,
  );
  const labels = {
    ready: '可用',
    creating: '准备中',
    removing: '清理中',
    removed: '已清理',
    unknown: '结果未知',
  };
  const blocked = Boolean(
    p.reason || controller?.busy || controller?.pending || controller?.loadError,
  );
  return (
    <Dialog.Root open onOpenChange={(open) => !open && p.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog git-workspace-panel">
          <div className="git-workspace-heading">
            <Dialog.Title>Git 与工作目录</Dialog.Title>
            <button aria-label="关闭 Git 与工作目录" onClick={p.onClose}>
              <X size={18} />
            </button>
          </div>
          <Dialog.Description>
            查看当前会话的工作目录与 Git 状态。创建和清理目录都需要手动操作，不会自动运行 Agent。
          </Dialog.Description>
          {p.reason && <p role="status">{p.reason}</p>}
          {controller?.loadError && <p role="alert">{controller.loadError}</p>}
          {controller?.error && <p role="alert">{controller.error}</p>}
          {controller?.pending && (
            <div className="git-pending" role="status">
              <p>
                原{controller.pending.request.action === 'prepare' ? '创建' : '清理'}
                操作结果待确认。刷新和重连不会发送。手动重试沿用原请求；主机已记录的操作只核查结果，不重复执行。
              </p>
              <button disabled={Boolean(p.reason) || controller.busy} onClick={p.onRetry}>
                重试确认
              </button>
            </div>
          )}
          {execution && (
            <p>
              <strong>{execution.mode === 'worktree' ? '独立工作目录' : '项目原目录'}</strong> ·{' '}
              {labels[execution.status]}
              {execution.branch ? ` · ${execution.branch}` : ''}
              {execution.baseOid && <code className="git-oid">基线 {execution.baseOid}</code>}
            </p>
          )}
          {execution?.reason && <p>{execution.reason}</p>}
          {state && (
            <>
              <p>
                {controller?.source === 'cache'
                  ? '上次读取的缓存状态；操作前会重新检查。'
                  : '来自执行电脑的当前状态。'}
              </p>
              {state.repository.kind === 'git' ? (
                <>
                  <p>
                    分支：{state.repository.branch || '分离的提交'}
                    <code className="git-oid">{state.repository.headOid}</code>
                  </p>
                  <p>
                    {state.repository.dirty
                      ? '存在未提交改动'
                      : state.repository.partial
                        ? '状态未完整读取，不能视为无改动'
                        : '未发现未提交改动'}
                    {state.repository.outsideProjectChanges ? ' · 项目范围外也有改动' : ''}
                  </p>
                  {state.repository.changes.length > 0 && (
                    <ul className="git-changes">
                      {state.repository.changes.map((change, index) => (
                        <li key={index}>
                          <code>
                            {change.index}
                            {change.worktree}
                          </code>
                          <span>
                            {change.previousPath ? `${change.previousPath} → ` : ''}
                            {change.path}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p>当前目录的 Git 状态不可用。</p>
              )}
              {state.repository.issues.length > 0 && (
                <ul>
                  {state.repository.issues.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              )}
              {p.newSession && state.canPrepare && (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (choice) p.onPrepare(choice.name, choice.oid, newBranch);
                  }}
                >
                  <h3>为新会话创建独立工作目录</h3>
                  <p>仅从所选提交创建，不包含项目原目录的未提交改动。原目录的分支不会切换。</p>
                  <label>
                    本地基线分支
                    <select
                      value={baseline}
                      disabled={blocked}
                      onChange={(event) => setBaseline(event.target.value)}
                    >
                      <option value="">选择分支与当前提交</option>
                      {state.repository.branches.map((branch) => (
                        <option key={branch.name} value={JSON.stringify([branch.name, branch.oid])}>
                          {branch.name} · {branch.oid.slice(0, 12)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {choice && <code className="git-oid">确认基线提交 {choice.oid}</code>}
                  <label>
                    新分支名称
                    <input
                      maxLength={200}
                      value={newBranch}
                      disabled={blocked}
                      onChange={(event) => setNewBranch(event.target.value)}
                      placeholder="例如 feature/my-change"
                    />
                  </label>
                  <button
                    disabled={
                      blocked || !choice || !newBranch.trim() || !state.repository.writeSupported
                    }
                    type="submit"
                  >
                    创建独立工作目录
                  </button>
                </form>
              )}
              {!p.newSession && (
                <p>已有会话保留当前工作目录；本版本仅在新会话开始前创建独立目录。</p>
              )}
              {execution?.mode === 'worktree' && execution.status !== 'removed' && (
                <section>
                  <h3>清理独立工作目录</h3>
                  <p>
                    只清理 Moor
                    管理且无未提交改动、无活动回合的目录。分支和提交历史会保留，当前会话之后不能再发送指令。
                  </p>
                  {state.canRemove ? (
                    <>
                      <label>
                        <input
                          type="checkbox"
                          checked={confirmRemove}
                          disabled={blocked}
                          onChange={(event) => setConfirmRemove(event.target.checked)}
                        />
                        我确认清理此会话的独立工作目录
                      </label>
                      <button disabled={blocked || !confirmRemove} onClick={p.onRemove}>
                        清理工作目录
                      </button>
                    </>
                  ) : (
                    <p>当前不能清理。请确认目录改动与活动回合；以主机重新检查为准。</p>
                  )}
                </section>
              )}
            </>
          )}
          {execution?.status === 'removed' && (
            <p>工作目录已清理。会话历史与分支仍保留；新指令需要另一份新会话。</p>
          )}
          {execution?.status === 'removed' && p.newSession && (
            <button disabled={blocked} onClick={p.onNewDraft}>
              开始另一份新会话草稿
            </button>
          )}
          <button
            disabled={Boolean(p.reason) || controller?.busy || !controller}
            onClick={p.onRefresh}
          >
            重新读取 Git 状态
          </button>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showGitWorkspacePanel(props?: GitWorkspacePanelProps) {
  paint(
    '#git-workspace-view',
    props ? (
      <GitWorkspacePanel
        key={props.controller ? gitWorkspaceKey(props.controller.target) : 'loading'}
        {...props}
      />
    ) : null,
  );
}
export function showGitWorkspaceControl(props?: {
  onOpen(): void;
  disabled?: boolean;
  label?: string;
}) {
  paint(
    '#git-workspace-control',
    props ? (
      <button className="project-content-trigger" onClick={props.onOpen} disabled={props.disabled}>
        <GitBranch size={16} />
        {props.label || 'Git 与工作目录'}
      </button>
    ) : null,
  );
}
