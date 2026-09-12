import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { DesktopPreviewSettings } from '../src/desktop/preview-settings.cjs';
import { PreviewConfig } from '../src/runtime/preview-config';

function transport() {
  const sent: any[] = [],
    timers = new Map<number, () => void>();
  let timerId = 0,
    current = true;
  let child = {
    connected: true,
    send(message: any) {
      sent.push(message);
    },
  };
  const bridge = new DesktopPreviewSettings({
    bridge: () => child,
    schedule(fn: () => void) {
      timers.set(++timerId, fn);
      return timerId;
    },
    cancel(id: unknown) {
      timers.delete(Number(id));
    },
  });
  return {
    sent,
    timers,
    bridge,
    get child() {
      return child;
    },
    set child(value: typeof child) {
      child = value;
    },
    get current() {
      return current;
    },
    set current(value: boolean) {
      current = value;
    },
  };
}
const state = {
  revision: 1,
  targets: [
    {
      localProjectId: 'project',
      executionId: 'shared',
      label: 'Synthetic',
      rootPath: '/synthetic/project',
      projectRoot: '/synthetic/project',
      privateMetadata: 'not-public',
    },
  ],
  services: [
    {
      id: 'service',
      localProjectId: 'project',
      executionId: 'shared',
      label: 'Frontend',
      address: '127.0.0.1',
      port: 5173,
      startPath: '/',
      enabled: true,
      current: true,
      rootIdentity: 'not-public',
    },
  ],
  privateMetadata: 'not-public',
};
test('desktop preview IPC validates actions and scopes replies to current child/window, bounded timers and no automatic retry', async () => {
  const f = transport();
  const first = f.bridge.request({ action: 'read' }, () => f.current),
    message = f.sent[0];
  f.bridge.receive({} as any, {
    type: 'preview-config-result',
    requestId: message.requestId,
    ok: true,
    state,
  });
  assert.equal(f.timers.size, 1);
  f.bridge.receive(f.child, {
    type: 'preview-config-result',
    requestId: message.requestId,
    ok: true,
    state,
  });
  assert.equal(JSON.stringify(await first).includes('not-public'), false);
  assert.equal(f.timers.size, 0);
  for (const action of [
    { action: 'read', rootPath: '/outside' },
    { action: 'service-enabled', expectedRevision: 1, id: 'service', enabled: 'true' },
    {
      action: 'service-save',
      expectedRevision: 1,
      localProjectId: 'project',
      executionId: 'shared',
      label: 'Bad',
      address: 'localhost',
      port: 5173,
      startPath: '/',
    },
  ])
    assert.throws(() => f.bridge.request(action, () => true));
  const lost = f.bridge.request(
      { action: 'service-remove', expectedRevision: 1, id: 'service' },
      () => true,
    ),
    lostError = assert.rejects(lost, /尚未确认/),
    lostMessage = f.sent.at(-1);
  [...f.timers.values()][0]!();
  await lostError;
  f.bridge.receive(f.child, {
    type: 'preview-config-result',
    requestId: lostMessage.requestId,
    ok: true,
    state,
  });
  assert.equal(f.sent.length, 2);
  const changed = f.bridge.request({ action: 'read' }, () => f.current),
    changedError = assert.rejects(changed, /窗口已变化/);
  f.current = false;
  f.bridge.receive(f.child, {
    type: 'preview-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state,
  });
  await changedError;
  f.current = true;
  const previous = f.child,
    restarted = f.bridge.request({ action: 'read' }, () => true),
    restartedError = assert.rejects(restarted, /已重启/);
  f.child = {
    connected: true,
    send(message: any) {
      f.sent.push(message);
    },
  };
  f.bridge.disconnect(previous);
  await restartedError;
  f.bridge.receive(previous, {
    type: 'preview-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state,
  });
  const failed = f.bridge.request({ action: 'read' }, () => true),
    failedError = assert.rejects(failed, (e: Error) => !e.message.includes('/private/data'));
  f.bridge.receive(f.child, {
    type: 'preview-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: false,
    error: '/private/data',
  });
  await failedError;
  const duplicate = f.bridge.request({ action: 'read' }, () => true),
    duplicateError = assert.rejects(duplicate, /不可验证/);
  f.bridge.receive(f.child, {
    type: 'preview-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state: { ...state, services: [state.services[0], state.services[0]] },
  });
  await duplicateError;
  const closing = f.bridge.request({ action: 'read' }, () => true),
    closingError = assert.rejects(closing, /已退出/);
  f.bridge.close();
  await closingError;
  assert.equal(f.timers.size, 0);
  await assert.rejects(
    f.bridge.request({ action: 'read' }, () => true),
    /暂不可用/,
  );
});

