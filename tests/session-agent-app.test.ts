import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire as createPackageRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { Flock, LoroDoc, decode, delta, encode, metas, mirror, putMeta } from '../src/model';
import { syntheticCapabilities } from './support/agent-capabilities';

// Exercise the real controller and React UI. Only storage and transport are
// synthetic; deferred responses reproduce ordering races without elapsed time.
test('actual app keeps an existing session on its fixed Agent version, validates projections, and preserves its original retry across catalog changes', async () => {
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
    onmessage?: (event: { data: string }) => void;
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
  const current = {
    id: 'agent-current',
    name: 'Current Agent version',
    cliType: 'builtin',
    agentType: 'codex',
    runConfig: syntheticCapabilities,
  };
  const old = { ...current, id: 'agent-old', name: 'Frozen old Agent version' };
  const runtime = {
    id: 'runtime',
    name: 'Synthetic runtime',
    userId: 'synthetic-user',
    machineId: 'machine',
    projects: [{ id: 'local-project', name: 'Synthetic project', rootPath: '/synthetic' }],
    agents: [current],
    features: ['agent-versions-v1'],
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
  const hostMeta = new Flock(),
    documents = new Map<string, LoroDoc>();
  for (const [id, agent] of [
    ['session', old],
    ['current-session', current],
  ] as const) {
    const doc = new LoroDoc(),
      view = mirror(doc, id);
    view.setState(
      (state) =>
        void state.history.push({
          id: id + '-seed',
          role: 'user',
          userId: runtime.userId,
          userTurnId: undefined,
          inputConfig: undefined,
          timestamp: '2026-01-01T00:00:00Z',
          finished: true,
          read: true,
          status: 'handled',
          items: [{ type: 'text', text: 'Synthetic ' + id + ' history' }],
          fileDiff: null,
        }),
    );
    view.dispose();
    doc.commit();
    documents.set(id, doc);
    putMeta(hostMeta, 'session-' + id, {
      id,
      title: id,
      machineId: runtime.machineId,
      userId: runtime.userId,
      project: { kind: 'local', localProjectId: 'local-project' },
      cliType: agent.cliType,
      agentType: agent.agentType,
      agentConfigId: agent.id,
      metadataRevision: 0,
      isArchived: false,
      isPinned: false,
      status: { type: 'idle' },
      latestUserMsgId: id + '-seed',
      lastHandledUserMsgId: id + '-seed',
      lastMessageAt: 1,
    });
  }
  const metadata = (id: string) => metas(hostMeta)['session-' + id];
  const cacheKey = [owner, device.id, runtime.id, 'session'].join('/');
  const storage = new Map<string, unknown>([
    [
      owner + '/view',
      {
        deviceId: device.id,
        workspaceId: runtime.id,
        catalogWorkspaceId: space.id,
        replicaId: 'replica',
        sessionId: 'session',
      },
    ],
    [cacheKey + '/draft', 'Preserve the old session draft'],
  ]);
  function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { resolve, promise };
  }
  const requests: { path: string; body: any }[] = [];
  let waitRead: undefined | (() => Promise<void>), waitOptions: undefined | (() => Promise<void>);
  let invalidProjection = false,
    omitOldProjection = false,
    omitCurrentProjection = false,
    invalidOptions = false,
    lost = true;
  let wrongProject: { kind: string; localProjectId?: string } | undefined;
  const receipts = new Map<string, unknown>();
  Object.assign(globalThis, {
    __moorAppCache: storage,
    __moorNotificationLocal: { version: 1, revision: 0, records: [] },
    __moorSchedule: (_callback: () => void) => 1,
    __moorTextWrite: async (key: string, value: unknown) => {
      storage.set(key, structuredClone(value));
    },
    __moorTextCAS: async (
      key: string,
      expected: string | undefined,
      value: string,
      current: () => boolean,
    ) => {
      if (!current()) throw Error('stale scope');
      if (storage.get(key) !== expected) return false;
      storage.set(key, value);
      return true;
    },
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, win.location.href),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, body });
      let result: any;
      if (url.pathname === '/api/devices') result = [device];
      else if (url.pathname === '/api/workspaces') result = [space];
      else if (url.pathname.endsWith('/hosts/host/sessions'))
        result = [metadata('session'), metadata('current-session')];
      else if (url.pathname.includes('/sessions/')) {
        const id = url.pathname.split('/').at(-1)!;
        // Capture at dispatch so a later synthetic catalog change cannot rewrite this response.
        result = {
          meta: { ...metadata(id), ...(wrongProject ? { project: wrongProject } : {}) },
          metaBundle: hostMeta.exportJson(),
          update: delta(documents.get(id)!),
          online: true,
          synced: true,
          persisted: true,
          ...(id === 'session' && !omitOldProjection
            ? {
                agent: {
                  ...(invalidProjection ? current : old),
                  customAcp: { command: '/private/synthetic-not-for-web' },
                  env: { SECRET: 'not-public' },
                },
              }
            : id === 'current-session' &&
                runtime.features.includes('agent-versions-v1') &&
                !omitCurrentProjection
              ? { agent: current }
              : {}),
        };
        await waitRead?.();
      } else if (url.pathname.endsWith('/agent-options')) {
        const agent = body.agentId === old.id ? old : current;
        result = { ...(invalidOptions ? current : agent), name: 'Refreshed ' + agent.name };
        await waitOptions?.();
      } else if (url.pathname.endsWith('/mutations')) {
        assert.deepEqual(storage.get(cacheKey + '/pending'), body);
        if (!receipts.has(body.operationId)) {
          documents.get(body.sessionId)!.import(decode(body.update));
          hostMeta.importJson(body.metaBundle);
          receipts.set(body.operationId, {
            accepted: true,
            delivered: true,
            operationId: body.operationId,
          });
        }
        if (lost) throw Error('Synthetic lost receipt');
        result = receipts.get(body.operationId);
      } else assert.fail('Unexpected session Agent app request ' + url.pathname);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/session-agent-app-')),
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
        name: 'synthetic-session-agent-boundaries',
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
                ? 'export const read=async key=>structuredClone(globalThis.__moorAppCache.get(key));export const write=async(key,value)=>{await globalThis.__moorTextWrite(key,value);};export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const compareText=(...args)=>globalThis.__moorTextCAS(...args); export const clear=async()=>globalThis.__moorAppCache.clear();'
                : 'export const notificationLocal=async update=>{if(update)globalThis.__moorNotificationLocal=update(globalThis.__moorNotificationLocal);return structuredClone(globalThis.__moorNotificationLocal);};export const rememberNotification=async()=>{};',
          }));
          builder.onLoad({ filter: /\/src\/web\/app\.ts$/ }, async (args) => ({
            loader: 'ts',
            resolveDir: resolve('src/web'),
            contents:
              (await readFile(args.path, 'utf8'))
                .replaceAll('setTimeout(', 'globalThis.__moorSchedule(')
                .replace(
                  'void fn().catch(error);',
                  'globalThis.__moorLastOperation = fn().catch(error);',
                )
                .replace(
                  'void loadAttachmentDraft().catch(error);',
                  'globalThis.__moorGitProjectChange = loadAttachmentDraft().catch(error);',
                ) +
              '\nexport {openSession,sendTurn,currentAgent,refreshRunOptions,loadSession,loadDevices};export {disposeUI} from "./ui";',
          }));
        },
      },
    ],
  });

  const app = await import(pathToFileURL(outfile).href),
    { act } = await import('react');
  const field = () => document.querySelector<HTMLTextAreaElement>('#prompt')!;
  const button = (label: string) => {
    const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label,
    );
    assert.ok(result, label);
    return result;
  };
  const click = async (label: string) =>
    act(async () => {
      button(label).click();
      await (globalThis as any).__moorLastOperation;
    });
  async function type(value: string) {
    await act(() => {
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        field(),
        value,
      );
      field().dispatchEvent(new win.Event('input', { bubbles: true }));
    });
  }
  const mutations = () => requests.filter((call) => call.path.endsWith('/mutations'));
  const options = () => requests.filter((call) => call.path.endsWith('/agent-options'));
  try {
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    await act(() => SyntheticSocket.instances.at(-1)!.open());
    await act(async () => await (globalThis as any).__moorLastOperation);
    assert.equal(
      app.currentAgent().id,
      old.id,
      'session projection takes priority over current-only catalog',
    );
    assert.equal(field().value, 'Preserve the old session draft');
    assert.equal(
      options().length,
      0,
      'opening a session with known options does not initialize an Agent',
    );
    const saved = storage.get(cacheKey + '/session') as any;
    assert.equal(saved.agent.id, old.id);
    assert.equal(saved.agent.customAcp, undefined);
    assert.equal(saved.agent.env, undefined, 'only parsed public fields enter the session cache');

    invalidOptions = true;
    await act(async () => {
      await assert.rejects(app.refreshRunOptions(), /不属于当前会话/);
    });
    assert.deepEqual(options().at(-1)!.body, { agentId: old.id, sessionId: 'session' });
    assert.equal(app.currentAgent().id, old.id);
    assert.equal(
      app.currentAgent().name,
      old.name,
      'bad options cannot replace the pinned projection',
    );
    invalidOptions = false;
    await act(() => app.refreshRunOptions());
    assert.equal(app.currentAgent().id, old.id);
    assert.match(app.currentAgent().name, /Refreshed/);

    // An old options response arriving in a different session must be discarded.
    const optionsEntered = signal(),
      optionsRelease = signal();
    waitOptions = async () => {
      optionsEntered.resolve();
      await optionsRelease.promise;
    };
    let lateOptions!: Promise<void>;
    await act(async () => {
      lateOptions = app.refreshRunOptions();
      await optionsEntered.promise;
    });
    await act(() => app.openSession('current-session', 'replica'));
    assert.equal(
      app.currentAgent().id,
      current.id,
      'the other session reads its own version projection',
    );
    await act(async () => {
      optionsRelease.resolve();
      await lateOptions;
    });
    waitOptions = undefined;
    assert.equal(app.currentAgent().name, current.name);

    // Version-aware hosts cannot fall back to a catalog entry when the bound descriptor is missing.
    omitCurrentProjection = true;
    await act(() => app.openSession('current-session', 'replica'));
    assert.equal(app.currentAgent(), undefined);
    assert.match(
      document.querySelector('#history')!.textContent!,
      /Synthetic current-session history/,
    );
    assert.match(document.querySelector('#session-persistence-state')!.textContent!, /Agent/);
    assert.equal(document.querySelector<HTMLButtonElement>('#send')!.disabled, true);
    await act(async () => {
      await assert.rejects(app.sendTurn(), /Agent/);
    });
    assert.equal(mutations().length, 0);

    // Older hosts expose neither the feature nor the descriptor and expect the original body.
    runtime.features = [];
    await act(() => app.loadDevices());
    await act(() => app.openSession('current-session', 'replica'));
    assert.equal(app.currentAgent().id, current.id);
    await act(() => app.refreshRunOptions());
    assert.deepEqual(options().at(-1)!.body, { agentId: current.id });
    runtime.features = ['agent-versions-v1'];
    omitCurrentProjection = false;
    await act(() => app.loadDevices());
    await act(() => app.openSession(''));
    assert.equal(app.currentAgent().id, current.id, 'new sessions use only the current catalog');
    await act(() => app.refreshRunOptions());
    assert.deepEqual(options().at(-1)!.body, { agentId: current.id });

    // Read projections obey the same generation boundary, including new drafts.
    const readEntered = signal(),
      readRelease = signal();
    waitRead = async () => {
      readEntered.resolve();
      await readRelease.promise;
    };
    let lateRead!: Promise<void>;
    await act(async () => {
      lateRead = app.openSession('session', 'replica');
      await readEntered.promise;
    });
    await act(() => app.openSession(''));
    await act(async () => {
      readRelease.resolve();
      await lateRead;
    });
    waitRead = undefined;
    assert.equal(app.currentAgent().id, current.id);

    // Even a syntactically valid projection must agree with the bound metadata.
    invalidProjection = true;
    await act(() => app.openSession('session', 'replica'));
    assert.equal(app.currentAgent(), undefined);
    assert.match(
      document.querySelector('#session-persistence-state')?.textContent ??
        document.body.textContent!,
      /Agent 配置不匹配/,
    );
    await act(async () => {
      await assert.rejects(app.sendTurn(), /Agent 配置不匹配/);
    });
    assert.equal(mutations().length, 0);
    assert.equal((storage.get(cacheKey + '/session') as any).agent.id, old.id);
    invalidProjection = false;
    for (const project of [
      { kind: 'local', localProjectId: 'another-project' },
      { kind: 'unbound' },
    ]) {
      wrongProject = project;
      await act(() => app.openSession('session', 'replica'));
      assert.equal(
        app.currentAgent(),
        undefined,
        'the descriptor must belong to this project replica',
      );
      await act(async () => {
        await assert.rejects(app.sendTurn(), /Agent 配置不匹配/);
      });
      assert.equal(mutations().length, 0);
      assert.deepEqual(
        (storage.get(cacheKey + '/session') as any).meta.project,
        { kind: 'local', localProjectId: 'local-project' },
        'wrong-project metadata never replaces the confirmed cache',
      );
    }
    wrongProject = undefined;
    await act(() => app.openSession('session', 'replica'));

    // Cache projection remains useful for offline display but cannot authorize execution.
    device.online = false;
    space.hosts[0]!.online = false;
    await act(() => app.loadDevices());
    const readCount = requests.filter((call) => call.path.includes('/sessions/')).length;
    await act(() => app.openSession('session', 'replica'));
    assert.equal(app.currentAgent().id, old.id);
    assert.equal(requests.filter((call) => call.path.includes('/sessions/')).length, readCount);
    await act(async () => {
      await assert.rejects(app.sendTurn(), /离线/);
    });
    assert.equal(mutations().length, 0);
    device.online = true;
    space.hosts[0]!.online = true;
    await act(() => app.loadDevices());
    await act(() => app.openSession('session', 'replica'));
    await type('Manual input on the original Agent version');
    await click('发送指令');
    assert.equal(mutations().length, 1);
    const original = structuredClone(mutations()[0]!.body);
    assert.deepEqual(storage.get(cacheKey + '/pending'), original);
    assert.equal(metadata('session').agentConfigId, old.id);
    assert.equal(field().value, 'Manual input on the original Agent version');

    // A refreshed catalog still cannot turn this old pending operation into a new Agent turn.
    omitOldProjection = true;
    await act(() => app.openSession('session', 'replica'));
    assert.equal(app.currentAgent(), undefined);
    assert.match(
      document.querySelector('#history')!.textContent!,
      /Manual input on the original Agent version/,
    );
    assert.equal(mutations().length, 1, 'refresh restores the request without replay');
    lost = false;
    await click('重试确认');
    assert.deepEqual(mutations()[1]!.body, original);
    assert.equal(receipts.size, 1);
    assert.equal(metadata('session').agentConfigId, old.id);
    assert.equal(storage.get(cacheKey + '/pending'), undefined);
    assert.equal(field().value, '');
    await act(() => app.openSession(''));
    assert.equal(app.currentAgent().id, current.id);
  } finally {
    await act(() => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
