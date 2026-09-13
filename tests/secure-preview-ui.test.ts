import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import type { SecureCliTarget } from '../src/cli/secure-operation';
import type { SecurePreviewContext } from '../src/web/secure-preview';
import type { SecurePreviewUiHandle, SecurePreviewUiProps } from '../src/web/secure-preview-ui';
import type { PreviewAction } from '../src/preview-protocol';
import {
  previewFrame,
  previewViewport,
  previewVersion,
  previewSignal,
} from './support/preview-fixture';
import { SecureStore, type SecureStorageBackend } from '../src/web/secure-store';
import { SecureScopedStorage } from '../src/web/secure-scoped-storage';
import { SecurePreviewAnnotations } from '../src/web/secure-preview';
import { previewRequestVersion } from '../src/web/project-preview';

class Memory implements SecureStorageBackend {
  values = new Map<string, unknown>();
  beforeWrite?: () => Promise<void>;
  async read(key: string) {
    return structuredClone(this.values.get(key) ?? null);
  }
  async compareAndSet(key: string, expected: unknown, value: unknown, current: () => void) {
    await this.beforeWrite?.();
    current();
    assert.deepEqual(this.values.get(key) ?? null, expected);
    this.values.set(key, structuredClone(value));
  }
  async exclusive<T>(_key: string, current: () => void, work: () => Promise<T>) {
    current();
    return work();
  }
}
test('trusted preview panel exposes complete local annotation and image flows with safe page text and explicit interactions', async (t) => {
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
  const { createElement, createRef, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { SecurePreviewUI } = await import('../src/web/secure-preview-ui');
  const target: SecureCliTarget = {
    origin: 'https://relay.synthetic.invalid',
    owner: 'owner',
    rootKeyId: 'A'.repeat(43),
    clientDeviceId: 'client',
    hostDeviceId: 'host',
    workspaceId: 'workspace',
    localProjectId: 'project',
    userId: 'user',
    machineId: 'machine',
    sessionId: 'session',
    product: {
      catalogWorkspaceId: 'space',
      projectId: 'product',
      replicaId: 'replica',
      revision: 1,
    },
  };
  let context: SecurePreviewContext = { target, online: true, generation: 1 };
  const memory = new Memory(),
    store = new SecureStore(memory),
    storage = new SecureScopedStorage(store),
    annotations = new SecurePreviewAnnotations(store, storage);
  const calls: { method: string; params: any }[] = [],
    images: unknown[] = [],
    changes: unknown[] = [];
  let sequence = 0;
  let viewport = previewViewport;
  const timers = new Set<() => void>();
  const props: SecurePreviewUiProps = {
    context: () => context,
    storage,
    annotations,
    schedule: (_milliseconds, work) => {
      timers.add(work);
      return () => {
        timers.delete(work);
      };
    },
    request: async (destination, method, input, current) => {
      current();
      assert.deepEqual(destination, target);
      const params = input as any;
      calls.push({ method, params });
      const base = {
        previewVersion: 1,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
        confirmed: true,
      };
      if (method === 'preview-read' && params.view === 'options')
        return {
          ...base,
          view: 'options',
          available: true,
          execution: { mode: 'shared', status: 'ready', revision: 0 },
          services: [
            {
              id: 'service',
              label: 'Synthetic service <script>unsafe()</script>',
              version: previewVersion,
              startPath: '/',
            },
          ],
        };
      if (method === 'preview-read' && params.view === 'locate')
        return {
          ...base,
          view: 'locate',
          clientId: params.clientId,
          previewId: params.previewId,
          frameId: params.frameId,
          element: {
            elementId: 'element',
            frameId: params.frameId,
            tag: 'input',
            role: 'textbox',
            name: 'Synthetic <img src=x>',
            text: 'Unsafe <script>unsafe()</script>',
            rect: { x: 20, y: 20, width: 120, height: 40 },
            editable: true,
            password: false,
          },
        };
      if (method === 'preview-read')
        return {
          ...base,
          ...params,
          frame: previewFrame('preview', 'frame-' + ++sequence, viewport),
          expiresAt: 123456789,
        };
      const request = (method === 'preview-close' ? params.request : params) as PreviewAction;
      if ('viewport' in request) viewport = request.viewport;
      return {
        previewVersion: 1,
        workspaceId: target.workspaceId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
        clientId: request.clientId,
        operationId: request.operationId,
        action: request.action,
        requestVersion: await previewRequestVersion(request),
        phase: method === 'preview-close' ? 'closed' : 'accepted',
        previewId: 'preview',
        closed: method === 'preview-close',
        message: 'Synthetic confirmed',
        checkedAt: '2026-09-12T00:00:00.000Z',
        ...(method === 'preview-close'
          ? {}
          : { frame: previewFrame('preview', 'frame-' + ++sequence, viewport) }),
      };
    },
    addImage: async (scope, item, current) => {
      current();
      images.push({ target: scope, item });
    },
    changedAnnotations: async (scope, items, current) => {
      current();
      changes.push({ target: scope, items });
    },
  };
  const ref = createRef<SecurePreviewUiHandle>(),
    root = createRoot(document.getElementById('app')!);
  let unblockWrite: (() => void) | undefined;
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label,
    );
    assert.ok(found, label);
    return found;
  };
  const click = async (label: string) => act(async () => button(label).click());
  const field = (label: string) => {
    const found = [...document.querySelectorAll('label')].find((item) =>
      item.textContent?.trim().startsWith(label),
    );
    assert.ok(found, label);
    return found.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!;
  };
  const type = async (label: string, value: string) =>
    act(async () => {
      const input = field(label);
      Object.getOwnPropertyDescriptor(
        input.tagName === 'TEXTAREA'
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  try {
    await act(async () => root.render(createElement(SecurePreviewUI, { ...props, ref })));
    assert.equal(calls.length, 0);
    await act(async () => ref.current!.open(target));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.view, 'options');
    await click('连接预览');
    assert.equal(
      document
        .querySelector('.preview-frame img')!
        .getAttribute('src')!
        .startsWith('data:image/png;base64,'),
      true,
    );
    await click('定位画面中心元素');
    assert.equal(document.querySelector('.preview-element script,.preview-element img'), null);
    await type('标注说明', 'Synthetic reviewed note <img src=x>');
    await act(async () => field('在本地标注中保存当前 PNG 截图').click());
    const before = calls.length;
    await click('保存冻结标注');
    assert.equal(calls.length, before);
    assert.equal(document.querySelectorAll('.preview-annotation-card').length, 1);
    assert.equal(document.querySelector('.preview-annotation-card script'), null);
    assert.equal(
      document
        .querySelector('.preview-annotation-card details img')!
        .getAttribute('src')!
        .startsWith('data:image/png;base64,'),
      true,
    );
    const savedHeartbeat = [...timers][0],
      writingSelection = previewSignal(),
      finishSelection = previewSignal();
    unblockWrite = finishSelection.resolve;
    assert.ok(savedHeartbeat);
    memory.beforeWrite = async () => {
      writingSelection.resolve();
      await finishSelection.promise;
    };
    await act(async () => {
      button('加入原会话草稿').click();
      await writingSelection.promise;
    });
    for (const label of [
      '加入原会话草稿',
      '将截图作为附件',
      '编辑说明',
      '删除保存的标注',
      '重新截图',
    ])
      assert.equal(button(label).disabled, true, label + ' waits for the saved selection');
    assert.equal(timers.size, 0, 'annotation persistence suspends the preview heartbeat');
    const duringSaveCalls = calls.length;
    await act(async () => {
      savedHeartbeat();
      button('将截图作为附件').click();
    });
    assert.equal(calls.length, duringSaveCalls, 'a cancelled heartbeat cannot interrupt the save');
    assert.equal(
      images.length,
      0,
      'the disabled screenshot action does not read the old selection',
    );
    await act(async () => {
      memory.beforeWrite = undefined;
      finishSelection.resolve();
    });
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.equal(button('将截图作为附件').disabled, false);
    assert.equal(timers.size, 1, 'the heartbeat resumes only after persistence and projection');
    assert.equal((await annotations.read(target, () => {}))[0].selectionId !== undefined, true);
    await click('将截图作为附件');
    assert.equal(images.length, 1);
    await click('编辑说明');
    const card = document.querySelector('.preview-annotation-card')!;
    await act(async () => {
      const textarea = card.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Edited local annotation',
      );
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await click('保存说明');
    assert.equal((await annotations.read(target, () => {}))[0].selectionId, undefined);
    await type('输入到网页', 'Explicit webpage input');
    await click('将文字输入网页');
    assert.equal(calls.at(-1)!.params.action, 'input');
    await click('向下滚动');
    assert.equal(calls.at(-1)!.params.action, 'scroll');
    await click('删除保存的标注');
    assert.equal((await annotations.read(target, () => {})).length, 0);
    assert(changes.length >= 4);
    const count = calls.length;
    context = { ...context, online: false, generation: 2 };
    await act(async () => root.render(createElement(SecurePreviewUI, { ...props, ref })));
    assert.equal(document.querySelector('.project-preview-panel'), null);
    assert.equal(calls.length, count);
    context = { ...context, online: true, generation: 3 };
    await act(async () => root.render(createElement(SecurePreviewUI, { ...props, ref })));
    assert.equal(document.querySelector('.project-preview-panel'), null);
    assert.equal(calls.length, count);
    await act(async () => ref.current!.open(target));
    assert.equal(
      document.querySelector('.preview-frame'),
      null,
      'cold reopen never restores a live screenshot',
    );
    await click('关闭网页预览面板');
    assert.equal(document.querySelector('.project-preview-panel'), null);
    assert.equal(calls.at(-1)!.method, 'preview-close');
  } finally {
    memory.beforeWrite = undefined;
    unblockWrite?.();
    await act(async () => {
      await ref.current?.close();
      root.unmount();
    });
    dom.window.close();
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
});
