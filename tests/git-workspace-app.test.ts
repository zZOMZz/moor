import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire as createPackageRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { Flock, LoroDoc, decode, delta, encode, metas, mirror, putMeta } from '../src/model';
import { syntheticCapabilities } from './support/agent-capabilities';
import { createHash } from 'node:crypto';
import {
  parseNotificationNavigation,
  resolveNotificationNavigation,
} from '../src/web/notification-navigation';

// Exercise the real controller and React UI. Only storage and transport are
// synthetic; deferred responses reproduce ordering races without elapsed time.
test('actual Git app restores prepared new drafts, retries original operations and sends the first prompt only after confirmation', async () => {
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
    'location',
    'history',
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
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.assign(win, {
    matchMedia: globalThis.matchMedia,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  });
  class SyntheticSocket {
    static OPEN = 1;
    static instances: SyntheticSocket[] = [];
    readyState = 0;
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: () => void;
    constructor() {
      SyntheticSocket.instances.push(this);
    }
    send() {}
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
  }
  Object.assign(globalThis, { WebSocket: SyntheticSocket });
  const owner = 'synthetic-owner';
  const runtime = {
    id: 'runtime',
    name: 'Synthetic runtime',
    userId: 'synthetic-user',
    machineId: 'machine',
    projects: [{ id: 'local-project', name: 'Synthetic project', rootPath: '/synthetic' }],
    agents: [
      {
        id: 'agent',
        name: 'Synthetic agent',
        cliType: 'builtin',
        agentType: 'codex',
        runConfig: syntheticCapabilities,
      },
    ],
    features: ['session-actions', 'git-worktree-v1'],
  };
  const device = { id: 'device', name: 'Synthetic Mac', online: true, workspaces: [runtime] };
  const space = {
    id: 'catalog',
    name: 'Synthetic workspace',
    hosts: [
      {
        id: 'host',
        deviceId: device.id,
        machineId: runtime.machineId,
        runtimeWorkspaceId: runtime.id,
        name: device.name,
        online: true,
        agents: runtime.agents,
      },
    ],
    projects: [{ id: 'project', name: 'Synthetic project', source: { kind: 'local' } }],
    replicas: [
      {
        id: 'replica',
        projectId: 'project',
        hostId: 'host',
        localProjectId: 'local-project',
        rootPath: '/synthetic',
        available: true,
      },
    ],
  };
  runtime.projects.push({
    id: 'second-local-project',
    name: 'Second project',
    rootPath: '/synthetic-second',
  });
  space.projects.push({ id: 'second-project', name: 'Second project', source: { kind: 'local' } });
  space.replicas.push({
    id: 'second-replica',
    projectId: 'second-project',
    hostId: 'host',
    localProjectId: 'second-local-project',
    rootPath: '/synthetic-second',
    available: true,
  });
  const sessionId = 'session';
  const hostMeta = new Flock(),
    hostDoc = new LoroDoc(),
    view = mirror(hostDoc, sessionId);
  view.setState(
    (state) =>
      void state.history.push({
        id: 'seed-turn',
        role: 'user',
        userId: runtime.userId,
        userTurnId: undefined,
        inputConfig: undefined,
        timestamp: '2026-01-01T00:00:00Z',
        finished: true,
        read: true,
        status: 'handled',
        items: [{ type: 'text', text: 'Synthetic history' }],
        fileDiff: null,
      }),
  );
  view.setState(
    (state: any) =>
      void state.history.push({
        id: 'assistant-turn',
        role: 'assistant',
        userId: runtime.userId,
        userTurnId: 'seed-turn',
        inputConfig: undefined,
        timestamp: '2026-01-01T00:00:01Z',
        finished: true,
        read: true,
        status: 'handled',
        items: [
          { type: 'text', text: 'Synthetic needle response' },
          {
            type: 'tool_call',
            id: 'tool-call',
            title: 'Inspect',
            status: 'completed',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'tool needle <img src=x onerror=bad>' },
              },
            ],
          },
        ],
        fileDiff: null,
      }),
  );
  view.dispose();
  hostDoc.commit();
  putMeta(hostMeta, 'session-' + sessionId, {
    id: sessionId,
    title: 'Original title',
    machineId: runtime.machineId,
    userId: runtime.userId,
    project: { kind: 'local', localProjectId: 'local-project' },
    cliType: 'builtin',
    agentType: 'codex',
    agentConfigId: 'agent',
    metadataRevision: 0,
    isArchived: false,
    isPinned: false,
    status: { type: 'idle' },
    latestUserMsgId: 'seed-turn',
    lastHandledUserMsgId: 'seed-turn',
    lastMessageAt: 1,
  });
  const currentMeta = () => metas(hostMeta)['session-' + sessionId];
  const cacheKey = [owner, device.id, runtime.id, sessionId].join('/');
  const draft = 'Unsent synthetic draft survives archiving';
  const storage = new Map<string, unknown>([
    [
      owner + '/view',
      {
        deviceId: device.id,
        workspaceId: runtime.id,
        catalogWorkspaceId: space.id,
        replicaId: 'replica',
        sessionId,
      },
    ],
    [cacheKey + '/draft', draft],
  ]);
  Object.assign(globalThis, { __moorAppCache: storage });
  storage.set(cacheKey + '/session', {
    snapshot: encode(hostDoc.export({ mode: 'snapshot' })),
    metaBundle: hostMeta.exportJson(),
    meta: currentMeta(),
  });
  const executions = new Map<string, any>(),
    documents = new Map([[sessionId, hostDoc]]),
    metadata = new Map([[sessionId, currentMeta()]]),
    metadataStores = new Map([[sessionId, hostMeta]]);
  const requests: { path: string; body: any }[] = [];
  let loseAction = true,
    dirty = false,
    online = true;
  const oid = 'a'.repeat(40),
    version = 'sha256:' + 'b'.repeat(64);
  const gitState = (body: any) => ({
    gitVersion: 1,
    workspaceId: body.workspaceId,
    localProjectId: body.localProjectId,
    sessionId: body.sessionId,
    confirmed: true,
    execution: executions.get(body.sessionId) || { mode: 'shared', status: 'ready', revision: 0 },
    canPrepare: !metadata.has(body.sessionId) && !executions.has(body.sessionId),
    canRemove: executions.get(body.sessionId)?.status === 'ready' && !dirty,
    repository: {
      kind: 'git',
      branch: executions.get(body.sessionId)?.branch || 'main',
      headOid: oid,
      branches: [{ name: 'main', oid }],
      changes: dirty
        ? [{ path: 'unsafe <img src=x onerror=bad>.txt', index: ' ', worktree: 'M' }]
        : [],
      dirty,
      partial: body.sessionId === sessionId,
      outsideProjectChanges: false,
      version,
      issues: [],
      writeSupported: true,
    },
  });
  Object.assign(globalThis, {
    __moorNotificationLocal: { version: 1, revision: 0, records: [] },
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, win.location.href),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, body });
      let result: any;
      if (url.pathname === '/api/devices') result = [{ ...device, online }];
      else if (url.pathname === '/api/workspaces') result = [space];
      else if (url.pathname.endsWith('/hosts/host/sessions')) result = [...metadata.values()];
      else if (url.pathname.includes('/sessions/')) {
        const id = url.pathname.split('/').at(-1)!;
        assert.ok(documents.has(id));
        result = {
          meta: metadata.get(id),
          metaBundle: metadataStores.get(id)!.exportJson(),
          update: delta(documents.get(id)!),
          online: true,
          synced: true,
          persisted: true,
        };
      } else if (url.pathname.endsWith('/git/state')) result = gitState(body);
      else if (url.pathname.endsWith('/git/action')) {
        const stored = [...storage.values()].find(
          (value: any) => value?.pending?.request?.operationId === body.operationId,
        ) as any;
        assert.ok(stored);
        assert.deepEqual(stored.pending.request, body);
        if (body.action === 'prepare')
          executions.set(body.sessionId, {
            mode: 'worktree',
            status: 'ready',
            revision: 1,
            executionId: 'execution-' + body.sessionId,
            branch: body.newBranch,
            baseOid: body.expectedOid,
          });
        else
          executions.set(body.sessionId, {
            ...executions.get(body.sessionId),
            status: 'removed',
            revision: 2,
          });
        if (loseAction) throw new Error('Synthetic lost Git receipt');
        result = {
          gitVersion: 1,
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          operationId: body.operationId,
          phase: 'accepted',
          confirmed: true,
          execution: executions.get(body.sessionId),
        };
      } else if (url.pathname.endsWith('/mutations')) {
        assert.equal(executions.get(body.sessionId)?.status, 'ready');
        const store = metadataStores.get(body.sessionId) || new Flock();
        store.importJson(body.metaBundle);
        metadataStores.set(body.sessionId, store);
        metadata.set(body.sessionId, metas(store)['session-' + body.sessionId]);
        const document = documents.get(body.sessionId) || new LoroDoc();
        document.import(decode(body.update));
        documents.set(body.sessionId, document);
        result = { accepted: true, delivered: true, operationId: body.operationId };
      } else assert.fail('Unexpected Git app request ' + url.pathname);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/git-workspace-app-')),
    outfile = join(directory, 'app.mjs');
  await build({
    entryPoints: ['src/web/app.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['loro-crdt', 'react', 'react-dom', 'react-dom/client'],
    banner: {
      js: "import { createRequire as createPackageRequire } from 'node:module';const require=createPackageRequire(import.meta.url);",
    },
    plugins: [
      {
        name: 'synthetic-git-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/cache$/ }, () => ({
            path: 'cache',
            namespace: 'synthetic',
          }));
          builder.onResolve({ filter: /^\.\/notification-storage$/ }, () => ({
            path: 'notification-storage',
            namespace: 'synthetic',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, (args) => ({
            loader: 'js',
            contents:
              args.path === 'cache'
                ? 'export const read=async key=>structuredClone(globalThis.__moorAppCache.get(key));export const write=async(key,value)=>{globalThis.__moorAppCache.set(key,structuredClone(value));};export const compareText=async(key,expected,value,current,signal)=>{if(signal?.aborted||!current())throw new Error("stale draft");const cache=globalThis.__moorAppCache;if(cache.get(key)!==expected)return false;cache.set(key,value);return true;}; export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const compareDraftBundle=async()=>{throw new Error("unexpected role draft application");}; export const clear=async()=>globalThis.__moorAppCache.clear();'
                : 'export const notificationLocal=async update=>{if(update)globalThis.__moorNotificationLocal=update(globalThis.__moorNotificationLocal);return structuredClone(globalThis.__moorNotificationLocal);};export const rememberNotification=async()=>{};',
          }));
          builder.onLoad({ filter: /\/src\/web\/app\.ts$/ }, async (args) => ({
            loader: 'ts',
            resolveDir: resolve('src/web'),
            contents:
              (await readFile(args.path, 'utf8'))
                .replace(
                  'void fn().catch(error);',
                  'globalThis.__moorLastOperation = fn().catch(error);',
                )
                .replace(
                  'void loadAttachmentDraft().catch(error);',
                  'globalThis.__moorGitProjectChange = loadAttachmentDraft().catch(error);',
                ) +
              '\nexport {openGitWorkspace,currentGitWorkspace,openSession,sendTurn};export {disposeUI} from "./ui";',
          }));
        },
      },
    ],
  });
  const app = await import(pathToFileURL(outfile).href),
    { act } = await import('react');
  const field = () => document.querySelector<HTMLTextAreaElement>('#prompt')!;
  const button = (label: string) => {
    const element = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === label || button.getAttribute('aria-label') === label,
    );
    assert.ok(element, label);
    return element;
  };
  const click = async (label: string) => {
    await act(() => button(label).click());
    await act(async () => await (globalThis as any).__moorLastOperation);
  };
  const actions = () => requests.filter((request) => request.path.endsWith('/git/action'));
  const mutations = () => requests.filter((request) => request.path.endsWith('/mutations'));
  try {
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    await act(() => SyntheticSocket.instances.at(-1)!.open());
    await act(async () => await (globalThis as any).__moorLastOperation);
    await act(() => app.openGitWorkspace());
    assert.match(document.body.textContent!, /状态未完整读取/);
    assert.equal(document.querySelector('.git-workspace-panel form'), null);
    await click('关闭 Git 与工作目录');
    await act(() => app.openSession(''));
    const stable = app.currentGitWorkspace().target.sessionId;
    const stableKey =
      'attachment-session-v1/' + JSON.stringify([owner, device.id, runtime.id, 'local-project']);
    assert.equal(storage.get(stableKey), stable);
    await act(() => app.openGitWorkspace());
    assert.match(document.body.textContent!, /不包含项目原目录的未提交改动/);
    const select = document.querySelector<HTMLSelectElement>('.git-workspace-panel select')!,
      input = document.querySelector<HTMLInputElement>(
        '.git-workspace-panel input:not([type="checkbox"])',
      )!;
    await act(() => {
      select.value = JSON.stringify(['main', oid]);
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'feature/synthetic',
      );
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    });
    await click('创建独立工作目录');
    assert.equal(actions().length, 1);
    const original = structuredClone(actions()[0]!.body);
    assert.equal(original.sessionId, stable);
    assert.equal(mutations().length, 0);
    assert.equal(document.querySelector<HTMLButtonElement>('#send')!.disabled, true);
    assert.equal(document.querySelector<HTMLButtonElement>('#project')!.disabled, true);
    await click('关闭 Git 与工作目录');
    await act(() => app.openSession(sessionId, 'replica'));
    assert.ok(document.querySelector('[data-search-turn="assistant-turn"]'));
    await act(() => app.openSession(''));
    assert.equal(app.currentGitWorkspace().target.sessionId, stable);
    assert.equal(actions().length, 1);
    assert.ok(app.currentGitWorkspace().pending);
    online = false;
    await act(() => app.boot(Promise.resolve(null), Promise.resolve(owner)));
    assert.equal(app.currentGitWorkspace().target.sessionId, stable);
    assert.equal(actions().length, 1);
    online = true;
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    await act(() => SyntheticSocket.instances.at(-1)!.open());
    await act(async () => await (globalThis as any).__moorLastOperation);
    assert.equal(app.currentGitWorkspace().target.sessionId, stable);
    assert.equal(actions().length, 1);
    loseAction = false;
    await act(() => app.openGitWorkspace());
    await click('重试确认');
    assert.deepEqual(actions()[1]!.body, original);
    assert.equal(app.currentGitWorkspace().pending, undefined);
    await click('关闭 Git 与工作目录');
    const selectProject = async (name: string) => {
      await act(async () => {
        document.querySelector<HTMLButtonElement>('#project')!.click();
      });
      const option = [...document.querySelectorAll<HTMLElement>('[role=option]')].find(
        (option) => option.textContent === name,
      );
      assert.ok(option, name);
      await act(async () => {
        option.click();
        await (globalThis as any).__moorGitProjectChange;
      });
    };
    await selectProject('Second project');
    assert.equal(app.currentGitWorkspace().target.localProjectId, 'second-local-project');
    assert.notEqual(app.currentGitWorkspace().target.sessionId, stable);
    await selectProject('Synthetic project');
    assert.equal(app.currentGitWorkspace().target.sessionId, stable);
    assert.equal(app.currentGitWorkspace().execution.mode, 'worktree');
    assert.equal(actions().length, 2);
    field().value = 'Continue in the prepared directory';
    await act(() => app.sendTurn());
    assert.equal(mutations()[0]!.body.sessionId, stable);
    assert.equal(storage.get(stableKey), undefined);
    assert.ok(document.querySelector('[data-search-turn]'));
    await act(() => app.openSession(''));
    assert.notEqual(app.currentGitWorkspace().target.sessionId, stable);
    await act(() => app.openSession(stable, 'replica'));
    await act(() => app.openGitWorkspace());
    dirty = true;
    await act(() =>
      document
        .querySelector<HTMLInputElement>('.git-workspace-panel input[type="checkbox"]')!
        .click(),
    );
    await click('清理工作目录');
    assert.equal(actions().length, 2);
    assert.match(document.body.textContent!, /不能清理/);
    assert.equal(document.querySelector('.git-workspace-panel img'), null);
    dirty = false;
    await click('重新读取 Git 状态');
    await click('清理工作目录');
    assert.equal(actions().length, 3);
    assert.equal(app.currentGitWorkspace().execution.status, 'removed');
    assert.equal(document.querySelector<HTMLButtonElement>('#send')!.disabled, true);
    assert.ok(document.querySelector('[data-search-turn]'));
    assert.equal(mutations().length, 1);
  } finally {
    await act(() => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
