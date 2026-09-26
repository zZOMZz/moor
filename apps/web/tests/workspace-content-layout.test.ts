import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

test('dock dragging coalesces pointer samples, persists only release and cancels pending work', async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://synthetic.invalid',
  });
  const win = dom.window;
  for (const name of [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'MouseEvent',
    'navigator',
    'localStorage',
  ])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? win : (win as any)[name],
    });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id);
    },
  });
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useContentDockLayout } = await import('../src/features/files/workspace-content-layout');
  const root = createRoot(document.getElementById('app')!);
  let layoutReads = 0;
  let commits = 0;
  const { useLayoutEffect } = await import('react');
  function Harness({ open = true }: { open?: boolean }) {
    const layout = useContentDockLayout(open);
    useLayoutEffect(() => {
      commits++;
    });
    return createElement(
      'div',
      {
        ref: (node: HTMLDivElement | null) => {
          if (node)
            node.getBoundingClientRect = () => {
              layoutReads++;
              return { right: 1000, width: 1000 } as DOMRect;
            };
          layout.ref(node);
        },
        style: layout.style,
        'data-expanded': layout.expanded,
      },
      layout.sizer,
      createElement('button', { onClick: layout.toggleExpanded }, 'expand'),
    );
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    const separator = document.querySelector<HTMLElement>('[role="separator"]')!;
    let captured: number | undefined;
    separator.setPointerCapture = (id) => {
      captured = id;
    };
    separator.hasPointerCapture = (id) => captured === id;
    separator.releasePointerCapture = () => {
      captured = undefined;
    };
    const pointer = (type: string, clientX: number) => {
      const event = new win.MouseEvent(type, { bubbles: true, button: 0, clientX });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      separator.dispatchEvent(event);
    };
    const flushFrame = () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(16);
    };
    const original = win.Storage.prototype.setItem;
    let writes = 0;
    win.Storage.prototype.setItem = function (key, value) {
      writes++;
      return original.call(this, key, value);
    };
    const beforeReads = layoutReads;
    const beforeCommits = commits;
    await act(async () => {
      pointer('pointerdown', 580);
      for (let x = 579; x >= 480; x--) pointer('pointermove', x);
    });
    assert.equal(frames.size, 1, 'a burst queues only one frame');
    assert.equal(layoutReads, beforeReads, 'pointer events do not force synchronous layout');
    assert.equal(commits, beforeCommits, 'pointer events do not update React before the frame');
    assert.equal(writes, 0);
    await act(async () => flushFrame());
    assert.equal(layoutReads, beforeReads + 1);
    assert.equal(commits, beforeCommits + 1);
    assert.equal(separator.getAttribute('aria-valuenow'), '520');
    assert.equal(writes, 0, 'visible drag progress is not a saved preference');
    await act(async () => {
      pointer('pointermove', 460);
      pointer('pointerup', 450);
    });
    assert.equal(
      separator.getAttribute('aria-valuenow'),
      '550',
      'release consumes its final position',
    );
    assert.equal(frames.size, 0);
    assert.equal(writes, 1);
    assert.equal(localStorage.getItem('moor-content-dock-width-v1'), '550');
    await act(async () => {
      pointer('pointerdown', 450);
      pointer('pointermove', 350);
      flushFrame();
    });
    assert.equal(separator.getAttribute('aria-valuenow'), '650');
    await act(async () => {
      pointer('pointermove', 300);
      pointer('pointercancel', 300);
    });
    assert.equal(
      separator.getAttribute('aria-valuenow'),
      '550',
      'cancel restores the starting preference',
    );
    assert.equal(frames.size, 0);
    assert.equal(writes, 1);
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click());
    assert.equal(separator.parentElement!.dataset.expanded, 'true');
    await act(async () => {
      pointer('pointerdown', 380);
      pointer('pointermove', 350);
      flushFrame();
    });
    await act(async () => root.render(createElement(Harness, { open: false })));
    assert.equal(
      separator.parentElement!.dataset.expanded,
      'false',
      'closing a cancelled expanded drag stays collapsed',
    );
    assert.equal(separator.getAttribute('aria-valuenow'), '550');
    assert.equal(writes, 1);
    await act(async () => root.render(createElement(Harness)));
    await act(async () => {
      pointer('pointerdown', 450);
      pointer('pointermove', 300);
    });
    await act(async () => root.unmount());
    assert.equal(frames.size, 0, 'unmount cancels scheduled reads and updates');
    assert.equal(writes, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
