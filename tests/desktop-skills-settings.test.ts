import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { DesktopSkillsSettings } from '../src/desktop/skills-settings.cjs';
import { SkillsConfig } from '../src/runtime/skills-config';

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
  const bridge = new DesktopSkillsSettings({
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
  sources: [
    {
      id: 'source',
      label: 'Synthetic Skills',
      rootPath: '/synthetic/skills',
      enabled: true,
      current: true,
      rootIdentity: 'not-public',
    },
  ],
  privateMetadata: 'not-public',
};
test('desktop skills IPC validates actions and scopes replies to current child/window, bounded timers and no automatic retry', async () => {
  const f = transport();
  const first = f.bridge.request({ action: 'read' }, () => f.current),
    message = f.sent[0];
  f.bridge.receive({} as any, {
    type: 'skills-config-result',
    requestId: message.requestId,
    ok: true,
    state,
  });
  assert.equal(f.timers.size, 1);
  f.bridge.receive(f.child, {
    type: 'skills-config-result',
    requestId: message.requestId,
    ok: true,
    state,
  });
  assert.equal(JSON.stringify(await first).includes('not-public'), false);
  assert.equal(f.timers.size, 0);
  for (const action of [
    { action: 'read', rootPath: '/outside' },
    { action: 'source-enabled', expectedRevision: 1, id: 'source', enabled: 'true' },
    { action: 'source-save', expectedRevision: 1, label: 'Bad', rootPath: 'relative' },
  ])
    assert.throws(() => f.bridge.request(action, () => true));
  const lost = f.bridge.request(
      { action: 'source-remove', expectedRevision: 1, id: 'source' },
      () => true,
    ),
    lostError = assert.rejects(lost, /尚未确认/),
    lostMessage = f.sent.at(-1);
  [...f.timers.values()][0]!();
  await lostError;
  f.bridge.receive(f.child, {
    type: 'skills-config-result',
    requestId: lostMessage.requestId,
    ok: true,
    state,
  });
  assert.equal(f.sent.length, 2);
  const changed = f.bridge.request({ action: 'read' }, () => f.current),
    changedError = assert.rejects(changed, /窗口已变化/);
  f.current = false;
  f.bridge.receive(f.child, {
    type: 'skills-config-result',
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
    type: 'skills-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state,
  });
  const failed = f.bridge.request({ action: 'read' }, () => true),
    failedError = assert.rejects(failed, (e: Error) => !e.message.includes('/private/data'));
  f.bridge.receive(f.child, {
    type: 'skills-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: false,
    error: '/private/data',
  });
  await failedError;
  const duplicate = f.bridge.request({ action: 'read' }, () => true),
    duplicateError = assert.rejects(duplicate, /不可验证/);
  f.bridge.receive(f.child, {
    type: 'skills-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state: { ...state, sources: [state.sources[0], state.sources[0]] },
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

test('actual Skills settings and preload select a directory, save, revoke stale roots, reject stale CAS and ignore closed-window replies', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moor-desktop-skills-'))),
    root = join(directory, 'skills'),
    data = join(directory, 'private');
  await mkdir(root);
  await mkdir(data);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = new SkillsConfig(join(data, 'skills-v1.json'), {
    identity: { workspaceId: 'workspace', userId: 'synthetic-user', machineId: 'machine' },
    projectRoots: () => [],
    privateRoots: [data],
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
                type: 'skills-config-result',
                requestId: message.requestId,
                ok: true,
                state,
              });
          if (hold) replies.push(reply);
          else reply();
        } catch (error) {
          f.bridge.receive(f.child, {
            type: 'skills-config-result',
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
          if (name === 'personal:skills-config') return f.bridge.request(value, () => !closed);
          if (name === 'personal:skills-directory') return Promise.resolve(root);
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
  const element = (id: string) => dom.window.document.getElementById(id) as HTMLInputElement,
    click = (id: string) => (element(id).onclick as any)(new dom.window.MouseEvent('click'));
  assert.equal(f.sent.length, 0);
  await click('skills-refresh');
  await click('skills-choose');
  assert.equal(element('skills-root').value, root);
  element('skills-label').value = 'Synthetic Skills';
  await click('skills-save');
  const id = config.read().sources[0]!.id;
  assert.equal(config.read().sources[0]!.enabled, false);
  assert.equal(element('skills-source').value, id);
  await click('skills-toggle');
  assert.equal(config.read().sources[0]!.enabled, true);
  config.handle({ action: 'source-enabled', expectedRevision: 2, id, enabled: false });
  await click('skills-save');
  assert.match(element('skills-status').textContent!, /已变化.*不会自动重试/);
  assert.equal(element('skills-controls').disabled, true);
  await click('skills-refresh');
  await rename(root, root + '-old');
  await mkdir(root);
  await click('skills-refresh');
  assert.equal(element('skills-toggle').disabled, true);
  assert.equal(element('skills-remove').disabled, false);
  assert.match(element('skills-source-status').textContent!, /原目录已变化/);
  element('skills-enabled').checked = true;
  await click('skills-save');
  assert.equal(config.read().sources[0]!.current, true);
  await click('skills-remove');
  assert.equal(config.read().sources.length, 0);
  hold = true;
  const reading = click('skills-refresh');
  await Promise.resolve();
  closed = true;
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
  replies.forEach((reply) => reply());
  await reading;
  assert.match(element('skills-status').textContent!, /正在处理/);
  f.bridge.close();
  assert.equal(f.timers.size, 0);
});
