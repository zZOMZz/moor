import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import type { SecureGitUiHandle } from '../../apps/web/src/features/git/secure-git-ui';
import type { SecureGitOpenOptions } from '../../apps/web/src/features/git/secure-git';
import { fixture, target, version, oid, signal } from '../fixtures/secure-git-fixture';

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
  const { SecureGitUI } = await import('../../apps/web/src/features/git/secure-git-ui');
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
  const ref = createRef<SecureGitUiHandle>(),
    root = createRoot(dom.window.document.getElementById('app')!);
  const render = async (extra: { busy?: boolean } = {}) => {
    await act(async () => root.render(createElement(SecureGitUI, { ...f.deps, ...extra, ref })));
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
    async open(options: SecureGitOpenOptions = { newSession: true }) {
      await act(async () => ref.current!.open(f.state.context.target!, options));
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

test('trusted Git DOM explicitly selects a baseline and branch; unseen original survives cold reopen and manual seal', async (t) => {
  const f = await mount(t);
  f.hostState().repository.issues = ['<img src=x onerror=alert(1)>'];
  await f.open();
  assert.equal(f.document.querySelectorAll('img,script,iframe').length, 0);
  assert.equal(f.button('创建独立工作目录').disabled, true);
  await f.change('本地基线分支', JSON.stringify(['main', oid]));
  await f.change('新分支名称', 'feature/manual');
  assert.match(f.document.body.textContent!, new RegExp('确认基线提交 ' + oid));
  f.state.unseen = true;
  await f.click('创建独立工作目录');
  const original = f.calls.find((call) => call.method === 'git-action')!;
  assert.equal(original.params.newBranch, 'feature/manual');
  assert.match(f.document.body.textContent!, /核查只读取原请求结果/);
  assert.match(f.document.body.textContent!, /git-operation-1/);
  await f.act(async () => f.ref.current!.close());
  await f.open();
  assert.equal(f.calls.filter((call) => call.method === 'git-action').length, 1);
  assert.equal(f.button('核查原 Git 操作').disabled, false);
  await f.click('核查原 Git 操作');
  assert.match(f.document.body.textContent!, /尚未记录/);
  assert.equal(f.button('封存原 Git 操作').disabled, true);
  await f.act(async () => (f.field('我确认封存此原请求') as HTMLInputElement).click());
  await f.click('封存原 Git 操作');
  assert.match(f.document.body.textContent!, /原请求已封存/);
  assert.equal(f.calls.filter((call) => call.method === 'git-action').length, 1);
  assert.deepEqual(f.state.navigations, []);
});

test('rendered cleanup consent expires with a changed directory and old enabled button never adopts new execution', async (t) => {
  const f = await mount(t);
  const host = f.hostState();
  host.execution = {
    mode: 'worktree',
    status: 'ready',
    revision: 1,
    executionId: 'original-worktree',
    branch: 'feature/original',
    baseOid: oid,
  };
  host.canPrepare = false;
  host.canRemove = true;
  await f.open({ newSession: false });
  await f.act(async () => (f.field('我确认清理此会话的独立工作目录') as HTMLInputElement).click());
  assert.equal(f.button('清理工作目录').disabled, false);
  const stale = callback(f.button('清理工作目录'));
  await f.act(async () => (f.field('我确认清理此会话的独立工作目录') as HTMLInputElement).click());
  await f.act(async () => stale());
  assert.equal(
    f.calls.filter((call) => call.method === 'git-action').length,
    0,
    'Unchecked consent cannot be reused by an old render',
  );
  await f.act(async () => (f.field('我确认清理此会话的独立工作目录') as HTMLInputElement).click());
  host.execution.executionId = 'another-worktree';
  host.execution.revision++;
  host.repository.version = 'sha256:' + 'c'.repeat(64);
  await f.click('重新读取 Git 状态');
  assert.equal((f.field('我确认清理此会话的独立工作目录') as HTMLInputElement).checked, false);
  assert.equal(f.button('清理工作目录').disabled, true);
  await f.act(async () => stale());
  assert.equal(f.calls.filter((call) => call.method === 'git-action').length, 0);
  await f.act(async () => (f.field('我确认清理此会话的独立工作目录') as HTMLInputElement).click());
  await f.click('清理工作目录');
  assert.equal(
    f.calls.find((call) => call.method === 'git-action')!.params.executionId,
    'another-worktree',
  );
  assert.match(f.document.body.textContent!, /工作目录已清理/);
});

test('old form submit cannot create a previously edited branch name', async (t) => {
  const f = await mount(t);
  await f.open();
  await f.change('本地基线分支', JSON.stringify(['main', oid]));
  await f.change('新分支名称', 'feature/previous');
  const form = f.document.querySelector('form')!;
  const propsKey = Object.keys(form).find((name) => name.startsWith('__reactProps'))!;
  const old = (
    form as unknown as Record<string, { onSubmit(event: { preventDefault(): void }): void }>
  )[propsKey].onSubmit;
  await f.change('新分支名称', 'feature/current');
  await f.act(async () => old({ preventDefault() {} }));
  assert.equal(f.calls.filter((call) => call.method === 'git-action').length, 0);
  await f.click('创建独立工作目录');
  assert.equal(
    f.calls.find((call) => call.method === 'git-action')!.params.newBranch,
    'feature/current',
  );
});

test('cold reopen keeps navigation and original inspect disabled through final initialization barrier; first enabled click works', async (t) => {
  const f = await mount(t),
    controller = f.controller;
  await controller.open(target, { newSession: true });
  f.state.unseen = true;
  await assert.rejects(
    controller.prepare(controller.state!.review, 'main', oid, 'feature/original'),
  );
  controller.close();
  const entered = signal(),
    release = signal();
  f.state.beforeRefresh = async () => {
    entered.resolve();
    await release.promise;
  };
  let opening!: Promise<void>;
  await f.act(async () => {
    opening = f.ref.current!.open(target, { newSession: true });
    await entered.promise;
  });
  assert.match(f.document.body.textContent!, /正在恢复原 Git 记录/);
  assert.equal(f.button('核查原 Git 操作').disabled, true);
  assert.equal(f.button('提交与推送').disabled, true);
  assert.equal(f.button('重新读取 Git 状态').disabled, true);
  await f.click('核查原 Git 操作');
  assert.equal(f.calls.filter((call) => call.method === 'git-operations').length, 0);
  await f.act(async () => {
    release.resolve();
    await opening;
  });
  assert.equal(f.button('核查原 Git 操作').disabled, false);
  await f.click('核查原 Git 操作');
  assert.equal(f.calls.filter((call) => call.method === 'git-operations').length, 1);
  assert.match(f.document.body.textContent!, /尚未记录/);
});

test('restored old mapping navigation stays disabled until initialization finishes and recovery keeps original product', async (t) => {
  const f = await mount(t),
    controller = f.controller;
  await controller.open(target, { newSession: true });
  f.state.unseen = true;
  await assert.rejects(
    controller.prepare(controller.state!.review, 'main', oid, 'feature/original'),
  );
  controller.close();
  f.state.context.target!.product = {
    ...target.product!,
    projectId: 'new-product',
    replicaId: 'new-replica',
    revision: 2,
  };
  f.state.context.generation++;
  const entered = signal(),
    release = signal();
  f.state.beforeRefresh = async () => {
    entered.resolve();
    await release.promise;
  };
  let opening!: Promise<void>;
  await f.act(async () => {
    opening = f.ref.current!.open(f.state.context.target!, { newSession: true });
    await entered.promise;
  });
  assert.equal(f.button('原项目映射的 Git 记录').disabled, true);
  await f.click('原项目映射的 Git 记录');
  assert.match(f.document.querySelector('[role=dialog]')!.textContent!, /Git 与工作目录/);
  await f.act(async () => {
    release.resolve();
    await opening;
  });
  assert.equal(f.button('原项目映射的 Git 记录').disabled, false);
  await f.click('原项目映射的 Git 记录');
  assert.match(
    f.document.querySelector('[role=dialog]')!.textContent!,
    /原目录操作 · product · replica · 版本 1/,
  );
  await f.click('核查此原 Git 操作');
  assert.deepEqual(f.calls.at(-1)!.target, target);
  assert.equal(f.calls.filter((call) => call.method === 'git-action').length, 1);
});

test('offline cache is viewable; target and connection ABA remove the panel before stale callbacks can read or write', async (t) => {
  const f = await mount(t);
  await f.open();
  const stale = callback(f.button('重新读取 Git 状态'));
  await f.act(async () => f.ref.current!.close());
  f.state.context.online = false;
  f.state.context.generation++;
  const before = f.calls.length;
  await f.open();
  assert.match(f.document.body.textContent!, /执行电脑离线/);
  assert.equal(f.calls.length, before);
  assert.equal(f.button('重新读取 Git 状态').disabled, true);
  f.state.context.online = true;
  f.state.context.generation += 2;
  await f.render();
  assert.equal(f.document.querySelector('[role=dialog]'), null);
  await f.act(async () => stale());
  assert.equal(f.calls.length, before);
});

test('explicit Fork resource panel names the child and removes only the child directory', async (t) => {
  const f = await mount(t),
    child = { ...target, sessionId: 'fork-child' },
    host = f.hostState(child);
  host.execution = {
    mode: 'worktree',
    status: 'ready',
    revision: 1,
    executionId: 'fork-execution',
    branch: 'feature/fork',
    baseOid: oid,
  };
  host.canPrepare = false;
  host.canRemove = true;
  await f.act(async () =>
    f.ref.current!.open(child, {
      newSession: false,
      resource: { parentTarget: target, childSessionId: child.sessionId },
    }),
  );
  assert.match(f.document.body.textContent!, /Fork 子会话资源 fork-child/);
  assert(
    ![...f.document.querySelectorAll('button')].some((item) => item.textContent === '提交与推送'),
  );
  await f.act(async () => (f.field('我确认清理此会话的独立工作目录') as HTMLInputElement).click());
  await f.click('清理工作目录');
  const action = f.calls.find((call) => call.method === 'git-action')!;
  assert.equal(action.target.sessionId, 'fork-child');
  assert.equal(action.params.executionId, 'fork-execution');
  assert.equal(f.state.context.target!.sessionId, target.sessionId);
  assert.match(f.document.body.textContent!, /资源操作已完成/);
  assert.equal(f.button('重新读取 Git 状态').disabled, true);
  assert.deepEqual(
    [...f.document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')]
      .filter((button) => !button.disabled)
      .map((button) => button.getAttribute('aria-label') || button.textContent),
    ['关闭 Git 与工作目录'],
  );
  const count = f.calls.length;
  await f.click('重新读取 Git 状态');
  assert.equal(f.calls.length, count);
});

for (const oldMapping of [false, true])
  test(`removed Fork resource keeps its proof until manual ${oldMapping ? 'old-mapping' : 'current'} Git receipt recovery and then only closes`, async (t) => {
    const setup = fixture(),
      child = { ...target, sessionId: 'fork-child' },
      host = setup.hostState(child);
    host.execution = {
      mode: 'worktree',
      status: 'ready',
      revision: 1,
      executionId: 'fork-execution',
    };
    host.canPrepare = false;
    host.canRemove = true;
    const read = setup.deps.resourceRequest!,
      refreshed = setup.deps.onRefresh!;
    let cleanup = 0,
      afterCleanupRequests = 0;
    setup.deps.resourceRequest = async (...args) => {
      if (cleanup) {
        afterCleanupRequests++;
        throw Error('Synthetic resource proof already released');
      }
      return read(...args);
    };
    setup.deps.onRefresh = async (...args) => {
      if (args[1].execution.status === 'removed') cleanup++;
      await refreshed(...args);
    };
    const f = await mount(t, setup);
    const open = () =>
      f.ref.current!.open(
        { ...f.state.context.target!, sessionId: child.sessionId },
        {
          newSession: false,
          resource: {
            parentTarget: f.state.context.target!,
            childSessionId: child.sessionId,
            sourceTarget: target,
          },
        },
      );
    await f.act(async () => open());
    await f.act(async () =>
      (f.field('我确认清理此会话的独立工作目录') as HTMLInputElement).click(),
    );
    f.state.lost = true;
    await f.click('清理工作目录');
    assert.equal(host.execution.status, 'removed');
    assert.equal(cleanup, 0);
    await f.act(async () => f.ref.current!.close());
    if (oldMapping) {
      f.state.context.target!.product = {
        ...target.product!,
        replicaId: 'new-replica',
        revision: 2,
      };
      f.state.context.generation++;
    }
    await f.act(async () => open());
    assert.equal(
      cleanup,
      0,
      'Reading removed Git state does not release proof for the pending original',
    );
    assert.equal(f.calls.filter((call) => call.method === 'git-action').length, 1);
    const staleRefresh = callback(f.button('重新读取 Git 状态'));
    if (oldMapping) await f.click('原项目映射的 Git 记录');
    const inspect = oldMapping ? '核查此原 Git 操作' : '核查原 Git 操作';
    assert.equal(f.button(inspect).disabled, false);
    await f.click(inspect);
    assert.equal(cleanup, 1);
    assert.equal(afterCleanupRequests, 0);
    const receipt = f.calls.find((call) => call.method === 'git-operations')!;
    assert.deepEqual(receipt.target, child);
    assert.equal(f.calls.filter((call) => call.method === 'git-action').length, 1);
    assert.match(f.document.body.textContent!, /资源操作已完成/);
    assert.equal(f.button('重新读取 Git 状态').disabled, true);
    await f.act(async () => staleRefresh());
    await f.click('重新读取 Git 状态');
    assert.equal(afterCleanupRequests, 0);
    await f.click('关闭 Git 与工作目录');
    assert.equal(f.document.querySelector('[role=dialog]'), null);
  });

test('root busy disables all operational controls and restores usable navigation without reopening', async (t) => {
  const f = await mount(t);
  await f.open();
  assert.equal(f.button('提交与推送').disabled, false);
  const stale = callback(f.button('提交与推送'));
  await f.render({ busy: true });
  assert.equal(f.button('提交与推送').disabled, true);
  assert.equal(f.button('重新读取 Git 状态').disabled, true);
  await f.act(async () => stale());
  assert.deepEqual(f.state.navigations, []);
  await f.render({ busy: false });
  await f.click('提交与推送');
  assert.deepEqual(f.state.navigations, ['write']);
});
