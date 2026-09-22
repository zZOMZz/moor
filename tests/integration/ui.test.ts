import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Real component interactions against synthetic data, with deterministic observer
// signals. No model account, network, real runtime, animation delay or sleeps.
test('shared run controls preserve focus, controlled selections and disabled states', async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://synthetic.invalid',
  });
  const win = dom.window;
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
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { RunControls } = await import('../../apps/web/src/components/ui');
  const { UsagePanel } = await import('../../apps/web/src/components/usage-panel');
  const root = createRoot(document.getElementById('app')!);
  const renderRunControls = (props: Parameters<typeof RunControls>[0]) =>
    root.render(createElement(RunControls, props));
  const renderUsage = (props: Parameters<typeof UsagePanel>[0]) =>
    root.render(createElement(UsagePanel, props));
  const button = (label: string) => {
    const element = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    assert.ok(element, label);
    return element;
  };
  const click = async (element: HTMLElement) => {
    await act(async () => element.click());
  };
  try {
    const changes: unknown[] = [],
      defaults: unknown[] = [];
    let refreshed = 0;
    const controls = {
      capabilities: {
        models: [
          { id: 'a', name: 'Model A', efforts: ['high'] },
          { id: 'b', name: 'Model B', efforts: ['medium'] },
        ],
        modes: [
          { id: 'read-only', name: 'Read only' },
          { id: 'agent-full-access', name: 'Full access' },
        ],
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
      async onSaveDefaults(selection: unknown) {
        defaults.push(selection);
      },
      onRefresh() {
        refreshed++;
      },
    };
    await act(async () => {
      renderRunControls(controls);
    });
    await click(button('模型与推理强度'));
    await click(document.querySelector<HTMLButtonElement>('.model-menu-row')!);
    const option = [...document.querySelectorAll<HTMLElement>('[data-choice]')].find(
      (e) => e.textContent === 'Model B',
    )!;
    assert.ok(option);
    await click(option);
    assert.deepEqual(changes, [['modelId', 'b']]);
    await act(async () => {
      renderRunControls({ ...controls, selection: { modelId: 'b' } });
    });
    await click(button('模型与推理强度'));
    await click(document.querySelectorAll<HTMLButtonElement>('.model-menu-row')[1]!);
    assert.deepEqual(
      [...document.querySelectorAll('[data-choice]')].map((e) => e.textContent),
      ['Medium'],
    );
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.equal(document.activeElement, button('模型与推理强度'));
    await click(button('模型与推理强度'));
    await click(document.querySelectorAll<HTMLButtonElement>('.model-menu-row')[1]!);
    await click(document.querySelector<HTMLElement>('[data-choice]')!);
    assert.deepEqual(changes, [
      ['modelId', 'b'],
      ['reasoningEffort', 'medium'],
    ]);
    const updatedSelection = {
      modelId: 'b',
      reasoningEffort: 'medium',
      modeId: 'read-only',
    };
    await act(async () => {
      renderRunControls({ ...controls, selection: updatedSelection });
    });
    assert.match(button('模型与推理强度').textContent ?? '', /Model B/);
    assert.match(button('模型与推理强度').textContent ?? '', /Medium/);
    await click(button('模型与推理强度'));
    const saveDefault = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent === '设为新会话默认',
    )!;
    assert.ok(saveDefault);
    await click(saveDefault);
    assert.deepEqual(defaults, [updatedSelection]);
    assert.match(document.querySelector('.model-menu-root')!.textContent!, /已设为新会话默认/);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    await click(button('权限'));
    const approvalOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (e) => e.textContent === 'Full access',
    )!;
    assert.ok(approvalOption);
    await click(approvalOption);
    assert.deepEqual(changes.at(-1), ['modeId', 'agent-full-access']);
    updatedSelection.modeId = 'agent-full-access';
    await act(async () => {
      renderRunControls({ ...controls, selection: updatedSelection });
    });
    assert.match(button('权限').textContent ?? '', /Full access/);
    assert.equal(document.querySelector('#refresh-run-options'), null);
    assert.equal(refreshed, 0, 'model and effort choices never query the host');
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    await act(async () => {
      renderRunControls({
        ...controls,
        selection: updatedSelection,
        disabled: true,
        canRefresh: false,
      });
    });
    for (const name of ['模型与推理强度', '权限'])
      assert.equal(button(name).disabled, true, 'pending operations lock configuration');
    assert.equal(document.querySelector('#refresh-run-options'), null);
    assert.match(button('模型与推理强度').textContent ?? '', /Medium/);
    assert.match(button('权限').textContent ?? '', /Full access/);
    await act(async () => {
      renderRunControls({ ...controls, validation: '所选模型不再可用' });
    });
    const validation = [...document.querySelectorAll<HTMLElement>('[role="alert"]')].find(
      (e) => e.textContent === '所选模型不再可用',
    )!;
    assert.ok(validation, 'validation is visible while settings are closed');
    let usageReads = 0;
    const { resetLabel } = await import('../../apps/web/src/components/usage-panel');
    const usageEvent = { kind: 'context-usage', used: 106000, size: 258000 };
    assert.equal(resetLabel(1000, 1000000), '已到重置时间，等待更新');
    assert.equal(resetLabel(null, 1000000), '重置时间未提供');
    await act(async () =>
      renderUsage({
        context: usageEvent,
        now: 1000000,
        onRead: () => {
          usageReads++;
        },
        usage: {
          version: 1,
          status: 'ready',
          observedAt: 1000000,
          buckets: [
            {
              id: 'core',
              name: 'Synthetic Codex',
              primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1300 },
              secondary: { usedPercent: 65, windowDurationMins: 10080 },
            },
            { id: 'special', primary: { usedPercent: 120 } },
          ],
        },
      }),
    );
    assert.equal(usageReads, 0);
    await click(button('上下文与账号额度，上下文已用 41%'));
    assert.equal(usageReads, 1);
    const panel = document.querySelector('.usage-panel')!;
    assert.match(panel.textContent!, /10.6 万 \/ 25.8 万 tokens/);
    assert.match(panel.textContent!, /剩余 77%/);
    assert.match(panel.textContent!, /剩余 35%/);
    assert.match(panel.textContent!, /剩余 0%/);
    assert.match(panel.textContent!, /5 分钟后重置/);
    assert.equal(panel.querySelector('time')?.dateTime, new Date(1300000).toISOString());
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.equal(document.activeElement, button('上下文与账号额度，上下文已用 41%'));
    await act(async () =>
      renderUsage({ now: 1000000, usage: { version: 1, status: 'unsupported', buckets: [] } }),
    );
    await click(button('上下文与账号额度'));
    assert.match(document.querySelector('.usage-panel')!.textContent!, /暂无数据/);
    assert.match(document.querySelector('.usage-panel')!.textContent!, /未提供套餐额度/);
    assert.equal(document.querySelectorAll('.usage-panel progress').length, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
