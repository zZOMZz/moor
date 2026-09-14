import { useEffect, useRef, useState, useImperativeHandle, type Ref } from 'react';
import { FolderOpen, GitCompareArrows } from 'lucide-react';
import { ProjectContentPanel } from './project-content-ui';
import type { WorkspaceController } from './workspace-controller';

export type WorkspaceContentHandle = { open(mode: 'tree' | 'changes', turnId?: string): boolean };

export function WorkspaceContentUI({
  controller,
  busy,
  run,
  controlRef,
}: {
  controller: WorkspaceController;
  controlRef?: Ref<WorkspaceContentHandle>;
  busy: boolean;
  run(task: () => Promise<unknown>): boolean;
}) {
  const [, render] = useState(0);
  type Panel = Awaited<ReturnType<WorkspaceController['openProjectContent']>>;
  const panel = useRef<Panel | null>(null);
  useEffect(() => {
    panel.current?.dispose();
    panel.current = null;
    render((n) => n + 1);
    return () => {
      panel.current?.dispose();
      panel.current = null;
    };
  }, [controller, controller.contextRevision]);
  const open = (mode: 'tree' | 'changes', turnId?: string) =>
    run(async () => {
      panel.current?.dispose();
      panel.current = null;
      panel.current = await controller.openProjectContent(() => render((n) => n + 1), mode, turnId);
      render((n) => n + 1);
    });
  useImperativeHandle(controlRef, () => ({ open }));
  const value = panel.current?.state;
  return (
    <>
      <button
        type="button"
        aria-label="项目文件"
        title="项目文件"
        disabled={busy}
        onClick={() => open('tree')}
      >
        <FolderOpen size={16} />
      </button>
      <button
        type="button"
        aria-label="历史文件变更"
        title="历史文件变更"
        disabled={busy}
        onClick={() => open('changes')}
      >
        <GitCompareArrows size={16} />
      </button>
      {value && panel.current && (
        <ProjectContentPanel
          {...value}
          onMode={(mode) => {
            run(() => panel.current!.setMode(mode));
          }}
          onTreeMore={() => {
            run(() => panel.current!.treeMore());
          }}
          onFile={(path, size) => {
            run(() => panel.current!.file(path, size));
          }}
          onTurn={(turnId) => {
            run(() => panel.current!.turn(turnId));
          }}
          onDiffFile={(change) => {
            run(() => panel.current!.diffFile(change));
          }}
          onRefresh={() => {
            run(() => panel.current!.refresh());
          }}
          onClose={() => {
            panel.current?.close();
            render((n) => n + 1);
          }}
        />
      )}
    </>
  );
}
