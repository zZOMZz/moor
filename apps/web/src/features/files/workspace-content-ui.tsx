import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  useSyncExternalStore,
  type Ref,
  type RefObject,
} from 'react';
import { FolderOpen, GitCompareArrows } from 'lucide-react';
import { createPortal } from 'react-dom';
import { ProjectContentPanel, type ProjectContentPanelProps } from './project-content-ui';
import type { WorkspaceController } from '../workspace/workspace-controller';

export type WorkspaceContentHandle = { open(mode: 'tree' | 'changes', turnId?: string): boolean };
type Panel = Awaited<ReturnType<WorkspaceController['openProjectContent']>>;
const noop = () => {};
const emptySnapshot = () => null;
async function previewFirstChange(current: Panel) {
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
}

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
  const [currentPanel, setPanel] = useState<Panel | null>(null);
  const panel = useRef<Panel | null>(null);
  const generation = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const [wide, setWide] = useState(() => window.innerWidth >= 1100);
  const value = useSyncExternalStore(
    useCallback((listener) => currentPanel?.subscribe(listener) ?? noop, [currentPanel]),
    useCallback(() => currentPanel?.state ?? null, [currentPanel]),
    emptySnapshot,
  );
  const docked = !!value && !!dockContainer && wide;
  const latest = useRef({ controller, run, onQuote, onToggleExpanded, docked });
  useLayoutEffect(() => {
    latest.current = { controller, run, onQuote, onToggleExpanded, docked };
  });
  useEffect(() => {
    const resize = () => setWide(window.innerWidth >= 1100);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    generation.current++;
    panel.current?.dispose();
    panel.current = null;
    setPanel(null);
    return () => {
      generation.current++;
      panel.current?.dispose();
      panel.current = null;
    };
  }, [controller, controller.contextRevision]);
  const open = useCallback(
    (mode: 'tree' | 'changes', turnId?: string) =>
      latest.current.run(async () => {
        const current = ++generation.current;
        opener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        panel.current?.dispose();
        panel.current = null;
        setPanel(null);
        const next = await latest.current.controller.openProjectContent(noop, mode, turnId);
        if (current !== generation.current) {
          next.dispose();
          return;
        }
        panel.current = next;
        setPanel(next);
        await previewFirstChange(next);
      }),
    [],
  );
  useImperativeHandle(controlRef, () => ({ open }), [open]);
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
  // Stable event proxies keep the independent content snapshot memoizable. They read
  // committed callbacks and validate the live binding at interaction time.
  const actions = useMemo(() => {
    const withPanel = (task: (current: Panel) => Promise<unknown>) => {
      const current = panel.current;
      if (current?.state) latest.current.run(() => task(current));
    };
    return {
      onToggleExpanded: () => latest.current.onToggleExpanded?.(),
      onQuote: (text: string) => {
        if (!panel.current?.state) return;
        if (!latest.current.docked) panel.current.close();
        latest.current.onQuote?.(text);
      },
      onMode: (mode) =>
        withPanel(async (current) => {
          await current.setMode(mode);
          await previewFirstChange(current);
        }),
      onTreeMore: () => withPanel((current) => current.treeMore()),
      onFile: (path, size) => withPanel((current) => current.file(path, size)),
      onTurn: (turnId) =>
        withPanel(async (current) => {
          await current.turn(turnId);
          await previewFirstChange(current);
        }),
      onDiffFile: (change) => withPanel((current) => current.diffFile(change)),
      onRefresh: () =>
        withPanel(async (current) => {
          await current.refresh();
          await previewFirstChange(current);
        }),
      onClose: () => {
        panel.current?.close();
        if (opener.current?.isConnected) opener.current.focus();
      },
    } satisfies Pick<
      ProjectContentPanelProps,
      | 'onToggleExpanded'
      | 'onQuote'
      | 'onMode'
      | 'onTreeMore'
      | 'onFile'
      | 'onTurn'
      | 'onDiffFile'
      | 'onRefresh'
      | 'onClose'
    >;
  }, []);
  const content = value ? (
    <ProjectContentPanel
      {...value}
      {...actions}
      docked={docked}
      returnFocus={opener}
      quoteFocus={quoteFocus}
      expanded={expanded}
      onToggleExpanded={docked && onToggleExpanded ? actions.onToggleExpanded : undefined}
      onQuote={onQuote ? actions.onQuote : undefined}
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
