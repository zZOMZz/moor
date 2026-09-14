import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createRequire as createPackageRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { Flock, LoroDoc, decode, delta, metas, mirror, putMeta } from '../src/model';
import { syntheticCapabilities } from './support/agent-capabilities';
import {
  ACTOR_FEATURE,
  ATTENTION_FEATURE,
  FOLLOWUP_FEATURE,
  actorKey,
  type AttentionActor,
  type AttentionItem,
} from '../src/attention';
import { gitWorkspaceKey } from '../src/web/git-workspace';
import { attachmentDraftKey } from '../src/web/attachments';
import { MCP_FEATURE } from '../src/mcp-protocol';
import { mcpKey } from '../src/web/mcp';
import { SESSION_TASKS_FEATURE } from '../src/task-protocol';
import { tasksKey } from '../src/web/tasks';
import { syntheticTaskPlan } from './support/task-plan';
import { previewAnnotationKey } from '../src/web/project-preview';

// Exercise the real controller and React UI. Only storage and transport are
// synthetic; deferred responses reproduce ordering races without elapsed time.
test('actual Actor app isolates attention continuation, local drafts and durable operation locks', async (t) => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://synthetic.invalid',
  });
  t.after(() => dom.window.close());
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

  const owner = 'synthetic-attention-owner';
  let actor: AttentionActor = { kind: 'local', authorityId: 'authority-a', accountId: 'account-a' };
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
        inputCapabilities: { text: true, image: true, audio: false, embeddedContext: true },
      },
    ],
    features: [
      'session-actions',
      ACTOR_FEATURE,
      ATTENTION_FEATURE,
      FOLLOWUP_FEATURE,
      SESSION_TASKS_FEATURE,
      MCP_FEATURE,
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
  const sessionId = 'session',
    hostDoc = new LoroDoc(),
    hostMeta = new Flock();
  const view = mirror(hostDoc, sessionId);
  view.setState((state) => {
    state.history.push({
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
    });
  });
  view.dispose();
  hostDoc.commit();
  putMeta(hostMeta, 'session-' + sessionId, {
    id: sessionId,
    title: 'Original synthetic session',
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
  const scope = {
    owner,
    deviceId: device.id,
    workspaceId: runtime.id,
    localProjectId: 'local-project',
    sessionId,
  };
  const target = {
    ...scope,
    userId: runtime.userId,
    machineId: runtime.machineId,
    catalogWorkspaceId: space.id,
    replicaId: 'replica',
  };
  const cacheKey = [owner, device.id, runtime.id, sessionId].join('/');
  const draft = 'Original composer text kept for separate manual review';
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
  const seed: AttentionItem = {
    itemId: 'outcome',
    sessionId,
    localProjectId: 'local-project',
    assistantTurnId: 'assistant',
    userTurnId: 'seed-turn',
    kind: 'outcome',
    lifecycle: 'ended',
    eventRevision: 1,
    observationRevision: 0,
    sequence: 1,
    occurredAt: 1,
    summary: 'Synthetic result to inspect',
    seenRevision: 0,
    disposition: 'pending',
    cause: 'agent_returned',
  };
  const items = new Map<string, AttentionItem>();
  const item = () => {
    const key = actorKey(actor);
    if (!items.has(key)) items.set(key, structuredClone(seed));
    return items.get(key)!;
  };
  const requests: { path: string; body: any }[] = [];
  let releaseRead: (() => void) | undefined, readStarted: (() => void) | undefined;
  let deferNextRead = false;
  Object.assign(globalThis, {
    fetch: async (path: string, init?: RequestInit) => {
      const url = new URL(path, win.location.href),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, body: structuredClone(body) });
      let result: unknown;
      if (url.pathname === '/api/devices') result = [device];
      else if (url.pathname === '/api/workspaces') result = [space];
      else if (url.pathname.endsWith('/hosts/host/sessions')) result = [currentMeta()];
      else if (url.pathname.includes('/attention')) {
        const selected = item();
        if (!body)
          result = url.pathname.endsWith('/' + selected.itemId)
            ? {
                item: structuredClone(selected),
                title: currentMeta().title,
                isArchived: false,
                turn: { items: [{ text: 'Synthetic outcome' }] },
                userTurn: { items: [{ text: 'Original input' }] },
              }
            : {
                sessions: [
                  {
                    sessionId,
                    title: currentMeta().title,
                    isArchived: false,
                    items: [structuredClone(selected)],
                    itemCount: 1,
                  },
                ],
                total: 1,
                version: selected.observationRevision,
              };
        else {
          if (url.pathname.endsWith('/seen')) selected.seenRevision = body.eventRevision;
          else if (url.pathname.endsWith('/disposition')) {
            selected.disposition = body.disposition;
            selected.observationRevision++;
          } else if (url.pathname.endsWith('/continue')) {
            assert.equal(body.mutation.sessionId, sessionId);
            assert.equal(body.mutation.workspaceId, runtime.id);
            assert.ok(
              [...storage.values()].some(
                (value: any) =>
                  value?.operation?.body?.mutation?.operationId === body.mutation.operationId,
              ),
              'original attention outbox is durable before dispatch',
            );
            hostDoc.import(decode(body.mutation.update));
            hostMeta.importJson(body.mutation.metaBundle);
            selected.disposition = 'continued';
            selected.observationRevision++;
          } else assert.fail('Unexpected attention action: ' + path);
          result = {
            accepted: true,
            delivered: true,
            operationId: body.operationId ?? body.mutation.operationId,
            item: structuredClone(selected),
          };
        }
      } else if (url.pathname.endsWith('/sessions/' + sessionId)) {
        result = {
          meta: currentMeta(),
          metaBundle: hostMeta.exportJson(),
          update: delta(hostDoc),
          online: true,
          synced: true,
        };
        if (deferNextRead) {
          deferNextRead = false;
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
            readStarted?.();
          });
        }
      } else assert.fail('Unexpected synthetic request: ' + path);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  // Keep test-only exports and the cache substitution in the disposable bundle.
  // Production code receives no test hook and no real IndexedDB is accessed.
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/attention-app-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
        export const compareAndSet = async (key, expected, value) => {
          if (JSON.stringify(globalThis.__moorAppCache.get(key)) !== JSON.stringify(expected)) return false;
          globalThis.__moorAppCache.set(key, structuredClone(value));
          return true;
        };
        export const compareText=async(key,expected,value,current,signal)=>{if(signal?.aborted||!current())throw new Error("stale draft");const cache=globalThis.__moorAppCache;if(cache.get(key)!==expected)return false;cache.set(key,value);return true;}; export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const compareTaskSubmission=async()=>{throw new Error("attention cannot stage composer tasks");}; export const compareDraftBundle=async()=>{throw new Error("unexpected role draft application");}; export const clear = async () => { globalThis.__moorAppCache.clear(); };
      `,
          }));
          builder.onLoad({ filter: /\/src\/web\/app\.ts$/ }, async (args) => ({
            loader: 'ts',
            resolveDir: resolve('src/web'),
            contents:
              (await readFile(args.path, 'utf8')) +
              '\nexport { attention, loadSession, openSession, openAttention, openGitWorkspace, openSkills, openRoles, openTasks, openMcp, saveComposerDraft, currentAttachments, currentPreviewAnnotations }; export { disposeUI } from "./ui";\n',
          }));
          builder.onLoad({ filter: /\/src\/web\/attention-ui\.tsx$/ }, async (args) => ({
            loader: 'tsx',
            resolveDir: resolve('src/web'),
            contents: (await readFile(args.path, 'utf8')).replace(
              'void work().catch((cause) => controller.report(cause));',
              'globalThis.__moorAttentionUIAction = work().catch((cause) => controller.report(cause));',
            ),
          }));
        },
      },
    ],
  });

  const app = await import(pathToFileURL(outfile).href);
  const { act } = await import('react');
  const field = () => document.querySelector<HTMLTextAreaElement>('#prompt')!;
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (value) => value.textContent === label || value.getAttribute('aria-label') === label,
    );
    assert.ok(found, label);
    return found;
  };
  const start = async () => {
    await act(async () =>
      app.boot(
        Promise.resolve({ owner, actor, needsSetup: false, localOnly: true }),
        Promise.resolve(undefined),
      ),
    );
    await act(async () => SyntheticSocket.instances.at(-1)!.open());
  };
  const clickAttention = async (label: string) => {
    await act(async () => {
      (globalThis as any).__moorAttentionUIAction = undefined;
      button(label).click();
      const action = (globalThis as any).__moorAttentionUIAction;
      assert.ok(action instanceof Promise, 'the real UI started an observed operation');
      await action;
    });
  };
  const selectAttention = async () => {
    await act(async () => app.openAttention());
    await act(async () =>
      app.attention.open({ replicaId: 'replica', sessionId, itemId: seed.itemId }),
    );
  };
  const saveFollowup = async (text: string) => {
    await act(async () => app.attention.createDraft());
    await act(async () => app.attention.editDraft(text));
    await act(async () => app.attention.saveDraft());
  };
  const continuationCount = () => requests.filter((row) => row.path.endsWith('/continue')).length;
  try {
    await start();
    await act(async () => app.saveComposerDraft(draft));
    assert.equal(field().value, draft);
    assert.equal(document.querySelector<HTMLButtonElement>('#send')!.disabled, false);
    assert.deepEqual(
      (storage.get(cacheKey + '/draft/actor') as any).scope,
      JSON.stringify([win.location.origin, actorKey(actor)]),
    );

    await t.test(
      'Actor boot renders the workbench and navigation closes session panels',
      async () => {
        assert.ok(button('待我处理'));
        for (const open of [app.openGitWorkspace, app.openSkills]) {
          await act(async () => app.openSession(sessionId, 'replica'));
          await act(async () => open());
          assert.ok(
            document.querySelector('.session-dialog'),
            'a real session feature panel opened',
          );
          await act(async () => app.openAttention());
          assert.equal(document.querySelector<HTMLElement>('#attention-view')!.hidden, false);
          assert.match(document.querySelector('#target')!.textContent!, /待我处理/);
          assert.equal(
            document.querySelector('.session-dialog'),
            null,
            'workbench closes session panels',
          );
          assert.equal(
            document.querySelector('#project-content-controls button'),
            null,
            'session toolbar controls are hidden',
          );
        }
      },
    );

    await t.test(
      'attention sends only reviewed text and preserves selected hidden attachments and annotations',
      async () => {
        await act(async () => app.openSession(sessionId, 'replica'));
        await act(async () =>
          app
            .currentAttachments()
            .add([new File(['SYNTHETIC_ATTACHMENT'], 'hidden.txt', { type: 'text/plain' })]),
        );
        const legacyAnnotations = {
          version: 1,
          target,
          cacheRevision: 1,
          annotations: [{ note: 'SYNTHETIC_RETIRED_ANNOTATION' }],
        };
        storage.set(previewAnnotationKey(target), legacyAnnotations);
        const taskRecord = {
          version: 1,
          cacheRevision: 1,
          target,
          draft: syntheticTaskPlan(),
          enabled: {
            reviewId: 'reviewed-other-composer-plan',
            parentAgentId: 'agent',
            plan: syntheticTaskPlan(),
          },
        };
        storage.set(tasksKey(target), taskRecord);
        const mcpRecord = {
          version: 1,
          cacheRevision: 1,
          target,
          review: {
            reviewId: 'reviewed-other-composer-mcp',
            servers: [
              {
                id: 'sha256:' + 'b'.repeat(64),
                name: 'Synthetic MCP',
                description: 'Separate composer selection',
                transport: 'stdio',
              },
            ],
          },
        };
        storage.set(mcpKey(target), mcpRecord);
        const attachments = structuredClone(storage.get(attachmentDraftKey(scope))),
          annotations = structuredClone(storage.get(previewAnnotationKey(target)));
        await selectAttention();
        await clickAttention('需要继续');
        assert.equal(
          document.querySelector<HTMLTextAreaElement>('#attention-draft')!.value,
          draft,
          'actor-scoped draft is available for manual review',
        );
        const reviewed = 'Only this reviewed followup text';
        await saveFollowup(reviewed);
        await clickAttention('发送后续要求');
        assert.equal(continuationCount(), 1);
        assert.equal(
          requests.some(
            (row) => row.path.endsWith('/mutations') || row.path.endsWith('/attachment-actions'),
          ),
          false,
        );
        const continued = mirror(hostDoc, sessionId),
          turn = continued.getState().history.at(-1)!,
          input = z.record(z.unknown()).parse(turn.inputConfig);
        assert.equal(input.prompt, reviewed);
        assert.equal(input.attachments, undefined);
        assert.equal(Boolean(input.taskToolsEnabled), false);
        assert.equal(input.taskPlan, undefined);
        assert.deepEqual(input.mcpServerIds ?? [], []);
        assert.deepEqual(storage.get(mcpKey(target)), mcpRecord);
        assert.equal(
          requests.some((row) => row.path.includes('/mcp/')),
          false,
        );
        assert.deepEqual(storage.get(tasksKey(target)), taskRecord);
        assert.deepEqual(turn.items, [{ type: 'text', text: reviewed }]);
        continued.dispose();
        assert.deepEqual(storage.get(attachmentDraftKey(scope)), attachments);
        assert.deepEqual(storage.get(previewAnnotationKey(target)), annotations);
        assert.equal(
          storage.get(cacheKey + '/draft'),
          draft,
          'unrelated composer text is retained',
        );
        assert.equal(
          document.querySelector<HTMLElement>('#attention-view')!.hidden,
          false,
          'host confirmation preserves the workbench',
        );
      },
    );

    await t.test(
      'original session and Git pending records block the dedicated followup before any dispatch',
      async () => {
        item().disposition = 'pending';
        await selectAttention();
        await saveFollowup('Reviewed text waiting for old operations');
        const before = continuationCount();
        const pendingKey = cacheKey + '/pending';
        storage.set(pendingKey, {
          operationId: 'original-session-action',
          workspaceId: runtime.id,
          sessionId,
          kind: 'cancel',
          update: delta(hostDoc),
        });
        await act(async () => assert.rejects(app.attention.sendContinue(), /上一次操作/));
        assert.equal(continuationCount(), before);
        assert.equal((storage.get(pendingKey) as any).operationId, 'original-session-action');
        storage.delete(pendingKey);
        const gitKey = gitWorkspaceKey(target),
          gitRecord = {
            version: 1,
            cacheRevision: 1,
            target,
            pending: {
              target,
              request: {
                gitVersion: 1,
                workspaceId: runtime.id,
                localProjectId: 'local-project',
                sessionId,
                operationId: 'original-git-action',
                expectedRevision: 0,
                action: 'remove',
                executionId: 'execution',
                expectedStateVersion: 'sha256:' + 'a'.repeat(64),
              },
            },
          };
        storage.set(gitKey, gitRecord);
        await act(async () => assert.rejects(app.attention.sendContinue(), /Git 与工作目录/));
        assert.equal(continuationCount(), before);
        assert.deepEqual(storage.get(gitKey), gitRecord);
        storage.delete(gitKey);
      },
    );

    await t.test(
      'switching authority during preparation rejects late delivery and excludes another actors draft',
      async () => {
        const started = new Promise<void>((resolve) => {
          readStarted = resolve;
        });
        deferNextRead = true;
        const before = continuationCount();
        let pending: Promise<void>;
        await act(async () => {
          pending = assert.rejects(
            app.attention.sendContinue(),
            /登录状态|访问范围|账号或执行范围/,
          );
          await started;
        });
        actor = { ...actor, authorityId: 'authority-b' };
        await start();
        await act(async () => {
          releaseRead!();
          await pending!;
        });
        assert.equal(continuationCount(), before);
        await selectAttention();
        await act(async () => app.attention.createDraft());
        assert.notEqual(
          document.querySelector<HTMLTextAreaElement>('#attention-draft')!.value,
          draft,
        );
        assert.match(app.attention.state.notice, /未关联当前账号/);
        assert.equal(storage.get(cacheKey + '/draft'), draft);
      },
    );
  } finally {
    releaseRead?.();
    await act(async () => app.disposeUI());
  }
});
