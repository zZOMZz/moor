import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { DesktopAgentSettings } from '../src/desktop/agent-settings.cjs';
import { RuntimeStore } from '../src/runtime/store';
import { AgentSettings } from '../src/runtime/agent-settings';
import { syntheticCapabilities } from './support/agent-capabilities';

function transport() {
  const sent: any[] = [],
    timers = new Map<number, () => void>();
  let counter = 0,
    current = true;
  let child = {
    connected: true,
    send(message: any) {
      sent.push(message);
    },
  };
  const bridge = new DesktopAgentSettings({
    bridge: () => child,
    schedule(callback: () => void) {
      timers.set(++counter, callback);
      return counter;
    },
    cancel(timer: unknown) {
      timers.delete(Number(timer));
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
  revision: 2,
  presets: [
    {
      id: 'preset',
      name: 'Synthetic ACP',
      versionId: 'agent-v1',
      cliType: 'custom',
      agentType: 'custom',
      enabled: false,
      command: '/synthetic/agent',
      args: ['literal argument'],
      checked: {
        versionId: 'agent-v1',
        ok: true,
        runConfig: syntheticCapabilities,
        rawDiagnostics: 'not-public',
      },
      privateMetadata: 'not-public',
    },
  ],
  privateMetadata: 'not-public',
};
test('private Agent IPC validates actions, strips unchecked fields, and binds replies to child and settings frame', async () => {
  const f = transport();
  const reading = f.bridge.request({ action: 'read' }, () => f.current),
    request = f.sent[0];
  f.bridge.receive(
    {},
    { type: 'agent-config-result', requestId: request.requestId, ok: true, state },
  );
  assert.equal(f.timers.size, 1);
  f.bridge.receive(f.child, {
    type: 'agent-config-result',
    requestId: request.requestId,
    ok: true,
    state,
  });
  const received = await reading;
  assert.equal(received.presets[0].command, '/synthetic/agent');
  assert.equal(JSON.stringify(received).includes('not-public'), false);
  for (const action of [
    { action: 'read', command: '/synthetic/extra' },
    { action: 'save', expectedRevision: 2, name: 'Bad', command: 'relative', args: [] },
    {
      action: 'save',
      expectedRevision: 2,
      name: 'Bad',
      command: '/synthetic/program',
      args: ['\0'],
    },
    { action: 'builtin', expectedRevision: 2, agentType: 'shell' },
    { action: 'check', expectedRevision: 2, id: 'preset' },
    { action: 'enabled', expectedRevision: 2, id: 'preset', enabled: 'yes' },
  ])
    assert.throws(() => f.bridge.request(action, () => true));
  const changed = f.bridge.request(
    { action: 'check', expectedRevision: 2, id: 'preset', versionId: 'agent-v1' },
    () => f.current,
  );
  const changedError = assert.rejects(changed, /窗口已变化/);
  f.current = false;
  f.bridge.receive(f.child, {
    type: 'agent-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state,
  });
  await changedError;
  f.current = true;
  const stale = f.bridge.request({ action: 'read' }, () => true),
    staleError = assert.rejects(stale, /不可验证/);
  f.bridge.receive(f.child, {
    type: 'agent-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state: {
      ...state,
      presets: [{ ...state.presets[0], checked: { versionId: 'agent-v2', ok: true } }],
    },
  });
  await staleError;
  const previous = f.child,
    restart = f.bridge.request({ action: 'read' }, () => true),
    restartError = assert.rejects(restart, /已重启/);
  f.child = {
    connected: true,
    send(value: any) {
      f.sent.push(value);
    },
  };
  f.bridge.disconnect(previous);
  await restartError;
  const lost = f.bridge.request(
    { action: 'remove', expectedRevision: 2, id: 'preset' },
    () => true,
  );
  const lostError = assert.rejects(lost, /尚未确认/),
    count = f.sent.length;
  [...f.timers.values()][0]!();
  await lostError;
  assert.equal(f.sent.length, count);
  const failed = f.bridge.request({ action: 'read' }, () => true),
    failedError = assert.rejects(
      failed,
      (error: Error) => !error.message.includes('private-secret'),
    );
  f.bridge.receive(f.child, {
    type: 'agent-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: false,
    error: '/private/private-secret',
  });
  await failedError;
  const closing = f.bridge.request({ action: 'read' }, () => true),
    closingError = assert.rejects(closing, /已退出/);
  f.bridge.close();
  await closingError;
  assert.equal(f.timers.size, 0);
});

test('actual Agent settings create, check, edit, enable and remove versions without prompts or replay', async (t) => {
  const store = new RuntimeStore(':memory:');
  t.after(() => store.close());
  let opens = 0,
    closes = 0,
    prompts = 0;
  const launch: unknown[] = [];
  const settings = new AgentSettings(store, {
    async open(config, cwd, nativeId, callbacks) {
      opens++;
      launch.push(structuredClone(config));
      assert.equal(nativeId, undefined);
      assert.ok(cwd.includes('moor-agent-check-'));
      assert.deepEqual(await callbacks.permission({}), { outcome: { outcome: 'cancelled' } });
      return {
        id: 'synthetic-native',
        capabilities: syntheticCapabilities,
        async prompt() {
          prompts++;
        },
        async cancel() {},
        close() {
          closes++;
        },
      };
    },
  });
  t.after(() => settings.close());
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
      void settings.handle(message.action).then(
        (state) => {
          const reply = () =>
            f.bridge.receive(f.child, {
              type: 'agent-config-result',
              requestId: message.requestId,
              ok: true,
              state,
            });
          if (hold) replies.push(reply);
          else reply();
        },
        (error) =>
          f.bridge.receive(f.child, {
            type: 'agent-config-result',
            requestId: message.requestId,
            ok: false,
            error: error.message,
          }),
      );
    },
  };
  const exposed = new Map<string, any>();
  runInNewContext(await readFile(resolve('src/desktop/preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name: string, value: any) => exposed.set(name, value) },
      ipcRenderer: {
        invoke(name: string, value: unknown) {
          if (name === 'personal:agent-config') return f.bridge.request(value, () => !closed);
          if (name === 'personal:agent-executable') return Promise.resolve(process.execPath);
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
  assert.equal(opens, 0);
  await click('agent-refresh');
  await click('agent-choose');
  element('agent-name').value = '合成 ACP';
  element('agent-args').value = JSON.stringify(['--synthetic', '$(do-not-execute)', '中文参数']);
  await click('agent-save');
  const original = settings.read().presets[0]!;
  assert.equal(element('agent-preset').value, original.id);
  assert.equal(original.enabled, false);
  assert.equal(opens, 0);
  await click('agent-check');
  assert.equal(opens, 1);
  assert.equal(closes, 1);
  assert.equal(prompts, 0);
  assert.deepEqual((launch[0] as any).customAcp.args, [
    '--synthetic',
    '$(do-not-execute)',
    '中文参数',
  ]);
  assert.match(element('agent-check-status').textContent!, /已连接/);
  await click('agent-toggle');
  assert.equal(settings.read().presets[0].enabled, true);
  element('agent-args').value = '["--synthetic-v2"]';
  element('agent-args').dispatchEvent(new dom.window.Event('input'));
  assert.equal(element('agent-check').disabled, true);
  await click('agent-check');
  assert.equal(opens, 1);
  await click('agent-save');
  const updated = settings.read().presets[0];
  assert.notEqual(updated.versionId, original.versionId);
  assert.deepEqual(store.agents.get(original.versionId)?.customAcp?.args, [
    '--synthetic',
    '$(do-not-execute)',
    '中文参数',
  ]);
  assert.equal(updated.checked, undefined);
  element('agent-args').value = 'not-json';
  const beforeBadArgs = f.sent.length;
  await click('agent-save');
  assert.equal(f.sent.length, beforeBadArgs);
  assert.match(element('agent-status').textContent!, /有效的 JSON/);
  await click('agent-refresh');
  await settings.handle({
    action: 'enabled',
    expectedRevision: settings.read().revision,
    id: original.id,
    enabled: false,
  });
  await click('agent-toggle');
  assert.equal(element('agent-controls').disabled, true);
  assert.match(element('agent-status').textContent!, /不会自动重试/);
  await click('agent-refresh');
  await click('agent-remove');
  assert.equal(settings.read().presets.length, 0);
  assert.ok(store.agents.get(original.versionId));
  await click('agent-add-claude');
  assert.equal(settings.read().presets[0].agentType, 'claude');
  assert.equal(settings.read().presets[0].enabled, false);
  assert.equal(element('agent-save').disabled, true);
  assert.equal(opens, 1);
  assert.equal(prompts, 0);
  hold = true;
  const reading = click('agent-refresh');
  await Promise.resolve();
  closed = true;
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
  replies.forEach((reply) => reply());
  await reading;
  assert.match(element('agent-status').textContent!, /正在处理/);
  f.bridge.close();
  assert.equal(f.timers.size, 0);
});
