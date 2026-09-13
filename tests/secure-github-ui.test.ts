import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import type { SecureGithubUiHandle } from '../src/web/secure-github-ui';
import type { SecureGithubMode } from '../src/web/secure-github';
import { fixture, target, version, head, base, signal } from './support/secure-github-fixture';

async function mount(t: TestContext, f = fixture()) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'moor-client://app/remote/',
    pretendToBeVisual: true,
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const set = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const name of [
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLFormElement',
    'Element',
    'Node',
    'MutationObserver',
    'Event',
    'MouseEvent',
    'navigator',
    'FormData',
    'NodeFilter',
    'Document',
    'DocumentFragment',
    'ShadowRoot',
    'DOMRect',
    'KeyboardEvent',
  ])
    set(name, (dom.window as unknown as Record<string, unknown>)[name]);
  set('window', dom.window);
  set('IS_REACT_ACT_ENVIRONMENT', true);
  set('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  const animation = (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  };
  const resize = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const media = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  set('requestAnimationFrame', animation);
  set('cancelAnimationFrame', () => {});
  set('ResizeObserver', resize);
  set('matchMedia', media);
  Object.assign(dom.window, {
    requestAnimationFrame: animation,
    cancelAnimationFrame() {},
    ResizeObserver: resize,
    matchMedia: media,
  });
  const { createElement, createRef, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { SecureGithubUI } = await import('../src/web/secure-github-ui');
  t.mock.method(
    crypto.subtle,
    'digest',
    async (_algorithm: AlgorithmIdentifier, input: BufferSource) => {
      const bytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      return Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer;
    },
  );
  const ref = createRef<SecureGithubUiHandle>(),
    root = createRoot(dom.window.document.getElementById('app')!);
  const render = async () => {
    await act(async () => root.render(createElement(SecureGithubUI, { ...f.deps, ref })));
  };
  await render();
  const button = (label: string) => {
    const found = [...dom.window.document.querySelectorAll('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label,
    );
    assert(found, `Missing button: ${label}`);
    return found;
  };
  const field = (label: string) => {
    const wrapper = [...dom.window.document.querySelectorAll('label')].find((item) =>
      item.textContent!.startsWith(label),
    );
    const found = wrapper?.querySelector<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >('input,textarea,select');
    assert(found, `Missing field: ${label}`);
    return found;
  };
  const change = async (label: string, value: string) => {
    const node = field(label);
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')!.set!.call(node, value);
      node.dispatchEvent(
        new dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
      );
    });
  };
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  return {
    ...f,
    ref,
    act,
    render,
    button,
    field,
    change,
    document: dom.window.document,
    async open(mode?: SecureGithubMode) {
      await act(async () => ref.current!.open(f.state.context.target!, mode));
    },
    async click(label: string) {
      await act(async () => button(label).click());
    },
  };
}
function callback(node: Element): () => void {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps'))!;
  return (node as unknown as Record<string, { onClick(): void }>)[key].onClick;
}

test('trusted GitHub UI reads safe text, quotes explicitly, navigates writes, reviews exact body and recovers original unknown result', async (t) => {
  const f = await mount(t);
  await f.open();
  await f.click('读取 PRs');
  const item = [...f.document.querySelectorAll('button')].find((b) =>
    b.textContent!.includes('#2 Synthetic private PR title'),
  )!;
  await f.act(async () => item.click());
  assert.ok(f.document.body.textContent!.includes(f.item.body));
  assert.equal(f.document.querySelectorAll('script,img,iframe').length, 0);
  assert.doesNotMatch(JSON.stringify([...f.memory.values]), /Synthetic provider body/);
  await f.click('将正文加入草稿');
  assert.ok(f.state.appended.includes(f.item.body));
  await f.click('审查、评论与发布');
  await f.click('编写会话评论');
  await f.change('待发布正文', 'My explicit manual comment');
  await f.click('审查本次操作');
  assert.match(
    f.document.querySelector('[aria-label="最终写入确认"]')!.textContent!,
    /My explicit manual comment/,
  );
  assert.equal(f.calls.filter((c) => c.method === 'github-write-action').length, 0);
  f.state.lost = true;
  await f.click('确认发布会话评论');
  const original = f.calls.find((c) => c.method === 'github-write-action')!;
  assert.match(f.document.body.textContent!, /等待核查/);
  assert.equal(f.button('核查原操作结果').disabled, false);
  await f.act(async () => f.ref.current!.close());
  const before = f.calls.filter((c) => c.method === 'github-write-action').length;
  await f.open('write');
  assert.equal(f.calls.filter((c) => c.method === 'github-write-action').length, before);
  f.state.lost = false;
  f.state.phase = 'unknown';
  await f.click('核查原操作结果');
  assert.deepEqual(f.calls.at(-1)!.params, { request: original.params, page: 1 });
  const consent = f.field('结束核查；若远端已开始执行，其结果仍可能未知') as HTMLInputElement;
  await f.act(async () => consent.click());
  f.state.released = true;
  await f.click('结束原操作核查');
  assert.match(f.document.body.textContent!, /远端结果仍未知/);
  assert.equal(f.calls.filter((c) => c.method === 'github-write-action').length, 1);
});

