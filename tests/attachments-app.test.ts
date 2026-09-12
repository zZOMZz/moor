import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire as createPackageRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { Flock, LoroDoc, decode, delta, metas, mirror, putMeta } from '../src/model';
import type { Mutation } from '../src/protocol';
import type { AttachmentAction } from '../src/attachment-protocol';
import type { AttachmentReference } from '../src/content-protocol';
import { attachmentDraftKey } from '../src/web/attachments';
import { syntheticCapabilities } from './support/agent-capabilities';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('real app preserves attachment-only new drafts and scoped manual delivery across reloads, offline states and target switches', async () => {
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
  const runtimes = ['a', 'b'].map((name) => ({
    id: 'runtime-' + name,
    name: 'Synthetic runtime ' + name,
    userId: 'synthetic-user',
    machineId: 'machine-' + name,
    projects: [
      {
        id: 'local-project-' + name,
        name: 'Synthetic project ' + name,
        rootPath: '/synthetic/' + name,
      },
    ],
    agents: [
      {
        id: 'agent',
        name: 'Synthetic agent',
        cliType: 'builtin',
        agentType: 'codex',
        runConfig: syntheticCapabilities,
        inputCapabilities: { image: true, audio: true, embeddedContext: true },
      },
    ],
    features: ['session-actions', 'attachments-v1'],
  }));
  const devices = runtimes.map((runtime, index) => ({
    id: 'device-' + ['a', 'b'][index],
    name: 'Synthetic Mac ' + index,
    online: true,
    workspaces: [runtime],
  }));
  const space = {
    id: 'catalog',
    name: 'Synthetic workspace',
    hosts: devices.map((device, index) => ({
      id: 'host-' + ['a', 'b'][index],
      deviceId: device.id,
      machineId: runtimes[index].machineId,
      runtimeWorkspaceId: runtimes[index].id,
      name: device.name,
      online: true,
      agents: runtimes[index].agents,
    })),
    projects: ['a', 'b'].map((name) => ({
      id: 'project-' + name,
      name: 'Synthetic project ' + name,
      source: { kind: 'local' },
    })),
    replicas: ['a', 'b'].map((name) => ({
      id: 'replica-' + name,
      projectId: 'project-' + name,
      hostId: 'host-' + name,
      localProjectId: 'local-project-' + name,
      rootPath: '/synthetic/' + name,
      available: true,
    })),
  };
  const storage = new Map<string, unknown>([
    [
      owner + '/view',
      {
        deviceId: 'device-a',
        workspaceId: 'runtime-a',
        catalogWorkspaceId: 'catalog',
        replicaId: 'replica-a',
        sessionId: '',
      },
    ],
  ]);
  Object.assign(globalThis, { __moorAttachmentAppCache: storage });
  const sessions = new Map<string, { replicaId: string; doc: LoroDoc; flock: Flock }>();
  const savedAttachments = new Map<string, Extract<AttachmentAction, { action: 'upload' }>>();
  const actions: AttachmentAction[] = [],
    mutations: Mutation[] = [];
  const existing = { replicaId: 'replica-b', doc: new LoroDoc(), flock: new Flock() };
  putMeta(existing.flock, 'session-existing-b', {
    id: 'existing-b',
    title: 'Synthetic existing B',
    machineId: 'machine-b',
    userId: 'synthetic-user',
    project: { kind: 'local', localProjectId: 'local-project-b' },
    cliType: 'builtin',
    agentType: 'codex',
    agentConfigId: 'agent',
    metadataRevision: 0,
    status: { type: 'idle' },
  });
  sessions.set('existing-b', existing);
  let uploadGate:
    | { started: ReturnType<typeof signal>; release: ReturnType<typeof signal>; lose?: boolean }
    | undefined;
  let mutationGate:
    | { started: ReturnType<typeof signal>; release: ReturnType<typeof signal> }
    | undefined;
  let mutationReceiptOverride: Record<string, unknown> | undefined;
  const metaOf = (id: string) => metas(sessions.get(id)!.flock)['session-' + id];
  Object.assign(globalThis, {
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, win.location.href);
      let result: unknown;
      if (url.pathname === '/api/devices') result = devices;
      else if (url.pathname === '/api/workspaces') result = [space];
      else if (/\/hosts\/host-[ab]\/sessions$/.test(url.pathname)) {
        const replica = 'replica-' + url.pathname.split('/').at(-2)!.slice(-1);
        result = [...sessions.entries()]
          .filter(([, value]) => value.replicaId === replica)
          .map(([id]) => metaOf(id));
      } else if (url.pathname.includes('/sessions/')) {
        const id = url.pathname.split('/').at(-1)!;
        const stored = sessions.get(id)!;
        assert.ok(stored, 'only persisted synthetic sessions can be read');
        result = {
          meta: metaOf(id),
          metaBundle: stored.flock.exportJson(),
          update: delta(stored.doc),
          online: true,
          synced: true,
        };
      } else if (url.pathname.endsWith('/attachment-actions')) {
        const action = JSON.parse(String(init!.body)) as AttachmentAction;
        const pending = [...storage.values()].some((entry: any) =>
          entry?.items?.some(
            (item: any) => item.pending?.request.operationId === action.operationId,
          ),
        );
        assert.equal(
          pending,
          true,
          'the real app persisted its attachment outbox before transmission',
        );
        actions.push(structuredClone(action));
        assert.equal(
          url.pathname,
          `/api/workspaces/catalog/replicas/replica-${action.workspaceId.slice(-1)}/attachment-actions`,
        );
        if (action.action === 'upload')
          savedAttachments.set(action.attachment.attachmentId, structuredClone(action));
        else savedAttachments.delete(action.attachmentId);
        const gate = uploadGate;
        uploadGate = undefined;
        if (gate) {
          gate.started.resolve();
          await gate.release.promise;
          if (gate.lose) throw new Error('synthetic response lost');
        }
        const { contentVersion, workspaceId, localProjectId, sessionId, operationId } = action;
        result = {
          contentVersion,
          workspaceId,
          localProjectId,
          sessionId,
          operationId,
          accepted: true,
          delivered: true,
          ...(action.action === 'upload' ? { attachment: action.attachment } : { removed: true }),
        };
      } else if (url.pathname.endsWith('/mutations')) {
        const mutation = JSON.parse(String(init!.body)) as Mutation;
        mutations.push(structuredClone(mutation));
        let stored = sessions.get(mutation.sessionId);
        if (!stored) {
          stored = {
            replicaId: 'replica-' + mutation.workspaceId.slice(-1),
            doc: new LoroDoc(),
            flock: new Flock(),
          };
          sessions.set(mutation.sessionId, stored);
        }
        stored.doc.import(decode(mutation.update));
        stored.flock.importJson(mutation.metaBundle as never);
        const view = mirror(stored.doc, mutation.sessionId);
        const turn = view.getState().history.at(-1)!;
        const input = turn.inputConfig as { attachments?: AttachmentReference[] };
        assert.ok(input.attachments?.length, 'this fixture receives attachment-only prompts');
        for (const reference of input.attachments!)
          assert.ok(savedAttachments.has(reference.attachmentId));
        view.dispose();
        const gate = mutationGate;
        mutationGate = undefined;
        if (gate) {
          gate.started.resolve();
          await gate.release.promise;
        }
        result = {
          accepted: true,
          delivered: true,
          operationId: mutation.operationId,
          ...mutationReceiptOverride,
        };
        mutationReceiptOverride = undefined;
      } else if (url.pathname.endsWith('/attachments/read')) {
        const input = JSON.parse(String(init!.body));
        const stored = savedAttachments.get(input.attachmentId)!;
        assert.equal(stored.sessionId, input.sessionId);
        result = {
          contentVersion: 1,
          confirmed: true,
          workspaceId: stored.workspaceId,
          localProjectId: stored.localProjectId,
          sessionId: stored.sessionId,
          attachment: stored.attachment,
          data: stored.data,
        };
      } else assert.fail('Unexpected synthetic request: ' + path);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  const { build } = createPackageRequire(join(process.cwd(), 'package.json'))(
    'esbuild',
  ) as typeof import('esbuild');
  await mkdir(join(process.cwd(), 'dist/tests'), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/attachments-app-'));
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
      js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);",
    },
    plugins: [
      {
        name: 'synthetic-attachment-app-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/cache$/ }, () => ({
            path: 'cache',
            namespace: 'synthetic',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({
            loader: 'js',
            contents: `export const read=async key=>structuredClone(globalThis.__moorAttachmentAppCache.get(key)); export const write=async (key,value)=>{globalThis.__moorAttachmentAppCache.set(key,structuredClone(value));}; export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAttachmentAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const clear=async()=>globalThis.__moorAttachmentAppCache.clear();`,
          }));
          builder.onLoad({ filter: /\/src\/web\/app\.ts$/ }, async (args) => ({
            loader: 'ts',
            resolveDir: resolve('src/web'),
            contents:
              (await readFile(args.path, 'utf8')) +
              '\nexport { loadDevices, loadSessions, selectDevice, openSession, currentAttachments, sendTurn, addAttachments, openHistoryAttachment }; export { disposeUI } from "./ui";\n',
          }));
        },
      },
    ],
  });
  const app = await import(pathToFileURL(outfile).href);
  const { act } = await import('react');
  const field = () => document.querySelector<HTMLTextAreaElement>('#prompt')!;
  const boot = async () => {
    await act(async () => {
      await app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner));
    });
    await act(async () => SyntheticSocket.instances.at(-1)!.open());
  };
  const choose = async (name: 'a' | 'b', sessionId = '') => {
    await act(async () =>
      app.selectDevice('device-' + name, {
        workspaceId: 'runtime-' + name,
        sessionId,
        replicaId: 'replica-' + name,
      }),
    );
  };
  const scopeA = (id: string) => ({
    owner,
    deviceId: 'device-a',
    workspaceId: 'runtime-a',
    localProjectId: 'local-project-a',
    sessionId: id,
  });
  try {
    await boot();
    assert.ok(app.currentAttachments());
    const originalId = app.currentAttachments().scope.sessionId;
    const first = new File(['Synthetic first file'], 'first.txt', { type: 'text/plain' });
    await act(async () => app.addAttachments([first]));
    assert.equal(actions.length, 0, 'selection stores local data without sending');
    devices[0].online = false;
    space.hosts[0].online = false;
    space.replicas[0].available = false;
    await act(async () => app.loadDevices());
    await act(async () =>
      app.addAttachments([
        new File(['Synthetic second file'], 'second.txt', { type: 'text/plain' }),
      ]),
    );
    await boot();
    assert.equal(
      app.currentAttachments().scope.sessionId,
      originalId,
      'reload retains the stable session identity',
    );
    assert.equal(app.currentAttachments().items.length, 2);
    assert.equal(actions.length, 0, 'offline reload does not upload any draft');
    devices[0].online = true;
    space.hosts[0].online = true;
    space.replicas[0].available = true;
    await act(async () => app.loadDevices());
    assert.equal(actions.length, 0, 'reconnecting never uploads drafts');
    assert.equal(field().value, '', 'the first prompt is attachment-only');

    const firstGate = { started: signal(), release: signal() };
    uploadGate = firstGate;
    let firstSend!: Promise<void>;
    await act(async () => {
      firstSend = app.sendTurn();
      await firstGate.started.promise;
    });
    assert.equal(mutations.length, 0, 'no prompt mutation precedes attachment confirmation');
    await choose('b');
    await act(async () => {
      firstGate.release.resolve();
      await firstSend;
    });
    assert.equal(
      mutations.length,
      0,
      'changing execution target during upload aborts the pending send',
    );
    assert.equal(app.currentAttachments().scope.workspaceId, 'runtime-b');
    assert.equal(app.currentAttachments().items.length, 0);
    await choose('a');
    assert.equal(app.currentAttachments().scope.sessionId, originalId);
    assert.equal(app.currentAttachments().items[0].uploaded, true);
    const lostGate = { started: signal(), release: signal(), lose: true };
    uploadGate = lostGate;
    let failedSend!: Promise<void>;
    await act(async () => {
      failedSend = app.sendTurn();
      await lostGate.started.promise;
    });
    await act(async () => {
      lostGate.release.resolve();
      await assert.rejects(failedSend, /草稿和待确认请求已保留/);
    });
    assert.equal(mutations.length, 0);
    const pending = structuredClone(app.currentAttachments().items[1].pending);
    assert.ok(pending);
    await boot();
    assert.deepEqual(app.currentAttachments().items[1].pending, pending);
    assert.equal(actions.length, 2, 'reload never retries unknown delivery');
    assert.equal(document.querySelector<HTMLButtonElement>('#send')!.disabled, true);
    const retry = document.querySelector<HTMLButtonElement>(
      '[aria-label="手动重试附件：second.txt"]',
    )!;
    assert.ok(retry);
    await act(async () => retry.click());
    assert.deepEqual(
      actions[2],
      pending.request,
      'explicit UI retry retains the original operation and bytes',
    );
    assert.equal(app.currentAttachments().references().length, 2);

    const pendingKey = [owner, 'device-a', 'runtime-a', 'new', 'pending'].join('/');
    for (const malformed of [
      { operationId: 'another-synthetic-operation' },
      { accepted: false },
      { delivered: false },
    ]) {
      mutationReceiptOverride = malformed;
      await act(async () => {
        await assert.rejects(app.sendTurn(), /有效的主机确认/);
      });
      assert.deepEqual(
        mutations.at(-1),
        mutations[0],
        'each manual retry keeps the original mutation',
      );
      assert.deepEqual(
        storage.get(pendingKey),
        mutations[0],
        'invalid receipts retain the durable prompt request',
      );
      assert.equal(app.currentAttachments().scope.sessionId, originalId);
      assert.equal(
        app.currentAttachments().references().length,
        2,
        'invalid receipts never clear attachment drafts',
      );
      assert.equal((storage.get(attachmentDraftKey(scopeA(originalId))) as any).items.length, 2);
      assert.equal(document.querySelector('#send')!.getAttribute('aria-label'), '重试确认');
    }
    assert.equal(actions.length, 3, 'prompt receipt retries do not upload attachments again');

    const promptGate = { started: signal(), release: signal() };
    mutationGate = promptGate;
    let submitted!: Promise<void>;
    await act(async () => {
      submitted = app.sendTurn();
      await promptGate.started.promise;
    });
    assert.equal(mutations.length, 4);
    assert.deepEqual(
      mutations[3],
      mutations[0],
      'the successful manual retry uses the same operation',
    );
    assert.equal(mutations[0].sessionId, originalId);
    assert.equal(mutations[0].expectedTurnId, null);
    const sent = mirror(sessions.get(originalId)!.doc, originalId);
    const sentInput = sent.getState().history[0].inputConfig as {
      prompt: string;
      attachments: AttachmentReference[];
    };
    assert.equal(sentInput.prompt, '');
    assert.equal(sentInput.attachments.length, 2);
    assert.equal(sent.getState().history.length, 1, 'receipt retries do not create another turn');
    sent.dispose();
    await choose('b', 'existing-b');
    await act(async () => {
      promptGate.release.resolve();
      await submitted;
    });
    assert.equal(
      app.currentAttachments().scope.sessionId,
      'existing-b',
      'a late confirmation preserves the current target',
    );
    assert.equal(
      (storage.get(attachmentDraftKey(scopeA(originalId))) as any).items.length,
      0,
      'host-confirmed prompt clears its composer attachments',
    );
    assert.equal(savedAttachments.size, 2, 'confirmed prompt attachments remain in host history');
    await choose('a');
    assert.notEqual(
      app.currentAttachments().scope.sessionId,
      originalId,
      'a subsequent new session must not reuse the already delivered draft session',
    );
    assert.equal(app.currentAttachments().items.length, 0);
    await act(async () => app.openSession(originalId, 'replica-a'));
    assert.equal(document.querySelectorAll('#history [data-open-attachment]').length, 2);
    const reference = [...savedAttachments.values()][0].attachment;
    await act(async () => app.openHistoryAttachment(reference));
    assert.match(
      document.querySelector('.attachment-preview')!.textContent!,
      /Synthetic first file/,
    );
  } finally {
    await act(async () => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
