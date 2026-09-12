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
test('actual Tasks app reviews without execution, stages the parent plan atomically and retries only its original mutation', async () => {
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
      runConfig: syntheticCapabilities,
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
    features: ['agent-versions-v1', 'session-tasks-v1', 'git-worktree-v1'],
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
  const childMeta = {
    ...metadata(),
    id: 'task-child',
    title: 'Task child',
    taskOrigin: {
      version: 1,
      grantId: 'grant',
      parentSessionId: 'session',
      parentUserTurnId: 'parent-user',
      parentAssistantTurnId: 'parent-assistant',
      taskId: 'task',
      completion: 'Review fixture',
    },
  };
  putMeta(hostMeta, 'session-task-child', childMeta);
  const documents = new Map<string, LoroDoc>([
    ['session', hostDoc],
    ['task-child', new LoroDoc()],
  ]);
  const requests: { path: string; body: any }[] = [],
    receipts = new Map<string, any>();
  let grants: any[] = [];
  let lost = true,
    failCAS = false,
    rejectRetry = false;
  let waitMutation: undefined | (() => Promise<void>);
  const oid = 'a'.repeat(40);
  Object.assign(globalThis, {
    __moorAppCache: storage,
    __moorNotificationLocal: { version: 1, revision: 0, records: [] },
    __moorSchedule: () => 1,
    __moorTextWrite: async (key: string, value: unknown) =>
      storage.set(key, structuredClone(value)),
    __moorTextCAS: async () => {
      throw Error('not expected');
    },
    __moorBundleCAS: async (
      entries: { key: string; expected: unknown; value: unknown }[],
      current: () => boolean,
    ) => {
      assert.equal(entries.length, 2, 'task delivery and original mutation are one transaction');
      if (failCAS) throw Error('synthetic storage failure');
      if (!current()) throw Error('scope changed');
      if (entries.some((e) => JSON.stringify(storage.get(e.key)) !== JSON.stringify(e.expected)))
        return false;
      for (const e of entries) storage.set(e.key, structuredClone(e.value));
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
        result = Object.values(metas(hostMeta));
      else if (url.pathname.includes('/sessions/')) {
        const id = url.pathname.split('/').at(-1)!;
        result = {
          meta: metas(hostMeta)['session-' + id],
          metaBundle: hostMeta.exportJson(),
          update: delta(documents.get(id) ?? new LoroDoc()),
          online: true,
          synced: true,
          persisted: true,
          agent,
        };
      } else if (url.pathname.endsWith('/git/state'))
        result = {
          ...body,
          confirmed: true,
          repository: {
            kind: 'git',
            branch: 'main',
            headOid: oid,
            branches: [{ name: 'main', oid }],
            changes: [],
            dirty: false,
            partial: false,
            outsideProjectChanges: false,
            version: 'sha256:' + 'a'.repeat(64),
            issues: [],
            writeSupported: true,
          },
          execution: { mode: 'shared', status: 'ready', revision: 0 },
          canPrepare: true,
          canRemove: false,
        };
      else if (url.pathname.endsWith('/tasks-read'))
        result = { ...body, confirmed: true, grants, truncated: false };
      else if (url.pathname.endsWith('/tasks-action')) {
        const grant = structuredClone(grants[0]);
        if (body.action === 'inspect') grant.operations[0].state = 'abandoned';
        else if (body.action === 'cleanup') {
          assert.ok(
            [...storage.values()].some((v: any) => v?.pending?.operationId === body.operationId),
          );
          grant.tasks[0].execution = {
            ...grant.tasks[0].execution,
            status: 'removed',
            revision: 2,
            disposition: 'removed',
          };
          grant.operations.push({
            operationId: body.operationId,
            taskId: body.taskId,
            kind: 'cleanup',
            state: 'accepted',
          });
        } else assert.fail('unexpected task action');
        grants = [grant];
        result = {
          ...body,
          confirmed: true,
          grant,
          operation: grant.operations.find((op: any) => op.operationId === body.operationId),
        };
      } else if (url.pathname.endsWith('/agent-options')) result = agent;
      else if (url.pathname.endsWith('/mutations')) {
        assert.deepEqual(
          storage.get(
            [
              owner,
              'device',
              'runtime',
              body.sessionId === 'session' ? 'session' : 'new',
              'pending',
            ].join('/'),
          ),
          body,
        );
        assert.ok(
          [...storage.values()].some((v: any) => v?.delivery?.operationId === body.operationId),
          'task authorization is durable before dispatch',
        );
        await waitMutation?.();
        if (rejectRetry)
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: 'Synthetic pre-dispatch rejection', rejected: true }),
          };
        if (!receipts.has(body.operationId)) {
          let document = documents.get(body.sessionId);
          if (!document) {
            document = new LoroDoc();
            documents.set(body.sessionId, document);
          }
          document.import(decode(body.update));
          hostMeta.importJson(body.metaBundle);
          receipts.set(body.operationId, {
            accepted: true,
            delivered: true,
            operationId: body.operationId,
          });
        }
        if (lost) throw Error('synthetic lost parent receipt');
        result = receipts.get(body.operationId);
      } else assert.fail('Unexpected Tasks app request ' + url.pathname);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/tasks-app-')),
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
        name: 'synthetic-tasks-boundaries',
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
                ? 'export const read=async key=>structuredClone(globalThis.__moorAppCache.get(key));export const write=async(key,value)=>{await globalThis.__moorTextWrite(key,value);};export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const compareText=(...args)=>globalThis.__moorTextCAS(...args); export const compareDraftBundle=(...args)=>globalThis.__moorBundleCAS(...args); export const compareTaskSubmission=(...args)=>globalThis.__moorBundleCAS(...args); export const clear=async()=>globalThis.__moorAppCache.clear();'
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
              '\nexport {openSession,sendTurn,currentAgent,openTasks,currentTasks,reviewTasks,runSelection};export {disposeUI} from "./ui";',
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
  const draft = {
    version: 1 as const,
    tasks: [
      {
        taskId: 'task',
        title: 'Review <img src=x onerror=bad()>',
        agentId: 'agent',
        instruction: 'Read synthetic files only',
        completion: 'Return a report',
        baseBranch: 'main',
        expectedOid: oid,
      },
    ],
    maxParallel: 1,
    maxTurnsPerTask: 1,
    timeoutMs: 60000,
    onParentEnd: 'cancel' as const,
  };
  async function enablePlan() {
    await act(() => app.currentTasks().edit(draft));
    await click('协作任务');
    await act(async () => {
      await app.reviewTasks();
    });
    await click('审查本次任务计划');
    await click('启用本次任务计划');
    assert.ok(app.currentTasks().enabled);
    await click('关闭协作任务');
  }
  try {
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    await act(() => SyntheticSocket.instances.at(-1)!.open());
    await act(async () => await (globalThis as any).__moorLastOperation);
    assert.equal(options().length, 0);
    await enablePlan();
    assert.equal(options().length, 0);
    assert.equal(mutations().length, 0);
    await click('查看');
    assert.equal(mutations().length, 0, 'composer card is not a form submit');
    assert.equal(document.querySelector('.tasks-panel img,.tasks-panel script'), null);
    await click('关闭协作任务');
    assert.match(field().value, /Keep my original input/);
    await click('发送指令');
    assert.equal(mutations().length, 1);
    const original = structuredClone(mutations()[0]!.body),
      sent = mirror(hostDoc, 'session'),
      input = sent.getState().history.at(-1)!.inputConfig as any;
    sent.dispose();
    assert.equal(input.taskToolsEnabled, true);
    assert.deepEqual(input.taskPlan, draft);
    assert.equal(input.prompt, 'Keep my original input');
    await act(() => app.openSession('session', 'replica'));
    assert.equal(mutations().length, 1);
    assert.equal(app.currentTasks().delivery.operationId, original.operationId);
    rejectRetry = true;
    await click('重试确认');
    assert.deepEqual(storage.get(cacheKey + '/pending'), original);
    assert.equal(
      app.currentTasks().delivery.operationId,
      original.operationId,
      'late predispatch rejection cannot erase original unknown',
    );
    rejectRetry = false;
    lost = false;
    await click('重试确认');
    assert.deepEqual(mutations().at(-1)!.body, original);
    assert.equal(app.currentTasks().delivery, undefined);
    assert.equal(app.currentTasks().enabled, undefined);
    assert.equal(field().value, '');
    // A prepared worktree with no child history remains reviewable and manually cleanable.
    grants = [
      {
        grantId: 'grant',
        parentSessionId: 'session',
        parentUserTurnId: 'parent-user',
        parentAssistantTurnId: 'parent-assistant',
        state: 'interrupted',
        createdAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-01-01T01:00:00Z',
        plan: draft,
        tasks: [
          {
            taskId: 'task',
            childSessionId: 'uncreated-child',
            sessionCreated: false,
            title: draft.tasks[0]!.title,
            agentId: 'agent',
            completion: draft.tasks[0]!.completion,
            status: 'unknown',
            turnsUsed: 0,
            execution: {
              mode: 'worktree',
              status: 'ready',
              revision: 1,
              executionId: 'task-execution',
            },
            goalVerified: false,
          },
        ],
        operations: [
          { operationId: 'create-op', taskId: 'task', kind: 'create', state: 'unknown' },
        ],
      },
    ];
    await click('协作任务');
    await click('读取任务状态');
    assert.equal(button('清理此任务工作目录').disabled, true);
    assert.equal(
      [...document.querySelectorAll('button')].some((b) => b.textContent === '打开子会话'),
      false,
    );
    await click('核查原操作');
    assert.equal(button('清理此任务工作目录').disabled, false);
    await click('清理此任务工作目录');
    assert.equal(
      requests.filter((r) => r.path.endsWith('/tasks-action')).length,
      1,
      'cleanup requires final review',
    );
    await click('确认此操作');
    const cleanup = requests.filter((r) => r.path.endsWith('/tasks-action')).at(-1)!.body;
    assert.equal(cleanup.action, 'cleanup');
    assert.equal(cleanup.taskId, 'task');
    assert.equal(cleanup.expectedExecutionRevision, 1);
    assert.match(document.querySelector('.tasks-panel')!.textContent!, /removed/);
    await click('关闭协作任务');
    // Child sessions may be read and navigated, but cannot authorize a second level.
    await act(() => app.openSession('task-child', 'replica'));
    await click('协作任务');
    assert.match(document.querySelector('.tasks-panel')!.textContent!, /子任务会话不能/);
    assert.equal(button('添加子任务').disabled, true);
    await click('关闭协作任务');
    // Stable empty parent ID survives refresh and a failed transaction never sends.
    await act(() => app.openSession('', 'replica'));
    await enablePlan();
    const newId = app.currentTasks().target.sessionId;
    await act(() => app.openSession('', 'replica'));
    assert.equal(app.currentTasks().target.sessionId, newId);
    assert.ok(app.currentTasks().enabled);
    await type('New parent instruction');
    const count = mutations().length;
    failCAS = true;
    await click('发送指令');
    assert.equal(mutations().length, count);
    assert.match(field().value, /New parent instruction/);
    assert.equal(storage.get([owner, 'device', 'runtime', 'new', 'pending'].join('/')), undefined);
    failCAS = false;
    await act(() => app.openSession('', 'replica'));
    assert.ok(app.currentTasks().enabled);
    await click('发送指令');
    assert.equal(mutations().length, count + 1);
    assert.equal(mutations().at(-1)!.body.sessionId, newId);
    assert.equal(field().value, '');
    // Late accepted response is retained in its original outbox when navigating away.
    await act(() => app.openSession('session', 'replica'));
    await enablePlan();
    await type('Late parent');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      released = new Promise<void>((r) => (release = r));
    waitMutation = async () => {
      entered();
      await released;
    };
    let sending!: Promise<void>;
    await act(async () => {
      button('发送指令').click();
      sending = (globalThis as any).__moorLastOperation;
      await started;
    });
    await act(() => app.openSession('task-child', 'replica'));
    await act(async () => {
      release();
      await sending;
    });
    assert.equal(field().value, '');
    assert.ok(storage.get(cacheKey + '/pending'));
    assert.ok(
      [...storage.values()].some((v: any) => v?.target?.sessionId === 'session' && v?.delivery),
    );
    waitMutation = undefined;
    await act(() => app.openSession('session', 'replica'));
    await click('重试确认');
    assert.equal(app.currentTasks().delivery, undefined);
  } finally {
    await act(() => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
