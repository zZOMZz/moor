import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Ellipsis } from 'lucide-react';
const key = 'moor-workspace-layout-v1';
const clamp = (width: number) => Math.max(220, Math.min(400, width));
function initial(): { width: number; open: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      width: Number.isFinite(value.width) ? clamp(value.width) : 260,
      open: typeof value.open === 'boolean' ? value.open : true,
    };
  } catch {
    return { width: 260, open: true };
  }
}
export function useWorkspaceLayout() {
  const [preference, update] = useState(initial);
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= 700,
  );
  const [open, setOpen] = useState(() =>
    typeof window === 'undefined' || window.innerWidth > 700 ? preference.open : false,
  );
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(preference));
    } catch {
      /* Appearance remains usable without persistent storage. */
    }
  }, [preference]);
  useEffect(() => {
    const resize = () => {
      const next = window.innerWidth <= 700;
      if (next !== narrow) {
        setNarrow(next);
        setOpen(next ? false : preference.open);
      }
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [narrow, preference.open]);
  return {
    narrow,
    open,
    setOpen(value: boolean | ((previous: boolean) => boolean)) {
      setOpen((previous) => {
        const next = typeof value === 'function' ? value(previous) : value;
        if (window.innerWidth > 700) update((saved) => ({ ...saved, open: next }));
        return next;
      });
    },
    width: preference.width,
    resize: (width: number) => update((saved) => ({ ...saved, width: clamp(width) })),
    style: { '--workspace-sidebar-width': preference.width + 'px' } as CSSProperties,
  };
}
export function SidebarSizer({ width, resize }: { width: number; resize(width: number): void }) {
  return (
    <div
      className="workspace-sidebar-sizer"
      role="separator"
      aria-label="调整侧栏宽度"
      aria-orientation="vertical"
      aria-valuemin={220}
      aria-valuemax={400}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        const next = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: 220, End: 400 }[
          event.key
        ];
        if (next !== undefined) {
          event.preventDefault();
          resize(next);
        }
      }}
    />
  );
}
export function WorkspaceToolMenu({ children }: { children: ReactNode }) {
  return (
    <details className="workspace-tool-menu">
      <summary aria-label="会话工具" title="会话工具">
        <Ellipsis size={18} />
      </summary>
      <div className="workspace-tool-menu-items" aria-label="会话工具列表">
        {children}
      </div>
    </details>
  );
}