test('old render click cannot confirm a newly prepared manual body; offline restart edits the original draft without RPC', async (t) => {
  const f = await mount(t),
    c = f.controller;
  await c.open(target, 'write');
  const id = await c.createDraft(c.state!.review, 'issue-comment', {
    number: 2,
    subject: 'pull',
    body: 'Original body',
    expectedVersion: version,
  });
  c.close();
  await f.open('write');
  await f.change('已保存的手工草稿', id);
  await f.click('审查本次操作');
  const stale = callback(f.button('确认发布会话评论'));
  await f.click('返回修改');
  await f.change('待发布正文', 'New edited body');
  await f.click('审查本次操作');
  await f.act(async () => stale());
  assert.equal(f.calls.filter((c) => c.method === 'github-write-action').length, 0);
  assert.match(
    f.document.querySelector('[aria-label="最终写入确认"]')!.textContent!,
    /New edited body/,
  );
  await f.act(async () => f.ref.current!.close());
  f.state.context.online = false;
  f.state.context.generation++;
  const before = f.calls.length;
  await f.open();
  assert.equal(f.button('审查、评论与发布').disabled, false);
  await f.click('审查、评论与发布');
  await f.change('已保存的手工草稿', id);
  await f.change('待发布正文', 'Offline manual body');
  assert.equal(f.button('审查本次操作').disabled, true);
  assert.equal((f.field('待发布正文') as HTMLTextAreaElement).disabled, false);
  assert.equal(f.calls.length, before);
  f.state.context.online = true;
  f.state.context.generation++;
  await f.render();
  assert.equal(f.document.querySelector('[role=dialog]'), null);
  assert.equal(f.calls.length, before);
  await f.open('write');
  await f.change('已保存的手工草稿', id);
  assert.equal((f.field('待发布正文') as HTMLTextAreaElement).value, 'Offline manual body');
});

