import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Users, X } from 'lucide-react';
import { paint } from './ui';
import type { RunCapabilities, RunSelection } from '../run-config';
import type { RoleView } from '../role-protocol';
import { rolesKey, type RolesController, type RoleEdit } from './roles';
export type RoleAgent = { id: string; name: string; runConfig?: RunCapabilities };
export type RolesPanelProps = {
  controller?: RolesController;
  reason: string;
  agents: RoleAgent[];
  currentAgentId?: string;
  existing: boolean;
  selectedId?: string;
  applying: boolean;
  applyReason(role: RoleView): string;
  effective(role: RoleView): RunSelection;
  onClose(): void;
  onRefresh(): void;
  onSave(edit: RoleEdit): void;
  onRemove(id: string): void;
  onInspect(): void;
  onRetry(): void;
  onAbandon(): void;
  onApply(role: RoleView): void;
  onNew(role: RoleView): void;
  onRefreshAgent(id: string): void;
};
export function RolesPanel(p: RolesPanelProps) {
  const [selectedId, setSelectedId] = useState(p.selectedId ?? ''),
    [edit, setEdit] = useState<RoleEdit>(),
    [deleting, setDeleting] = useState('');
  const c = p.controller,
    role = c?.list?.roles.find((value) => value.id === selectedId),
    busy = !!c?.busy || p.applying,
    blocked = busy || !!p.reason || !!c?.loadError,
    editingAgent = p.agents.find((agent) => agent.id === edit?.agentId),
    caps = editingAgent?.runConfig,
    applyReason = role ? p.applyReason(role) : '';
  const editorGeneration = useRef(0),
    submittedEditor = useRef<{ generation: number; edit: RoleEdit } | undefined>(undefined),
    handledReceipt = useRef<string | undefined>(undefined);
  const receipt = c?.receipt;
  useEffect(() => {
    if (!receipt || handledReceipt.current === receipt.operationId) return;
    handledReceipt.current = receipt.operationId;
    if (!receipt.accepted) return;
    if (receipt.action === 'save') {
      const submitted = submittedEditor.current;
      if (!edit || submitted?.generation === editorGeneration.current)
        setSelectedId(receipt.roleId);
      if (submitted?.generation === editorGeneration.current) {
        // Keep edits typed while saving, but turn them into an edit of the
        // confirmed role so a second save cannot create another role.
        setEdit((current) =>
          current === submitted.edit
            ? undefined
            : current
              ? { ...current, id: receipt.roleId }
              : undefined,
        );
      }
      submittedEditor.current = undefined;
    } else {
      if (selectedId === receipt.roleId) setSelectedId('');
      if (edit?.id === receipt.roleId) setEdit(undefined);
    }
    setDeleting('');
  }, [receipt]);

  const update = (values: Partial<RoleEdit>) =>
    setEdit((prior) => (prior ? { ...prior, ...values } : prior));
  const selection = (key: keyof RunSelection, value: string) => {
    const next = { ...edit!.selection, [key]: value || undefined };
    if (key === 'modelId' && !value) delete next.reasoningEffort;
    update({ selection: next });
  };
  const roleEditor = (source?: RoleView, copy = false) => {
    editorGeneration.current++;
    setDeleting('');
    setEdit(
      source
        ? {
            ...(copy ? {} : { id: source.id }),
            name: source.name + (copy ? ' 副本' : ''),
            agentId: source.agentId,
            selection: { ...source.selection },
            instructions: source.instructions,
          }
        : {
            name: '',
            agentId: p.currentAgentId ?? p.agents[0]?.id ?? '',
            selection: {},
            instructions: '',
          },
    );
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && p.onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="session-dialog-backdrop" />
        <Dialog.Popup className="session-dialog roles-panel">
          <div className="github-heading">
            <Dialog.Title>角色预设</Dialog.Title>
            <button className="icon-button" onClick={p.onClose} aria-label="关闭角色预设">
              <X />
            </button>
          </div>
          <Dialog.Description>
            角色在当前项目共享。编辑预设不改变已有会话；应用只追加当前草稿并保存运行选项，发送仍需手动确认。
          </Dialog.Description>
          <p className="muted">
            模型、effort 或审批模式留空表示保持当前选择，不代表重置或降低权限。读取列表不会启动
            Agent。
          </p>
          {p.reason && <p role="status">{p.reason}</p>}
          {(c?.error || c?.loadError) && <p role="alert">{c.loadError || c.error}</p>}
          <div className="roles-tools">
            <button disabled={blocked || !c?.loaded} onClick={p.onRefresh}>
              重新读取角色
            </button>
            <button disabled={blocked || !!c?.pending || !c?.list} onClick={() => roleEditor()}>
              新建角色
            </button>
          </div>
          {c?.pending && (
            <section className="roles-pending" aria-label="待确认角色操作">
              <strong>原角色{c.pending.action === 'save' ? '保存' : '删除'}结果待确认</strong>
              <p>刷新和重连不会发送。核查只读取原回执；重试沿用原请求，可能首次送达主机。</p>
              <p>操作编号：{c.pending.operationId}</p>
              <button disabled={blocked} onClick={p.onInspect}>
                核查原角色操作
              </button>
              <button disabled={blocked} onClick={p.onRetry}>
                {c.ending ? '重试结束角色操作' : '重试原角色操作'}
              </button>
              <p>
                结束操作会封存尚未执行的原请求；若此前已完成，主机会返回实际回执。此操作不撤销已保存的角色。
              </p>
              <button disabled={blocked} onClick={p.onAbandon}>
                结束原角色操作
              </button>
            </section>
          )}
          <div className="roles-columns">
            <div className="roles-list" aria-label="项目角色列表">
              {c?.list?.roles.map((value) => (
                <button
                  key={value.id}
                  disabled={busy}
                  aria-pressed={value.id === selectedId}
                  onClick={() => {
                    editorGeneration.current++;
                    setSelectedId(value.id);
                    setEdit(undefined);
                    setDeleting('');
                  }}
                >
                  <strong>{value.name}</strong>
                  <span>
                    版本 {value.revision} ·{' '}
                    {p.agents.find((agent) => agent.id === value.agentId)?.name ?? value.agentId}
                  </span>
                  {!value.available && <small>{value.unavailableReason}</small>}
                </button>
              ))}
              {c?.list?.roles.length === 0 && <p>此项目尚未创建角色。</p>}
            </div>
            <section className="roles-detail">
              {edit ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    submittedEditor.current = { generation: editorGeneration.current, edit };
                    p.onSave(edit);
                  }}
                >
                  <h3>{edit.id ? '编辑角色' : '新建角色'}</h3>
                  <label>
                    角色名称
                    <input
                      required
                      maxLength={100}
                      value={edit.name}
                      onChange={(event) => update({ name: event.target.value })}
                    />
                  </label>
                  <label>
                    固定 Agent 版本
                    <select
                      value={edit.agentId}
                      onChange={(event) => update({ agentId: event.target.value })}
                    >
                      {!p.agents.some((agent) => agent.id === edit.agentId) && (
                        <option value={edit.agentId}>{edit.agentId} · 当前不可选</option>
                      )}
                      {p.agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name} · {agent.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    模型
                    <select
                      value={edit.selection.modelId ?? ''}
                      onChange={(event) => selection('modelId', event.target.value)}
                    >
                      <option value="">保持当前</option>
                      {edit.selection.modelId &&
                        !caps?.models.some((model) => model.id === edit.selection.modelId) && (
                          <option value={edit.selection.modelId}>
                            {edit.selection.modelId} · 尚未验证
                          </option>
                        )}
                      {caps?.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Effort
                    <select
                      value={edit.selection.reasoningEffort ?? ''}
                      onChange={(event) => selection('reasoningEffort', event.target.value)}
                    >
                      <option value="">保持当前</option>
                      {edit.selection.reasoningEffort &&
                        !caps?.models
                          .find((model) => model.id === edit.selection.modelId)
                          ?.efforts.includes(edit.selection.reasoningEffort) && (
                          <option value={edit.selection.reasoningEffort}>
                            {edit.selection.reasoningEffort} · 尚未验证
                          </option>
                        )}
                      {caps?.models
                        .find((model) => model.id === edit.selection.modelId)
                        ?.efforts.map((effort) => (
                          <option key={effort}>{effort}</option>
                        ))}
                    </select>
                  </label>
                  <label>
                    审批模式
                    <select
                      value={edit.selection.modeId ?? ''}
                      onChange={(event) => selection('modeId', event.target.value)}
                    >
                      <option value="">保持当前</option>
                      {edit.selection.modeId &&
                        !caps?.modes.some((mode) => mode.id === edit.selection.modeId) && (
                          <option value={edit.selection.modeId}>
                            {edit.selection.modeId} · 尚未验证
                          </option>
                        )}
                      {caps?.modes.map((mode) => (
                        <option key={mode.id} value={mode.id}>
                          {mode.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!caps && (
                    <p>
                      此 Agent 尚未提供运行选项。可保存不指定选项的角色；应用时仍会校验当前选择。
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={
                      blocked || !editingAgent || (p.existing && edit.agentId !== p.currentAgentId)
                    }
                    onClick={() => p.onRefreshAgent(edit.agentId)}
                  >
                    读取此 Agent 的模型选项（会启动 Agent）
                  </button>
                  <label>
                    默认说明
                    <textarea
                      rows={7}
                      value={edit.instructions}
                      onChange={(event) => update({ instructions: event.target.value })}
                    />
                  </label>
                  <p className="muted">
                    保存不会运行这些说明。应用时会将此版本说明追加到现有草稿。
                  </p>
                  <button
                    disabled={blocked || !!c?.pending || !c?.list || !editingAgent}
                    type="submit"
                  >
                    保存角色
                  </button>
                  <button type="button" disabled={busy} onClick={() => setEdit(undefined)}>
                    返回角色详情
                  </button>
                </form>
              ) : role ? (
                <>
                  <h3>
                    {role.name} · 版本 {role.revision}
                  </h3>
                  <p>
                    Agent：
                    {p.agents.find((agent) => agent.id === role.agentId)?.name ??
                      role.agentId} · {role.agentId}
                  </p>
                  <div className="roles-tools">
                    <button disabled={blocked || !!c?.pending} onClick={() => roleEditor(role)}>
                      编辑角色
                    </button>
                    <button
                      disabled={blocked || !!c?.pending}
                      onClick={() => roleEditor(role, true)}
                    >
                      复制角色
                    </button>
                    <button disabled={blocked || !!c?.pending} onClick={() => setDeleting(role.id)}>
                      删除角色
                    </button>
                  </div>
                  {deleting === role.id && (
                    <div role="alert">
                      <p>删除“{role.name}”预设不会改变已有草稿或会话。</p>
                      <button
                        disabled={blocked || !!c?.pending}
                        onClick={() => p.onRemove(role.id)}
                      >
                        确认删除角色
                      </button>
                      <button onClick={() => setDeleting('')}>保留角色</button>
                    </div>
                  )}
                  <h4>应用到草稿前确认</h4>
                  <p>
                    模型：{role.selection.modelId ?? '保持当前'} · Effort：
                    {role.selection.reasoningEffort ?? '保持当前'} · 审批模式：
                    {role.selection.modeId ?? '保持当前'}
                  </p>
                  {!applyReason && (
                    <p>
                      应用后选择：{p.effective(role).modelId ?? 'Agent 默认'} ·{' '}
                      {p.effective(role).reasoningEffort ?? '未指定 effort'} ·{' '}
                      {p.effective(role).modeId ?? '保持 Agent 当前审批模式'}
                    </p>
                  )}
                  <p>将追加的完整说明：</p>
                  <pre className="roles-instructions">
                    {role.instructions || '（没有追加说明；仅保存运行选项）'}
                  </pre>
                  {applyReason && <p role="status">{applyReason}</p>}
                  <button
                    disabled={blocked || !!applyReason || !!c?.pending}
                    onClick={() => p.onApply(role)}
                  >
                    {p.applying ? '正在保存角色草稿…' : '确认应用到草稿'}
                  </button>
                  {p.existing &&
                    role.agentId !== p.currentAgentId &&
                    p.agents.some((agent) => agent.id === role.agentId) && (
                      <button disabled={blocked} onClick={() => p.onNew(role)}>
                        在新会话应用此角色
                      </button>
                    )}
                  <button
                    disabled={
                      blocked ||
                      (p.existing && role.agentId !== p.currentAgentId) ||
                      !p.agents.some((agent) => agent.id === role.agentId)
                    }
                    onClick={() => p.onRefreshAgent(role.agentId)}
                  >
                    读取此 Agent 的模型选项（会启动 Agent）
                  </button>
                </>
              ) : (
                <p>选择一个角色查看说明和运行选项。</p>
              )}
            </section>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function showRolesControl(props?: { disabled: boolean; onOpen(): void }) {
  paint(
    '#roles-control',
    props ? (
      <button
        className="icon-button"
        disabled={props.disabled}
        onClick={props.onOpen}
        aria-label="角色预设"
        title="角色预设"
      >
        <Users />
      </button>
    ) : null,
  );
}
export function showRolesPanel(props?: RolesPanelProps) {
  paint(
    '#roles-view',
    props ? (
      <RolesPanel key={props.controller ? rolesKey(props.controller.target) : 'none'} {...props} />
    ) : null,
  );
}
