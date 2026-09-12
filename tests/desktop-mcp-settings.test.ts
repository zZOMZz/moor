import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { DesktopMcpSettings, validateAction, publicState } from '../src/desktop/mcp-settings.cjs';
import { McpSettings } from '../src/runtime/mcp-settings';
import { RuntimeStore } from '../src/runtime/store';

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
  const bridge = new DesktopMcpSettings({
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
const versionId = 'mcpv_' + '1'.repeat(32);
const state = {
  revision: 2,
  projects: [{ id: 'project', name: 'Synthetic', rootPath: '/private-not-public' }],
  presets: [
    {
      id: 'preset',
      versionId,
      name: 'Synthetic MCP',
      description: 'Synthetic only',
      projectIds: ['project'],
      enabled: false,
      connection: {
        transport: 'stdio',
        command: '/synthetic/mcp',
        args: ['literal'],
        envNames: ['TOKEN'],
        env: { TOKEN: 'private-not-public' },
        headers: { Authorization: 'private-not-public' },
      },
      privateMetadata: 'private-not-public',
    },
  ],
  privateMetadata: 'private-not-public',
};
const save = {
  action: 'save',
  expectedRevision: 2,
  name: 'Synthetic MCP',
  description: '',
  projectIds: ['project'],
  connection: { transport: 'stdio', command: '/synthetic/mcp', args: [] },
};
test('private MCP IPC validates all transports and projects and never returns credential values', () => {
  assert.deepEqual(validateAction(save), save);
  for (const transport of ['http', 'sse']) {
    const action = {
      ...save,
      connection: {
        transport,
        url: 'https://synthetic.invalid/mcp',
        headers: { Authorization: 'Bearer synthetic-secret' },
      },
    };
    assert.deepEqual(validateAction(action), action);
    const projected = publicState({
      ...state,
      presets: [
        {
          ...state.presets[0],
          connection: { ...action.connection, headerNames: ['Authorization'] },
        },
      ],
    });
    assert.equal(JSON.stringify(projected).includes('synthetic-secret'), false);
    assert.deepEqual(projected.presets[0].connection.headerNames, ['Authorization']);
  }
  const received = publicState(state);
  assert.equal(JSON.stringify(received).includes('private-not-public'), false);
  assert.equal(received.presets[0].connection.command, '/synthetic/mcp');
  for (const action of [
    { action: 'read', connection: save.connection },
    { ...save, expectedRevision: -1 },
    { ...save, projectIds: [] },
    { ...save, projectIds: ['project', 'project'] },
    { ...save, enabled: 'true' },
    { ...save, name: '   ' },
    { ...save, connection: { ...save.connection, command: 'relative' } },
    { ...save, connection: { ...save.connection, shell: true } },
    { ...save, connection: { ...save.connection, env: { TOKEN: 1 } } },
    { ...save, connection: { ...save.connection, args: ['\0'] } },
    { ...save, connection: { ...save.connection, args: Array(17).fill('x'.repeat(4096)) } },
    ...[
      'http://external.invalid/mcp',
      'https://user:secret@synthetic.invalid/mcp',
      'https://synthetic.invalid/?token=secret',
      'https://synthetic.invalid/#secret',
      'file:///private',
    ].map((url) => ({ ...save, connection: { transport: 'http', url } })),
    ...[
      { Host: 'other' },
      { Authorization: 'secret\r\nHost: other' },
      { Authorization: 'one', authorization: 'two' },
    ].map((headers) => ({
      ...save,
      connection: { transport: 'sse', url: 'https://synthetic.invalid/mcp', headers },
    })),
    { action: 'check', expectedRevision: 2, id: 'preset' },
    { action: 'enabled', expectedRevision: 2, id: 'preset', enabled: 'yes' },
  ])
    assert.throws(
      () => validateAction(action),
      (error: Error) => !error.message.includes('secret'),
    );
  for (const malformed of [
    { ...state, revision: -1 },
    { ...state, projects: [state.projects[0], state.projects[0]] },
    { ...state, presets: [state.presets[0], state.presets[0]] },
    { ...state, presets: [{ ...state.presets[0], versionId: 'moor_tasks' }] },
    { ...state, presets: [{ ...state.presets[0], projectIds: [] }] },
    {
      ...state,
      presets: [
        {
          ...state.presets[0],
          connection: { ...state.presets[0].connection, envNames: ['bad name'] },
        },
      ],
    },
  ])
    assert.throws(() => publicState(malformed));
});

test('MCP replies are bound to the exact child and current settings frame and uncertain writes never retry', async () => {
  const f = transport();
  const reading = f.bridge.request({ action: 'read' }, () => f.current),
    request = f.sent[0];
  f.bridge.receive(
    {},
    { type: 'mcp-config-result', requestId: request.requestId, ok: true, state },
  );
  assert.equal(f.timers.size, 1);
  f.bridge.receive(f.child, {
    type: 'mcp-config-result',
    requestId: request.requestId,
    ok: true,
    state,
  });
  assert.equal(JSON.stringify(await reading).includes('private-not-public'), false);
  const changed = f.bridge.request({ action: 'read' }, () => f.current),
    changedError = assert.rejects(changed, /窗口已变化/);
  f.current = false;
  f.bridge.receive(f.child, {
    type: 'mcp-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state,
  });
  await changedError;
  f.current = true;
  const old = f.child,
    pending = f.bridge.request(save, () => true),
    restarted = assert.rejects(pending, /已重启/);
  f.child = {
    connected: true,
    send(message: any) {
      f.sent.push(message);
    },
  };
  f.bridge.receive(old, {
    type: 'mcp-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state,
  });
  assert.equal(f.timers.size, 1);
  f.bridge.disconnect(old);
  await restarted;
  const uncertain = f.bridge.request(
      { action: 'remove', id: 'preset', expectedRevision: 2 },
      () => true,
    ),
    lost = assert.rejects(uncertain, /不会自动重试/),
    count = f.sent.length;
  [...f.timers.values()][0]();
  await lost;
  assert.equal(f.sent.length, count);
  const failed = f.bridge.request(save, () => true),
    hidden = assert.rejects(failed, (error: Error) => !error.message.includes('secret'));
  f.bridge.receive(f.child, {
    type: 'mcp-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: false,
    error: 'private-secret',
  });
  await hidden;
  const invalid = f.bridge.request({ action: 'read' }, () => true),
    rejected = assert.rejects(invalid, /不可验证/);
  f.bridge.receive(f.child, {
    type: 'mcp-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state: { ...state, revision: 'bad' },
  });
  await rejected;
  const closing = f.bridge.request({ action: 'read' }, () => f.current),
    closed = assert.rejects(closing, /已关闭/);
  f.current = false;
  f.bridge.invalidate();
  await closed;
  f.current = true;
  const exiting = f.bridge.request({ action: 'read' }, () => true),
    exited = assert.rejects(exiting, /已退出/);
  f.bridge.close();
  await exited;
  assert.equal(f.timers.size, 0);
  await assert.rejects(
    f.bridge.request(save, () => true),
    /暂不可用/,
  );
});

test('MCP send failures and pending limits do not retain requests or replay their private payload', async () => {
  const f = transport();
  f.child = {
    connected: true,
    send() {
      throw new Error('synthetic-secret');
    },
  };
  await assert.rejects(
    f.bridge.request(save, () => true),
    (error: Error) => /未能送达/.test(error.message) && !error.message.includes('secret'),
  );
  assert.equal(f.timers.size, 0);
  f.child = {
    connected: true,
    send(value: any) {
      f.sent.push(value);
    },
  };
  const pending = Array.from({ length: 8 }, () =>
    assert.rejects(
      f.bridge.request({ action: 'read' }, () => true),
      /已退出/,
    ),
  );
  await assert.rejects(
    f.bridge.request(save, () => true),
    /暂不可用/,
  );
  assert.equal(f.sent.length, 8);
  f.bridge.close();
  await Promise.all(pending);
  assert.equal(f.timers.size, 0);
});

test('actual MCP HTML and preload save private settings with explicit keep, replace and clear and never connect', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moor-desktop-mcp-'))),
    projectRoot = join(directory, 'project'),
    command = join(directory, 'synthetic-mcp'),
    marker = join(directory, 'must-not-execute');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(projectRoot);
  await writeFile(command, '#!/bin/sh\nprintf synthetic > ' + marker + '\n', { mode: 0o700 });
  const store = new RuntimeStore(join(directory, 'runtime.sqlite'));
  t.after(() => store.close());
  const project = store.registerProject(projectRoot),
    settings = new McpSettings(store),
    f = transport();
  const dom = new JSDOM(await readFile(resolve('src/desktop/settings.html'), 'utf8'), {
    runScripts: 'outside-only',
    url: pathToFileURL(resolve('src/desktop/settings.html')).href,
  });
  t.after(() => dom.window.close());
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
              type: 'mcp-config-result',
              requestId: message.requestId,
              ok: true,
              state,
            });
          if (hold) replies.push(reply);
          else reply();
        },
        () =>
          f.bridge.receive(f.child, {
            type: 'mcp-config-result',
            requestId: message.requestId,
            ok: false,
            error: 'private-error-secret',
          }),
      );
    },
  };
  const exposed = new Map<string, any>(),
    health = {
      host: { state: 'ready', message: 'Ready' },
      local: { state: 'ready', message: 'Ready' },
      relay: { state: 'unpaired', message: 'Local' },
      recovering: false,
    };
  runInNewContext(await readFile(resolve('src/desktop/preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (name: string, value: any) => exposed.set(name, value) },
      ipcRenderer: {
        invoke(name: string, value: unknown) {
          if (name === 'personal:mcp-config') return f.bridge.request(value, () => !closed);
          if (name === 'personal:mcp-executable') return Promise.resolve(command);
          if (name === 'personal:health') return Promise.resolve(health);
          if (name === 'personal:settings')
            return Promise.resolve({
              name: 'Synthetic',
              server: '',
              projects: [],
              agents: [],
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
  const change = (id: string, value: string) => {
    element(id).value = value;
    element(id).dispatchEvent(new dom.window.Event('change'));
  };
  const scope = {
    workspaceId: store.workspace.id,
    userId: store.workspace.userId,
    machineId: store.workspace.machineId,
    localProjectId: project,
    sessionId: 'synthetic-session',
  };
  assert.equal(f.sent.length, 0);
  await click('mcp-refresh');
  await click('mcp-choose');
  element('mcp-name').value = '<img src=x onerror=alert(1)>';
  element('mcp-description').value = 'Synthetic description';
  element('mcp-args').value = '["--synthetic", "$(do-not-execute)"]';
  await click('mcp-save');
  assert.match(element('mcp-status').textContent!, /至少选择一个/);
  const projectInput = element('mcp-projects').querySelector('input')!;
  projectInput.checked = true;
  change('mcp-private-mode', 'replace');
  element('mcp-private').value = '{"TOKEN":"synthetic-env-secret"}';
  await click('mcp-save');
  const original = settings.read().presets[0];
  assert.equal(original.enabled, false);
  assert.equal(element('mcp-preset').value, original.id);
  assert.equal(element('mcp-private').value, '');
  assert.equal(dom.window.document.querySelector('#mcp-settings img'), null);
  assert.ok(!dom.window.document.body.textContent?.includes('synthetic-env-secret'));
  assert.match(element('mcp-private-names').textContent!, /TOKEN/);
  assert.deepEqual(settings.catalog(scope), []);
  await click('mcp-toggle');
  assert.equal(settings.read().presets[0].enabled, true);
  element('mcp-description').value = 'Updated description';
  await click('mcp-save');
  const kept = settings.read().presets[0];
  assert.notEqual(kept.versionId, original.versionId);
  assert.equal(Object.hasOwn(f.sent.at(-1).action.connection, 'env'), false);
  assert.deepEqual((settings.authorize(scope, [kept.versionId]).servers[0] as any).env, [
    { name: 'TOKEN', value: 'synthetic-env-secret' },
  ]);
  change('mcp-private-mode', 'clear');
  assert.match(element('mcp-private-help').textContent!, /清空/);
  await click('mcp-save');
  assert.deepEqual(
    (settings.authorize(scope, [settings.read().presets[0].versionId]).servers[0] as any).env,
    [],
  );
  change('mcp-transport', 'http');
  assert.equal(element('mcp-network-fields').hidden, false);
  assert.equal(element('mcp-stdio-fields').hidden, true);
  element('mcp-url').value = 'https://synthetic.invalid/private-mcp';
  change('mcp-private-mode', 'replace');
  element('mcp-private').value = '{"Authorization":"Bearer synthetic-header-secret"}';
  await click('mcp-save');
  assert.equal(element('mcp-private').value, '');
  assert.match(element('mcp-private-names').textContent!, /Authorization/);
  assert.equal(JSON.stringify(settings.read()).includes('synthetic-header-secret'), false);
  element('mcp-description').value = 'HTTP preserves credentials';
  await click('mcp-save');
  assert.equal(Object.hasOwn(f.sent.at(-1).action.connection, 'headers'), false);
  assert.deepEqual(
    (settings.authorize(scope, [settings.read().presets[0].versionId]).servers[0] as any).headers,
    [{ name: 'Authorization', value: 'Bearer synthetic-header-secret' }],
  );
  change('mcp-transport', 'sse');
  assert.match(element('mcp-private-help').textContent!, /不会继承/);
  element('mcp-url').value = 'http://127.0.0.1:43210/mcp';
  await click('mcp-save');
  const sse = settings.authorize(scope, [settings.read().presets[0].versionId]).servers[0] as any;
  assert.equal(sse.type, 'sse');
  assert.deepEqual(sse.headers, []);
  change('mcp-private-mode', 'replace');
  element('mcp-private').value = '{"TOKEN":"synthetic-malformed-secret"';
  const count = f.sent.length;
  await click('mcp-save');
  assert.equal(f.sent.length, count);
  assert.match(element('mcp-status').textContent!, /有效的 JSON/);
  assert.equal(element('mcp-status').textContent!.includes('synthetic-malformed-secret'), false);
  await click('mcp-refresh');
  await settings.handle({
    action: 'enabled',
    id: original.id,
    expectedRevision: settings.read().revision,
    enabled: false,
  });
  await click('mcp-toggle');
  assert.equal(element('mcp-controls').disabled, true);
  assert.match(element('mcp-status').textContent!, /不会自动重试/);
  assert.equal(element('mcp-status').textContent!.includes('private-error-secret'), false);
  await click('mcp-refresh');
  await click('mcp-remove');
  assert.equal(settings.read().presets.length, 0);
  assert.equal(existsSync(marker), false);
  hold = true;
  const reading = click('mcp-refresh');
  await Promise.resolve();
  closed = true;
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
  replies.forEach((reply) => reply());
  await reading;
  assert.match(element('mcp-status').textContent!, /正在处理/);
  assert.equal(element('mcp-private').value, '');
  f.bridge.close();
  assert.equal(f.timers.size, 0);
});
