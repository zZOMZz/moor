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
test('actual Fork app preserves the source, restores unknown requests and opens only a confirmed native child', async () => {
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
    features: ['session-actions', 'git-worktree-v1', 'session-fork-v1'],
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
    canRemove:
      executions.get(body.sessionId)?.status === 'ready' && !dirty && forkPhase === 'rejected',
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
  let forkPhase: 'accepted' | 'unknown' | 'rejected' = 'unknown',
    wrongFork = false;
  const forkCalls = new Map<string, any>();
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
      } else if (url.pathname.endsWith('/fork/options'))
        result = {
          forkVersion: 1,
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          confirmed: true,
          sourceVersion: version,
          execution: { mode: 'shared', status: 'ready', revision: 0 },
          agent: { id: 'agent', name: 'Synthetic Agent', agentType: 'codex' },
          capabilities: { sameDirectory: true, worktree: true, turnCutoff: true },
          currentAvailable: true,
          turns: [
            {
              turnId: 'assistant-turn',
              ordinal: 1,
              timestamp: '2026-01-01T00:00:01Z',
              available: true,
            },
            {
              turnId: 'old-turn',
              ordinal: 2,
              timestamp: '2026-01-01T00:00:02Z',
              available: false,
              reason: 'No native anchor',
            },
          ],
          partial: false,
          repository: gitState(body).repository,
        };
      else if (url.pathname.endsWith('/fork/action')) {
        const stored = [...storage.values()].find(
          (value: any) => value?.operation?.request?.operationId === body.operationId,
        ) as any;
        assert.ok(stored);
        assert.deepEqual(stored.operation.request, body);
        if (forkCalls.has(body.operationId))
          assert.deepEqual(forkCalls.get(body.operationId), body);
        else forkCalls.set(body.operationId, structuredClone(body));
        const execution =
          body.directory.kind === 'worktree'
            ? {
                mode: 'worktree',
                status: 'ready',
                revision: 1,
                executionId: 'execution-' + body.childSessionId,
                branch: body.directory.newBranch,
                baseOid: body.directory.expectedOid,
              }
            : { mode: 'shared', status: 'ready', revision: 0 };
        executions.set(body.childSessionId, execution);
        const origin = {
          version: 1,
          sourceSessionId: body.sessionId,
          sourceVersion: body.expectedSourceVersion,
          sourceTitle: 'Source <img src=x onerror=bad>',
          cutoff: body.cutoff,
          directory: body.directory.kind,
          ...(body.directory.kind === 'worktree'
            ? { branch: body.directory.newBranch, baseOid: body.directory.expectedOid }
            : {}),
          createdAt: '2026-09-12T00:00:00Z',
        };
        if (forkPhase === 'accepted') {
          const childDoc = new LoroDoc(),
            childMeta = new Flock();
          putMeta(childMeta, 'session-' + body.childSessionId, {
            ...currentMeta(),
            id: body.childSessionId,
            title: 'Fork child',
            forkOrigin: origin,
            status: { type: 'idle' },
            latestUserMsgId: null,
            lastHandledUserMsgId: null,
          });
          metadataStores.set(body.childSessionId, childMeta);
          metadata.set(body.childSessionId, metas(childMeta)['session-' + body.childSessionId]);
          documents.set(body.childSessionId, childDoc);
        }
        result = {
          forkVersion: 1,
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          operationId: body.operationId,
          childSessionId: body.childSessionId,
          phase: forkPhase,
          confirmed: forkPhase === 'accepted',
          execution,
          origin: wrongFork ? { ...origin, sourceSessionId: 'wrong-source' } : origin,
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
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/fork-app-')),
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
                ? 'export const read=async key=>structuredClone(globalThis.__moorAppCache.get(key));export const write=async(key,value)=>{globalThis.__moorAppCache.set(key,structuredClone(value));};export const compareText=async(key,expected,value,current,signal)=>{if(signal?.aborted||!current())throw new Error("stale draft");const cache=globalThis.__moorAppCache;if(cache.get(key)!==expected)return false;cache.set(key,value);return true;}; export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const clear=async()=>globalThis.__moorAppCache.clear();'
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
              '\nexport {openSessionFork,currentSessionFork,openSession,sendTurn,addAttachments,currentAttachments};export {disposeUI} from "./ui";',
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
    await act(async () => {
      button(label).click();
      await (globalThis as any).__moorLastOperation;
    });
  };
  const actions = () => requests.filter((request) => request.path.endsWith('/fork/action'));
  const mutations = () => requests.filter((request) => request.path.endsWith('/mutations'));
  const stableKey =
    'attachment-session-v1/' + JSON.stringify([owner, device.id, runtime.id, 'local-project']);
  storage.set(stableKey, 'independent-unsent-new-draft');
  const setSelect = async (index: number, value: string) =>
    act(() => {
      const select = document.querySelectorAll<HTMLSelectElement>('.session-fork-panel select')[
        index
      ]!;
      select.value = value;
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
  try {
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    await act(() => SyntheticSocket.instances.at(-1)!.open());
    await act(async () => await (globalThis as any).__moorLastOperation);
    const attachmentBytes = new TextEncoder().encode('Unsent source attachment');
    await act(() =>
      app.addAttachments([
        {
          name: 'source-draft.txt',
          type: 'text/plain',
          size: attachmentBytes.length,
          arrayBuffer: async () => attachmentBytes.buffer,
        },
      ]),
    );
    const attachmentsBefore = structuredClone(app.currentAttachments().items);
    await click('从此回合创建副本');
    assert.equal(
      document.querySelector<HTMLSelectElement>('.session-fork-panel select')!.value,
      'turn:assistant-turn',
    );
    assert.equal(
      document.querySelector<HTMLOptionElement>('option[value="turn:old-turn"]')!.disabled,
      true,
    );
    await setSelect(1, 'worktree');
    await setSelect(2, JSON.stringify(['main', oid]));
    await act(() => {
      const input = document.querySelector<HTMLInputElement>('.session-fork-panel input')!;
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'feature/synthetic-fork',
      );
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    });
    await click('创建原生会话副本');
    assert.equal(actions().length, 1);
    const original = structuredClone(actions()[0]!.body);
    assert.equal(original.sessionId, sessionId);
    assert.notEqual(original.childSessionId, sessionId);
    assert.notEqual(original.childSessionId, storage.get(stableKey));
    assert.deepEqual(original.cutoff, { kind: 'turn', turnId: 'assistant-turn' });
    assert.equal(app.currentSessionFork().target.sessionId, sessionId);
    assert.equal(field().value, draft);
    assert.equal(storage.get(stableKey), 'independent-unsent-new-draft');
    assert.equal(mutations().length, 0);
    assert.equal(document.querySelector<HTMLButtonElement>('#send')!.disabled, true);
    await click('查看本次分叉的工作目录');
    assert.equal(
      requests.findLast((request) => request.path.endsWith('/git/state'))!.body.sessionId,
      original.childSessionId,
    );
    assert.equal(
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent === '清理工作目录',
      ),
      false,
    );
    await click('关闭 Git 与工作目录');
    await click('关闭会话副本');
    await act(() => app.openSession(''));
    assert.equal(actions().length, 1);
    assert.equal(storage.get(stableKey), 'independent-unsent-new-draft');
    await act(() => app.openSession(sessionId, 'replica'));
    assert.deepEqual(app.currentSessionFork().pending.request, original);
    assert.equal(field().value, draft);
    online = false;
    await act(() => app.boot(Promise.resolve(null), Promise.resolve(owner)));
    await act(() => app.openSessionFork());
    assert.equal(actions().length, 1);
    assert.match(document.body.textContent!, /离线/);
    online = true;
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    await act(() => SyntheticSocket.instances.at(-1)!.open());
    await act(async () => await (globalThis as any).__moorLastOperation);
    await act(() => app.openSessionFork());
    forkPhase = 'accepted';
    wrongFork = true;
    await click('重试确认 Fork');
    assert.equal(app.currentSessionFork().target.sessionId, sessionId);
    assert.ok(app.currentSessionFork().pending);
    assert.equal(field().value, draft);
    wrongFork = false;
    await click('重试确认 Fork');
    assert.equal(actions().length, 3);
    for (const action of actions()) assert.deepEqual(action.body, original);
    assert.equal(forkCalls.size, 1);
    assert.equal(app.currentSessionFork().target.sessionId, original.childSessionId);
    assert.equal(document.querySelector('[data-search-turn="assistant-turn"]'), null);
    assert.match(
      document.querySelector('.fork-origin')!.textContent!,
      /Source <img src=x onerror=bad>/,
    );
    assert.equal(document.querySelector('.fork-origin img'), null);
    assert.equal(field().value, '');
    assert.equal(storage.get(cacheKey + '/draft'), draft);
    assert.equal(storage.get(stableKey), 'independent-unsent-new-draft');
    await click('查看来源与截止点');
    assert.equal(app.currentSessionFork().target.sessionId, sessionId);
    assert.ok(document.querySelector('[data-search-turn="assistant-turn"].search-located'));
    assert.equal(field().value, draft);
    assert.deepEqual(app.currentAttachments().items, attachmentsBefore);
    assert.equal(mutations().length, 0);
  } finally {
    await act(() => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
