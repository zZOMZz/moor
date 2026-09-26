import { useCallback, useLayoutEffect, useRef, type ComponentPropsWithRef } from 'react';

/** Presentation only: the owner retains draft persistence and submit authorization. */
export function ComposerInput({
  ref,
  className,
  value,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  ...props
}: ComponentPropsWithRef<'textarea'>) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const setInput = useCallback(
    (node: HTMLTextAreaElement | null) => {
      input.current = node;
      if (typeof ref === 'function') return ref(node);
      if (ref) ref.current = node;
    },
    [ref],
  );
  const resize = () => {
    const node = input.current;
    if (!node) return;
    node.style.height = 'auto';
    // Hidden panes (and non-layout DOMs) have no usable measurement yet.
    if (!node.scrollHeight) return;
    // Let CSS clamp the used height, including viewport-dependent limits.
    node.style.height = node.scrollHeight + 'px';
    node.style.overflowY = node.scrollHeight > node.clientHeight ? 'auto' : 'hidden';
  };
  useLayoutEffect(resize, [value]);
  useLayoutEffect(() => {
    const node = input.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let width = node.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = node.getBoundingClientRect().width;
      if (nextWidth !== width) {
        width = nextWidth;
        resize();
      }
      // The viewport can change the CSS max-height without changing the width.
      // Update scrolling without another height write, so observer delivery settles.
      node.style.overflowY = node.scrollHeight > node.clientHeight ? 'auto' : 'hidden';
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <textarea
      {...props}
      ref={setInput}
      className={['composer-input', className].filter(Boolean).join(' ')}
      value={value}
      onCompositionStart={(event) => {
        composing.current = true;
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        onCompositionEnd?.(event);
      }}
      onKeyDown={(event) => {
        // Some IMEs report Enter before compositionend without isComposing.
        // Keep those keystrokes out of the owner's submit / Skills shortcuts.
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        onKeyDown?.(event);
      }}
    />
  );
}
