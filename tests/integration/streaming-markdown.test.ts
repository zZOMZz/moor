import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { markdown, plainCode } from '../../apps/web/src/components/content';

test('streaming Markdown preserves safe formatting across arbitrary chunk boundaries, edits and long code', async () => {
  const dom = new JSDOM('<div id="app"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { StreamingMarkdown } =
    await import('../../apps/web/src/features/sessions/streaming-markdown');
  const root = createRoot(dom.window.document.getElementById('app')!);
  const normalized = (html: string) => {
    const template = dom.window.document.createElement('template');
    template.innerHTML = html;
    // Incremental leaves add transparent spans so completed text nodes stay mounted.
    for (const span of template.content.querySelectorAll('span'))
      span.replaceWith(...span.childNodes);
    for (const button of template.content.querySelectorAll('[data-copy]')) {
      button.setAttribute('data-copy', '');
      button.removeAttribute('title');
    }
    return template.innerHTML;
  };
  const render = async (text: string) => {
    await act(async () => root.render(createElement(StreamingMarkdown, { text })));
    const rendered = dom.window.document.querySelector('.markdown')!;
    assert.equal(
      normalized(rendered.outerHTML),
      normalized(markdown(text)),
      `source: ${text.slice(-120)}`,
    );
    assert.equal(rendered.querySelector('script,img,iframe,[href^="javascript:"]'), null);
    return rendered;
  };
  try {
    const text =
      '# 标题\r\n\r\n**bold** and `x < y`\nnext [safe](https://example.com)\n\n- first\n* second\n1. ordered\n2. next\n\n> quote\n```ts\nconst x = "<script>";\n\u001b[31mred\u001b[0m\n```\n\n[bad](javascript:alert) <img src=x>\n```invalid```\ntext';
    for (let end = 0; end <= text.length; end++) await render(text.slice(0, end));
    for (const changed of [
      text.replace('first', 'edited'),
      text.slice(0, 45),
      '',
      'replacement',
      text,
    ])
      await render(changed);
    for (const code of [
      'x'.repeat(4095) + '😀' + 'y'.repeat(4097),
      'isolated high \ud800 and low \udc00 remain code units',
      'x'.repeat(120_010),
      '\u001b[31m'.repeat(100) + 'safe',
    ]) {
      await render('```\n' + code);
      await render('```\n' + code + '\n```\nfinished');
    }
    for (const source of [
      'paragraph \ud800 with an isolated low \udc00\ncontinued',
      '# heading \ud800\n\n> quote \udc00\n- list \ud800\n- next \udc00',
    ]) {
      await render(source);
      await render(source + '\nmore');
    }
    // The plain-code fast path must return to the conservative parser as soon
    // as ANSI/CR can reinterpret a provisional suffix. Compare every character.
    for (const ending of [
      '\u001b[31mred\u001b[0m\n```\nnext',
      '\u001b[1;2:3 /~after\n``` trailing\n```\nnext',
      '\u001b[12x\u001b[?9 bad\u001bX\n```\nnext',
      '\r\n```\r\nnext',
      '\n`\n``\n``` more\n```\nnext',
    ]) {
      const start = '```js\n' + 'x'.repeat(5000);
      await render(start);
      for (let end = 1; end <= ending.length; end++) await render(start + ending.slice(0, end));
    }
    const unicodePrefix = '```js\n' + 'x'.repeat(8191);
    await render(unicodePrefix + '\ud83d');
    const unicode = await render(unicodePrefix + '😀');
    for (const part of unicode.querySelectorAll('pre code > span')) {
      assert.doesNotMatch(part.textContent!, /[\uD800-\uDBFF]$/);
      assert.doesNotMatch(part.textContent!, /^[\uDC00-\uDFFF]/);
    }
    // Count actual sanitizer input, not machine time. The legacy reference is
    // intentionally not rendered inside this window because it reparses fully.
    for (const size of [65_536, 262_144]) {
      let source = '```js\n' + 'x'.repeat(size);
      const initial = await render(source);
      const firstPart = initial.querySelector('code')!.firstChild;
      const replace = String.prototype.replace;
      let sanitized = 0;
      String.prototype.replace = function (
        this: string,
        search: string | RegExp,
        ...rest: unknown[]
      ) {
        if (search instanceof RegExp && search.source === '\\x1b\\[[0-?]*[ -/]*[@-~]')
          sanitized += this.length;
        return Reflect.apply(replace, this, [search, ...rest]);
      } as typeof replace;
      try {
        assert.equal(plainCode('counter'), 'counter');
        assert.equal(sanitized, 7, 'the counter observes the actual code sanitizer');
        sanitized = 0;
        for (let index = 0; index < 10; index++) {
          source += 'x';
          await act(async () => root.render(createElement(StreamingMarkdown, { text: source })));
          const code = dom.window.document.querySelector('code')!;
          assert.equal(code.firstChild, firstPart);
          assert.equal(code.textContent, 'x'.repeat(Math.min(size + index + 1, 120_000)));
        }
        assert.equal(sanitized, 0, 'plain appends never rescan the already parsed code line');
      } finally {
        String.prototype.replace = replace;
      }
      await render(source + '\n```\ncomplete');
      await render(source.replace('xxxxx', '<tag>') + '\n```');
    }
    const prefix =
      '# Stable heading\n\nselected paragraph\n\n```js\n' + 'const value = 1;\n'.repeat(700);
    const current = await render(prefix);
    const heading = current.querySelector('h2');
    const paragraph = current.querySelector('p');
    const code = current.querySelector('pre code')!;
    const firstCodePart = code.firstChild;
    const range = dom.window.document.createRange();
    range.selectNodeContents(paragraph!);
    dom.window.getSelection()!.addRange(range);
    for (const suffix of ['tail', 'tail\n', 'tail\n```\n\nnext block']) {
      await render(prefix + suffix);
      assert.equal(current.querySelector('h2'), heading);
      assert.equal(current.querySelector('p'), paragraph);
      assert.equal(current.querySelector('pre code'), code);
      assert.equal(code.firstChild, firstCodePart);
      assert.equal(dom.window.getSelection()!.toString(), 'selected paragraph');
    }
    const copied: string[] = [];
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => copied.push(value) },
    });
    await act(async () => current.querySelector<HTMLButtonElement>('[data-copy]')!.click());
    assert.deepEqual(copied, [code.textContent]);
    const unpairedText = 'high \ud800 low \udc00';
    const unpaired = await render('```\n' + unpairedText + '\n```');
    await act(async () => unpaired.querySelector<HTMLButtonElement>('[data-copy]')!.click());
    assert.equal(copied.at(-1), unpairedText, 'copying preserves every original UTF-16 code unit');
    const capped = await render('```\n' + 'z'.repeat(120_010));
    await act(async () => capped.querySelector<HTMLButtonElement>('[data-copy]')!.click());
    assert.equal(copied.at(-1), 'z'.repeat(120_000));
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error('denied');
        },
      },
    });
    await act(async () => capped.querySelector<HTMLButtonElement>('[data-copy]')!.click());
    assert.equal(capped.querySelector('[data-copy]')!.textContent, '复制失败');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
