import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire as createPackageRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { Flock, LoroDoc, delta, metas, mirror, putMeta } from '../src/model';
import { syntheticCapabilities } from './support/agent-capabilities';
import type { SessionAction } from '../src/protocol';
import type { SessionSummary } from '../src/web/navigation';

// Exercise the real controller and React UI. Only storage and transport are
// synthetic; deferred responses reproduce ordering races without elapsed time.
test('confirmed session actions survive stale reads and preserve draft and archive filter', async () => {
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
    features: ['session-actions'],
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
  const row = () =>
    ({
      ...currentMeta(),
      id: sessionId,
      replicaId: 'replica',
      projectId: 'project',
    }) as SessionSummary;
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
  const readResponse = () => ({
    meta: currentMeta(),
    metaBundle: hostMeta.exportJson(),
    update: delta(hostDoc),
    online: true,
    synced: true,
  });
  const actions: SessionAction[] = [];
  let releaseRead: (() => void) | undefined;
  let deferNextRead = false;
  Object.assign(globalThis, {
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, win.location.href);
      let result: unknown;
      if (url.pathname === '/api/devices') result = [device];
      else if (url.pathname === '/api/workspaces') result = [space];
      else if (url.pathname.endsWith('/hosts/host/sessions')) result = [currentMeta()];
      else if (url.pathname.endsWith('/sessions/' + sessionId)) {
        result = structuredClone(readResponse());
        if (deferNextRead) {
          deferNextRead = false;
          await new Promise<void>((resolveRead) => {
            releaseRead = resolveRead;
          });
        }
      } else if (url.pathname.endsWith('/session-actions')) {
        const action = JSON.parse(String(init!.body)) as SessionAction;
        assert.equal(action.expectedRevision, currentMeta().metadataRevision);
        actions.push(action);
        putMeta(hostMeta, 'session-' + sessionId, {
          metadataRevision: action.expectedRevision + 1,
          ...(action.action === 'rename' ? { title: action.title } : {}),
          ...(['archive', 'restore'].includes(action.action)
            ? { isArchived: action.action === 'archive' }
            : {}),
        });
        result = {
          accepted: true,
          delivered: true,
          operationId: action.operationId,
          meta: currentMeta(),
        };
      } else assert.fail('Unexpected synthetic request: ' + path);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  // Keep test-only exports and the cache substitution in the disposable bundle.
  // Production code receives no test hook and no real IndexedDB is accessed.
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/session-app-'));
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
              '\nexport { loadSession, loadSessions, manageSession, openSession }; export { disposeUI } from "./ui";\n',
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
    assert.equal(send().disabled, false);
    assert.match(document.querySelector('#history')!.textContent!, /Synthetic history/);

    deferNextRead = true;
    const beforeRename = app.loadSession();
    assert.ok(releaseRead, 'the stale read has reached the injected transport');
    await act(async () => app.manageSession(row(), 'rename', 'Confirmed title'));
    await act(async () => {
      releaseRead!();
      await beforeRename;
    });
    assert.equal((storage.get(cacheKey + '/session') as any).meta.title, 'Confirmed title');
    assert.match(
      document.querySelector('#target')?.textContent ?? document.body.textContent!,
      /Confirmed title/,
    );

    deferNextRead = true;
    const beforeArchive = app.loadSession();
    await act(async () => app.manageSession(row(), 'archive'));
    await act(async () => {
      releaseRead!();
      await beforeArchive;
    });
    assert.equal((storage.get(cacheKey + '/session') as any).meta.isArchived, true);
    assert.equal(send().disabled, true, 'a late pre-archive GET cannot enable execution');
    assert.equal(field().value, draft);
    assert.equal(storage.get(cacheKey + '/draft'), draft);

    await act(async () => button('活跃会话').click());
    assert.equal(button('活跃会话').getAttribute('aria-pressed'), 'true');
    await act(async () => {
      await app.loadSession();
      await app.loadSessions();
    });
    assert.equal(
      button('活跃会话').getAttribute('aria-pressed'),
      'true',
      'background reads preserve the chosen list filter',
    );
    assert.equal(
      send().disabled,
      true,
      'filtering changes navigation, not the archived conversation',
    );

    await act(async () => app.manageSession(row(), 'restore'));
    assert.equal(send().disabled, false);
    assert.equal(field().value, draft);
    assert.equal(storage.get(cacheKey + '/draft'), draft);
    await act(async () => app.openSession(sessionId, 'replica'));
    assert.equal(field().value, draft, 'reopening restores the durable draft');
    assert.deepEqual(
      actions.map((action) => action.action),
      ['rename', 'archive', 'restore'],
    );
  } finally {
    await act(async () => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
