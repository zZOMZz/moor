import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { questionRequestSchema, type QuestionAnswer } from '../src/interaction-protocol';
import { questionDefaults, type QuestionDraftValues } from '../src/web/interactions';
import type { QuestionPanelProps } from '../src/web/interaction-ui';

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
  const { act } = await import('react');
  const { showShell, disposeUI } = await import('../src/web/ui');
  const { showQuestionPanel, showInformationPanel, closeInteractionPanel } =
    await import('../src/web/interaction-ui');
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
  let stop = 0,
    normalSend = 0;
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
    onClose: closeInteractionPanel,
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
      showShell({ onSend: () => normalSend++, onDraft() {}, onCancel: () => stop++ });
      showQuestionPanel(props);
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
    await act(async () => showQuestionPanel({ ...props, reason: '' }));
    await act(async () => button('提交回答').click());
    assert.deepEqual(answers[0], {
      action: 'accept',
      values: { text: 'Actual <script> text', number: 0, bool: false, single: '', multi: ['a'] },
    });
    await act(async () => button('拒绝回答').click());
    await act(async () => button('取消此问题').click());
    assert.deepEqual(answers.slice(1), [{ action: 'decline' }, { action: 'cancel' }]);
    assert.equal(stop, 0);
    assert.equal(normalSend, 0);
    await act(async () =>
      showQuestionPanel({
        ...props,
        reason: '',
        active: false,
        item: { ...props.item, status: 'expired' },
      }),
    );
    assert.equal(button('提交回答').disabled, true);
    assert.equal(button('取消此问题').disabled, true);
    assert.match(document.querySelector('.interaction-dialog')!.textContent!, /已失效/);
    await act(async () => closeInteractionPanel());
    await act(async () =>
      showInformationPanel({
        state: {
          version: 1,
          plans: [],
          commands: [{ name: 'inspect', description: '<img src=x onerror=bad>' }],
          contextUsage: {
            version: 1,
            source: 'acp',
            kind: 'context-usage',
            used: 0,
            size: 100,
            cost: { amount: 0, currency: 'USD' },
          },
          rateLimits: [
            {
              source: 'claude-agent-acp',
              adapterVersion: '0.76.0',
              status: 'allowed',
              rateLimitType: 'five_hour',
              utilization: 0,
            },
            {
              source: 'claude-agent-acp',
              adapterVersion: '0.76.0',
              status: 'rejected',
              rateLimitType: 'seven_day',
              resetsAt: 1,
            },
          ],
        },
        canFill: true,
        onFill: async (name) => {
          filled.push(name);
        },
        onClose: closeInteractionPanel,
      }),
    );
    assert.equal(document.querySelector('.interaction-dialog img'), null);
    assert.match(document.querySelector('.agent-usage')!.textContent!, /0 \/ 100/);
    assert.match(document.querySelector('.agent-usage')!.textContent!, /0 USD/);
    assert.match(document.querySelector('.agent-usage')!.textContent!, /未提供/);
    const limits = [...document.querySelectorAll('.agent-rate-limit')];
    assert.equal(limits.length, 2);
    assert.match(limits[0]!.textContent!, /5 小时.*已用比例0%/s);
    assert.match(limits[1]!.textContent!, /7 天.*上报状态已受限.*已用比例未提供/s);
    assert.match(limits[1]!.textContent!, /1970-01-01T00:00:01.000Z/);
    assert.match(document.querySelector('.interaction-dialog')!.textContent!, /不会推断额度已恢复/);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.agent-commands button')!.click(),
    );
    assert.deepEqual(filled, ['inspect']);
    assert.equal(normalSend, 0);
  } finally {
    await act(async () => disposeUI());
    dom.window.close();
  }
});
