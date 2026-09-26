import { useEffect, useState, type CSSProperties } from 'react';

const widthKey = 'moor-content-dock-width-v1';
const minimumWidth = 320;
const conversationWidth = 320;
const separatorWidth = 5;

function initialWidth() {
  try {
    const saved = Number(localStorage.getItem(widthKey));
    if (Number.isFinite(saved) && saved >= minimumWidth) return Math.min(saved, 1200);
  } catch {
    // The panel remains resizable when browser storage is unavailable.
  }
  return 420;
}

/** A device-local presentation preference; never part of a shared session or execution target. */
export function useContentDockLayout(open: boolean) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(900);
  const [preferred, setPreferred] = useState(initialWidth);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!open) setExpanded(false);
  }, [open]);
  useEffect(() => {
    if (!container) return;
    const measure = () => {
      const width = container.getBoundingClientRect().width;
      if (width > 0) setAvailable(width);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);
  const max = Math.max(
    minimumWidth,
    Math.min(1200, Math.floor(available - conversationWidth - separatorWidth)),
  );
  const width = Math.round(
    Math.min(max, Math.max(minimumWidth, expanded ? available * 0.62 : preferred)),
  );
  const resize = (next: number) => {
    const value = Math.round(Math.min(max, Math.max(minimumWidth, next)));
    setExpanded(false);
    setPreferred(value);
    try {
      localStorage.setItem(widthKey, String(value));
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  };
  return {
    ref: setContainer,
    expanded,
    toggleExpanded: () => setExpanded((value) => !value),
    style: { '--workspace-content-width': width + 'px' } as CSSProperties,
    sizer: (
      <div
        className="workspace-content-sizer"
        role="separator"
        aria-label="调整审查面板宽度"
        aria-orientation="vertical"
        aria-valuemin={minimumWidth}
        aria-valuemax={Math.floor(max)}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId) && container)
            resize(container.getBoundingClientRect().right - event.clientX);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onKeyDown={(event) => {
          const next = {
            ArrowLeft: width + 24,
            ArrowRight: width - 24,
            Home: minimumWidth,
            End: max,
          }[event.key];
          if (next !== undefined) {
            event.preventDefault();
            resize(next);
          }
        }}
      />
    ),
  };
}
