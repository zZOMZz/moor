import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { LoroDoc, LoroList, LoroMap } from 'loro-crdt';
import { appendSessionText } from '@moor/session/session-output';
import type { TimelineTurn } from '../../apps/web/src/features/sessions/session-timeline';

async function timeline(t: TestContext) {
  const dom = new JSDOM('<div id="app"></div>');
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { SessionTimeline } = await import('../../apps/web/src/features/sessions/session-timeline');
  const root = createRoot(dom.window.document.getElementById('app')!);
  const renderItem = (value: unknown, index: number) =>
    createElement('span', { 'data-item-index': index }, JSON.stringify(value));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    dom,
    act,
    document: dom.window.document,
    async render(history: TimelineTurn[], confirmed = true, live = true) {
      await act(async () =>
        root.render(createElement(SessionTimeline, { history, confirmed, live, renderItem })),
      );
    },
  };
}

const usage = {
  type: 'session_event',
  event: { version: 1, source: 'acp', kind: 'context-usage', used: 100, size: 2000 },
};

test('Host text separated by hidden observations keeps Markdown, selection and code copying continuous', async (t) => {
  const view = await timeline(t);
  const doc = new LoroDoc();
  t.after(() => doc.free());
  doc.getMap('session').set('id', 'session');
  const turn = doc.getList('history').pushContainer(new LoroMap());
  turn.set('id', 'assistant');
  turn.set('role', 'assistant');
  turn.set('finished', false);
  const append = (text: string) => appendSessionText(doc, 'session', 'assistant', 'text', text);
  const render = () => view.render(doc.toJSON().history as TimelineTurn[]);
  append('# Stable heading\n\nselected paragraph\n\n```js\nconst answer = ');
  await render();
  const heading = view.document.querySelector('h2');
  const paragraph = view.document.querySelector('.markdown p')!;
  const code = view.document.querySelector('pre code')!;
  const range = view.document.createRange();
  range.selectNodeContents(paragraph);
  view.dom.window.getSelection()!.addRange(range);
  const items = turn.get('items') as LoroList;
  items.push(usage);
  append('42;');
  await render();
  assert.equal(view.document.querySelectorAll('pre code').length, 1);
  assert.equal(code.textContent, 'const answer = 42;');
  items.push({
    type: 'session_event',
    event: { version: 1, source: 'acp', kind: 'commands', commands: [] },
  });
  append('\n```\n\n[unsafe](javascript:alert) <script>bad()</script> [safe](https://example.com)');
  await render();
  assert.equal(view.document.querySelector('h2'), heading);
  assert.equal(view.document.querySelector('.markdown p'), paragraph);
  assert.equal(view.document.querySelector('pre code'), code);
  assert.equal(view.dom.window.getSelection()!.toString(), 'selected paragraph');
  assert.equal(view.document.querySelectorAll('.session-message-text').length, 1);
  assert.equal(view.document.querySelector('script,img,iframe,[href^="javascript:"]'), null);
  assert.equal(view.document.querySelector('a')?.href, 'https://example.com/');
  const copied: string[] = [];
  Object.defineProperty(view.dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => copied.push(value) },
  });
  await view.act(async () =>
    view.document.querySelector<HTMLButtonElement>('[data-copy]')!.click(),
  );
  assert.deepEqual(copied, ['const answer = 42;']);
  assert.deepEqual(
    (doc.toJSON().history as TimelineTurn[])[0]!.items!.map((item: any) => item.type),
    ['text', 'session_event', 'text', 'session_event', 'text'],
    'presentation does not rewrite the Host-authored timeline',
  );
});

