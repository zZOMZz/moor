import test from 'node:test';
import { previewRequestVersion } from '../src/web/project-preview';
import { previewFrame, previewSignal, previewVersion } from './support/preview-fixture';
import assert from 'node:assert/strict';
import { createRequire as createPackageRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { Flock, LoroDoc, delta, decode, encode, metas, mirror, putMeta } from '../src/model';
import { syntheticCapabilities } from './support/agent-capabilities';

// Exercise the real controller and React UI. Only storage and transport are
// synthetic; deferred responses reproduce ordering races without elapsed time.
test('actual preview app freezes annotations, preserves scoped new drafts, and confirms exactly the original sent selection', async () => {
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
        inputCapabilities: { image: true, audio: false, embeddedContext: true },
      },
    ],
    features: [
      'session-actions',
      'git-worktree-v1',
      'session-fork-v1',
      'github-read-v1',
      'github-write-v1',
      'project-preview-v1',
      'attachments-v1',
    ],
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
  const draft = 'Keep my existing unsent input';
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

  const requests: { path: string; body: any }[] = [],
    mutationReceipts = new Map<string, any>();
  const documents = new Map([[sessionId, hostDoc]]),
    attachments = new Map<string, any>();
  let lostMutation = true,
    wrongMutation = false,
    frame = previewFrame();
  Object.assign(globalThis, {
    __moorNotificationLocal: { version: 1, revision: 0, records: [] },
    __moorSchedule: (_callback: () => void) => 1,
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
        const id = url.pathname.split('/sessions/')[1];
        result = {
          meta: metas(hostMeta)['session-' + id],
          metaBundle: hostMeta.exportJson(),
          update: delta(documents.get(id)!),
          online: true,
          synced: true,
          persisted: true,
        };
      } else if (url.pathname.endsWith('/git/state'))
        result = {
          gitVersion: 1,
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          confirmed: true,
          execution: { mode: 'shared', status: 'ready', revision: 0 },
          canPrepare: false,
          canRemove: false,
        };
      else if (url.pathname.endsWith('/preview/read')) {
        const scope = {
          previewVersion: 1,
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          view: body.view,
          confirmed: true,
        };
        if (body.view === 'options')
          result = {
            ...scope,
            available: true,
            execution: { mode: 'shared', status: 'ready', revision: 0 },
            services: [
              {
                id: 'service',
                label: 'Synthetic preview',
                version: previewVersion,
                startPath: '/',
              },
            ],
          };
        else {
          const instance = { ...scope, clientId: body.clientId, previewId: body.previewId };
          if (body.view === 'frame') result = { ...instance, frame, expiresAt: 100000 };
          else if (body.view === 'status')
            result = { ...instance, status: 'open', expiresAt: 100000 };
          else
            result = {
              ...instance,
              frameId: body.frameId,
              element: {
                elementId: 'element',
                frameId: body.frameId,
                tag: 'button',
                role: 'button',
                name: '<img src=x> save',
                text: '<script>page text</script>',
                rect: { x: 20, y: 20, width: 60, height: 30 },
                editable: false,
                password: false,
              },
            };
        }
      } else if (/\/preview\/(action|inspect|close)$/.test(url.pathname)) {
        const request = body.request ?? body,
          close = url.pathname.endsWith('/close');
        if (url.pathname.endsWith('/action')) {
          const stored = [...storage.values()].find(
            (v: any) => v?.pending?.operationId === request.operationId,
          ) as any;
          assert.ok(stored, 'action was durable before request');
          assert.deepEqual(stored.pending, request);
          frame = previewFrame(
            'preview-' + request.sessionId,
            'frame-' + request.operationId,
            request.viewport ?? frame.viewport,
          );
        }
        result = {
          previewVersion: 1,
          workspaceId: request.workspaceId,
          localProjectId: request.localProjectId,
          sessionId: request.sessionId,
          clientId: request.clientId,
          operationId: request.operationId,
          requestVersion: await previewRequestVersion(request),
          action: request.action,
          phase: close ? 'closed' : 'accepted',
          closed: close,
          previewId: frame.previewId,
          message: 'Synthetic preview receipt',
          checkedAt: frame.capturedAt,
          ...(!close ? { frame } : {}),
        };
      } else if (url.pathname.endsWith('/attachment-actions')) {
        assert.equal(body.action, 'upload');
        attachments.set(body.attachment.attachmentId, body);
        result = {
          contentVersion: 1,
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          operationId: body.operationId,
          accepted: true,
          delivered: true,
          attachment: body.attachment,
        };
      } else if (url.pathname.endsWith('/mutations')) {
        const record = storage.get(
          [
            owner,
            device.id,
            runtime.id,
            body.sessionId === sessionId ? sessionId : 'new',
            'pending',
          ].join('/'),
        ) as any;
        assert.deepEqual(
          record.mutation,
          body,
          'local envelope is atomic and only its mutation reaches the host',
        );
        assert.equal(record.annotationDelivery.operationId, body.operationId);
        assert.equal(record.annotationDelivery.submission.target.sessionId, body.sessionId);
        if (!mutationReceipts.has(body.operationId)) {
          const doc = documents.get(body.sessionId) ?? new LoroDoc();
          documents.set(body.sessionId, doc);
          doc.import(decode(body.update));
          hostMeta.importJson(body.metaBundle);
          mutationReceipts.set(body.operationId, {
            accepted: true,
            delivered: true,
            operationId: body.operationId,
          });
        }
        if (lostMutation) throw new Error('Synthetic response lost after host persistence');
        result = {
          ...mutationReceipts.get(body.operationId),
          operationId: wrongMutation ? 'wrong' : body.operationId,
        };
      } else assert.fail('Unexpected preview app request ' + url.pathname);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/project-preview-app-')),
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
        name: 'synthetic-preview-boundaries',
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
                ? 'export const read=async key=>structuredClone(globalThis.__moorAppCache.get(key));export const write=async(key,value)=>{globalThis.__moorAppCache.set(key,structuredClone(value));};export const compareWrite=async(key,expectedRevision,value,current)=>{if(key.startsWith("preview-annotations-v1/")&&globalThis.__moorAnnotationWriteGate){globalThis.__moorAnnotationWriteEntered();await globalThis.__moorAnnotationWriteGate;}if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const clear=async()=>globalThis.__moorAppCache.clear();'
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
              '\nexport {openProjectPreview,currentProjectPreview,currentPreviewAnnotations,currentAttachments,openSession,sendTurn,resetProjectPreview};export {disposeUI} from "./ui";',
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

  const mutations = () => requests.filter((v) => v.path.endsWith('/mutations'));
  const actions = () => requests.filter((v) => v.path.endsWith('/preview/action'));
  const stableKey =
    'attachment-session-v1/' + JSON.stringify([owner, device.id, runtime.id, 'local-project']);
  storage.set(stableKey, 'new-preview-draft');
  const noteField = () =>
    [...document.querySelectorAll<HTMLLabelElement>('.project-preview-panel label')]
      .find((v) => v.textContent?.startsWith('标注说明'))!
      .querySelector<HTMLTextAreaElement>('textarea')!;
  async function note(value: string) {
    await act(() => {
      const input = noteField();
      Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        value,
      );
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    });
  }
  const selectProject = async (name: string) => {
    await act(() => document.querySelector<HTMLButtonElement>('#project')!.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role=option]')].find(
      (v) => v.textContent === name,
    );
    assert.ok(option);
    await act(async () => {
      option.click();
      await (globalThis as any).__moorGitProjectChange;
    });
  };
  try {
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    await act(() => SyntheticSocket.instances.at(-1)!.open());
    await act(async () => await (globalThis as any).__moorLastOperation);
    await click('网页预览');
    assert.equal(actions().length, 0);
    await act(() => {
      const input = [...document.querySelectorAll<HTMLLabelElement>('.project-preview-panel label')]
        .find((v) => v.textContent?.startsWith('视口'))!
        .querySelector<HTMLSelectElement>('select')!;
      input.value = JSON.stringify({ width: 390, height: 844 });
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    await click('连接预览');
    assert.equal(actions().length, 1);
    await click('定位画面中心元素');
    assert.equal(document.querySelector('.preview-element script'), null);
    assert.equal(document.querySelector('.preview-element img'), null);
    assert.match(
      document.querySelector('.preview-element')!.textContent!,
      /<script>page text<\/script>/,
    );
    await note('First frozen annotation');
    const imageCheckbox = [
      ...document.querySelectorAll<HTMLLabelElement>('.project-preview-panel label'),
    ]
      .find((v) => v.textContent?.includes('在本地标注中保存'))!
      .querySelector<HTMLInputElement>('input')!;
    await act(() => imageCheckbox.click());
    const entered = previewSignal(),
      release = previewSignal();
    Object.assign(globalThis, {
      __moorAnnotationWriteGate: release.promise,
      __moorAnnotationWriteEntered: entered.resolve,
    });
    await act(async () => {
      button('保存冻结标注').click();
      await entered.promise;
    });
    await note('New note typed while the previous save waits');
    (globalThis as any).__moorAnnotationWriteGate = undefined;
    await act(async () => {
      release.resolve();
      await app.currentPreviewAnnotations().settled();
    });
    assert.equal(noteField().value, 'New note typed while the previous save waits');
    assert.equal(app.currentPreviewAnnotations().items[0].snapshot.note, 'First frozen annotation');
    await click('加入原会话草稿');
    assert.match(
      document.querySelector('.preview-composer-cards')!.textContent!,
      /First frozen annotation/,
    );
    assert.equal(field().value, draft);
    assert.equal(storage.get(cacheKey + '/draft'), draft);
    await click('将截图作为附件');
    assert.equal(app.currentAttachments().items.length, 1);
    assert.equal(app.currentAttachments().items[0].uploaded, false);
    assert.equal(requests.filter((v) => v.path.endsWith('/attachment-actions')).length, 0);
    assert.equal(mutations().length, 0);
    await click('关闭网页预览面板');
    await click('发送指令');
    assert.equal(mutations().length, 1);
    assert.equal(mutationReceipts.size, 1);
    const original = structuredClone(mutations()[0].body),
      record = storage.get(cacheKey + '/pending') as any;
    assert.equal(record.previewDraftVersion, 1);
    assert.deepEqual(record.mutation, original);
    assert.equal(record.annotationDelivery.submission.selection.length, 1);
    assert.equal(app.currentPreviewAnnotations().selected.length, 1);
    assert.equal(field().value, draft);
    assert.equal(requests.filter((v) => v.path.endsWith('/attachment-actions')).length, 1);
    const sent = mirror(documents.get(sessionId)!, sessionId);
    const turn = sent.getState().history.at(-1)!;
    assert.match((turn.inputConfig as any).prompt, /Keep my existing unsent input/);
    assert.match((turn.inputConfig as any).prompt, /First frozen annotation/);
    assert.equal((turn.items ?? []).filter((v: any) => v.type === 'attachment').length, 1);
    sent.dispose();
    const beforeRefreshActions = actions().length;
    await act(() => app.openSession(''));
    await act(() => app.openSession(sessionId));
    assert.equal(actions().length, beforeRefreshActions);
    assert.equal(mutations().length, 1);
    assert.equal(app.currentPreviewAnnotations().selected.length, 1);
    lostMutation = false;
    wrongMutation = true;
    await click('重试确认');
    assert.equal(app.currentPreviewAnnotations().selected.length, 1);
    wrongMutation = false;
    await click('重试确认');
    assert.equal(mutationReceipts.size, 1);
    for (const request of mutations()) assert.deepEqual(request.body, original);
    assert.equal(app.currentPreviewAnnotations().selected.length, 0);
    assert.equal(app.currentPreviewAnnotations().items.length, 1);
    assert.equal(field().value, '');
    assert.equal(storage.get(cacheKey + '/pending'), undefined);
    await act(() => app.openSession(''));
    assert.equal(app.currentPreviewAnnotations().target.sessionId, 'new-preview-draft');
    await click('网页预览');
    await click('连接预览');
    await click('定位画面中心元素');
    await note('Only the original new project gets this annotation');
    await act(async () => {
      button('保存冻结标注').click();
      await app.currentPreviewAnnotations().settled();
    });
    await click('加入原会话草稿');
    await click('关闭网页预览面板');
    assert.equal(field().value, '');
    await selectProject('Second project');
    assert.equal(app.currentPreviewAnnotations().selected.length, 0);
    assert.equal(document.querySelector('.preview-composer-cards'), null);
    assert.equal(field().value, '');
    await selectProject('Synthetic project');
    assert.equal(app.currentPreviewAnnotations().target.sessionId, 'new-preview-draft');
    assert.equal(app.currentPreviewAnnotations().selected.length, 1);
    const beforeNew = mutations().length;
    await click('发送指令');
    assert.equal(mutations().length, beforeNew + 1);
    assert.equal(mutations().at(-1)!.body.sessionId, 'new-preview-draft');
    assert.equal(app.currentPreviewAnnotations().selected.length, 0);
    const newView = mirror(documents.get('new-preview-draft')!, 'new-preview-draft');
    assert.match(
      (newView.getState().history.at(-1)!.inputConfig as any).prompt,
      /Only the original new project/,
    );
    newView.dispose();
    await click('网页预览');
    await click('连接预览');
    assert.ok(app.currentProjectPreview().frame);
    const priorActions = actions().length;
    await act(() => SyntheticSocket.instances.at(-1)!.onclose?.());
    assert.equal(app.currentProjectPreview().frame, undefined);
    assert.equal(actions().length, priorActions);
  } finally {
    await act(async () => {
      app.resetProjectPreview();
      await app.disposeUI();
    });
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
