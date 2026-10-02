import type { WorkspaceClientState, WorkspaceGraph } from '@moor/client/features/workspace/compose';
import { SKILLS_FEATURE } from '@moor/protocol/skills-protocol';
import { BookOpen } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { bindWorkspacePort, type WorkspacePort } from '../../app/workspace-port';
import { SkillsPanel } from './skills-ui';
const workspaceSkillsUiPortSelection = {
  view: ['contextRevision'],
  skills: ['openSkills'],
} as const;
export type WorkspaceSkillsUiPort = WorkspacePort<typeof workspaceSkillsUiPortSelection>;
export const bindWorkspaceSkillsUiPort = (graph: WorkspaceSkillsUiPort) =>
  bindWorkspacePort(graph, workspaceSkillsUiPortSelection);

export function WorkspaceSkillsUI({
  controller,
  state,
  busy,
  run,
  controlRef,
}: {
  controller: WorkspaceSkillsUiPort;
  state: WorkspaceClientState;
  busy: boolean;
  controlRef?: Ref<{ open(): boolean }>;
  run(task: () => Promise<unknown>): boolean;
}) {
  const [, render] = useState(0);
  const panel = useRef<ReturnType<WorkspaceGraph['skills']['openSkills']> | null>(null);
  useEffect(
    () => () => {
      panel.current?.close();
      panel.current = null;
    },
    [controller, controller.view.contextRevision, state.offline],
  );
  const close = () => {
    panel.current?.close();
    panel.current = null;
    render((n) => n + 1);
  };
  const reason = state.offline
    ? '执行电脑离线，请连接后手动重新读取 Skills。'
    : !state.project?.runtime.features?.includes(SKILLS_FEATURE)
      ? '此执行电脑尚未提供 Skills 读取能力。'
      : '';
  const open = () =>
    run(async () => {
      panel.current?.close();
      panel.current = controller.skills.openSkills(() => render((n) => n + 1));
      render((n) => n + 1);
      if (!reason) await panel.current.controller.refresh();
    });
  useImperativeHandle(controlRef, () => ({ open }));
  return (
    <>
      <button type="button" aria-label="Skills" title="Skills" disabled={busy} onClick={open}>
        <BookOpen size={16} />
        <span>Skills</span>
        <kbd>$</kbd>
      </button>
      {panel.current && (
        <SkillsPanel
          controller={panel.current.controller}
          reason={reason}
          canAdd={!!state.draft && !!state.session?.persisted && !state.session.meta.isArchived}
          adding={busy}
          onClose={close}
          onRefresh={() => run(() => panel.current!.controller.refresh())}
          onSelect={(id) => run(() => panel.current!.controller.select(id))}
          onAdd={() => run(() => panel.current!.addToDraft())}
        />
      )}
    </>
  );
}
