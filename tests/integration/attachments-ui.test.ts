import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import type { WorkspaceController } from '../../apps/web/src/features/workspace/workspace-controller';
import type { WorkspaceScope } from '../../apps/web/src/features/workspace/workspace-store';
import type { AttachmentReference } from '@moor/protocol/content-protocol';

test('shared browser attachment view escapes text and downloads only explicitly verified bytes', async (t) => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://synthetic.invalid' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const set = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const name of [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'MouseEvent',
    'navigator',
  ])
    set(name, (dom.window as any)[name]);
  set('IS_REACT_ACT_ENVIRONMENT', true);
  const blobs: Blob[] = [],
    downloads: { href: string; name: string }[] = [],
    revoked: string[] = [];
  const create = URL.createObjectURL,
    revoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    assert(blob instanceof Blob);
    blobs.push(blob);
    return 'blob:synthetic-' + blobs.length;
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  dom.window.HTMLAnchorElement.prototype.click = function () {
    downloads.push({ href: this.href, name: this.download });
  };
  const { createElement, act } = await import('react'),
    { createRoot } = await import('react-dom/client');
  const { WorkspaceAttachmentView } =
    await import('../../apps/web/src/features/attachments/workspace-attachment-view');
  const root = createRoot(dom.window.document.getElementById('app')!);
  t.after(async () => {
    await act(async () => root.unmount());
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    dom.window.close();
    for (const [name, descriptor] of originals)
      descriptor
        ? Object.defineProperty(globalThis, name, descriptor)
        : Reflect.deleteProperty(globalThis, name);
  });
  const bytes = Buffer.from('<script>inert()</script>');
  const reference: AttachmentReference = {
    contentVersion: 1,
    attachmentId: 'attachment',
    name: 'Synthetic <script>.txt',
    content: {
      version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
      mediaType: 'text/plain',
    },
  };
  const scope: WorkspaceScope = {
    source: 'remote',
    target: {
      serverKey: dom.window.location.origin,
      owner: 'owner',
      deviceId: 'device',
      userId: 'user',
      machineId: 'machine',
      workspaceId: 'runtime',
      localProjectId: 'project',
      catalogWorkspaceId: 'catalog',
      catalogProjectId: 'logical',
      replicaId: 'replica',
    },
  };
  let reads = 0,
    data = bytes.toString('base64'),
    pending: Promise<unknown> | undefined;
  const errors: string[] = [];
  const controller = {
    readAttachment: async () => {
      reads++;
      return { source: 'cache', cacheSaved: true, data };
    },
  } as unknown as WorkspaceController;
  const run = (task: () => Promise<unknown>) => {
    pending = task().catch((error) => errors.push(error.message));
  };
  const render = async (sessionId: string) => {
    await act(async () =>
      root.render(
        createElement(WorkspaceAttachmentView, {
          controller,
          scope,
          sessionId,
          reference,
          busy: false,
          run,
        }),
      ),
    );
  };
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === label,
    )!;
    assert(button);
    await act(async () => {
      button.click();
      await pending;
    });
  };
  await render('session');
  assert.equal(reads, 0);
  assert.equal(downloads.length, 0);
  await click('查看附件');
  assert.equal(dom.window.document.querySelector('script'), null);
  assert.equal(dom.window.document.querySelector('pre')!.textContent, bytes.toString());
  assert.match(dom.window.document.body.textContent!, /本机缓存/);
  await click('保存附件');
  assert.deepEqual(downloads, [{ href: 'blob:synthetic-1', name: reference.name }]);
  assert.equal(await blobs[0]!.text(), bytes.toString());
  assert.equal(reads, 1, 'saving cached bytes never rereads or dispatches an operation');
  assert.match(dom.window.document.body.textContent!, /已交给浏览器下载/);
  await render('other-session');
  assert.equal(
    dom.window.document.querySelector('pre'),
    null,
    'a different scope clears the old attachment view',
  );
  data = Buffer.from('wrong bytes').toString('base64');
  await click('查看附件');
  await click('保存附件');
  assert.equal(downloads.length, 1, 'mismatched bytes never leave the browser');
  assert.match(errors.at(-1)!, /校验失败/);
});
