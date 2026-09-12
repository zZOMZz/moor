import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire as createPackageRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { Flock, LoroDoc, decode, delta, metas, mirror, putMeta } from '../src/model';
import { syntheticCapabilities } from './support/agent-capabilities';
import { createHash } from 'node:crypto';
import type { ProjectDiffReference, ProjectDiffChange } from '../src/project-content-protocol';

// Exercise the real controller and React UI. Only storage and transport are
// synthetic; deferred responses reproduce ordering races without elapsed time.
test('project content app keeps frozen history separate, rejects stale responses and never caches volatile host output', async () => {
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
    features: ['session-actions', 'project-tree-v1', 'project-diff-v1'],
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
        items: [{ type: 'text', text: 'Synthetic response' }],
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
  let persisted = true;
  let restartedDoc: LoroDoc | undefined;
  let transientMeta: Flock | undefined;
  const readResponse = () => ({
    meta: transientMeta ? metas(transientMeta)['session-' + sessionId] : currentMeta(),
    metaBundle: (transientMeta ?? hostMeta).exportJson(),
    update: delta(restartedDoc ?? hostDoc),
    online: true,
    synced: true,
    persisted,
    ...(persisted ? {} : { persistenceError: 'Synthetic persistence failure' }),
  });
  let currentText = '# Current project text',
    deferFile = false;
  let fileStarted: (() => void) | undefined, releaseFile: (() => void) | undefined;
  const requests: { path: string; body: any; version: string | null }[] = [];
  Object.assign(globalThis, {
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, win.location.href),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, body, version: url.searchParams.get('version') });
      let result: unknown;
      if (url.pathname === '/api/devices') result = [device];
      else if (url.pathname === '/api/workspaces') result = [space];
      else if (url.pathname.endsWith('/hosts/host/sessions')) result = [currentMeta()];
      else if (url.pathname.endsWith('/sessions/' + sessionId)) result = readResponse();
      else if (url.pathname.endsWith('/project-tree'))
        result = {
          ...contentScope,
          version: hash('tree'),
          source: 'git',
          entries: [
            { path: 'current.md', type: 'file', size: 50 },
            { path: 'other.txt', type: 'file', size: 50 },
          ],
          offset: 0,
          total: 2,
          partial: true,
          enumerationComplete: true,
          issues: [{ reason: 'policy-excluded' }],
        };
      else if (url.pathname.endsWith('/file-content')) {
        const text = body.path === 'other.txt' ? 'Other selected file' : currentText;
        result = {
          ...contentScope,
          path: body.path,
          content: {
            version: hash(text),
            byteLength: Buffer.byteLength(text),
            mediaType: 'text/plain',
          },
          status: 'content',
          encoding: 'base64',
          data: Buffer.from(text).toString('base64'),
        };
        if (deferFile) {
          deferFile = false;
          await new Promise<void>((done) => {
            releaseFile = done;
            fileStarted?.();
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
      else assert.fail('Unexpected synthetic read-only request: ' + path);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  // Keep test-only exports and the cache substitution in the disposable bundle.
  // Production code receives no test hook and no real IndexedDB is accessed.
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/project-content-app-'));
  const outfile = join(directory, 'app.mjs');
  await build({
    entryPoints: ['src/web/app.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['loro-crdt', 'react', 'react-dom', 'react-dom/client'],
    banner: {
      js: "import { createRequire as createPackageRequire } from 'node:module'; const require=createPackageRequire(import.meta.url);",
    },
    plugins: [
      {
        name: 'synthetic-app-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/cache$/ }, () => ({
            path: 'cache',
            namespace: 'synthetic',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({
            loader: 'js',
            contents: `
        export const read = async key => structuredClone(globalThis.__moorAppCache.get(key));
        export const write = async (key, value) => { globalThis.__moorAppCache.set(key, structuredClone(value)); };
        export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const clear = async () => { globalThis.__moorAppCache.clear(); };
      `,
          }));
          builder.onLoad({ filter: /\/src\/web\/app\.ts$/ }, async (args) => ({
            loader: 'ts',
            resolveDir: resolve('src/web'),
            contents:
              (await readFile(args.path, 'utf8')) +
              '\nexport { loadSession, loadDevices, openSession, openProjectContent, openCurrentProjectFile, openProjectDiffFile, closeProjectContent, sendTurn }; export { disposeUI } from "./ui";\n',
          }));
        },
      },
    ],
  });
  const app = await import(pathToFileURL(outfile).href);
  const { act } = await import('react');
  const field = () => document.querySelector<HTMLTextAreaElement>('#prompt')!;
  const send = () => document.querySelector<HTMLButtonElement>('#send')!;
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label,
    );
    assert.ok(found, label);
    return found;
  };
  try {
    await act(async () =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(undefined)),
    );
    await act(async () => SyntheticSocket.instances.at(-1)!.open());
    assert.equal(field().value, draft);
    assert.ok(document.querySelector('[data-project-turn="assistant-turn"]'));
    await act(async () => app.openProjectContent('tree'));
    assert.ok(document.querySelector('[aria-label="查看文件：current.md"]'));
    await act(async () => app.openCurrentProjectFile('current.md', 50));
    assert.match(document.querySelector('.project-file-view')!.textContent!, /当前主机文件/);
    assert.match(document.querySelector('.project-markdown')!.textContent!, /Current project text/);
    await act(async () => app.openProjectContent('changes', 'assistant-turn'));
    await act(async () => app.openProjectDiffFile(change));
    assert.equal(document.querySelector('.project-diff-line.removed code')!.textContent, 'old');
    assert.equal(document.querySelector('.project-diff-line.added code')!.textContent, 'new');
    currentText = '# Later project contents';
    await act(async () => app.openProjectContent('tree'));
    await act(async () => app.openCurrentProjectFile('current.md', 50));
    assert.match(
      document.querySelector('.project-markdown')!.textContent!,
      /Later project contents/,
    );
    device.online = false;
    space.hosts[0].online = false;
    space.replicas[0].available = false;
    await act(async () => app.loadDevices());
    const readCount = () => requests.filter((request) => request.body).length;
    const beforeOffline = readCount();
    await act(async () => app.openProjectContent('changes', 'assistant-turn'));
    await act(async () => app.openProjectDiffFile(change));
    assert.match(document.querySelector('.project-diff-preview')!.textContent!, /离线缓存/);
    assert.equal(document.querySelector('.project-diff-line.removed code')!.textContent, 'old');
    await act(async () => app.openProjectContent('tree'));
    await act(async () => app.openCurrentProjectFile('current.md', 50));
    assert.match(
      document.querySelector('.project-file-view')!.textContent!,
      /已缓存文件版本 · 不代表当前主机内容/,
    );
    assert.equal(
      readCount(),
      beforeOffline,
      'offline content navigation only reads cached versions',
    );
    device.online = true;
    space.hosts[0].online = true;
    space.replicas[0].available = true;
    await act(async () => app.loadDevices());
    assert.equal(readCount(), beforeOffline, 'reconnection does not perform content operations');
    deferFile = true;
    let late!: Promise<void>;
    const started = new Promise<void>((done) => {
      fileStarted = done;
    });
    await act(async () => {
      late = app.openCurrentProjectFile('current.md', 50);
      await started;
    });
    await act(async () => app.openCurrentProjectFile('other.txt', 50));
    await act(async () => {
      releaseFile!();
      await late;
    });
    assert.match(document.querySelector('.project-file-view')!.textContent!, /Other selected file/);
    assert.doesNotMatch(
      document.querySelector('.project-file-view')!.textContent!,
      /Later project contents/,
    );
    deferFile = true;
    const switched = new Promise<void>((done) => {
      fileStarted = done;
    });
    await act(async () => {
      late = app.openCurrentProjectFile('current.md', 50);
      await switched;
    });
    await act(async () => app.openSession(''));
    await act(async () => {
      releaseFile!();
      await late;
    });
    assert.equal(
      document.querySelector('.project-content-panel'),
      null,
      'late response cannot reopen a panel in another session',
    );
    assert.equal(field().value, '');
    await act(async () => app.openSession(sessionId, 'replica'));
    const cachedSession = structuredClone(storage.get(cacheKey + '/session'));
    const durableSnapshot = hostDoc.export({ mode: 'snapshot' });
    const volatile = mirror(hostDoc, sessionId);
    volatile.setState((state: any) => {
      state.history[1].items.push({ type: 'text', text: 'Synthetic unsaved final output' });
    });
    volatile.dispose();
    hostDoc.commit();
    persisted = false;
    transientMeta = Flock.fromJson(hostMeta.exportJson(), 'ab12345678123456');
    putMeta(transientMeta, 'session-' + sessionId, {
      metadataRevision: 1,
      title: 'Synthetic volatile title',
      volatileMarker: 'unpersisted-metadata',
    });
    await act(async () => app.loadSession());
    assert.match(
      document.querySelector('#history')!.textContent!,
      /Synthetic unsaved final output/,
    );
    assert.match(document.querySelector('#session-persistence-state')!.textContent!, /尚未保存/);
    assert.equal(
      document.querySelector('#session-persistence-state')!.hasAttribute('hidden'),
      false,
    );
    assert.equal(send().disabled, true);
    assert.deepEqual(
      storage.get(cacheKey + '/session'),
      cachedSession,
      'volatile host output never becomes a confirmed history cache',
    );
    await act(async () => {
      await assert.rejects(app.sendTurn(), /尚未保存/);
    });
    assert.equal(field().value, draft);
    assert.ok(
      requests.every(
        (request) => !/mutations|attachment-actions|cancel|session-actions/.test(request.path),
      ),
      'all project content operations remain read-only',
    );
    persisted = true;
    transientMeta = undefined;
    restartedDoc = new LoroDoc();
    restartedDoc.import(durableSnapshot);
    await act(async () => app.loadSession());
    assert.equal(
      document.querySelector('#session-persistence-state')!.hasAttribute('hidden'),
      true,
    );
    assert.equal(
      requests.at(-1)!.version,
      null,
      'recovery after volatile output requests a full host state',
    );
    assert.doesNotMatch(
      document.querySelector('#history')!.textContent!,
      /Synthetic unsaved final output/,
    );
    const recovered = new LoroDoc();
    const recoveredCache = storage.get(cacheKey + '/session') as any;
    assert.equal(
      recoveredCache.meta.metadataRevision,
      0,
      'full recovery accepts the durable metadata revision',
    );
    assert.equal(recoveredCache.meta.title, 'Original title');
    const recoveredMeta = new Flock();
    recoveredMeta.importJson(recoveredCache.metaBundle);
    assert.equal(metas(recoveredMeta)['session-' + sessionId].volatileMarker, undefined);
    recovered.import(decode((storage.get(cacheKey + '/session') as any).snapshot));
    const recoveredView = mirror(recovered, sessionId);
    assert.doesNotMatch(JSON.stringify(recoveredView.getState()), /Synthetic unsaved final output/);
    recoveredView.dispose();
    assert.ok(
      requests.every((request) => !request.path.includes('/mutations')),
      'restoring canonical history cannot replay a pending turn',
    );
  } finally {
    await act(async () => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
