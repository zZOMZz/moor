import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import type { SecureCliTarget } from '@moor/client/secure-operation';
import type {
  SecureSkillsContext,
  SecureSkillsDependencies,
} from '../../apps/web/src/features/skills/secure-skills';
import type { SecureSkillsUiHandle } from '../../apps/web/src/features/skills/secure-skills-ui';
import type { SkillsRead } from '@moor/protocol/skills-protocol';

test('secure Skills UI displays safe complete content, manually appends, retries errors and clears on target departure', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'moor-client://app/remote/',
    pretendToBeVisual: true,
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
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
    setGlobal(name, (dom.window as unknown as Record<string, unknown>)[name]);
  setGlobal('window', dom.window);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
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
  setGlobal('requestAnimationFrame', animation);
  setGlobal('cancelAnimationFrame', () => {});
  setGlobal('ResizeObserver', resize);
  setGlobal('matchMedia', media);
  Object.assign(dom.window, {
    requestAnimationFrame: animation,
    cancelAnimationFrame() {},
    ResizeObserver: resize,
    matchMedia: media,
  });
  // Synchronous deterministic SHA-256 scheduling keeps UI assertions independent of worker timing.
  t.mock.method(
    crypto.subtle,
    'digest',
    async (_algorithm: AlgorithmIdentifier, input: BufferSource) => {
      const bytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      const result = createHash('sha256').update(bytes).digest();
      return Uint8Array.from(result).buffer;
    },
  );
  const { createElement, createRef, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { SecureSkillsUI } = await import('../../apps/web/src/features/skills/secure-skills-ui');
  const target: SecureCliTarget = {
    origin: 'https://relay.synthetic.invalid',
    owner: 'owner',
    rootKeyId: 'A'.repeat(43),
    clientDeviceId: 'client',
    hostDeviceId: 'host',
    workspaceId: 'runtime',
    localProjectId: 'project',
    userId: 'local-user',
    machineId: 'machine',
    sessionId: 'empty-session',
    product: {
      catalogWorkspaceId: 'space',
      projectId: 'product',
      replicaId: 'replica',
      revision: 1,
    },
  };
  let context: SecureSkillsContext = { target, online: true, generation: 1 };
  const text =
    '# Synthetic complete Skill\n\n<script>unsafe()</script>\n<img src=x onerror=unsafe()>\n![tracker](https://invalid.test/pixel)\n[javascript](javascript:unsafe())\n\n完整末尾';
  const hash = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
  const source = {
    id: 'project-agents',
    label: '.agents/skills',
    scope: 'project',
    convention: 'agents',
    version: hash('source'),
    status: 'available',
  };
  const summary = {
    id: 'skill',
    sourceId: source.id,
    name: 'Synthetic Skill',
    description: '合成描述',
    path: 'synthetic/SKILL.md',
    version: hash(text),
    byteLength: Buffer.byteLength(text),
    metadata: 'parsed',
  };
  const requests: SkillsRead[] = [];
  const drafts: string[] = [];
  let failRead = false;
  const props: SecureSkillsDependencies = {
    context: () => context,
    request: async (scope, method, params) => {
      assert.deepEqual(scope, target);
      assert.equal(method, 'skills-read');
      requests.push(params);
      if (failRead) throw Error('Synthetic unavailable; manually refresh');
      const base = {
        ...params,
        confirmed: true,
        catalogVersion: hash('catalog'),
        executionRevision: 0,
      };
      return params.view === 'list'
        ? { ...base, sources: [source], skills: [summary], issues: [], truncated: false }
        : {
            skillsVersion: 1,
            workspaceId: params.workspaceId,
            localProjectId: params.localProjectId,
            sessionId: params.sessionId,
            view: 'detail',
            confirmed: true,
            catalogVersion: hash('catalog'),
            executionRevision: 0,
            source,
            skill: summary,
            text,
          };
    },
    appendInstruction: async (scope, instruction, current) => {
      current();
      assert.deepEqual(scope, target);
      drafts.push(instruction);
    },
  };
  const ref = createRef<SecureSkillsUiHandle>(),
    root = createRoot(document.getElementById('app')!);
  const button = (label: string) => {
    const item = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label,
    );
    assert.ok(item, label);
    return item;
  };
  const select = async () =>
    act(async () => {
      document.querySelector<HTMLButtonElement>('.skills-list button')!.click();
    });
  try {
    await act(async () => root.render(createElement(SecureSkillsUI, { ...props, ref })));
    assert.equal(requests.length, 0);
    await act(async () => ref.current!.open(target));
    await select();
    assert.match(document.querySelector('.skills-detail')!.textContent!, /完整末尾/);
    assert.equal(
      document.querySelector('.skills-panel script,.skills-panel img,.skills-panel iframe'),
      null,
    );
    assert.equal(document.querySelector('a[href^="javascript:"]'), null);
    assert.equal(drafts.length, 0);
    await act(async () => button('将说明加入本次指令').click());
    assert.equal(drafts.length, 1);
    assert.ok(drafts[0].includes(text));
    assert.deepEqual(
      requests.map((request) => request.view),
      ['list', 'detail', 'detail'],
    );
    failRead = true;
    await act(async () => button('重新读取 Skills').click());
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Synthetic unavailable/);
    assert.equal(
      button('重新读取 Skills').disabled,
      false,
      'a read error keeps manual retry available',
    );
    failRead = false;
    await act(async () => button('重新读取 Skills').click());
    await select();
    context = { ...context, generation: 2, online: false };
    await act(async () => root.render(createElement(SecureSkillsUI, { ...props, ref })));
    assert.equal(document.querySelector('.skills-panel'), null);
    const count = requests.length;
    context = { ...context, generation: 3, online: true };
    await act(async () => root.render(createElement(SecureSkillsUI, { ...props, ref })));
    assert.equal(document.querySelector('.skills-panel'), null);
    assert.equal(requests.length, count);
    await act(async () => ref.current!.open(target));
    assert.doesNotMatch(document.querySelector('.skills-detail')!.textContent!, /完整末尾/);
    await act(async () => button('关闭 Skills').click());
    assert.equal(document.querySelector('.skills-panel'), null);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
});
