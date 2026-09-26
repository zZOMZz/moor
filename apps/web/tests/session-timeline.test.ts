import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import {
  SessionTimeline,
  SessionInformation,
  hasTurnFileChanges,
  type TimelineTurn,
} from '../src/features/sessions/session-timeline';
const event = {
  type: 'session_event',
  event: { version: 1, source: 'acp', kind: 'context-usage', used: 10, size: 100 },
};
const turn: TimelineTurn = {
  id: 'turn',
  role: 'assistant',
  finished: true,
  items: [
    { type: 'text', text: '**正文**' },
    event,
    { type: 'tool_call', title: 'ordinary tool' },
    { type: 'tool_call', title: 'approval required', permissionRequest: { requestId: 'request' } },
    { type: 'tool_call', title: 'failed tool', status: 'failed' },
  ],
};
test('shared timeline retains actionable records and share plain text, collapsed tools and separate information', () => {
  {
    const html = renderToStaticMarkup(
      createElement(SessionTimeline, {
        history: [turn],
        renderItem: (item: any) => createElement('p', null, item.title),
      }),
    );
    assert.match(html, /<strong>正文<\/strong>/);
    assert.doesNotMatch(html, /context-usage|用量/);
    assert.match(html, /<details class="session-tool-details">/);
    assert.match(html, /<span>工具与思考<\/span><span class="session-tool-count">1<\/span>/);
    assert.doesNotMatch(html, /ordinary tool|session-tool-content/);
    assert.match(html, /approval required/);
    assert.match(html, /failed tool/);
    const tools = html.slice(html.indexOf('<details'), html.indexOf('</details>'));
    assert.doesNotMatch(tools, /approval required|failed tool/);
  }
  const html = renderToStaticMarkup(
    createElement(SessionInformation, { history: [turn], disabled: false, onCommand: () => {} }),
  );
  assert.match(html, /会话信息/);
  assert.doesNotMatch(html, /session-information-panel|最近上报/);
  assert.doesNotMatch(html, /<details[^>]* open/);
});
test('tool disclosures preserve transcript order and keep active work outside collapsed groups', () => {
  const html = renderToStaticMarkup(
    createElement(SessionTimeline, {
      history: [
        {
          ...turn,
          finished: false,
          items: [
            { type: 'text', text: 'before operation' },
            { type: 'tool_call', title: 'read synthetic file', status: 'completed' },
            { type: 'text', text: 'after operation' },
            { type: 'tool_call', title: 'check synthetic file', status: 'completed' },
            { type: 'tool_call', title: 'running synthetic check', status: 'in_progress' },
            { type: 'tool_call', title: 'waiting synthetic approval', permissionRequest: {} },
            { type: 'tool_call', title: 'failed synthetic check', status: 'failed' },
          ],
        },
      ],
      renderItem: (item: any) => createElement('p', null, item.title),
    }),
  );
  const disclosures = [...html.matchAll(/<details class="session-tool-details">.*?<\/details>/g)];
  assert.equal(disclosures.length, 2);
  assert.doesNotMatch(html, /read synthetic file|check synthetic file|session-tool-content/);
  assert.ok(html.indexOf('before operation') < disclosures[0]!.index!);
  assert.ok(disclosures[0]!.index! < html.indexOf('after operation'));
  assert.ok(html.indexOf('after operation') < disclosures[1]!.index!);
  assert.ok(disclosures[1]!.index! < html.indexOf('running synthetic check'));
  for (const [details] of disclosures)
    assert.doesNotMatch(details, /running synthetic|waiting synthetic|failed synthetic/);
  assert.match(html, /正在执行/);
  assert.match(html, /执行失败/);
});
test('turn changes need a matching saved reference and positive count; unknown or empty results never create a diff action', () => {
  const fileDiff = {
    contentVersion: 1,
    basis: 'project-snapshot',
    turnId: 'turn',
    diffId: 'diff',
    state: 'ready',
    version: 'sha256:' + 'a'.repeat(64),
    changeCount: 1,
  };
  assert.equal(hasTurnFileChanges({ ...turn, fileDiff }), true);
  assert.equal(hasTurnFileChanges({ ...turn, fileDiff: { ...fileDiff, state: 'partial' } }), true);
  for (const value of [
    null,
    { ...fileDiff, turnId: 'other' },
    { ...fileDiff, changeCount: 0 },
    { ...fileDiff, state: 'unavailable' },
    { ...fileDiff, state: 'pending', version: undefined, changeCount: 0 },
  ])
    assert.equal(hasTurnFileChanges({ ...turn, fileDiff: value }), false);
});

