import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import type { SecureForkUiHandle } from '../src/web/secure-fork-ui';
import { secureForkFixture, forkOid, forkSignal } from './support/secure-fork-fixture';

test('trusted Fork DOM freezes reviews, separates recovery from retry and exposes original navigation only at its source', async (t) => {
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
  const { createElement, createRef, act } = await import('react'),
    { createRoot } = await import('react-dom/client'),
    { SecureForkUI } = await import('../src/web/secure-fork-ui');
  const f = secureForkFixture(),
    ref = createRef<SecureForkUiHandle>(),
    root = createRoot(document.getElementById('app')!);
  let release: (() => void) | undefined, pending: Promise<void> | undefined;
  const button = (label: string) => {
    const item = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === label || node.getAttribute('aria-label') === label,
    );
    assert.ok(item, label);
    return item;
  };
  const click = (label: string) => act(async () => button(label).click());
  const select = (index: number, value: string) =>
    act(() => {
      const node = document.querySelectorAll<HTMLSelectElement>('.session-fork-panel select')[
        index
      ]!;
      node.value = value;
      node.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  const render = () => root.render(createElement(SecureForkUI, { ...f.dependencies, ref }));
  const source = { sourceTitle: 'Source <img src=x onerror=bad>', turnId: 'finished' };
  try {
    await act(async () => render());
    const opening = forkSignal(),
      finishOpen = forkSignal();
    release = finishOpen.resolve;
    f.controls.beforeOptions = async () => {
      opening.resolve();
      await finishOpen.promise;
    };
    await act(async () => {
      pending = ref.current!.open(f.target, source);
      await opening.promise;
    });
    assert.equal(button('重新读取 Fork 选项').disabled, true);
    assert.equal(document.querySelector('.session-fork-panel img'), null);
    const openingCalls = f.calls.length;
    await click('重新读取 Fork 选项');
    assert.equal(f.calls.length, openingCalls);
    await act(async () => {
      f.controls.beforeOptions = undefined;
      finishOpen.resolve();
      await pending;
    });
    assert.equal(
      document.querySelector<HTMLSelectElement>('.session-fork-panel select')!.value,
      'turn:finished',
    );
    assert.equal(
      document.querySelector<HTMLOptionElement>('option[value="turn:missing"]')!.disabled,
      true,
    );
    await select(1, 'worktree');
    await select(2, JSON.stringify(['main', forkOid]));
    await act(() => {
      const input = document.querySelector<HTMLInputElement>('.session-fork-panel input')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'feature/secure-reviewed',
      );
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await click('审阅 Fork 方案');
    const finalReview = document.querySelector('[aria-label="最终 Fork 审阅"]')!;
    assert.match(finalReview.textContent!, /完成回合 finished/);
    assert(finalReview.textContent!.includes(forkOid));
    assert.match(finalReview.textContent!, /feature\/secure-reviewed/);
    assert.equal(finalReview.querySelector('img,script'), null);
    assert.equal(f.controls.nativeCalls, 0);
    const saving = forkSignal(),
      finishSave = forkSignal();
    release = finishSave.resolve;
    f.memory.beforeWrite = async () => {
      saving.resolve();
      await finishSave.promise;
    };
    f.controls.phase = 'unknown';
    await act(async () => {
      button('确认创建原生会话副本').click();
      await saving.promise;
    });
    assert.equal(button('确认创建原生会话副本').disabled, true);
    assert.equal(button('返回修改 Fork 方案').disabled, true);
    assert.equal(button('重新读取 Fork 选项').disabled, true);
    await click('确认创建原生会话副本');
    assert.equal(f.controls.nativeCalls, 0);
    await act(async () => {
      f.memory.beforeWrite = undefined;
      finishSave.resolve();
    });
    assert.equal(f.controls.nativeCalls, 1);
    const originalCalls = f.calls.length;
    await click('关闭会话副本');
    await act(async () => ref.current!.open(f.target, source));
    assert.equal(f.calls.length, originalCalls, 'reopening does not retry the pending native Fork');
    assert.equal(button('重试确认 Fork').disabled, false);
    const original = f.calls.find((call) => call.method === 'fork-action')!.params,
      childTarget = { ...f.target, sessionId: original.childSessionId };
    f.setContext({ target: childTarget, online: true, generation: 1 });
    await act(async () => {
      render();
      await ref.current!.open(childTarget, { sourceTitle: 'Fork child' });
    });
    const originalBody = document.querySelector('[aria-label="Fork 原操作记录"]')!;
    assert.deepEqual(
      JSON.parse(originalBody.querySelector('pre')!.textContent!).operation.request,
      original,
    );
    assert.match(originalBody.textContent!, /通过会话的“Fork 来源”返回源会话/);
    assert.equal(button('核查原 Fork 结果').disabled, false);
    assert.equal(button('封存原 Fork 操作').disabled, true);
    assert.equal(originalBody.querySelectorAll('button').length, 2);
    await click('核查原 Fork 结果');
    assert.equal(f.calls.at(-1)!.method, 'fork-operations');
    assert.equal(f.calls.at(-1)!.params.action, 'inspect');
    assert.deepEqual(f.calls.at(-1)!.target, f.target);
    assert.deepEqual(f.calls.at(-1)!.params.request, original);
    assert.equal(f.calls.filter((call) => call.method === 'fork-action').length, 1);
    f.setContext({ target: f.target, online: true, generation: 1 });
    await act(async () => {
      render();
      await ref.current!.open(f.target, source);
    });
    const confirmation = document.querySelector<HTMLInputElement>(
      '[aria-label="Fork 原操作记录"] input[type="checkbox"]',
    )!;
    assert.equal(button('封存原 Fork 操作').disabled, true);
    await act(() => confirmation.click());
    await click('封存原 Fork 操作');
    assert.equal(f.calls.at(-1)!.params.action, 'abandon');
    assert.match(document.body.textContent!, /已生成的目录仍保留/);
    await click('查看本次分叉的工作目录');
    assert.equal(f.directories.length, 1);
    assert.equal(f.children.length, 0, 'an abandoned directory is not an accepted session');
    const beforeOffline = f.calls.length;
    f.setContext({ target: f.target, generation: 2, online: false });
    await act(async () => render());
    assert.equal(document.querySelector('.session-fork-panel'), null);
    f.setContext({ target: f.target, generation: 3, online: true });
    await act(async () => render());
    assert.equal(document.querySelector('.session-fork-panel'), null);
    assert.equal(f.calls.length, beforeOffline);

    // A confirmed child still displays the original receipt, but its source owns
    // navigation and directory management, including older failed directories.
    const seed = f.create();
    f.controls.phase = 'accepted';
    await seed.open(f.target, source);
    await seed.prepare(
      seed.state!.review,
      { kind: 'current' },
      {
        kind: 'worktree',
        baseBranch: 'main',
        expectedOid: forkOid,
        newBranch: 'feature/confirmed-child',
      },
    );
    await seed.confirm(seed.state!.review);
    const accepted = structuredClone(seed.state!.controller.receipt!),
      acceptedTarget = { ...f.target, sessionId: accepted.childSessionId };
    seed.close();
    f.setContext({ target: acceptedTarget, online: true, generation: 3 });
    await act(async () => {
      render();
      await ref.current!.open(acceptedTarget, { sourceTitle: 'Confirmed child' });
    });
    const childRecord = document.querySelector('[aria-label="Fork 原操作记录"]')!;
    assert.deepEqual(JSON.parse(childRecord.querySelector('pre')!.textContent!).receipt, accepted);
    assert.equal(childRecord.querySelectorAll('button').length, 0);
    assert.match(childRecord.textContent!, /通过会话的“Fork 来源”返回源会话/);
    await seed.open(acceptedTarget, { sourceTitle: 'Confirmed child' });
    const recoveryId = seed.state!.recoveries[0]!.id;
    await assert.rejects(seed.openChild(seed.state!.review, recoveryId), /返回源会话/);
    await assert.rejects(
      seed.openWorkspace(seed.state!.review, accepted.childSessionId, recoveryId),
      /返回源会话/,
    );
    seed.close();
    assert.equal(f.children.length, 0);
    assert.equal(f.directories.length, 1);

    const remappedSource = {
      ...f.target,
      product: { ...f.target.product!, revision: 2 },
    };
    f.setContext({ target: remappedSource, online: true, generation: 3 });
    await act(async () => {
      render();
      await ref.current!.open(remappedSource, source);
    });
    assert.equal(button('打开原记录已确认的副本').disabled, false);
    assert.equal(button('查看原记录保留的目录').disabled, false);
    assert.match(
      document.querySelector('[aria-label="Fork 原操作记录"]')!.textContent!,
      /查看此前保留目录/,
    );
    await click('打开原记录已确认的副本');
    await click('查看原记录保留的目录');
    assert.deepEqual(f.children, [{ target: f.target, childId: accepted.childSessionId }]);
    assert.deepEqual(f.directories.at(-1), {
      target: f.target,
      childId: accepted.childSessionId,
    });
    assert.equal(f.controls.nativeCalls, 2, 'navigation and child recovery never fork again');
  } finally {
    f.memory.beforeWrite = undefined;
    f.controls.beforeOptions = undefined;
    release?.();
    await act(async () => {
      ref.current?.close();
      await pending?.catch(() => {});
      root.unmount();
    });
    dom.window.close();
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
});
