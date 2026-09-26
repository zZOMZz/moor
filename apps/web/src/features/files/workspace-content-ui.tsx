import { useEffect, useRef, useState, useImperativeHandle, type Ref, type RefObject } from 'react';
import { FolderOpen, GitCompareArrows } from 'lucide-react';
import { createPortal } from 'react-dom';
import { ProjectContentPanel } from './project-content-ui';
import type { WorkspaceController } from '../workspace/workspace-controller';

export type WorkspaceContentHandle = { open(mode: 'tree' | 'changes', turnId?: string): boolean };

export function WorkspaceContentUI({
  controller,
  busy,
  run,
  controlRef,
  dockContainer,
  onVisibilityChange,
  expanded,
  onToggleExpanded,
  onQuote,
  quoteFocus,
  hideTriggers = false,
}: {
  controller: WorkspaceController;
  controlRef?: Ref<WorkspaceContentHandle>;
  dockContainer?: HTMLElement | null;
  onVisibilityChange?(open: boolean): void;
  expanded?: boolean;
  onToggleExpanded?(): void;
  onQuote?(text: string): void;
  quoteFocus?: RefObject<HTMLElement | null>;
  hideTriggers?: boolean;
  busy: boolean;
  run(task: () => Promise<unknown>): boolean;
}) {
  const [, render] = useState(0);
  type Panel = Awaited<ReturnType<WorkspaceController['openProjectContent']>>;
  const panel = useRef<Panel | null>(null);
  const generation = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const [wide, setWide] = useState(() => window.innerWidth >= 1100);
  useEffect(() => {
    const resize = () => setWide(window.innerWidth >= 1100);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    generation.current++;
    panel.current?.dispose();
    panel.current = null;
    render((n) => n + 1);
    return () => {
      generation.current++;
      panel.current?.dispose();
      panel.current = null;
    };
  }, [controller, controller.contextRevision]);
  const previewFirstChange = async (current: Panel) => {
    const state = current.state;
    const first = state?.diff?.result.changes[0];
    if (
      state?.mode === 'changes' &&
      !state.error &&
      !state.diffFile &&
      state.diff?.result.reference?.version &&
      first
    )
      await current.diffFile(first);
  };
  const open = (mode: 'tree' | 'changes', turnId?: string) =>
    run(async () => {
      const current = ++generation.current;
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      panel.current?.dispose();
      panel.current = null;
      const next = await controller.openProjectContent(() => render((n) => n + 1), mode, turnId);
      if (current !== generation.current) {
        next.dispose();
        return;
      }
      panel.current = next;
      render((n) => n + 1);
      await previewFirstChange(next);
    });
  useImperativeHandle(controlRef, () => ({ open }));
  const value = panel.current?.state;
  const docked = !!value && !!dockContainer && wide;
  useEffect(() => {
    onVisibilityChange?.(docked);
    return () => onVisibilityChange?.(false);
  }, [docked, onVisibilityChange]);
  useEffect(() => {
    if (!docked || !dockContainer) return;
    const frame = requestAnimationFrame(() => {
      dockContainer.querySelector<HTMLButtonElement>('[aria-label="关闭文件与变更"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [docked, dockContainer]);
  const content =
    value && panel.current ? (
      <ProjectContentPanel
        {...value}
        docked={docked}
        returnFocus={opener}
        quoteFocus={quoteFocus}
        expanded={expanded}
        onToggleExpanded={docked ? onToggleExpanded : undefined}
        onQuote={
          onQuote
            ? (text) => {
                // Recheck the controller's account/device/project/session binding at click time.
                if (!panel.current?.state) return;
                if (!docked) {
                  panel.current.close();
                  render((n) => n + 1);
                }
                onQuote(text);
              }
            : undefined
        }
        onMode={(mode) => {
          const current = panel.current!;
          run(async () => {
            await current.setMode(mode);
            await previewFirstChange(current);
          });
        }}
        onTreeMore={() => {
          run(() => panel.current!.treeMore());
        }}
        onFile={(path, size) => {
          run(() => panel.current!.file(path, size));
        }}
        onTurn={(turnId) => {
          const current = panel.current!;
          run(async () => {
            await current.turn(turnId);
            await previewFirstChange(current);
          });
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
          if (opener.current?.isConnected) opener.current.focus();
        }}
      />
    ) : null;
  return (
    <>
      {!hideTriggers && (
        <>
          <button
            type="button"
            aria-label="项目文件"
            title="项目文件"
            disabled={busy}
            onClick={() => open('tree')}
          >
            <FolderOpen size={16} />
            <span>项目文件</span>
          </button>
          <button
            type="button"
            aria-label="历史文件变更"
            title="历史文件变更"
            disabled={busy}
            onClick={() => open('changes')}
          >
            <GitCompareArrows size={16} />
            <span>文件变更</span>
          </button>
        </>
      )}
      {docked ? createPortal(content, dockContainer!) : content}
    </>
  );
}
