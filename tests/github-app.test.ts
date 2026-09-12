import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire as createPackageRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { Flock, LoroDoc, delta, encode, metas, mirror, putMeta } from '../src/model';
import { syntheticCapabilities } from './support/agent-capabilities';

// Exercise the real controller and React UI. Only storage and transport are
// synthetic; deferred responses reproduce ordering races without elapsed time.
test('actual GitHub app scopes private content, preserves drafts, and binds existing and new sessions only by explicit confirmation', async () => {
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
    features: ['session-actions', 'git-worktree-v1', 'session-fork-v1', 'github-read-v1'],
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
  const requests: { path: string; body: any }[] = [];
  const timestamp = '2026-09-12T00:00:00Z',
    version = 'sha256:' + 'a'.repeat(64),
    oid = 'b'.repeat(40);
  const repository = {
    id: 42,
    owner: 'example',
    name: 'private',
    private: true,
    defaultBranch: 'main',
    url: 'https://github.com/example/private',
  };
  const issue = {
    id: 99,
    number: 7,
    kind: 'issue',
    title: 'Synthetic <img src=x> issue',
    state: 'open',
    author: 'synthetic',
    url: repository.url + '/issues/7',
    updatedAt: timestamp,
    body: 'Private issue body <script>bad()</script>',
    bodyTruncated: true,
    labels: [],
    version,
  };
  const pull = {
    ...issue,
    id: 100,
    number: 8,
    kind: 'pull',
    title: 'Synthetic fork PR',
    url: repository.url + '/pull/8',
    head: {
      sha: oid,
      branch: 'contributor/fix',
      repository: { id: 43, owner: 'contributor', name: 'fork' },
    },
    base: {
      sha: 'c'.repeat(40),
      branch: 'main',
      repository: { id: 42, owner: 'example', name: 'private' },
    },
    mergeable: null,
  };
  let available = true,
    lost = false,
    undelivered = false,
    wrong = false,
    waitRead: undefined | (() => Promise<void>),
    itemVersion = version;
  const bindings = new Map<string, any>(),
    receipts = new Map<string, any>();
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
      else if (url.pathname.endsWith('/github/read')) {
        const base = {
          githubVersion: 1,
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          confirmed: true,
          binding: bindings.get(body.sessionId) || { revision: 0 },
          readAt: timestamp,
          view: body.view,
        };
        if (body.view === 'overview')
          result = available
            ? {
                ...base,
                status: 'available',
                repository,
                configVersion: version,
                localBranch: 'local-other',
              }
            : {
                ...base,
                status: 'unavailable',
                binding: { revision: base.binding.revision },
                reason: '授权已停用',
              };
        else {
          if (!available)
            return {
              ok: false,
              status: 403,
              json: async () => ({ error: 'GitHub authorization revoked', rejected: true }),
            };
          assert.equal(body.repositoryId, 42);
          assert.equal(body.configVersion, version);
          const scoped = { ...base, repository, configVersion: version },
            page = { page: body.page, hasNext: false, partial: false };
          if (body.view === 'branches')
            result = {
              ...scoped,
              result: { ...page, items: [{ name: 'main', sha: oid, protected: true }] },
            };
          else if (body.view === 'issues' || body.view === 'pulls') {
            const detail = body.view === 'issues' ? issue : pull;
            const {
              body: _,
              bodyTruncated,
              labels,
              version: __,
              head,
              base: ___,
              mergeable,
              ...summary
            } = detail as any;
            result = {
              ...scoped,
              state: body.state,
              result: { ...page, items: [summary], partial: true },
            };
          } else if (body.view === 'issue' || body.view === 'pull') {
            await waitRead?.();
            result = {
              ...scoped,
              item: { ...(body.view === 'issue' ? issue : pull), version: itemVersion },
            };
          } else if (body.view === 'comments')
            result = {
              ...scoped,
              number: body.number,
              subject: body.subject,
              result: {
                ...page,
                items: [
                  {
                    id: 1,
                    author: 'synthetic',
                    body: 'Private comment <img src=x>',
                    bodyTruncated: false,
                    url: repository.url + '/issues/7#issuecomment-1',
                    updatedAt: timestamp,
                  },
                ],
              },
            };
          else if (body.view === 'checks')
            result = {
              ...scoped,
              number: body.number,
              headSha: body.headSha,
              checks: {
                ...page,
                items: [
                  {
                    id: 1,
                    name: 'Synthetic CI',
                    status: 'in_progress',
                    conclusion: null,
                    startedAt: timestamp,
                    completedAt: null,
                  },
                ],
                partial: true,
              },
              statuses: { ...page, items: [], state: 'pending', totalCount: 0 },
            };
          else assert.fail('Unexpected GitHub view');
        }
      } else if (url.pathname.endsWith('/github/abandon')) {
        const stored = [...storage.values()].find(
          (v: any) => v?.pending?.request?.operationId === body.operationId,
        ) as any;
        assert.ok(stored?.pending.abandon);
        assert.deepEqual(stored.pending.request, body);
        assert.equal(receipts.has(body.operationId), false);
        result = {
          githubVersion: 1,
          workspaceId: body.workspaceId,
          localProjectId: body.localProjectId,
          sessionId: body.sessionId,
          operationId: body.operationId,
          confirmed: true,
          abandoned: true,
          binding: { revision: body.expectedRevision },
        };
        receipts.set(body.operationId, structuredClone(result));
      } else if (url.pathname.endsWith('/github/action')) {
        const stored = [...storage.values()].find(
          (v: any) => v?.pending?.request?.operationId === body.operationId,
        ) as any;
        assert.ok(stored);
        assert.deepEqual(stored.pending.request, body);
        if (undelivered) throw new Error('Synthetic request never reached the host');
        if (!receipts.has(body.operationId)) {
          const binding = {
            revision: body.expectedRevision + 1,
            ...(body.action === 'bind'
              ? {
                  context: {
                    repository: { id: 42, owner: 'example', name: 'private' },
                    branch: body.branch,
                    subject: body.subject,
                    updatedAt: timestamp,
                  },
                }
              : {}),
          };
          bindings.set(body.sessionId, binding);
          receipts.set(body.operationId, {
            githubVersion: 1,
            workspaceId: body.workspaceId,
            localProjectId: body.localProjectId,
            sessionId: body.sessionId,
            operationId: body.operationId,
            confirmed: true,
            binding,
          });
        }
        if (lost) throw new Error('Synthetic lost receipt');
        result = {
          ...receipts.get(body.operationId),
          operationId: wrong ? 'wrong-operation' : body.operationId,
        };
      } else assert.fail('Unexpected GitHub app request ' + url.pathname);
      return { ok: true, status: 200, json: async () => structuredClone(result) };
    },
  });
  const loadPackage = createPackageRequire(join(process.cwd(), 'package.json'));
  const { build } = loadPackage('esbuild') as typeof import('esbuild');
  const directory = await mkdtemp(join(process.cwd(), 'dist/tests/github-app-')),
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
        name: 'synthetic-github-boundaries',
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
                ? 'export const read=async key=>structuredClone(globalThis.__moorAppCache.get(key));export const write=async(key,value)=>{globalThis.__moorAppCache.set(key,structuredClone(value));};export const compareText=async(key,expected,value,current,signal)=>{if(signal?.aborted||!current())throw new Error("stale draft");const cache=globalThis.__moorAppCache;if(cache.get(key)!==expected)return false;cache.set(key,value);return true;}; export const compareWrite=async(key,expectedRevision,value,current)=>{if(!current())throw new Error("stale Git target");const cache=globalThis.__moorAppCache;if((cache.get(key)?.cacheRevision??0)!==expectedRevision)return false;cache.set(key,structuredClone(value));return true;}; export const compareDraftBundle=async()=>{throw new Error("unexpected role draft application");}; export const clear=async()=>globalThis.__moorAppCache.clear();'
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
              '\nexport {openGithub,currentGithub,openSession,sendTurn,addAttachments,currentAttachments,appendGithubDraft};export {disposeUI} from "./ui";',
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
  const actions = () => requests.filter((v) => v.path.endsWith('/github/action'));
  const reads = () => requests.filter((v) => v.path.endsWith('/github/read'));
  const stableKey =
    'attachment-session-v1/' + JSON.stringify([owner, device.id, runtime.id, 'local-project']);
  storage.set(stableKey, 'stable-new-github-draft');
  const chooseBranch = () =>
    act(() => {
      const select = document.querySelector<HTMLSelectElement>('.github-panel select')!;
      select.value = 'main';
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
  function signal() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { resolve, promise };
  }
  try {
    await act(() =>
      app.boot(Promise.resolve({ owner, needsSetup: false }), Promise.resolve(owner)),
    );
    await act(() => SyntheticSocket.instances.at(-1)!.open());
    await act(async () => await (globalThis as any).__moorLastOperation);
    assert.equal(reads().length, 0);
    await click('GitHub 仓库与会话上下文');
    assert.match(document.querySelector('.github-panel')!.textContent!, /local-other/);
    assert.equal(document.querySelector('.github-panel input[type=password]'), null);
    await click('读取 Issues');
    assert.match(document.querySelector('.github-panel')!.textContent!, /部分内容未读取/);
    await click('#7 Synthetic <img src=x> issueopen · synthetic');
    assert.match(document.querySelector('.github-body')!.textContent!, /Private issue body/);
    assert.equal(document.querySelector('.github-panel img,.github-panel script'), null);
    assert.doesNotMatch(JSON.stringify([...storage.values()]), /Private issue body/);
    await click('读取评论');
    assert.match(document.querySelector('.github-panel')!.textContent!, /Private comment <img/);
    const entered = signal(),
      release = signal();
    waitRead = async () => {
      entered.resolve();
      await release.promise;
    };
    let append!: Promise<void>;
    await act(async () => {
      append = app.appendGithubDraft();
      await entered.promise;
    });
    await act(() => {
      field().value = draft + ' with a later edit';
    });
    release.resolve();
    await act(async () => await append);
    waitRead = undefined;
    assert.match(field().value, /^Keep my existing unsent input with a later edit\n\nIssue #7/);
    assert.match(String(storage.get(cacheKey + '/draft')), /Private issue body/);
    assert.equal(actions().length, 0);
    const copied = field().value;
    itemVersion = 'sha256:' + 'd'.repeat(64);
    await click('将正文加入草稿');
    assert.equal(field().value, copied);
    assert.equal(app.currentGithub().detail, undefined);
    itemVersion = version;
    await click('重新读取 GitHub 授权');
    await click('读取 PRs');
    await click('#8 Synthetic fork PRopen · synthetic');
    assert.match(document.querySelector('.github-panel')!.textContent!, /contributor\/fork/);
    assert.equal(
      document.querySelector<HTMLSelectElement>('.github-panel select')!.value,
      'contributor/fix',
    );
    await click('读取此提交的 CI 状态');
    assert.match(document.querySelector('.github-panel')!.textContent!, /尚无结论/);
    lost = true;
    await click('确认绑定到此会话');
    assert.equal(actions().length, 1);
    assert.equal(actions()[0].body.branch, 'contributor/fix');
    const original = structuredClone(actions()[0].body);
    assert.equal(field().value, copied);
    assert.equal(document.querySelector<HTMLButtonElement>('#send')!.disabled, true);
    await click('关闭 GitHub 面板');
    const count = actions().length,
      readCount = reads().length;
    await act(() => app.openSession(''));
    assert.equal(app.currentGithub().target.sessionId, 'stable-new-github-draft');
    assert.equal(actions().length, count);
    await act(() => app.openSession(sessionId));
    assert.deepEqual(app.currentGithub().pending.request, original);
    assert.equal(reads().length, readCount);
    await click('GitHub 仓库与会话上下文');
    lost = false;
    wrong = true;
    await click('重试确认 GitHub 绑定');
    assert.ok(app.currentGithub().pending);
    wrong = false;
    await click('重试确认 GitHub 绑定');
    assert.equal(app.currentGithub().pending, undefined);
    for (const request of actions()) assert.deepEqual(request.body, original);
    await click('重新读取 GitHub 授权');
    await click('读取 Issues');
    await click('#7 Synthetic <img src=x> issueopen · synthetic');
    available = false;
    await act(() =>
      SyntheticSocket.instances.at(-1)!.onmessage?.({
        data: JSON.stringify({
          type: 'changed',
          deviceId: device.id,
          workspaceId: runtime.id,
          room: { scope: 'github' },
        }),
      }),
    );
    assert.equal(document.querySelector('.github-body'), null);
    assert.match(document.querySelector('.github-panel')!.textContent!, /配置已变化/);
    await click('重新读取 GitHub 授权');
    assert.match(document.querySelector('.github-panel')!.textContent!, /授权已停用/);
    await click('解除会话绑定');
    assert.equal(bindings.get(sessionId).context, undefined);
    await click('关闭 GitHub 面板');
    available = true;
    await act(() => app.openSession(''));
    await click('GitHub 仓库与会话上下文');
    await click('读取远端分支');
    await chooseBranch();
    const newDraftBefore = field().value;
    undelivered = true;
    await click('确认绑定到此会话');
    const undeliveredRequest = structuredClone(actions().at(-1)!.body);
    assert.equal(receipts.has(undeliveredRequest.operationId), false);
    assert.equal(document.querySelector<HTMLButtonElement>('#send')!.disabled, true);
    assert.ok(app.currentGithub().pending);
    const beforeAbandonActions = actions().length;
    await click('撤销待确认操作');
    assert.equal(actions().length, beforeAbandonActions);
    const abandonCalls = requests.filter((v) => v.path.endsWith('/github/abandon'));
    assert.equal(abandonCalls.length, 1);
    assert.deepEqual(abandonCalls[0]!.body, undeliveredRequest);
    assert.equal(app.currentGithub().pending, undefined);
    assert.equal(app.currentGithub().blocked, false);
    assert.equal(document.querySelector<HTMLButtonElement>('#send')!.disabled, false);
    assert.equal(field().value, newDraftBefore);
    assert.match(document.querySelector('.github-panel')!.textContent!, /主机已确认原请求未执行/);
    assert.equal(bindings.has('stable-new-github-draft'), false);
    undelivered = false;
    await click('重新读取 GitHub 授权');
    await click('读取远端分支');
    await chooseBranch();
    await click('确认绑定到此会话');
    assert.equal(actions().at(-1)!.body.sessionId, 'stable-new-github-draft');
    assert.equal(storage.get(stableKey), 'stable-new-github-draft');
    await click('读取 Issues');
    const enteredLate = signal(),
      releaseLate = signal();
    waitRead = async () => {
      enteredLate.resolve();
      await releaseLate.promise;
    };
    let late!: Promise<void>;
    await act(async () => {
      late = app.currentGithub().openItem('issue', 7);
      await enteredLate.promise;
    });
    await act(() => app.openSession(sessionId));
    releaseLate.resolve();
    await act(async () => await assert.rejects(late, /已改变/));
    waitRead = undefined;
    assert.equal(app.currentGithub().detail, undefined);
    assert.equal(field().value, copied);
    await click('GitHub 仓库与会话上下文');
    await click('读取 Issues');
    await click('#7 Synthetic <img src=x> issueopen · synthetic');
    const beforeOffline = reads().length;
    await act(() => SyntheticSocket.instances.at(-1)!.onclose?.());
    assert.equal(document.querySelector('.github-body'), null);
    assert.equal(reads().length, beforeOffline);
    assert.match(document.querySelector('.github-panel')!.textContent!, /不会离线保存/);
    assert.equal(requests.filter((v) => v.path.endsWith('/mutations')).length, 0);
    assert.doesNotMatch(
      JSON.stringify(
        [...storage.entries()].filter(([key]) => key.startsWith('github-binding-v1/')),
      ),
      /Private issue body|Private comment|Synthetic fork PR/,
    );
  } finally {
    await act(() => app.disposeUI());
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});
