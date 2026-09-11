import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Workspace } from '../src/catalog';

// Real component interactions against synthetic data, with deterministic observer
// signals. No model account, network, real runtime, animation delay or sleeps.
test('mobile navigation menus stay inside the dialog focus boundary and survive refresh', async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://synthetic.invalid',
  });
  const win = dom.window;
  // Bundling loads React before jsdom, enabling its legacy input-event fallback.
  Object.assign(win.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  for (const name of [
    'window',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'Element',
    'Node',
    'NodeFilter',
    'Document',
    'DocumentFragment',
    'ShadowRoot',
    'MutationObserver',
    'DOMRect',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'navigator',
    'localStorage',
  ]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? win : (win as any)[name],
    });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: (fn: FrameRequestCallback) => {
      queueMicrotask(() => fn(0));
      return 1;
    },
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  Object.assign(win, {
    matchMedia: globalThis.matchMedia,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  });
  const { act } = await import('react');
  const { showShell, showNavigation, showRunControls, closeNavigation, disposeUI } =
    await import('../src/web/ui');
  const space: Workspace = {
    id: 'w',
    name: 'Synthetic workspace',
    createdAt: 1,
    projects: [],
    replicas: [],
    hosts: [
      { id: 'h', deviceId: 'd', runtimeWorkspaceId: 'rw', name: 'Synthetic Mac', online: true },
    ],
  } as unknown as Workspace;
  let selectedHost = '',
    created = 0,
    sent = 0;
  const drafts: string[] = [];
  const props = {
    catalog: [space],
    space,
    projectLabels: {},
    list: [],
    projectFilter: '',
    search: '',
    selectedSession: '',
    connected: true,
    localOnly: false,
    canCreate: true,
    onWorkspace: () => {},
    onHost: (id: string) => {
      selectedHost = id;
    },
    onSearch: () => {},
    onProject: () => {},
    onSession: () => {},
    onNew: () => {
      created++;
    },
    onManage: () => {},
    onPair: () => {},
    onLogout: () => {},
  };
  const button = (label: string) => {
    const element = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    assert.ok(element, label);
    return element;
  };
  const click = async (element: HTMLElement) => {
    await act(async () => element.click());
  };
  try {
    await act(async () => {
      showShell({
        onSend() {
          sent++;
        },
        onDraft(value) {
          drafts.push(value);
        },
        onCancel() {},
      });
      showNavigation(props);
    });
    await click(button('选择工作区和会话'));
    const popup = document.querySelector('#navigation')!;
    assert.equal(popup.getAttribute('data-open'), '');
    await click(button('我的电脑'));
    assert.ok(document.querySelector('[role="menu"]'));
    const hostItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) =>
      e.textContent?.includes('Synthetic Mac'),
    )!;
    assert.ok(hostItem);
    await act(async () => {
      showNavigation({ ...props, connected: false });
    });
    assert.ok(document.querySelector('[role="menu"]'), 'network refresh does not close a menu');
    await click(hostItem);
    assert.equal(selectedHost, 'h');
    await click(button('设置与账号'));
    assert.equal(document.querySelectorAll('[role="menuitemradio"]').length, 3);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.equal(
      document.activeElement,
      button('设置与账号'),
      'Escape restores focus to the menu trigger',
    );
    await click(document.querySelector<HTMLElement>('#new')!);
    assert.equal(created, 1, 'new-session action is connected');
    await act(async () => closeNavigation());
    assert.equal(
      document.activeElement,
      button('选择工作区和会话'),
      'drawer returns focus to its trigger',
    );

    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!;
    const suggestion = [
      ...document.querySelectorAll<HTMLButtonElement>('.composer-suggestions button'),
    ].find((element) => element.textContent === '梳理项目')!;
    prompt.value = '保留已有草稿';
    await click(suggestion);
    assert.equal(prompt.value, '保留已有草稿\n\n请梳理当前项目的结构、主要功能和开发方式。');
    assert.deepEqual(
      drafts,
      [prompt.value],
      'suggestions persist through the normal draft callback',
    );
    assert.equal(sent, 0, 'choosing a suggestion never submits a task');
    prompt.readOnly = true;
    await click(suggestion);
    assert.equal(drafts.length, 1, 'pending submissions keep their draft unchanged');
    prompt.readOnly = false;

    const changes: unknown[] = [];
    const controls = {
      capabilities: {
        models: [
          { id: 'a', name: 'Model A', efforts: ['high'] },
          { id: 'b', name: 'Model B', efforts: ['medium'] },
        ],
        modes: [{ id: 'read-only', name: 'Read only' }],
        effortConfigId: 'effort',
      },
      selection: { modelId: 'a', reasoningEffort: 'high', modeId: 'read-only' },
      agentType: 'codex',
      disabled: false,
      loading: false,
      canRefresh: true,
      validation: '',
      existing: true,
      onChange: (key: string, value: string) => changes.push([key, value]),
      onRefresh() {},
    };
    await act(async () => {
      showRunControls(controls);
    });
    await click(button('模型'));
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (e) => e.textContent === 'Model B',
    )!;
    assert.ok(option);
    await click(option);
    assert.deepEqual(changes, [['modelId', 'b']]);
    await act(async () => {
      showRunControls({ ...controls, selection: { modelId: 'b' } });
    });
    await click(button('Effort'));
    const effortList = document.getElementById(button('Effort').getAttribute('aria-controls')!)!;
    assert.ok(effortList);
    assert.deepEqual(
      [...effortList.querySelectorAll('[role="option"]')].map((e) => e.textContent),
      ['默认', 'medium'],
    );
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await act(async () => {
      showRunControls({ ...controls, disabled: true });
    });
    for (const name of ['模型', 'Effort', '审批'])
      assert.equal(button(name).disabled, true, 'pending operations lock configuration');

    Object.assign(globalThis, {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    await act(async () => {
      showShell({ onSend() {}, onDraft() {}, onCancel() {} });
      showNavigation(props);
    });
    assert.equal(document.querySelector('#navigation')!.hasAttribute('data-open'), true);
    await click(button('收起侧栏'));
    assert.equal(document.querySelector('#navigation')!.hasAttribute('data-closed'), true);
    await click(button('选择工作区和会话'));
    assert.equal(document.querySelector('#navigation')!.hasAttribute('data-open'), true);
  } finally {
    await act(async () => disposeUI());
    dom.window.close();
  }
});