test('full GitHub write panel exposes PR review files, exact line replies, new PR branches and commit/push previews', async (t) => {
  const f = await mount(t);
  await f.open();
  await f.click('读取 PRs');
  await f.act(async () =>
    [...f.document.querySelectorAll('button')]
      .find((b) => b.textContent!.includes('#2 Synthetic private PR title'))!
      .click(),
  );
  await f.click('审查、评论与发布');
  await f.click('读取 PR 文件 Diff');
  const summary = [...f.document.querySelectorAll('summary')].find((n) =>
    n.textContent!.startsWith('README.md'),
  )!;
  await f.act(async () => (summary as HTMLElement).click());
  await f.click('评论 README.md 新文件第 2 行');
  assert.match(f.document.body.textContent!, /README.md · 新文件 第 2 行/);
  await f.change('待发布正文', 'Manual exact line');
  await f.click('审查本次操作');
  assert.match(
    f.document.querySelector('[aria-label="最终写入确认"]')!.textContent!,
    /Manual exact line/,
  );
  await f.click('返回修改');
  await f.click('手动同步行评论');
  await f.click('回复评论 71');
  await f.change('待发布正文', 'Manual reply');
  await f.click('审查本次操作');
  assert.match(
    f.document.querySelector('[aria-label="最终写入确认"]')!.textContent!,
    /回复评论编号 71/,
  );
  await f.click('返回修改');
  await f.click('读取可用远端分支');
  await f.change('来源分支', 'topic');
  await f.change('目标分支', 'main');
  await f.click('编写新 PR 草稿');
  await f.change('标题', 'Manual UI PR');
  await f.change('待发布正文', 'Manual PR body');
  await f.click('审查本次操作');
  assert.match(
    f.document.querySelector('[aria-label="最终写入确认"]')!.textContent!,
    /Manual UI PR/,
  );
  await f.click('返回修改');
  await f.act(async () => (f.field('README.md') as HTMLInputElement).click());
  await f.click('预览选中文件');
  await f.click('编写提交说明');
  await f.change('提交说明', 'Manual UI commit');
  await f.change('提交作者姓名', 'Synthetic');
  await f.change('提交作者邮箱', 'synthetic@example.invalid');
  await f.click('审查本次操作');
  assert.match(
    f.document.querySelector('[aria-label="最终写入确认"]')!.textContent!,
    /Manual UI commit/,
  );
  await f.click('返回修改');
  await f.click('查看当前分支推送目标');
  await f.click('准备推送这次提交');
  await f.click('审查本次操作');
  const review = f.document.querySelector('[aria-label="最终写入确认"]')!.textContent!;
  assert.ok(review.includes(head));
  assert.ok(review.includes(base));
  assert.equal(f.calls.filter((c) => c.method === 'github-write-action').length, 0);
});

test('old mapping navigation shows original scope and offers only inspect or explicitly consented seal', async (t) => {
  const f = await mount(t),
    c = f.controller;
  await c.open(target, 'write');
  const id = await c.createDraft(c.state!.review, 'issue-comment', {
    number: 2,
    subject: 'pull',
    body: 'Original scope body',
  });
  await c.prepare(c.state!.review, id);
  f.state.lost = true;
  await assert.rejects(c.confirm(c.state!.review), /lost/);
  c.close();
  f.state.context.target = {
    ...target,
    product: { ...target.product!, revision: 2, replicaId: 'moved' },
  };
  f.state.context.generation++;
  await f.open();
  await f.click('查看原项目映射记录');
  assert.match(f.document.body.textContent!, /原项目映射的 GitHub 记录/);
  assert.ok(f.document.body.textContent!.includes('Original scope body'));
  assert.equal(f.document.querySelector('[aria-label="最终写入确认"]'), null);
  assert.equal(f.button('封存此原操作').disabled, true);
  f.state.lost = false;
  f.state.phase = 'unknown';
  await f.click('核查此原写入结果');
  assert.deepEqual(f.calls.at(-1)!.target, target);
  const consent = f.field('结束此原操作核查；远端结果仍可能未知') as HTMLInputElement;
  await f.act(async () => consent.click());
  f.state.released = true;
  await f.click('封存此原操作');
  assert.equal(f.calls.at(-1)!.method, 'github-write-abandon');
  assert.deepEqual(f.calls.at(-1)!.target, target);
  assert.equal(f.calls.filter((c) => c.method === 'github-write-action').length, 1);
});

test('closing or connection ABA during a provider read immediately clears visible content and cancels its late completion', async (t) => {
  const f = await mount(t);
  await f.open();
  const entered = signal(),
    release = signal();
  f.state.beforeResponse = async () => {
    entered.resolve();
    await release.promise;
  };
  await f.act(async () => {
    f.button('读取 PRs').click();
    await entered.promise;
  });
  f.state.context.online = false;
  f.state.context.generation++;
  f.state.context.online = true;
  f.state.context.generation++;
  await f.render();
  assert.equal(f.document.querySelector('[role=dialog]'), null);
  await f.act(async () => release.resolve());
  assert.equal(f.document.querySelector('[role=dialog]'), null);
  assert.equal(f.calls.filter((c) => c.method.endsWith('-action')).length, 0);
});

