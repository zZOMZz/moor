import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire as createPackageRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { Flock, LoroDoc, delta, encode, metas, mirror, putMeta } from '../src/model';
import { syntheticCapabilities } from './support/agent-capabilities';

// Exercise the real controller and React UI. Only storage and transport are
// synthetic; deferred responses reproduce ordering races without elapsed time.
test('actual Skills app keeps reads ephemeral, appends the latest draft with CAS, and sends only an ordinary manual mutation', async () => {
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
      },
    ],
    features: ['session-actions', 'git-worktree-v1', 'session-fork-v1', 'skills-read-v1'],
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
            type: 'session_event',
            event: {
              version: 1,
              source: 'acp',
              kind: 'commands',
              commands: [
                { name: '$synthetic', description: 'Pinned Codex Skill' },
                { name: '/prefixed', description: 'Prefixed' },
                { name: 'normal', description: 'Normal' },
              ],
            },
          },
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

  function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { resolve, promise };
  }
  const requests: { path: string; body: any }[] = [];
  const skillText =
    '# 合成说明\n\nKeep this frozen body. <script>bad()</script>\n![tracking](https://invalid.test/pixel)';
  const version = 'sha256:' + createHash('sha256').update(skillText).digest('hex');
  const source = {
    id: 'project-agents',
    label: '.agents/skills',
    scope: 'project',
    convention: 'agents',
    status: 'available',
    version,
  };
  const skill = {
    id: 'skill',
    sourceId: source.id,
    name: 'Synthetic Skill',
    description: 'Synthetic description',
    path: 'test/SKILL.md',
    version,
    byteLength: Buffer.byteLength(skillText),
    metadata: 'parsed',
  };
  let waitRead: undefined | (() => Promise<void>),
    waitWrite: undefined | (() => Promise<void>),
    waitCAS: undefined | (() => Promise<void>),
    failCAS = false;
  let lost = true;
  const receipts = new Map<string, any>();
  Object.assign(globalThis, {
    __moorNotificationLocal: { version: 1, revision: 0, records: [] },
    __moorSchedule: (_callback: () => void) => 1,
    __moorTextWrite: async (key: string, value: unknown) => {
      if (key.endsWith('/draft')) await waitWrite?.();
      storage.set(key, structuredClone(value));
    },
    __moorTextCAS: async (
      key: string,
      expected: string | undefined,
      value: string,
      current: () => boolean,
      signal?: AbortSignal,
    ) => {
      await waitCAS?.();
      if (failCAS) throw new Error('Synthetic storage failure');
      if (signal?.aborted || !current()) throw new Error('Synthetic stale append');
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
      else if (url.pathname.endsWith('/hosts/host/sessions')) result = [currentMeta()];
      else if (url.pathname.includes('/sessions/'))
        result = {
          meta: currentMeta(),
          metaBundle: hostMeta.exportJson(),
          update: delta(hostDoc),
          online: true,
          synced: true,
          persisted: true,
        };
      else if (url.pathname.endsWith('/git/state'))
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
      else if (url.pathname.endsWith('/skills/read')) {
        if (body.view === 'detail') await waitRead?.();
        const base = {
          skillsVersion: 1,
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          view: body.view,
          confirmed: true,
          catalogVersion: version,
          executionRevision: 0,
        };
        result =
          body.view === 'list'
            ? {
                ...base,
                sources: [
                  source,
                  {
                    ...source,
                    id: 'global',
                    label: 'Registered synthetic global',
                    scope: 'global',
                    convention: 'registered',
                  },
                  { ...source, id: 'missing', label: '.claude/skills', status: 'missing' },
                ],
                skills: [skill, { ...skill, id: 'global-skill', sourceId: 'global' }],
                issues: [{ sourceId: source.id, path: 'large/SKILL.md', reason: 'too-large' }],
                truncated: true,
              }
            : {
                ...base,
                source:
                  body.sourceId === 'global'
                    ? {
                        ...source,
                        id: 'global',
                        label: 'Registered synthetic global',
                        scope: 'global',
                        convention: 'registered',
                      }
                    : source,
                skill: { ...skill, id: body.skillId, sourceId: body.sourceId },
                text: skillText,
              };
      } else if (url.pathname.endsWith('/mutations')) {
        assert.deepEqual(
          storage.get(cacheKey + '/pending'),
          body,
          'unchanged ordinary mutation outbox',
        );
        if (!receipts.has(body.operationId))
          receipts.set(body.operationId, {
            accepted: true,
            delivered: true,
            operationId: body.operationId,
          });
        if (lost) throw new Error('Synthetic lost receipt');
        result = receipts.get(body.operationId);
      } else assert.fail('Unexpected Skills app request ' + url.pathname);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/skills-app-')),
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
        name: 'synthetic-skills-boundaries',
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
                ? 'export const read=async key=>structuredClone(globalThis.__moorAppCache.get(key));export const write=async(key,value)=>{await globalThis.__moorTextWrite(key,value);};export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const compareText=(...args)=>globalThis.__moorTextCAS(...args); export const compareDraftBundle=async()=>{throw new Error("unexpected role draft application");}; export const clear=async()=>globalThis.__moorAppCache.clear();'
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
              '\nexport {openSkills,currentSkills,resetSkills,appendSkillDraft,openSession,sendTurn,currentAttachments,fillAgentCommand,persistComposerDraft};export {disposeUI} from "./ui";',
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
  const chooseSkill = async () =>
    act(async () => {
      document.querySelector<HTMLButtonElement>('.skills-list button')!.click();
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
  const readCount = () => requests.filter((call) => call.path.endsWith('/skills/read')).length;
  const mutations = () => requests.filter((call) => call.path.endsWith('/mutations'));
  async function selected() {
    await click('Skills');
    await chooseSkill();
  }
  try {
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    await act(() => SyntheticSocket.instances.at(-1)!.open());
    await act(async () => await (globalThis as any).__moorLastOperation);
    assert.equal(readCount(), 0);
    await selected();
    assert.match(document.querySelector('.skills-panel')!.textContent!, /同名/);
    assert.match(document.querySelector('.skills-panel')!.textContent!, /主机全局/);
    assert.match(document.querySelector('.skills-panel')!.textContent!, /目录不存在/);
    assert.match(document.querySelector('.skills-panel')!.textContent!, /部分 Skills 未读取/);
    assert.equal(document.querySelector('.skills-panel img,.skills-panel script'), null);
    assert.doesNotMatch(JSON.stringify([...storage.values()]), /Keep this frozen body/);

    // The fresh detail read does not freeze typing; append waits for the most
    // recent queued input write before comparing and preserving the draft.
    const detailEntered = signal(),
      detailRelease = signal(),
      writeEntered = signal(),
      writeRelease = signal();
    waitRead = () => {
      detailEntered.resolve();
      return detailRelease.promise;
    };
    await act(async () => {
      button('将说明加入本次指令').click();
      await detailEntered.promise;
    });
    const appending = (globalThis as any).__moorLastOperation;
    waitWrite = () => {
      writeEntered.resolve();
      return writeRelease.promise;
    };
    await type('Typed during fresh Skill read');
    await writeEntered.promise;
    assert.equal(field().readOnly, false);
    waitRead = undefined;
    await act(async () => {
      detailRelease.resolve();
    });
    assert.equal(
      storage.get(cacheKey + '/draft'),
      draft,
      'older unfinished input save is still pending',
    );
    waitWrite = undefined;
    await act(async () => {
      writeRelease.resolve();
      await appending;
    });
    assert.match(field().value, /^Typed during fresh Skill read\n\n/);
    assert.ok(field().value.includes(skillText));
    assert.equal(storage.get(cacheKey + '/draft'), field().value);
    assert.equal(mutations().length, 0);
    const appended = field().value;
    await click('关闭 Skills');
    assert.equal(document.querySelector('.skills-panel'), null);
    await click('Skills');
    assert.equal(app.currentSkills().detail, undefined, 'reopen restores no private detail');
    await chooseSkill();

    // Another tab changes the string after the read but before the CAS.
    const casEntered = signal(),
      casRelease = signal();
    waitCAS = () => {
      casEntered.resolve();
      return casRelease.promise;
    };
    await act(async () => {
      button('将说明加入本次指令').click();
      await casEntered.promise;
    });
    const competing = (globalThis as any).__moorLastOperation;
    storage.set(cacheKey + '/draft', 'Other tab draft');
    waitCAS = undefined;
    await act(async () => {
      casRelease.resolve();
      await competing;
    });
    assert.equal(field().value, appended);
    assert.equal(storage.get(cacheKey + '/draft'), 'Other tab draft');
    assert.match(document.querySelector('#notice')!.textContent!, /其他页面/);

    // An edit during the short CAS window aborts rather than losing new text.
    await type('Before gated append');
    const editEntered = signal(),
      editRelease = signal();
    waitCAS = () => {
      editEntered.resolve();
      return editRelease.promise;
    };
    await act(async () => {
      button('将说明加入本次指令').click();
      await editEntered.promise;
    });
    const editing = (globalThis as any).__moorLastOperation;
    await type('New input during CAS');
    waitCAS = undefined;
    await act(async () => {
      editRelease.resolve();
      await editing;
    });
    assert.equal(field().value, 'New input during CAS');
    assert.equal(storage.get(cacheKey + '/draft'), 'New input during CAS');
    failCAS = true;
    await click('将说明加入本次指令');
    failCAS = false;
    assert.equal(field().value, 'New input during CAS');
    assert.equal(mutations().length, 0);

    // Scope departure while CAS is pending leaves the original and new drafts intact.
    const targetEntered = signal(),
      targetRelease = signal();
    waitCAS = () => {
      targetEntered.resolve();
      return targetRelease.promise;
    };
    await act(async () => {
      button('将说明加入本次指令').click();
      await targetEntered.promise;
    });
    const switching = (globalThis as any).__moorLastOperation;
    await act(() => app.openSession(''));
    waitCAS = undefined;
    await act(async () => {
      targetRelease.resolve();
      await switching;
    });
    assert.equal(field().value, '');
    assert.equal(storage.get(cacheKey + '/draft'), 'New input during CAS');
    assert.equal(document.querySelector('.skills-panel'), null);
    const stableId = app.currentAttachments().scope.sessionId;
    await click('Skills');
    const latestList = requests.filter((call) => call.path.endsWith('/skills/read')).at(-1)!;
    assert.equal(latestList.body.sessionId, stableId);
    await chooseSkill();
    await click('关闭 Skills');
    await act(() => app.openSession(''));
    assert.equal(
      app.currentAttachments().scope.sessionId,
      stableId,
      'new session identity survives re-open',
    );

    // Late detail after an offline event does not repopulate the panel.
    await click('Skills');
    const lateEntered = signal(),
      lateRelease = signal();
    waitRead = () => {
      lateEntered.resolve();
      return lateRelease.promise;
    };
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.skills-list button')!.click();
      await lateEntered.promise;
    });
    const late = (globalThis as any).__moorLastOperation;
    await act(() => win.dispatchEvent(new win.Event('offline')));
    waitRead = undefined;
    await act(async () => {
      lateRelease.resolve();
      await late;
    });
    assert.equal(app.currentSkills().detail, undefined);
    assert.equal(app.currentSkills().list, undefined);
    assert.doesNotMatch(
      document.querySelector('.skills-panel')!.textContent!,
      /Keep this frozen body/,
    );
    await click('关闭 Skills');
    await act(() => app.openSession(sessionId, 'replica'));
    await act(() => app.fillAgentCommand('$synthetic'));
    assert.match(field().value, /^\$synthetic /);
    assert.doesNotMatch(field().value, /^\/\$/);
    await type('Final existing draft');
    await selected();
    await click('将说明加入本次指令');
    await click('关闭 Skills');
    const beforeSend = field().value;
    await click('发送指令');
    assert.equal(mutations().length, 1);
    const original = structuredClone(mutations()[0].body);
    assert.equal(field().value, beforeSend);
    assert.deepEqual(storage.get(cacheKey + '/pending'), original);
    lost = false;
    await click('重试确认');
    assert.deepEqual(mutations()[1].body, original);
    assert.equal(receipts.size, 1);
    assert.equal(field().value, '');
    assert.equal(
      requests.some((call) => /capabilities|\/skills\/action|\/preview\/action/.test(call.path)),
      false,
      'reads never initialize Agent or run another action',
    );
  } finally {
    await act(async () => {
      app.resetSkills();
      await app.disposeUI();
    });
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