test('real item boundaries stay separate and telemetry-separated streaming retains parsed code blocks', async (t) => {
  const view = await timeline(t);
  for (const boundary of [
    { type: 'tool_call', status: 'completed', title: 'Read file' },
    { type: 'tool_call', permissionRequest: { requestId: 'permission' } },
    { type: 'attachment', name: 'file.txt' },
    { type: 'question', status: 'pending' },
    { type: 'thought', text: 'Intermediate reasoning' },
    { type: 'system_notice', message: 'Important notice' },
    { type: 'session_event', event: { kind: 'unknown' } },
  ]) {
    await view.render([
      {
        id: 'assistant',
        role: 'assistant',
        finished: true,
        items: [
          { type: 'text', text: 'Before' },
          usage,
          boundary,
          usage,
          { type: 'text', text: 'After' },
        ],
      },
    ]);
    assert.equal(view.document.querySelectorAll('.session-message-text').length, 2, boundary.type);
    if (boundary.type === 'tool_call' && 'permissionRequest' in boundary)
      assert.ok(view.document.querySelector('[data-item-index="2"]'), 'approval stays visible');
  }
  const prefix = { type: 'text', text: '```js\n' + 'x'.repeat(65_536) };
  let suffix = '';
  const history = (event = usage): TimelineTurn[] => [
    {
      id: 'stream',
      role: 'assistant',
      finished: false,
      items: [prefix, event, { type: 'text', text: suffix }],
    },
  ];
  await view.render(history());
  const code = view.document.querySelector('pre code')!;
  const firstPart = code.firstChild;
  const replace = String.prototype.replace;
  let sanitized = 0;
  String.prototype.replace = function (this: string, search: string | RegExp, ...rest: unknown[]) {
    if (search instanceof RegExp && search.source === '\\x1b\\[[0-?]*[ -/]*[@-~]')
      sanitized += this.length;
    return Reflect.apply(replace, this, [search, ...rest]);
  } as typeof replace;
  try {
    for (let index = 0; index < 10; index++) {
      suffix += 'y';
      await view.render(history());
      assert.equal(view.document.querySelector('pre code'), code);
      assert.equal(code.firstChild, firstPart);
      assert.equal(code.textContent, 'x'.repeat(65_536) + suffix);
    }
    assert.equal(sanitized, 0, 'joining text never reparses the completed code prefix');
    let mutations = 0;
    const observer = new view.dom.window.MutationObserver(
      (records) => (mutations += records.length),
    );
    observer.observe(view.document.querySelector('.session-timeline-content')!, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    await view.render(history({ ...usage, event: { ...usage.event, used: 101 } }));
    mutations += observer.takeRecords().length;
    observer.disconnect();
    assert.equal(mutations, 0, 'changing only hidden metadata leaves visible content untouched');
    assert.equal(sanitized, 0);
  } finally {
    String.prototype.replace = replace;
  }
});

test('only confirmed assistant terminal facts label stopped and failed history without claiming success', async (t) => {
  const view = await timeline(t);
  const turn: TimelineTurn = {
    id: 'assistant',
    role: 'assistant',
    finished: true,
    status: 'canceled',
    items: [{ type: 'text', text: 'Partial output' }],
  };
  await view.render([turn], false);
  assert.equal(view.document.querySelector('[data-terminal]'), null);
  await view.render([turn], true, false);
  assert.equal(view.document.querySelector('[data-terminal="canceled"]')?.textContent, '已停止');
  assert.equal(view.document.querySelector('.session-turn-progress'), null);
  await view.render([{ ...turn, status: 'failed' }]);
  assert.equal(view.document.querySelector('[data-terminal="failed"]')?.textContent, '执行失败');
  for (const status of ['handled', 'unknown', undefined]) {
    await view.render([{ ...turn, status }]);
    assert.equal(view.document.querySelector('[data-terminal]'), null);
    assert.doesNotMatch(view.document.querySelector('.workspace-turn')!.textContent!, /成功/);
  }
  await view.render([{ ...turn, finished: false }]);
  assert.equal(view.document.querySelector('[data-terminal]'), null);
  assert.equal(view.document.querySelector('.session-turn-progress')?.textContent, '进行中');
});
