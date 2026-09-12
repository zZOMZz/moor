import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ListChecks, X } from 'lucide-react';
import { paint, RunControls } from './ui';
import { tasksKey, type TasksController, type TaskDraft } from './tasks';
import type { TaskPlan, TaskAction, TaskOrigin, TaskGrantView } from '../task-protocol';
import type { RunCapabilities } from '../run-config';
export type TasksPanelProps = {
  controller?: TasksController;
  reason: string;
  draftReason: string;
  sending: boolean;
  existing: boolean;
  agents: readonly { id: string; name: string; agentType?: string; runConfig?: RunCapabilities }[];
  branches: readonly { name: string; oid: string }[];
  branchesPartial: boolean;
  onClose(): void;
  onEdit(draft: TaskDraft): void;
  onReadBranches(): void;
  onRefreshAgent(id: string): void;
  onReview(): Promise<TaskPlan>;
  onEnable(plan: TaskPlan): void;
  onDisable(): void;
  onRefresh(): void;
  onAction(
    action: TaskAction['action'],
    grantId: string,
    operationId?: string,
    cleanup?: { taskId: string; expectedExecutionRevision: number },
  ): void;
  onRetry(): void;
  onOpenSession(id: string): void;
};
const grantState = {
  active: '授权有效',
  expired: '已到期',
  interrupted: '已中断',
  canceled: '工具授权已撤销',
};
const slotState = {
  reserved: '尚未创建',
  preparing: '正在准备目录',
  ready: '会话已创建',
  running: '正在执行',
  terminal: '回合已结束',
  unknown: '结果未知',
};
export function TasksPanel(p: TasksPanelProps) {
  const c = p.controller,
    [review, setReview] = useState<{ plan: TaskPlan; draft: string }>(),
    [reviewing, setReviewing] = useState(false),
    [localError, setError] = useState(''),
    [confirmation, setConfirmation] = useState<{
      key: string;
      action: TaskAction['action'];
      grantId: string;
      operationId?: string;
      cleanup?: { taskId: string; expectedExecutionRevision: number };
      text: string;
    }>();
  const draft = c?.draft,
    busy = !!c?.busy || p.sending || reviewing,
    blocked = busy || !c?.loaded || !!c?.loadError;
  const editBlocked = blocked || !!p.draftReason;
  const update = (patch: Partial<TaskDraft>) => {
    if (draft) {
      setReview(undefined);
      p.onEdit({ ...draft, ...patch });
    }
  };
  const grants = c?.list?.grants ?? (c?.receipt ? [c.receipt.grant] : []);
  const ask = (
    grant: TaskGrantView,
    action: 'revoke' | 'abandon' | 'cleanup',
    operationId?: string,
    cleanup?: { taskId: string; expectedExecutionRevision: number },
  ) =>
    setConfirmation({
      key: [grant.grantId, action, operationId, cleanup?.taskId].join('/'),
      action,
      grantId: grant.grantId,
      operationId,
      cleanup,
      text:
        action === 'revoke'
          ? '结束此授权，并请求停止仍在执行的子任务。已产生的文件与分支会保留。'
          : action === 'cleanup'
            ? '清理此子任务的独立工作目录。主机将再次检查目录是否干净、是否仍被使用；分支和会话历史保留。'
            : '封存原操作，阻止尚未开始的执行。若主机已执行，将显示原结果；不会把未知结果称为已撤销。',
    });
  return (
    <Dialog.Root open onOpenChange={(open) => !open && p.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog tasks-panel">
          <div className="github-heading">
            <Dialog.Title>协作任务</Dialog.Title>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭协作任务"
              onClick={p.onClose}
            >
              <X />
            </button>
          </div>
          <Dialog.Description>
            审查后启用本次任务计划，再手动发送父指令。每个子任务在同电脑、同项目的独立 Git
            工作目录执行；只从指定提交创建，不包含原目录未提交改动。父回合结束或授权到期时请求停止子任务。
          </Dialog.Description>
          {p.reason && <p role="status">{p.reason}</p>}
          {p.draftReason && <p role="status">{p.draftReason}</p>}
          {(c?.loadError || c?.error || localError) && (
            <p role="alert">{c?.loadError || c?.error || localError}</p>
          )}
          {draft && (
            <section aria-label="任务计划草稿">
              <h3>本次任务计划</h3>
              <p>
                {c.saving
                  ? '正在保存草稿…'
                  : c.enabled
                    ? '已审查启用；尚未发送。'
                    : '草稿保存在此会话，刷新和重连不会执行。'}
              </p>
              <button type="button" disabled={blocked || !!p.reason} onClick={p.onReadBranches}>
                读取本地基线分支
              </button>
              {p.branchesPartial && <p>分支列表为部分结果；请选择列表中已读取的明确提交。</p>}
              {draft.tasks.map((task, index) => {
                const agent = p.agents.find((a) => a.id === task.agentId),
                  updateTask = (patch: Partial<typeof task>) =>
                    update({
                      tasks: draft.tasks.map((t) =>
                        t.taskId === task.taskId ? { ...t, ...patch } : t,
                      ),
                    });
                return (
                  <fieldset key={task.taskId} disabled={editBlocked} className="task-card">
                    <legend>子任务 {index + 1}</legend>
                    <label>
                      标题
                      <input
                        aria-label={`任务 ${index + 1} 标题`}
                        maxLength={120}
                        value={task.title}
                        onChange={(e) => updateTask({ title: e.target.value })}
                      />
                    </label>
                    <label>
                      Agent 版本
                      <select
                        aria-label={`任务 ${index + 1} Agent`}
                        value={task.agentId}
                        onChange={(e) => updateTask({ agentId: e.target.value, selection: {} })}
                      >
                        <option value="">选择 Agent</option>
                        {p.agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} · {a.id}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      执行说明
                      <textarea
                        aria-label={`任务 ${index + 1} 执行说明`}
                        maxLength={10000}
                        value={task.instruction}
                        onChange={(e) => updateTask({ instruction: e.target.value })}
                      />
                    </label>
                    <label>
                      完成条件
                      <textarea
                        aria-label={`任务 ${index + 1} 完成条件`}
                        maxLength={2000}
                        value={task.completion}
                        onChange={(e) => updateTask({ completion: e.target.value })}
                      />
                    </label>
                    <label>
                      基线分支与提交
                      <select
                        aria-label={`任务 ${index + 1} 基线`}
                        value={JSON.stringify([task.baseBranch, task.expectedOid])}
                        onChange={(e) => {
                          const [baseBranch, expectedOid] = JSON.parse(e.target.value);
                          updateTask({ baseBranch, expectedOid });
                        }}
                      >
                        <option value={JSON.stringify(['', ''])}>选择已读取的提交</option>
                        {task.expectedOid &&
                          !p.branches.some(
                            (b) => b.name === task.baseBranch && b.oid === task.expectedOid,
                          ) && (
                            <option value={JSON.stringify([task.baseBranch, task.expectedOid])}>
                              {task.baseBranch} · {task.expectedOid}（待重新核对）
                            </option>
                          )}
                        {p.branches.map((b) => (
                          <option key={b.name} value={JSON.stringify([b.name, b.oid])}>
                            {b.name} · {b.oid}
                          </option>
                        ))}
                      </select>
                    </label>
                    <RunControls
                      idPrefix={`task-${task.taskId}-`}
                      capabilities={agent?.runConfig}
                      agentType={agent?.agentType}
                      selection={task.selection ?? {}}
                      disabled={editBlocked}
                      loading={false}
                      canRefresh={!!agent && !p.reason}
                      validation="未选择的运行选项使用该 Agent 版本默认值。刷新选项会启动能力检查。"
                      existing={false}
                      onChange={(key, value) =>
                        updateTask({
                          selection: {
                            ...task.selection,
                            [key]: value || undefined,
                            ...(key === 'modelId' ? { reasoningEffort: undefined } : {}),
                          },
                        })
                      }
                      onRefresh={() => p.onRefreshAgent(task.agentId)}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        update({ tasks: draft.tasks.filter((t) => t.taskId !== task.taskId) })
                      }
                    >
                      移除此任务
                    </button>
                  </fieldset>
                );
              })}
              <button
                type="button"
                disabled={editBlocked || draft.tasks.length >= 8}
                onClick={() =>
                  update({
                    tasks: [
                      ...draft.tasks,
                      {
                        taskId: crypto.randomUUID(),
                        title: '',
                        agentId: p.agents[0]?.id ?? '',
                        instruction: '',
                        completion: '',
                        baseBranch: '',
                        expectedOid: '',
                      },
                    ],
                  })
                }
              >
                添加子任务
              </button>
              <div className="tasks-limits">
                <label>
                  最多并行
                  <select
                    disabled={editBlocked}
                    value={draft.maxParallel}
                    onChange={(e) => update({ maxParallel: Number(e.target.value) })}
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label>
                  每项最多回合
                  <select
                    disabled={editBlocked}
                    value={draft.maxTurnsPerTask}
                    onChange={(e) => update({ maxTurnsPerTask: Number(e.target.value) })}
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label>
                  授权时限（分钟）
                  <input
                    type="number"
                    min={1}
                    max={60}
                    disabled={editBlocked}
                    value={draft.timeoutMs / 60000}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (n >= 1 && n <= 60) update({ timeoutMs: n * 60000 });
                    }}
                  />
                </label>
              </div>
              <button
                type="button"
                disabled={editBlocked || !!p.reason || !draft.tasks.length || !!c.delivery}
                onClick={() => {
                  setError('');
                  setReviewing(true);
                  void p
                    .onReview()
                    .then((plan) => setReview({ plan, draft: JSON.stringify(c.draft) }))
                    .catch((e) => setError(e.message))
                    .finally(() => setReviewing(false));
                }}
              >
                审查本次任务计划
              </button>
              {c.enabled && (
                <button type="button" disabled={blocked} onClick={p.onDisable}>
                  停用本次计划
                </button>
              )}
              {review && review.draft === JSON.stringify(draft) && (
                <section className="task-review" aria-label="任务授权最终审查">
                  <h3>确认本次授权</h3>
                  <p>
                    最多并行 {review.plan.maxParallel} 项，每项最多 {review.plan.maxTurnsPerTask}{' '}
                    回合，{review.plan.timeoutMs / 60000}{' '}
                    分钟后到期。父回合结束时请求停止子任务；停止结果以实际状态为准。子任务不能再创建下一层任务；完成条件仍需人工核对。
                  </p>
                  {review.plan.tasks.map((t) => (
                    <article key={t.taskId}>
                      <strong>{t.title}</strong>
                      <p>
                        Agent：{p.agents.find((a) => a.id === t.agentId)?.name} · {t.agentId}
                      </p>
                      <p>
                        基线：{t.baseBranch} · {t.expectedOid}
                      </p>
                      <p>运行选项：{JSON.stringify(t.selection ?? {})}（空项使用 Agent 默认）</p>
                      <pre>{t.instruction}</pre>
                      <p>完成条件：{t.completion}</p>
                    </article>
                  ))}
                  <button
                    type="button"
                    disabled={editBlocked || !!p.reason || !!c.delivery}
                    onClick={() => {
                      p.onEnable(review.plan);
                      setReview(undefined);
                    }}
                  >
                    启用本次任务计划
                  </button>
                </section>
              )}
            </section>
          )}
          <section aria-label="已授权任务状态">
            <h3>已授权任务</h3>
            <button
              type="button"
              disabled={blocked || !!p.reason || !p.existing}
              onClick={p.onRefresh}
            >
              读取任务状态
            </button>
            {!p.existing && <p>首次父指令获得主机确认后可读取任务状态。</p>}
            {c?.list && !grants.length && <p>当前会话尚无协作授权。</p>}
            {c?.list?.truncated && <p>仅显示最近 20 份授权；结果不完整。</p>}
            {c?.pending && (
              <div className="task-review">
                <p>
                  待确认操作：{c.pending.action} · {c.pending.operationId}。刷新和重连不会发送。
                </p>
                <button type="button" disabled={blocked || !!p.reason} onClick={p.onRetry}>
                  {c.pending.action === 'revoke' ? '重试原撤销' : '重试原任务操作'}
                </button>
                <button
                  type="button"
                  disabled={blocked || !!p.reason}
                  hidden={c.pending.action === 'revoke'}
                  onClick={() => p.onAction('inspect', c.pending!.grantId, c.pending!.operationId)}
                >
                  核查原操作
                </button>
                <button
                  type="button"
                  disabled={blocked || !!p.reason}
                  hidden={c.pending.action === 'revoke'}
                  onClick={() =>
                    setConfirmation({
                      key: c.pending!.operationId,
                      action: 'abandon',
                      grantId: c.pending!.grantId,
                      operationId: c.pending!.operationId,
                      text: '封存原编号；已执行的操作返回原结果，不宣称撤销远端执行。',
                    })
                  }
                >
                  封存待确认操作
                </button>
              </div>
            )}
            {grants.map((grant) => (
              <article key={grant.grantId} className="task-card">
                <h4>
                  {grantState[grant.state]} · {grant.grantId}
                </h4>
                <p>
                  到期：{grant.expiresAt} · 父回合 {grant.parentUserTurnId}
                </p>
                {grant.state === 'active' && (
                  <button
                    type="button"
                    disabled={blocked || !!p.reason || !!c?.pending}
                    onClick={() => ask(grant, 'revoke')}
                  >
                    结束此授权并停止子任务
                  </button>
                )}
                {grant.tasks.map((task) => (
                  <div className="task-slot" key={task.taskId}>
                    <strong>{task.title}</strong>
                    <p>
                      {slotState[task.status]}
                      {task.terminal ? ` · ${task.terminal}` : ''} · 已用 {task.turnsUsed}/
                      {grant.plan.maxTurnsPerTask} 回合
                    </p>
                    <p>完成条件（未自动核实）：{task.completion}</p>
                    {task.sessionCreated && (
                      <button type="button" onClick={() => p.onOpenSession(task.childSessionId)}>
                        打开子会话
                      </button>
                    )}
                    {task.execution && (
                      <p>
                        目录：{task.execution.branch ?? task.execution.mode} ·{' '}
                        {task.execution.status} · 版本 {task.execution.revision}
                      </p>
                    )}
                    {task.execution?.mode === 'worktree' && task.execution.status !== 'removed' && (
                      <button
                        type="button"
                        disabled={
                          blocked ||
                          !!p.reason ||
                          !!c?.pending ||
                          grant.state === 'active' ||
                          task.execution.status !== 'ready' ||
                          grant.operations.some(
                            (op) =>
                              op.taskId === task.taskId &&
                              ['pending', 'unknown'].includes(op.state),
                          )
                        }
                        onClick={() =>
                          ask(grant, 'cleanup', undefined, {
                            taskId: task.taskId,
                            expectedExecutionRevision: task.execution!.revision,
                          })
                        }
                      >
                        清理此任务工作目录
                      </button>
                    )}
                    {grant.operations
                      .filter((op) => op.taskId === task.taskId)
                      .map((op) => (
                        <div key={op.operationId}>
                          <p>
                            {op.kind} · {op.state} · {op.operationId}
                            {op.message ? ` · ${op.message}` : ''}
                          </p>
                          {['pending', 'unknown'].includes(op.state) && (
                            <>
                              <button
                                type="button"
                                disabled={blocked || !!p.reason || !!c?.pending}
                                onClick={() => p.onAction('inspect', grant.grantId, op.operationId)}
                              >
                                核查原操作
                              </button>
                              <button
                                type="button"
                                disabled={blocked || !!p.reason || !!c?.pending}
                                onClick={() => ask(grant, 'abandon', op.operationId)}
                              >
                                封存原操作
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                  </div>
                ))}
              </article>
            ))}
            {confirmation && (
              <section key={confirmation.key} className="task-review" aria-label="确认任务操作">
                <p>{confirmation.text}</p>
                <p>
                  授权：{confirmation.grantId}
                  {confirmation.cleanup
                    ? ` · 子任务：${confirmation.cleanup.taskId} · 目录版本：${confirmation.cleanup.expectedExecutionRevision}`
                    : ''}
                </p>
                <button
                  type="button"
                  disabled={blocked || !!p.reason}
                  onClick={() => {
                    p.onAction(
                      confirmation.action,
                      confirmation.grantId,
                      confirmation.operationId,
                      confirmation.cleanup,
                    );
                    setConfirmation(undefined);
                  }}
                >
                  确认此操作
                </button>
                <button type="button" onClick={() => setConfirmation(undefined)}>
                  返回
                </button>
              </section>
            )}
          </section>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showTasksControl(props?: { disabled: boolean; onOpen(): void }) {
  paint(
    '#tasks-control',
    props ? (
      <button
        type="button"
        className="icon-button"
        disabled={props.disabled}
        aria-label="协作任务"
        title="协作任务"
        onClick={props.onOpen}
      >
        <ListChecks />
      </button>
    ) : null,
  );
}
export function showTasksPanel(props?: TasksPanelProps) {
  paint(
    '#tasks-view',
    props ? (
      <TasksPanel key={props.controller ? tasksKey(props.controller.target) : 'none'} {...props} />
    ) : null,
  );
}
export function showTaskPlanCard(props?: {
  count: number;
  pending: boolean;
  onOpen(): void;
  onRemove(): void;
  disabled: boolean;
}) {
  paint(
    '#task-plan-card',
    props ? (
      <div className="task-plan-card">
        <span>
          {props.count} 项协作任务 ·{' '}
          {props.pending ? '原父指令待确认' : '已审查，将随本次父指令授权'}
        </span>
        <button type="button" onClick={props.onOpen}>
          查看
        </button>
        <button type="button" disabled={props.disabled || props.pending} onClick={props.onRemove}>
          移除本次计划
        </button>
      </div>
    ) : null,
  );
}
export function showTaskOrigin(props?: { origin: TaskOrigin; onOpen(): void }) {
  paint(
    '#task-origin',
    props ? (
      <div className="task-plan-card">
        <span>子任务 · 完成条件：{props.origin.completion}。此会话不能创建下一层协作任务。</span>
        <button type="button" onClick={props.onOpen}>
          打开父会话
        </button>
      </div>
    ) : null,
  );
}
