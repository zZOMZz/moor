import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Workspace } from '@moor/protocol/catalog';

// Real component interactions against synthetic data, with deterministic observer
// signals. No model account, network, real runtime, animation delay or sleeps.
test('navigation and composer pickers preserve focus, controlled selections and disabled states', async () => {
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
  const { act } = await import('react');
  const {
    showShell,
    showNavigation,
    showNewSessionControls,
    showRunControls,
    showUsageControl,
    closeNavigation,
    disposeUI,
  } = await import('../../apps/web/src/components/ui');
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
        onDraft() {},
        onCancel() {},
      });
      showNavigation(props);
    });
    assert(
      document.querySelector('.prompt-surface > .composer-actions > #run-options'),
      'run controls mount inside the legacy composer toolbar',
    );
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
    assert.match(document.querySelector('[role="menu"]')!.textContent!, /外观设置/);
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

    const targets: [string, string][] = [];
    const newSession = {
      projects: [
        { id: 'project-local', name: 'Moor' },
        { id: 'project-remote', name: 'Moor' },
        { id: 'project-design', name: '设计与体验' },
      ],
      agents: [
        { id: 'codex-local', name: 'Codex' },
        { id: 'codex-remote', name: 'Codex' },
        { id: 'claude-local', name: 'Claude Code' },
      ],
      projectId: 'project-local',
      agentId: 'codex-local',
      disabled: false,
      onProject(value: string) {
        targets.push(['project', value]);
        newSession.projectId = value;
        showNewSessionControls({ ...newSession });
      },
      onAgent(value: string) {
        targets.push(['agent', value]);
        newSession.agentId = value;
        showNewSessionControls({ ...newSession });
      },
    };
    const pickerOptions = (label: string) => {
      const list = document.getElementById(button(label).getAttribute('aria-controls')!);
      assert.ok(list, `${label} options are linked to their trigger`);
      return [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    };
    await act(async () => showNewSessionControls(newSession));
    assert.equal(button('项目').id, 'project');
    assert.equal(button('Agent').id, 'agent');
    assert.equal(document.querySelector('#new-options select'), null);
    await click(button('项目'));
    assert.deepEqual(
      pickerOptions('项目').map((option) => option.textContent),
      ['Moor', 'Moor', '设计与体验'],
      'project choices contain only valid targets, without an empty default',
    );
    await click(pickerOptions('项目')[1]!);
    assert.deepEqual(
      targets,
      [['project', 'project-remote']],
      'duplicate labels preserve target ids',
    );
    assert.match(button('项目').textContent ?? '', /Moor/);
    await click(button('Agent'));
    await click(pickerOptions('Agent')[1]!);
    assert.deepEqual(targets.at(-1), ['agent', 'codex-remote']);
    assert.match(button('Agent').textContent ?? '', /Codex/);

    await click(button('项目'));
    await act(async () => {
      newSession.projectId = 'project-design';
      showNewSessionControls({ ...newSession });
    });
    assert.equal(
      button('项目').getAttribute('aria-expanded'),
      'true',
      'refresh preserves an open picker',
    );
    assert.match(button('项目').textContent ?? '', /设计与体验/);
    assert.equal(pickerOptions('项目')[2]!.getAttribute('aria-selected'), 'true');
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.equal(button('项目').getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, button('项目'), 'Escape restores project trigger focus');
    await act(async () => {
      button('Agent').focus();
      button('Agent').dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    assert.equal(
      button('Agent').getAttribute('aria-expanded'),
      'true',
      'keyboard opens the agent picker',
    );
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    assert.equal(document.activeElement, button('Agent'), 'Escape restores agent trigger focus');

    await act(async () => showNewSessionControls({ ...newSession, disabled: true }));
    for (const label of ['项目', 'Agent']) {
      assert.equal(button(label).disabled, true, 'pending operations lock target changes');
      await click(button(label));
      assert.equal(button(label).getAttribute('aria-expanded'), 'false');
    }
    assert.equal(targets.length, 2, 'disabled selectors do not dispatch changes');
    assert.equal(sent, 0, 'choosing a project or agent never submits the composer');
    await act(async () => {
      showNewSessionControls({
        ...newSession,
        projects: [],
        agents: [],
        projectId: '',
        agentId: '',
      });
    });
    for (const label of ['项目', 'Agent']) {
      assert.equal(button(label).disabled, true, 'an empty catalog cannot be selected');
      assert.match(button(label).textContent ?? '', /无可用|暂无/);
    }
    await act(async () => showNewSessionControls(null));
    assert.equal(
      document.querySelector('#new-options button'),
      null,
      'existing sessions hide target controls',
    );

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
      showRunControls(controls);
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
      showRunControls({ ...controls, selection: { modelId: 'b' } });
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
      showRunControls({ ...controls, selection: updatedSelection });
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
      showRunControls({ ...controls, selection: updatedSelection });
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
      showRunControls({
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
    assert.equal(sent, 0, 'settings interactions never submit the composer');
    await act(async () => {
      showRunControls({ ...controls, validation: '所选模型不再可用' });
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
      showUsageControl({
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
      showUsageControl({ now: 1000000, usage: { version: 1, status: 'unsupported', buckets: [] } }),
    );
    await click(button('上下文与账号额度'));
    assert.match(document.querySelector('.usage-panel')!.textContent!, /暂无数据/);
    assert.match(document.querySelector('.usage-panel')!.textContent!, /未提供套餐额度/);
    assert.equal(document.querySelectorAll('.usage-panel progress').length, 0);
  } finally {
    await act(async () => disposeUI());
    dom.window.close();
  }
});
