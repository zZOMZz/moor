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
test('actual Roles app stages manual CRUD, applies a reviewed draft bundle once, and preserves typing and Agent scope', async () => {
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
  const agent = {
      id: 'agent',
      name: 'Explicit custom ACP',
      cliType: 'custom',
      agentType: 'custom',
    },
    other = { ...agent, id: 'other', name: 'Other custom ACP', runConfig: syntheticCapabilities };
  const runtime = {
    id: 'runtime',
    name: 'Synthetic runtime',
    userId: 'user',
    machineId: 'machine',
    projects: [{ id: 'project', name: 'Project', rootPath: '/synthetic' }],
    agents: [agent, other],
    features: ['agent-versions-v1', 'roles-v1'],
  };
  const device = { id: 'device', name: 'Synthetic Mac', online: true, workspaces: [runtime] };
  const space = {
    id: 'catalog',
    name: 'Workspace',
    hosts: [
      {
        id: 'host',
        deviceId: 'device',
        machineId: 'machine',
        runtimeWorkspaceId: 'runtime',
        name: 'Host',
        online: true,
        agents: runtime.agents,
      },
    ],
    projects: [{ id: 'project', name: 'Project', source: { kind: 'local' } }],
    replicas: [
      {
        id: 'replica',
        projectId: 'project',
        hostId: 'host',
        localProjectId: 'project',
        rootPath: '/synthetic',
        available: true,
      },
    ],
  };
  runtime.projects.push({
    id: 'second-project',
    name: 'Second project',
    rootPath: '/synthetic-second',
  });
  space.projects.push({ id: 'second-project', name: 'Second project', source: { kind: 'local' } });
  space.replicas.push({
    id: 'second-replica',
    projectId: 'second-project',
    hostId: 'host',
    localProjectId: 'second-project',
    rootPath: '/synthetic-second',
    available: true,
  });
  const hostMeta = new Flock(),
    hostDoc = new LoroDoc(),
    view = mirror(hostDoc, 'session');
  view.setState(
    (state) =>
      void state.history.push({
        id: 'seed',
        role: 'user',
        userId: 'user',
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
  putMeta(hostMeta, 'session-session', {
    id: 'session',
    title: 'Session',
    machineId: 'machine',
    userId: 'user',
    project: { kind: 'local', localProjectId: 'project' },
    cliType: 'custom',
    agentType: 'custom',
    agentConfigId: 'agent',
    metadataRevision: 0,
    isArchived: false,
    isPinned: false,
    status: { type: 'idle' },
    latestUserMsgId: 'seed',
    lastHandledUserMsgId: 'seed',
    lastMessageAt: 1,
  });
  const metadata = () => metas(hostMeta)['session-session'];
  const cacheKey = [owner, 'device', 'runtime', 'session'].join('/');
  const storage = new Map<string, unknown>([
    [
      owner + '/view',
      {
        deviceId: 'device',
        workspaceId: 'runtime',
        catalogWorkspaceId: 'catalog',
        replicaId: 'replica',
        sessionId: 'session',
      },
    ],
    [cacheKey + '/draft', 'Keep my original input'],
  ]);
  function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { resolve, promise };
  }
  let waitRead: undefined | (() => Promise<void>),
    waitCAS: undefined | (() => Promise<void>),
    waitWrite: undefined | (() => Promise<void>),
    failCAS = false,
    lost = true,
    broadcastBeforeReceipt = false,
    undelivered = false,
    lostAbandon = false;
  const requests: { path: string; body: any }[] = [],
    receipts = new Map<string, any>();
  let roleRevision = 1;
  let roles: any[] = [
    {
      id: 'role',
      name: 'Review role',
      revision: 1,
      agentId: 'agent',
      selection: { modelId: 'model-a', reasoningEffort: 'high', modeId: 'read-only' },
      instructions: 'Frozen role instructions <script>bad()</script>',
      available: true,
    },
    {
      id: 'other-role',
      name: 'Other Agent role',
      revision: 1,
      agentId: 'other',
      selection: { modelId: 'model-b' },
      instructions: 'Other Agent instructions',
      available: true,
    },
  ];
  Object.assign(globalThis, {
    __moorAppCache: storage,
    __moorNotificationLocal: { version: 1, revision: 0, records: [] },
    __moorSchedule: (_callback: () => void) => 1,
    __moorTextWrite: async (key: string, value: unknown) => {
      if (key.endsWith('/draft')) await waitWrite?.();
      storage.set(key, structuredClone(value));
    },
    __moorTextCAS: async () => {
      throw Error('Roles must use the multi-key transaction');
    },
    __moorBundleCAS: async (
      entries: { key: string; expected: unknown; value: unknown }[],
      current: () => boolean,
      abort?: AbortSignal,
    ) => {
      await waitCAS?.();
      if (failCAS) throw Error('Synthetic storage failure');
      if (abort?.aborted || !current()) throw Error('Synthetic cancelled role application');
      if (
        entries.some(
          (entry) => JSON.stringify(storage.get(entry.key)) !== JSON.stringify(entry.expected),
        )
      )
        return false;
      for (const entry of entries) storage.set(entry.key, structuredClone(entry.value));
      return true;
    },
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, win.location.href),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, body });
      let result: any;
      if (url.pathname === '/api/devices') result = [device];
      else if (url.pathname === '/api/workspaces') result = [space];
      else if (url.pathname.endsWith('/hosts/host/sessions')) result = [metadata()];
      else if (url.pathname.includes('/sessions/'))
        result = {
          meta: metadata(),
          metaBundle: hostMeta.exportJson(),
          update: delta(hostDoc),
          online: true,
          synced: true,
          persisted: true,
          agent,
        };
      else if (url.pathname.endsWith('/agent-options'))
        result = {
          ...(body.agentId === 'other' ? other : agent),
          runConfig: syntheticCapabilities,
        };
      else if (url.pathname.endsWith('/roles/read')) {
        await waitRead?.();
        result = {
          rolesVersion: 1,
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          confirmed: true,
          catalogRevision: roleRevision,
          roles,
        };
      } else if (url.pathname.endsWith('/roles/action')) {
        const scope = {
          rolesVersion: 1,
          workspaceId: body.workspaceId ?? body.request.workspaceId,
          localProjectId: body.localProjectId ?? body.request.localProjectId,
          sessionId: body.sessionId ?? body.request.sessionId,
          confirmed: true,
        };
        if (body.action === 'inspect')
          result = {
            ...scope,
            action: 'inspect',
            operationId: body.request.operationId,
            found: receipts.has(body.request.operationId),
            ...(receipts.has(body.request.operationId)
              ? { receipt: receipts.get(body.request.operationId) }
              : {}),
          };
        else if (body.action === 'abandon') {
          if (!receipts.has(body.request.operationId))
            receipts.set(body.request.operationId, {
              ...scope,
              accepted: false,
              abandoned: true,
              operationId: body.request.operationId,
              action: body.request.action,
              catalogRevision: body.request.expectedRevision,
            });
          if (lostAbandon) throw Error('Synthetic lost abandon receipt');
          result = receipts.get(body.request.operationId);
        } else {
          assert.ok(
            [...storage.values()].some(
              (value: any) => value?.pending?.operationId === body.operationId,
            ),
            'role request is durable',
          );
          if (undelivered) throw Error('Synthetic role request never reached host');
          if (!receipts.has(body.operationId)) {
            const roleId = body.id ?? 'created-role';
            roleRevision++;
            roles =
              body.action === 'remove'
                ? roles.filter((role) => role.id !== roleId)
                : [
                    ...roles.filter((role) => role.id !== roleId),
                    {
                      id: roleId,
                      name: body.name,
                      revision: roleRevision,
                      agentId: body.agentId,
                      selection: body.selection,
                      instructions: body.instructions,
                      available: true,
                    },
                  ];
            receipts.set(body.operationId, {
              ...scope,
              accepted: true,
              operationId: body.operationId,
              action: body.action,
              catalogRevision: roleRevision,
              roleId,
            });
          }
          if (broadcastBeforeReceipt)
            SyntheticSocket.instances.at(-1)!.onmessage?.({
              data: JSON.stringify({
                type: 'changed',
                deviceId: 'device',
                workspaceId: 'runtime',
                room: { scope: 'doc' },
              }),
            });
          if (lost) throw Error('Synthetic lost role receipt');
          result = receipts.get(body.operationId);
        }
      } else if (url.pathname.endsWith('/mutations')) {
        assert.deepEqual(storage.get(cacheKey + '/pending'), body);
        if (!receipts.has(body.operationId)) {
          hostDoc.import(decode(body.update));
          hostMeta.importJson(body.metaBundle);
          receipts.set(body.operationId, {
            accepted: true,
            delivered: true,
            operationId: body.operationId,
          });
        }
        if (lost) throw Error('Synthetic lost turn receipt');
        result = receipts.get(body.operationId);
      } else assert.fail('Unexpected Roles app request ' + url.pathname);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/roles-app-')),
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
        name: 'synthetic-roles-boundaries',
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
                ? 'export const read=async key=>structuredClone(globalThis.__moorAppCache.get(key));export const write=async(key,value)=>{await globalThis.__moorTextWrite(key,value);};export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const compareText=(...args)=>globalThis.__moorTextCAS(...args); export const compareDraftBundle=(...args)=>globalThis.__moorBundleCAS(...args); export const clear=async()=>globalThis.__moorAppCache.clear();'
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
              '\nexport {openSession,sendTurn,currentAgent,openRoles,currentRoles,applyRoleDraft,runSelection};export {disposeUI} from "./ui";',
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
  const select = async (name = 'Review role') =>
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('.roles-list button')]
        .find((button) => button.textContent!.startsWith(name))!
        .click();
    });
  const applicationCount = () => field().value.split('Frozen role instructions').length - 1;
  try {
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    await act(() => SyntheticSocket.instances.at(-1)!.open());
    await act(async () => await (globalThis as any).__moorLastOperation);
    assert.equal(options().length, 0, 'opening custom ACP does not probe or launch it');
    await click('角色预设');
    await select();
    assert.equal(options().length, 0);
    assert.equal(button('确认应用到草稿').disabled, true);
    assert.match(document.querySelector('.roles-panel')!.textContent!, /模型已不可用/);
    await click('读取此 Agent 的模型选项（会启动 Agent）');
    assert.deepEqual(options()[0]!.body, { agentId: 'agent', sessionId: 'session' });
    assert.equal(button('确认应用到草稿').disabled, false);
    assert.equal(document.querySelector('.roles-panel script,.roles-panel img'), null);

    // During the fresh role read and an already queued draft save, keep subsequent typing.
    const readEntered = signal(),
      readRelease = signal(),
      writeEntered = signal(),
      writeRelease = signal();
    waitRead = async () => {
      readEntered.resolve();
      await readRelease.promise;
    };
    waitWrite = async () => {
      writeEntered.resolve();
      await writeRelease.promise;
    };
    await type('Pending typed input');
    await writeEntered.promise;
    let applying!: Promise<void>;
    await act(async () => {
      button('确认应用到草稿').click();
      applying = (globalThis as any).__moorLastOperation;
      await readEntered.promise;
    });
    await type('Latest typed input');
    await act(async () => {
      readRelease.resolve();
      writeRelease.resolve();
      await applying;
    });
    waitRead = waitWrite = undefined;
    assert.match(field().value, /^Latest typed input\n\n/);
    assert.equal(applicationCount(), 1);
    assert.deepEqual(app.runSelection, {
      modelId: 'model-a',
      reasoningEffort: 'high',
      modeId: 'read-only',
    });
    assert.deepEqual(
      (storage.get(cacheKey + '/run-options/agent') as any).selection,
      app.runSelection,
    );
    assert.equal([...storage.keys()].filter((key) => key.startsWith('role-applied-v1/')).length, 1);
    assert.equal(mutations().length, 0);
    await click('关闭角色预设');
    await click('角色预设');
    await select();
    assert.equal(button('确认应用到草稿').disabled, true);
    assert.match(document.querySelector('.roles-panel')!.textContent!, /已应用/);
    assert.equal(applicationCount(), 1);

    // A role version changes intentionally; rejected transaction must preserve both parts of the draft.
    roleRevision++;
    roles[0] = { ...roles[0], revision: roleRevision, instructions: 'Revised role instructions' };
    await click('重新读取角色');
    await select();
    const beforeText = field().value,
      beforeSelection = structuredClone(app.runSelection);
    failCAS = true;
    await click('确认应用到草稿');
    failCAS = false;
    assert.equal(field().value, beforeText);
    assert.deepEqual(app.runSelection, beforeSelection);
    const casEntered = signal(),
      casRelease = signal();
    waitCAS = async () => {
      casEntered.resolve();
      await casRelease.promise;
    };
    await act(async () => {
      button('确认应用到草稿').click();
      applying = (globalThis as any).__moorLastOperation;
      await casEntered.promise;
    });
    await type('Typing during the CAS must win');
    await act(async () => {
      casRelease.resolve();
      await applying;
    });
    waitCAS = undefined;
    assert.equal(field().value, 'Typing during the CAS must win');
    assert.deepEqual(app.runSelection, beforeSelection);

    // Another tab changing the target options after the comparison snapshot rejects the whole bundle.
    const raceEntered = signal(),
      raceRelease = signal();
    waitCAS = async () => {
      raceEntered.resolve();
      await raceRelease.promise;
    };
    await act(async () => {
      button('确认应用到草稿').click();
      applying = (globalThis as any).__moorLastOperation;
      await raceEntered.promise;
    });
    storage.set(cacheKey + '/run-options/agent', {
      base: 'seed',
      selection: { modelId: 'model-b' },
    });
    await act(async () => {
      raceRelease.resolve();
      await applying;
    });
    waitCAS = undefined;
    assert.equal(field().value, 'Typing during the CAS must win');
    assert.deepEqual(app.runSelection, beforeSelection);

    // Closing a panel or switching sessions cancels a late application without injecting text elsewhere.
    const closeEntered = signal(),
      closeRelease = signal();
    waitRead = async () => {
      closeEntered.resolve();
      await closeRelease.promise;
    };
    await act(async () => {
      button('确认应用到草稿').click();
      applying = (globalThis as any).__moorLastOperation;
      await closeEntered.promise;
    });
    await act(() => button('关闭角色预设').click());
    await act(async () => {
      closeRelease.resolve();
      await applying;
    });
    waitRead = undefined;
    assert.equal(field().value, 'Typing during the CAS must win');
    await click('角色预设');
    await select('Other Agent role');
    assert.equal(button('确认应用到草稿').disabled, true);
    assert.match(document.querySelector('.roles-panel')!.textContent!, /固定另一 Agent/);
    storage.set([owner, 'device', 'runtime', 'new', 'options'].join('/'), {
      project: 'second-project',
      agent: 'agent',
    });
    storage.set(
      [owner, 'device', 'runtime', 'new', 'draft'].join('/'),
      'Another project draft text',
    );
    await click('在新会话应用此角色');
    assert.equal(field().value, 'Another project draft text');
    assert.equal(
      app.currentRoles().target.localProjectId,
      'project',
      'the explicit new role flow keeps the source project even when old new-draft options chose another project',
    );
    assert.equal(app.currentAgent().id, 'agent');
    await click('确认应用到草稿');
    assert.equal(app.currentAgent().id, 'other');
    assert.match(field().value, /Other Agent instructions/);
    assert.equal(
      (storage.get([owner, 'device', 'runtime', 'new', 'options'].join('/')) as any).agent,
      'other',
    );
    const newText = field().value;
    await click('关闭角色预设');
    await act(() => app.openSession(''));
    assert.equal(app.currentAgent().id, 'other');
    assert.equal(field().value, newText);
    await click('角色预设');
    await select('Other Agent role');
    assert.equal(button('确认应用到草稿').disabled, true);

    // Explicit CRUD uses the reviewable editor, persists unknown, and inspects without a second save.
    await click('复制角色');
    await click('保存角色');
    assert.ok(app.currentRoles().pending);
    const original = structuredClone(app.currentRoles().pending);
    await click('关闭角色预设');
    await click('角色预设');
    assert.deepEqual(app.currentRoles().pending, original);
    const saveCount = requests.filter((call) => call.body?.action === 'save').length;
    await click('核查原角色操作');
    assert.equal(app.currentRoles().pending, undefined);
    assert.equal(requests.filter((call) => call.body?.action === 'save').length, saveCount);
    assert.equal(mutations().length, 0, 'role CRUD and application never send a prompt');
    await click('重新读取角色');
    await select('Other Agent role 副本');
    await click('编辑角色');
    const editor = document.querySelector<HTMLTextAreaElement>('.roles-detail textarea')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        editor,
        'Unsaved edited instructions',
      );
      editor.dispatchEvent(new win.Event('input', { bubbles: true }));
      SyntheticSocket.instances.at(-1)!.onmessage?.({
        data: JSON.stringify({
          type: 'changed',
          deviceId: 'device',
          workspaceId: 'runtime',
          room: { scope: 'doc' },
        }),
      });
    });
    assert.equal(app.currentRoles().list, undefined);
    assert.equal(
      editor.value,
      'Unsaved edited instructions',
      'catalog notifications preserve the manual editor',
    );
    await click('重新读取角色');
    lost = false;
    broadcastBeforeReceipt = true;
    await click('保存角色');
    assert.equal(
      app.currentRoles().pending,
      undefined,
      'our own catalog marker arriving before the HTTP receipt does not invalidate confirmation',
    );
    broadcastBeforeReceipt = false;
    assert.equal(
      document.querySelector('.roles-detail form'),
      null,
      'an accepted edit closes its submitted editor',
    );
    await click('重新读取角色');
    assert.equal(document.querySelector('.roles-detail form'), null);
    assert.match(
      document.querySelector('.roles-list [aria-pressed="true"]')!.textContent!,
      /Other Agent role 副本/,
    );
    await click('复制角色');
    await click('保存角色');
    const confirmedCreates = requests.filter(
      (call) => call.body?.action === 'save' && !call.body.id,
    ).length;
    assert.equal(
      document.querySelector('.roles-detail form'),
      null,
      'an accepted create leaves no reusable new-role form',
    );
    await click('重新读取角色');
    assert.equal(
      document.querySelector('.roles-detail form'),
      null,
      'refresh cannot re-enable a second create from the old form',
    );
    assert.equal(
      [...document.querySelectorAll('button')].some((button) => button.textContent === '保存角色'),
      false,
    );
    assert.equal(
      requests.filter((call) => call.body?.action === 'save' && !call.body.id).length,
      confirmedCreates,
    );
    lost = true;
    await click('重新读取角色');
    await select('Other Agent role');
    await click('复制角色');
    undelivered = true;
    await click('保存角色');
    const unreceived = structuredClone(app.currentRoles().pending);
    lostAbandon = true;
    await click('结束原角色操作');
    assert.equal(app.currentRoles().ending, true);
    await click('关闭角色预设');
    await click('角色预设');
    assert.deepEqual(app.currentRoles().pending, unreceived);
    assert.equal(app.currentRoles().ending, true);
    lostAbandon = false;
    await click('重试结束角色操作');
    assert.equal(app.currentRoles().pending, undefined);
    assert.equal(app.currentRoles().receipt.accepted, false);
    await click('重新读取角色');
    assert.equal(
      document.querySelector('.roles-list [aria-pressed="true"]'),
      null,
      'abandonment does not select an allegedly saved role',
    );
    assert.equal(
      requests.filter(
        (call) => call.body?.action === 'save' && call.body.operationId === unreceived.operationId,
      ).length,
      1,
    );
    assert.deepEqual(
      requests.filter((call) => call.body?.action === 'abandon').map((call) => call.body.request),
      [unreceived, unreceived],
    );
    undelivered = false;

    // The application freezes an ordinary prompt; its unknown delivery never adds the role again.
    await click('关闭角色预设');
    await act(() => app.openSession('session', 'replica'));
    await click('角色预设');
    await select();
    await click('读取此 Agent 的模型选项（会启动 Agent）');
    await click('确认应用到草稿');
    assert.match(field().value, /Revised role instructions/);
    const submittedText = field().value;
    await click('关闭角色预设');
    await click('发送指令');
    assert.equal(mutations().length, 1);
    const mutation = structuredClone(mutations()[0]!.body);
    assert.deepEqual(storage.get(cacheKey + '/pending'), mutation);
    const sent = mirror(hostDoc, 'session');
    const input = sent.getState().history.at(-1)!.inputConfig as any;
    assert.equal(input.prompt, submittedText);
    assert.equal(input.modelId, 'model-a');
    assert.equal(input.modeId, 'read-only');
    assert.deepEqual(input.configOptionValues, { reasoning_effort: 'high' });
    sent.dispose();
    await act(() => app.openSession('session', 'replica'));
    assert.equal(mutations().length, 1, 'restoring a role draft never sends');
    lost = false;
    await click('重试确认');
    assert.deepEqual(mutations()[1]!.body, mutation);
    assert.equal(field().value, '');
  } finally {
    await act(() => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