test('actual preview settings UI and preload register exact worktree targets, edit, disable, handle stale CAS and remove without probing', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'moor-desktop-preview-')),
    rootPath = join(data, 'project'),
    worktree = join(data, 'worktree');
  await mkdir(rootPath);
  await mkdir(worktree);
  t.after(() => rm(data, { recursive: true, force: true }));
  const target = (executionId: string, root: string) => ({
    localProjectId: 'project',
    executionId,
    label: executionId,
    rootPath: root,
    projectRoot: rootPath,
  });
  let targets = [target('shared', rootPath), target('worktree', worktree)];
  const config = new PreviewConfig(join(data, 'private', 'preview-v1.json'), {
    identity: { workspaceId: 'workspace', userId: 'local:synthetic', machineId: 'machine' },
    targets: () => targets,
    blockedOrigins: () => [],
  });
  const dom = new JSDOM(await readFile(resolve('src/desktop/settings.html'), 'utf8'), {
    runScripts: 'outside-only',
    url: pathToFileURL(resolve('src/desktop/settings.html')).href,
  });
  t.after(() => dom.window.close());
  const health = {
    host: { state: 'ready', message: 'Ready' },
    local: { state: 'ready', message: 'Ready' },
    relay: { state: 'unpaired', message: 'Local' },
    recovering: false,
  };
  const f = transport();
  let closed = false,
    hold = false;
  const replies: (() => void)[] = [];
  f.child = {
    connected: true,
    send(message: any) {
      f.sent.push(message);
      void Promise.resolve().then(() => {
        try {
          const state = config.handle(message.action),
            reply = () =>
              f.bridge.receive(f.child, {
                type: 'preview-config-result',
                requestId: message.requestId,
                ok: true,
                state,
              });
          if (hold) replies.push(reply);
          else reply();
        } catch (error) {
          f.bridge.receive(f.child, {
            type: 'preview-config-result',
            requestId: message.requestId,
            ok: false,
            error: error instanceof Error ? error.message : '',
          });
        }
      });
    },
  };
  const exposed = new Map<string, any>();
  runInNewContext(await readFile(resolve('src/desktop/preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name: string, value: any) => exposed.set(name, value) },
      ipcRenderer: {
        invoke(name: string, value: unknown) {
          if (name === 'personal:preview-config') return f.bridge.request(value, () => !closed);
          if (name === 'personal:health') return Promise.resolve(health);
          if (name === 'personal:settings')
            return Promise.resolve({
              name: 'Synthetic',
              server: '',
              projects: [],
              agents: ['codex'],
              health,
            });
          throw new Error('Unexpected IPC');
        },
      },
    }),
  });
  Object.assign(dom.window, {
    personal: exposed.get('personal'),
    setInterval: () => 1,
    clearInterval() {},
  });
  dom.window.eval(await readFile(resolve('src/desktop/settings.js'), 'utf8'));
  await Promise.resolve();
  const element = (id: string) => dom.window.document.getElementById(id) as HTMLInputElement;
  const click = (id: string) => (element(id).onclick as any)(new dom.window.MouseEvent('click'));
  assert.equal(f.sent.length, 0);
  await click('preview-refresh');
  element('preview-target').value = JSON.stringify(['project', 'worktree']);
  element('preview-label').value = 'Worktree preview';
  element('preview-port').value = '5173';
  element('preview-path').value = '/app?mode=review';
  element('preview-enabled').checked = true;
  await click('preview-save');
  assert.equal(f.sent.at(-1).action.executionId, 'worktree');
  assert.equal('rootPath' in f.sent.at(-1).action, false);
  const id = config.read().services[0]!.id;
  assert.equal(config.read().services[0]!.enabled, true);
  assert.equal(element('preview-target').disabled, true);
  assert.equal(element('preview-root').textContent, worktree);
  element('preview-port').value = '5174';
  await click('preview-save');
  assert.equal(config.read().services[0]!.port, 5174);
  await click('preview-toggle');
  assert.equal(config.read().services[0]!.enabled, false);
  await click('preview-toggle');
  assert.equal(config.read().services[0]!.enabled, true);
  config.handle({
    action: 'service-enabled',
    id,
    expectedRevision: config.read().revision,
    enabled: false,
  });
  await click('preview-save');
  assert.match(element('preview-status').textContent!, /已变化.*不会自动重试/);
  assert.equal(element('preview-controls').disabled, true);
  await click('preview-refresh');
  targets = [targets[0]!];
  await click('preview-refresh');
  assert.equal(
    element('preview-target').value,
    '',
    'missing worktree must not select shared as fallback',
  );
  assert.equal(element('preview-save').disabled, true);
  assert.equal(element('preview-toggle').disabled, true);
  assert.equal(element('preview-remove').disabled, false);
  await click('preview-remove');
  assert.equal(config.read().services.length, 0);
  const before = element('preview-status').textContent;
  hold = true;
  const reading = click('preview-refresh');
  await Promise.resolve();
  closed = true;
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
  replies.forEach((reply) => reply());
  await reading;
  assert.notEqual(element('preview-status').textContent, before);
  assert.match(element('preview-status').textContent!, /正在处理/);
  f.bridge.close();
  assert.equal(f.timers.size, 0);
});
