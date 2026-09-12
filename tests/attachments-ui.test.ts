import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderItem } from '../src/web/content';
import type { AttachmentReference } from '../src/content-protocol';
import type { AttachmentControlsProps } from '../src/web/ui';

const reference: AttachmentReference = {
  contentVersion: 1,
  attachmentId: 'synthetic-attachment',
  name: 'Synthetic <script>.txt',
  content: { version: 'sha256:' + '0'.repeat(64), byteLength: 4, mediaType: 'text/plain' },
};

test('history attachment cards escape labels and expose only scoped attachment identifiers', () => {
  const html = renderItem({ type: 'attachment', attachment: reference }, true, 'row');
  assert.match(html, /data-open-attachment="synthetic-attachment"/);
  assert.match(html, /Synthetic &lt;script&gt;.txt/);
  assert.doesNotMatch(html, /<script>|href=|src=|file:\/\//);
  assert.match(
    renderItem(
      { type: 'attachment', attachment: { ...reference, path: '/private/file' } },
      true,
      'row',
    ),
    /记录不可用/,
  );
  const tool = renderItem(
    { type: 'tool_call', content: [{ type: 'attachment', attachment: reference }] },
    true,
    'tool',
  );
  assert.match(tool, /data-open-attachment="synthetic-attachment"/);
});

test('attachment controls select and paste images, expose manual retries, preserve text drafts and safely preview downloads', async () => {
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
  const { showShell, showAttachmentControls, showAttachmentPreview, disposeUI } =
    await import('../src/web/ui');
  const files: File[][] = [],
    actions: string[] = [];
  let downloads = 0;
  const props: AttachmentControlsProps = {
    items: [{ reference, data: 'dGVzdA==', uploaded: false }],
    onFiles: (values) => files.push(values),
    onUpload: (id) => actions.push('upload:' + id),
    onRetry: (id) => actions.push('retry:' + id),
    onRemove: (id) => actions.push('remove:' + id),
    onPreview: () => actions.push('preview'),
  };
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.getAttribute('aria-label') === label || element.textContent === label,
    );
    assert.ok(found, label);
    return found;
  };
  try {
    await act(async () => {
      showShell({ onSend() {}, onDraft() {}, onCancel() {}, onFiles: props.onFiles });
      showAttachmentControls(props);
    });
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!;
    prompt.value = 'Synthetic preserved draft';
    const input = document.querySelector<HTMLInputElement>('#attachment-input')!;
    const chosen = new File(['synthetic'], 'selected.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { configurable: true, value: [chosen] });
    await act(async () => {
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    assert.deepEqual(files[0], [chosen]);
    const pasted = new File(['png'], 'paste.png', { type: 'image/png' });
    const paste = new win.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => pasted }] },
    });
    await act(async () => {
      prompt.dispatchEvent(paste);
    });
    assert.equal(paste.defaultPrevented, true);
    assert.deepEqual(files[1], [pasted]);
    assert.equal(prompt.value, 'Synthetic preserved draft');
    await act(async () => {
      button('上传附件：' + reference.name).click();
    });
    assert.deepEqual(actions, ['upload:synthetic-attachment']);
    const pending = {
      owner: 'owner',
      deviceId: 'device',
      catalogWorkspaceId: 'catalog',
      replicaId: 'replica',
      request: {
        contentVersion: 1 as const,
        operationId: 'op',
        workspaceId: 'runtime',
        localProjectId: 'project',
        sessionId: 'session',
        action: 'upload' as const,
        attachment: reference,
        data: 'dGVzdA==',
      },
    };
    await act(async () => {
      showAttachmentControls({ ...props, items: [{ ...props.items[0], pending }] });
    });
    assert.equal(button('移除附件：' + reference.name).disabled, true);
    assert.match(document.querySelector('#attachment-controls')!.textContent!, /上传结果待确认/);
    assert.equal(actions.length, 1, 'rendering pending data never retries it');
    await act(async () => {
      button('手动重试附件：' + reference.name).click();
    });
    assert.equal(actions[1], 'retry:synthetic-attachment');
    await act(async () => {
      showAttachmentControls({ ...props, reason: '执行电脑离线，请连接后手动上传。' });
    });
    assert.equal(button('上传附件：' + reference.name).disabled, true);
    assert.equal(button('添加附件').disabled, false, 'offline local drafts remain available');
    assert.equal(prompt.value, 'Synthetic preserved draft');
    await act(async () => {
      showAttachmentPreview({
        reference,
        data: Buffer.from('<script>alert(1)</script>').toString('base64'),
        source: 'cache',
        onClose: () => showAttachmentPreview(),
        onDownload: () => downloads++,
      });
    });
    const preview = document.querySelector('.attachment-preview')!;
    assert.ok(preview);
    assert.match(preview.textContent!, /离线缓存/);
    assert.equal(preview.querySelector('script'), null);
    assert.match(preview.querySelector('pre')!.textContent!, /<script>/);
    await act(async () => {
      button('下载附件').click();
    });
    assert.equal(downloads, 1);
    await act(async () => {
      button('关闭附件预览').click();
    });
    assert.equal(document.querySelector('.attachment-preview'), null);
    await act(async () => {
      showAttachmentPreview({
        reference: { ...reference, content: { ...reference.content, mediaType: 'image/svg+xml' } },
        data: Buffer.from('<svg onload="alert(1)"/>').toString('base64'),
        source: 'host',
        onClose: () => showAttachmentPreview(),
        onDownload() {},
      });
    });
    assert.equal(document.querySelector('.attachment-preview img'), null);
    assert.match(document.querySelector('.attachment-preview')!.textContent!, /不支持预览/);
  } finally {
    await act(async () => {
      disposeUI();
    });
    dom.window.close();
  }
});
