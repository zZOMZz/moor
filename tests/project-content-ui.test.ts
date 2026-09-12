import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { ProjectContentPanelProps } from '../src/web/project-content-ui';
import type { ProjectDiffReference } from '../src/project-content-protocol';

const version = 'sha256:' + '0'.repeat(64);
const scope = {
  contentVersion: 1 as const,
  workspaceId: 'runtime',
  localProjectId: 'project',
  sessionId: 'session',
  confirmed: true as const,
};
const reference: ProjectDiffReference = {
  contentVersion: 1,
  basis: 'project-snapshot',
  turnId: 'turn',
  diffId: 'diff',
  state: 'ready',
  version,
  changeCount: 1,
};

test('mobile project panel distinguishes current files, cached history and incomplete scans while preserving safe interaction', async () => {
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
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
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
  const { showProjectContentPanel, showProjectContentControls } =
    await import('../src/web/project-content-ui');
  const actions: unknown[] = [];
  let props: ProjectContentPanelProps = {
    title: 'Synthetic session · Synthetic Mac',
    mode: 'tree',
    turns: [{ id: 'turn', label: '第 1 回合', reference }],
    tree: {
      source: 'cache',
      cacheSaved: true,
      result: {
        ...scope,
        version,
        source: 'git',
        offset: 0,
        total: 4,
        nextOffset: 3,
        entries: [
          { path: 'docs', type: 'directory', size: 0 },
          { path: 'docs/readme.md', type: 'file', size: 30 },
          { path: 'huge.txt', type: 'file', size: 2 * 1024 * 1024 },
        ],
        partial: true,
        enumerationComplete: false,
        issues: [{ reason: 'entry-limit' }],
      },
    },
    onMode: (mode) => actions.push(mode),
    onTreeMore: () => actions.push('more'),
    onFile: (path, size) => actions.push({ path, size }),
    onTurn: (id) => actions.push(id),
    onDiffFile: (change) => actions.push(change.path),
    onRefresh: () => actions.push('refresh'),
    onClose: () => showProjectContentPanel(),
  };
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (value) => value.getAttribute('aria-label') === label || value.textContent === label,
    );
    assert.ok(found, label);
    return found;
  };
  const panel = () => document.querySelector('.project-content-panel')!;
  try {
    await act(async () => {
      showShell({ onSend() {}, onDraft() {}, onCancel() {} });
      showProjectContentControls({ tree: true, changes: true, onTree() {}, onChanges() {} });
      showProjectContentPanel(props);
    });
    assert.match(panel().textContent!, /上次读取的目录缓存/);
    assert.match(panel().textContent!, /未列出不表示文件不存在/);
    assert.match(panel().textContent!, /外部编辑器或其他会话/);
    await act(async () => button('打开目录：docs').click());
    await act(async () => button('查看文件：docs/readme.md').click());
    assert.deepEqual(actions[0], { path: 'docs/readme.md', size: 30 });
    await act(async () => button('继续载入目录').click());
    assert.equal(actions[1], 'more');
    await act(async () => button('返回上级目录').click());
    assert.match(button('查看文件：huge.txt').textContent!, /超限/);
    const text = '# Synthetic\n<script>unsafe</script>\n[unsafe](javascript:alert(1))';
    props = {
      ...props,
      currentFile: {
        source: 'cache',
        stale: true,
        cacheSaved: true,
        bytes: new TextEncoder().encode(text),
        text,
        result: {
          ...scope,
          path: 'docs/readme.md',
          content: { version, byteLength: text.length, mediaType: 'text/plain' },
          status: 'content',
          encoding: 'base64',
          data: '',
        },
      },
    };
    await act(async () => showProjectContentPanel(props));
    assert.match(panel().textContent!, /已缓存文件版本 · 不代表当前主机内容/);
    assert.equal(panel().querySelector('script'), null);
    assert.equal(panel().querySelector('a[href^="javascript:"]'), null);
    assert.ok(panel().querySelector('.project-markdown h2'));
    await act(async () => button('源文本').click());
    assert.equal(panel().querySelector('.project-file-text')!.textContent, text);
    const file = {
      path: 'a.txt',
      size: 3,
      state: 'text' as const,
      version,
      mediaType: 'text/plain' as const,
    };
    props = {
      ...props,
      mode: 'changes',
      turnId: 'turn',
      diff: {
        source: 'host',
        cacheSaved: true,
        result: {
          ...scope,
          turnId: 'turn',
          state: 'ready',
          reference,
          changes: [{ path: 'a.txt', kind: 'modified', before: file, after: file }],
          partial: false,
          issues: [],
          attribution: 'shared-project',
        },
      },
      diffFile: {
        source: 'cache',
        cacheSaved: true,
        result: {
          ...scope,
          turnId: 'turn',
          path: 'a.txt',
          reference,
          before: { ...file, text: 'old' },
          after: { ...file, text: 'new' },
          partial: false,
          issues: [],
          attribution: 'shared-project',
        },
      },
    };
    await act(async () => showProjectContentPanel(props));
    assert.match(panel().textContent!, /已保存的回合前后版本 · 离线缓存/);
    assert.equal(panel().querySelector('.project-diff-line.removed code')!.textContent, 'old');
    assert.equal(panel().querySelector('.project-diff-line.added code')!.textContent, 'new');
    await act(async () => button('前后版本').click());
    assert.equal(panel().querySelectorAll('.project-frozen-file').length, 2);
    for (const state of [
      'pending',
      'partial',
      'unavailable',
      'interrupted',
      'not-recorded',
    ] as const) {
      props = {
        ...props,
        diffFile: undefined,
        diff: {
          source: 'cache',
          cacheSaved: true,
          result: {
            ...props.diff!.result,
            state,
            changes: [],
            partial: true,
            reference: undefined,
          },
        },
      };
      await act(async () => showProjectContentPanel(props));
      assert.ok(panel().querySelector('.project-partial'), state);
      assert.doesNotMatch(panel().textContent!, /未检测到文件变化|零改动|0 个文件/, state);
    }
    await act(async () => button('关闭文件与变更').click());
    assert.equal(document.querySelector('.project-content-panel'), null);
    assert.equal(
      document.querySelector<HTMLTextAreaElement>('#prompt')!.value,
      '',
      'read-only navigation never changes the prompt',
    );
  } finally {
    await act(async () => disposeUI());
    dom.window.close();
  }
});
