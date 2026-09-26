import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

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
  const latest = useRef({ container, max, preferred, expanded });
  useLayoutEffect(() => {
    latest.current = { container, max, preferred, expanded };
  });
  const frame = useRef<number | undefined>(undefined);
  const drag = useRef<{
    pointerId: number;
    preferred: number;
    expanded: boolean;
    clientX?: number;
  } | null>(null);
  const cancelFrame = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
  }, []);
  const applyWidth = useCallback((next: number) => {
    const value = Math.round(Math.min(latest.current.max, Math.max(minimumWidth, next)));
    setExpanded(false);
    setPreferred(value);
    return value;
  }, []);
  const applyPointer = useCallback(() => {
    frame.current = undefined;
    const current = drag.current;
    const element = latest.current.container;
    if (current?.clientX === undefined || !element) return;
    return applyWidth(element.getBoundingClientRect().right - current.clientX);
  }, [applyWidth]);
  const cancelDrag = useCallback(() => {
    cancelFrame();
    const current = drag.current;
    drag.current = null;
    if (current) {
      setPreferred(current.preferred);
      setExpanded(current.expanded);
    }
  }, [cancelFrame]);
  useEffect(() => {
    if (!open) {
      cancelDrag();
      setExpanded(false);
    }
  }, [open, cancelDrag]);
  useEffect(
    () => () => {
      cancelFrame();
      drag.current = null;
    },
    [container, cancelFrame],
  );
  const persist = (value: number) => {
    try {
      localStorage.setItem(widthKey, String(value));
    } catch {
      // Keep the in-memory preference when storage is unavailable.
    }
  };
  return {
    ref: setContainer,
    expanded,
    toggleExpanded: useCallback(() => setExpanded((value) => !value), []),
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
          if (drag.current) return;
          drag.current = {
            pointerId: event.pointerId,
            preferred: latest.current.preferred,
            expanded: latest.current.expanded,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current.clientX = event.clientX;
          if (frame.current === undefined) frame.current = requestAnimationFrame(applyPointer);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          cancelFrame();
          if (drag.current.clientX !== undefined) {
            drag.current.clientX = event.clientX;
            const value = applyPointer();
            if (value !== undefined) persist(value);
          }
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointerId === event.pointerId) cancelDrag();
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointerId === event.pointerId) cancelDrag();
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
            cancelDrag();
            persist(applyWidth(next));
          }
        }}
      />
    ),
  };
}
