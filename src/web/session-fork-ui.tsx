import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { GitFork, X } from 'lucide-react';
import { paint } from './ui';
import { sessionForkKey, type SessionForkController } from './session-fork';
import type { ForkCutoff, ForkDirectory, ForkOrigin } from '../fork-protocol';

export type SessionForkPanelProps = {
  controller?: SessionForkController;
  sourceTitle: string;
  initialTurnId?: string;
  reason?: string;
  onClose(): void;
  onRefresh(turnId?: string): void;
  onCreate(cutoff: ForkCutoff, directory: ForkDirectory): void;
  onRetry(): void;
  onOpenChild(): void;
  onOpenWorkspace(childSessionId: string): void;
};
export function SessionForkPanel(p: SessionForkPanelProps) {
  const [cutoff, setCutoff] = useState(p.initialTurnId ? `turn:${p.initialTurnId}` : ''),
    [directory, setDirectory] = useState(''),
    [baseline, setBaseline] = useState(''),
    [branch, setBranch] = useState('');
  const controller = p.controller,
    options = controller?.options,
    receipt = controller?.receipt;
  const turnId = cutoff.startsWith('turn:') ? cutoff.slice(5) : undefined;
  const selectedTurn = options?.turns.find((turn) => turn.turnId === turnId);
  const selectedBranch = options?.repository?.branches.find(
    (item) => JSON.stringify([item.name, item.oid]) === baseline,
  );
  const busy = !!(
    p.reason ||
    !controller?.loaded ||
    controller?.busy ||
    controller?.loadError ||
    controller?.pending
  );
  const availableCutoff =
    cutoff === 'current'
      ? options?.currentAvailable
      : selectedTurn?.available && options?.capabilities.turnCutoff;
  const availableDirectory =
    directory === 'same-directory'
      ? options?.capabilities.sameDirectory
      : directory === 'worktree' &&
        options?.capabilities.worktree &&
        selectedBranch &&
        branch.trim() &&
        options?.repository?.writeSupported;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && p.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog session-fork-panel">
          <div className="session-fork-heading">
            <Dialog.Title>创建会话副本</Dialog.Title>
            <button aria-label="关闭会话副本" onClick={p.onClose}>
              <X size={18} />
            </button>
          </div>
          <Dialog.Description>
            从 Agent 的原生上下文创建新会话。源会话、草稿和附件会保留，创建副本不会发送指令。
          </Dialog.Description>
          <p>
            源会话：<strong>{p.sourceTitle || '未命名会话'}</strong>
          </p>
          {p.reason && <p role="status">{p.reason}</p>}
          {controller?.loadError && <p role="alert">{controller.loadError}</p>}
          {controller?.error && <p role="alert">{controller.error}</p>}
          {controller?.pending && (
            <section className="fork-pending" role="status">
              <p>
                原 Fork 结果待确认。刷新和重连不会发送。手动重试沿用原请求；主机已经调用的原生 Fork
                不会再次调用。
              </p>
              <button
                disabled={!!p.reason || controller.busy || !!controller.loadError}
                onClick={p.onRetry}
              >
                重试确认 Fork
              </button>
            </section>
          )}
          {receipt?.phase === 'accepted' && (
            <section role="status">
              <p>主机已确认新会话及原生上下文。</p>
              <button disabled={controller?.busy || !!p.reason} onClick={p.onOpenChild}>
                打开已确认的副本
              </button>
            </section>
          )}
          {receipt?.execution?.mode === 'worktree' && !controller?.cleanup && (
            <button
              disabled={controller?.busy}
              onClick={() => p.onOpenWorkspace(receipt.childSessionId)}
            >
              查看本次分叉的工作目录
            </button>
          )}
          {!!controller?.resources.length && (
            <section>
              <h3>此前 Fork 保留的目录</h3>
              <p>这些副本未创建成功，工作目录仍保留，可分别查看与清理。</p>
              {controller.resources.map((resource) => (
                <button
                  key={resource.receipt.childSessionId}
                  disabled={controller.busy}
                  onClick={() => p.onOpenWorkspace(resource.receipt.childSessionId)}
                >
                  查看保留目录 ·{' '}
                  {resource.receipt.execution?.branch || resource.receipt.childSessionId}
                </button>
              ))}
            </section>
          )}
          {options && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !availableCutoff || !availableDirectory) return;
                p.onCreate(
                  cutoff === 'current' ? { kind: 'current' } : { kind: 'turn', turnId: turnId! },
                  directory === 'same-directory'
                    ? { kind: 'same-directory' }
                    : {
                        kind: 'worktree',
                        baseBranch: selectedBranch!.name,
                        expectedOid: selectedBranch!.oid,
                        newBranch: branch.trim(),
                      },
                );
              }}
            >
              <p>
                {controller?.source === 'cache'
                  ? '上次读取的缓存选项；创建前会重新检查。'
                  : `来自执行电脑的 ${options.agent.name} 实际能力。`}
              </p>
              <label>
                历史截止点
                <select
                  value={cutoff}
                  disabled={busy}
                  onChange={(event) => setCutoff(event.target.value)}
                >
                  <option value="">选择原生上下文的截止范围</option>
                  <option value="current" disabled={!options.currentAvailable}>
                    Agent 当前已保存上下文{!options.currentAvailable ? '（不可用）' : ''}
                  </option>
                  {options.turns.map((turn) => (
                    <option
                      key={turn.turnId}
                      value={`turn:${turn.turnId}`}
                      disabled={!turn.available || !options.capabilities.turnCutoff}
                    >
                      第 {turn.ordinal} 个完成回合结束 · {turn.timestamp}
                      {!turn.available ? '（无可用原生锚点）' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                “当前已保存上下文”包含 Agent
                此时保存的全部内容；指定回合只包含主机确认的原生截止范围。旧回合没有原生锚点时不能据
                Moor 历史推断。
              </p>
              {options.currentReason && <p>{options.currentReason}</p>}
              {options.capabilities.turnCutoffReason && (
                <p>{options.capabilities.turnCutoffReason}</p>
              )}
              {selectedTurn?.reason && <p>{selectedTurn.reason}</p>}
              {turnId && !selectedTurn && <p>此回合尚未确认原生锚点，请重新读取该回合选项。</p>}
              {options.partial && (
                <p>此列表只显示部分回合。可从源会话中指定的完成回合打开 Fork，单独读取其能力。</p>
              )}
              <label>
                执行目录
                <select
                  value={directory}
                  disabled={busy}
                  onChange={(event) => setDirectory(event.target.value)}
                >
                  <option value="">选择目录方式</option>
                  <option value="same-directory" disabled={!options.capabilities.sameDirectory}>
                    沿用源会话的目录
                  </option>
                  <option value="worktree" disabled={!options.capabilities.worktree}>
                    创建独立 Git 工作目录
                  </option>
                </select>
              </label>
              {options.capabilities.sameDirectoryReason && (
                <p>{options.capabilities.sameDirectoryReason}</p>
              )}
              {options.capabilities.worktreeReason && <p>{options.capabilities.worktreeReason}</p>}
              {directory === 'same-directory' && (
                <p>两份会话会读写同一目录；文件改动会相互可见。</p>
              )}
              {directory === 'worktree' && (
                <section>
                  <p>
                    仅从所选提交创建，不包含源目录的未提交改动。源目录的分支不会切换；Git 基线与
                    Agent 上下文截止点分别选择。
                  </p>
                  <label>
                    本地基线分支
                    <select
                      value={baseline}
                      disabled={busy}
                      onChange={(event) => setBaseline(event.target.value)}
                    >
                      <option value="">选择分支与当前提交</option>
                      {options.repository?.branches.map((item) => (
                        <option key={item.name} value={JSON.stringify([item.name, item.oid])}>
                          {item.name} · {item.oid.slice(0, 12)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedBranch && (
                    <code className="git-oid">确认基线提交 {selectedBranch.oid}</code>
                  )}
                  <label>
                    新分支名称
                    <input
                      maxLength={200}
                      value={branch}
                      disabled={busy}
                      onChange={(event) => setBranch(event.target.value)}
                      placeholder="例如 feature/fork"
                    />
                  </label>
                </section>
              )}
              <button type="submit" disabled={busy || !availableCutoff || !availableDirectory}>
                创建原生会话副本
              </button>
            </form>
          )}
          <button
            disabled={
              !!p.reason || !controller?.loaded || controller.busy || !!controller.loadError
            }
            onClick={() => p.onRefresh(turnId)}
          >
            重新读取 Fork 选项
          </button>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showSessionForkPanel(props?: SessionForkPanelProps) {
  paint(
    '#session-fork-view',
    props ? (
      <SessionForkPanel
        key={`${props.controller ? sessionForkKey(props.controller.target) : 'loading'}/${props.initialTurnId ?? ''}`}
        {...props}
      />
    ) : null,
  );
}
export function showSessionForkControl(props?: { onOpen(): void; disabled?: boolean }) {
  paint(
    '#session-fork-control',
    props ? (
      <button
        title="创建会话副本"
        aria-label="创建会话副本"
        disabled={props.disabled}
        onClick={props.onOpen}
      >
        <GitFork size={16} />
        <span>会话副本</span>
      </button>
    ) : null,
  );
}
export function showForkOrigin(props?: { origin: ForkOrigin; onOpen(): void }) {
  paint(
    '#session-fork-origin',
    props ? (
      <aside className="fork-origin">
        <span>
          来自「{props.origin.sourceTitle || '未命名会话'}」 ·{' '}
          {props.origin.cutoff.kind === 'current'
            ? '创建时 Agent 已保存上下文'
            : '指定完成回合结束'}{' '}
          · {props.origin.directory === 'worktree' ? '独立工作目录' : '沿用源目录'}
        </span>
        <button onClick={props.onOpen}>查看来源与截止点</button>
      </aside>
    ) : null,
  );
}
