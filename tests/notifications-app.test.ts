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
test('actual notification navigation re-reads immutable scope, never mutates and cancels native attachment saves on target changes', async () => {
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
    features: ['session-actions', 'project-tree-v1', 'project-diff-v1', 'session-search-v1'],
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
  let identityOwner = owner,
    localIdentity = false,
    hostOnline = true,
    deferIdentity = false;
  let identityStarted: (() => void) | undefined, releaseIdentity: (() => void) | undefined;
  const requests: { path: string; body: any }[] = [],
    saveRequests: any[] = [];
  let cancellations = 0,
    rejectSave: ((error: Error) => void) | undefined;
  Object.assign(win, {
    moorDesktop: {
      version: 1,
      cancelAttachmentSave: async () => {
        cancellations++;
      },
      saveAttachment: (value: unknown) => {
        saveRequests.push(value);
        return new Promise((_, reject) => {
          rejectSave = reject;
        });
      },
    },
  });
  Object.defineProperty(win.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value() {},
  });
  Object.assign(globalThis, {
    __moorNotificationLocal: { version: 1, revision: 0, records: [] },
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, win.location.href),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, body });
      let result: unknown;
      if (url.pathname === '/api/me') {
        if (deferIdentity) {
          deferIdentity = false;
          await new Promise<void>((resolve) => {
            releaseIdentity = resolve;
            identityStarted?.();
          });
        }
        result = { owner: identityOwner, needsSetup: false, localOnly: localIdentity };
      } else if (url.pathname === '/api/devices') result = [{ ...device, online: hostOnline }];
      else if (url.pathname === '/api/workspaces') result = [space];
      else if (url.pathname.endsWith('/hosts/host/sessions')) result = [currentMeta()];
      else if (url.pathname.endsWith('/sessions/' + sessionId))
        result = {
          meta: currentMeta(),
          metaBundle: hostMeta.exportJson(),
          update: delta(hostDoc),
          online: true,
          synced: true,
          persisted: true,
        };
      else if (url.pathname === '/api/notifications')
        result = { configured: false, reason: 'Synthetic: not configured', subscriptions: [] };
      else assert.fail('Unexpected request ' + url.pathname);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/notifications-app-')),
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
        name: 'synthetic-notification-boundaries',
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
              (await readFile(args.path, 'utf8')).replace(
                'void fn().catch(error);',
                'globalThis.__moorLastOperation = fn().catch(error);',
              ) +
              '\nexport {openNotificationQuery,openNotifications,previewAttachment,openSession,resetWorkspace};export {disposeUI} from "./ui";',
          }));
        },
      },
    ],
  });
  const app = await import(pathToFileURL(outfile).href),
    { act } = await import('react');
  const field = () => document.querySelector<HTMLTextAreaElement>('#prompt')!;
  const notification = {
    notificationVersion: 1,
    eventId: 'notification_' + 'a'.repeat(64),
    kind: 'completed',
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 60000,
    userId: runtime.userId,
    machineId: runtime.machineId,
    workspaceId: runtime.id,
    localProjectId: 'local-project',
    sessionId,
    turnId: 'assistant-turn',
    owner,
    deviceId: device.id,
    catalogWorkspaceId: 'old-catalog',
    replicaId: 'old-replica',
  };
  const query = (value: unknown) =>
    win.history.replaceState(
      null,
      '',
      '/?notification=' + encodeURIComponent(JSON.stringify(value)),
    );
  const open = async (value: unknown) => {
    query(value);
    await act(() => app.openNotificationQuery());
  };
  try {
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    query(notification);
    await act(() => app.openNotificationQuery());
    assert.equal(win.location.search, '');
    assert.ok(document.querySelector('[data-search-turn="assistant-turn"].search-located'));
    assert.equal(field().value, draft);
    assert.equal(storage.get(cacheKey + '/draft'), draft);
    const reads = requests.map((request) => request.path);
    assert.ok(reads.includes('/api/me'));
    assert.ok(reads.includes('/api/workspaces'));
    assert.ok(reads.some((path) => path.includes('/replicas/replica/sessions/')));
    assert.equal(requests.filter((request) => request.body).length, 0);
    await open({ ...notification, owner: 'other' });
    assert.match(document.body.textContent!, /其他账号/);
    await open({ ...notification, expiresAt: Date.now() - 1 });
    assert.match(document.body.textContent!, /过期/);
    await open({ ...notification, deviceId: 'removed-device' });
    assert.match(document.body.textContent!, /移除|映射/);
    const native = { ...notification } as any;
    for (const key of ['owner', 'deviceId', 'catalogWorkspaceId', 'replicaId']) delete native[key];
    await open(native);
    assert.match(document.body.textContent!, /来源无效/);
    localIdentity = true;
    await open(native);
    assert.ok(document.querySelector('[data-search-turn="assistant-turn"].search-located'));
    localIdentity = false;
    hostOnline = false;
    await open(notification);
    assert.match(document.body.textContent!, /本机缓存/);
    hostOnline = true;
    await open(notification);
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    identityStarted = started;
    deferIdentity = true;
    query(notification);
    await act(async () => {
      const opening = app.openNotificationQuery();
      await began;
      await app.openSession('');
      releaseIdentity!();
      await opening;
    });
    assert.equal(document.querySelector('[data-search-turn="assistant-turn"]'), null);
    assert.equal(win.location.search, '');
    await open(notification);
    const bytes = Buffer.from('Synthetic download'),
      reference = {
        contentVersion: 1,
        attachmentId: 'attachment',
        name: 'result.txt',
        content: {
          version: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
          byteLength: bytes.length,
          mediaType: 'text/plain',
        },
      };
    await act(() => app.previewAttachment(reference, bytes.toString('base64'), 'host'));
    const download = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('下载'),
    )!;
    assert.ok(download);
    await act(() => download.click());
    assert.deepEqual(saveRequests[0], {
      scope: {
        owner,
        deviceId: device.id,
        workspaceId: runtime.id,
        localProjectId: 'local-project',
        sessionId,
      },
      reference,
      data: bytes.toString('base64'),
    });
    const beforeCancel = cancellations;
    await act(() => app.openSession(''));
    assert.ok(cancellations > beforeCancel);
    await act(async () => {
      rejectSave!(new Error('Late save failure from old session'));
      await (globalThis as any).__moorLastOperation;
    });
    assert.equal(document.body.textContent!.includes('Late save failure'), false);
    assert.equal(requests.filter((request) => request.body).length, 0);
    await act(() => app.openNotifications());
    await act(async () => await (globalThis as any).__moorLastOperation);
    assert.match(document.body.textContent!, /通知设置/);
    assert.match(document.body.textContent!, /此浏览器未开启通知/);
    assert.equal(
      requests.some((request) => request.path.endsWith('/subscriptions')),
      false,
    );
  } finally {
    await act(() => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
