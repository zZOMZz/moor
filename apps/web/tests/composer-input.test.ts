import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

test('composer measurement cannot clamp transcript scrolling and releases its temporary box constraint', async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://synthetic.invalid',
  });
  const win = dom.window;
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  };
  for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'navigator'])
    install(name, name === 'window' ? win : (win as any)[name]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  let naturalHeight = 139;
  let hidden = false;
  let input: HTMLTextAreaElement;
  let scrollTop = 9680;
  const usedHeight = () =>
    hidden ? 0 : Math.min(220, Number.parseFloat(input?.style.height ?? '') || 58);
  const boxHeight = () =>
    hidden
      ? 0
      : Math.max(usedHeight() + 60, Number.parseFloat(input.parentElement!.style.minHeight) || 0);
  const measure = () => {
    // Model the browser's synchronous scroll clamp when the sibling composer
    // becomes shorter during a layout read. Initial viewport height is 320px.
    const clientHeight = 320 + 199 - boxHeight();
    scrollTop = Math.min(scrollTop, 10_000 - clientHeight);
  };
  install('getComputedStyle', (node: Element) =>
    node === input?.parentElement ? { height: boxHeight() + 'px' } : win.getComputedStyle(node),
  );
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ComposerInput } = await import('../src/features/sessions/composer-input');
  const root = createRoot(document.getElementById('app')!);
  const attach = (node: HTMLTextAreaElement | null) => {
    if (!node) return;
    input = node;
    input.style.height = '139px';
    Object.defineProperties(input, {
      scrollHeight: {
        get: () => {
          measure();
          return hidden ? 0 : naturalHeight;
        },
      },
      clientHeight: { get: usedHeight },
    });
  };
  const render = (value: string) =>
    root.render(
      createElement(
        'div',
        null,
        createElement(ComposerInput, { ref: attach, value, onChange: () => {} }),
      ),
    );
  try {
    await act(async () => render('long draft'));
    assert.equal(scrollTop, 9680, 'auto measurement must not move the transcript up by 81px');
    assert.equal(input!.style.height, '139px');
    const box = input!.parentElement!;
    assert.equal(box.style.minHeight, '');
    box.style.setProperty('min-height', '23px', 'important');
    await act(async () => render('long draft with another character'));
    assert.equal(scrollTop, 9680);
    assert.equal(box.style.minHeight, '23px');
    assert.equal(box.style.getPropertyPriority('min-height'), 'important');

    naturalHeight = 58;
    await act(async () => render('short'));
    assert.equal(input!.style.height, '58px');
    assert.equal(boxHeight(), 118, 'the final smaller draft must release the old height');
    assert.equal(box.style.minHeight, '23px');
    naturalHeight = 500;
    await act(async () => render('large draft'));
    assert.equal(input!.style.overflowY, 'auto', 'CSS can still cap a large input and scroll it');
    assert.equal(box.style.minHeight, '23px');

    hidden = true;
    await act(async () => render('hidden draft'));
    assert.equal(box.style.minHeight, '23px', 'zero-layout early return retains existing styles');
    assert.equal(box.style.getPropertyPriority('min-height'), 'important');
  } finally {
    await act(async () => root.unmount());
    win.close();
    for (const [name, descriptor] of globals)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
});
