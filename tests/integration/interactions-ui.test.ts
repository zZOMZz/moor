import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { questionRequestSchema, type QuestionAnswer } from '@moor/protocol/interaction-protocol';
import {
  questionDefaults,
  type QuestionDraftValues,
} from '../../apps/web/src/features/interactions/interactions';
import type { QuestionPanelProps } from '../../apps/web/src/features/interactions/interaction-ui';
import type {
  WorkspaceClientState,
  WorkspaceController,
} from '../../apps/web/src/features/workspace/workspace-controller';

test('React question forms preserve all field types, save offline drafts and keep decline/cancel separate from Stop', async () => {
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
  ])
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === 'window' ? win : (win as any)[name],
    });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: (fn: FrameRequestCallback) => {
      queueMicrotask(() => fn(0));
      return 1;
    },
    cancelAnimationFrame() {},
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
  const { QuestionPanel } = await import('../../apps/web/src/features/interactions/interaction-ui');
  const { WorkspaceInteractionUI } =
    await import('../../apps/web/src/features/interactions/workspace-interaction-ui');
  const { SessionInformation } =
    await import('../../apps/web/src/features/sessions/session-timeline');
  const root = createRoot(document.getElementById('app')!);
  const closePanel = () => root.render(null);
  const renderQuestion = (props: Parameters<typeof QuestionPanel>[0]) =>
    root.render(createElement(QuestionPanel, props));
  const renderInformation = (props: Parameters<typeof SessionInformation>[0]) =>
    root.render(createElement(SessionInformation, props));
  const request = questionRequestSchema.parse({
    interactionVersion: 1,
    workspaceId: 'runtime',
    localProjectId: 'project',
    sessionId: 'session',
    expectedTurnId: 'turn',
    requestId: 'question',
    message: 'Synthetic <script>unsafe()</script>',
    fields: [
      {
        id: 'text',
        kind: 'text',
        label: 'Text <img>',
        required: true,
        minLength: 1,
        maxLength: 100,
      },
      {
        id: 'number',
        kind: 'number',
        label: 'Number',
        required: true,
        integer: true,
        minimum: 0,
        maximum: 10,
      },
      { id: 'bool', kind: 'boolean', label: 'Bool', required: true },
      {
        id: 'single',
        kind: 'single-select',
        label: 'Single',
        required: true,
        options: [
          { value: '', label: 'Empty option' },
          { value: 'b', label: 'B' },
        ],
      },
      {
        id: 'multi',
        kind: 'multi-select',
        label: 'Multiple',
        required: true,
        minItems: 1,
        maxItems: 2,
        options: [
          { value: 'a', label: 'A <img onerror=x>' },
          { value: 'b', label: 'B' },
        ],
      },
    ],
  });
  const drafts: QuestionDraftValues[] = [],
    answers: QuestionAnswer['answer'][] = [],
    filled: string[] = [];
  const props: QuestionPanelProps = {
    item: { type: 'question', request, status: 'pending' },
    values: questionDefaults(request),
    active: true,
    busy: false,
    pending: false,
    reason: '执行电脑离线，输入保存为草稿。',
    onClose: closePanel,
    onDraft: async (values) => {
      drafts.push(structuredClone(values));
    },
    onAnswer: async (answer) => {
      answers.push(answer);
    },
  };
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label,
    );
    assert.ok(found, label);
    return found;
  };
  async function type(index: number, value: string) {
    await act(async () => {
      const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        '#agent-question-' + index,
      )!;
      const prototype =
        element.tagName === 'TEXTAREA'
          ? win.HTMLTextAreaElement.prototype
          : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new win.Event('input', { bubbles: true }));
    });
  }
  async function select(index: number, value: string) {
    await act(async () => {
      const element = document.querySelector<HTMLSelectElement>('#agent-question-' + index)!;
      element.value = value;
      element.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
  }
  try {
    await act(async () => {
      renderQuestion(props);
    });
    assert.equal(document.querySelector('.interaction-dialog script'), null);
    assert.equal(document.querySelector('.interaction-dialog img'), null);
    assert.equal(button('提交回答').disabled, true);
    await type(0, 'Actual <script> text');
    await type(1, '0');
    await select(2, 'no');
    await select(3, '0');
    await act(async () => {
      document.querySelector<HTMLInputElement>('.question-choice input')!.click();
    });
    assert.deepEqual(drafts.at(-1), {
      text: 'Actual <script> text',
      number: '0',
      bool: false,
      single: '',
      multi: ['a'],
    });
    assert.equal(answers.length, 0, 'offline typing never transmits answers');
    await act(async () => renderQuestion({ ...props, reason: '' }));
    await act(async () => button('提交回答').click());
    assert.deepEqual(answers[0], {
      action: 'accept',
      values: { text: 'Actual <script> text', number: 0, bool: false, single: '', multi: ['a'] },
    });
    await act(async () => button('拒绝回答').click());
    await act(async () => button('取消此问题').click());
    assert.deepEqual(answers.slice(1), [{ action: 'decline' }, { action: 'cancel' }]);
    await act(async () =>
      renderQuestion({
        ...props,
        reason: '',
        active: false,
        item: { ...props.item, status: 'expired' },
      }),
    );
    assert.equal(button('提交回答').disabled, true);
    assert.equal(button('取消此问题').disabled, true);
    assert.match(document.querySelector('.interaction-dialog')!.textContent!, /已失效/);
    await act(async () => closePanel());
    const interactionState = {
      offline: true,
      sessionId: 'session',
      sessionLoad: { status: 'failed', source: 'cache', reason: 'connection' },
      session: {
        meta: {},
        persisted: true,
        history: [{ id: 'turn', role: 'assistant', finished: false, items: [] }],
      },
    } as unknown as WorkspaceClientState;
    let failReload = true,
      reloads = 0,
      submissions = 0;
    const dirty: boolean[] = [];
    await act(async () =>
      root.render(
        createElement(WorkspaceInteractionUI, {
          state: interactionState,
          busy: false,
          controller: {
            saveSteerDraft: async () => {
              throw Error('Synthetic disk failure');
            },
            reloadDraft: async () => {
              reloads++;
              if (failReload) throw Error('Synthetic reload failure');
            },
            steer: async () => {
              submissions++;
            },
          } as unknown as WorkspaceController,
          run: (task) => {
            void task();
            return true;
          },
          onDirty: (value) => dirty.push(value),
        }),
      ),
    );
    await act(async () => button('回合内追加').click());
    const steerDraft = document.querySelector<HTMLTextAreaElement>('#steer-draft')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        steerDraft,
        'Keep this unsaved input',
      );
      steerDraft.dispatchEvent(new win.Event('input', { bubbles: true }));
    });
    assert.equal(steerDraft.disabled, false, 'local editing remains available offline');
    assert.equal(button('追加到活动回合').disabled, true);
    // A disabled button is not the only submission path: the form itself must
    // also reject keyboard/programmatic submit while the Host is unavailable.
    await act(async () =>
      steerDraft.form!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })),
    );
    assert.equal(submissions, 0);
    await act(async () => button('关闭').click());
    assert.ok(document.querySelector('.interaction-dialog'), 'unsaved input cannot disappear');
    assert.ok(
      button('重新读取交互草稿').closest('.interaction-dialog'),
      'recovery remains reachable inside the modal focus boundary',
    );
    await act(async () => button('重新读取交互草稿').click());
    assert.equal(reloads, 1);
    assert.equal(steerDraft.value, 'Keep this unsaved input');
    assert.match(document.querySelector('.interaction-dialog')!.textContent!, /无法重新读取/);
    assert.equal(dirty.at(-1), true);
    failReload = false;
    await act(async () => button('重新读取交互草稿').click());
    assert.equal(reloads, 2);
    assert.equal(dirty.at(-1), false);
    assert.equal(document.querySelector('.interaction-dialog'), null);
    assert.equal(submissions, 0, 'recovering a draft never submits an interaction');
    await act(async () => closePanel());
    await act(async () =>
      renderInformation({
        history: [
          {
            id: 'turn',
            role: 'assistant',
            finished: true,
            items: [
              {
                type: 'session_event',
                event: {
                  version: 1,
                  source: 'acp',
                  kind: 'commands',
                  commands: [{ name: 'inspect', description: '<img src=x onerror=bad>' }],
                },
              },
              {
                type: 'session_event',
                event: {
                  version: 1,
                  source: 'acp',
                  kind: 'context-usage',
                  used: 0,
                  size: 100,
                  cost: { amount: 0, currency: 'USD' },
                },
              },
            ],
          },
        ],
        disabled: false,
        onCommand: (name) => {
          filled.push(name);
        },
      }),
    );
    const information = document.querySelector<HTMLDetailsElement>('.session-information')!;
    assert.equal(information.querySelector('.session-information-panel'), null);
    await act(async () => {
      const toggled = new Promise<void>((resolve) =>
        information.addEventListener('toggle', () => resolve(), { once: true }),
      );
      information.querySelector('summary')!.click();
      await toggled;
    });
    assert.equal(document.querySelector('.session-information img'), null);
    assert.match(document.querySelector('.agent-usage')!.textContent!, /0 \/ 100/);
    assert.match(document.querySelector('.agent-usage')!.textContent!, /0 USD/);
    assert.match(document.querySelector('.agent-usage')!.textContent!, /未提供/);
    assert.equal(document.querySelector('.agent-rate-limit'), null);
    assert.doesNotMatch(document.querySelector('.session-information')!.textContent!, /账号额度/);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.session-command button')!.click(),
    );
    assert.deepEqual(filled, ['/inspect']);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
