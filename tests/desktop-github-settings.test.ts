import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { DesktopGitHubSettings } from '../src/desktop/github-settings.cjs';
import { GitHubConfig } from '../src/runtime/github-config';

function transport() {
  const timers = new Map<number, () => void>(),
    sent: any[] = [];
  let id = 0,
    current = true;
  const first = {
    connected: true,
    send(value: unknown) {
      sent.push(value);
    },
  };
  let child = first;
  const bridge = new DesktopGitHubSettings({
    bridge: () => child,
    schedule(fn: () => void) {
      timers.set(++id, fn);
      return id;
    },
    cancel(timer: unknown) {
      timers.delete(Number(timer));
    },
  });
  return {
    bridge,
    timers,
    sent,
    first,
    get child() {
      return child;
    },
    set child(value: typeof first) {
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
  credentials: [
    {
      id: 'credential',
      label: 'Synthetic account',
      token: 'synthetic_saved_secret',
      status: { state: 'connected', login: 'synthetic-user' },
    },
  ],
  projects: [
    {
      id: 'project',
      name: 'Synthetic project',
      rootPath: '/synthetic/project',
      binding: {
        credentialId: 'credential',
        owner: 'synthetic-owner',
        repo: 'repo',
        repositoryId: 42,
        current: true,
        status: { state: 'connected' },
        token: 'synthetic_saved_secret',
      },
    },
  ],
  token: 'synthetic_saved_secret',
};

test('desktop GitHub control binds replies to the current child and settings frame, strips private fields, and never retries', async () => {
  const f = transport(),
    request = f.bridge.request({ action: 'read' }, () => f.current),
    message = f.sent[0];
  f.bridge.receive({ connected: true } as any, {
    type: 'github-config-result',
    requestId: message.requestId,
    ok: true,
    state,
  });
  assert.equal(f.timers.size, 1);
  f.bridge.receive(f.child, {
    type: 'github-config-result',
    requestId: message.requestId,
    ok: true,
    state,
  });
  const result = await request;
  assert.equal(JSON.stringify(result).includes('synthetic_saved_secret'), false);
  assert.equal(result.projects[0]!.binding!.repositoryId, 42);
  assert.equal(f.timers.size, 0);
  const switched = f.bridge.request({ action: 'read' }, () => f.current),
    switchedRejection = assert.rejects(switched, /窗口已变化/);
  f.current = false;
  f.bridge.receive(f.child, {
    type: 'github-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state,
  });
  await switchedRejection;
  f.current = true;
  const lost = f.bridge.request(
      { action: 'credential-remove', credentialId: 'credential', expectedRevision: 1 },
      () => true,
    ),
    lostRejection = assert.rejects(lost, /未确认/),
    lostMessage = f.sent.at(-1);
  [...f.timers.values()][0]!();
  await lostRejection;
  f.bridge.receive(f.child, {
    type: 'github-config-result',
    requestId: lostMessage.requestId,
    ok: true,
    state,
  });
  assert.equal(f.sent.length, 3);
  assert.equal(f.timers.size, 0);
  const failed = f.bridge.request({ action: 'read' }, () => true),
    failedResult = assert.rejects(
      failed,
      (error: Error) => !error.message.includes('synthetic_saved_secret'),
    );
  f.bridge.receive(f.child, {
    type: 'github-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: false,
    error: 'synthetic_saved_secret /private/path',
  });
  await failedResult;
  const actionable = f.bridge.request({ action: 'read' }, () => true),
    actionableResult = assert.rejects(actionable, /不能位于已登记项目内/);
  f.bridge.receive(f.child, {
    type: 'github-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: false,
    error: 'GitHub 私有数据目录不能位于已登记项目内，请将运行数据迁移到代码目录外',
  });
  await actionableResult;
  const old = f.bridge.request({ action: 'read' }, () => true),
    oldRejection = assert.rejects(old, /已重启/);
  f.bridge.disconnect(f.first);
  await oldRejection;
  f.child = {
    connected: true,
    send(value: unknown) {
      f.sent.push(value);
    },
  };
  f.bridge.receive(f.first, {
    type: 'github-config-result',
    requestId: f.sent.at(-1).requestId,
    ok: true,
    state,
  });
  assert.throws(
    () => f.bridge.request({ action: 'read', token: 'should-not-be-sent' }, () => true),
    /请求无效/,
  );
  const closed = f.bridge.request({ action: 'read' }, () => true),
    closedRejection = assert.rejects(closed, /已退出/);
  f.bridge.close();
  await closedRejection;
  assert.equal(f.timers.size, 0);
});

test('the actual desktop settings UI and preload add, replace, verify and remove private GitHub configuration without echoing tokens', async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'moor-desktop-github-')),
    rootPath = join(data, 'project');
  await mkdir(rootPath);
  t.after(() => rm(data, { recursive: true, force: true }));
  let network = 0;
  const config = new GitHubConfig(join(data, 'private', 'github-v1.json'), {
    identity: { workspaceId: 'workspace', machineId: 'machine', userId: 'local:synthetic' },
    projects: () => [{ id: 'project', name: 'Synthetic project', rootPath }],
    verifier: {
      async getUser() {
        network++;
        return { login: 'synthetic-user' };
      },
      async getRepository(_token, owner, repo) {
        network++;
        return { id: 42, owner, repo };
      },
    },
    now: () => 1000,
  });
  const dom = new JSDOM(await readFile(resolve('src/desktop/settings.html'), 'utf8'), {
    runScripts: 'outside-only',
    url: pathToFileURL(resolve('src/desktop/settings.html')).href,
  });
  t.after(() => dom.window.close());
  const health = {
      host: { state: 'ready', message: 'Synthetic ready' },
      local: { state: 'ready', message: 'Synthetic ready' },
      relay: { state: 'unpaired', message: 'Synthetic unpaired' },
      recovering: false,
    },
    f = transport();
  let closed = false;
  const child = {
    connected: true,
    send(message: any) {
      f.sent.push(message);
      void config.handle(message.action).then(
        (value) =>
          f.bridge.receive(child, {
            type: 'github-config-result',
            requestId: message.requestId,
            ok: true,
            state: value,
          }),
        () =>
          f.bridge.receive(child, {
            type: 'github-config-result',
            requestId: message.requestId,
            ok: false,
          }),
      );
    },
  };
  f.child = child;
  const exposed = new Map<string, unknown>();
  runInNewContext(await readFile(resolve('src/desktop/preload.cjs'), 'utf8'), {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value),
      },
      ipcRenderer: {
        invoke(name: string, value: unknown) {
          if (name === 'personal:github-config') return f.bridge.request(value, () => !closed);
          if (name === 'personal:health') return Promise.resolve(health);
          if (name === 'personal:settings')
            return Promise.resolve({
              name: 'Synthetic',
              server: '',
              projects: [],
              agents: ['codex'],
              health,
            });
          return Promise.reject(new Error('Unexpected synthetic IPC'));
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
  assert.equal(f.sent.length, 0, 'loading the settings window never checks credentials');
  await click('github-refresh');
  element('github-label').value = 'Synthetic account';
  element('github-token').value = 'synthetic_ui_token_1';
  const saving = click('github-credential-save');
  assert.equal(element('github-token').value, '', 'new secret is cleared before awaiting IPC');
  await saving;
  assert.equal(network, 0);
  assert.equal(config.read().credentials.length, 1);
  assert.equal(dom.window.document.body.textContent!.includes('synthetic_ui_token'), false);
  await click('github-credential-check');
  assert.equal(network, 1);
  assert.match(element('github-credential-status').textContent!, /synthetic-user/);
  element('github-owner').value = 'synthetic-owner';
  element('github-repo').value = 'synthetic-repo';
  await click('github-project-bind');
  assert.equal(config.getProject('project').repositoryId, 42);
  assert.match(element('github-project-status').textContent!, /42/);
  element('github-token').value = 'synthetic_ui_token_2';
  await click('github-credential-save');
  assert.equal(element('github-token').value, '');
  assert.throws(() => config.getProject('project'), /尚未验证/);
  await click('github-project-check');
  assert.equal(config.getProject('project').token, 'synthetic_ui_token_2');
  await click('github-credential-remove');
  assert.equal(config.read().credentials.length, 0);
  assert.equal(config.read().projects[0]!.binding, undefined);
  assert.equal(dom.window.document.body.textContent!.includes('synthetic_ui_token'), false);
  closed = true;
  dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
  f.bridge.close();
  assert.equal(f.timers.size, 0);
});