test('following survives delayed programmatic scroll events and preserves deliberate reading positions', async () => {
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
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  install('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  install('cancelAnimationFrame', (id: number) => frames.delete(id));
  const observers = new Set<ResizeObserverCallback>();
  install(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {
        observers.add(callback);
      }
      observe() {}
      disconnect() {
        observers.delete(this.callback);
      }
    },
  );
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('app')!);
  let revision = 0;
  const render = (focusTurnId?: string) =>
    root.render(
      createElement(SessionTimeline, {
        history: [{ ...turn, items: [{ type: 'text', text: String(++revision) }] }],
        focusTurnId,
        renderItem: () => null,
      }),
    );
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(16);
  };
  const resize = () => {
    for (const callback of observers) callback([], {} as ResizeObserver);
  };
  try {
    await act(async () => render());
    const viewport = document.querySelector<HTMLElement>('.workspace-history')!;
    let height = 1000;
    let clientHeight = 400;
    let top = 0;
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => height },
      clientHeight: { get: () => clientHeight },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, height - clientHeight));
        },
      },
    });
    const scroll = () => viewport.dispatchEvent(new win.Event('scroll'));
    const jump = () => document.querySelector<HTMLButtonElement>('.session-jump-latest');
    await act(async () => flushFrame());
    assert.equal(top, 600);

    // A React commit grows the content before the browser delivers the event
    // queued by the prior programmatic scroll. No user has moved the viewport.
    height += 300;
    await act(async () => render());
    await act(async () => scroll());
    assert.equal(!!jump(), false);
    await act(async () => flushFrame());
    assert.equal(top, 900, 'the delayed event must not disable the queued follow');

    // A genuine upward move must cancel even an already queued follow frame.
    height += 200;
    await act(async () => render());
    await act(async () => {
      viewport.scrollTop = 700;
      scroll();
    });
    assert.ok(jump());
    await act(async () => flushFrame());
    assert.equal(top, 700);
    await act(async () => resize());
    assert.equal(frames.size, 0, 'resizing does not disturb someone reading history');

    await act(async () => jump()!.click());
    await act(async () => flushFrame());
    assert.equal(top, 1100);
    assert.equal(!!jump(), false);
    clientHeight = 300;
    await act(async () => resize());
    await act(async () => scroll());
    await act(async () => flushFrame());
    assert.equal(top, 1200, 'viewport shrink preserves following');

    const article = document.querySelector<HTMLElement>('[data-turn-id="turn"]')!;
    let searchScrolls = 0;
    article.scrollIntoView = () => {
      searchScrolls++;
      viewport.scrollTop = 200;
      scroll();
    };
    await act(async () => render('turn'));
    assert.equal(searchScrolls, 1);
    assert.equal(document.activeElement, article);
    assert.ok(jump());
    height += 400;
    await act(async () => render('turn'));
    await act(async () => resize());
    assert.equal(frames.size, 0);
    assert.equal(top, 200, 'later output retains the search result position');

    await act(async () => {
      viewport.scrollTop = height - clientHeight;
      scroll();
    });
    assert.equal(!!jump(), false, 'manually returning to the bottom resumes following');
    height += 100;
    await act(async () => resize());
    assert.equal(frames.size, 1);
    await act(async () => root.unmount());
    assert.equal(frames.size, 0);
    assert.equal(observers.size, 0);
  } finally {
    await act(async () => root.unmount());
    win.close();
    for (const [name, descriptor] of globals)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
});
