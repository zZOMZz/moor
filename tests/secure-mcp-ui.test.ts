import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { SecureMcpUiHandle, SecureMcpUiProps } from '../src/web/secure-mcp-ui';
import type { SecureMcpDraft } from '../src/web/secure-mcp';
import type { SecureContentContext } from '../src/web/secure-controller';
import type { SecureCliTarget } from '../src/cli/secure-operation';
import type { McpReadResult, McpServerView } from '../src/mcp-protocol';

const target: SecureCliTarget = {
  origin: 'https://relay.synthetic.invalid',
  owner: 'owner',
  rootKeyId: 'A'.repeat(43),
  clientDeviceId: 'client',
  hostDeviceId: 'host',
  workspaceId: 'runtime',
  localProjectId: 'local',
  userId: 'user',
  machineId: 'machine',
  sessionId: 'session',
  product: {
    catalogWorkspaceId: 'catalog',
    projectId: 'project',
    replicaId: 'replica',
    revision: 1,
  },
};
const server: McpServerView = {
  id: 'version-1',
  name: 'Synthetic MCP',
  description: 'Synthetic description',
  transport: 'http',
};
function catalog(servers = [server]): McpReadResult {
  return {
    mcpVersion: 1,
    confirmed: true,
    workspaceId: target.workspaceId,
    localProjectId: target.localProjectId,
    sessionId: target.sessionId,
    catalogRevision: 1,
    servers,
  };
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mount(initial?: SecureMcpDraft, online = true) {
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
  const { SecureMcpUI } = await import('../src/web/secure-mcp-ui');
  const ref = createRef<SecureMcpUiHandle>(),
    root = createRoot(dom.window.document.getElementById('app')!);
  const model = {
    context: { target: structuredClone(target), online, generation: 1 } as SecureContentContext,
    draft: initial ?? ({ target: structuredClone(target) } as SecureMcpDraft),
    catalog: catalog(),
    reads: [] as SecureCliTarget[],
    saves: [] as unknown[][],
    writes: 0,
    beforeRead: undefined as (() => Promise<void>) | undefined,
    beforeApply: undefined as (() => Promise<void>) | undefined,
  };
  const props: SecureMcpUiProps = {
    context: () => model.context,
    draft: () => model.draft,
    async readCatalog(destination) {
      model.reads.push(structuredClone(destination));
      await model.beforeRead?.();
      return structuredClone(model.catalog);
    },
    async apply(destination, expected, servers, list, current) {
      model.saves.push(structuredClone([destination, expected, servers, list]));
      await model.beforeApply?.();
      current();
      model.writes++;
      model.draft = {
        ...model.draft,
        review: { reviewId: `saved-${model.writes}`, servers: structuredClone(servers) },
      };
    },
  };
  const render = async () => {
    await act(async () => root.render(createElement(SecureMcpUI, { ...props, ref })));
  };
  await render();
  const button = (label: string) => {
    const found = [...dom.window.document.querySelectorAll('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label,
    );
    assert(found, `Missing button: ${label}`);
    return found;
  };
  const check = (name = server.name) => {
    const found = [
      ...dom.window.document.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
    ].find((item) => item.getAttribute('aria-label') === `选择 MCP：${name}`);
    assert(found, `Missing MCP checkbox: ${name}`);
    return found;
  };
  return {
    model,
    props,
    ref,
    act,
    render,
    button,
    check,
    document: dom.window.document,
    async open(t = target) {
      await act(async () => ref.current!.open(t));
    },
    async click(label: string) {
      await act(async () => button(label).click());
    },
    async toggle(name = server.name) {
      await act(async () => check(name).click());
    },
    async cleanup() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('opening MCP does no read; explicit catalog allows up to eight frozen safe metadata selections', async (t) => {
  const f = await mount();
  t.after(f.cleanup);
  f.model.catalog = catalog(
    Array.from({ length: 9 }, (_, index) => ({
      ...server,
      id: `version-${index}`,
      name: `Synthetic ${index}`,
    })),
  );
  await f.open();
  assert.equal(f.model.reads.length, 0);
  assert.equal(f.model.saves.length, 0);
  assert.match(f.document.body.textContent!, /读取目录和保存草稿不会连接服务器或启动/);
  await f.click('读取项目允许的 MCP');
  assert.deepEqual(f.model.reads, [target]);
  for (let index = 0; index < 8; index++) await f.toggle(`Synthetic ${index}`);
  assert.equal(f.check('Synthetic 8').disabled, true);
  await f.click('确认保存 MCP 选择到草稿');
  assert.deepEqual(f.model.saves[0][0], target);
  assert.deepEqual(f.model.saves[0][1], { target });
  assert.equal((f.model.saves[0][2] as McpServerView[]).length, 8);
  assert.equal(f.model.reads.length, 1);
});

test('offline MCP retains original choice and allows explicit removal without reading or adding a server', async (t) => {
  const f = await mount({ target, review: { reviewId: 'old', servers: [server] } }, false);
  t.after(f.cleanup);
  await f.open();
  assert.equal(f.button('读取项目允许的 MCP').disabled, true);
  assert.equal(f.check().checked, true);
  await f.toggle();
  assert.equal(f.check().checked, false);
  assert.equal(f.check().disabled, false);
  await f.toggle();
  assert.equal(f.check().checked, true);
  await f.toggle();
  await f.click('确认保存 MCP 选择到草稿');
  assert.deepEqual(f.model.draft.review?.servers, []);
  assert.equal(f.model.reads.length, 0);
  assert.equal(f.model.writes, 1);
});

test('same-ID metadata change keeps reviewed text until user removes and reselects the current version', async (t) => {
  const f = await mount({ target, review: { reviewId: 'old', servers: [server] } });
  t.after(f.cleanup);
  const changed = { ...server, name: 'Changed MCP', description: 'Changed description' };
  f.model.catalog = catalog([changed]);
  await f.open();
  await f.click('读取项目允许的 MCP');
  assert.equal(f.check().checked, true);
  assert.match(f.document.body.textContent!, /Synthetic description/);
  assert.doesNotMatch(f.document.body.textContent!, /Changed description/);
  assert.match(f.document.body.textContent!, /当前不可用或尚未重新核对/);
  await f.toggle();
  assert.equal(f.check(changed.name).checked, false);
  await f.toggle(changed.name);
  await f.click('确认保存 MCP 选择到草稿');
  assert.deepEqual(f.model.saves[0][2], [changed]);
});

test('metadata is rendered as text with no links, images, embedded markup or executable configuration', async (t) => {
  const f = await mount();
  t.after(f.cleanup);
  const unsafeText = {
    ...server,
    name: '<img src=x onerror=alert(1)>',
    description: '<a href="javascript:alert(1)">Synthetic</a>',
  };
  f.model.catalog = catalog([unsafeText]);
  await f.open();
  await f.click('读取项目允许的 MCP');
  assert.equal(f.document.querySelectorAll('img,a,iframe,script').length, 0);
  assert.match(f.document.body.textContent!, /<img src=x onerror=alert\(1\)>/);
  await f.toggle(unsafeText.name);
  await f.click('确认保存 MCP 选择到草稿');
  assert.deepEqual(f.model.saves[0][2], [unsafeText]);
});

test('catalog errors permit another explicit read and perform no automatic retry', async (t) => {
  const f = await mount();
  t.after(f.cleanup);
  f.model.beforeRead = async () => {
    throw Error('synthetic read unavailable');
  };
  await f.open();
  await f.click('读取项目允许的 MCP');
  assert.equal(f.model.reads.length, 1);
  assert.match(f.document.body.textContent!, /synthetic read unavailable/);
  assert.equal(f.button('读取项目允许的 MCP').disabled, false);
  f.model.beforeRead = undefined;
  await f.click('读取项目允许的 MCP');
  assert.equal(f.model.reads.length, 2);
  assert.equal(f.check().disabled, false);
});

test('late catalog response is discarded after connection ABA and reopened panel has no automatic catalog', async (t) => {
  const f = await mount(),
    entered = signal(),
    release = signal();
  t.after(f.cleanup);
  f.model.beforeRead = async () => {
    entered.resolve();
    await release.promise;
  };
  await f.open();
  await f.click('读取项目允许的 MCP');
  await entered.promise;
  f.model.context = { target, online: false, generation: 2 };
  await f.render();
  assert.equal(f.document.querySelector('[role=dialog]'), null);
  f.model.context = { target, online: true, generation: 3 };
  await f.render();
  await f.act(async () => release.resolve());
  assert.equal(f.document.querySelector('[role=dialog]'), null);
  await f.open();
  assert.equal(f.model.reads.length, 1);
  assert.equal(f.document.querySelectorAll('input[type=checkbox]').length, 0);
});

test('closing and reopening a panel invalidates an outstanding apply guard before its durable write', async (t) => {
  const f = await mount({ target, review: { reviewId: 'old', servers: [server] } }),
    entered = signal(),
    release = signal();
  t.after(f.cleanup);
  f.model.beforeApply = async () => {
    entered.resolve();
    await release.promise;
  };
  await f.open();
  await f.toggle();
  await f.click('确认保存 MCP 选择到草稿');
  await entered.promise;
  await f.click('关闭额外 MCP');
  await f.open();
  await f.act(async () => release.resolve());
  assert.equal(f.model.writes, 0);
  assert.deepEqual(f.model.draft.review?.servers, [server]);
  assert.equal(f.check().checked, true);
});

test('a scope change invalidates an already painted save action before parent receives any apply request', async (t) => {
  const f = await mount({ target, review: { reviewId: 'old', servers: [server] } });
  t.after(f.cleanup);
  await f.open();
  await f.toggle();
  const other = { ...target, hostDeviceId: 'other-host' };
  f.model.context = { target: other, online: true, generation: 2 };
  f.model.draft = { target: other };
  await f.click('确认保存 MCP 选择到草稿');
  assert.equal(f.model.saves.length, 0);
  assert.equal(f.model.writes, 0);
  await f.render();
  assert.equal(f.document.querySelector('[role=dialog]'), null);
});

test('pending original MCP stays fixed while explicitly saving a different review for later', async (t) => {
  const old = { reviewId: 'old', servers: [server] },
    draft: SecureMcpDraft = {
      target,
      review: old,
      delivery: { operationId: 'original', state: 'ending', review: old },
    };
  const f = await mount(draft);
  t.after(f.cleanup);
  await f.open();
  assert.match(f.document.body.textContent!, /原指令 original 正在封存/);
  await f.click('清空待保存选择');
  await f.click('确认保存 MCP 选择到草稿');
  assert.deepEqual(f.model.saves[0][1], draft);
  assert.deepEqual(f.model.draft.delivery, draft.delivery);
  assert.deepEqual(f.model.draft.review?.servers, []);
});
