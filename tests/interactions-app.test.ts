import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire as createPackageRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { Flock, LoroDoc, delta, metas, mirror, putMeta } from '../src/model';
import { syntheticCapabilities } from './support/agent-capabilities';
import { interactionKey, questionDraftKey } from '../src/web/interactions';
import { questionRequestSchema } from '../src/interaction-protocol';

test('actual app keeps question delivery exactly once, rejects late answers, preserves unknown steer and leaves Stop independent', async () => {
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
    features: ['session-actions', 'questions-v1', 'steer-v1'],
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
  const sessionId = 'session',
    turnId = 'assistant-turn';
  const request = questionRequestSchema.parse({
    interactionVersion: 1,
    workspaceId: runtime.id,
    localProjectId: 'local-project',
    sessionId,
    expectedTurnId: turnId,
    requestId: 'question',
    title: 'Synthetic <img src=x onerror=bad>',
    message: 'Choose synthetic values',
    fields: [
      {
        id: 'text',
        kind: 'text',
        label: 'Text',
        required: true,
        minLength: 1,
        maxLength: 40,
        default: 'Initial',
      },
      {
        id: 'number',
        kind: 'number',
        label: 'Number',
        required: true,
        integer: true,
        minimum: 0,
        maximum: 100,
        default: 0,
      },
      { id: 'bool', kind: 'boolean', label: 'Boolean', required: true, default: false },
      {
        id: 'single',
        kind: 'single-select',
        label: 'Choice',
        required: true,
        options: [
          { value: '', label: 'Empty choice' },
          { value: 'B', label: 'Other' },
        ],
        default: '',
      },
      {
        id: 'multi',
        kind: 'multi-select',
        label: 'Multiple',
        required: true,
        minItems: 1,
        maxItems: 2,
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        default: ['a'],
      },
    ],
  });
  const target = {
    owner,
    deviceId: device.id,
    workspaceId: runtime.id,
    localProjectId: 'local-project',
    sessionId,
  };
  const hostDoc = new LoroDoc(),
    hostMeta = new Flock();
  const edit = (fn: (state: any) => void) => {
    const view = mirror(hostDoc, sessionId);
    view.setState(fn);
    view.dispose();
    hostDoc.commit();
  };
  const interactionCaps = { questions: true, steer: true };
  edit((state) => {
    state.history.push({
      id: 'user-turn',
      role: 'user',
      userId: runtime.userId,
      timestamp: '2026-01-01T00:00:00Z',
      finished: true,
      read: true,
      status: 'handled',
      items: [{ type: 'text', text: 'Synthetic original prompt' }],
      fileDiff: null,
    });
    state.history.push({
      id: turnId,
      role: 'assistant',
      userId: runtime.userId,
      userTurnId: 'user-turn',
      timestamp: '2026-01-01T00:00:01Z',
      finished: false,
      read: true,
      status: 'pending',
      items: [
        { type: 'agent_features', interactionCapabilities: interactionCaps },
        {
          type: 'session_event',
          event: {
            version: 1,
            source: 'acp',
            kind: 'commands',
            commands: [
              {
                name: 'inspect',
                description: 'Read the project',
                input: { hint: 'Optional path' },
              },
            ],
          },
        },
        { type: 'question', request, status: 'pending' },
      ],
      fileDiff: null,
    });
  });
  putMeta(hostMeta, 'session-' + sessionId, {
    id: sessionId,
    title: 'Synthetic interaction session',
    machineId: runtime.machineId,
    userId: runtime.userId,
    project: { kind: 'local', localProjectId: 'local-project' },
    cliType: 'builtin',
    agentType: 'codex',
    agentConfigId: 'agent',
    metadataRevision: 0,
    isArchived: false,
    isPinned: false,
    status: { type: 'working' },
    latestUserMsgId: 'user-turn',
    lastHandledUserMsgId: 'user-turn',
    lastMessageAt: 1,
  });
  const currentMeta = () => metas(hostMeta)['session-' + sessionId];
  const cacheKey = [owner, device.id, runtime.id, sessionId].join('/');
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
    [cacheKey + '/draft', 'Unsent ordinary prompt'],
  ]);
  Object.assign(globalThis, { __moorAppCache: storage });
  let answers = 0,
    nativeSteers = 0,
    cancels = 0,
    loseAnswer = true,
    wrongReceipt = false;
  const questionReceipts = new Map<string, unknown>(),
    steerJournal = new Set<string>(),
    calls: { path: string; body: any }[] = [];
  Object.assign(globalThis, {
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, win.location.href),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: url.pathname, body });
      let result: unknown;
      if (url.pathname === '/api/devices') result = [device];
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
      else if (url.pathname.endsWith('/question-answers')) {
        assert.deepEqual(
          (storage.get(interactionKey(target)) as any).pending.request,
          body,
          'original request must be committed locally before transmission',
        );
        if (!questionReceipts.has(body.operationId)) {
          answers++;
          result = {
            interactionVersion: 1,
            workspaceId: body.workspaceId,
            localProjectId: body.localProjectId,
            sessionId: body.sessionId,
            expectedTurnId: body.expectedTurnId,
            requestId: body.requestId,
            operationId: body.operationId,
            accepted: true,
            delivered: true,
          };
          questionReceipts.set(body.operationId, result);
          edit((state) => {
            const item = state.history[1].items.find(
              (item: any) => item.type === 'question' && item.request.requestId === body.requestId,
            );
            item.status = 'answered';
            item.answer = body.answer;
            item.operationId = body.operationId;
          });
        }
        result = questionReceipts.get(body.operationId);
        if (loseAnswer) {
          loseAnswer = false;
          throw new Error('Synthetic lost response');
        }
        if (wrongReceipt) result = { ...(result as object), operationId: 'wrong-operation' };
      } else if (url.pathname.endsWith('/steer')) {
        assert.deepEqual((storage.get(interactionKey(target)) as any).pending.request, body);
        if (!steerJournal.has(body.operationId)) {
          steerJournal.add(body.operationId);
          nativeSteers++;
          edit((state) => {
            state.history[1].items.push({
              type: 'steer',
              ...body,
              status: 'unknown',
              message: 'Synthetic native result unknown',
            });
          });
        }
        return {
          ok: false,
          status: 504,
          json: async () => ({ error: 'Synthetic native result unknown', rejected: false }),
        };
      } else if (url.pathname.endsWith('/cancel')) {
        cancels++;
        edit((state) => {
          state.history[1].finished = true;
          state.history[1].items
            .filter((item: any) => item.type === 'question' && item.status === 'pending')
            .forEach((item: any) => (item.status = 'cancelled'));
        });
        result = { success: true };
      } else assert.fail('Unexpected synthetic interaction request: ' + url.pathname);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/interactions-app-')),
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
      js: "import { createRequire as createPackageRequire } from 'node:module'; const require=createPackageRequire(import.meta.url);",
    },
    plugins: [
      {
        name: 'synthetic-interaction-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/cache$/ }, () => ({
            path: 'cache',
            namespace: 'synthetic',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({
            loader: 'js',
            contents:
              'export const read=async key=>structuredClone(globalThis.__moorAppCache.get(key)); export const write=async(key,value)=>{globalThis.__moorAppCache.set(key,structuredClone(value));}; export const compareText=async(key,expected,value,current,signal)=>{if(signal?.aborted||!current())throw new Error("stale draft");const cache=globalThis.__moorAppCache;if(cache.get(key)!==expected)return false;cache.set(key,value);return true;}; export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const compareDraftBundle=async()=>{throw new Error("unexpected role draft application");}; export const clear=async()=>globalThis.__moorAppCache.clear();',
          }));
          builder.onLoad({ filter: /\/src\/web\/app\.ts$/ }, async (args) => ({
            loader: 'ts',
            resolveDir: resolve('src/web'),
            contents:
              (await readFile(args.path, 'utf8')) +
              '\nexport {loadSession,loadDevices,openSession,answerActiveQuestion,retryInteraction,dismissInteraction,submitSteer,closeCurrentInteractionPanel,cancelTurn,sendTurn};export {disposeUI} from "./ui";',
          }));
        },
      },
    ],
  });
  const app = await import(pathToFileURL(outfile).href),
    { act } = await import('react');
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label,
    );
    assert.ok(found, label);
    return found;
  };
  const field = () => document.querySelector<HTMLTextAreaElement>('#prompt')!;
  const interactionCalls = () =>
    calls.filter((call) => call.body && /question-answers|steer/.test(call.path));
  try {
    await act(async () =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(undefined)),
    );
    await act(async () => SyntheticSocket.instances.at(-1)!.open());
    assert.equal(field().value, 'Unsent ordinary prompt');
    await act(async () => button('命令、计划与用量').click());
    await act(async () => {
      const command = document.querySelector<HTMLButtonElement>('.agent-commands button')!;
      assert.ok(command);
      command.click();
    });
    assert.equal(field().value, '/inspect Unsent ordinary prompt');
    assert.equal(interactionCalls().length, 0);
    assert.equal(
      calls.filter((call) => call.path.endsWith('/mutations')).length,
      0,
      'command selection only fills composer',
    );
    await act(async () => button('回答问题 · ' + request.title).click());
    const panel = document.querySelector('.interaction-dialog')!;
    assert.equal(panel.querySelector('img'), null);
    assert.match(panel.textContent!, /Synthetic <img/);
    assert.equal((panel.querySelector('#agent-question-1') as HTMLInputElement).value, '0');
    assert.equal((panel.querySelector('#agent-question-2') as HTMLSelectElement).value, 'no');
    assert.equal((panel.querySelector('#agent-question-3') as HTMLSelectElement).value, '0');
    // Exercise the real React form, including a nonempty native option whose actual value is empty.
    await act(async () => {
      const select = panel.querySelector<HTMLSelectElement>('#agent-question-3')!;
      select.value = '1';
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    await act(async () => {
      const select = panel.querySelector<HTMLSelectElement>('#agent-question-3')!;
      select.value = '0';
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    await act(async () => button('提交回答').click());
    assert.equal(answers, 1);
    assert.match(document.querySelector('#interaction-controls')!.textContent!, /结果待确认/);
    const first = (storage.get(interactionKey(target)) as any).pending;
    assert.deepEqual(first.request.answer.values, {
      text: 'Initial',
      number: 0,
      bool: false,
      single: '',
      multi: ['a'],
    });
    assert.equal(document.querySelector<HTMLButtonElement>('#cancel')!.disabled, false);
    await act(async () => app.openSession(sessionId, 'replica'));
    assert.equal(answers, 1);
    assert.equal(interactionCalls().length, 1, 'refresh only restores outbox');
    assert.match(document.querySelector('#history')!.textContent!, /已回答/);
    wrongReceipt = true;
    await act(async () => assert.rejects(app.retryInteraction(), /有效的主机确认/));
    assert.deepEqual((storage.get(interactionKey(target)) as any).pending, first);
    assert.equal(answers, 1);
    wrongReceipt = false;
    await act(async () => app.retryInteraction());
    assert.equal(answers, 1);
    assert.equal((storage.get(interactionKey(target)) as any).pending, undefined);
    assert.deepEqual(
      interactionCalls().map((call) => call.body),
      [first.request, first.request, first.request],
    );
    // A displayed question becoming cancelled must be disabled and cannot be answered from a stale handler.
    const nextQuestion = { ...request, requestId: 'late-question' };
    edit((state) => {
      state.history[1].items.push({ type: 'question', request: nextQuestion, status: 'pending' });
    });
    await act(async () => app.loadSession());
    await act(async () => button('回答问题 · ' + request.title).click());
    edit((state) => {
      state.history[1].items.find(
        (item: any) => item.request?.requestId === 'late-question',
      ).status = 'cancelled';
    });
    await act(async () => app.loadSession());
    assert.equal(button('提交回答').disabled, true);
    await act(async () =>
      assert.rejects(
        app.answerActiveQuestion(questionDraftKey(nextQuestion), { action: 'cancel' }),
        /问题已结束/,
      ),
    );
    assert.equal(answers, 1);
    await act(async () => app.closeCurrentInteractionPanel());
    // Driver capability, not an ACP report flag, gates the separate steer action.
    edit((state) => {
      state.history[1].items[0].interactionCapabilities = {
        questions: true,
        steer: false,
        steerUnavailableReason: '当前 Codex 适配器不支持回合内追加。',
      };
    });
    await act(async () => app.loadSession());
    await act(async () => button('回合内追加').click());
    assert.match(document.querySelector('.interaction-dialog')!.textContent!, /Codex.*不支持/);
    assert.equal(button('追加到活动回合').disabled, true);
    await act(async () => assert.rejects(app.submitSteer('Do not send', turnId), /Codex.*不支持/));
    assert.equal(nativeSteers, 0);
    await act(async () => app.closeCurrentInteractionPanel());
    edit((state) => {
      state.history[1].items[0].interactionCapabilities = interactionCaps;
    });
    await act(async () => app.loadSession());
    await act(async () => assert.rejects(app.submitSteer('Synthetic steer', turnId), /unknown/));
    assert.equal(nativeSteers, 1);
    const steer = (storage.get(interactionKey(target)) as any).pending;
    await act(async () => app.openSession(sessionId, 'replica'));
    assert.equal(nativeSteers, 1);
    await act(async () => assert.rejects(app.retryInteraction(), /unknown/));
    assert.equal(nativeSteers, 1);
    assert.deepEqual(interactionCalls().at(-1)!.body, steer.request);
    assert.equal(document.querySelector<HTMLButtonElement>('#cancel')!.disabled, false);
    await act(async () => app.cancelTurn());
    assert.equal(cancels, 1);
    await act(async () => app.loadSession());
    assert.match(document.querySelector('#history')!.textContent!, /结果未知/);
    await act(async () => assert.rejects(app.sendTurn(), /确认或关闭原交互记录/));
    await act(async () => button('关闭此待确认记录').click());
    const saved = storage.get(interactionKey(target)) as any;
    assert.equal(saved.pending, undefined);
    assert.equal(saved.closed[0].outcome, 'unknown');
    assert.deepEqual(saved.closed[0].operation, steer);
    assert.equal(field().value, '/inspect Unsent ordinary prompt');
    assert.equal(
      calls.filter((call) => call.path.endsWith('/mutations')).length,
      0,
      'unknown steer never becomes a new prompt',
    );
    const count = interactionCalls().length;
    device.online = false;
    space.hosts[0].online = false;
    space.replicas[0].available = false;
    await act(async () => app.loadDevices());
    device.online = true;
    space.hosts[0].online = true;
    space.replicas[0].available = true;
    await act(async () => app.loadDevices());
    assert.equal(interactionCalls().length, count, 'reconnecting never sends interaction drafts');
  } finally {
    await act(async () => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
