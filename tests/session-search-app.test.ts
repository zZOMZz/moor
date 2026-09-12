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
import type { ProjectDiffReference, ProjectDiffChange } from '../src/project-content-protocol';

// Exercise the real controller and React UI. Only storage and transport are
// synthetic; deferred responses reproduce ordering races without elapsed time.
test('actual app searches scoped text, navigates frozen results, limits offline caches and rejects late responses', async () => {
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
  const hash = (text: string) => 'sha256:' + createHash('sha256').update(text).digest('hex');
  const reference: ProjectDiffReference = {
    contentVersion: 1,
    basis: 'project-snapshot',
    turnId: 'assistant-turn',
    diffId: 'diff',
    state: 'ready',
    version: hash('frozen diff'),
    changeCount: 1,
  };
  const before = {
    path: 'changed.txt',
    size: 3,
    state: 'text' as const,
    version: hash('old'),
    mediaType: 'text/plain' as const,
  };
  const after = { ...before, version: hash('new') };
  const change: ProjectDiffChange = { path: 'changed.txt', kind: 'modified', before, after };
  const contentScope = {
    contentVersion: 1 as const,
    confirmed: true,
    workspaceId: runtime.id,
    localProjectId: 'local-project',
    sessionId,
  };

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
        fileDiff: reference,
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
  const documents = new Map<string, LoroDoc>([[sessionId, hostDoc]]);
  const siblingMeta = (id: string, title: string) => ({ ...currentMeta(), id, title });
  const second = siblingMeta('second', 'Second synthetic session'),
    foreign = siblingMeta('foreign', 'Foreign cached identity'),
    missing = siblingMeta('missing', 'Uncached session');
  const rows = [currentMeta(), second, foreign, missing];
  const putCached = (id: string, text: string, metadata: any) => {
    const document = new LoroDoc(),
      view = mirror(document, id);
    view.setState((state: any) => {
      state.history.push({
        id: 'other-turn',
        role: 'user',
        userId: runtime.userId,
        timestamp: '2026-01-01T00:00:00Z',
        finished: true,
        read: true,
        status: 'handled',
        items: [{ type: 'text', text }],
        fileDiff: null,
      });
    });
    view.dispose();
    document.commit();
    documents.set(id, document);
    const metadataStore = new Flock();
    putMeta(metadataStore, 'session-' + id, metadata);
    storage.set([owner, device.id, runtime.id, id, 'session'].join('/'), {
      snapshot: encode(document.export({ mode: 'snapshot' })),
      metaBundle: metadataStore.exportJson(),
      meta: metadata,
    });
  };
  putCached('second', 'Second needle body', second);
  putCached('foreign', 'Secret foreign needle body', { ...foreign, userId: 'another-user' });
  putCached('unlisted', 'Secret unlisted needle body', siblingMeta('unlisted', 'Unlisted'));
  storage.set([owner, device.id, runtime.id, 'second', 'draft'].join('/'), 'Second unsent draft');
  let deferSearch = false,
    searchStarted: (() => void) | undefined,
    releaseSearch: (() => void) | undefined;
  const requests: { path: string; body: any }[] = [];
  const scrolled: HTMLElement[] = [];
  Object.defineProperty(win.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: function (this: HTMLElement) {
      scrolled.push(this);
    },
  });
  Object.assign(globalThis, {
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, win.location.href),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, body });
      let result: unknown;
      if (url.pathname === '/api/devices') result = [device];
      else if (url.pathname === '/api/workspaces') result = [space];
      else if (url.pathname.endsWith('/hosts/host/sessions')) result = rows;
      else if (url.pathname.includes('/sessions/')) {
        const id = url.pathname.split('/').at(-1)!;
        const metadata = rows.find((row) => row.id === id);
        assert.ok(metadata);
        const store = new Flock();
        putMeta(store, 'session-' + id, metadata);
        result = {
          meta: metadata,
          metaBundle: store.exportJson(),
          update: delta(documents.get(id)!),
          online: true,
          synced: true,
          persisted: true,
        };
      } else if (url.pathname.endsWith('/session-search')) {
        assert.equal(body.workspaceId, runtime.id);
        assert.equal(body.localProjectId, 'local-project');
        const hits =
          body.query === 'frozen'
            ? [
                {
                  sessionId,
                  turnId: reference.turnId,
                  itemIndex: 0,
                  kind: 'diff',
                  path: change.path,
                  excerpt: 'frozen file changed.txt',
                },
              ]
            : body.scope === 'project'
              ? [
                  {
                    sessionId: 'second',
                    turnId: 'other-turn',
                    itemIndex: 0,
                    kind: 'message',
                    excerpt: 'Second needle body',
                  },
                ]
              : [
                  {
                    sessionId,
                    turnId: 'assistant-turn',
                    itemIndex: 1,
                    kind: 'tool',
                    excerpt: 'tool needle <img src=x onerror=bad>',
                  },
                ];
        result = {
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          searchVersion: 1,
          confirmed: true,
          source: 'host-index',
          scope: body.scope,
          query: body.query,
          hits,
          more: false,
          partial: false,
        };
        if (deferSearch) {
          deferSearch = false;
          await new Promise<void>((resolve) => {
            releaseSearch = resolve;
            searchStarted?.();
          });
        }
      } else if (url.pathname.endsWith('/turn-diff'))
        result = {
          ...contentScope,
          turnId: reference.turnId,
          state: 'ready',
          reference,
          changes: [change],
          partial: false,
          issues: [],
          attribution: 'shared-project',
        };
      else if (url.pathname.endsWith('/diff-file'))
        result = {
          ...contentScope,
          turnId: reference.turnId,
          path: change.path,
          reference,
          before: { ...before, text: 'old' },
          after: { ...after, text: 'new' },
          partial: false,
          issues: [],
          attribution: 'shared-project',
        };
      else assert.fail('Unexpected synthetic search request ' + url.pathname);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/session-search-app-')),
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
        name: 'synthetic-search-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/cache$/ }, () => ({
            path: 'cache',
            namespace: 'synthetic',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({
            loader: 'js',
            contents:
              'export const read=async key=>structuredClone(globalThis.__moorAppCache.get(key));export const write=async(key,value)=>{globalThis.__moorAppCache.set(key,structuredClone(value));};export const compareText=async(key,expected,value,current,signal)=>{if(signal?.aborted||!current())throw new Error("stale draft");const cache=globalThis.__moorAppCache;if(cache.get(key)!==expected)return false;cache.set(key,value);return true;}; export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const compareDraftBundle=async()=>{throw new Error("unexpected role draft application");}; export const clear=async()=>globalThis.__moorAppCache.clear();',
          }));
          builder.onLoad({ filter: /\/src\/web\/app\.ts$/ }, async (args) => ({
            loader: 'ts',
            resolveDir: resolve('src/web'),
            contents:
              (await readFile(args.path, 'utf8')).replace(
                'void fn().catch(error);',
                'globalThis.__moorLastOperation = fn().catch(error);',
              ) +
              '\nexport {loadDevices,openSession,closeProjectContent,openSessionSearch,closeSessionSearch};export const testSearch=(query,scope)=>runSessionSearch(searchPanel,query,scope);export {disposeUI} from "./ui";',
          }));
        },
      },
    ],
  });
  const app = await import(pathToFileURL(outfile).href),
    { act } = await import('react');
  const field = () => document.querySelector<HTMLTextAreaElement>('#prompt')!;
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) => element.textContent === label || element.getAttribute('aria-label') === label,
    );
    assert.ok(found, label);
    return found;
  };
  const searchRequests = () =>
    requests.filter((request) => request.path.endsWith('/session-search'));
  const searchFromForm = async (query: string, scope: 'session' | 'project') => {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('[aria-label="搜索正文"]')!;
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        query,
      );
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      const select = document.querySelector<HTMLSelectElement>('[aria-label="正文搜索范围"]')!;
      select.value = scope;
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    await act(async () => {
      button('搜索').click();
      await (globalThis as any).__moorLastOperation;
    });
  };
  try {
    await act(async () =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(undefined)),
    );
    await act(async () => SyntheticSocket.instances.at(-1)!.open());
    assert.equal(field().value, draft);
    await act(async () => button('正文搜索').click());
    await searchFromForm('needle', 'session');
    assert.equal(searchRequests().length, 1);
    assert.equal(searchRequests()[0]!.body.scope, 'session');
    assert.equal(document.querySelector('.session-search-results img'), null);
    assert.match(
      document.querySelector('.session-search-results')!.textContent!,
      /<img src=x onerror=bad>/,
    );
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.session-search-results button')!.click();
      await (globalThis as any).__moorLastOperation;
    });
    assert.equal(document.querySelector('.session-search-panel'), null);
    assert.equal(scrolled.at(-1)?.dataset.searchItem, '1');
    assert.equal(
      scrolled.at(-1)?.closest<HTMLElement>('[data-search-turn]')?.dataset.searchTurn,
      'assistant-turn',
    );
    assert.ok(document.querySelector('.search-located details[open]'));
    assert.equal(field().value, draft);
    await act(async () => button('正文搜索').click());
    await searchFromForm('needle', 'project');
    assert.equal(searchRequests().at(-1)!.body.scope, 'project');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.session-search-results button')!.click();
      await (globalThis as any).__moorLastOperation;
    });
    assert.equal(field().value, 'Second unsent draft');
    assert.match(document.querySelector('.search-located')!.textContent!, /Second needle body/);
    await act(async () => app.openSession(sessionId, 'replica'));
    assert.equal(field().value, draft);
    await act(async () => button('正文搜索').click());
    await searchFromForm('frozen', 'session');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.session-search-results button')!.click();
      await (globalThis as any).__moorLastOperation;
    });
    assert.equal(document.querySelector('.project-diff-line.removed code')!.textContent, 'old');
    assert.equal(document.querySelector('.project-diff-line.added code')!.textContent, 'new');
    assert.equal(
      requests.filter((request) => request.path.endsWith('/file-content')).length,
      0,
      'a diff hit opens frozen bytes, never current files',
    );
    await act(async () => app.closeProjectContent());
    const beforeOffline = requests.length;
    device.online = false;
    space.hosts[0].online = false;
    space.replicas[0].available = false;
    await act(async () => app.loadDevices());
    await act(async () => button('正文搜索').click());
    const beforeOfflineSearch = requests.length;
    await searchFromForm('needle', 'project');
    assert.equal(requests.length, beforeOfflineSearch, 'offline search does not make requests');
    assert.ok(beforeOfflineSearch > beforeOffline);
    const results = document.querySelector('.session-search-results')!.textContent!;
    assert.match(results, /Second needle body/);
    assert.match(results, /Synthetic needle response/);
    assert.doesNotMatch(results, /Secret foreign|Secret unlisted/);
    assert.match(document.querySelector('.session-search-panel')!.textContent!, /部分内容尚未缓存/);
    assert.match(document.querySelector('.session-search-panel')!.textContent!, /2\/4/);
    await searchFromForm('new', 'session');
    assert.match(document.querySelector('.session-search-results')!.textContent!, /changed.txt/);
    assert.equal(
      requests.length,
      beforeOfflineSearch,
      'cached diff text is searched without fetching the host',
    );
    assert.equal(field().value, draft);
    await act(async () => app.closeSessionSearch());
    device.online = true;
    space.hosts[0].online = true;
    space.replicas[0].available = true;
    await act(async () => app.loadDevices());
    await act(async () => app.openSessionSearch());
    deferSearch = true;
    const started = new Promise<void>((resolve) => {
      searchStarted = resolve;
    });
    let late!: Promise<void>;
    await act(async () => {
      late = app.testSearch('needle', 'session');
      await started;
    });
    await act(async () => app.openSession('second', 'replica'));
    await act(async () => {
      releaseSearch!();
      await late;
    });
    assert.equal(document.querySelector('.session-search-panel'), null);
    assert.match(document.querySelector('#history')!.textContent!, /Second needle body/);
    assert.equal(field().value, 'Second unsent draft');
    assert.equal(storage.get(cacheKey + '/draft'), draft);
    assert.equal(
      requests.filter(
        (request) =>
          request.path.endsWith('/mutations') ||
          request.path.endsWith('/steer') ||
          request.path.endsWith('/question-answers'),
      ).length,
      0,
    );
  } finally {
    await act(async () => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
