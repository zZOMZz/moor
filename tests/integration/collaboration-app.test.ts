import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { CollaborationClient, type CollaborationStorage } from '@moor/client/collaboration-client';
import { CollaborationStore } from '@moor/sync/store';
import {
  collaborationReadResponseSchema,
  type CollaborationSyncRequest,
} from '@moor/protocol/collaboration-protocol';
import { syntheticCollaboration } from '../fixtures/collaboration-host';

class Memory implements CollaborationStorage {
  values = new Map<string, unknown>();
  async read(key: string) {
    return structuredClone(this.values.get(key));
  }
  async exclusive<T>(_key: string, current: () => void, task: () => Promise<T>) {
    current();
    return task();
  }
  async compareAndSet(key: string, before: unknown, value: unknown, current: () => void) {
    current();
    assert.deepEqual(this.values.get(key) ?? null, before);
    this.values.set(key, structuredClone(value));
  }
}

test('collaboration composer restores local text and never transmits edits on refresh or reconnect', async (t) => {
  const f = await syntheticCollaboration();
  t.after(f.close);
  const initial = collaborationReadResponseSchema.parse(
    await (await f.ownerApi(f.route + '/enable', {})).json(),
  );
  const actor = {
    kind: 'relay' as const,
    authorityId: f.accounts.authorityId,
    accountId: f.ownerId,
  };
  const host = new CollaborationStore(':memory:', actor.authorityId, () => 1000);
  t.after(() => host.close());
  host.createWorkspace(actor, initial.scope.workspaceId);
  host.registerSession(actor, initial.scope, initial.target);
  const requests: CollaborationSyncRequest[] = [];
  const storage = new Memory();
  let sequence = 0;
  const client = new CollaborationClient({
    scope: initial.scope,
    author: { actor, clientId: 'browser' },
    storage,
    current: () => {},
    now: () => 1000,
    uuid: () => 'intent-' + ++sequence,
    transport: {
      sync: async (request) => {
        requests.push(structuredClone(request));
        return host.sync(actor, request);
      },
    },
  });
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://synthetic.invalid/',
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const set = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  for (const name of [
    'window',
    'document',
    'navigator',
    'location',
    'localStorage',
    'HTMLElement',
    'HTMLTextAreaElement',
    'Event',
  ])
    set(name, (dom.window as unknown as Record<string, unknown>)[name]);
  set('IS_REACT_ACT_ENVIRONMENT', true);
  set(
    'WebSocket',
    class {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 0;
      close() {}
    },
  );
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { CollaborationBoard } = await import('../../apps/web/src/app/collaboration-app');
  const root = createRoot(document.getElementById('app')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const composerKey = JSON.stringify([
    'moor-collaboration-composer',
    location.origin,
    actor,
    initial.scope,
    'shared-draft',
  ]);
  localStorage.setItem(
    composerKey,
    JSON.stringify({ text: 'previous local input', parents: ['retired-revision'] }),
  );
  const refreshRead = async () => initial;
  const render = async (key: string) =>
    act(async () => {
      root.render(
        createElement(CollaborationBoard, {
          key,
          client,
          initial,
          actor,
          route: f.route,
          refreshRead,
        }),
      );
    });
  const field = () => document.querySelector('textarea')!;
  const type = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        field(),
        value,
      );
      field().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  await render('first');
  assert.equal(field().value, 'previous local input');
  await type('SYNTHETIC_LOCAL_ONLY_DRAFT');
  assert.equal(JSON.parse(localStorage.getItem(composerKey)!).text, field().value);
  await render('reload');
  assert.equal(field().value, 'SYNTHETIC_LOCAL_ONLY_DRAFT');
  await act(async () => {
    window.dispatchEvent(new dom.window.Event('online'));
  });
  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request.operations.length === 0));
  assert.equal(JSON.stringify(requests).includes('SYNTHETIC_LOCAL_ONLY_DRAFT'), false);
  assert.deepEqual(client.state.snapshot().pending, []);
  assert.deepEqual(host.projection(initial.scope).operations, []);
  assert.equal(document.body.textContent!.includes('保存共享草稿'), false);
  const submit = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === '授权提交任务',
  )!;
  await act(async () => submit.click());
  const operations = host.projection(initial.scope).operations;
  assert.equal(operations.length, 1);
  assert.equal(operations[0].kind, 'submit');
  assert.equal(
    operations[0].kind === 'submit' && operations[0].input.prompt,
    'SYNTHETIC_LOCAL_ONLY_DRAFT',
  );
  await type('SYNTHETIC_LATER_LOCAL_EDIT');
  await act(async () => {
    window.dispatchEvent(new dom.window.Event('online'));
  });
  assert.deepEqual(host.projection(initial.scope).operations, operations);
  assert.equal(JSON.stringify(requests).includes('SYNTHETIC_LATER_LOCAL_EDIT'), false);
});