async function pendingGithubFixture() {
  const f = fixture(),
    c = f.controller;
  await c.open(target, 'write');
  const id = await c.createDraft(c.state!.review, 'issue-comment', {
    number: 2,
    subject: 'pull',
    body: 'Cold restart original body',
  });
  await c.prepare(c.state!.review, id);
  const original = structuredClone(c.state!.write.review!.request);
  f.state.lost = true;
  await assert.rejects(c.confirm(c.state!.review), /lost/);
  c.close();
  f.state.lost = false;
  f.state.phase = 'unknown';
  return { f, original };
}

test('cold open keeps write disabled through independent write restoration and initial overview, then its first enabled click reaches original inspection', async (t) => {
  const { f: source, original } = await pendingGithubFixture();
  const restored = signal(),
    restoreRelease = signal(),
    overview = signal(),
    overviewRelease = signal();
  let reads = 0;
  source.memory.beforeRead = async () => {
    if (++reads === 2) {
      restored.resolve();
      await restoreRelease.promise;
    }
  };
  source.state.beforeResponse = async (method) => {
    if (method === 'github-read') {
      overview.resolve();
      await overviewRelease.promise;
    }
  };
  const f = await mount(t, source);
  let opening!: Promise<void>;
  await f.act(async () => {
    opening = f.ref.current!.open(target);
    await restored.promise;
  });
  assert.equal(
    f.button('审查、评论与发布').disabled,
    true,
    'read loaded alone does not mean the panel is ready',
  );
  assert.match(f.document.body.textContent!, /正在恢复 GitHub 本机记录/);
  const early = callback(f.button('审查、评论与发布'));
  await f.act(async () => early());
  assert.match(f.document.body.textContent!, /GitHub 仓库与会话上下文/);
  await f.act(async () => {
    restoreRelease.resolve();
    await overview.promise;
  });
  assert.equal(
    f.button('审查、评论与发布').disabled,
    true,
    'the initial overview also owns initialization',
  );
  await f.act(async () => {
    overviewRelease.resolve();
    await opening;
  });
  assert.equal(f.button('审查、评论与发布').disabled, false);
  await f.click('审查、评论与发布');
  assert.equal(f.button('核查原操作结果').disabled, false);
  await f.click('核查原操作结果');
  assert.deepEqual(f.calls.at(-1)!.params, { request: original, page: 1 });
  assert.equal(f.calls.filter((entry) => entry.method === 'github-write-action').length, 1);
});

for (const mode of ['read', 'write', 'recovery'] as const)
  test(`cold ${mode} initialization keeps all original-record navigation and recovery actions disabled until root reconciliation completes`, async (t) => {
    const { f: source, original } = await pendingGithubFixture();
    source.state.context.target = { ...target, product: { ...target.product!, revision: 2 } };
    source.state.context.generation++;
    const entered = signal(),
      release = signal();
    source.state.beforeChanged = async () => {
      entered.resolve();
      await release.promise;
    };
    const f = await mount(t, source);
    let opening!: Promise<void>;
    await f.act(async () => {
      opening = f.ref.current!.open(source.state.context.target!, mode);
      await entered.promise;
    });
    if (mode === 'recovery') {
      assert.equal(f.button('当前仓库与会话上下文').disabled, true);
      assert.equal(f.button('当前项目的写入草稿').disabled, true);
      assert.equal(f.button('核查此原写入结果').disabled, true);
    } else {
      assert.equal(f.button('查看原项目映射记录').disabled, true);
      assert.equal(
        f.button(mode === 'read' ? '审查、评论与发布' : '返回仓库与会话上下文').disabled,
        true,
      );
    }
    const before = f.calls.length;
    await f.act(async () => {
      release.resolve();
      await opening;
    });
    if (mode !== 'recovery') {
      assert.equal(f.button('查看原项目映射记录').disabled, false);
      await f.click('查看原项目映射记录');
    } else assert.equal(f.calls.length, before, 'opening original records is entirely local');
    assert.equal(f.button('核查此原写入结果').disabled, false);
    await f.click('核查此原写入结果');
    assert.deepEqual(f.calls.at(-1), {
      target,
      method: 'github-write-inspect',
      params: { request: original, page: 1 },
    });
    assert.equal(f.calls.filter((entry) => entry.method === 'github-write-action').length, 1);
  });
