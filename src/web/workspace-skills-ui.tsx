import { useEffect, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import type { WorkspaceController, WorkspaceClientState } from './workspace-controller';
import { SkillsPanel } from './skills-ui';
import { SKILLS_FEATURE } from '../skills-protocol';

export function WorkspaceSkillsUI({
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
  const panel = useRef<ReturnType<WorkspaceController['openSkills']> | null>(null);
  useEffect(
    () => () => {
      panel.current?.close();
      panel.current = null;
    },
    [controller, controller.contextRevision, state.offline],
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
  return (
    <>
      <button
        type="button"
        aria-label="Skills"
        title="Skills"
        disabled={busy}
        onClick={() =>
          run(async () => {
            panel.current?.close();
            panel.current = controller.openSkills(() => render((n) => n + 1));
            render((n) => n + 1);
            if (!reason) await panel.current.controller.refresh();
          })
        }
      >
        <BookOpen size={16} />
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
