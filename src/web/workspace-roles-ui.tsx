import { useEffect, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { RolesPanel } from './roles-ui';
import { roleSelection } from './roles';
import { ROLE_FEATURE, type RoleView } from '../role-protocol';
import type { WorkspaceController, WorkspaceClientState } from './workspace-controller';

export function WorkspaceRolesUI({
  controller,
  state,
  busy,
  run,
}: {
  controller: WorkspaceController;
  state: WorkspaceClientState;
  busy: boolean;
  run(task: () => Promise<unknown>): boolean;
}) {
  const [, render] = useState(0);
  type Panel = Awaited<ReturnType<WorkspaceController['openRoles']>>;
  const panel = useRef<Panel | null>(null);
  const close = () => {
    panel.current?.close();
    panel.current = null;
    render((n) => n + 1);
  };
  useEffect(
    () => () => {
      close();
    },
    [controller, controller.contextRevision, state.offline],
  );
  const reason = state.offline
    ? '执行电脑离线，请连接后手动读取角色。'
    : !state.project?.runtime.features?.includes(ROLE_FEATURE)
      ? '此执行电脑尚未提供角色预设能力。'
      : '';
  const agents = [...(state.project?.runtime.agents ?? [])];
  if (state.session?.agent) {
    const index = agents.findIndex((agent) => agent.id === state.session!.agent!.id);
    if (index < 0) agents.push(state.session.agent);
    else agents[index] = state.session.agent;
  }
  const effective = (role: RoleView) =>
    roleSelection(
      role,
      state.draft?.selection ?? {},
      agents.find((agent) => agent.id === role.agentId)?.runConfig,
    );
  const applyReason = (role: RoleView) => {
    if (state.session?.meta.agentConfigId !== role.agentId)
      return '已有会话固定了另一 Agent，可明确创建新会话后应用。';
    if (state.session.meta.isArchived) return '已归档会话不能应用角色。';
    const base = state.session.history.findLast((turn) => turn.role === 'user')?.id ?? '';
    const marker = state.ledger?.roleApplied?.[state.sessionId!];
    if (
      marker?.base === base &&
      marker.applied.some((item) => item.roleId === role.id && item.revision === role.revision)
    )
      return '此角色版本已应用到当前草稿，不会重复追加。';
    try {
      effective(role);
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  };
  const act = (task: (value: Panel) => Promise<unknown>) => {
    const value = panel.current;
    if (value) run(() => task(value));
  };
  return (
    <>
      <button
        type="button"
        aria-label="角色预设"
        title="角色预设"
        disabled={busy}
        onClick={() =>
          run(async () => {
            close();
            panel.current = await controller.openRoles(() => render((n) => n + 1));
            render((n) => n + 1);
            if (!reason) await panel.current.refresh();
          })
        }
      >
        <Users size={16} />
      </button>
      {panel.current && (
        <RolesPanel
          controller={panel.current.controller}
          reason={reason}
          agents={agents}
          currentAgentId={state.session?.meta.agentConfigId}
          existing
          applying={busy}
          applyReason={applyReason}
          effective={effective}
          onClose={close}
          onRefresh={() => act((value) => value.refresh())}
          onSave={(edit) => act((value) => value.save(edit))}
          onRemove={(id) => act((value) => value.remove(id))}
          onInspect={() => act((value) => value.inspect())}
          onRetry={() => act((value) => value.retry())}
          onAbandon={() => act((value) => value.abandon())}
          onApply={(role) => act((value) => value.apply(role))}
          onNew={(role) => act((value) => value.createFromRole(role))}
          onRefreshAgent={(id) => act((value) => value.refreshAgent(id))}
        />
      )}
    </>
  );
}
